// Plans every bot run in this worker, frame by frame on the game's own physics. All of the worker's
// bots advance together in ticks; a full copy of the wasm heap is kept at each tick boundary. When a
// bot fails (off its line, fallen, stuck, wrecked, a missed checkpoint), the heap goes back a few
// ticks, the other bots replay their logged keys to where they were, and the failed bot tries again
// with other settings. When it keeps failing it lives with it: it respawns at its last checkpoint,
// or restarts, like a player would.
//
// After every run a bot goes over it (rethink): from the exact state where a section of its run began, it
// tries other ways through that section and drives on to the finish; a way that finishes sooner becomes its
// run. Experts then drive their best run as it is, the others their notes from it, with their own slips.
//
// Time is bot time: ms since GO. The physics step taken at time t gives the car's state at t + 1.
import { EXPERT_SKILL, type BotPlan, type Persona } from '../wire.ts';
import { Brain } from './brain.ts';
import { copyDriverState, DEFAULT_PARAMS, Driver, newDriverState, type DriverParams, type DriverState } from './driver.ts';
import { clearanceOf, marginOffsets, type Clearance } from './clearance.ts';
import { FIELDS, Notes, refKey, SECTION } from './notes.ts';
import type { TrackRays } from './rays.ts';
import type { Reference } from './reference.ts';
import { axes, newRaw, readRaw, type Keys, type Raw, type Sim, type TrackLoad } from './sim.ts';

export const TICK = 200;
// Frames each bot may still change; older keyframes are final and can be sent.
export const HOLD = 3000;
export const KEY_EVERY = 50;
// Heap copies kept for going back, in bytes at most (fewer of them on a big track).
const SNAP_BUDGET = 320 * 1024 * 1024;
// Past the line a bot brakes and, like a ghost, leaves the track soon after (scenery past a finish
// would wreck it): a single run stops sending after AFTER_RUN, time attack restarts after AFTER_TA.
const AFTER_RUN = 400;
const AFTER_TA = 400;
// Heap slot for practice (learn.ts): the state a section's tries all start from.
const DRILL_SLOT = 63;
// Ways tried through each section by a top expert in a race.
const DRILL_TRIES = 4;
// A practice try's cost: ms to the end of the next section, less this much per km/h it leaves with.
const EXIT_MS_PER_KMH = 10;
// Going over a run: ways tried from each section's start, and how far behind the run a try may fall at a
// later section before it is given up.
const THINK_TRIES = 3;
const THINK_BEHIND = 150;
const PONDER_MS = 20_000;
// An expert on a hint run this much slower than the fastest (log of their times) or more drives it at most this
// much faster than its own speeds.
const MAX_LIFT = 0.08;
// A retry counts as having got through this far (units) past where it failed.
const FIX_PAST = 25;
// Practice makes a bot better on a track: after r runs there (rounds before this one, then every attempt in
// time attack) it has closed WARM_GAIN * (1 - e^(-r / WARM_RUNS)) of its gap to an expert's pace, and slips
// that much less. The first run is as it always was.
const WARM_GAIN = 0.4;
const WARM_RUNS = 5;
// Time attack: a run this far behind the bot's best at the same section is restarted, like a player would.
const FAR_MS = 1500;
const FAR_SHARE = 0.08;

export interface Out {
  f: number;
  raw: Uint8Array;
  cut: boolean;
}

export interface JobSpec {
  id: string;
  bot: Persona;
  mode: 'run' | 'ta';
  end: number;
  // Network weights (brain.ts) for this bot; none drives without the network.
  brain?: Float32Array | null;
  // An expert's notes (notes.ts), by hint run (refKey).
  notes?: Record<string, Float32Array> | null;
  // A practice run (learn.ts): the notes exactly as they are, no random inputs or mistakes.
  practice?: boolean;
  // The top expert in a race: it searches its own run as it goes, like practice (see Planner.practise).
  drill?: boolean;
  // The bot's own best runs, by hint run (the one for its hint is used).
  plans?: BotPlan[] | null;
  // Follows this reference (index, fastest first) instead of the one its persona gets.
  refIdx?: number;
  // Runs the bot has already had on this track (rounds before this one).
  warm?: number;
}

type Copy = { keys: Uint8Array; n: number; own?: boolean };

// Now and then (about every 12 s of driving) a small input the driver didn't choose, for 40-150 ms: it
// may turn up a better line, or cost a little.
const NOISE_RATE = 1 / 12000;
// Another reference is only taken up where it passes this close to the car, units.
const SWITCH_NEAR = 10;
const TAU = Math.PI * 2;

export type Why = 'lost' | 'fell' | 'stuck' | 'crash' | 'missed' | 'flipped' | 'spun';
type Status = 'run' | 'after' | 'done' | 'dnf';

// Every car's physics world holds every part it is given (~30 MB a car on a 60k-part deco track), but a
// bot is never long more than 12 units off a reference ('lost'), so on a big track it gets only the parts
// near one (part positions are in 5-unit tiles). Gates and start parts stay wherever they are.
const ROUTE_PARTS = 4000;
const ROUTE_REACH = 60;
const ROUTE_CELL = 20;

export function routeTrack(sim: Sim, t: TrackLoad, refs: Reference[], gate: (id: number) => boolean): TrackLoad {
  let parts = 0;
  t.track.forEachPart(() => parts++);
  if (parts < ROUTE_PARTS || !refs.length) return t;
  const key = (x: number, y: number, z: number) => ((x & 1023) << 20) | ((y & 1023) << 10) | (z & 1023);
  const near = new Set<number>();
  const r = Math.ceil(ROUTE_REACH / ROUTE_CELL);
  for (const ref of refs) {
    let lx = Infinity, ly = 0, lz = 0;
    for (let i = 0; i < ref.n; i++) {
      const x = ref.px[i], y = ref.py[i], z = ref.pz[i];
      if ((x - lx) ** 2 + (y - ly) ** 2 + (z - lz) ** 2 < 25 && i < ref.n - 1) continue;
      lx = x;
      ly = y;
      lz = z;
      const cx = Math.floor(x / ROUTE_CELL), cy = Math.floor(y / ROUTE_CELL), cz = Math.floor(z / ROUTE_CELL);
      for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) for (let c = -r; c <= r; c++) near.add(key(cx + a, cy + b, cz + c));
    }
  }
  return sim.prune(t, (x, y, z, id, cp, start) => cp != null || start != null || gate(id) || near.has(key(Math.floor((x * 5) / ROUTE_CELL), Math.floor((y * 5) / ROUTE_CELL), Math.floor((z * 5) / ROUTE_CELL))));
}

interface Saved {
  t: number;
  car: number;
  runStart: number;
  st: DriverState;
  cutNext: boolean;
  status: Status;
  runs: number;
  bestArc: number;
  bestArcAt: number;
  farFrames: number;
  lastCp: number;
  airSince: number;
  respawns: number;
  resetAt: number;
  finishedAt: number;
  mistakeUntil: number;
  speedHist: number[];
  prev: Uint8Array;
  hasPrev: boolean;
  // Off the reference line by this much when saved (a good place to go back to is close to it).
  lat: number;
  refIdx: number;
  sec: number;
}

// A bot's lane off the start: bots dealt neighbouring runs (Persona.copy) get lanes about a car apart,
// left and right of the line in turn, and a little of their own on top (by name, so a run it goes over and
// the next one leave the same way).
function laneOf(b: Persona) {
  const k = b.copy ?? b.seed % 7;
  const side = k % 2 ? -1 : 1;
  const own = (Math.imul((b.name ?? b.u) + 0x9e37, 0x85ebca6b) >>> 8) % 100;
  return side * (0.6 + 0.9 * Math.ceil((k % 7) / 2)) * (k % 7 === 0 ? 0.4 : 1) + own / 250 - 0.2;
}

// Small seeded generator (mulberry32).
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Job {
  readonly id: string;
  readonly bot: Persona;
  readonly mode: 'run' | 'ta';
  readonly end: number;
  readonly rand: () => number;
  ref: Reference;
  readonly p: DriverParams;
  driver: Driver;
  // Reference runs this bot can follow, fastest first, and the one it follows now.
  readonly refs: Reference[];
  refIdx = 0;
  #drivers = new Map<number, Driver>();
  readonly #clear: Map<Reference, Clearance>;
  car = 0;
  runStart = 0;
  // Next step happens at this time.
  t = 0;
  keys = new Uint8Array(1 << 16);
  out: Out[] = [];
  cutNext = true;
  committed = 0;
  status: Status = 'run';
  runs: [number, number | null][] = [];
  st: DriverState = newDriverState();
  bestArc = 0;
  bestArcAt = 0;
  farFrames = 0;
  offFrames = 0;
  lastCp = 0;
  // In the air since this time (-1 on the ground).
  airSince = -1;
  respawns = 0;
  resetAt = -1;
  finishedAt = -1;
  mistakeUntil = -1;
  speedHist: number[] = [];
  // The car's state at time t (after the last step).
  prev = new Uint8Array(256);
  hasPrev = false;
  prevSpeed = 0;
  failAt = -1;
  failWhy: Why | null = null;
  failArc = 0;
  failJump = false;
  // Much slower than the reference where it failed: it needs more speed there, not less.
  failSlow = false;
  failK = 0;
  // A retry under way: the hint sections it changes, how (pace multiplier, offset or null), and where it failed.
  fix: { from: number; to: number; pace: number; off: number | null; arc: number } | null = null;
  // Restarts from the start line this round (before any checkpoint, a respawn can't help).
  restarts = 0;
  // Respawns in a row that failed again before the next checkpoint.
  respawnCp = -1;
  cpRespawns = 0;
  // This run drives a recorded run's own keys from the start (a sure finish: the physics is exact),
  // because the bot's own driving got nowhere, or (own) an expert's own best run.
  copy: Copy | null = null;
  // The bot's own best run on its hint run, and the frame (from the run's start) this run entered each section.
  plan: BotPlan | null = null;
  sin = new Int32Array(0);
  // Time attack: the best run's time and section entries; a run far behind them starts over.
  pbTime = Infinity;
  pbSin: Int32Array | null = null;
  restartNow = false;
  readonly thinkRand: () => number;
  // Wall ms spent going over this bot's runs between rounds.
  pondered = 0;
  // Runs before this job (JobSpec.warm), the pace it started with and this run's share of its slips.
  readonly warm: number;
  readonly basePace: number;
  slips = 1;
  tries = new Map<number, number>();
  dnfAt: number | null = null;
  forceReset = false;
  // Mistakes kept this run.
  kept = 0;
  // An expert's own notes on its hint run (refs[hint]) and this run's way of driving them (notes.ts).
  readonly name: number;
  notes: Notes | null = null;
  hint = -1;
  sections: Float32Array | null = null;
  readonly practice: boolean;
  readonly drill: boolean;
  // Practice and drilling: the hint run's section the car is in, when it left each one and how fast, and the
  // last section practised.
  sec = -1;
  tout = new Float64Array(0);
  vout = new Float64Array(0);
  drilled = -1;

  constructor(spec: JobSpec, refs: Reference[], clear: Map<Reference, Clearance>) {
    this.id = spec.id;
    this.bot = spec.bot;
    this.mode = spec.mode;
    this.end = spec.end;
    this.rand = rng(spec.bot.seed);
    const b = spec.bot;
    // Riskier bots follow the fastest reference; careful ones a slower run when there is one.
    const sorted = [...refs].sort((a, c) => a.n - c.n);
    this.refs = sorted;
    this.#clear = clear;
    this.refIdx = sorted.length > 1 && this.rand() > b.risk ? 1 + Math.floor(this.rand() * (sorted.length - 1)) : 0;
    // Each bot its own top run as a hint (Persona.copy), experts the fastest ones.
    if (b.copy != null && sorted.length) this.refIdx = b.copy % sorted.length;
    if (spec.refIdx != null && spec.refIdx < sorted.length) this.refIdx = spec.refIdx;
    this.ref = sorted[this.refIdx];
    this.name = b.name ?? b.u;
    this.practice = !!spec.practice;
    this.drill = !!spec.drill;
    this.thinkRand = rng(b.seed ^ 0x5bd1e995);
    if (this.ref.kind !== 'explore') {
      const key = refKey(this.ref);
      const plan = spec.plans?.find((p) => p.ref === key && p.n > 0 && p.keys.length >= p.n) ?? null;
      // Every expert is as good as the best: its hint run only gives it its line and way of driving.
      const lift = b.skill >= EXPERT_SKILL ? Math.min(MAX_LIFT, Math.log(this.ref.n / sorted[0].n)) : 0;
      const notes = new Notes(this.ref, this.name, plan?.notes ?? spec.notes?.[key], lift);
      if (plan && plan.notes.length === notes.v.length && plan.sin.length === notes.n) this.plan = plan;
      this.notes = notes;
      this.hint = this.refIdx;
      this.sections = new Float32Array(notes.n * FIELDS);
      this.tout = new Float64Array(notes.n);
      this.vout = new Float64Array(notes.n);
      this.sin = new Int32Array(notes.n).fill(-1);
    }
    const jitter = (this.rand() - 0.5) * 0.03 * (1 - b.skill);
    // An explored route's speeds are already careful, and nothing on it is worth copying exactly.
    this.p = this.ref.kind === 'explore'
      ? { ...DEFAULT_PARAMS, pace: Math.min(1, 0.9 + 0.1 * b.skill + jitter), imitate: 0, drift: false }
      : { ...DEFAULT_PARAMS, pace: Math.min(1, 0.78 + 0.22 * b.skill + jitter), imitate: b.skill >= 0.85 ? 0.05 : 0, drift: b.skill >= 0.5 };
    this.warm = spec.warm ?? 0;
    this.basePace = this.p.pace;
    this.brainW = spec.brain ?? null;
    this.#brain = spec.brain ? new Brain(spec.brain) : null;
    this.driver = this.#driverFor(this.refIdx);
  }

  get expert() {
    return this.bot.skill >= EXPERT_SKILL;
  }

  #driverFor(i: number) {
    let d = this.#drivers.get(i);
    if (!d) {
      const ref = this.refs[i];
      d = new Driver(ref, this.p);
      d.skill = this.bot.skill;
      d.brain = this.#brain;
      if (i === this.hint) d.sections = this.sections;
      // Room to spare from walls and edges: a little for a sharp bot, more for a careful one.
      const c = this.#clear.get(ref);
      if (c) {
        d.offsets = marginOffsets(ref, c, this.bot.skill >= EXPERT_SKILL ? 0 : 0.15 + 0.55 * (1 - this.bot.skill));
        d.clear = c;
      }
      this.#drivers.set(i, d);
    }
    return d;
  }

  #brain: Brain | null = null;
  brainW: Float32Array | null = null;
  // Network weights learned meanwhile, taken up at the next run's start (time attack).
  nextBrain: Float32Array | null | undefined = undefined;
  setBrain(w: Float32Array | null) {
    this.brainW = w;
    this.#brain = w ? new Brain(w) : null;
    for (const d of this.#drivers.values()) d.brain = this.#brain;
  }

  // Follows another reference from here on (its progress index is found from the car's position).
  useRef(i: number) {
    if (i === this.refIdx) return;
    this.refIdx = i;
    this.ref = this.refs[i];
    this.driver = this.#driverFor(i);
  }

  save(): Saved {
    return {
      t: this.t, car: this.car, runStart: this.runStart, st: copyDriverState(this.st), cutNext: this.cutNext,
      status: this.status, runs: this.runs.length, bestArc: this.bestArc, bestArcAt: this.bestArcAt, farFrames: this.farFrames,
      lastCp: this.lastCp, airSince: this.airSince, respawns: this.respawns, resetAt: this.resetAt, finishedAt: this.finishedAt, mistakeUntil: this.mistakeUntil,
      speedHist: [...this.speedHist], prev: this.prev.slice(), hasPrev: this.hasPrev,
      lat: Math.abs(this.driver.lat) + Math.abs(this.driver.headPath) * 5,
      refIdx: this.refIdx,
      sec: this.sec,
    };
  }

  load(s: Saved) {
    this.useRef(s.refIdx);
    this.t = s.t;
    this.car = s.car;
    this.runStart = s.runStart;
    this.st = copyDriverState(s.st);
    // Keyframes past the snapshot are from the attempt being thrown away (commits shift the list, so
    // its length then says nothing).
    while (this.out.length && this.out[this.out.length - 1].f > s.t) this.out.pop();
    this.cutNext = s.cutNext;
    this.status = s.status;
    this.runs.length = s.runs;
    if (this.runs.length && s.finishedAt < 0) this.runs[this.runs.length - 1][1] = null;
    this.bestArc = s.bestArc;
    this.bestArcAt = s.bestArcAt;
    this.farFrames = s.farFrames;
    this.lastCp = s.lastCp;
    this.airSince = s.airSince;
    this.respawns = s.respawns;
    this.resetAt = s.resetAt;
    this.finishedAt = s.finishedAt;
    this.mistakeUntil = s.mistakeUntil;
    this.speedHist = [...s.speedHist];
    this.prev.set(s.prev);
    this.hasPrev = s.hasPrev;
    this.sec = s.sec;
    for (let q = 0; q < this.sin.length; q++) if (this.sin[q] > s.t - this.runStart) this.sin[q] = -1;
    this.failAt = -1;
    this.failWhy = null;
    this.forceReset = false;
  }

  log(t: number, k: Keys) {
    if (t >= this.keys.length) {
      const n = new Uint8Array(Math.max(this.keys.length * 2, t + 1024));
      n.set(this.keys);
      this.keys = n;
    }
    this.keys[t] = (k.up ? 1 : 0) | (k.right ? 2 : 0) | (k.down ? 4 : 0) | (k.left ? 8 : 0) | (k.reset ? 16 : 0);
  }

  get live() {
    return this.status === 'run' || this.status === 'after';
  }
}

const keysOf = (b: number, k: Keys) => {
  k.up = (b & 1) !== 0;
  k.right = (b & 2) !== 0;
  k.down = (b & 4) !== 0;
  k.left = (b & 8) !== 0;
  k.reset = (b & 16) !== 0;
  return k;
};

interface Snap {
  slot: number;
  tick: number;
  jobs: Map<string, Saved>;
}

export class Planner {
  readonly sim: Sim;
  readonly track: TrackLoad;
  // The whole track, for runs that copy a recording (it was made there; routeTrack may leave parts out).
  readonly full: TrackLoad;
  readonly refs: Reference[];
  readonly jobs: Job[] = [];
  readonly ringSize: number;
  #ring: Snap[] = [];
  #tick = 0;
  #raw: Raw = newRaw();
  #fw = new Float32Array(3);
  #up = new Float32Array(3);
  #vel = new Float32Array(3);
  #k: Keys = { up: false, right: false, down: false, left: false, reset: false };
  // A job changed cars since the last snapshot: older snapshots no longer hold its car.
  #carChanged = false;
  onCommit: (job: Job, outs: Out[]) => void = () => {};
  onDone: (job: Job) => void = () => {};
  onFail: (job: Job, why: Why, r: Raw) => void = () => {};
  // A bot found a faster run of its own (#think).
  onPlan: (job: Job, plan: BotPlan) => void = () => {};
  // Set by the worker: how long a bot may go over its run between runs, ms.
  thinkMs: () => number = () => 400;
  // Going over a run or drilling a section: the heap is borrowed, nothing else may start.
  #busy = false;
  #ponderAt = 0;
  // Set by the worker: planning has fallen close behind the race clock.
  hurry: () => boolean = () => false;
  // Set by the worker: planning is far enough ahead for the top expert to search its run (drill).
  roomy: () => boolean = () => true;
  stats = { ticks: 0, rebuilds: 0, restores: 0, replay: 0, accepted: 0, respawns: 0, restarts: 0, copies: 0, frames: 0, fails: {} as Record<string, number> };

  readonly clear = new Map<Reference, Clearance>();

  // `rays` measures the room beside each reference; a map of it measured before can stand in.
  constructor(sim: Sim, track: TrackLoad, refs: Reference[], ringSize = 5, rays: TrackRays | Map<Reference, Clearance> | null = null, full = track) {
    if (rays instanceof Map) for (const [ref, c] of rays) this.clear.set(ref, c);
    else if (rays) for (const ref of refs) this.clear.set(ref, clearanceOf(ref, rays));
    this.sim = sim;
    this.track = track;
    this.full = full;
    this.refs = refs;
    this.ringSize = ringSize;
  }

  add(spec: JobSpec) {
    const job = new Job(spec, this.refs, this.clear);
    this.#startRun(job, 0);
    this.jobs.push(job);
    return job;
  }

  // New network weights for a bot, from its next run.
  brain(id: string, w: Float32Array | null) {
    const job = this.jobs.find((j) => j.id === id);
    if (job) job.nextBrain = w;
  }

  // An expert's notes learned in practice, from its next run.
  notes(name: number, key: string, v: Float32Array) {
    for (const j of this.jobs) if (j.notes && j.name === name && refKey(j.notes.ref) === key && v.length === j.notes.v.length) j.notes.v.set(v);
  }

  // One tick of an expert's practice run (learn.ts), the only job of this planner. Before each section of
  // its hint run it tries other ways through it (from `rand`), each from the same exact state to the end of
  // the next section, and drives on with the fastest.
  practise(rand: () => number, tries: number) {
    if (this.jobs[0]) this.#drillNext(this.jobs[0], rand, tries);
    return this.tick();
  }

  #drillNext(job: Job, rand: () => number, tries: number) {
    if (!job.notes || job.status !== 'run' || job.copy || job.refIdx !== job.hint || !job.hasPrev || job.t + 5 * SECTION >= job.end) return;
    const s = Math.floor(job.st.k / SECTION) + 1;
    if (s <= job.drilled || s >= job.notes.n - 1) return;
    job.drilled = s;
    this.#drill(job, s, rand, tries);
  }

  #drill(job: Job, s: number, rand: () => number, tries: number) {
    if (this.#busy) return;
    const p = job.sections!, o = s * FIELDS, sim = this.sim;
    const was = p.slice(o, o + FIELDS);
    const saved = job.save();
    sim.save(DRILL_SLOT);
    this.#busy = true;
    let best = was, least = Infinity;
    try {
      for (let i = 0; i <= tries; i++) {
        const way = i === 0 ? was : job.notes!.vary(p, s, rand);
        if (i > 0) {
          sim.restore(DRILL_SLOT);
          job.load(saved);
        }
        p.set(way, o);
        job.tout[s + 1] = -1;
        const until = job.t + 4 * SECTION;
        while (job.status === 'run' && job.failAt < 0 && job.tout[s + 1] < 0 && job.t < until) this.#run(job, job.t + TICK);
        const cost = job.failAt < 0 && job.tout[s + 1] >= 0 ? job.tout[s + 1] - EXIT_MS_PER_KMH * job.vout[s + 1] : Infinity;
        if (cost < least) {
          least = cost;
          best = way;
        }
      }
    } finally {
      sim.restore(DRILL_SLOT);
      sim.dropSlot(DRILL_SLOT);
      job.load(saved);
      p.set(best, o);
      this.#busy = false;
    }
  }

  cancel(id: string) {
    const i = this.jobs.findIndex((j) => j.id === id);
    if (i < 0) return;
    const job = this.jobs[i];
    if (job.car) this.sim.deleteCar(job.car);
    job.car = 0;
    this.jobs.splice(i, 1);
    this.#ring = [];
  }

  dispose() {
    for (const j of this.jobs) if (j.car) this.sim.deleteCar(j.car);
    this.jobs.length = 0;
    this.#ring = [];
    this.sim.freeSlots();
  }

  get busy() {
    return this.jobs.some((j) => j.live);
  }

  // Lowest time still being planned among running bots (Infinity when all are done).
  get frontier() {
    let m = Infinity;
    for (const j of this.jobs) if (j.live) m = Math.min(m, j.t);
    return m;
  }

  tick() {
    const live = this.jobs.filter((j) => j.live);
    if (!live.length) return false;
    if (this.roomy()) for (const job of live) if (job.drill) this.#drillNext(job, job.rand, DRILL_TRIES);
    this.#snapshot();
    for (const job of live) this.#run(job, job.t + TICK);
    const failed = live.filter((j) => j.failAt >= 0);
    if (failed.length) this.#recover(failed, live);
    for (const job of this.jobs) this.#commit(job);
    this.#tick++;
    this.stats.ticks++;
    return true;
  }

  #startRun(job: Job, at: number, copy: Copy | null = null) {
    if (job.car) this.sim.deleteCar(job.car);
    // An expert drives its own best run as it is (it goes over it between runs; see #think).
    if (!copy && job.plan && job.expert && !job.practice && job.refIdx === job.hint) copy = { keys: job.plan.keys, n: job.plan.n, own: true };
    job.copy = copy;
    if (!job.practice) {
      const g = WARM_GAIN * (1 - Math.exp(-(job.warm + job.runs.length) / WARM_RUNS));
      job.p.pace = Math.min(1, job.basePace + (1 - job.basePace) * g);
      job.slips = 1 - g;
    }
    job.car = this.sim.newCar(copy && !copy.own ? this.full : this.track);
    job.sin.fill(-1);
    job.restartNow = false;
    job.fix = null;
    this.#carChanged = true;
    job.runStart = at;
    job.t = at;
    if (job.nextBrain !== undefined) {
      job.setBrain(job.nextBrain);
      job.nextBrain = undefined;
    }
    job.st = newDriverState();
    if (!copy) this.#roll(job);
    job.st.lane = laneOf(job.bot);
    if (job.notes && !copy) job.notes.plan(job.rand, job.sections!, job.practice);
    job.sec = -1;
    job.drilled = -1;
    if (job.ref.kind === 'explore') job.st.gripUntil = Infinity;
    job.st.imitating = job.p.imitate > 0;
    job.bestArc = 0;
    job.bestArcAt = at;
    job.farFrames = 0;
    job.lastCp = 0;
    job.airSince = -1;
    job.respawns = 0;
    job.respawnCp = -1;
    job.cpRespawns = 0;
    job.resetAt = -1;
    job.finishedAt = -1;
    job.speedHist = [];
    job.hasPrev = false;
    job.cutNext = true;
    job.kept = 0;
    job.runs.push([at, null]);
    job.status = 'run';
  }

  // When the car enters each section of its hint run; for practice also when it leaves one, and how fast.
  // In time attack a run that has fallen far behind the bot's best is started over.
  #section(job: Job, r: Raw, now: number) {
    const s = Math.min(job.notes!.n - 1, Math.floor(job.st.k / SECTION));
    if (s <= job.sec) return;
    if (job.sec >= 0) {
      job.tout[job.sec] = now;
      job.vout[job.sec] = r.speed;
    }
    for (let q = Math.max(0, job.sec + 1); q <= s; q++) if (job.sin[q] < 0) job.sin[q] = now - job.runStart;
    job.sec = s;
    const pb = job.pbSin?.[s] ?? -1;
    if (job.mode === 'ta' && !job.practice && pb > 0 && now - job.runStart > pb + Math.max(FAR_MS, FAR_SHARE * pb)) job.restartNow = true;
  }

  #keep(job: Job, f: number, raw: Uint8Array) {
    const last = job.out[job.out.length - 1];
    if (last && last.f >= f) return;
    job.out.push({ f, raw: raw.slice(0, this.sim.I.stateSize), cut: job.cutNext });
    job.cutNext = false;
  }

  // Steps a bot until time `to`, a failure, or the end of its run.
  #run(job: Job, to: number) {
    const sim = this.sim, r = this.#raw, k = this.#k;
    to = Math.min(to, job.end);
    while (job.t < to && job.live) {
      // A restart or another reference changes these along the way.
      const ref = job.ref, drv = job.driver, st = job.st;
      const t = job.t;
      const s = sim.steerInput(job.car);
      if (job.status === 'after') {
        k.up = k.left = k.right = k.reset = false;
        // Brake to a stop (holding brake at a standstill would reverse).
        k.down = job.prevSpeed > 3;
      } else this.#decide(job, t, s, k);
      job.log(t, k);
      const buf = sim.step(job.car, k);
      readRaw(buf, r);
      this.stats.frames++;
      const now = t + 1;
      job.t = now;
      const jumped = k.reset && job.hasPrev && this.#jumped(job.prev, r);
      if (jumped) {
        this.#keep(job, t, job.prev);
        job.cutNext = true;
      }
      // A hit: both sides of the sudden change, so pages don't smooth it over.
      const hit = job.hasPrev && Math.abs(r.speed - job.prevSpeed) > 5;
      if (hit) this.#keep(job, t, job.prev);
      if (hit || jumped || job.cutNext || now % KEY_EVERY === 0 || r.cp !== job.lastCp || (r.finished && job.status === 'run')) this.#keep(job, now, buf);
      job.prevSpeed = r.speed;
      job.prev.set(buf.subarray(0, Math.min(buf.length, 256)));
      job.hasPrev = true;
      job.lastCp = r.cp;
      if (r.wheels > 0) job.airSince = -1;
      else if (job.airSince < 0) job.airSince = now;
      if (job.status === 'after') {
        const left = (job.mode === 'ta' ? AFTER_TA : AFTER_RUN) - (now - job.finishedAt);
        if (left <= 0) {
          if (job.mode === 'ta' && now + 2000 < job.end) {
            this.#keep(job, now, buf);
            this.#think(job, performance.now() + this.thinkMs());
            this.#startRun(job, now);
          } else {
            if (this.jobs.includes(job)) this.#think(job, performance.now() + this.thinkMs());
            this.#finishJob(job, 'done');
          }
        }
        continue;
      }
      if (r.finished) {
        if ((job.practice || job.drill) && job.sec >= 0) {
          job.tout[job.sec] = now;
          job.vout[job.sec] = r.speed;
        }
        job.finishedAt = now;
        job.runs[job.runs.length - 1][1] = job.runStart + r.finishFrames;
        job.status = 'after';
        this.#ran(job, r.finishFrames);
        continue;
      }
      // An own run that no longer goes where it went (the track it was driven on changed): drive instead.
      if (job.copy?.own && now - job.runStart > job.copy.n + 50) {
        job.plan = null;
        this.#keep(job, now, buf);
        this.#startRun(job, now);
        continue;
      }
      if (jumped) {
        drv.anchor(r, st);
        job.bestArc = ref.arc[st.k];
        job.bestArcAt = now;
        job.farFrames = 0;
        job.speedHist = [];
        continue;
      }
      if ((now & 3) === 0 && !job.copy) {
        axes(r, this.#fw, this.#up);
        drv.track(r, st);
        if (job.notes && job.refIdx === job.hint) this.#section(job, r, now);
        if (job.restartNow && !this.#busy) {
          this.stats.restarts++;
          this.#keep(job, now, buf);
          this.#startRun(job, now);
          continue;
        }
        const why = this.#check(job, r, now);
        if (why) {
          job.failAt = now;
          job.failWhy = why;
          job.failArc = ref.arc[st.k];
          // Went wrong where the reference was in the air or had just taken off: a jump it reached too
          // slowly or badly. (Airborne where the reference wasn't means too fast or off its line.)
          job.failJump = ref.wheels[st.k] === 0 || ref.jumpIn(Math.max(0, st.k - 1500), 1500) !== Infinity;
          job.failK = st.k;
          job.failSlow = (job.speedHist[Math.max(0, job.speedHist.length - 50)] ?? r.speed) < 0.85 * Math.abs(ref.speed[st.k]);
          this.stats.fails[why] = (this.stats.fails[why] ?? 0) + 1;
          this.onFail(job, why, r);
          return;
        }
      }
    }
    if (job.live && job.t >= job.end) this.#finishJob(job, job.status === 'after' || job.mode === 'ta' ? 'done' : 'dnf');
  }

  #finishJob(job: Job, how: 'done' | 'dnf') {
    if (how === 'dnf' && job.dnfAt == null) job.dnfAt = job.t;
    job.status = how;
    // The car stays (never stepped again) until dispose: deleting it now would make every snapshot
    // older than this unusable for the bots still driving.
    if (this.jobs.includes(job)) this.onDone(job);
  }

  // A run reached the finish in `time` ms: the time attack's best so far, and the bot's own best run.
  #ran(job: Job, time: number) {
    if (job.practice || !this.jobs.includes(job)) return;
    const own = !job.copy || job.copy.own;
    if (own && time < job.pbTime) {
      job.pbTime = time;
      job.pbSin = job.copy?.own && job.plan ? job.plan.sin.slice() : job.sin.slice();
    }
    if (!job.notes || job.copy || job.refIdx !== job.hint || (job.plan && job.plan.n <= time)) return;
    job.plan = { ref: refKey(job.notes.ref), notes: job.sections!.slice(), keys: job.keys.slice(job.runStart, job.runStart + time), n: time, sin: job.sin.slice() };
    job.notes.v.set(job.plan.notes);
    this.onPlan(job, job.plan);
  }

  // Goes over a bot's run until the deadline (performance.now()), like a player thinking back on it: from the
  // exact state where a section began, a few other ways through it (notes.nudge, or the hint run's own
  // inputs there), each driven on to the finish with no slips or random inputs. One that finishes sooner becomes the bot's run (Job.plan). Uses a
  // car of its own, deleted again, and heap slot DRILL_SLOT; the bots' own cars and the planner's snapshots
  // are left as they were.
  #think(job: Job, deadline: number) {
    const notes = job.notes;
    let plan = notes && job.plan?.ref === refKey(notes.ref) ? job.plan : null;
    if (!notes || !plan || this.#busy || performance.now() >= deadline) return;
    this.#busy = true;
    const changed = this.#carChanged;
    const bot: Persona = { ...job.bot, mistakes: 0 };
    const tj = new Job({ id: 'think', bot, mode: 'run', end: notes.ref.n * 3 + 20000, brain: job.brainW, notes: { [plan.ref]: plan.notes.slice() }, practice: true, refIdx: job.hint }, this.refs, this.clear);
    tj.p.pace = job.p.pace;
    let better = false;
    try {
      const sections = notes.n;
      while (performance.now() < deadline) {
        const s = this.#pickSection(plan, job.thinkRand, sections);
        if (s < 0) break;
        // The run up to section s, once; every way tried starts from there.
        this.#startRun(tj, 0);
        const from = plan.sin[s];
        const k = this.#k;
        let buf: Uint8Array | null = null;
        let resetAt = -1;
        for (let t = 0; t < from; t++) {
          const b = plan.keys[t];
          if (b & 16) resetAt = t;
          tj.log(t, keysOf(b, k));
          buf = this.sim.step(tj.car, k);
        }
        if (!buf) continue;
        this.#resume(tj, buf, from, resetAt);
        tj.sin.set(plan.sin);
        tj.sin.fill(-1, s);
        tj.sec = s - 1;
        this.sim.save(DRILL_SLOT);
        const saved = tj.save();
        const sin = tj.sin.slice();
        for (let i = 0; i < THINK_TRIES && performance.now() < deadline; i++) {
          if (i > 0) {
            this.sim.restore(DRILL_SLOT);
            tj.load(saved);
            tj.sin.set(sin);
          }
          tj.sections!.set(plan.notes);
          // Now and then the hint run's own inputs through this section (and maybe the next), as they were.
          if (i === 1 && job.thinkRand() < 0.5) {
            tj.st.openFrom = tj.st.k;
            tj.st.openAt = tj.t;
            tj.st.openUntil = tj.t + SECTION * (job.thinkRand() < 0.5 ? 1 : 2);
          } else tj.sections!.set(notes.nudge(plan.notes, s, job.thinkRand), s * FIELDS);
          const p = this.#tryRest(tj, plan, s);
          if (p) {
            plan = p;
            better = true;
            break;
          }
        }
        this.sim.dropSlot(DRILL_SLOT);
      }
    } finally {
      if (tj.car) this.sim.deleteCar(tj.car);
      tj.car = 0;
      this.#carChanged = changed;
      this.#busy = false;
    }
    if (better && plan) {
      job.plan = plan;
      notes.v.set(plan.notes);
      this.onPlan(job, plan);
    }
  }

  // The section to go over next: where the run loses most against its hint run (each section is a second of
  // it), now and then any.
  #pickSection(plan: BotPlan, rand: () => number, n: number) {
    const w: number[] = [];
    let sum = 0;
    for (let s = 0; s < n - 1; s++) {
      const a = plan.sin[s], b = plan.sin[s + 1];
      const v = a > 0 && b > a ? Math.max(0, b - a - SECTION) + 40 : 0;
      w.push(v);
      sum += v;
    }
    if (!sum) return -1;
    let x = rand() * sum;
    for (let s = 0; s < w.length; s++) if ((x -= w[s]) < 0 && w[s] > 0) return s;
    return w.findLastIndex((v) => v > 0);
  }

  // A thinking run's car was driven by keys to frame `at` (buf: its state then): carry on driving from there.
  #resume(job: Job, buf: Uint8Array, at: number, resetAt: number) {
    job.t = at;
    job.prev.set(buf.subarray(0, Math.min(buf.length, 256)));
    job.hasPrev = true;
    readRaw(buf, this.#raw);
    job.lastCp = this.#raw.cp;
    job.prevSpeed = this.#raw.speed;
    job.driver.anchor(this.#raw, job.st);
    job.bestArc = job.ref.arc[job.st.k];
    job.bestArcAt = at;
    job.farFrames = job.offFrames = 0;
    job.speedHist = [];
    job.resetAt = resetAt;
    job.airSince = this.#raw.wheels > 0 ? -1 : at;
    job.out.length = 0;
  }

  // Drives a thinking run on to the finish; its whole run if it finishes sooner than `plan` (or with no plan),
  // else null. From section `s` on it gives up once it is THINK_BEHIND behind the plan at a section.
  #tryRest(tj: Job, plan: BotPlan | null, s: number): BotPlan | null {
    const limit = plan ? plan.n : tj.end;
    while (tj.status === 'run' && tj.failAt < 0 && tj.t < limit) {
      this.#run(tj, tj.t + TICK);
      if (plan)
        for (let q = s + 1; q <= tj.sec && q < plan.sin.length; q++) if (plan.sin[q] >= 0 && tj.sin[q] > plan.sin[q] + THINK_BEHIND) return null;
    }
    const run = tj.runs[tj.runs.length - 1];
    if (tj.failAt >= 0 || run?.[1] == null) return null;
    const time = run[1] - run[0];
    if (plan && time >= plan.n) return null;
    return { ref: refKey(tj.notes!.ref), notes: tj.sections!.slice(), keys: tj.keys.slice(0, time), n: time, sin: tj.sin.slice() };
  }

  // Thinks over done bots' runs while the planner has nothing else to do (between rounds), each for up to
  // PONDER_MS; true if it did.
  ponder(deadline: number) {
    if (this.busy) return false;
    const done = this.jobs.filter((j) => j.status === 'done' && j.plan && j.pondered < PONDER_MS);
    if (!done.length) return false;
    const job = done[this.#ponderAt++ % done.length];
    const t0 = performance.now();
    this.#think(job, deadline);
    job.pondered += Math.max(1, performance.now() - t0);
    return true;
  }

  #jumped(prev: Uint8Array, r: Raw) {
    const dv = new DataView(prev.buffer, prev.byteOffset, prev.byteLength);
    const off = (prev[11] & 2 ? 3 : 0) + 14;
    const dx = r.x - dv.getFloat32(off, true), dy = r.y - dv.getFloat32(off + 4, true), dz = r.z - dv.getFloat32(off + 8, true);
    return dx * dx + dy * dy + dz * dz > 9;
  }

  #decide(job: Job, t: number, s: number, k: Keys) {
    const st = job.st, ref = job.ref, r = this.#raw;
    if (job.copy) {
      keysOf(job.copy.keys[Math.min(t - job.runStart, job.copy.n - 1)], k);
      return;
    }
    k.reset = false;
    if (!job.hasPrev) {
      keysOf(ref.keys[0] & 15, k);
      return;
    }
    readRaw(job.prev, r);
    if (job.forceReset) {
      job.forceReset = false;
      k.up = k.down = k.left = k.right = false;
      k.reset = true;
      job.resetAt = t;
      return;
    }
    axes(r, this.#fw, this.#up);
    this.sim.velocity(job.car, this.#vel);
    // Respawn where the reference respawned (tracks built around it), once on the same checkpoint.
    const tp = ref.teleportAfter(st.k - 4);
    if (tp > 0 && st.k >= tp - 3 && r.cp === ref.cp[tp - 1] && job.resetAt < t - 300) {
      k.up = k.down = k.left = k.right = false;
      k.reset = true;
      job.resetAt = t;
      return;
    }
    if (st.openUntil >= t) {
      keysOf(ref.keys[Math.min(ref.n - 1, st.openFrom + (t - st.openAt))] & 15, k);
      return;
    }
    job.driver.decide(t, r, this.#vel, s, this.#fw, st, k);
    // Mistakes: a twitch of the wheel or a lift, now and then.
    if (!job.practice && !job.drill && st.biasUntil < t && st.paceUntil < t && t - job.runStart > 3000 && job.rand() < job.bot.mistakes * job.slips * 0.00006) {
      if (job.rand() < 0.5) {
        st.bias = (job.rand() < 0.5 ? -1 : 1) * (0.15 + 0.35 * job.rand());
        st.biasUntil = t + 120 + Math.floor(job.rand() * 250);
      } else {
        st.paceMul = 0.75 + 0.15 * job.rand();
        st.paceUntil = t + 500 + Math.floor(job.rand() * 800);
      }
      job.mistakeUntil = Math.max(st.biasUntil, st.paceUntil) + 1500;
    }
    if (!job.practice && !job.drill && st.noiseUntil < t && t - job.runStart > 2000 && job.rand() < NOISE_RATE && !ref.runUp(st.k) && ref.jumpIn(st.k, 2500) === Infinity) {
      st.noiseLift = job.rand() < 0.3;
      st.noise = st.noiseLift ? 0 : (job.rand() < 0.5 ? -1 : 1) * (0.05 + 0.12 * job.rand());
      st.noiseUntil = t + 40 + Math.floor(job.rand() * 110);
    }
  }

  // A new way of driving for this run, or for the rest of it after a respawn (see DriverState.style).
  #roll(job: Job) {
    const r = job.rand, s = job.st.style, loose = 1 - job.bot.skill;
    // Practice and going over a run drive the notes exactly: no weaves, no pace swings.
    const amp = job.practice ? 0 : job.bot.skill >= EXPERT_SKILL ? 0.05 : 0.1 + 0.5 * loose;
    s[0] = amp * (0.4 + 0.6 * r());
    s[1] = 60 + 140 * r();
    s[2] = TAU * r();
    s[3] = amp * 0.5 * r();
    s[4] = 25 + 50 * r();
    s[5] = TAU * r();
    const swing = 0.005 + 0.03 * loose * r();
    s[6] = job.practice ? 0 : swing;
    s[7] = 80 + 200 * r();
    s[8] = TAU * r();
  }

  #check(job: Job, r: Raw, now: number): Why | null {
    const ref = job.ref, drv = job.driver, k = job.st.k;
    if (drv.dist > 12) job.farFrames += 4;
    else job.farFrames = 0;
    if (job.farFrames > 400) return 'lost';
    // Flying off the line where the reference stayed on the ground.
    if (r.wheels === 0 && ref.wheels[k] > 0 && drv.dist > 4) {
      job.offFrames += 4;
      if (job.offFrames > 160) return 'fell';
    } else job.offFrames = 0;
    // Sideways at speed, off the line. Not just after a respawn, where the car faces the gate, not the line.
    const settled = now - job.runStart > 1500 && now - job.resetAt > 1500;
    if (settled && r.speed > 25 && Math.min(Math.abs(drv.head), Math.abs(drv.headPath)) > 0.45 && Math.abs(drv.lat) > 1 && r.wheels > 0) return 'spun';
    if (r.y < ref.minY - 15 || (r.wheels === 0 && r.y < ref.py[k] - 10)) return 'fell';
    const arc = ref.arc[k];
    if (arc > job.bestArc + 2) {
      job.bestArc = arc;
      job.bestArcAt = now;
    } else if (now - job.bestArcAt > 1600 && job.resetAt < now - 1600) return 'stuck';
    const need = ref.cp[k];
    if (need > r.cp && arc - ref.arc[ref.cpAt[need] ?? k] > 12) return 'missed';
    // Speed and the reference's speed, every 4 frames for the last 300 ms. A wreck loses 45 km/h in 100 ms; a
    // wall the car scrapes along bleeds 55 over 300 ms where the reference kept its speed.
    const h = job.speedHist, vr = Math.abs(ref.speed[k]);
    h.push(r.speed, vr);
    if (h.length > 150) h.splice(0, 2);
    const n = h.length;
    if (n >= 50 && h[n - 50] - r.speed > 45 && vr > r.speed + 40) return 'crash';
    if (n === 150 && vr > r.speed + 35 && h[1] - vr < 25) {
      let top = 0;
      for (let i = 0; i < n; i += 2) top = Math.max(top, h[i]);
      if (top - r.speed > 55) return 'crash';
    }
    // A retry got through where it failed: what it changed is how the bot drives there from now on.
    const fix = job.fix;
    if (fix && arc > fix.arc + FIX_PAST) {
      job.fix = null;
      if (job.notes && job.refIdx === job.hint && !job.practice) for (let s = fix.from; s <= fix.to; s++) job.notes.learn(s, fix.pace, fix.off);
    }
    const upDot = this.#up[0] * ref.ux[k] + this.#up[1] * ref.uy[k] + this.#up[2] * ref.uz[k];
    if (upDot < -0.3 && r.wheels === 0 && now - job.bestArcAt > 600) return 'flipped';
    return null;
  }

  #snapshot() {
    if (this.#carChanged) {
      this.#carChanged = false;
      this.#ring = [];
    }
    let slot: number;
    const cap = Math.max(2, Math.min(this.ringSize, Math.floor(SNAP_BUDGET / this.sim.heap.length)));
    while (this.#ring.length > cap) this.sim.dropSlot(this.#ring.shift()!.slot);
    if (this.#ring.length >= cap) {
      // Thin out so the kept snapshots reach back roughly geometrically: drop the one whose
      // neighbours are closest together for its age.
      let drop = 0, best = Infinity;
      const ring = this.#ring;
      for (let i = 1; i < ring.length - 1; i++) {
        const density = (ring[i + 1].tick - ring[i - 1].tick) / (this.#tick - ring[i].tick);
        if (density < best) {
          best = density;
          drop = i;
        }
      }
      if (this.#tick - ring[0].tick > (HOLD / TICK) * 1.2) drop = 0;
      slot = ring.splice(drop, 1)[0].slot;
    } else {
      const used = new Set(this.#ring.map((s) => s.slot));
      slot = 0;
      while (used.has(slot)) slot++;
    }
    this.sim.save(slot);
    const jobs = new Map<string, Saved>();
    for (const j of this.jobs) if (j.live) jobs.set(j.id, j.save());
    this.#ring.push({ slot, tick: this.#tick, jobs });
  }

  #recover(failed: Job[], live: Job[]) {
    // A snapshot can only be restored while every running bot still has the car it held then.
    const usable = this.#carChanged ? [] : this.#ring.filter((s) => live.every((j) => s.jobs.get(j.id)?.car === j.car));
    const plans: { job: Job; snap: Snap | null; rebuildTo: number }[] = [];
    for (const job of failed) {
      const bucket = Math.floor(job.failArc / 20);
      const n = (job.tries.get(bucket) ?? 0) + 1;
      job.tries.set(bucket, n);
      readRaw(job.prev, this.#raw);
      // Before the first checkpoint giving up means a restart, so keep trying much longer there.
      // Close behind the race clock there is no time to try again: take the failure and go on.
      const limit = this.hurry() ? 0 : this.#raw.respawnable ? 6 + Math.round(4 * job.bot.skill) : 12;
      // A mistake the bot made itself, and a careless bot keeps it, a couple of times a run at most,
      // and only where a respawn (not a restart) gets it going again.
      const keep = job.mistakeUntil >= job.failAt && this.#raw.respawnable && job.kept < Math.round(2.5 * job.bot.mistakes * job.slips) && job.rand() < job.bot.mistakes * job.slips;
      if (keep) job.kept++;
      let snap: Snap | null = null;
      let rebuildTo = -1;
      if (n <= limit && !keep) {
        const back = (job.failJump || job.failSlow ? [5, 8, 12, 8, 13, 10, 13, 13] : [2, 3, 5, 4, 8, 5, 10, 13])[Math.min(7, (n - 1) % 8)];
        const want = this.#tick - back;
        for (let i = usable.length - 1; i >= 0; i--) {
          const saved = usable[i].jobs.get(job.id)!;
          if (saved.t < job.committed) break;
          snap = usable[i];
          // Far enough back, and on the line there (going further back while still off it), and on the
          // ground before a flight that went wrong (nothing done in the air changes where it lands).
          if (usable[i].tick <= want && saved.lat < 0.6 && (job.airSince < 0 || saved.t < job.airSince - 300)) break;
        }
        // No snapshot holds this car any more (another bot changed cars): replay its own keys instead.
        if (!snap) rebuildTo = Math.max(job.committed, job.runStart, job.failAt - back * TICK);
      }
      plans.push({ job, snap, rebuildTo });
    }
    const restoring = plans.filter((p) => p.snap);
    if (restoring.length) {
      const oldest = restoring.reduce((a, b) => (a.snap!.tick <= b.snap!.tick ? a : b)).snap!;
      this.sim.restore(oldest.slot);
      this.stats.restores++;
      for (const job of live) {
        const from = oldest.jobs.get(job.id)!;
        const plan = restoring.find((p) => p.job === job);
        if (plan) {
          const target = plan.snap!.jobs.get(job.id)!;
          this.#replay(job, from.t, target.t);
          job.load(target);
          this.#vary(job, plan.job.failArc);
        } else this.#replay(job, from.t, job.t);
      }
      this.#ring = this.#ring.filter((s) => s.tick <= oldest.tick);
    }
    for (const p of plans) {
      if (p.snap) continue;
      if (p.rebuildTo >= 0 && p.rebuildTo > p.job.runStart) this.#rebuild(p.job, p.rebuildTo);
      else this.#accept(p.job);
    }
  }

  // A new car for this bot, driven through its own logged keys from the start of its run to time `to`.
  // Slower than a snapshot (it replays the whole run so far), so only for when no snapshot will do.
  #rebuild(job: Job, to: number) {
    this.stats.rebuilds++;
    if (job.car) this.sim.deleteCar(job.car);
    job.car = this.sim.newCar(job.copy && !job.copy.own ? this.full : this.track);
    this.#carChanged = true;
    const k = this.#k;
    let buf: Uint8Array | null = null;
    for (let t = job.runStart; t < to; t++) buf = this.sim.step(job.car, keysOf(job.keys[t], k));
    this.stats.replay += to - job.runStart;
    job.t = to;
    if (buf) {
      job.prev.set(buf.subarray(0, Math.min(buf.length, 256)));
      job.hasPrev = true;
      readRaw(buf, this.#raw);
      job.lastCp = this.#raw.cp;
      job.prevSpeed = this.#raw.speed;
      job.driver.anchor(this.#raw, job.st);
    }
    job.sec = -1;
    for (let q = 0; q < job.sin.length; q++) if (job.sin[q] > to - job.runStart) job.sin[q] = -1;
    while (job.out.length && job.out[job.out.length - 1].f > to) job.out.pop();
    job.bestArc = job.ref.arc[job.st.k];
    job.bestArcAt = to;
    job.farFrames = job.offFrames = 0;
    job.speedHist = [];
    job.failAt = -1;
    job.resetAt = -1;
    job.airSince = -1;
    this.#vary(job, job.failArc);
    job.failWhy = null;
  }

  // Steps a bot's car through its logged keys (physics only).
  #replay(job: Job, from: number, to: number) {
    const k = this.#k;
    for (let t = from; t < to; t++) this.sim.step(job.car, keysOf(job.keys[t], k));
    this.stats.replay += Math.max(0, to - from);
  }

  // Settings for the next try at the place that failed: slower first, faster for missed jumps,
  // then other lines.
  #vary(job: Job, arc: number) {
    const st = job.st, n = job.tries.get(Math.floor(arc / 20)) ?? 1;
    const until = job.t + 2500;
    // A jump wants the reference's own speed (and a little either side); anything else, slower.
    const full = 1 / Math.max(0.5, job.p.pace);
    const faster = job.failJump || job.failSlow;
    const paces = faster ? [full, full * 1.02, full * 0.98, full * 1.04, full * 0.96, full, full * 0.92, full * 1.06] : [0.95, 0.9, 0.85, 0.92, 0.8, 0.88, 0.75, 0.7];
    st.paceMul = paces[(n - 1) % paces.length];
    st.paceUntil = until;
    if (n >= 3) {
      st.bias = (job.rand() - 0.5) * 0.3;
      st.biasUntil = job.t + 200 + Math.floor(job.rand() * 400);
    }
    // A jump that went wrong: some tries fly it on the reference's own keys from before the takeoff.
    if (job.failJump && job.ref.kind !== 'explore' && (n === 2 || n === 4 || n === 7)) {
      st.openFrom = st.k + 1;
      st.openAt = job.t;
      st.openUntil = job.t + Math.min(6000, Math.max(0, job.failAt - job.t) + 1500);
    }
    // A drift that went wrong: take that part on grip.
    if (job.ref.kind !== 'explore' && ((job.failWhy === 'spun' && n % 2 === 1) || n === 3 || n === 6)) st.gripUntil = until;
    if (n >= 4) {
      st.off = (job.rand() - 0.5) * 1.2;
      st.offUntil = until;
    }
    // Still failing here: try another player's line through it, from where the car is (one that passes
    // close by; elsewhere the car would be lost on it).
    if (n >= 4 && n % 2 === 0 && job.refs.length > 1) {
      readRaw(job.prev, this.#raw);
      const r = this.#raw, d = new Float64Array(1);
      for (let step = 1; step < job.refs.length; step++) {
        const i = (job.refIdx + step) % job.refs.length;
        if (job.refs[i].search(r.x, r.y, r.z, r.cp, d) < 0 || d[0] > SWITCH_NEAR * SWITCH_NEAR) continue;
        job.useRef(i);
        job.driver.anchor(r, job.st);
        job.bestArc = job.ref.arc[job.st.k];
        break;
      }
    }
    st.imitating = false;
    // A failure the bot's own slip caused teaches it nothing about the place.
    if (job.notes && job.refIdx === job.hint && !job.practice && job.mistakeUntil < job.failAt) {
      const at = (i: number) => Math.min(job.notes!.n - 1, Math.floor(i / SECTION));
      job.fix = { from: at(st.k), to: at(Math.max(st.k, job.failK)), pace: st.paceMul, off: st.offUntil >= job.t ? st.off : null, arc };
    } else job.fix = null;
  }

  // Keeps going from a failure: respawn at the last checkpoint, or restart the run. In time attack, once it
  // has a time, a run that went wrong is started over (a respawn's time can't beat it).
  #accept(job: Job) {
    this.stats.accepted++;
    job.fix = null;
    const why = job.failWhy;
    job.failAt = -1;
    job.failWhy = null;
    readRaw(job.prev, this.#raw);
    if (job.mode === 'ta' && job.pbTime < Infinity) {
      job.tries.clear();
      this.#keep(job, job.t, job.prev);
      this.#startRun(job, job.t);
      this.stats.restarts++;
      return;
    }
    // A wreck that left the car crawling: back to the checkpoint rather than limp on.
    if (why === 'crash' && !(this.#raw.respawnable && this.#raw.speed < 0.5 * Math.abs(job.ref.speed[job.st.k]))) {
      job.speedHist = [];
      return;
    }
    job.respawns++;
    const again = this.#raw.cp === job.respawnCp;
    job.cpRespawns = again ? job.cpRespawns + 1 : 1;
    job.respawnCp = this.#raw.cp;
    // A respawn that keeps failing before the next checkpoint is a dead end (it goes the same way every
    // time), and so is one that can't get up to the speed the place needs.
    if (job.respawns > 6 || job.cpRespawns > 3 || (again && job.failSlow)) {
      this.#startOver(job);
      return;
    }
    if (this.#raw.respawnable) {
      job.forceReset = true;
      job.bestArcAt = job.t;
      job.farFrames = 0;
      job.st.biasUntil = job.st.paceUntil = job.st.offUntil = -1;
      this.#roll(job);
      this.stats.respawns++;
    } else if (job.mode === 'ta' || job.restarts < 1) {
      job.restarts++;
      job.tries.clear();
      this.#keep(job, job.t, job.prev);
      this.#startRun(job, job.t);
      this.stats.restarts++;
    } else this.#startOver(job);
  }

  // Nothing the bot does itself gets it through: it starts over on a recorded run's own keys (in time attack
  // only when the round is running out and it has no time yet), or with no recorded run (an explored route)
  // on its own driving again.
  #startOver(job: Job) {
    // The slowest recording that still finishes before the round ends (else the fastest).
    const recorded = job.refs.filter((r) => r.kind !== 'explore');
    const copy = [...recorded].reverse().find((r) => job.t + r.n + 500 <= job.end) ?? recorded[0] ?? null;
    const late = job.mode === 'run' || (!job.runs.some((r) => r[1] != null) && job.t + 3 * (copy?.n ?? 0) > job.end);
    const useCopy = copy && late ? copy : null;
    job.tries.clear();
    this.#keep(job, job.t, job.prev);
    this.#startRun(job, job.t, useCopy);
    this.stats.restarts++;
    if (useCopy) this.stats.copies++;
  }

  #commit(job: Job) {
    const limit = job.live ? job.t - HOLD : Infinity;
    if (limit <= job.committed) return;
    let n = 0;
    while (n < job.out.length && job.out[n].f < limit) n++;
    if (n) this.onCommit(job, job.out.splice(0, n));
    job.committed = Math.max(job.committed, Math.min(limit, job.t));
  }
}
