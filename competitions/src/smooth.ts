// Draws every other car a little in the past, between two real states this page already has, so a
// car is never drawn past the newest state its page sent and nothing is guessed. Each car has its own
// delay: how far behind its newest state this page was each time new states landed (a high
// percentile over the last 10 s, plus about a frame). Its playback runs at most 5% fast or slow to
// follow that delay, and stops at the newest state when states run late. Everything is timed by this
// page's performance.now(), so clock syncs and stamps never move a drawn car. The game's own remote
// playback gets no states and just draws what is set here. Bumper cars keep the game's own playback
// (0.25 s behind its newest state).
import type { Car, CarState, CarUpdate, Connection, Native, Quat, Vec3 } from './game.ts';

interface Sample {
  at: number;
  ms: number;
}
interface Segment {
  a: CarState;
  b: CarState;
  // Velocities at a and b in metres per ms, fixed when the car enters the segment so states that land
  // later never bend the path under it.
  va: Vec3;
  vb: Vec3;
}
interface Lane {
  session: number;
  resets: number;
  // Real states by frames; cuts[i] means states[i] can't be reached smoothly from states[i - 1].
  states: CarState[];
  cuts: boolean[];
  // The moment drawn, in the car's own frames. Null before it starts.
  at: number | null;
  // How long after a newest state the next new states landed (ms, this page's clock minus frames).
  needs: Sample[];
  need: number;
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
  seg: Segment | null;
  shown: CarState | null;
  drawn: Vec3 | null;
  underruns: number;
  resyncs: number;
}
type Lerp = (a: CarState, b: CarState, t: number) => CarState;

const WINDOW_MS = 10_000;
const QUANTILE = 0.98;
// Until a car has this many samples its delay leans on the other cars'.
const MIN_SAMPLES = 8;
const PRIOR_MS = 300;
const MIN_DELAY_MS = 50;
const MAX_DELAY_MS = 1500;
// After states ran out, the delay goes up at once and comes back down at 100 ms a second (not at all
// once the car has finished: its page then sends once a second).
const ATTACK_DECAY = 0.1;
const WARP = 0.05;
const WARP_MS = 500;
// Further than this from where it should be drawn, a car jumps there instead of catching up.
const RESYNC_MS = 500;
const SNAP_DT_MS = 250;
// Within this of its newest state a car slows, so running out of states is a stop, not a wall.
const SOFT_MS = 15;
const MAX_SEG_MS = 150;
const RESET_JUMP_M = 5;
// States that land within this of each other came in one batch.
const EVENT_MS = 8;
// A run with a lower count than one that is still sending is a late copy of the run before.
const STALE_MS = 1000;
const MAX_STATES = 200;
const FORGET_MS = 30_000;
// The game draws remote cars at their state's own time, or this far behind in a collision cup.
const GAME_DELAY = 0;
const COLLISION_DELAY = 0.25;

const ZERO: Vec3 = { x: 0, y: 0, z: 0 };
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
  return { x: a.x * ka + c.x * kb, y: a.y * ka + c.y * kb, z: a.z * ka + c.z * kb, w: a.w * ka + c.w * kb };
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
  // Bumper cars: states go to the game's own playback, each once (they come straight and from the organizer).
  play = false;
  played = new Map<number, { session: number; resets: number; frames: number }>();

  constructor(private lerp: Lerp = plainLerp) {}

  #play(session: number, id: number, resets: number, state: CarState) {
    const seen = this.played.get(id);
    if (seen && (session < seen.session || (session === seen.session && (resets < seen.resets || (resets === seen.resets && state.frames <= seen.frames))))) return;
    this.played.set(id, { session, resets, frames: state.frames });
    for (const cb of this.listeners)
      try {
        cb(session, id, resets, state);
      } catch (error) {
        console.error(error);
      }
  }

  #newLane(session: number, resets: number, now: number): Lane {
    return {
      session,
      resets,
      states: [],
      cuts: [],
      at: null,
      needs: [],
      need: 0,
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
      seg: null,
      shown: null,
      drawn: null,
      underruns: 0,
      resyncs: 0,
    };
  }

  // How far behind its fastest delivery a car is drawn (ms).
  delay(lane: Lane) {
    let d = this.prior;
    if (lane.needs.length && lane.late != null) {
      const w = Math.min(1, lane.needs.length / MIN_SAMPLES);
      d += w * (lane.need + this.margin - lane.late - d);
    }
    return clamp(Math.max(d, lane.attack), MIN_DELAY_MS, MAX_DELAY_MS);
  }

  arrive(session: number, id: number, resets: number, state: CarState, now: number) {
    if (this.play) return this.#play(session, id, resets, state);
    const floor = this.floors.get(id);
    if (floor && before(session, resets, floor) && now - floor.at < STALE_MS) return;
    let lane = this.lanes.get(id);
    if (!lane || lane.session !== session || lane.resets !== resets) {
      lane = this.#newLane(session, resets, now);
      this.lanes.set(id, lane);
    }
    const { states, cuts } = lane;
    let i = states.length;
    while (i > 0 && states[i - 1].frames >= state.frames) i--;
    if (states[i]?.frames === state.frames) return;
    if (i < states.length) {
      const at = lane.at;
      // States that fill a gap late came late as far as the delay goes (the car stood still there if
      // it had reached the gap).
      if (i > 0 && cuts[i] && !cut(states[i - 1], state) && state.hasStarted && lane.late != null && now - lane.eventAt >= EVENT_MS) {
        lane.eventAt = now;
        this.#landed(lane, states[i - 1], now, at != null && at >= states[i - 1].frames);
      }
      // A copy that comes after a later state is only kept beyond the stretch being drawn, so the path
      // under the car never changes.
      if (at != null && state.frames <= (states.find((s) => s.frames > at)?.frames ?? Infinity)) return;
      states.splice(i, 0, state);
      cuts.splice(i, 0, i > 0 && cut(states[i - 1], state));
      cuts[i + 1] = cut(state, states[i + 1]);
    } else this.#newest(lane, state, now);
    lane.seenAt = now;
    this.floors.set(id, { session, resets, at: now });
    if (states.length > MAX_STATES) {
      states.shift();
      cuts.shift();
    }
  }

  #newest(lane: Lane, state: CarState, now: number) {
    const prev = lane.states[lane.states.length - 1];
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
    if (event && prev?.hasStarted && !broken) this.#landed(lane, prev, now, lane.at != null && prev.frames - lane.at < 1);
  }

  // States landed after `prev`: how long after it they came is what the car's delay has to cover.
  #landed(lane: Lane, prev: CarState, now: number, dry: boolean) {
    const b = now - prev.frames - lane.late!;
    const racing = prev.finishFrames == null;
    if (racing && b > this.delay(lane) + RESYNC_MS) {
      // A long stall while racing: the car jumps on (draw()) instead of everyone waiting longer, unless
      // these states show it finished (its page then sends once a second).
      if (dry) lane.stall = b + this.margin;
      return;
    }
    if (dry) {
      lane.underruns++;
      lane.attack = Math.max(lane.attack, b + this.margin);
    }
    if (!racing) return;
    while (lane.needs.length && now - lane.needs[0].at > WINDOW_MS) lane.needs.shift();
    lane.needs.push({ at: now, ms: now - prev.frames });
    lane.need = quantile(
      lane.needs.map((n) => n.ms),
      QUANTILE,
    );
  }

  // The game has put the car back at the start: the run before it is never drawn again.
  reset(session: number, id: number, resets: number, now: number) {
    if (this.play) return;
    const floor = this.floors.get(id);
    if (!floor || !before(session, resets, floor)) this.floors.set(id, { session, resets, at: now });
    const lane = this.lanes.get(id);
    if (!lane || before(session, resets, lane)) return;
    if (lane.session === session && lane.resets === resets) lane.fresh = true;
    else this.lanes.delete(id);
  }

  #tangent(lane: Lane, i: number): Vec3 {
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
    if (back) return scale(back, 1 / hb);
    if (ahead) return scale(ahead, 1 / ha);
    return ZERO;
  }

  #segment(lane: Lane, i: number): Segment {
    const a = lane.states[i],
      b = lane.states[i + 1];
    const s = lane.seg;
    if (s && s.a === a && s.b === b) return s;
    // At most 3x the segment's own speed at either end, so the curve never loops past b.
    const most = (3 * len(sub(b.position, a.position))) / (b.frames - a.frames);
    const va = cap(s && s.b === a ? s.vb : this.#tangent(lane, i), most);
    return (lane.seg = { a, b, va, vb: cap(this.#tangent(lane, i + 1), most) });
  }

  // Once a frame, before the game moves and draws the cars. `dt` is the frame's own time (ms).
  frame(now: number, dt: number, session: number | undefined, carOf: (id: number) => Pick<Car, 'setCarState'> | undefined, collisions: boolean) {
    if (collisions !== this.play) {
      this.play = collisions;
      this.lanes.clear();
      this.floors.clear();
      this.played.clear();
    }
    if (collisions) return;
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
      if (lane.needs.length >= MIN_SAMPLES && newest?.hasStarted && newest.finishFrames == null && now - lane.seenAt < 2000)
        racing.push(lane.need + this.margin - lane.late!);
      if (lane.session !== session) continue;
      const car = carOf(id);
      if (car) this.#draw(lane, car, now, dt);
    }
    if (racing.length) this.prior = clamp(median(racing), MIN_DELAY_MS, MAX_DELAY_MS);
  }

  #draw(lane: Lane, car: Pick<Car, 'setCarState'>, now: number, frameDt: number) {
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
      lane.seg = null;
      if (!reset && lane.shown === newest) return;
      lane.shown = newest;
      lane.drawn = newest.position;
      car.setCarState({ ...newest, collisionImpulses: [] }, reset);
      return;
    }
    const target = now - lane.late - this.delay(lane);
    const from = lane.at;
    let at: number;
    const snap = from == null || dt > SNAP_DT_MS || target - from > RESYNC_MS;
    if (snap) {
      at = Math.max(from ?? -Infinity, Math.min(target, newest.frames));
      if (from != null && at > from) lane.resyncs++;
    } else {
      let step = dt * (1 + clamp((target - from) / WARP_MS, -WARP, WARP));
      const room = newest.frames - from;
      if (room < SOFT_MS + step) step *= room / (room + SOFT_MS);
      at = Math.min(from + step, newest.frames);
    }
    lane.at = at;
    if (at === from && !reset) return;
    let i = states.length - 1;
    while (i > 0 && states[i].frames > at) i--;
    // Real states passed this frame: their hits sound once, and a cut among them may need a reset.
    let impulses: number[] = [];
    let jumped = snap;
    for (let j = i; j >= 0 && states[j].frames > (from ?? Infinity); j--) {
      if (states[j].frames > at) continue;
      if (!snap && states[j].collisionImpulses.length) impulses = impulses.concat(states[j].collisionImpulses);
      if (cuts[j]) jumped = true;
    }
    const a = states[i];
    let state: CarState;
    if (at <= a.frames || i === states.length - 1 || cuts[i + 1]) state = { ...a, frames: Math.max(a.frames, Math.round(at)), collisionImpulses: impulses };
    else {
      const b = states[i + 1];
      const h = b.frames - a.frames;
      const u = (at - a.frames) / h;
      const seg = this.#segment(lane, i);
      state = {
        ...this.lerp(a, b, u),
        frames: Math.round(at),
        position: hermite(a.position, seg.va, b.position, seg.vb, u, h),
        hasStarted: a.hasStarted,
        brakeLightEnabled: a.brakeLightEnabled,
        controls: a.controls,
        collisionImpulses: impulses,
      };
    }
    if (jumped && lane.drawn && len(sub(state.position, lane.drawn)) > RESET_JUMP_M) reset = true;
    lane.drawn = state.position;
    car.setCarState(state, reset);
    // Two states before the one drawn are kept for its velocity.
    while (states.length > 3 && states[2].frames <= at) {
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
        return feeds.get(this)?.play ? COLLISION_DELAY : GAME_DELAY;
      },
      set() {},
    });
  }
}

// Once a frame, just before the game moves and draws the other cars. `dt` is in ms.
export function drawCars(
  connection: Connection | undefined,
  session: number | undefined,
  carOf: (id: number) => Pick<Car, 'setCarState'> | undefined,
  now: number,
  dt: number,
  collisions: boolean,
) {
  const feed = connection && feeds.get(connection);
  if (feed) feed.frame(now, dt, session, carOf, collisions);
}
