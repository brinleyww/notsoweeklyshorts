// Draws every other car where it is now, not where it was when its last state left its page.
// Each page stamps its car's states with when that car started on the cup clock (transport.js), so
// a state's age here is known: the car is drawn at (cup time now - its start), between the two real
// states around that moment, or carried on from the newest one along its path when the moment is
// past it. When a new state shows the guess was off (a brake, a crash, a landing), the difference
// fades out over a tenth of a second instead of jumping. The game's own playback of remote cars
// (a buffer drawn 0.6 s behind) gets no states and just keeps what is set here. Bumper cars keep
// the game's own playback (0.4 s behind): a guessed car there would be one you crash into.
import type { Car, CarState, CarUpdate, Connection, Native } from './game.ts';

interface Vec {
  x: number;
  y: number;
  z: number;
}
interface Quat extends Vec {
  w: number;
}
interface Pose {
  p: Vec;
  q: Quat;
}
interface Drawn extends CarState {
  position: Vec;
  quaternion: Quat;
}
interface Lane {
  session: number;
  resets: number;
  states: Drawn[];
  late: { at: number; ms: number }[];
  start: number | null;
  // The sender's car start as stamped on this lane's newest state.
  stamp: number | undefined;
  off: Vec;
  offQ: Quat;
  fresh: boolean;
  seenAt: number;
  drawnAt: number;
}

const KEEP = 16;
// Without a stamp (a page from before stamps), the start is guessed from the earliest arrivals.
const WINDOW_MS = 4000;
// How far past the newest state a car is carried on; beyond that it waits for news.
const MAX_LEAD_MS = 1200;
// Two states further apart than this aren't a speed to carry on with.
const MAX_GAP_MS = 250;
const FADE_MS = 80;
const START_SNAP_MS = 1000;
const START_SLEW = 0.05;
const FORGET_MS = 30_000;
// The game draws remote cars at their state's own time, or this far behind in a collision cup.
const GAME_DELAY = 0;
const COLLISION_DELAY = 0.25;

const ONE: Quat = { x: 0, y: 0, z: 0, w: 1 };
const mul = (a: Quat, b: Quat): Quat => ({
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
});
const inv = (q: Quat): Quat => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
const norm = (q: Quat): Quat => {
  const n = Math.hypot(q.x, q.y, q.z, q.w) || 1;
  return { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n };
};
function slerp(a: Quat, b: Quat, t: number): Quat {
  let d = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  let c = b;
  if (d < 0) {
    d = -d;
    c = { x: -b.x, y: -b.y, z: -b.z, w: -b.w };
  }
  if (d > 0.9995) return norm({ x: a.x + (c.x - a.x) * t, y: a.y + (c.y - a.y) * t, z: a.z + (c.z - a.z) * t, w: a.w + (c.w - a.w) * t });
  const th = Math.acos(d),
    s = Math.sin(th);
  const ka = Math.sin((1 - t) * th) / s,
    kb = Math.sin(t * th) / s;
  return { x: a.x * ka + c.x * kb, y: a.y * ka + c.y * kb, z: a.z * ka + c.z * kb, w: a.w * ka + c.w * kb };
}
// The rotation from a to b, done t times over (t may be past 1).
function turn(a: Quat, b: Quat, t: number): Quat {
  let d = mul(b, inv(a));
  if (d.w < 0) d = { x: -d.x, y: -d.y, z: -d.z, w: -d.w };
  const half = Math.acos(Math.min(1, d.w));
  const s = Math.sin(half);
  if (s < 1e-6) return b;
  const k = Math.sin(half * t) / s;
  return norm(mul({ x: d.x * k, y: d.y * k, z: d.z * k, w: Math.cos(half * t) }, b));
}
const lerp = (a: Vec, b: Vec, t: number): Vec => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });

// The car at frame f by its real states: between two of them, or carried on from the newest.
function poseAt(states: Drawn[], f: number): Pose {
  const last = states[states.length - 1];
  if (f >= last.frames) {
    const prev = states[states.length - 2];
    const gap = prev ? last.frames - prev.frames : 0;
    if (!prev || gap <= 0 || gap > MAX_GAP_MS || last.finishFrames != null && prev.finishFrames == null) return { p: last.position, q: last.quaternion };
    const t = Math.min(f - last.frames, MAX_LEAD_MS) / gap;
    return { p: lerp(prev.position, last.position, 1 + t), q: turn(prev.quaternion, last.quaternion, 1 + t) };
  }
  let i = states.length - 2;
  while (i > 0 && states[i].frames > f) i--;
  const a = states[i],
    b = states[i + 1];
  if (f <= a.frames) return { p: a.position, q: a.quaternion };
  const t = (f - a.frames) / (b.frames - a.frames);
  return { p: lerp(a.position, b.position, t), q: slerp(a.quaternion, b.quaternion, t) };
}

class Feed {
  listeners = new Set<CarUpdate>();
  lanes = new Map<number, Lane>();
  clock: (id: number) => number | undefined = () => undefined;
  now = 0;
  // The cup clock minus performance.now(), for states that arrive between frames.
  offset = 0;
  // Bumper cars: states go to the game's own playback, each once (they come straight and from the organizer).
  play = false;
  played = new Map<number, { session: number; resets: number; frames: number }>();

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

  arrive(session: number, id: number, resets: number, state: CarState, now: number) {
    if (this.play) return this.#play(session, id, resets, state);
    let lane = this.lanes.get(id);
    // A respawn or restart counts up; the organizer's later copies of the run before it don't go back.
    if (lane && (session < lane.session || (session === lane.session && resets < lane.resets))) return;
    if (!lane || lane.session !== session || lane.resets !== resets) {
      lane = { session, resets, states: [], late: [], start: null, stamp: undefined, off: { x: 0, y: 0, z: 0 }, offQ: ONE, fresh: true, seenAt: now, drawnAt: 0 };
      this.lanes.set(id, lane);
    }
    const s = state as Drawn;
    const last = lane.states[lane.states.length - 1];
    // The organizer's batches still carry states that came straight from the racer already.
    if (last && s.frames <= last.frames) return;
    lane.seenAt = now;
    // transport.js notes the stamp just before the game hands over the state it came with.
    lane.stamp = this.clock(id);
    if (s.hasStarted) {
      lane.late.push({ at: now, ms: now - s.frames });
      while (lane.late.length && now - lane.late[0].at > WINDOW_MS) lane.late.shift();
    }
    if (!lane.fresh && lane.start != null && last?.hasStarted && s.hasStarted) {
      // Keep the car where it is drawn; the correction fades out in draw().
      const f = this.now - lane.start;
      const before = poseAt(lane.states, f);
      lane.states.push(s);
      const after = poseAt(lane.states, f);
      lane.off = { x: lane.off.x + before.p.x - after.p.x, y: lane.off.y + before.p.y - after.p.y, z: lane.off.z + before.p.z - after.p.z };
      lane.offQ = norm(mul(lane.offQ, mul(before.q, inv(after.q))));
    } else lane.states.push(s);
    if (lane.states.length > KEEP) lane.states.shift();
  }

  draw(id: number, lane: Lane, car: Pick<Car, 'setCarState'>, now: number) {
    const last = lane.states[lane.states.length - 1];
    if (!last) return;
    const dt = Math.min(250, Math.max(0, now - (lane.drawnAt || now)));
    lane.drawnAt = now;
    if (lane.fresh || !last.hasStarted) {
      car.setCarState(last, lane.fresh);
      lane.fresh = false;
      lane.start = null;
      return;
    }
    const stamp = lane.stamp ?? this.clock(id);
    let want = Number.isFinite(stamp) ? stamp! : Infinity;
    if (want === Infinity) for (const l of lane.late) want = Math.min(want, l.ms);
    if (!Number.isFinite(want)) want = now - last.frames;
    if (lane.start == null || Math.abs(want - lane.start) > START_SNAP_MS) lane.start = want;
    else lane.start += Math.max(-START_SLEW * dt, Math.min(START_SLEW * dt, want - lane.start));
    const f = now - lane.start;
    const pose = poseAt(lane.states, f);
    const fade = Math.exp(-dt / FADE_MS);
    lane.off = { x: lane.off.x * fade, y: lane.off.y * fade, z: lane.off.z * fade };
    lane.offQ = slerp(ONE, lane.offQ, fade);
    car.setCarState(
      {
        ...last,
        frames: Math.max(0, Math.round(f)),
        position: { x: pose.p.x + lane.off.x, y: pose.p.y + lane.off.y, z: pose.p.z + lane.off.z },
        quaternion: norm(mul(lane.offQ, pose.q)),
      } as CarState,
      false,
    );
  }
}

const feeds = new WeakMap<Connection, Feed>();

// A callback marked raw (live timing) gets every state the moment it arrives.
export function rawCarUpdates(cb: CarUpdate) {
  return Object.assign(cb, { raw: true });
}

export function installSmoothing(native: Native) {
  for (const C of [native.Host, native.Client]) {
    const proto = C.prototype as Connection;
    const add = proto.addCarUpdateCallback;
    const remove = proto.removeCarUpdateCallback;
    proto.addCarUpdateCallback = function (this: Connection, cb: CarUpdate) {
      if ((cb as { raw?: boolean }).raw) return add.call(this, cb);
      let feed = feeds.get(this);
      if (!feed) {
        const f = (feed = new Feed());
        feeds.set(this, f);
        add.call(this, rawCarUpdates((session, id, resets, state) => f.arrive(session, id, resets, state, performance.now() + f.offset)));
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

// Once a frame, before the game draws. `now` is the cup clock.
export function predictCars(
  connection: Connection | undefined,
  carOf: (id: number) => Pick<Car, 'setCarState'> | undefined,
  now: number,
  clock: (id: number) => number | undefined,
  collisions: boolean,
) {
  const feed = connection && feeds.get(connection);
  if (!feed) return;
  if (collisions !== feed.play) {
    feed.play = collisions;
    feed.lanes.clear();
    feed.played.clear();
  }
  if (collisions) return;
  feed.now = now;
  feed.offset = now - performance.now();
  feed.clock = clock;
  for (const [id, lane] of feed.lanes) {
    if (now - lane.seenAt > FORGET_MS) {
      feed.lanes.delete(id);
      continue;
    }
    const car = carOf(id);
    if (car) feed.draw(id, lane, car, now);
  }
}
