// A reference run (world record, board run, cup run) replayed once through the physics, kept frame by
// frame: where it was, how fast, which way it pointed, what it pressed. Bots follow these.
import { axes, newRaw, readRaw, type Sim, type TrackLoad } from './sim.ts';

const CELL = 12;
// Air time that makes a jump: the run-up has to be at the reference's speed to make it.
const JUMP_MS = 100;
const LONG_FLIGHT_MS = 700;
// A loss of more than HIT_DROP km/h within HIT_MS is a wall hit the run means (a cut along a barrier, a stop
// at a gate); brakes do about 2 km/h in that time, and brushing a wall costs 15-30, which bots still slow for.
const HIT_MS = 20;
const HIT_DROP = 40;
const RUN_UP_MS = 15000;

export class Reference {
  readonly id: string;
  readonly kind: string;
  readonly rank: number;
  // Frames until the finish (the run's time in ms).
  readonly n: number;
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  readonly fx: Float32Array;
  readonly fy: Float32Array;
  readonly fz: Float32Array;
  readonly ux: Float32Array;
  readonly uy: Float32Array;
  readonly uz: Float32Array;
  // km/h, steering input (-1..1), keys (1 up, 2 right, 4 down, 8 left, 16 reset), wheels on the ground, next checkpoint.
  readonly speed: Float32Array;
  readonly steer: Float32Array;
  readonly keys: Uint8Array;
  readonly wheels: Uint8Array;
  readonly cp: Uint16Array;
  readonly arc: Float32Array;
  // Signed curvature of the path (1/units, + = turning left about the car's up), smoothed over a few metres.
  readonly curv: Float32Array;
  // First frame with each next-checkpoint index; frames where a respawn moved the car.
  readonly cpAt: number[] = [];
  readonly teleports: number[] = [];
  readonly minY: number;
  #grid = new Map<number, number[]>();

  private constructor(id: string, kind: string, rank: number, n: number) {
    this.id = id;
    this.kind = kind;
    this.rank = rank;
    this.n = n;
    const f = () => new Float32Array(n);
    this.px = f();
    this.py = f();
    this.pz = f();
    this.vx = f();
    this.vy = f();
    this.vz = f();
    this.fx = f();
    this.fy = f();
    this.fz = f();
    this.ux = f();
    this.uy = f();
    this.uz = f();
    this.speed = f();
    this.steer = f();
    this.arc = f();
    this.curv = f();
    this.keys = new Uint8Array(n);
    this.wheels = new Uint8Array(n);
    this.cp = new Uint16Array(n);
    this.minY = Infinity;
  }

  // Replays the recording; null unless it finishes exactly on `frames`.
  static build(sim: Sim, t: TrackLoad, id: string, kind: string, rank: number, recording: string, frames: number): Reference | null {
    let rec: unknown;
    try {
      rec = sim.I.Recording.deserialize(recording);
    } catch {
      return null;
    }
    if (!rec || !(frames > 0) || frames > 1_200_000) return null;
    const controls = new sim.I.Controls(rec);
    const ref = new Reference(id, kind, rank, frames);
    const car = sim.newCar(t);
    const r = newRaw();
    const fw = new Float32Array(3), up = new Float32Array(3), vel = new Float32Array(3);
    let finished = -1;
    let minY = Infinity;
    let lastCp = -1;
    try {
      for (let i = 0; i < frames; i++) {
        const k = controls.getControls(i);
        readRaw(sim.step(car, k), r);
        sim.velocity(car, vel);
        axes(r, fw, up);
        ref.px[i] = r.x;
        ref.py[i] = r.y;
        ref.pz[i] = r.z;
        ref.vx[i] = vel[0];
        ref.vy[i] = vel[1];
        ref.vz[i] = vel[2];
        ref.fx[i] = fw[0];
        ref.fy[i] = fw[1];
        ref.fz[i] = fw[2];
        ref.ux[i] = up[0];
        ref.uy[i] = up[1];
        ref.uz[i] = up[2];
        ref.speed[i] = r.speed;
        ref.steer[i] = sim.steerInput(car);
        ref.keys[i] = (k.up ? 1 : 0) | (k.right ? 2 : 0) | (k.down ? 4 : 0) | (k.left ? 8 : 0) | (k.reset ? 16 : 0);
        ref.wheels[i] = r.wheels;
        ref.cp[i] = r.cp;
        if (r.cp !== lastCp) {
          while (ref.cpAt.length <= r.cp) ref.cpAt.push(i);
          lastCp = r.cp;
        }
        if (i > 0) {
          const dx = r.x - ref.px[i - 1], dy = r.y - ref.py[i - 1], dz = r.z - ref.pz[i - 1];
          const d = (dx * dx + dy * dy + dz * dz) ** 0.5;
          if (d > 3) ref.teleports.push(i);
          ref.arc[i] = ref.arc[i - 1] + (d > 3 ? 0 : d);
        }
        if (r.y < minY) minY = r.y;
        if (r.finished) {
          finished = i + 1;
          break;
        }
      }
    } finally {
      sim.deleteCar(car);
      (controls as { dispose?(): void }).dispose?.();
    }
    if (finished !== frames) return null;
    (ref as { minY: number }).minY = minY;
    ref.#index();
    ref.#curvature();
    return ref;
  }

  // A run along a path no car has driven (explore.ts): a cautious speed profile, sampled every ms.
  static fromPath(id: string, pts: { x: number; y: number; z: number; nx: number; ny: number; nz: number }[], gates: { min: number[]; max: number[] }[][]): Reference | null {
    const m = pts.length;
    if (m < 10) return null;
    const ds = new Float64Array(m), kappa = new Float64Array(m), vmax = new Float64Array(m), v = new Float64Array(m);
    for (let i = 1; i < m; i++) ds[i] = ((pts[i].x - pts[i - 1].x) ** 2 + (pts[i].y - pts[i - 1].y) ** 2 + (pts[i].z - pts[i - 1].z) ** 2) ** 0.5;
    for (let i = 2; i < m - 2; i++) {
      const a = pts[i - 2], b = pts[i], c = pts[i + 2];
      const ux = b.x - a.x, uz = b.z - a.z, wx = c.x - b.x, wz = c.z - b.z;
      const la = (ux * ux + uz * uz) ** 0.5, lb = (wx * wx + wz * wz) ** 0.5;
      if (la < 0.5 || lb < 0.5) continue;
      // Left turns are positive (about +y).
      kappa[i] = Math.atan2(ux * wz - uz * wx, ux * wx + uz * wz) / ((la + lb) / 2) * -1;
    }
    // Only corners limit it: the car itself accelerates and tops out as it can, so model it generously.
    const TOP = 130;
    for (let i = 0; i < m; i++) {
      const c = Math.abs(kappa[i]);
      const grip = c < 1e-4 ? TOP : (64 * Math.max(0, (0.95 * 0.4103) / (2.875 * c) - 1) ** 0.5) / 3.6;
      vmax[i] = Math.max(6, Math.min(TOP, grip));
    }
    v[0] = 0;
    for (let i = 1; i < m; i++) v[i] = Math.min(vmax[i], (v[i - 1] ** 2 + 2 * 45 * ds[i]) ** 0.5);
    for (let i = m - 2; i >= 0; i--) v[i] = Math.min(v[i], (v[i + 1] ** 2 + 2 * 24 * ds[i + 1]) ** 0.5);
    const time = new Float64Array(m);
    for (let i = 1; i < m; i++) time[i] = time[i - 1] + (1000 * ds[i]) / Math.max(1, (v[i] + v[i - 1]) / 2);
    const n = Math.ceil(time[m - 1]) + 1;
    if (n > 1_200_000) return null;
    const ref = new Reference(id, 'explore', 99, n);
    let seg = 0, cp = 0, arc = 0;
    for (let f = 0; f < n; f++) {
      while (seg < m - 2 && time[seg + 1] <= f) seg++;
      const a = pts[seg], b = pts[seg + 1];
      const span = time[seg + 1] - time[seg] || 1;
      const u = Math.max(0, Math.min(1, (f - time[seg]) / span));
      const x = a.x + (b.x - a.x) * u, y = a.y + (b.y - a.y) * u, z = a.z + (b.z - a.z) * u;
      let tx = b.x - a.x, ty = b.y - a.y, tz = b.z - a.z;
      const tl = (tx * tx + ty * ty + tz * tz) ** 0.5 || 1;
      tx /= tl;
      ty /= tl;
      tz /= tl;
      const sp = v[seg] + (v[seg + 1] - v[seg]) * u;
      if (f > 0) arc += ((x - ref.px[f - 1]) ** 2 + (y - ref.py[f - 1]) ** 2 + (z - ref.pz[f - 1]) ** 2) ** 0.5;
      ref.px[f] = x;
      ref.py[f] = y + 0.15;
      ref.pz[f] = z;
      ref.vx[f] = tx * sp;
      ref.vy[f] = ty * sp;
      ref.vz[f] = tz * sp;
      ref.fx[f] = tx;
      ref.fy[f] = ty;
      ref.fz[f] = tz;
      ref.ux[f] = a.nx;
      ref.uy[f] = a.ny;
      ref.uz[f] = a.nz;
      ref.speed[f] = sp * 3.6;
      const kmh = sp * 3.6;
      ref.steer[f] = Math.max(-1, Math.min(1, Math.atan(kappa[seg] * 2.875) / (0.4103 / (1 + (kmh / 64) ** 2))));
      ref.keys[f] = v[seg + 1] < v[seg] - 0.02 && v[seg + 1] < vmax[seg] - 0.5 ? 4 : 1;
      ref.wheels[f] = 4;
      const group = cp < gates.length ? gates[cp] : null;
      if (group && group.some((gt) => x >= gt.min[0] - 1 && x <= gt.max[0] + 1 && z >= gt.min[2] - 1 && z <= gt.max[2] + 1 && y >= gt.min[1] - 1.5 && y <= gt.max[1])) cp++;
      ref.cp[f] = cp;
      ref.arc[f] = arc;
      while (ref.cpAt.length <= cp) ref.cpAt.push(f);
    }
    let minY = Infinity;
    for (let f = 0; f < n; f++) minY = Math.min(minY, ref.py[f]);
    (ref as { minY: number }).minY = minY;
    ref.#index();
    ref.#curvature();
    return ref;
  }

  // Turn of the velocity direction about the car's up per unit of travel, measured across +-4 units.
  #curvature() {
    const n = this.n;
    const span = 4;
    let a = 0, b = 0;
    for (let i = 0; i < n; i++) {
      while (a < i && this.arc[i] - this.arc[a] > span) a++;
      while (b < n - 1 && this.arc[b] - this.arc[i] < span && !this.teleports.includes(b + 1)) b++;
      const ds = this.arc[b] - this.arc[a];
      // Below walking pace the direction of travel is noise.
      if (ds < 1 || Math.abs(this.speed[i]) < 8) continue;
      const ax = this.vx[a], ay = this.vy[a], az = this.vz[a], bx = this.vx[b], by = this.vy[b], bz = this.vz[b];
      const ux = this.ux[i], uy = this.uy[i], uz = this.uz[i];
      // Both directions flattened onto the plane of the car's up.
      const ad = ax * ux + ay * uy + az * uz, bd = bx * ux + by * uy + bz * uz;
      const px = ax - ad * ux, py = ay - ad * uy, pz = az - ad * uz;
      const qx = bx - bd * ux, qy = by - bd * uy, qz = bz - bd * uz;
      const cx = py * qz - pz * qy, cy = pz * qx - px * qz, cz = px * qy - py * qx;
      const sin = cx * ux + cy * uy + cz * uz, cos = px * qx + py * qy + pz * qz;
      this.curv[i] = Math.max(-0.3, Math.min(0.3, Math.atan2(sin, cos) / ds));
    }
  }

  #key(x: number, y: number, z: number) {
    return ((Math.floor(x / CELL) & 1023) << 20) | ((Math.floor(y / CELL) & 1023) << 10) | (Math.floor(z / CELL) & 1023);
  }

  #index() {
    for (let i = 0; i < this.n; i += 8) {
      const k = this.#key(this.px[i], this.py[i], this.pz[i]);
      let list = this.#grid.get(k);
      if (!list) this.#grid.set(k, (list = []));
      list.push(i);
    }
  }

  // Nearest frame within [from, to], coarse then fine; returns the squared distance in out[0].
  nearest(x: number, y: number, z: number, from: number, to: number, out: Float64Array): number {
    from = Math.max(0, from);
    to = Math.min(this.n - 1, to);
    let best = -1, bd = Infinity;
    const stride = to - from > 400 ? 4 : 1;
    for (let i = from; i <= to; i += stride) {
      const dx = this.px[i] - x, dy = this.py[i] - y, dz = this.pz[i] - z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    if (stride > 1 && best >= 0) {
      const a = Math.max(from, best - stride), b = Math.min(to, best + stride);
      for (let i = a; i <= b; i++) {
        const dx = this.px[i] - x, dy = this.py[i] - y, dz = this.pz[i] - z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
    }
    out[0] = bd;
    return best;
  }

  // Nearest frame anywhere near (x, y, z) whose next checkpoint is `cp` (or any, if none match).
  search(x: number, y: number, z: number, cp: number, out: Float64Array): number {
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL), cz = Math.floor(z / CELL);
    let best = -1, bd = Infinity, anyBest = -1, anyD = Infinity;
    for (let a = -2; a <= 2; a++)
      for (let b = -2; b <= 2; b++)
        for (let c = -2; c <= 2; c++) {
          const list = this.#grid.get((((cx + a) & 1023) << 20) | (((cy + b) & 1023) << 10) | ((cz + c) & 1023));
          if (!list) continue;
          for (const i of list) {
            const dx = this.px[i] - x, dy = this.py[i] - y, dz = this.pz[i] - z;
            const d = dx * dx + dy * dy + dz * dz;
            if (this.cp[i] === cp && d < bd) {
              bd = d;
              best = i;
            }
            if (d < anyD) {
              anyD = d;
              anyBest = i;
            }
          }
        }
    const pick = best >= 0 ? best : anyBest;
    if (pick < 0) {
      out[0] = Infinity;
      return -1;
    }
    const i = this.nearest(x, y, z, pick - 12, pick + 12, out);
    return i;
  }

  // Frame at `d` units of travel after frame i (clamped to the run).
  ahead(i: number, d: number) {
    const target = this.arc[i] + d;
    let j = i;
    const step = 16;
    while (j + step < this.n && this.arc[j + step] < target && !this.#jumpBetween(j, j + step)) j += step;
    while (j + 1 < this.n && this.arc[j + 1] < target && !this.#jumpBetween(j, j + 1)) j++;
    return j;
  }

  #jumpBetween(a: number, b: number) {
    for (const t of this.teleports) if (t > a && t <= b) return true;
    return false;
  }

  // Frames where a jump (at least JUMP_MS in the air) takes off, ascending.
  #takeoffs: number[] | null = null;
  takeoffs() {
    if (this.#takeoffs) return this.#takeoffs;
    const out: number[] = [];
    let start = -1;
    for (let i = 0; i < this.n; i++) {
      if (this.wheels[i] === 0) {
        if (start < 0) start = i;
      } else {
        if (start >= 0 && i - start >= JUMP_MS) out.push(start);
        start = -1;
      }
    }
    return (this.#takeoffs = out);
  }

  // The run-up to a long flight: the fast stretch before the takeoff and the corner it starts from.
  // Where a flight lands is decided by the speed it takes off with, which a car short of it can't make
  // up in the air (or, that fast, on the way there).
  #runUp: Uint8Array | null = null;
  runUp(i: number) {
    if (!this.#runUp) {
      const m = new Uint8Array(this.n);
      for (const t of this.takeoffs()) {
        let land = t;
        while (land < this.n && this.wheels[land] === 0) land++;
        if (land - t < LONG_FLIGHT_MS) continue;
        let j = t;
        const fast = 0.85 * Math.abs(this.speed[t]);
        while (j > 0 && t - j < RUN_UP_MS && Math.abs(this.speed[j - 1]) >= fast) j--;
        let low = Math.abs(this.speed[j]);
        while (j > 0 && t - j < RUN_UP_MS && Math.abs(this.speed[j - 1]) <= low + 2) low = Math.min(low, Math.abs(this.speed[--j]));
        while (j > 0 && t - j < RUN_UP_MS && ((this.keys[j - 1] & 4) !== 0 || Math.abs(this.steer[j - 1]) > 0.3)) j--;
        m.fill(1, j, t + 1);
      }
      this.#runUp = m;
    }
    return this.#runUp[i] === 1;
  }

  // Frames until the next jump's takeoff from frame i (Infinity if none within `within`).
  jumpIn(i: number, within: number) {
    for (const t of this.takeoffs()) {
      if (t < i - 600) continue;
      return t - i <= within ? t - i : Infinity;
    }
    return Infinity;
  }

  // How far (rad) the reference car's body points from where it travels at frame i, on the ground.
  slipAt(i: number) {
    const vn = Math.hypot(this.vx[i], this.vy[i], this.vz[i]);
    if (vn < 3 || !this.wheels[i]) return 0;
    return Math.acos(Math.max(-1, Math.min(1, (this.fx[i] * this.vx[i] + this.fy[i] * this.vy[i] + this.fz[i] * this.vz[i]) / vn)));
  }

  // The next respawn of the reference at or after frame i, or -1.
  teleportAfter(i: number) {
    for (const t of this.teleports) if (t > i) return t;
    return -1;
  }

  // Where the reference, on the ground, loses far more speed in HIT_MS than brakes can: it hits a wall on
  // purpose. The first frame of each loss.
  #hits: number[] | null = null;
  hits() {
    if (!this.#hits) {
      const out: number[] = [];
      let last = -Infinity;
      for (let i = 0; i + HIT_MS < this.n; i++) {
        if (this.wheels[i] === 0 || Math.abs(this.speed[i]) - Math.abs(this.speed[i + HIT_MS]) <= HIT_DROP) continue;
        if (this.teleports.some((t) => t > i && t <= i + HIT_MS)) continue;
        if (i - last > HIT_MS) out.push(i);
        last = i;
      }
      this.#hits = out;
    }
    return this.#hits;
  }

  // The next wall hit after frame i, or -1.
  hitAfter(i: number) {
    for (const h of this.hits()) if (h > i) return h;
    return -1;
  }
}
