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
import { EXPERT_SKILL, type BotPlan, type Persona, type Tip } from '../wire.ts';
import { Brain } from './brain.ts';
import { copyDriverState, DEFAULT_PARAMS, Driver, newDriverState, type DriverParams, type DriverState } from './driver.ts';
import { clearanceOf, marginOffsets, type Clearance } from './clearance.ts';
import { FIELDS, Notes, refKey, SECTION } from './notes.ts';
import type { TrackRays } from './rays.ts';
import type { Reference } from './reference.ts';
import { Shared } from './shared.ts';
import { axes, newRaw, readRaw, type Keys, type Raw, type Sim, type TrackLoad } from './sim.ts';

export const TICK = 200;
// Frames each bot may still change; older keyframes are final and can be sent.
export const HOLD = 3000;
export const KEY_EVERY = 50;
// A hit's most velocity change, units/s (bumper cups).
const MAX_KICK = 30;
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
// Screening ways locally: how many, scored where the section this many after theirs begins, and the least
// gain (ms) over the run there that is worth driving on to the finish.
const LOCAL_TRIES = 6;
const LOCAL_SECTIONS = 3;
const LOCAL_GAIN = 5;
const THINK_BEHIND = 150;
const PONDER_MS = 20_000;
// The record chaser (Persona.wr): how much wider it searches than its record (Notes explore), and how much
// longer it goes over its runs.
const WR_EXPLORE = 3;
const WR_THINK = 3;
// Going over a run picks a section other bots found a faster way through as if it lost this much more (ms).
const TIP_PICK = 300;
// Least gain (ms) of another bot's win worth trying.
const TIP_GAIN = 20;
// An expert on a hint run this much slower than the fastest (log of their times) or more drives it at most this
// much faster than its own speeds.
const MAX_LIFT = 0.08;
// A retry counts as having got through this far (units) past where it failed.
const FIX_PAST = 25;
// Identical failures in a row a bot goes further back for before it lives with the failure.
const MAX_REPEATS = 8;
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
  // A bumper cup: planned only a moment ahead of the race clock and pushed back from where another car hit it.
  bumper?: boolean;
}

type Copy = { keys: Uint8Array; n: number; own?: boolean };
export function adoptPlan(job: Job, name: number, plan: BotPlan) {
  const notes = job.notes;
  if (job.name !== name || !notes || plan.ref !== refKey(notes.ref) || plan.notes.length !== notes.v.length || plan.sin.length !== notes.n) return;
  if (job.plan && job.plan.n <= plan.n) return;
  job.plan = plan;
  notes.v.set(plan.notes);
}

// Share of its hint's sections a run must have driven to become the bot's run (Job.plan).
const PLAN_SECTIONS = 0.8;
// Shortest lift (frames) worth trading for a brake in editKeys.
const LIFT_TRADE = 40;
// Heap slots for sector snapshots (counting down from here) and the most memory they may take.
const START_SLOT = 62;
const SECTOR_SLOT = 61;
const SECTOR_BYTES = 160 * 1024 * 1024;

// The record chaser's TAS-style search (Planner.#brute): window lengths (frames) an edit goes in, how far
// (units) off its run's place a try may get before it is given up, how often that place is sampled, the
// buckets snapshots are taken at and failures counted in, and how many snapshots.
const BRUTE_WINDOW = [60, 600];
const BRUTE_OFF = 30;
const TRACE_EVERY = 10;
const BRUTE_BUCKET = 500;
const BRUTE_SNAPS = 6;
// Share of tries driven on anyway when back on their run (for drift).
const BRUTE_DRIFT = 0.25;
const EMPTY = new Float32Array(0);

// Frames whose keys differ between a run and a recorded one (and the frames one has past the other).
function keysApart(plan: BotPlan, rec: Reference) {
  let d = Math.abs(plan.n - rec.n);
  for (let t = Math.min(plan.n, rec.n) - 1; t >= 0; t--) if ((plan.keys[t] & 15) !== (rec.keys[t] & 15)) d++;
  return d;
}

// One TAS-style edit of keys[a, b): a press or release of one key moved up to 20 frames, a tap of it added or
// taken away (1-40 frames), or a stretch of it up to 80 frames taken out. Never across a respawn press.
function mutateKeys(keys: Uint8Array, a: number, b: number, rand: () => number) {
  if (b - a < 2) return false;
  for (let i = a; i < b; i++) if (keys[i] & 16) return false;
  const x = rand(), bit = x < 0.2 ? 1 : x < 0.4 ? 4 : x < 0.7 ? 2 : 8;
  const set = (i: number, on: boolean) => {
    if (i < 0 || i >= keys.length) return;
    keys[i] = on ? keys[i] | bit : keys[i] & ~bit;
    // Left and right at once steer nowhere: pressing one lets go of the other.
    if (on && bit === 2) keys[i] &= ~8;
    if (on && bit === 8) keys[i] &= ~2;
  };
  const how = rand();
  if (how < 0.45) {
    const edges: number[] = [];
    for (let i = Math.max(1, a); i < b; i++) if ((keys[i] & bit) !== (keys[i - 1] & bit)) edges.push(i);
    if (edges.length) {
      const e = edges[Math.floor(rand() * edges.length)], d = (1 + Math.floor(rand() * 20)) * (rand() < 0.5 ? -1 : 1);
      const after = (keys[e] & bit) !== 0;
      if (d < 0) for (let i = e + d; i < e; i++) set(i, after);
      else for (let i = e; i < e + d; i++) set(i, !after);
      return true;
    }
  }
  if (how < 0.8) {
    const s0 = a + Math.floor(rand() * (b - a)), len = 1 + Math.floor(rand() * 40);
    for (let i = s0; i < Math.min(keys.length, s0 + len); i++) set(i, (keys[i] & bit) === 0);
    return true;
  }
  // A whole stretch of the key held (or let go, as a lift is) made longer or shorter by up to a third, from
  // either end, or taken out when short.
  const held = rand() < 0.5;
  const runs: [number, number][] = [];
  let st = -1;
  for (let i = a; i <= b; i++) {
    const on = i < b && ((keys[i] & bit) !== 0) === held;
    if (on && st < 0) st = i;
    if (!on && st >= 0) {
      if (i - st <= 600) runs.push([st, i]);
      st = -1;
    }
  }
  if (!runs.length) return false;
  const [r0, r1] = runs[Math.floor(rand() * runs.length)];
  const len = r1 - r0;
  if (len <= 80 && rand() < 0.4) {
    for (let i = r0; i < r1; i++) set(i, !held);
    return true;
  }
  const d = Math.max(1, Math.round(len * rand() * 0.33)), grow = rand() < 0.5, atEnd = rand() < 0.5;
  if (grow) for (let i = 0; i < d; i++) set(atEnd ? r1 + i : r0 - 1 - i, held);
  else for (let i = 0; i < d; i++) set(atEnd ? r1 - 1 - i : r0 + i, !held);
  return true;
}

// Keys driven as they are from frame `at` to `until` (going over a run: an edit of the bot's own keys).
type Force = { keys: Uint8Array; at: number; until: number; trade?: boolean };

// The bot's own keys from `at` to `until` with one stretch of braking or of no throttle (on its own, not a
// respawn) shortened at either end or left out: braking becomes throttle, a lift holds throttle. Or (now
// and then) a lift traded for a short brake at its end or start and throttle for the rest, as TAS runs
// slow down: Arx Lucida's TAS coasts about half as long as its record and gains most of its 0.3 s in those
// corners. Null when there is none.
function editKeys(plan: BotPlan, at: number, until: number, rand: () => number): Force | null {
  if (until - at < 20) return null;
  const keys = plan.keys.slice(at, until);
  const runs: [number, number, boolean][] = [];
  let a = -1, brake = false;
  for (let i = 0; i <= keys.length; i++) {
    const b = i < keys.length ? keys[i] : 1;
    const kind = b & 16 ? 0 : b & 4 ? 2 : b & 1 ? 0 : 1;
    if (a >= 0 && (kind === 0 || (kind === 2) !== brake)) {
      runs.push([a, i, brake]);
      a = -1;
    }
    if (a < 0 && kind) {
      a = i;
      brake = kind === 2;
    }
  }
  if (!runs.length) return null;
  const [from, to, braking] = runs[Math.floor(rand() * runs.length)];
  const len = to - from, how = rand();
  if (!braking && len >= LIFT_TRADE && rand() < 0.4) {
    const brake = Math.max(8, Math.round(len * (0.15 + 0.4 * rand())));
    const late = rand() < 0.7;
    for (let i = from; i < to; i++) {
      const inBrake = late ? i >= to - brake : i < from + brake;
      keys[i] = inBrake ? (keys[i] & ~1) | 4 : (keys[i] & ~4) | 1;
    }
    return { keys, at, until, trade: true };
  }
  // Left out, or its first or last part (a quarter to three quarters of it).
  const cut = how < 0.34 ? len : Math.max(1, Math.round(len * (0.25 + 0.5 * rand())));
  const lo = how < 0.67 ? from : to - cut;
  for (let i = lo; i < lo + cut; i++) keys[i] = (keys[i] & ~4) | 1;
  return { keys, at, until };
}

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
  // Going over a run: keys driven as they are for a while (Force).
  force: Force | null = null;
  // The last failure and the time its retry started from, and how many identical failures in a row.
  lastFail: { at: number; why: Why | null; from: number; n: number } = { at: -1, why: null, from: -1, n: 0 };
  repeats = 0;
  // Much slower than the reference where it failed: it needs more speed there, not less.
  failSlow = false;
  failK = 0;
  // A retry under way: the hint sections it changes, how (pace multiplier, offset or null), and where it failed.
  fix: { from: number; to: number; pace: number; off: number | null; arc: number; k: number } | null = null;
  // Goes over its run that found nothing better, per hint section, since the last that did.
  thinkFails = new Float32Array(0);
  // Other bots' wins this bot has tried already (each once: most don't carry over).
  tipsTried = new WeakSet<Tip>();
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
  readonly bumper: boolean;
  // Hits from other cars this run: the velocity change after the step that reached each frame. Nothing before
  // the latest one may be driven again (it happened where it happened).
  kicks = new Map<number, number[]>();
  kickFloor = -Infinity;
  // The last frame handed over, and (after a hit sent it back to a snapshot) the frame before which what it
  // drives again is what pages already have: those frames aren't handed over twice.
  sent = -Infinity;
  sameUntil = -Infinity;
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
    this.bumper = !!spec.bumper;
    this.drill = !!spec.drill;
    this.thinkRand = rng(b.seed ^ 0x5bd1e995);
    if (this.ref.kind !== 'explore') {
      const key = refKey(this.ref);
      const plan = spec.plans?.find((p) => p.ref === key && p.n > 0 && p.keys.length >= p.n) ?? null;
      // Every expert is as good as the best: its hint run only gives it its line and way of driving.
      const lift = b.skill >= EXPERT_SKILL ? Math.min(MAX_LIFT, Math.log(this.ref.n / sorted[0].n)) : 0;
      const explore = b.skill >= EXPERT_SKILL && Planner.explore ? (b.wr ? WR_EXPLORE : 2) : 1;
      const notes = new Notes(this.ref, this.name, plan?.notes ?? spec.notes?.[key], lift, explore);
      if (plan && plan.notes.length === notes.v.length && plan.sin.length === notes.n) this.plan = plan;
      // The record chaser starts as the record's own inputs and goes over them (Planner.#brute).
      else if (b.wr && Planner.seedRecord) {
        const sin = new Int32Array(notes.n);
        for (let q = 0; q < notes.n; q++) sin[q] = Math.min(this.ref.n - 1, q * SECTION);
        this.plan = { ref: key, notes: notes.v.slice(), keys: this.ref.keys.slice(0, this.ref.n), n: this.ref.n, sin };
      }
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
      : { ...DEFAULT_PARAMS, pace: Math.min(1, 0.78 + 0.22 * b.skill + jitter), imitate: b.skill >= 0.85 && !b.wr ? 0.05 : 0, drift: b.skill >= 0.5 };
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

  // keys[0..n) = src's (a run gone over from a snapshot: what came before it must be that run's own keys).
  keysUpTo(src: Uint8Array, n: number) {
    if (this.keys.length < n + 1024) {
      const g = new Uint8Array(Math.max(this.keys.length * 2, n + 1024));
      g.set(this.keys);
      this.keys = g;
    }
    this.keys.set(src.subarray(0, n));
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
  // Retries that fail exactly as the last one go further back (off only for lab comparisons).
  static retryMode = 1;
  // Experts explore beyond their hint (on; off only for lab comparisons).
  static explore = true;
  // The record chaser starts from the record's own inputs (off only for lab comparisons).
  static seedRecord = true;
  // Respawns after another car knocked the bot off don't count towards starting its run over (off only for lab
  // comparisons).
  static hitRespawnsFree = true;
  // A failure this soon after another car hit the bot was the hit's doing (bumper cups).
  static hitFailMs = 5000;
  // Share of the record chaser's goes over its run made its own way rather than by editing its inputs.
  static ownShare = 0.25;
  // Frames behind its run's place at which a try is given up.
  static bruteBehind = 30;
  // How much each fruitless go over a section lowers its chance of being picked again.
  static failWeight = 1;
  // Ways screened locally before one is driven to the finish (on; off only for lab comparisons).
  static screen = true;
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
  // What the bots on this track learned from each other (shared.ts), and a tip to pass on to other workers.
  readonly shared = new Shared();
  onTip: (tip: Tip) => void = () => {};
  // Set by the worker: how long a bot may go over its run between runs, ms.
  thinkMs: () => number = () => 400;
  // Going over a run or drilling a section: the heap is borrowed, nothing else may start.
  #busy = false;
  #ponderAt = 0;
  // Set by the worker: planning has fallen close behind the race clock.
  hurry: () => boolean = () => false;
  // Bumper cups: the last bot frame pages may have yet (just past the race clock). Planned frames past it are
  // only a guess another car's hit can still change.
  showBy: () => number = () => Infinity;
  // Set by the worker: planning is far enough ahead for the top expert to search its run (drill).
  roomy: () => boolean = () => true;
  // Tries left for going over runs (lab benchmarks set it; a cup runs on time alone).
  budget = Infinity;
  // Sector snapshots going over a run may keep (heap copies; the learning worker's planner uses them).
  sectorSnaps = 0;
  stats = { ticks: 0, rebuilds: 0, restores: 0, bumps: 0, shared: 0, tipsTried: 0, tipWays: 0, tipWins: 0, editWins: 0, tradeWins: 0, gripWins: 0, sectorHits: 0, bruteWins: 0, bruteDrift: 0, bruteGain: 0, bruteRestoreMs: 0, bruteFrames: 0, replay: 0, accepted: 0, respawns: 0, restarts: 0, copies: 0, frames: 0, thinks: 0, thinkMs: 0, tried: 0, fails: {} as Record<string, number> };

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
    job.kicks.clear();
    job.kickFloor = -Infinity;
    job.sameUntil = -Infinity;
    // A run that went onto another player's line to get through somewhere starts again on its own hint.
    if (job.hint >= 0) job.useRef(job.hint);
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
    job.lastFail = { at: -1, why: null, from: -1, n: 0 };
    job.repeats = 0;
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
      this.#kick(job, now);
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
    // A run another car pushed about can't be driven again from its keys, and one that drove most of the way on
    // another player's line (a retry switched to it) has no sections of its hint to go over: it would be
    // replayed as it is every round, never better.
    if (!job.notes || job.copy || job.bumper || (job.plan && job.plan.n <= time)) return;
    let mapped = 0;
    for (let q = 0; q < job.sin.length; q++) if (job.sin[q] >= 0) mapped++;
    if (mapped < PLAN_SECTIONS * job.sin.length) return;
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
    // The record chaser mostly edits its inputs; now and then it goes over its run its own way, which finds more
    // where the record left time on the table (Anubis).
    if (job.bot.wr && job.notes && job.plan?.ref === refKey(job.notes.ref) && job.thinkRand() >= Planner.ownShare) this.#brute(job, deadline);
    else this.#thinkOwn(job, deadline);
  }

  #thinkOwn(job: Job, deadline: number) {
    const notes = job.notes;
    let plan = notes && job.plan?.ref === refKey(notes.ref) ? job.plan : null;
    if (!notes || !plan || job.bumper || this.#busy || performance.now() >= deadline) return;
    this.#busy = true;
    const t0 = performance.now();
    this.stats.thinks++;
    const changed = this.#carChanged;
    const bot: Persona = { ...job.bot, mistakes: 0 };
    const tj = new Job({ id: 'think', bot, mode: 'run', end: notes.ref.n * 3 + 20000, brain: job.brainW, notes: { [plan.ref]: plan.notes.slice() }, practice: true, refIdx: job.hint }, this.refs, this.clear);
    tj.p.pace = job.p.pace;
    let better = false;
    // Heap snapshots by frame at section starts of the run being gone over, for this call only (nothing else
    // moves meanwhile): later tries there start from one instead of replaying the run from the start.
    const snaps = new Map<number, { slot: number; saved: Saved; resetAt: number }>();
    // With snapshots one car serves the whole call, kept from its start line (a snapshot from before another
    // car was made or deleted would break the physics).
    let startSnap: { slot: number; saved: Saved } | null = null;
    try {
      const sections = notes.n;
      if (this.sectorSnaps > 0) {
        this.#startRun(tj, 0);
        this.sim.save(START_SLOT);
        startSnap = { slot: START_SLOT, saved: tj.save() };
      }
      while (this.#more(deadline)) {
        if (job.thinkFails.length !== sections) job.thinkFails = new Float32Array(sections);
        const s = this.#pickSection(plan, job.thinkRand, sections, job.bot.wr ? null : (q) => (this.shared.wins(notes.ref, q, job.name).some((t) => t.gain >= TIP_GAIN && !job.tipsTried.has(t)) ? TIP_PICK : 0), job.thinkFails);
        if (s < 0) break;
        const planBefore: BotPlan = plan;
        // The run up to section s, once; every way tried starts from there. From the latest snapshot at or
        // before that frame when there is one (the run's keys before a snapshot are the ones it was taken
        // with), else from the start.
        const from = plan.sin[s];
        const k = this.#k;
        let base = -1;
        for (const q of snaps.keys()) if (q <= from && q > base) base = q;
        tj.keysUpTo(plan.keys, from);
        if (base === from) {
          const at = snaps.get(from)!;
          this.sim.restore(at.slot);
          tj.load(at.saved);
          tj.resetAt = at.resetAt;
          this.stats.sectorHits++;
        } else {
          let start = 0, resetAt = -1;
          if (base >= 0) {
            const at = snaps.get(base)!;
            this.sim.restore(at.slot);
            tj.load(at.saved);
            start = base;
            resetAt = at.resetAt;
            this.stats.sectorHits++;
          } else if (startSnap) {
            this.sim.restore(startSnap.slot);
            tj.load(startSnap.saved);
          } else this.#startRun(tj, 0);
          let buf: Uint8Array | null = start > 0 ? tj.prev : null;
          for (let t = start; t < from; t++) {
            const b = plan.keys[t];
            if (b & 16) resetAt = t;
            buf = this.sim.step(tj.car, keysOf(b, k));
          }
          if (!buf) continue;
          this.#resume(tj, buf, from, resetAt);
        }
        tj.sin.set(plan.sin);
        tj.sin.fill(-1, s);
        tj.sec = s - 1;
        const most = Math.min(this.sectorSnaps, Math.floor(SECTOR_BYTES / this.sim.heap.length));
        if (!snaps.has(from) && most > 0) {
          // A free slot, or the oldest one's.
          let slot = -1;
          if (snaps.size >= most) {
            const [q, old] = snaps.entries().next().value!;
            snaps.delete(q);
            slot = old.slot;
          } else {
            const used = new Set([...snaps.values()].map((x) => x.slot));
            for (let c = SECTOR_SLOT; c > SECTOR_SLOT - this.sectorSnaps && slot < 0; c--) if (!used.has(c)) slot = c;
          }
          if (slot >= 0) {
            this.sim.save(slot);
            snaps.set(from, { slot, saved: tj.save(), resetAt: tj.resetAt });
          }
        }
        this.sim.save(DRILL_SLOT);
        const saved = tj.save();
        const sin = tj.sin.slice();
        const reset = () => {
          this.sim.restore(DRILL_SLOT);
          tj.load(saved);
          tj.sin.set(sin);
          tj.sections!.set(plan!.notes);
          tj.force = null;
        };
        // A way through: other notes for section s, (open > 0) the hint run's own inputs for that long, or
        // (edit) the bot's own keys there with one brake or lift shortened or left out, as a TAS runner would.
        type Way = { notes: Float32Array | null; open: number; edit: Force | null; tip?: Tip; grip?: number };
        // Other bots' faster ways through this place (not for the record chaser, whose way is its own).
        const tips = job.bot.wr ? [] : this.shared.wins(notes.ref, s, job.name).filter((t) => t.v.length === FIELDS && t.gain >= TIP_GAIN && !job.tipsTried.has(t));
        const apply = (way: Way) => {
          if (way.notes) tj.sections!.set(way.notes, s * FIELDS);
          if (way.open > 0) {
            tj.st.openFrom = tj.st.k;
            tj.st.openAt = tj.t;
            tj.st.openUntil = tj.t + way.open;
          }
          tj.force = way.edit;
          if (way.grip) tj.st.gripUntil = tj.t + way.grip;
        };
        const make = (i: number): Way => {
          const r = job.thinkRand();
          if (i % 3 === 2 && tips.length) {
            const tip = tips.shift()!;
            job.tipsTried.add(tip);
            this.stats.tipWays++;
            return { notes: notes.fromTip(plan!.notes, s, tip.v, job.thinkRand), open: 0, edit: null, tip };
          }
          // The record chaser's way is its own: no stretches of the record's keys, more edits of its own.
          if (i % 3 === 0 || (job.bot.wr && i % 3 === 1)) {
            const edit = editKeys(plan!, from, Math.min(plan!.n, plan!.sin[s + 2] > 0 ? plan!.sin[s + 2] : from + 2 * SECTION), job.thinkRand);
            if (edit) return { notes: null, open: 0, edit };
          }
          if (i % 3 === 1 && r < 0.5 && !job.bot.wr) return { notes: null, open: SECTION * (job.thinkRand() < 0.5 ? 1 : 2), edit: null };
          // On grip instead of the hint's slide: Arx Lucida's TAS and its next-best run both take the record's
          // slides at 5.5 s and 12 s on grip and come out faster.
          if (i % 3 === 1 && r >= 0.5 && notes.slides(s)) return { notes: null, open: 0, edit: null, grip: SECTION * (job.thinkRand() < 0.5 ? 1 : 2) };
          return { notes: notes.nudge(plan!.notes, s, job.thinkRand), open: 0, edit: null };
        };
        const e = s + LOCAL_SECTIONS;
        let pick: Way | null = null;
        if (Planner.screen && e < sections && plan.sin[e] > 0) {
          // Each way is first driven only to where section e begins and scored there (time, less the speed it
          // carries), against the run's own score; only the best one is driven on to the finish.
          const k2 = this.#k;
          let pbuf: Uint8Array | null = null;
          for (let t = from; t < plan.sin[e]; t++) pbuf = this.sim.step(tj.car, keysOf(plan.keys[t], k2));
          if (!pbuf) continue;
          readRaw(pbuf, this.#raw);
          let least = plan.sin[e] - EXIT_MS_PER_KMH * this.#raw.speed - LOCAL_GAIN;
          for (let i = 0; i < LOCAL_TRIES && this.#more(deadline); i++) {
            this.budget--;
            reset();
            const way = make(i);
            apply(way);
            const until = plan.sin[e] + THINK_BEHIND;
            while (tj.status === 'run' && tj.failAt < 0 && tj.sin[e] < 0 && tj.t < until) this.#run(tj, tj.t + TICK);
            if (tj.failAt >= 0 || tj.sin[e] < 0) continue;
            const cost = tj.sin[e] - EXIT_MS_PER_KMH * tj.vout[e - 1];
            if (cost < least) {
              least = cost;
              pick = way;
            }
          }
          if (!pick) {
            this.sim.dropSlot(DRILL_SLOT);
            continue;
          }
        }
        for (let i = 0; i < (pick ? 1 : THINK_TRIES) && this.#more(deadline); i++) {
          this.budget--;
          reset();
          const way = pick ?? make(i);
          apply(way);
          const p = this.#tryRest(tj, plan, s);
          this.stats.tried++;
          if (p) {
            if (way.tip) this.stats.tipWins++;
            if (way.edit) this.stats[way.edit.trade ? 'tradeWins' : 'editWins']++;
            if (way.grip) this.stats.gripWins++;
            else if (way.notes) this.#share(job, notes.ref, 'win', s * SECTION, [...way.notes], plan.n - p.n);
            plan = p;
            better = true;
            // The new run has other keys from frame `from` on: snapshots after it no longer hold.
            for (const [q, at] of [...snaps]) if (q > from) {
              this.sim.dropSlot(at.slot);
              snaps.delete(q);
            }
            break;
          }
        }
        this.sim.dropSlot(DRILL_SLOT);
        // Nothing tried there helped: the section is picked less often, until something does.
        if (plan === planBefore) job.thinkFails[s]++;
        else job.thinkFails[s] = 0;
      }
    } finally {
      for (const at of snaps.values()) this.sim.dropSlot(at.slot);
      if (startSnap) this.sim.dropSlot(startSnap.slot);
      if (tj.car) this.sim.deleteCar(tj.car);
      tj.car = 0;
      this.#carChanged = changed;
      this.#busy = false;
      this.stats.thinkMs += performance.now() - t0;
    }
    if (better && plan) {
      job.plan = plan;
      notes.v.set(plan.notes);
      this.onPlan(job, plan);
    }
  }

  // The record chaser goes over its run as a TAS runner would (it starts as the record's own inputs): one
  // edit of its keys in a short window (a press or release moved, a tap added or taken out), the rest of its
  // keys as they were, the game's physics to the finish. Sooner: its run. As soon and further from the
  // record's inputs: its run too, so it becomes a run of its own without getting slower. Like #think it uses a
  // car of its own and heap slots, and leaves the bots' cars and the planner's snapshots as they were.
  #brute(job: Job, deadline: number) {
    const notes = job.notes!, rec = notes.ref;
    let plan = job.plan!;
    if (this.#busy || plan.n < 2 || !this.#more(deadline)) return;
    this.#busy = true;
    const t0 = performance.now();
    this.stats.thinks++;
    const changed = this.#carChanged;
    const k = this.#k, r = this.#raw;
    const car = this.sim.newCar(this.track);
    // Heap snapshots by frame (this call only), and the run's place every TRACE_EVERY frames.
    const snaps = new Map<number, number>();
    let better = false;
    // A try is given up once it is behind its run's place (it can't finish sooner), and, most times, once it is
    // back on the run's exact place (it can only finish when the run does; now and then it is driven on, for a
    // run as fast and further from the record).
    const drive = (keys: Uint8Array, a: number, end: number, trace: Float32Array | null, out: Float32Array | null, drift = false, changed = 0) => {
      let same = 0, best = Math.floor(a / TRACE_EVERY);
      const d2at = (j: number) => {
        const ex = r.x - trace![j * 3], ey = r.y - trace![j * 3 + 1], ez = r.z - trace![j * 3 + 2];
        return ex * ex + ey * ey + ez * ez;
      };
      for (let t = a; t < end; t++) {
        readRaw(this.sim.step(car, keysOf(keys[Math.min(t, keys.length - 1)], k)), r);
        const i = (t + 1) / TRACE_EVERY;
        const sample = Number.isInteger(i) && i * 3 + 2 < (out ?? trace ?? EMPTY).length;
        if (out && sample) {
          out[i * 3] = r.x;
          out[i * 3 + 1] = r.y;
          out[i * 3 + 2] = r.z;
        }
        if (r.finished) return r.finishFrames;
        if (!trace || !sample) continue;
        const d2 = d2at(i);
        if (d2 > BRUTE_OFF * BRUTE_OFF) return -1;
        same = d2 === 0 && t > changed ? same + 1 : 0;
        if (same >= 3 && !drift) return -2;
        if (d2 === 0) {
          best = i;
          continue;
        }
        // Where along the run the car is: its nearest place, followed from the last one.
        const last = trace.length / 3 - 1;
        let bd = d2at(Math.min(best, last));
        best = Math.min(best, last);
        while (best < last && d2at(best + 1) < bd) bd = d2at(++best);
        while (best > 0 && d2at(best - 1) < bd) bd = d2at(--best);
        const nb = best < last ? best + 1 : best - 1;
        let at = best;
        if (nb >= 0 && nb !== best) {
          const sx = trace[nb * 3] - trace[best * 3], sy = trace[nb * 3 + 1] - trace[best * 3 + 1], sz = trace[nb * 3 + 2] - trace[best * 3 + 2];
          const s2 = sx * sx + sy * sy + sz * sz;
          if (s2 > 0) at = best + (nb - best) * Math.max(-1, Math.min(1, ((r.x - trace[best * 3]) * sx + (r.y - trace[best * 3 + 1]) * sy + (r.z - trace[best * 3 + 2]) * sz) / s2));
        }
        const lead = (at - i) * TRACE_EVERY;
        if (lead < -Planner.bruteBehind) return -1;
      }
      return -1;
    };
    try {
      this.sim.save(START_SLOT);
      // The run as it is, once: it must finish where it says (a record that doesn't on this track's parts is no
      // start), and its place along the way is what tries are checked against.
      let trace = new Float32Array(3 * (Math.floor(plan.n / TRACE_EVERY) + 2));
      if (drive(plan.keys, 0, plan.n + 1, null, trace) !== plan.n) {
        job.plan = null;
        return;
      }
      let diff = keysApart(plan, rec);
      const n0 = plan.n;
      const fails = new Float32Array(Math.ceil(plan.n / BRUTE_BUCKET) + 1);
      while (this.#more(deadline)) {
        this.budget--;
        this.stats.tried++;
        // Where: a window anywhere, less often where edits have failed lately.
        let a = 0;
        for (let pick = 0; pick < 4; pick++) {
          a = Math.floor(job.thinkRand() * Math.max(1, plan.n - 50));
          if (job.thinkRand() * (1 + Planner.failWeight * fails[Math.floor(a / BRUTE_BUCKET)]) < 1) break;
        }
        const w = BRUTE_WINDOW[0] + Math.floor(job.thinkRand() * (BRUTE_WINDOW[1] - BRUTE_WINDOW[0]));
        const keys = plan.keys.slice(0, plan.n);
        if (!mutateKeys(keys, a, Math.min(plan.n, a + w), job.thinkRand)) continue;
        // The frames the edit changed: the try is driven from the first, and is "back on the run" only after the last.
        let lo = -1, hi = -1;
        for (let t = 0; t < plan.n; t++)
          if (keys[t] !== plan.keys[t]) {
            if (lo < 0) lo = t;
            hi = t;
          }
        if (lo < 0) continue;
        a = lo;
        // To frame a from the latest snapshot before it (one is taken at its bucket's start on the way).
        let at = -1;
        for (const q of snaps.keys()) if (q <= a && q > at) at = q;
        const tr = performance.now();
        if (at >= 0) this.sim.restore(snaps.get(at)!);
        else {
          this.sim.restore(START_SLOT);
          at = 0;
        }
        this.stats.bruteRestoreMs += performance.now() - tr;
        this.stats.bruteFrames -= at;
        const b0 = Math.floor(a / BRUTE_BUCKET) * BRUTE_BUCKET;
        if (at < b0) {
          drive(plan.keys, at, b0, null, null);
          at = b0;
          if (snaps.size < Math.min(this.sectorSnaps, BRUTE_SNAPS, Math.floor(SECTOR_BYTES / this.sim.heap.length))) {
            const used = new Set(snaps.values());
            let slot = SECTOR_SLOT;
            while (used.has(slot)) slot--;
            this.sim.save(slot);
            snaps.set(b0, slot);
          }
        }
        drive(plan.keys, at, a, null, null);
        const out = new Float32Array(trace.length);
        const f = drive(keys, a, plan.n + 1, trace, out, job.thinkRand() < BRUTE_DRIFT, hi);
        this.stats.bruteFrames += this.#raw.frames;
        if (f < 0 || f > plan.n) {
          fails[Math.floor(a / BRUTE_BUCKET)]++;
          continue;
        }
        const next: BotPlan = { ref: plan.ref, notes: plan.notes, keys: keys.slice(0, f), n: f, sin: plan.sin.map((x) => Math.min(x, f - 1)) };
        const apart = keysApart(next, rec);
        if (f === plan.n && apart <= diff) {
          fails[Math.floor(a / BRUTE_BUCKET)]++;
          continue;
        }
        if (f < plan.n) this.stats.bruteWins++;
        else this.stats.bruteDrift++;
        // Its place from frame a on is the new run's.
        const keep = Math.floor(a / TRACE_EVERY) * 3 + 3;
        const nt = new Float32Array(3 * (Math.floor(f / TRACE_EVERY) + 2));
        nt.set(trace.subarray(0, Math.min(keep, nt.length)));
        if (keep < nt.length) nt.set(out.subarray(keep, Math.min(out.length, nt.length)), keep);
        trace = nt;
        plan = next;
        diff = apart;
        better = true;
        fails[Math.floor(a / BRUTE_BUCKET)] = 0;
        for (const [q, slot] of [...snaps])
          if (q > a) {
            this.sim.dropSlot(slot);
            snaps.delete(q);
          }
      }
      this.stats.bruteGain += n0 - plan.n;
    } finally {
      for (const slot of snaps.values()) this.sim.dropSlot(slot);
      this.sim.dropSlot(START_SLOT);
      this.sim.deleteCar(car);
      this.#carChanged = changed;
      this.#busy = false;
      this.stats.thinkMs += performance.now() - t0;
    }
    if (better) {
      job.plan = plan;
      this.onPlan(job, plan);
    }
  }

  #share(job: Job, ref: Reference, kind: Tip['kind'], k: number, v: number[], gain: number) {
    const i = Math.max(0, Math.min(ref.n - 1, k));
    const tip: Tip = { kind, by: job.name, x: ref.px[i], y: ref.py[i], z: ref.pz[i], cp: ref.cp[i], ref: refKey(ref), s: Math.floor(i / SECTION), v, gain };
    if (!this.shared.add(tip)) return;
    this.stats.shared++;
    this.onTip(tip);
  }

  // Going over runs goes on until the deadline, or (lab) until `budget` tries are spent.
  #more(deadline: number) {
    return this.budget > 0 && performance.now() < deadline;
  }

  // The section to go over next: where the run loses most against its hint run (each section is a second of
  // it), now and then any; `bonus` adds weight (other bots found a faster way through there).
  #pickSection(plan: BotPlan, rand: () => number, n: number, bonus: ((s: number) => number) | null = null, fails: Float32Array | null = null) {
    const w: number[] = [];
    let sum = 0;
    for (let s = 0; s < n - 1; s++) {
      const a = plan.sin[s], b = plan.sin[s + 1];
      const v = a > 0 && b > a ? (Math.max(0, b - a - SECTION) + 40 + (bonus?.(s) ?? 0)) / (1 + Planner.failWeight * (fails?.[s] ?? 0)) : 0;
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

  // Goes over a bot's run until the deadline (the learning worker's own planner, for experts' runs).
  improve(job: Job, deadline: number) {
    this.#think(job, deadline);
  }

  // A faster run of a bot's own found elsewhere (the learning worker, or another round): its next run drives it.
  adopt(name: number, plan: BotPlan) {
    for (const job of this.jobs) adoptPlan(job, name, plan);
  }

  // Thinks over done bots' runs while the planner has nothing else to do (between rounds), each for up to
  // PONDER_MS; true if it did.
  ponder(deadline: number) {
    if (this.busy) return false;
    const done = this.jobs.filter((j) => j.status === 'done' && j.plan && j.pondered < PONDER_MS * (j.bot.wr ? WR_THINK : 1));
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
    const force = job.force;
    if (force && t >= force.at && t < force.until) {
      keysOf(force.keys[t - force.at], k);
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
      if (job.notes && job.refIdx === job.hint && !job.practice) {
        for (let s = fix.from; s <= fix.to; s++) job.notes.learn(s, fix.pace, fix.off);
        this.#share(job, job.ref, 'fix', fix.k, [fix.pace, fix.off ?? NaN], 0);
      }
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
      // The same failure as the last try's (same kind, within 8 ms): that try started past the point where the
      // run was lost, so it taught nothing. It doesn't count as a try; the next one starts further back.
      // (When it can't go further back, another way through is tried from there instead.)
      const last = job.lastFail;
      const back1 = last.from - TICK * (job.repeats + 1);
      const repeat = Planner.retryMode > 0 && last.why === job.failWhy && Math.abs(last.at - job.failAt) <= 8 && job.repeats < MAX_REPEATS && back1 > Math.max(job.committed, job.runStart);
      const bucket = Math.floor(job.failArc / 20);
      const n = repeat ? last.n : (job.tries.get(bucket) ?? 0) + 1;
      if (!repeat) job.tries.set(bucket, n);
      job.repeats = repeat ? job.repeats + 1 : 0;
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
      const before = repeat ? back1 : Infinity;
      if (n <= limit && !keep) {
        const back = (job.failJump || job.failSlow ? [5, 8, 12, 8, 13, 10, 13, 13] : [2, 3, 5, 4, 8, 5, 10, 13])[Math.min(7, (n - 1) % 8)];
        const want = this.#tick - back;
        for (let i = usable.length - 1; i >= 0; i--) {
          const saved = usable[i].jobs.get(job.id)!;
          if (saved.t < Math.max(job.committed, job.kickFloor)) break;
          if (saved.t > before) continue;
          snap = usable[i];
          // Far enough back, and on the line there (going further back while still off it), and on the
          // ground before a flight that went wrong (nothing done in the air changes where it lands).
          if (usable[i].tick <= want && saved.lat < 0.6 && (job.airSince < 0 || saved.t < job.airSince - 300)) break;
        }
        // No snapshot holds this car any more (another bot changed cars), or none is far enough back: replay its
        // own keys instead.
        if (!snap) rebuildTo = Math.max(job.committed, job.runStart, job.kickFloor, Math.min(job.failAt - back * TICK, before));
        job.lastFail = { at: job.failAt, why: job.failWhy, from: snap ? snap.jobs.get(job.id)!.t : rebuildTo, n };
      } else job.lastFail = { at: -1, why: null, from: -1, n: 0 };
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
  #rebuild(job: Job, to: number, vary = true) {
    this.stats.rebuilds++;
    if (job.car) this.sim.deleteCar(job.car);
    job.car = this.sim.newCar(job.copy && !job.copy.own ? this.full : this.track);
    this.#carChanged = true;
    const k = this.#k;
    let buf: Uint8Array | null = null;
    for (let t = job.runStart; t < to; t++) {
      buf = this.sim.step(job.car, keysOf(job.keys[t], k));
      this.#kick(job, t + 1);
    }
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
    if (vary) this.#vary(job, job.failArc);
    job.failWhy = null;
  }

  // Steps a bot's car through its logged keys (physics only).
  #replay(job: Job, from: number, to: number) {
    const k = this.#k;
    for (let t = from; t < to; t++) {
      this.sim.step(job.car, keysOf(job.keys[t], k));
      this.#kick(job, t + 1);
    }
    this.stats.replay += Math.max(0, to - from);
  }

  #kick(job: Job, f: number) {
    if (!job.kicks.size) return;
    const v = job.kicks.get(f);
    if (v) this.sim.kick(job.car, v);
  }

  // Another car hit bot `id` at its frame `at` (bumper cups): the velocity change v there, and the bot driven on
  // from it. A hit in the past sends every bot back to a snapshot from before it (the others drive their own
  // keys again to where they were); this one drives its own keys up to the hit, then on from there. Its frames
  // from there go to pages again. False when it isn't one of this planner's running bumper bots.
  bump(id: string, at: number, v: number[]) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job || !job.bumper || job.status !== 'run' || v.length !== 3 || !v.every(Number.isFinite) || !Number.isFinite(at)) return false;
    at = Math.round(at);
    if (at <= job.runStart || at < job.kickFloor) return false;
    const len = Math.hypot(v[0], v[1], v[2]), scale = len > MAX_KICK ? MAX_KICK / len : 1;
    const dv = v.map((x) => x * scale);
    const was = job.kicks.get(at);
    job.kicks.set(at, was ? was.map((x, j) => x + dv[j]) : dv);
    job.kickFloor = at;
    this.stats.bumps++;
    if (at > job.t) return true;
    const live = this.jobs.filter((j) => j.live);
    const usable = this.#carChanged ? [] : this.#ring.filter((s) => live.every((j) => s.jobs.get(j.id)?.car === j.car));
    let snap: Snap | null = null;
    for (let i = usable.length - 1; i >= 0 && !snap; i--) {
      const saved = usable[i].jobs.get(job.id)!;
      if (saved.t <= at && saved.t >= job.runStart) snap = usable[i];
    }
    job.copy = null;
    if (!snap) {
      this.#rebuild(job, at, false);
      job.committed = Math.min(job.committed, at);
      return true;
    }
    this.sim.restore(snap.slot);
    this.stats.restores++;
    for (const j of live) {
      const from = snap.jobs.get(j.id)!;
      if (j !== job) {
        this.#replay(j, from.t, j.t);
        continue;
      }
      j.load(from);
      j.force = at > from.t ? { keys: j.keys.slice(from.t, at), at: from.t, until: at } : null;
      j.committed = Math.min(j.committed, from.t);
      j.sameUntil = at;
    }
    this.#ring = this.#ring.filter((s) => s.tick <= snap!.tick);
    return true;
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
    // The first try here: another bot that failed about here got past this way.
    if (n === 1 && job.ref.kind !== 'explore' && !job.practice) {
      const i = Math.max(0, Math.min(job.ref.n - 1, job.failK));
      const tip = this.shared.near('fix', job.ref.px[i], job.ref.py[i], job.ref.pz[i], job.ref.cp[i], job.name)[0];
      if (tip) {
        st.paceMul = Math.max(0.6, Math.min(1.1 * full, tip.v[0]));
        if (Number.isFinite(tip.v[1]) && tip.ref === refKey(job.ref)) {
          st.off = tip.v[1];
          st.offUntil = until;
        }
        this.stats.tipsTried++;
      }
    }
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
      job.fix = { from: at(st.k), to: at(Math.max(st.k, job.failK)), pace: st.paceMul, off: st.offUntil >= job.t ? st.off : null, arc, k: job.failK };
    } else job.fix = null;
  }

  // Keeps going from a failure: respawn at the last checkpoint, or restart the run. In time attack, once it
  // has a time, a run that went wrong is started over (a respawn's time can't beat it).
  #accept(job: Job) {
    this.stats.accepted++;
    job.fix = null;
    const why = job.failWhy;
    const hit = Planner.hitRespawnsFree && job.failAt - job.kickFloor < Planner.hitFailMs;
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
    // A respawn that keeps failing before the next checkpoint is a dead end (it goes the same way every
    // time), and so is one that can't get up to the speed the place needs. One after another car knocked it off
    // is the hit's doing, not a dead end.
    if (!hit) {
      job.respawns++;
      const again = this.#raw.cp === job.respawnCp;
      job.cpRespawns = again ? job.cpRespawns + 1 : 1;
      job.respawnCp = this.#raw.cp;
      if (job.respawns > 6 || job.cpRespawns > 3 || (again && job.failSlow)) {
        this.#startOver(job);
        return;
      }
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
    // The record chaser never drives the record's keys: its own best run if it has one, else its own driving.
    const own = job.bot.wr && job.plan && job.t + job.plan.n + 500 <= job.end ? { keys: job.plan.keys, n: job.plan.n, own: true } : null;
    const useCopy = own ?? (copy && late && !job.bot.wr ? copy : null);
    job.tries.clear();
    this.#keep(job, job.t, job.prev);
    this.#startRun(job, job.t, useCopy);
    this.stats.restarts++;
    if (useCopy) this.stats.copies++;
  }

  // Hands over what is due (bumper cups hand frames over as the race clock goes, not as planning goes).
  commitAll() {
    for (const job of this.jobs) this.#commit(job);
  }

  #commit(job: Job) {
    const limit = job.live ? (job.bumper ? Math.min(job.t, this.showBy()) : job.t - HOLD) : Infinity;
    if (limit <= job.committed) return;
    let n = 0;
    while (n < job.out.length && job.out[n].f < limit) n++;
    if (n) {
      let outs = job.out.splice(0, n);
      if (job.sameUntil > -Infinity) {
        outs = outs.filter((o) => o.f >= job.sameUntil || o.f > job.sent);
        if (limit > job.sameUntil) job.sameUntil = -Infinity;
      }
      if (outs.length) {
        job.sent = Math.max(job.sent, outs[outs.length - 1].f);
        this.onCommit(job, outs);
      }
    }
    job.committed = Math.max(job.committed, Math.min(limit, job.t));
  }
}
