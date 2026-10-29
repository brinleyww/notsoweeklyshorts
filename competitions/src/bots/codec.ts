// Bot keyframes: the planner worker encodes chosen car states, every page decodes them.
// A chunk stands on its own. After a version byte and the keyframe count come columns (all of one
// field, then the next), each value a zigzag varint residual against a prediction made from the
// keyframes before it in the same chunk, so the first keyframe of a chunk is absolute.

export interface Keyframe {
  // Bot frame: ms since GO (race clock), not the car's own frame counter.
  f: number;
  // No interpolation from the previous keyframe (respawn, restart, start of a new run).
  cut: boolean;
  // The car's own frames (its run clock; resets on a restart).
  frames: number;
  speedKmh: number;
  hasStarted: boolean;
  finishFrames: number | null;
  nextCheckpointIndex: number;
  hasCheckpointToRespawnAt: boolean;
  // Contact bits: bit w = wheel w touching.
  wheels: number;
  pos: [number, number, number];
  quat: [number, number, number, number];
  impulses: number[];
  susp: [number, number, number, number];
  rot: [number, number, number, number];
  skid: [number, number, number, number];
  steering: number;
  // 1 up, 2 right, 4 down, 8 left, 16 reset, 32 brake light.
  controls: number;
  // Rocket League effects: 1 boosting, 2 flipping or jumping.
  rocketFx: number;
}

// A chunk with Rocket League effects in it (X_ROCKET) is version 2, so older pages turn it down instead of misreading
// it; every other chunk is still version 1.
const VERSION = 1;
const VERSION_ROCKET = 2;
const POS = 200;
const QUAT = 32767;
const SPEED = 10;
const FINE = 1e4;
const SKID = 255;
const GRID_MS = 50;

// Per keyframe, byte A = wheel contacts | (up, right, down, left) << 4, and byte B = the wheels whose
// skid is not 1 | the B_ flags. With B_EXT an X byte names the rare fields that follow in the ext column.
const X_F = 1;
const X_FRAMES = 2;
const X_STARTED = 4;
const X_RESPAWN = 8;
const X_CP = 16;
const X_FINISH = 32;
const X_IMPULSES = 64;
const X_ROCKET = 128;

const B_BRAKE = 16;
const B_RESET = 32;
const B_CUT = 64;
const B_EXT = 128;

// The worker's raw state: u32 car id, then the game's multiplayer car-state layout.
export function decodeRaw(raw: Uint8Array): Omit<Keyframe, 'f' | 'cut'> {
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  let i = 4;
  const frames = raw[i] | (raw[i + 1] << 8) | (raw[i + 2] << 16);
  const speedKmh = v.getFloat32(i + 3, true);
  const flags = raw[i + 7];
  i += 8;
  let finishFrames: number | null = null;
  if (flags & 2) {
    finishFrames = raw[i] | (raw[i + 1] << 8) | (raw[i + 2] << 16);
    i += 3;
  }
  const nextCheckpointIndex = v.getUint16(i, true);
  const f32 = (at: number) => v.getFloat32(at, true);
  const pos: Keyframe['pos'] = [f32(i + 2), f32(i + 6), f32(i + 10)];
  const quat: Keyframe['quat'] = [f32(i + 14), f32(i + 18), f32(i + 22), f32(i + 26)];
  i += 30;
  const count = Math.min(raw[i], 4);
  i++;
  const impulses: number[] = [];
  for (let k = 0; k < count; k++, i += 4) impulses.push(f32(i));
  const wheels = (flags >> 3) & 15;
  for (let w = 0; w < 4; w++) if (wheels & (1 << w)) i += 24;
  const four = (): [number, number, number, number] => {
    const out: [number, number, number, number] = [f32(i), f32(i + 4), f32(i + 8), f32(i + 12)];
    i += 16;
    return out;
  };
  const susp = four();
  i += 16;
  const rot = four();
  const skid = four();
  const steering = f32(i);
  const controls = raw[i + 4] & 63;
  const rocketFx = raw[i + 4] >> 6;
  return {
    frames,
    speedKmh,
    hasStarted: !!(flags & 1),
    finishFrames,
    nextCheckpointIndex,
    hasCheckpointToRespawnAt: !!(flags & 4),
    wheels,
    pos,
    quat,
    impulses,
    susp,
    rot,
    skid,
    steering,
    controls,
    rocketFx,
  };
}

class Bytes {
  a = new Uint8Array(256);
  n = 0;
  byte(x: number) {
    if (this.n === this.a.length) {
      const b = new Uint8Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = x;
  }
  int(x: number) {
    let z = x >= 0 ? x * 2 : -x * 2 - 1;
    while (z >= 128) {
      this.byte((z % 128) | 128);
      z = Math.floor(z / 128);
    }
    this.byte(z);
  }
}

class Reader {
  i = 0;
  constructor(private a: Uint8Array) {}
  byte() {
    if (this.i >= this.a.length) throw new Error('Bot chunk is too short');
    return this.a[this.i++];
  }
  int() {
    let z = 0,
      m = 1,
      b: number;
    do {
      b = this.byte();
      z += (b & 127) * m;
      m *= 128;
    } while (b & 128);
    return z % 2 ? -(z + 1) / 2 : z / 2;
  }
}

const q = (x: number, k: number) => (Number.isFinite(x) ? Math.round(x * k) : 0);
const quatInt = (x: number) => Math.max(-QUAT, Math.min(QUAT, q(x, QUAT)));

// What encoder and decoder both know before each keyframe of a chunk.
class Predictor {
  f = 0;
  frames = 0;
  started = false;
  respawn = false;
  cp = 0;
  finish: number | null = null;
  speed = 0;
  wheels = 0;
  steer = 0;
  rocketFx = 0;
  susp = [0, 0, 0, 0];
  rot = [0, 0, 0, 0];
  // The last two keyframes since the latest cut, as integers.
  posA: number[] | null = null;
  posB: number[] | null = null;
  quatA: number[] | null = null;
  quatB: number[] | null = null;
  fA = 0;
  fB = 0;

  // Linear extrapolation in time from the last two keyframes, never across a cut.
  #extrapolate(a: number[] | null, b: number[] | null, f: number, cut: boolean, k: number) {
    if (!b) return 0;
    if (cut || !a || this.fB === this.fA) return b[k];
    return b[k] + Math.round(((b[k] - a[k]) * (f - this.fB)) / (this.fB - this.fA));
  }
  pos(f: number, cut: boolean, k: number) {
    return this.#extrapolate(this.posA, this.posB, f, cut, k);
  }
  quat(f: number, cut: boolean, k: number) {
    return this.#extrapolate(this.quatA, this.quatB, f, cut, k);
  }
  // Wheels that roll on the ground turn in step with the speed.
  rotAt(w: number, speed: number, wheels: number) {
    const was = this.rot[w];
    const ground = this.wheels & wheels & (1 << w);
    return ground && Math.abs(this.speed) >= 100 && speed * this.speed > 0 ? Math.round((was * speed) / this.speed) : was;
  }
  push(f: number, cut: boolean, pos: number[], quat: number[]) {
    this.posA = cut ? null : this.posB;
    this.quatA = cut ? null : this.quatB;
    this.posB = pos;
    this.quatB = quat;
    this.fA = this.fB;
    this.fB = f;
    this.f = f;
  }
}

export class KeyframeEncoder {
  #count = 0;
  #rocket = false;
  #p = new Predictor();
  #a = new Bytes();
  #b = new Bytes();
  #x = new Bytes();
  #ext = new Bytes();
  #speed = new Bytes();
  #pos = new Bytes();
  #quat = new Bytes();
  #steer = new Bytes();
  #susp = new Bytes();
  #rot = new Bytes();
  #skid = new Bytes();

  add(f: number, raw: Uint8Array, cut: boolean) {
    const s = decodeRaw(raw);
    const p = this.#p;
    f = Math.round(f);
    const c = s.controls;
    this.#a.byte(s.wheels | ((c & 15) << 4));
    const skid = s.skid.map((v) => Math.max(0, Math.min(SKID, q(v, SKID))));
    let b = (c & 16 ? B_RESET : 0) | (c & 32 ? B_BRAKE : 0) | (cut ? B_CUT : 0);
    for (let w = 0; w < 4; w++) if (skid[w] !== SKID) b |= 1 << w;
    let x = 0;
    const ext = this.#ext;
    const finish = s.finishFrames;
    const frames = s.frames - (p.frames + (f - p.f));
    const imps = s.impulses.map((v) => q(v, 1));
    if (f - p.f !== GRID_MS) x |= X_F;
    if (frames !== 0) x |= X_FRAMES;
    if (s.hasStarted !== p.started) x |= X_STARTED;
    if (s.hasCheckpointToRespawnAt !== p.respawn) x |= X_RESPAWN;
    if (s.nextCheckpointIndex !== p.cp) x |= X_CP;
    if (finish !== p.finish) x |= X_FINISH;
    if (imps.length) x |= X_IMPULSES;
    if (s.rocketFx !== p.rocketFx) x |= X_ROCKET;
    if (x) {
      b |= B_EXT;
      this.#x.byte(x);
      if (x & X_F) ext.int(f - p.f);
      if (x & X_FRAMES) ext.int(frames);
      if (x & X_CP) ext.int(s.nextCheckpointIndex - p.cp);
      if (x & X_FINISH) ext.int(finish == null ? -1 : finish);
      if (x & X_IMPULSES) {
        ext.int(imps.length);
        for (const v of imps) ext.int(v);
      }
      if (x & X_ROCKET) ext.int(s.rocketFx), (this.#rocket = true);
    }
    this.#b.byte(b);
    for (let w = 0; w < 4; w++) if (skid[w] !== SKID) this.#skid.byte(skid[w]);

    const speed = q(s.speedKmh, SPEED);
    this.#speed.int(speed - p.speed);
    const pos = s.pos.map((v) => q(v, POS));
    for (let k = 0; k < 3; k++) this.#pos.int(pos[k] - p.pos(f, cut, k));
    let qs = s.quat;
    const last = p.quatB;
    if (last && qs[0] * last[0] + qs[1] * last[1] + qs[2] * last[2] + qs[3] * last[3] < 0) qs = [-qs[0], -qs[1], -qs[2], -qs[3]];
    const quat = qs.map(quatInt);
    for (let k = 0; k < 4; k++) this.#quat.int(quat[k] - p.quat(f, cut, k));
    const steer = q(s.steering, FINE);
    this.#steer.int(steer - p.steer);
    for (let w = 0; w < 4; w++) {
      const susp = q(s.susp[w], FINE);
      this.#susp.int(susp - p.susp[w]);
      p.susp[w] = susp;
      const rot = q(s.rot[w], FINE);
      this.#rot.int(rot - p.rotAt(w, speed, s.wheels));
      p.rot[w] = rot;
    }

    p.frames = s.frames;
    p.started = s.hasStarted;
    p.respawn = s.hasCheckpointToRespawnAt;
    p.cp = s.nextCheckpointIndex;
    p.finish = finish;
    p.speed = speed;
    p.wheels = s.wheels;
    p.steer = steer;
    p.rocketFx = s.rocketFx;
    p.push(f, cut, pos, quat);
    this.#count++;
  }

  take(): Uint8Array | null {
    if (!this.#count) return null;
    const head = new Bytes();
    head.byte(this.#rocket ? VERSION_ROCKET : VERSION);
    this.#rocket = false;
    head.int(this.#count);
    const parts = [head, this.#a, this.#b, this.#x, this.#ext, this.#speed, this.#pos, this.#quat, this.#steer, this.#susp, this.#rot, this.#skid];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.n, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p.a.subarray(0, p.n), at);
      at += p.n;
      p.n = 0;
    }
    this.#count = 0;
    this.#p = new Predictor();
    return out;
  }
}

export function decodeChunk(bytes: Uint8Array): Keyframe[] {
  const r = new Reader(bytes);
  const version = r.byte();
  if (version !== VERSION && version !== VERSION_ROCKET) throw new Error('Unknown bot chunk version');
  const n = r.int();
  if (!(n >= 0 && n <= bytes.length)) throw new Error('Bad bot chunk');
  const a = new Uint8Array(n),
    b = new Uint8Array(n),
    x = new Uint8Array(n);
  for (let k = 0; k < n; k++) a[k] = r.byte();
  for (let k = 0; k < n; k++) b[k] = r.byte();
  for (let k = 0; k < n; k++) if (b[k] & B_EXT) x[k] = r.byte();
  const p = new Predictor();
  const out: Keyframe[] = [];
  // Extended fields first, in keyframe order, as the encoder wrote them.
  const ext = [];
  for (let k = 0; k < n; k++) {
    const e = { f: GRID_MS, frames: 0, cp: 0, finish: 0, imps: [] as number[], rocketFx: -1 };
    if (x[k] & X_F) e.f = r.int();
    if (x[k] & X_FRAMES) e.frames = r.int();
    if (x[k] & X_CP) e.cp = r.int();
    if (x[k] & X_FINISH) e.finish = r.int();
    if (x[k] & X_IMPULSES) {
      const count = r.int();
      if (count < 0 || count > 4) throw new Error('Bad bot chunk');
      for (let j = 0; j < count; j++) e.imps.push(r.int());
    }
    if (x[k] & X_ROCKET) e.rocketFx = r.int();
    ext.push(e);
  }
  const speeds = new Int32Array(n);
  for (let k = 0; k < n; k++) speeds[k] = r.int();
  const posR = new Float64Array(n * 3);
  for (let k = 0; k < n * 3; k++) posR[k] = r.int();
  const quatR = new Float64Array(n * 4);
  for (let k = 0; k < n * 4; k++) quatR[k] = r.int();
  const steers = new Int32Array(n);
  for (let k = 0; k < n; k++) steers[k] = r.int();
  const suspR = new Float64Array(n * 4);
  for (let k = 0; k < n * 4; k++) suspR[k] = r.int();
  const rotR = new Float64Array(n * 4);
  for (let k = 0; k < n * 4; k++) rotR[k] = r.int();

  for (let k = 0; k < n; k++) {
    const e = ext[k];
    const cut = !!(b[k] & B_CUT);
    const f = p.f + e.f;
    const frames = p.frames + (f - p.f) + e.frames;
    const started = x[k] & X_STARTED ? !p.started : p.started;
    const respawn = x[k] & X_RESPAWN ? !p.respawn : p.respawn;
    const cp = p.cp + e.cp;
    const finish = x[k] & X_FINISH ? (e.finish < 0 ? null : e.finish) : p.finish;
    const wheels = a[k] & 15;
    const speed = p.speed + speeds[k];
    const pos = [0, 1, 2].map((j) => p.pos(f, cut, j) + posR[k * 3 + j]);
    const quat = [0, 1, 2, 3].map((j) => p.quat(f, cut, j) + quatR[k * 4 + j]);
    const steer = p.steer + steers[k];
    const rocketFx = e.rocketFx >= 0 ? e.rocketFx : p.rocketFx;
    const susp = [0, 0, 0, 0],
      rot = [0, 0, 0, 0],
      skid = [1, 1, 1, 1];
    for (let w = 0; w < 4; w++) {
      susp[w] = p.susp[w] + suspR[k * 4 + w];
      rot[w] = p.rotAt(w, speed, wheels) + rotR[k * 4 + w];
      p.susp[w] = susp[w];
      p.rot[w] = rot[w];
      if (b[k] & (1 << w)) skid[w] = r.byte() / SKID;
    }
    const norm = Math.hypot(quat[0], quat[1], quat[2], quat[3]) || 1;
    out.push({
      f,
      cut,
      frames,
      speedKmh: speed / SPEED,
      hasStarted: started,
      finishFrames: finish,
      nextCheckpointIndex: cp,
      hasCheckpointToRespawnAt: respawn,
      wheels,
      pos: [pos[0] / POS, pos[1] / POS, pos[2] / POS],
      quat: [quat[0] / norm, quat[1] / norm, quat[2] / norm, quat[3] / norm],
      impulses: e.imps,
      susp: [susp[0] / FINE, susp[1] / FINE, susp[2] / FINE, susp[3] / FINE],
      rot: [rot[0] / FINE, rot[1] / FINE, rot[2] / FINE, rot[3] / FINE],
      skid: skid as Keyframe['skid'],
      steering: steer / FINE,
      controls: (a[k] >> 4) | (b[k] & B_RESET ? 16 : 0) | (b[k] & B_BRAKE ? 32 : 0),
      rocketFx,
    });
    p.frames = frames;
    p.started = started;
    p.respawn = respawn;
    p.cp = cp;
    p.finish = finish;
    p.speed = speed;
    p.wheels = wheels;
    p.steer = steer;
    p.rocketFx = rocketFx;
    p.push(f, cut, pos, quat);
  }
  return out;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}
export async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  return pipe(bytes, new CompressionStream('deflate-raw'));
}
export async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  return pipe(bytes, new DecompressionStream('deflate-raw'));
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const INDEX = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) INDEX[ALPHABET.charCodeAt(i)] = i;

// base64url without padding.
export function toB64(bytes: Uint8Array): string {
  let s = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    s += ALPHABET[v >> 18] + ALPHABET[(v >> 12) & 63] + ALPHABET[(v >> 6) & 63] + ALPHABET[v & 63];
  }
  if (i + 1 === bytes.length) {
    const v = bytes[i] << 16;
    s += ALPHABET[v >> 18] + ALPHABET[(v >> 12) & 63];
  } else if (i + 2 === bytes.length) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8);
    s += ALPHABET[v >> 18] + ALPHABET[(v >> 12) & 63] + ALPHABET[(v >> 6) & 63];
  }
  return s;
}

export function fromB64(s: string): Uint8Array {
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let bits = 0,
    acc = 0,
    n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? INDEX[c] : -1;
    if (v < 0) throw new Error('Bad base64url');
    acc = ((acc << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 255;
    }
  }
  return out.subarray(0, n);
}
