import type { CameraView } from './types.ts';
import type { NativeCar } from './game-types.ts';
import type { CameraPose } from './types.ts';
// Transmit the racer's actual camera, including their cockpit/chase choice and FOV.
// This is scene data only; no screen capture, microphone, or camera permission.
// Not So Weekly Shorts: poses arrive in proxy batches (polycup/nsws/transport.js), two hops of up
// to 200 ms each, so playback stays further behind to keep a batch in hand.
export const VIEW_DELAY_MS = 600;
const vector = (p: number[]) =>
  Array.isArray(p) && p.length === 3 && p.every((n) => Number.isFinite(n) && Math.abs(n) < 1e7);
const rotation = (p: number[]) =>
  Array.isArray(p) &&
  p.length === 4 &&
  p.every((n) => Number.isFinite(n) && Math.abs(n) <= 1.01) &&
  Math.abs(Math.hypot(...p) - 1) < 0.02;
export function validPose(p: CameraPose) {
  return (
    !!p &&
    Number.isSafeInteger(p.sessionId) &&
    Number.isFinite(p.at) &&
    Array.isArray(p.position) &&
    p.position.length === 3 &&
    p.position.every((n) => Number.isFinite(n) && Math.abs(n) < 1e7) &&
    Array.isArray(p.quaternion) &&
    p.quaternion.length === 4 &&
    p.quaternion.every((n) => Number.isFinite(n) && Math.abs(n) <= 1.01) &&
    Math.abs(Math.hypot(...p.quaternion) - 1) < 0.02 &&
    Number.isFinite(p.fov) &&
    p.fov >= 5 &&
    p.fov <= 175 &&
    Number.isSafeInteger(p.frames) &&
    p.frames >= 0 &&
    p.frames <= 3600000 &&
    Number.isFinite(p.speed) &&
    Math.abs(p.speed) < 100000 &&
    vector(p.carPosition) &&
    rotation(p.carQuaternion) &&
    [0, 1].includes(p.view) &&
    (p.resetCounter === undefined || (Number.isSafeInteger(p.resetCounter) && p.resetCounter >= 0))
  );
}
function mixRotation(a: number[], b: number[], t: number) {
  let dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
  const sign = dot < 0 ? -1 : 1;
  dot = Math.min(1, Math.abs(dot));
  const angle = Math.acos(dot),
    sine = Math.sin(angle);
  const x = dot > 0.9995 ? 1 - t : Math.sin((1 - t) * angle) / sine;
  const y = dot > 0.9995 ? t : Math.sin(t * angle) / sine;
  const q = a.map((v, i) => x * v + y * b[i] * sign),
    length = Math.hypot(...q);
  return q.map((v) => v / length);
}
const mixPosition = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * t);

function rotateVector(v: number[], q: number[]) {
  // Native rotations can be slightly off unit length (the game approximates trig).
  const norm = Math.hypot(...q),
    [x, y, z, w] = q.map((n) => n / norm),
    [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy),
    ty = 2 * (z * vx - x * vz),
    tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + y * tz - z * ty,
    vy + w * ty + z * tx - x * tz,
    vz + w * tz + x * ty - y * tx,
  ];
}
function cameraOffset(p: CameraPose) {
  const delta = p.position.map((v, i) => v - p.carPosition[i]);
  return rotateVector(
    delta,
    p.quaternion.map((v, i) => (i === 3 ? v : -v)),
  );
}
function mixCameraPosition(
  a: CameraPose,
  b: CameraPose,
  t: number,
  carPosition: number[],
  quaternion: number[],
) {
  const start = cameraOffset(a),
    end = cameraOffset(b),
    local = mixPosition(start, end, t);
  // Interpolate around the car in camera space, not along a world-space chord.
  // This retains the driver's view and zoom without shortening the orbit in loops.
  const distance = Math.hypot(...start) * (1 - t) + Math.hypot(...end) * t,
    length = Math.hypot(...local);
  const direction = length > 1e-8 ? local : t < 0.5 ? start : end,
    magnitude = Math.hypot(...direction);
  const offset = rotateVector(
    magnitude > 1e-8 ? direction.map((v) => (v * distance) / magnitude) : direction,
    quaternion,
  );
  return carPosition.map((v, i) => v + offset[i]);
}

// Redraw only the remote car's visual transform. Never set a physics/network car
// state: doing so would feed our viewing delay back into native interpolation.
export function renderCarPose(car: NativeCar | undefined, pose: CameraView) {
  if (!car || !pose?.carPosition) return;
  const position = car.getPosition().fromArray(pose.carPosition);
  const quaternion = car.getQuaternion().fromArray(pose.carQuaternion!);
  const saved = (['getPosition', 'getQuaternion'] as const).map(
    (key) => [key, Object.getOwnPropertyDescriptor(car, key)] as const,
  );
  try {
    car.getPosition = () => position.clone();
    car.getQuaternion = () => quaternion.clone();
    car.update(0); // Update body/wheel transforms without advancing animations or skidmarks.
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(car, key, descriptor);
      else Reflect.deleteProperty(car, key);
    }
  }
}
export class CameraBuffer {
  #frames: CameraPose[] = [];
  #playhead: number | null = null;
  #arrivalAges: number[] = [];
  #delay: number = VIEW_DELAY_MS;
  #lastTick: number | null = null;

  constructor() {}
  push(p: CameraPose, receivedAt = p.at) {
    if (!validPose(p)) return false;
    const last = this.#frames.at(-1);
    if (last && last.sessionId === p.sessionId && last.at >= p.at) return false;
    if (
      last &&
      (last.sessionId !== p.sessionId ||
        p.frames < last.frames ||
        p.resetCounter !== last.resetCounter)
    ) {
      this.#frames = [];
      this.#arrivalAges = [];
      this.#delay = VIEW_DELAY_MS;
      this.#playhead = null;
      this.#lastTick = null;
    }
    this.#arrivalAges.push(Math.max(0, receivedAt - p.at));
    this.#arrivalAges = this.#arrivalAges.slice(-40);
    const needed = Math.min(
      1200,
      Math.max(VIEW_DELAY_MS, ...this.#arrivalAges.map((age) => age + 150)),
    );
    // Grow immediately on late arrivals; shed extra delay slowly after recovery.
    this.#delay = Math.max(needed, this.#delay - 1);
    this.#frames.push(p);
    this.#frames = this.#frames.slice(-40);
    return true;
  }
  sample(at: number, sessionId: number) {
    const frames = this.#frames.filter((p) => p.sessionId === sessionId);
    if (!frames.length || at - frames.at(-1)!.at > 1500) return null;
    const bIndex = frames.findIndex((p) => p.at >= at);
    if (bIndex < 1) return bIndex === 0 ? frames[0] : frames.at(-1);
    const a = frames[bIndex - 1],
      b = frames[bIndex],
      t = Math.min(1, Math.max(0, (at - a.at) / (b.at - a.at)));
    // A respawn is a cut, not a flight through scenery.
    if (
      a.view !== b.view ||
      Math.hypot(...a.carPosition.map((v, i) => b.carPosition[i] - v)) > 40 ||
      Math.hypot(...a.position.map((v, i) => b.position[i] - v)) > 40
    )
      return t < 1 ? a : b;
    const carPosition = mixPosition(a.carPosition, b.carPosition, t),
      quaternion = mixRotation(a.quaternion, b.quaternion, t);
    return {
      ...a,
      at,
      position: mixCameraPosition(a, b, t, carPosition, quaternion),
      quaternion,
      fov: a.fov + (b.fov - a.fov) * t,
      carPosition,
      carQuaternion: mixRotation(a.carQuaternion, b.carQuaternion, t),
      frames: Math.round(a.frames + (b.frames - a.frames) * t),
      speed: a.speed + (b.speed - a.speed) * t,
    };
  }
  playback(now: number, sessionId: number, tick: number) {
    const frames = this.#frames.filter((p) => p.sessionId === sessionId);
    if (!frames.length || now - frames.at(-1)!.at > 1500) {
      this.#playhead = null;
      this.#lastTick = null;
      return null;
    }
    const desired = now - this.#delay;
    if (this.#playhead === null || this.#lastTick === null || tick - this.#lastTick > 1000)
      this.#playhead = desired;
    else {
      const dt = Math.max(0, Math.min(100, tick - this.#lastTick));
      // Correct drift gradually; packet arrival and clock synchronization must
      // never rewind the camera or cause the native 50 ms catch-up steps.
      const drift = desired - (this.#playhead + dt);
      const rate = Math.max(0.8, Math.min(1.1, 1 + drift / 1000));
      this.#playhead += dt * rate;
    }
    this.#lastTick = tick;
    // Keep the logical cursor before the first sample during startup so the
    // full buffer fills instead of immediately chasing newly arriving packets.
    this.#playhead = Math.min(frames.at(-1)!.at, this.#playhead);
    return this.sample(this.#playhead, sessionId);
  }
}
