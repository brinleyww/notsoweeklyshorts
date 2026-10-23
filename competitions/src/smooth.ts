// Draws every other car where it is now, or as close to now as its states allow. A car may run at
// most LEAD_MS past the newest state its page sent, carried on by that state's speed, acceleration and
// turn; each car has its own delay: how old its newest state was each time new states landed (a high
// percentile over the last 10 s, plus about a frame), less the lead. With states that come quickly
// (rtc.js) the delay is 0 and the car is drawn at its own time now. Its playback runs at most 5% fast
// or slow to follow that delay, and eases to a stop at the lead's end when states run late. When new
// states change where the car should have been, the difference fades out over CORRECT_MS instead of
// moving the car at once. "Now" is the cup clock less the car's start (its stamps), or failing that
// this page's fastest delivery. The game's own remote playback gets no states and just draws what is
// set here. In a collision cup each drawn car also carries where it is heading (__cupKeys, for the
// sim worker's collisions), and a hit felt here pushes the other car at once (nudgeCar).
import type { Car, CarState, CarUpdate, Connection, Native, Quat, Vec3 } from './game.ts';

interface Sample {
  at: number;
  ms: number;
}
interface Pose {
  i: number;
  u: number;
  position: Vec3;
  quaternion: Quat;
}
interface Lane {
  id: number;
  session: number;
  resets: number;
  // Real states by frames; cuts[i] means states[i] can't be reached smoothly from states[i - 1].
  states: CarState[];
  cuts: boolean[];
  // The moment drawn, in the car's own frames. Null before it starts.
  at: number | null;
  // How old the newest state was (the car's own ms) each time new states landed.
  ages: Sample[];
  age: number;
  // Whether the ages were taken on the cup clock (the car's start known) or against `late`.
  clocked: boolean;
  // Arrival minus frames of each newest state; the smallest is the fastest delivery.
  lates: Sample[];
  late: number | null;
  attack: number;
  stall: number;
  eventAt: number;
  seenAt: number;
  drawnAt: number;
  drawnFrame: number;
  car: unknown;
  fresh: boolean;
  // Where the states put the car at `at` when it was drawn (and how fast it went there), whether
  // states came since, and what is left of the corrections being faded out.
  ideal: { position: Vec3; quaternion: Quat; velocity: Vec3 } | null;
  dirty: boolean;
  err: Vec3;
  errV: Vec3;
  qerr: Quat;
  // A hit felt on this page: the change of velocity (metres per ms) from the moment `at`, and the
  // velocity the states gave the car then.
  nudge: { at: number; dv: Vec3; v0: Vec3 } | null;
  shown: CarState | null;
  drawn: Vec3 | null;
  underruns: number;
  resyncs: number;
}
type Lerp = (a: CarState, b: CarState, t: number) => CarState;
// A car as drawn here, plus the poses the sim worker collides with: the drawn one at frame f, then ahead.
export interface CupKey {
  f: number;
  p: [number, number, number];
  q: [number, number, number, number];
}
type DrawnCar = Pick<Car, 'setCarState'> & { __cupKeys?: CupKey[] | null };
export interface CarClock {
  // Cup clock minus performance.now().
  offset: number;
  // When the car started, on the cup clock.
  startOf(id: number): number | undefined;
}

const WINDOW_MS = 10_000;
const QUANTILE = 0.98;
// Until a car has this many samples its delay leans on the other cars'.
const MIN_SAMPLES = 8;
const PRIOR_MS = 150;
const MAX_DELAY_MS = 1500;
// How far past its newest state a car may be carried on.
const LEAD_MS = 120;
const CORRECT_MS = 100;
// Metres per ms; a bigger change of speed is a real one (a crash), not one to hide.
const MAX_ERR_SPEED = 0.02;
// Metres per ms²; more than this between three states is a crash, not something to carry on.
const MAX_ACCEL = 0.0015;
// Two readings agree within this share of the larger, plus this many metres per ms².
const ACCEL_AGREE = 0.5;
const ACCEL_SLACK = 0.00005;
// After states ran out, the delay goes up at once and comes back down at 100 ms a second (not at all
// once the car has finished: its page then sends once a second).
const ATTACK_DECAY = 0.1;
const WARP = 0.05;
const WARP_MS = 500;
// Further than this from where it should be drawn, a car jumps there instead of catching up.
const RESYNC_MS = 500;
const SNAP_DT_MS = 250;
// Within this of the end of its lead a car slows, so running out of states is a stop, not a wall.
const SOFT_MS = 15;
const MAX_SEG_MS = 150;
const RESET_JUMP_M = 5;
// States that land within this of each other came in one batch.
const EVENT_MS = 8;
// A run with a lower count than one that is still sending is a late copy of the run before.
const STALE_MS = 1000;
const MAX_STATES = 200;
const FORGET_MS = 30_000;
// The game draws remote cars at their state's own time.
const GAME_DELAY = 0;
// A hit pushes the other car until its own states show the push, or for this long of its time.
const NUDGE_MS = 400;
// How far ahead of the drawn pose the collision keys go.
const KEYS_AHEAD = [40, 80, 120];

const ZERO: Vec3 = { x: 0, y: 0, z: 0 };
const IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 };
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const scale = (a: Vec3, k: number): Vec3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a: Vec3) => Math.hypot(a.x, a.y, a.z);
const cap = (v: Vec3, max: number) => {
  const m = len(v);
  return m > max ? scale(v, max / m) : v;
};
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const before = (session: number, resets: number, o: { session: number; resets: number }) =>
  session < o.session || (session === o.session && resets < o.resets);
const qmul = (a: Quat, b: Quat): Quat => ({
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
});
const qinv = (q: Quat): Quat => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });

// Also carries on past b for t > 1, at the same rate of turn.
function slerp(a: Quat, b: Quat, t: number): Quat {
  let d = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  let c = b;
  if (d < 0) {
    d = -d;
    c = { x: -b.x, y: -b.y, z: -b.z, w: -b.w };
  }
  if (d > 0.9995) {
    const q = { x: a.x + (c.x - a.x) * t, y: a.y + (c.y - a.y) * t, z: a.z + (c.z - a.z) * t, w: a.w + (c.w - a.w) * t };
    const n = Math.hypot(q.x, q.y, q.z, q.w) || 1;
    return { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n };
  }
  const th = Math.acos(d),
    s = Math.sin(th);
  const ka = Math.sin((1 - t) * th) / s,
    kb = Math.sin(t * th) / s;
  const q = { x: a.x * ka + c.x * kb, y: a.y * ka + c.y * kb, z: a.z * ka + c.z * kb, w: a.w * ka + c.w * kb };
  const n = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  return { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n };
}
// A page whose game has no lerpCarState (loaded before it existed) still gets positions and rotations.
const plainLerp: Lerp = (a, b, t) => ({ ...a, quaternion: slerp(a.quaternion, b.quaternion, t) });

function quantile(values: number[], q: number) {
  const s = [...values].sort((x, y) => x - y);
  const i = (s.length - 1) * q,
    lo = Math.floor(i);
  return lo + 1 < s.length ? s[lo] + (s[lo + 1] - s[lo]) * (i - lo) : s[lo];
}
const median = (values: number[]) => quantile(values, 0.5);

// A respawn or teleport, a lost stretch of states, a reset press or the start: never drawn as motion.
function cut(a: CarState, b: CarState) {
  const dt = b.frames - a.frames;
  if (dt > MAX_SEG_MS || a.hasStarted !== b.hasStarted || (!a.controls.reset && b.controls.reset)) return true;
  const reach = (Math.max(Math.abs(a.speedKmh), Math.abs(b.speedKmh)) / 3.6) * (dt / 1000) * 1.5 + 2;
  return len(sub(b.position, a.position)) > reach;
}

function hermite(a: Vec3, va: Vec3, b: Vec3, vb: Vec3, u: number, h: number): Vec3 {
  const u2 = u * u,
    u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1,
    h10 = (u3 - 2 * u2 + u) * h,
    h01 = 3 * u2 - 2 * u3,
    h11 = (u3 - u2) * h;
  return {
    x: h00 * a.x + h10 * va.x + h01 * b.x + h11 * vb.x,
    y: h00 * a.y + h10 * va.y + h01 * b.y + h11 * vb.y,
    z: h00 * a.z + h10 * va.z + h01 * b.z + h11 * vb.z,
  };
}

export class Feed {
  listeners = new Set<CarUpdate>();
  lanes = new Map<number, Lane>();
  // The newest run seen per car (a reset can come before that run's first state).
  floors = new Map<number, { session: number; resets: number; at: number }>();
  // Shared by cars that have no delay of their own yet, and kept from round to round.
  prior = PRIOR_MS;
  margin = 20;
  #dts: number[] = [];
  #frame = 0;
  #clock: CarClock | null = null;
  #collisions = false;

  constructor(private lerp: Lerp = plainLerp) {}

  #newLane(id: number, session: number, resets: number, now: number): Lane {
    return {
      id,
      session,
      resets,
      states: [],
      cuts: [],
      at: null,
      ages: [],
      age: 0,
      clocked: false,
      lates: [],
      late: null,
      attack: 0,
      stall: 0,
      eventAt: -Infinity,
      seenAt: now,
      drawnAt: 0,
      drawnFrame: -1,
      car: null,
      fresh: true,
      ideal: null,
      dirty: false,
      err: ZERO,
      errV: ZERO,
      qerr: IDENTITY,
      nudge: null,
      shown: null,
      drawn: null,
      underruns: 0,
      resyncs: 0,
    };
  }

  #start(lane: Lane) {
    const start = this.#clock?.startOf(lane.id);
    return start != null && Number.isFinite(start) ? start : null;
  }

  // The car's own time now: on the cup clock, or as of this page's fastest delivery.
  #now(lane: Lane, now: number) {
    const start = this.#start(lane);
    return start != null ? now + this.#clock!.offset - start : now - lane.late!;
  }

  // How far a car may be carried on past state i.
  #lead(lane: Lane, i: number) {
    const s = lane.states[i];
    return s.hasStarted && s.finishFrames == null && !s.controls.reset && i > 0 && !lane.cuts[i] ? LEAD_MS : 0;
  }

  // How far behind its own time now a car is drawn (ms).
  delay(lane: Lane) {
    let d = this.prior;
    if (lane.ages.length) {
      const w = Math.min(1, lane.ages.length / MIN_SAMPLES);
      d += w * (lane.age + this.margin - LEAD_MS - d);
    }
    return clamp(Math.max(d, lane.attack), 0, MAX_DELAY_MS);
  }

  arrive(session: number, id: number, resets: number, state: CarState, now: number) {
    const floor = this.floors.get(id);
    if (floor && before(session, resets, floor) && now - floor.at < STALE_MS) return;
    let lane = this.lanes.get(id);
    if (!lane || lane.session !== session || lane.resets !== resets) {
      lane = this.#newLane(id, session, resets, now);
      this.lanes.set(id, lane);
    }
    const { states, cuts } = lane;
    let i = states.length;
    while (i > 0 && states[i - 1].frames >= state.frames) i--;
    if (states[i]?.frames === state.frames) return;
    if (i < states.length) {
      // Older than what has already gone by: nothing left to put it next to.
      if (i === 0 && lane.at != null && state.frames < lane.at) return;
      const at = lane.at;
      // States that fill a gap late came late as far as the delay goes (the car stood still there if
      // it had reached the gap).
      if (i > 0 && cuts[i] && !cut(states[i - 1], state) && state.hasStarted && lane.late != null && now - lane.eventAt >= EVENT_MS) {
        lane.eventAt = now;
        this.#landed(lane, states[i - 1], now, at != null && at >= states[i - 1].frames + this.#lead(lane, i - 1) - 1);
      }
      states.splice(i, 0, state);
      cuts.splice(i, 0, i > 0 && cut(states[i - 1], state));
      cuts[i + 1] = cut(state, states[i + 1]);
    } else this.#newest(lane, state, now);
    lane.dirty = true;
    lane.seenAt = now;
    this.floors.set(id, { session, resets, at: now });
    if (states.length > MAX_STATES) {
      states.shift();
      cuts.shift();
    }
  }

  #newest(lane: Lane, state: CarState, now: number) {
    const n = lane.states.length;
    const prev = lane.states[n - 1];
    const dry = !!prev && lane.at != null && lane.at >= prev.frames + this.#lead(lane, n - 1) - 1;
    const broken = !!prev && cut(prev, state);
    lane.states.push(state);
    lane.cuts.push(broken);
    if (!state.hasStarted) return;
    const event = now - lane.eventAt >= EVENT_MS;
    if (event) lane.eventAt = now;
    const late = now - state.frames;
    while (lane.lates.length && now - lane.lates[0].at > WINDOW_MS) lane.lates.shift();
    const last = lane.lates[lane.lates.length - 1];
    if (!event && last) last.ms = Math.min(last.ms, late);
    else lane.lates.push({ at: now, ms: late });
    lane.late = Math.min(...lane.lates.map((l) => l.ms));
    if (event && prev?.hasStarted && !broken) this.#landed(lane, prev, now, dry);
  }

  // States landed after `prev`: how old it was by then is what the car's delay and lead have to cover.
  #landed(lane: Lane, prev: CarState, now: number, dry: boolean) {
    const clocked = this.#start(lane) != null;
    if (clocked !== lane.clocked) {
      lane.clocked = clocked;
      lane.ages = [];
      lane.attack = 0;
    }
    const age = this.#now(lane, now) - prev.frames;
    const racing = prev.finishFrames == null;
    if (racing && age > this.delay(lane) + LEAD_MS + RESYNC_MS) {
      // A long stall while racing: the car jumps on (draw()) instead of everyone waiting longer, unless
      // these states show it finished (its page then sends once a second).
      if (dry) lane.stall = age + this.margin - LEAD_MS;
      return;
    }
    if (dry) {
      lane.underruns++;
      lane.attack = Math.max(lane.attack, age + this.margin - LEAD_MS);
    }
    if (!racing) return;
    while (lane.ages.length && now - lane.ages[0].at > WINDOW_MS) lane.ages.shift();
    lane.ages.push({ at: now, ms: age });
    lane.age = quantile(
      lane.ages.map((n) => n.ms),
      QUANTILE,
    );
  }

  // The game has put the car back at the start: the run before it is never drawn again.
  reset(session: number, id: number, resets: number, now: number) {
    const floor = this.floors.get(id);
    if (!floor || !before(session, resets, floor)) this.floors.set(id, { session, resets, at: now });
    const lane = this.lanes.get(id);
    if (!lane || before(session, resets, lane)) return;
    if (lane.session === session && lane.resets === resets) lane.fresh = true;
    else this.lanes.delete(id);
  }

  // Metres per ms at state i, from its neighbours.
  #velocity(lane: Lane, i: number): Vec3 {
    const { states, cuts } = lane;
    const p = states[i].position;
    const back = i > 0 && !cuts[i] ? sub(p, states[i - 1].position) : null;
    const ahead = i + 1 < states.length && !cuts[i + 1] ? sub(states[i + 1].position, p) : null;
    const hb = back ? states[i].frames - states[i - 1].frames : 0;
    const ha = ahead ? states[i + 1].frames - states[i].frames : 0;
    if (back && ahead) {
      // A crash or a reversal: no overshoot past the turning point.
      if (dot(back, ahead) <= 0) return ZERO;
      return cap(scale({ x: back.x + ahead.x, y: back.y + ahead.y, z: back.z + ahead.z }, 1 / (hb + ha)), 1.5 * Math.max(len(back) / hb, len(ahead) / ha));
    }
    if (back) return add(scale(back, 1 / hb), scale(this.#accel(lane, i), hb / 2));
    if (ahead) return scale(ahead, 1 / ha);
    return ZERO;
  }

  // Metres per ms² over the two steps before state i, when the reading a step earlier agrees (a steady
  // turn or braking, not a hit or a landing, which carried on would overshoot), or none.
  #accel(lane: Lane, i: number): Vec3 {
    const now = this.#accelOver(lane, i),
      was = this.#accelOver(lane, i - 1);
    if (!now || !was) return ZERO;
    return len(sub(now, was)) > ACCEL_AGREE * Math.max(len(now), len(was)) + ACCEL_SLACK ? ZERO : now;
  }

  #accelOver(lane: Lane, i: number): Vec3 | null {
    const { states, cuts } = lane;
    if (i < 2 || cuts[i] || cuts[i - 1]) return null;
    const a = states[i - 2],
      b = states[i - 1],
      c = states[i];
    const d0 = b.frames - a.frames,
      d1 = c.frames - b.frames;
    const acc = scale(sub(scale(sub(c.position, b.position), 1 / d1), scale(sub(b.position, a.position), 1 / d0)), 2 / (d0 + d1));
    return len(acc) > MAX_ACCEL ? null : acc;
  }

  // Where the states put the car at `t` (its own ms): on a state, between two, or carried on past one.
  #pose(lane: Lane, t: number): Pose {
    const { states, cuts } = lane;
    let i = states.length - 1;
    while (i > 0 && states[i].frames > t) i--;
    const a = states[i];
    if (t <= a.frames) return { i, u: 0, position: a.position, quaternion: a.quaternion };
    if (i === states.length - 1 || cuts[i + 1]) {
      const h = Math.min(t - a.frames, this.#lead(lane, i));
      if (h <= 0) return { i, u: 0, position: a.position, quaternion: a.quaternion };
      const p = states[i - 1];
      const v = this.#velocity(lane, i),
        acc = this.#accel(lane, i);
      return {
        i,
        u: 0,
        position: add(add(a.position, scale(v, h)), scale(acc, (h * h) / 2)),
        quaternion: slerp(p.quaternion, a.quaternion, 1 + h / (a.frames - p.frames)),
      };
    }
    const b = states[i + 1];
    const h = b.frames - a.frames;
    const u = (t - a.frames) / h;
    // At most 3x the segment's own speed at either end, so the curve never loops past b.
    const most = (3 * len(sub(b.position, a.position))) / h;
    const position = hermite(a.position, cap(this.#velocity(lane, i), most), b.position, cap(this.#velocity(lane, i + 1), most), u, h);
    return { i, u, position, quaternion: slerp(a.quaternion, b.quaternion, u) };
  }

  // Metres per ms along the drawn path at `t`.
  #rate(lane: Lane, t: number, at: Pose) {
    return sub(at.position, this.#pose(lane, t - 1).position);
  }

  // Once a frame, before the game moves and draws the cars. `dt` is the frame's own time (ms).
  frame(
    now: number,
    dt: number,
    session: number | undefined,
    carOf: (id: number) => DrawnCar | undefined,
    collisions: boolean,
    clock: CarClock | null = null,
  ) {
    this.#collisions = collisions;
    this.#clock = clock;
    this.#frame++;
    this.#dts.push(dt);
    if (this.#dts.length > 31) this.#dts.shift();
    this.margin = Math.max(20, 1.2 * median(this.#dts));
    const racing: number[] = [];
    for (const [id, lane] of this.lanes) {
      if (now - lane.seenAt > FORGET_MS) {
        this.lanes.delete(id);
        continue;
      }
      const newest = lane.states[lane.states.length - 1];
      if (lane.ages.length >= MIN_SAMPLES && newest?.hasStarted && newest.finishFrames == null && now - lane.seenAt < 2000)
        racing.push(lane.age + this.margin - LEAD_MS);
      if (lane.session !== session) continue;
      const car = carOf(id);
      if (car) this.#draw(lane, car, now, dt);
    }
    if (racing.length) this.prior = clamp(median(racing), 0, MAX_DELAY_MS);
  }

  // How far behind where car `id` really is now it is drawn (ms), once its start on the cup clock is known.
  behind(id: number, now: number) {
    const lane = this.lanes.get(id);
    if (!lane || lane.at == null || this.#start(lane) == null) return null;
    return Math.max(0, this.#now(lane, now) - lane.at);
  }

  // A hit felt on this page changed car `id`'s velocity by `dv` (metres per ms).
  nudge(id: number, dv: Vec3) {
    const lane = this.lanes.get(id);
    if (!lane?.ideal || lane.at == null) return;
    this.#settle(lane);
    lane.nudge = { at: lane.at, dv, v0: lane.ideal.velocity };
  }

  // A push that ends hands what it moved the car to the fading corrections.
  #settle(lane: Lane) {
    const nudge = lane.nudge;
    if (!nudge || lane.at == null) return;
    lane.err = add(lane.err, scale(nudge.dv, Math.max(0, lane.at - nudge.at)));
    lane.errV = add(lane.errV, nudge.dv);
    lane.nudge = null;
  }

  #keys(car: DrawnCar, lane: Lane, at: number, position: Vec3, quaternion: Quat) {
    if (!this.#collisions) {
      if (car.__cupKeys) car.__cupKeys = null;
      return;
    }
    const v = lane.ideal ? add(add(lane.ideal.velocity, lane.errV), lane.nudge?.dv ?? ZERO) : ZERO;
    const key = (f: number, p: Vec3, q: Quat): CupKey => ({ f, p: [p.x, p.y, p.z], q: [q.x, q.y, q.z, q.w] });
    car.__cupKeys = [
      key(at, position, quaternion),
      ...KEYS_AHEAD.map((ahead) =>
        key(at + ahead, add(position, scale(v, ahead)), lane.ideal ? qmul(lane.qerr, this.#pose(lane, at + ahead).quaternion) : quaternion),
      ),
    ];
  }

  #draw(lane: Lane, car: DrawnCar, now: number, frameDt: number) {
    const { states, cuts } = lane;
    const newest = states[states.length - 1];
    if (!newest) return;
    const dt = lane.drawnFrame === this.#frame - 1 ? frameDt : lane.drawnAt ? now - lane.drawnAt : Infinity;
    lane.drawnAt = now;
    lane.drawnFrame = this.#frame;
    if (newest.finishFrames == null) lane.attack = Math.max(0, lane.attack - ATTACK_DECAY * Math.min(dt, SNAP_DT_MS));
    else if (lane.stall) lane.attack = Math.max(lane.attack, lane.stall);
    lane.stall = 0;
    let reset = lane.fresh || car !== lane.car;
    lane.fresh = false;
    lane.car = car;
    if (!newest.hasStarted || lane.late == null) {
      lane.at = null;
      lane.ideal = null;
      lane.err = lane.errV = ZERO;
      lane.qerr = IDENTITY;
      lane.nudge = null;
      lane.dirty = false;
      if (!reset && lane.shown === newest) return;
      lane.shown = newest;
      lane.drawn = newest.position;
      car.setCarState({ ...newest, collisionImpulses: [] }, reset);
      this.#keys(car, lane, newest.frames, newest.position, newest.quaternion);
      return;
    }
    const limit = newest.frames + this.#lead(lane, states.length - 1);
    const target = this.#now(lane, now) - this.delay(lane);
    const from = lane.at;
    let at: number;
    const snap = from == null || dt > SNAP_DT_MS || target - from > RESYNC_MS;
    if (snap) {
      at = Math.max(from ?? -Infinity, Math.min(target, limit));
      if (from != null && at > from) lane.resyncs++;
    } else {
      // A car past its limit (its newest state just ended the lead: a finish, a respawn) waits there.
      let step = dt * (1 + clamp((target - from - dt) / WARP_MS, -WARP, WARP));
      const room = limit - from;
      if (room < SOFT_MS + step) step *= Math.max(0, room) / (Math.max(0, room) + SOFT_MS);
      at = from + Math.max(0, Math.min(step, room));
    }
    lane.at = at;
    let jumped = snap;
    if (reset || snap || !lane.ideal) {
      lane.err = lane.errV = ZERO;
      lane.qerr = IDENTITY;
      lane.nudge = null;
    } else {
      if (lane.dirty) {
        // New states moved where the car should have been last frame, and how fast: draw it where it
        // was, going as it went, and fade the difference out, unless it is too far for that.
        const was = this.#pose(lane, from!);
        const err = add(lane.err, sub(lane.ideal.position, was.position));
        if (len(err) > RESET_JUMP_M) {
          lane.err = lane.errV = ZERO;
          lane.qerr = IDENTITY;
          jumped = true;
        } else {
          lane.err = err;
          lane.errV = cap(add(lane.errV, sub(lane.ideal.velocity, this.#rate(lane, from!, was))), MAX_ERR_SPEED);
          lane.qerr = qmul(qmul(lane.qerr, lane.ideal.quaternion), qinv(was.quaternion));
        }
      }
      // Critically damped, so a correction never changes the car's speed at once.
      const h = Math.min(dt, SNAP_DT_MS),
        w = 1 / CORRECT_MS,
        k = Math.exp(-w * h);
      const x0 = lane.err,
        v0 = lane.errV;
      const c = add(v0, scale(x0, w));
      lane.err = scale(add(x0, scale(c, h)), k);
      lane.errV = scale(sub(v0, scale(c, w * h)), k);
      lane.qerr = slerp(IDENTITY, lane.qerr, Math.exp(-h / CORRECT_MS));
    }
    lane.dirty = false;
    if (at === from && !reset && !lane.nudge && lane.drawn && len(lane.err) < 1e-4 && len(lane.errV) < 1e-6 && 1 - Math.abs(lane.qerr.w) < 1e-9) return;
    const pose = this.#pose(lane, at);
    lane.ideal = { position: pose.position, quaternion: pose.quaternion, velocity: this.#rate(lane, at, pose) };
    // A push shows until the car's own states show it (half of it along its direction) or it runs out.
    let push = ZERO;
    const nudge = lane.nudge;
    if (nudge) {
      const shown = dot(sub(lane.ideal.velocity, nudge.v0), nudge.dv) / (dot(nudge.dv, nudge.dv) || 1);
      if (shown >= 0.5 || at - nudge.at > NUDGE_MS) this.#settle(lane);
      else push = scale(nudge.dv, Math.max(0, at - nudge.at));
    }
    // Real states passed this frame: their hits sound once, and a cut among them may need a reset.
    let impulses: number[] = [];
    for (let j = pose.i; j >= 0 && states[j].frames > (from ?? Infinity); j--) {
      if (states[j].frames > at) continue;
      if (!snap && states[j].collisionImpulses.length) impulses = impulses.concat(states[j].collisionImpulses);
      if (cuts[j]) jumped = true;
    }
    const a = states[pose.i];
    const base =
      pose.u > 0
        ? { ...this.lerp(a, states[pose.i + 1], pose.u), hasStarted: a.hasStarted, brakeLightEnabled: a.brakeLightEnabled, controls: a.controls }
        : a;
    const state: CarState = {
      ...base,
      frames: Math.max(a.frames, Math.round(at)),
      position: add(add(pose.position, lane.err), push),
      quaternion: qmul(lane.qerr, pose.quaternion),
      collisionImpulses: impulses,
    };
    if (jumped && lane.drawn && len(sub(state.position, lane.drawn)) > RESET_JUMP_M) reset = true;
    lane.drawn = state.position;
    car.setCarState(state, reset);
    this.#keys(car, lane, at, state.position, state.quaternion);
    // Three states before the one drawn are kept for its velocity and acceleration.
    while (states.length > 4 && states[3].frames <= at) {
      states.shift();
      cuts.shift();
    }
  }
}

const feeds = new WeakMap<Connection, Feed>();

// A callback marked raw (live timing) gets every state the moment it arrives.
export function rawCarUpdates(cb: CarUpdate) {
  return Object.assign(cb, { raw: true });
}

export function installSmoothing(native: Native) {
  const lerp: Lerp | undefined = native.lerpCarState;
  for (const C of [native.Host, native.Client]) {
    const proto = C.prototype as Connection;
    const add = proto.addCarUpdateCallback;
    const remove = proto.removeCarUpdateCallback;
    proto.addCarUpdateCallback = function (this: Connection, cb: CarUpdate) {
      if ((cb as { raw?: boolean }).raw) return add.call(this, cb);
      let feed = feeds.get(this);
      if (!feed) {
        const f = (feed = new Feed(lerp));
        feeds.set(this, f);
        add.call(this, rawCarUpdates((session, id, resets, state) => f.arrive(session, id, resets, state, performance.now())));
        this.addCarResetCallback((session, id, resets) => f.reset(session, id, resets, performance.now()));
      }
      feed.listeners.add(cb);
    };
    proto.removeCarUpdateCallback = function (this: Connection, cb: CarUpdate) {
      if (feeds.get(this)?.listeners.delete(cb)) return;
      return remove.call(this, cb);
    };
    Object.defineProperty(proto, 'remoteDelay', {
      configurable: true,
      get(this: Connection) {
        return GAME_DELAY;
      },
      set() {},
    });
  }
}

// Once a frame, just before the game moves and draws the other cars. `dt` is in ms.
export function drawCars(
  connection: Connection | undefined,
  session: number | undefined,
  carOf: (id: number) => DrawnCar | undefined,
  now: number,
  dt: number,
  collisions: boolean,
  clock: CarClock | null = null,
) {
  const feed = connection && feeds.get(connection);
  if (feed) feed.frame(now, dt, session, carOf, collisions, clock);
}

export function ghostBehind(connection: Connection | undefined, id: number, now: number) {
  const feed = connection && feeds.get(connection);
  return feed ? feed.behind(id, now) : null;
}

// A hit on this page changed car `id`'s velocity by `dv` (world units a second): draw it pushed now.
export function nudgeCar(connection: Connection | undefined, id: number, dv: [number, number, number]) {
  const feed = connection && feeds.get(connection);
  feed?.nudge(id, { x: dv[0] / 1000, y: dv[1] / 1000, z: dv[2] / 1000 });
}
