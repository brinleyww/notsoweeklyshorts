// One bot's keyframes on a page, drawn at any bot time: Hermite positions, slerped rotation, the game's
// lerpCarState for the rest, and wheel contacts rebuilt from the pose so skidmarks and tyre sounds work.
import type { CarState, Native, Quat, Vec3 } from '../game.ts';
import type { Keyframe } from './codec.ts';

type Lerp = Native['lerpCarState'];

interface Entry {
  k: Keyframe;
  // nextCheckpointIndex or finishFrames changed since the keyframe before.
  event: boolean;
  // Without wheel contacts: lerpCarState would only throw them away.
  bare: CarState | null;
}

// Wheel hardpoints in the car-state frame (+z front). The physics puts each contact this far past
// the suspension along the car's down axis (measured: 0.331 +- 0.0001).
const WHEELS = [
  [0.627909, 0.27, 1.3478],
  [-0.627909, 0.27, 1.3478],
  [0.720832, 0.27, -1.52686],
  [-0.720832, 0.27, -1.52686],
];
const RADIUS = 0.331;
// Keyframes this far behind the drawn time are dropped.
const KEEP_MS = 5000;
// A step longer than this, or one the car could not have driven (keyframes that came late), that
// moves the car further than JUMP_M is drawn as a teleport.
const JUMP_MS = 250;
const JUMP_M = 5;
// Metres per ms per ms (1000 m/s²): a velocity change faster than this is a hit, not driving.
const MAX_ACCEL = 1e-3;

const ZERO: Vec3 = { x: 0, y: 0, z: 0 };
const mix = (a: number, b: number, u: number) => a + (b - a) * u;
const mix4 = (a: number[], b: number[], u: number) => [mix(a[0], b[0], u), mix(a[1], b[1], u), mix(a[2], b[2], u), mix(a[3], b[3], u)];

// The game's lerpCarState, for a page whose game is older than it.
const plainLerp = (a: CarState, b: CarState, u: number): CarState => ({
  ...a,
  frames: Math.round(mix(a.frames, b.frames, u)),
  speedKmh: mix(a.speedKmh, b.speedKmh, u),
  hasStarted: b.hasStarted,
  collisionImpulses: [],
  wheelContact: [null, null, null, null],
  wheelSuspensionLength: mix4(a.wheelSuspensionLength, b.wheelSuspensionLength, u),
  wheelSuspensionVelocity: mix4(a.wheelSuspensionVelocity, b.wheelSuspensionVelocity, u),
  wheelDeltaRotation: mix4(a.wheelDeltaRotation, b.wheelDeltaRotation, u),
  wheelSkidInfo: mix4(a.wheelSkidInfo, b.wheelSkidInfo, u),
  steering: mix(a.steering, b.steering, u),
  brakeLightEnabled: b.brakeLightEnabled,
  controls: b.controls,
});

function slerp(a: Keyframe['quat'], b: Keyframe['quat'], t: number): Quat {
  let [bx, by, bz, bw] = b;
  let d = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (d < 0) {
    d = -d;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let ka = 1 - t,
    kb = t;
  if (d < 0.9995) {
    const th = Math.acos(d),
      s = Math.sin(th);
    ka = Math.sin(ka * th) / s;
    kb = Math.sin(kb * th) / s;
  }
  const x = a[0] * ka + bx * kb,
    y = a[1] * ka + by * kb,
    z = a[2] * ka + bz * kb,
    w = a[3] * ka + bw * kb;
  const n = Math.hypot(x, y, z, w) || 1;
  return { x: x / n, y: y / n, z: z / n, w: w / n };
}

function hermite(a: Keyframe['pos'], va: Vec3, b: Keyframe['pos'], vb: Vec3, u: number, h: number): Vec3 {
  const u2 = u * u,
    u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1,
    h10 = (u3 - 2 * u2 + u) * h,
    h01 = 3 * u2 - 2 * u3,
    h11 = (u3 - u2) * h;
  return {
    x: h00 * a[0] + h10 * va.x + h01 * b[0] + h11 * vb.x,
    y: h00 * a[1] + h10 * va.y + h01 * b[1] + h11 * vb.y,
    z: h00 * a[2] + h10 * va.z + h01 * b[2] + h11 * vb.z,
  };
}

const cap = (v: Vec3, max: number) => {
  const m = Math.hypot(v.x, v.y, v.z);
  return m > max ? { x: (v.x * max) / m, y: (v.y * max) / m, z: (v.z * max) / m } : v;
};

function contacts(p: Vec3, q: Quat, susp: number[], bits: number): CarState['wheelContact'] {
  const out: CarState['wheelContact'] = [null, null, null, null];
  if (!bits) return out;
  const { x, y, z, w } = q;
  const rx = 1 - 2 * (y * y + z * z),
    ry = 2 * (x * y + z * w),
    rz = 2 * (x * z - y * w);
  const ux = 2 * (x * y - z * w),
    uy = 1 - 2 * (x * x + z * z),
    uz = 2 * (y * z + x * w);
  const fx = 2 * (x * z + y * w),
    fy = 2 * (y * z - x * w),
    fz = 1 - 2 * (x * x + y * y);
  for (let i = 0; i < 4; i++) {
    if (!(bits & (1 << i))) continue;
    const [lx, ly, lz] = WHEELS[i];
    const down = ly - susp[i] - RADIUS;
    out[i] = {
      position: { x: p.x + rx * lx + ux * down + fx * lz, y: p.y + ry * lx + uy * down + fy * lz, z: p.z + rz * lx + uz * down + fz * lz },
      normal: { x: ux, y: uy, z: uz },
    };
  }
  return out;
}

export class BotTimeline {
  #e: Entry[] = [];
  // Entries before this one were dropped (KEEP_MS).
  #start = 0;
  #pruned = false;
  #done = false;
  #at: number | null = null;
  #drawn: Vec3 | null = null;
  #speed = 0;
  #eventAt = 0;
  #eventsUsed = false;

  push(frames: Keyframe[]) {
    // A chunk that starts at or before the end replaces everything from its first frame (a bot in a bumper cup
    // driven again from where another car hit it).
    const first = frames[0], e = this.#e;
    if (first && e.length > this.#start && first.f <= e[e.length - 1].k.f) {
      let i = e.length;
      while (i > this.#start && e[i - 1].k.f >= first.f) i--;
      e.length = i;
      this.#eventAt = Math.min(this.#eventAt, i);
    }
    for (const k of frames) {
      const last = this.#e[this.#e.length - 1]?.k;
      if (last && k.f < last.f) continue;
      const event = !!last && (k.nextCheckpointIndex !== last.nextCheckpointIndex || k.finishFrames !== last.finishFrames);
      this.#e.push({ k, event, bare: null });
    }
  }

  get end(): number {
    const n = this.#e.length;
    return n ? this.#e[n - 1].k.f : -Infinity;
  }

  get done(): boolean {
    return this.#done;
  }

  markDone() {
    this.#done = true;
  }

  sample(t: number, lerp: Lerp): { state: CarState; reset: boolean } | null {
    const e = this.#e;
    if (e.length <= this.#start || t !== t) return null;
    const i = this.#find(t);
    let state: CarState;
    if (i < this.#start) {
      state = this.#full(e[this.#start]);
      if (!this.#pruned) state.hasStarted = false;
    } else if (i === e.length - 1 || e[i + 1].k.cut) state = this.#full(e[i]);
    else state = this.#between(i, t, lerp);

    const prev = this.#at;
    let reset = prev == null;
    if (prev != null && prev !== t) {
      const lo = Math.min(prev, t);
      const forward = t > prev && t - prev <= JUMP_MS;
      for (let j = this.#find(Math.max(prev, t)); j >= this.#start && e[j].k.f > lo; j--) {
        if (e[j].k.cut) reset = true;
        else if (forward && e[j].k.impulses.length) state.collisionImpulses = state.collisionImpulses.concat(e[j].k.impulses);
      }
      const d = this.#drawn!;
      const moved = Math.hypot(state.position.x - d.x, state.position.y - d.y, state.position.z - d.z);
      const reach = (Math.max(Math.abs(state.speedKmh), this.#speed) / 3600) * Math.abs(t - prev) * 1.5 + JUMP_M;
      if (moved > JUMP_M && (Math.abs(t - prev) > JUMP_MS || moved > reach)) reset = true;
    }
    if (reset) state.collisionImpulses = [];
    this.#at = t;
    this.#drawn = state.position;
    this.#speed = Math.abs(state.speedKmh);
    this.#prune(t);
    return { state, reset };
  }

  events(t: number): CarState[] {
    this.#eventsUsed = true;
    const e = this.#e;
    const out: CarState[] = [];
    if (this.#eventAt < this.#start) this.#eventAt = this.#start;
    while (this.#eventAt < e.length && e[this.#eventAt].k.f <= t) {
      const entry = e[this.#eventAt++];
      if (entry.event) out.push(this.#full(entry));
    }
    return out;
  }

  // Poses after t on the bot's clock (up to n, never past a cut), for another car's collision step.
  next(t: number, n: number, out: { f: number; p: number[]; q: number[] }[]) {
    const e = this.#e;
    for (let j = this.#find(t) + 1; j < e.length && out.length <= n; j++) {
      const k = e[j].k;
      if (k.cut) break;
      out.push({ f: k.f, p: [k.pos[0], k.pos[1], k.pos[2]], q: [k.quat[0], k.quat[1], k.quat[2], k.quat[3]] });
    }
    return out;
  }

  // The last entry at or before t, or #start - 1.
  #find(t: number) {
    const e = this.#e;
    let lo = this.#start,
      hi = e.length - 1,
      i = this.#start - 1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (e[m].k.f <= t) {
        i = m;
        lo = m + 1;
      } else hi = m - 1;
    }
    return i;
  }

  #bare(entry: Entry): CarState {
    if (entry.bare) return entry.bare;
    const k = entry.k;
    const c = k.controls;
    return (entry.bare = {
      frames: k.frames,
      speedKmh: k.speedKmh,
      hasStarted: k.hasStarted,
      finishFrames: k.finishFrames,
      nextCheckpointIndex: k.nextCheckpointIndex,
      hasCheckpointToRespawnAt: k.hasCheckpointToRespawnAt,
      position: { x: k.pos[0], y: k.pos[1], z: k.pos[2] },
      quaternion: { x: k.quat[0], y: k.quat[1], z: k.quat[2], w: k.quat[3] },
      collisionImpulses: [],
      wheelContact: [null, null, null, null],
      wheelSuspensionLength: k.susp,
      wheelSuspensionVelocity: [0, 0, 0, 0],
      wheelDeltaRotation: k.rot,
      wheelSkidInfo: k.skid,
      steering: k.steering,
      brakeLightEnabled: !!(c & 32),
      controls: { up: !!(c & 1), right: !!(c & 2), down: !!(c & 4), left: !!(c & 8), reset: !!(c & 16) },
    });
  }

  #full(entry: Entry): CarState {
    const s = this.#bare(entry);
    return { ...s, wheelContact: contacts(s.position, s.quaternion, s.wheelSuspensionLength, entry.k.wheels) };
  }

  // Velocity at entry j (metres per ms) for the segment on its left (side -1) or right (side 1),
  // never across a cut: the slope of the parabola through its neighbours, or, where the velocity
  // jumps (a crash, a landing), the slope on that side alone.
  #tangent(j: number, side: number): Vec3 {
    const e = this.#e;
    const k = e[j].k;
    const before = j > this.#start && !k.cut && e[j - 1].k.f < k.f ? e[j - 1].k : null;
    const next = e[j + 1]?.k;
    const after = next && !next.cut && next.f > k.f ? next : null;
    if (!before && !after) return ZERO;
    const h0 = before ? k.f - before.f : 0,
      h1 = after ? after.f - k.f : 0;
    const s0 = before && [(k.pos[0] - before.pos[0]) / h0, (k.pos[1] - before.pos[1]) / h0, (k.pos[2] - before.pos[2]) / h0];
    const s1 = after && [(after.pos[0] - k.pos[0]) / h1, (after.pos[1] - k.pos[1]) / h1, (after.pos[2] - k.pos[2]) / h1];
    let v: number[];
    if (!s0 || !s1) v = (s0 || s1)!;
    else if (Math.hypot(s1[0] - s0[0], s1[1] - s0[1], s1[2] - s0[2]) > ((h0 + h1) / 2) * MAX_ACCEL) v = side < 0 ? s0 : s1;
    else {
      const w0 = h1 / (h0 + h1),
        w1 = h0 / (h0 + h1);
      v = [s0[0] * w0 + s1[0] * w1, s0[1] * w0 + s1[1] * w1, s0[2] * w0 + s1[2] * w1];
    }
    return { x: v[0], y: v[1], z: v[2] };
  }

  #between(i: number, t: number, lerp: Lerp): CarState {
    const a = this.#e[i],
      b = this.#e[i + 1];
    const h = b.k.f - a.k.f;
    const u = (t - a.k.f) / h;
    const s = (lerp ?? plainLerp)(this.#bare(a), this.#bare(b), u);
    const pa = a.k.pos,
      pb = b.k.pos;
    // At most 3x the segment's own speed at either end, so the curve never loops past b.
    const most = (3 * Math.hypot(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2])) / h;
    s.position = hermite(pa, cap(this.#tangent(i, 1), most), pb, cap(this.#tangent(i + 1, -1), most), u, h);
    s.quaternion = slerp(a.k.quat, b.k.quat, u);
    s.wheelContact = contacts(s.position, s.quaternion, s.wheelSuspensionLength, a.k.wheels & b.k.wheels);
    s.collisionImpulses = [];
    return s;
  }

  #prune(t: number) {
    let keep = this.#find(t - KEEP_MS);
    if (this.#eventsUsed) keep = Math.min(keep, this.#eventAt);
    if (keep > this.#start) {
      this.#start = keep;
      this.#pruned = true;
    }
    if (this.#start > 512 && this.#start * 2 > this.#e.length) {
      this.#e.splice(0, this.#start);
      this.#eventAt = Math.max(0, this.#eventAt - this.#start);
      this.#start = 0;
    }
  }
}
