// Drives one car along a reference run.
// - On the reference's exact state it copies the reference's keys (that replays the reference).
// - At the reference's speed it follows the reference's own inputs (steering input, brake), which is
//   how it gets through drifts and risky lines, corrected for lateral and heading error.
// - Slower than the reference it drives on grip: steering from the line's curvature, and a speed cap
//   low enough for the steering to hold the line (the reference may drift where a slower car can't).
import { BRAIN_IN, BRAIN_OUT, type Brain } from './brain.ts';
import type { Clearance } from './clearance.ts';
import { SECTION } from './notes.ts';
import type { Reference } from './reference.ts';
import type { Keys, Raw } from './sim.ts';

export interface DriverParams {
  // Share of the reference's speed allowed in corners and braking zones (1 = as fast).
  pace: number;
  // Lateral offset from the reference line, units (positive = left).
  offset: number;
  // How close (units) the car must be to the reference state to copy its keys exactly; 0 never.
  imitate: number;
  // May follow the reference's drifts (otherwise grip only).
  drift: boolean;
  // Braking deceleration assumed when planning speed, units/s^2.
  brake: number;
  // Lateral error is closed over this many seconds of travel.
  latTime: number;
  headGain: number;
}

export const DEFAULT_PARAMS: DriverParams = { pace: 1, offset: 0, imitate: 0.05, drift: true, brake: 30, latTime: 0.35, headGain: 1.2 };

export interface DriverState {
  k: number;
  imitating: boolean;
  // Steering bias (input units) until a frame: mistakes and retries.
  bias: number;
  biasUntil: number;
  // Extra pace multiplier until a frame (retries).
  paceMul: number;
  paceUntil: number;
  // Offset override until a frame (retries).
  off: number;
  offUntil: number;
  // Grip only until a frame (retries).
  gripUntil: number;
  // This run's own way of driving, rolled from the bot's seed at every start and respawn: two slow
  // weaves across the line (amplitude units, wavelength units, phase) and a pace that swings from
  // corner to corner (share, wavelength, phase).
  style: Float64Array;
  // A small input the driver didn't choose (steering input added, or the throttle let off) until a frame.
  noise: number;
  noiseLift: boolean;
  noiseUntil: number;
  // A retry at a jump: the reference's own keys from its frame openFrom on (at time openAt), as they were,
  // until a frame.
  openFrom: number;
  openAt: number;
  openUntil: number;
  // The bot's own lane off the start (units beside the line, + = left), so a grid of bots doesn't leave in
  // single file; it fades out by LANE_ARC.
  lane: number;
}

export const newDriverState = (): DriverState => ({
  k: 0, imitating: true, bias: 0, biasUntil: -1, paceMul: 1, paceUntil: -1, off: 0, offUntil: -1, gripUntil: -1,
  style: new Float64Array(9), noise: 0, noiseLift: false, noiseUntil: -1, openFrom: 0, openAt: 0, openUntil: -1, lane: 0,
});

export const copyDriverState = (st: DriverState): DriverState => ({ ...st, style: st.style.slice() });

// Room outside (units) below which a car running wide at full lock slows down.
const WIDE_ROOM = 2.5;
// Room kept from a wall or edge when the weave moves the line toward it, units.
const STYLE_ROOM = 0.35;
// Distance along the line (units) where a bot's start lane has faded out, and over how much it fades.
const LANE_ARC = 220;
const LANE_FADE = 80;
const TAU = Math.PI * 2;

const WHEELBASE = 2.875;
// Wheel angle at full steering input for a speed in km/h (fit to the physics).
const maxAngle = (kmh: number) => 0.4103 / (1 + (kmh / 64) * (kmh / 64));
// Highest speed (units/s) at which steering alone can hold a curvature, with some margin.
export function gripSpeed(curv: number) {
  const c = Math.abs(curv);
  if (c < 1e-4) return Infinity;
  const r = (0.85 * 0.4103) / (WHEELBASE * c) - 1;
  return r <= 0.05 ? 6 : Math.max(6, (64 * r ** 0.5) / 3.6);
}

const tmp = new Float64Array(1);
// More than this far below the reference (drift weight), its brake is not copied: about 4.4% slower.
const BRAKE_DRIFT = 0.2;

export class Driver {
  readonly ref: Reference;
  readonly p: DriverParams;
  // Per reference frame: shift of the line away from walls and edges (units, + = left).
  offsets: Float32Array | null = null;
  // Room left and right of the reference line, for keeping the weave off walls.
  clear: Clearance | null = null;
  brain: Brain | null = null;
  // An expert's way of driving each section of this reference this run (notes.ts): pace, offset, turn-in.
  sections: Float32Array | null = null;
  skill = 1;
  readonly #x = new Float32Array(BRAIN_IN);
  readonly #y = new Float32Array(BRAIN_OUT);
  // From the last decision, for the planner: lateral error, heading error (rad), distance to the line.
  lat = 0;
  head = 0;
  headPath = 0;
  dist = 0;

  constructor(ref: Reference, p: DriverParams) {
    this.ref = ref;
    this.p = p;
  }

  anchor(r: Raw, st: DriverState) {
    const ref = this.ref;
    const i = ref.search(r.x, r.y, r.z, r.cp, tmp);
    if (i >= 0) st.k = i;
    else st.k = Math.min(ref.n - 1, ref.cpAt[Math.min(r.cp, ref.cpAt.length - 1)] ?? 0);
    st.imitating = false;
  }

  // Moves the progress index to the nearest reference frame; returns the distance.
  track(r: Raw, st: DriverState) {
    const ref = this.ref;
    let i = ref.nearest(r.x, r.y, r.z, st.k - 30, st.k + 300, tmp);
    let d2 = tmp[0];
    if (d2 > 400) {
      const j = ref.search(r.x, r.y, r.z, r.cp, tmp);
      if (j >= 0 && tmp[0] < d2 && Math.abs(ref.cp[j] - r.cp) <= 1) {
        i = j;
        d2 = tmp[0];
      }
    }
    if (i >= 0) st.k = i;
    this.dist = d2 ** 0.5;
    return this.dist;
  }

  decide(f: number, r: Raw, vel: Float32Array, s: number, fw: Float32Array, st: DriverState, out: Keys) {
    const ref = this.ref, p = this.p;
    const k = Math.min(st.k, ref.n - 1);
    const kmh = r.speed;
    const vms = (vel[0] * vel[0] + vel[1] * vel[1] + vel[2] * vel[2]) ** 0.5;
    const free = st.biasUntil < f && st.paceUntil < f && st.offUntil < f && st.gripUntil < f;

    // The reference at k: travel direction t, its up, left = up x t.
    let tx = ref.vx[k], ty = ref.vy[k], tz = ref.vz[k];
    let tn = (tx * tx + ty * ty + tz * tz) ** 0.5;
    if (tn < 1) {
      tx = ref.fx[k];
      ty = ref.fy[k];
      tz = ref.fz[k];
      tn = 1;
    }
    tx /= tn;
    ty /= tn;
    tz /= tn;
    const ux = ref.ux[k], uy = ref.uy[k], uz = ref.uz[k];
    const lx = uy * tz - uz * ty, ly = uz * tx - ux * tz, lz = ux * ty - uy * tx;
    const ex = r.x - ref.px[k], ey = r.y - ref.py[k], ez = r.z - ref.pz[k];
    let offset = (st.offUntil >= f ? st.off : p.offset) + (this.offsets ? this.offsets[Math.min(ref.n - 1, k + 20)] : 0);
    const sty = st.style, sec = this.sections;
    const si = sec ? 3 * Math.min(sec.length / 3 - 1, Math.floor(k / SECTION)) : 0;
    const secOff = sec ? sec[si + 1] : 0;
    const lane = st.lane !== 0 ? st.lane * Math.max(0, Math.min(1, (LANE_ARC - ref.arc[k]) / LANE_FADE)) : 0;
    const calm = free && (sty[0] + sty[3] > 0 || secOff !== 0 || lane !== 0) ? this.#calm(k) : 0;
    if (calm > 0) {
      const a = ref.arc[k];
      const w = calm * (secOff + lane + sty[0] * Math.sin((TAU * a) / sty[1] + sty[2]) + sty[3] * Math.sin((TAU * a) / sty[4] + sty[5]));
      const kk = Math.min(ref.n - 1, k + 20);
      const hi = this.clear ? this.clear.left[kk] - STYLE_ROOM : Infinity, lo = this.clear ? STYLE_ROOM - this.clear.right[kk] : -Infinity;
      if (hi > lo) offset = Math.max(Math.min(offset + w, Math.max(hi, offset)), Math.min(lo, offset));
    }
    const lat = ex * lx + ey * ly + ez * lz - offset;
    // Heading against the reference car's forward, and against the path, about the reference's up.
    const angle = (ax: number, ay: number, az: number) => {
      const cx = ay * fw[2] - az * fw[1], cy = az * fw[0] - ax * fw[2], cz = ax * fw[1] - ay * fw[0];
      return Math.atan2(cx * ux + cy * uy + cz * uz, ax * fw[0] + ay * fw[1] + az * fw[2]);
    };
    const headCar = angle(ref.fx[k], ref.fy[k], ref.fz[k]);
    const headPath = angle(tx, ty, tz);
    this.lat = lat;
    this.head = headCar;
    this.headPath = headPath;

    if (p.imitate > 0 && free) {
      const ad = (ex * ex + ey * ey + ez * ez) ** 0.5;
      const dv = Math.abs(kmh - ref.speed[k]);
      st.imitating = st.imitating
        ? ad < p.imitate * 4 && dv < 1 + 0.01 * Math.abs(ref.speed[k]) && Math.abs(headCar) < 0.02
        : ad < p.imitate && dv < 0.3 + 0.003 * Math.abs(ref.speed[k]) && Math.abs(headCar) < 0.005;
      if (st.imitating) {
        const kk = ref.keys[Math.min(ref.n - 1, k + 1)];
        out.up = (kk & 1) !== 0;
        out.right = (kk & 2) !== 0;
        out.down = (kk & 4) !== 0;
        out.left = (kk & 8) !== 0;
        out.reset = false;
        return;
      }
    } else st.imitating = false;

    // How much of the reference's own technique to use: all of it at its speed, none when slower.
    const vref = Math.abs(ref.speed[k]) || 1;
    const drift = p.drift && st.gripUntil < f ? Math.max(0, Math.min(1, (Math.abs(kmh) / vref - 0.95) / 0.03)) : 0;

    const tp = ref.teleportAfter(k);
    const lead = Math.max(k, Math.min(ref.n - 1, tp > 0 ? tp - 1 : Infinity, k + 12 + (sec && free ? Math.round(sec[si + 2]) : 0)));
    const amax = maxAngle(Math.abs(kmh));
    const closeDist = Math.max(3, p.latTime * Math.max(vms, 6));
    const wantHead = -Math.atan(lat / closeDist);
    const fbCar = Math.max(-0.8, Math.min(0.8, (0.25 * p.headGain * (wantHead - headCar)) / Math.max(amax, 0.02)));
    const fbPath = Math.max(-0.8, Math.min(0.8, (0.25 * p.headGain * (wantHead - headPath)) / Math.max(amax, 0.02)));
    const ratio = Math.max(0.5, Math.min(2.5, maxAngle(Math.abs(ref.speed[lead])) / amax));
    const sDrift = ref.steer[lead] * ratio ** 0.7 + fbCar;
    // Grip-only (a retry after a spin): steer for the line's curvature instead of the reference's input.
    const grip = st.gripUntil >= f ? 1 : 0;
    const sGrip = Math.atan(ref.curv[lead] * WHEELBASE) / amax + fbPath;
    let target = grip ? sGrip : sDrift;
    let paceAdj = 0;
    if (this.brain) {
      const x = this.#x, at = (ms: number) => Math.min(ref.n - 1, k + ms);
      const clamp = (v: number, m: number) => (v > m ? m : v < -m ? -m : v);
      x[0] = kmh / 100;
      x[1] = s;
      x[2] = clamp(target, 1.5);
      x[3] = clamp(lat / 2, 2);
      x[4] = clamp(headCar, 1.5);
      x[5] = clamp(headPath, 1.5);
      x[6] = clamp((kmh - ref.speed[k]) / 50, 2);
      x[7] = ref.speed[k] / 100;
      x[8] = ref.steer[at(100)];
      x[9] = ref.steer[at(250)];
      x[10] = ref.steer[at(500)];
      x[11] = ref.steer[at(1000)];
      x[12] = clamp(ref.curv[at(100)] * 3, 1);
      x[13] = clamp(ref.curv[at(250)] * 3, 1);
      x[14] = clamp(ref.curv[at(500)] * 3, 1);
      x[15] = clamp(ref.curv[at(1000)] * 3, 1);
      x[16] = this.clear ? clamp((this.clear.left[k] - offset) / 4, 2) : 1;
      x[17] = this.clear ? clamp((this.clear.right[k] + offset) / 4, 2) : 1;
      x[18] = r.wheels / 4;
      x[19] = drift;
      x[20] = clamp(vel[1] / 20, 2);
      x[21] = clamp((vel[0] * lx + vel[1] * ly + vel[2] * lz) / Math.max(vms, 1), 1.5);
      x[22] = this.skill;
      x[23] = ref.jumpIn(k, 1000) === Infinity ? 0 : 1;
      const y = this.brain.run(x, this.#y);
      target += y[0];
      paceAdj = y[1];
    }
    if (st.biasUntil >= f) target += st.bias;
    if (st.noiseUntil >= f) target += st.noise;
    if (kmh < -3) target = -target;
    target = target > 1 ? 1 : target < -1 ? -1 : target;
    // Each frame the input moves 0.01 toward +1 (left), -1 (right) or 0 (neither): pick the closest.
    const toZero = s > 0 ? Math.max(0, s - 0.01) : Math.min(0, s + 0.01);
    const eL = Math.abs(Math.min(1, s + 0.01) - target), eR = Math.abs(Math.max(-1, s - 0.01) - target), eN = Math.abs(toZero - target);
    out.left = eL < eR && eL < eN;
    out.right = eR < eL && eR < eN;

    const rk = ref.keys[Math.min(ref.n - 1, k + 1)];
    let up = (rk & 1) !== 0, down = (rk & 4) !== 0;
    const pace = p.pace * (st.paceUntil >= f ? st.paceMul : 1);
    let allow = this.#allowed(k, vms, pace, grip === 1, st) * Math.exp(paceAdj + (sec && st.paceUntil < f ? sec[si] : 0));
    // Steering already at full lock and still drifting wide: the corner is too fast for this line. With room
    // to spare outside that is fine; short of it, lift, and brake only when the room runs out.
    const wide = target * lat > 0 ? 0 : Math.abs(lat);
    if (Math.abs(target) > 0.97 && wide > 0.3) {
      const kk = Math.min(ref.n - 1, k + 20), at = lat + offset;
      const room = this.clear ? (lat > 0 ? this.clear.left[kk] - at : this.clear.right[kk] + at) : 0;
      if (room < WIDE_ROOM) allow = Math.min(allow, room < 0.8 ? vms - 5 : vms - 0.6 - 2 * wide);
    }
    if (vms > allow + 4) {
      up = false;
      down = true;
    } else if (vms > allow + 0.5) up = false;
    else if (down && drift < BRAKE_DRIFT) {
      // The reference brakes into a drift from a higher speed; this car is already slow enough.
      down = false;
      up = vms < allow;
    } else if (!up && vms < Math.min(allow, vref / 3.6) - 3) {
      // Far slower than the reference where it coasts (after a respawn, a wreck): drive.
      up = true;
      down = false;
    }
    if (r.wheels === 0) {
      up = (rk & 1) !== 0;
      down = (rk & 4) !== 0;
    }
    if (st.noiseUntil >= f && st.noiseLift) up = false;
    out.up = up;
    out.down = down;
    out.reset = false;
  }

  // How much of a run's own style may show here: none in a jump's run-up or just before a takeoff (where
  // only the reference's own line and speed get there), faded in and out over 1.5 s.
  #calm(k: number) {
    const ref = this.ref;
    let clear = 0;
    for (let i = 0; i < 4; i++) {
      const j = Math.min(ref.n - 1, k + i * 500);
      if (!ref.runUp(j) && ref.jumpIn(j, 2200) === Infinity) clear++;
    }
    return clear / 4;
  }

  // Highest speed (units/s) here from which every capped speed ahead can still be reached by braking.
  #allowed(k: number, vms: number, pace: number, grip: boolean, st: DriverState) {
    const sty = st.style;
    const ref = this.ref;
    const horizon = Math.max(30, (vms * vms) / (2 * this.p.brake) + 25);
    const a = ref.arc[k];
    // A respawn ends what lies ahead: past it the reference stands at the gate, which is no speed to slow for.
    const tp = ref.teleportAfter(k);
    let allow = Infinity;
    let i = k;
    for (let n = 0; n < 48 && i < ref.n && (tp < 0 || i < tp); n++) {
      const d = ref.arc[i] - a;
      if (d > horizon) break;
      const vr = Math.abs(ref.speed[i]) / 3.6;
      const c = Math.abs(ref.curv[i]);
      // Short of a jump every bot carries the reference's speed, or it falls short.
      const slow = ((ref.keys[i] & 4) !== 0 || Math.abs(ref.steer[i]) > 0.3) && ref.jumpIn(i, 2200) === Infinity;
      // Before a long flight only a retry's own slowdown counts, not the bot's usual pace.
      const q = slow && ref.runUp(i) ? pace / this.p.pace : pace;
      const swing = slow && !ref.runUp(i) ? 1 + sty[6] * Math.sin((TAU * ref.arc[i]) / (sty[7] || 1) + sty[8]) : 1;
      let cap = slow ? q * vr * swing : vr + 1;
      if (grip) cap = Math.min(cap, gripSpeed(c));
      const reach = (cap * cap + 2 * this.p.brake * d) ** 0.5;
      if (reach < allow) allow = reach;
      const next = ref.ahead(i, Math.max(1.5, horizon / 40));
      i = next > i ? next : i + 16;
    }
    return allow;
  }
}
