// The game's own physics, reached through the internals the simulation worker exposes
// (self.__nswsSimInternals). Every wasm-side state lives in its linear memory, so a copy of the
// heap is an exact snapshot of every car in this worker.

export interface Keys {
  up: boolean;
  right: boolean;
  down: boolean;
  left: boolean;
  reset: boolean;
}

export interface TrackObj {
  readonly environment: unknown;
  readonly sunDirection: unknown;
  addPart(x: number, y: number, z: number, id: number, rot: number, axis: number, color: number, cp: number | null, start: number | null): void;
  forEachPart(cb: (x: number, y: number, z: number, id: number, rot: number, axis: number, color: number, cp: number | null, start: number | null) => void): void;
  getStartTransform(): { position: { x: number; y: number; z: number }; quaternion: { x: number; y: number; z: number; w: number } } | null;
  getId(): string;
}

export interface SimInternals {
  module: {
    HEAPU8: Uint8Array;
    ccall(name: string, ret: string | null, types: string[], args: unknown[]): unknown;
  };
  create(id: number, mountain: Float32Array, offset: unknown, track: TrackObj, start: unknown): void;
  step(car: { id: number }, keys: Keys): Uint8Array;
  Track: { new (environment: unknown, sun: unknown): TrackObj; fromSaveString(s: string): TrackObj | null };
  Recording: { deserialize(s: string): unknown };
  Controls: new (rec: unknown) => { getControls(f: number): Keys; dispose?(): void };
  Vec3: new (x: number, y: number, z: number) => unknown;
  carPointer(id: number): number;
  stateAddr: number;
  stateSize: number;
}

export interface TrackLoad {
  track: TrackObj;
  start: unknown;
  mountain: Float32Array;
  offset: unknown;
}

let nextCarId = 1_000_000;

export class Sim {
  readonly I: SimInternals;
  #slots: (Uint8Array | null)[] = [];
  #slotLen: number[] = [];

  constructor(internals: SimInternals) {
    this.I = internals;
  }

  get heap() {
    return this.I.module.HEAPU8;
  }

  load(trackData: string, mountain: Float32Array, offset: { x: number; y: number; z: number }): TrackLoad | null {
    const track = this.I.Track.fromSaveString(trackData);
    const start = track?.getStartTransform();
    if (!track || !start) return null;
    return { track, start, mountain, offset: new this.I.Vec3(offset.x, offset.y, offset.z) };
  }

  // The same track with only the parts `keep` accepts (cars only touch what is near them). It keeps the
  // original id, which the physics hooks (Royale respawns) look tracks up by.
  prune(t: TrackLoad, keep: (x: number, y: number, z: number, id: number, cp: number | null, start: number | null) => boolean): TrackLoad {
    const src = t.track;
    const out = new this.I.Track(src.environment, src.sunDirection);
    src.forEachPart((x, y, z, id, rot, axis, color, cp, start) => {
      if (keep(x, y, z, id, cp, start)) out.addPart(x, y, z, id, rot, axis, color, cp, start);
    });
    const id = src.getId();
    out.getId = () => id;
    return { ...t, track: out };
  }

  newCar(t: TrackLoad): number {
    const id = nextCarId++;
    this.I.create(id, t.mountain, t.offset, t.track, t.start);
    return id;
  }

  deleteCar(id: number) {
    this.I.module.ccall('deleteCarModel', 'void', ['number'], [id]);
  }

  // The worker's state buffer for this car after one 1 ms frame; valid until the next step.
  step(id: number, keys: Keys): Uint8Array {
    return this.I.step({ id }, keys);
  }

  // Normalised steering input (-1 right .. +1 left); it moves 0.01 a frame toward the held key.
  steerInput(id: number) {
    const p = this.I.carPointer(id);
    return p ? new Float32Array(this.heap.buffer, p + 156, 1)[0] : 0;
  }

  // Linear velocity of the car body, world units per second.
  velocity(id: number, out: Float32Array) {
    const p = this.I.carPointer(id);
    if (!p) return out.fill(0);
    const body = new Uint32Array(this.heap.buffer, p + 36, 1)[0];
    const v = new Float32Array(this.heap.buffer, body + 312, 3);
    out[0] = v[0];
    out[1] = v[1];
    out[2] = v[2];
    return out;
  }

  // Adds a velocity change (units/s) to the car body; it shows from the next frame.
  kick(id: number, v: ArrayLike<number>) {
    const p = this.I.carPointer(id);
    if (!p) return;
    const body = new Uint32Array(this.heap.buffer, p + 36, 1)[0];
    const vel = new Float32Array(this.heap.buffer, body + 312, 3);
    for (let j = 0; j < 3; j++) vel[j] += v[j];
  }

  save(slot: number) {
    const h = this.heap;
    let buf = this.#slots[slot];
    if (!buf || buf.length < h.length) buf = this.#slots[slot] = new Uint8Array(h.length);
    buf.set(h);
    this.#slotLen[slot] = h.length;
  }

  restore(slot: number) {
    const buf = this.#slots[slot];
    if (!buf) throw new Error('empty snapshot slot');
    const n = this.#slotLen[slot];
    const h = this.heap;
    h.set(n === buf.length ? buf : buf.subarray(0, n));
    // Memory that grew after the snapshot did not exist then.
    if (h.length > n) h.fill(0, n);
  }

  dropSlot(slot: number) {
    this.#slots[slot] = null;
  }

  freeSlots() {
    this.#slots = [];
    this.#slotLen = [];
  }
}

// Decoded fields of the worker's raw state buffer (4-byte car id first).
export interface Raw {
  frames: number;
  speed: number;
  started: boolean;
  finished: boolean;
  finishFrames: number;
  respawnable: boolean;
  wheels: number;
  contacts: number;
  cp: number;
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  steering: number;
}

export function readRaw(u: Uint8Array, o: Raw): Raw {
  const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
  let i = 4;
  o.frames = u[i] | (u[i + 1] << 8) | (u[i + 2] << 16);
  i += 3;
  o.speed = dv.getFloat32(i, true);
  i += 4;
  const fl = u[i++];
  o.started = (fl & 1) !== 0;
  o.finished = (fl & 2) !== 0;
  o.respawnable = (fl & 4) !== 0;
  o.contacts = (fl >> 3) & 15;
  o.wheels = (o.contacts & 1) + ((o.contacts >> 1) & 1) + ((o.contacts >> 2) & 1) + ((o.contacts >> 3) & 1);
  o.finishFrames = -1;
  if (o.finished) {
    o.finishFrames = u[i] | (u[i + 1] << 8) | (u[i + 2] << 16);
    i += 3;
  }
  o.cp = dv.getUint16(i, true);
  i += 2;
  o.x = dv.getFloat32(i, true);
  o.y = dv.getFloat32(i + 4, true);
  o.z = dv.getFloat32(i + 8, true);
  i += 12;
  o.qx = dv.getFloat32(i, true);
  o.qy = dv.getFloat32(i + 4, true);
  o.qz = dv.getFloat32(i + 8, true);
  o.qw = dv.getFloat32(i + 12, true);
  i += 16;
  const imp = u[i++];
  i += 4 * imp + 24 * o.wheels + 64;
  o.steering = dv.getFloat32(i, true);
  return o;
}

export const newRaw = (): Raw => ({
  frames: 0, speed: 0, started: false, finished: false, finishFrames: -1, respawnable: false, wheels: 0, contacts: 0, cp: 0,
  x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, steering: 0,
});

// Car axes from its quaternion. Forward is the car's local +z.
export function axes(r: Raw, f: Float32Array, up: Float32Array) {
  const { qx: x, qy: y, qz: z, qw: w } = r;
  f[0] = 2 * (x * z + y * w);
  f[1] = 2 * (y * z - x * w);
  f[2] = 1 - 2 * (x * x + y * y);
  up[0] = 2 * (x * y - z * w);
  up[1] = 1 - 2 * (x * x + z * z);
  up[2] = 2 * (y * z + x * w);
}
