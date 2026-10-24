// How the bots' network learns (brain.ts): evolution strategies on the game's own physics. A test drives
// one bot's whole run through the planner (with its retries, respawns and restarts) and costs what a
// viewer would see: the finish time, and a little more for every wreck the bot had to live with. A change
// to the weights is kept only if it costs less than the current weights on the same test, so learning
// never makes a bot worse on what it was tested on. Used offline in the lab and online during a cup.
// Between those tests it drives the experts' practice: a run where before each section of its notes
// (notes.ts) the bot tries a few other ways through it from the same exact state and drives on with the
// fastest; the notes that run ends with are kept only if, like the weights, they do no worse than the old
// ones on every one of fresh race runs and better overall.
import type { BotPlan, Persona, Tip } from '../wire.ts';
import { BRAIN_SIZE } from './brain.ts';
import type { Clearance } from './clearance.ts';
import { refKey } from './notes.ts';
import { adoptPlan, Planner, type Job } from './planner.ts';
import type { Reference } from './reference.ts';
import type { Sim, TrackLoad } from './sim.ts';

export interface Course {
  sim: Sim;
  route: TrackLoad;
  full: TrackLoad;
  refs: Reference[];
  clear: Map<Reference, Clearance>;
}

const WRECK_MS = 1000;
// Size of a tried change, the least gain (share of the cost) that counts as better, and how many seeds a
// test drives (one lucky or unlucky run mustn't decide it).
const SIGMA = 0.05;
const MIN_GAIN = 0.002;
const SEEDS = 2;
// Other ways tried through each section in practice, the race runs that test what it found, and the least
// gain (ms over all of them) that is kept.
const DRILL_TRIES = 4;
const PRACTICE_SEEDS = 3;
const PRACTICE_GAIN = 30;
// Least time given to going over an expert's run in one turn, ms.
const POLISH_MS = 1500;

export const testPersona = (skill: number, seed: number): Persona => ({ u: 0, skill, risk: skill ** 1.5, mistakes: (1 - skill) * 0.8, seed });

function rng(seed: number) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One bot's test run, planned a few ticks at a time so it can share a worker.
export class Trial {
  readonly #planner: Planner;
  readonly #job: Job;
  readonly #end: number;
  cost = Infinity;
  done = false;

  // With `drill`, an expert's practice run (planner.practise); otherwise a run as in a race.
  readonly #drill: (() => number) | null;

  constructor(c: Course, bot: Persona, w: Float32Array | null, notes: Record<string, Float32Array> | null = null, drill: (() => number) | null = null) {
    this.#planner = new Planner(c.sim, c.route, c.refs, 3, c.clear, c.full);
    this.#end = c.refs[0].n * 3 + 20000;
    this.#drill = drill;
    this.#job = this.#planner.add({ id: 'test', bot, mode: 'run', end: this.#end, brain: w, notes, practice: !!drill });
  }

  get job() {
    return this.#job;
  }

  // Plans until the deadline (performance.now()) or the end of the run; true once it has ended.
  step(deadline: number) {
    if (this.done) return true;
    while (performance.now() < deadline) {
      if (this.#drill ? this.#planner.practise(this.#drill, DRILL_TRIES) : this.#planner.tick()) continue;
      const job = this.#job, run = job.runs.find((r) => r[1] != null);
      this.cost = (run ? run[1]! : 2 * this.#end) + WRECK_MS * this.#planner.stats.accepted;
      this.#planner.dispose();
      this.done = true;
      return true;
    }
    return false;
  }

  dispose() {
    if (!this.done) this.#planner.dispose();
    this.done = true;
  }
}

export interface Practice {
  bot: Persona;
  notes: Record<string, Float32Array>;
}

// An expert whose own runs the learning worker goes over, and the runs it has so far.
export interface Polish {
  bot: Persona;
  plans: BotPlan[];
}

export interface Task {
  // A skill level's weights for this course and their cost on the last test.
  key: string;
  skill: number;
  w: Float32Array;
}

// Learns every task's weights in turn: each round of a task tests its current weights, a random change and
// the opposite change on the same fresh seeds, and keeps the better change if it is no worse on any seed
// and better overall (a win on one seed where the current weights happened to wreck is luck, not learning).
export class Learner {
  readonly #c: Course;
  readonly #tasks: Task[];
  readonly #rand: () => number;
  #at = 0;
  #gen = 0;
  #seeds: number[] = [];
  #eps: Float32Array | null = null;
  // Per arm (current, +change, -change), the cost on each seed.
  #costs: number[][] = [];
  #runs = 0;
  #trial: Trial | null = null;
  readonly #practice: Practice[];
  #turn = 0;
  #drills = 0;
  #drill: { p: Practice; drill: Trial; key: string; v: Float32Array | null; seeds: number[]; tests: (() => Trial)[]; costs: number[]; test: Trial | null } | null = null;
  onBetter: (task: Task, cost: number, was: number) => void = () => {};
  // An expert's notes on its hint run (key) got better in practice: a run costs `cost` now, `was` before.
  onNotes: (bot: Persona, key: string, v: Float32Array, cost: number, was: number) => void = () => {};
  // An expert's run got faster here (planner.ts, #think): its next run drives it.
  onPlan: (name: number, plan: BotPlan) => void = () => {};
  // Something an expert learned here that other bots may try (shared.ts).
  onTip: (tip: Tip) => void = () => {};
  // Experts' runs gone over in turn, on a planner of their own whose jobs are never driven (no cars).
  #polisher: Planner | null = null;
  #polish: Job[] = [];
  #polishAt = 0;

  constructor(c: Course, tasks: Task[], seed: number, practice: Practice[] = [], polish: Polish[] = []) {
    this.#c = c;
    this.#tasks = tasks;
    this.#practice = practice;
    this.#rand = rng(seed);
    if (polish.length) {
      const pl = (this.#polisher = new Planner(c.sim, c.route, c.refs, 2, c.clear, c.full));
      pl.onPlan = (job, plan) => this.onPlan(job.name, plan);
      pl.onTip = (tip) => this.onTip(tip);
      polish.forEach((p, i) => {
        const job = pl.add({ id: `polish${i}`, bot: { ...p.bot, mistakes: 0 }, mode: 'run', end: c.refs[0].n * 3 + 20000, plans: p.plans });
        pl.cancel(job.id);
        this.#polish.push(job);
      });
    }
  }

  // The planner going over experts' runs: what it tried and found (lab).
  get polishStats() {
    return this.#polisher?.stats ?? null;
  }

  // What bots learned elsewhere.
  share(tips: Tip[]) {
    for (const t of tips) this.#polisher?.shared.add(t);
  }

  // A faster run of an expert's own found elsewhere.
  adopt(name: number, plan: BotPlan) {
    for (const job of this.#polish) adoptPlan(job, name, plan);
  }

  // Goes over the next expert's run that has one; false when none has.
  #polishNext(deadline: number) {
    // The record chaser gets as many turns as the other experts together.
    const others = this.#polish.filter((j) => j.plan && !j.bot.wr);
    const ready = this.#polish.filter((j) => j.plan).flatMap((j) => (j.bot.wr ? Array<Job>(Math.max(1, others.length)).fill(j) : [j]));
    if (!ready.length || !this.#polisher) return false;
    // Going over a run needs time to replay it to a section and try a few ways there, whatever the slice.
    this.#polisher.improve(ready[this.#polishAt++ % ready.length], Math.max(deadline, performance.now() + POLISH_MS));
    return true;
  }

  // An expert's notes learned elsewhere.
  merge(name: number, key: string, v: Float32Array) {
    for (const p of this.#practice) if ((p.bot.name ?? p.bot.u) === name) p.notes[key] = v.slice();
  }

  // One practice of the next expert and its tests; true once they have ended.
  #practise(deadline: number) {
    const seed = () => Math.floor(this.#rand() * 2 ** 31);
    if (!this.#drill) {
      const p = this.#practice[this.#drills++ % this.#practice.length];
      const drill = new Trial(this.#c, { ...p.bot, seed: seed(), mistakes: 0 }, null, p.notes, this.#rand);
      this.#drill = { p, drill, key: '', v: null, seeds: Array.from({ length: PRACTICE_SEEDS }, seed), tests: [], costs: [], test: null };
    }
    const d = this.#drill;
    if (!d.v) {
      if (!d.drill.step(deadline)) return false;
      const job = d.drill.job;
      if (!job.notes) {
        this.#drill = null;
        return true;
      }
      d.key = refKey(job.notes.ref);
      d.v = job.sections!.slice();
      // Each test seed drives the old notes, then the new (one at a time: trials share the physics heap).
      for (const s of d.seeds) for (const notes of [d.p.notes, { ...d.p.notes, [d.key]: d.v }]) d.tests.push(() => new Trial(this.#c, { ...d.p.bot, seed: s }, null, notes));
    }
    while (d.costs.length < d.tests.length) {
      d.test ??= d.tests[d.costs.length]();
      if (!d.test.step(deadline)) return false;
      d.costs.push(d.test.cost);
      d.test = null;
    }
    this.#drill = null;
    let was = 0, cost = 0, worse = false;
    for (let i = 0; i < d.costs.length; i += 2) {
      was += d.costs[i];
      cost += d.costs[i + 1];
      if (d.costs[i + 1] > d.costs[i]) worse = true;
    }
    if (!worse && cost < was - PRACTICE_GAIN) {
      d.p.notes[d.key] = d.v;
      this.onNotes(d.p.bot, d.key, d.v.slice(), cost / d.seeds.length, was / d.seeds.length);
    }
    return true;
  }

  #gauss() {
    const u = Math.max(1e-9, this.#rand()), v = this.#rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  #candidate(task: Task, sign: number) {
    const w = new Float32Array(BRAIN_SIZE);
    for (let i = 0; i < BRAIN_SIZE; i++) w[i] = task.w[i] + sign * SIGMA * this.#eps![i];
    return w;
  }

  // Works until the deadline (performance.now()).
  work(deadline: number) {
    while ((this.#tasks.length || this.#practice.length || this.#polish.length) && performance.now() < deadline) {
      // Experts' runs and network tests take turns.
      if (this.#polish.length && (!this.#tasks.length || (this.#turn & 1) === 1) && !this.#trial) {
        this.#turn++;
        if (this.#polishNext(deadline) || this.#tasks.length) continue;
        return;
      }
      // Practice and network tests take turns.
      if (this.#practice.length && (this.#drill || !this.#tasks.length || (this.#turn & 1) === 1) && !this.#trial) {
        if (!this.#practise(deadline)) return;
        this.#turn++;
        continue;
      }
      const task = this.#tasks[this.#at % this.#tasks.length];
      if (!this.#trial) {
        if (this.#runs === 0) {
          this.#seeds = Array.from({ length: SEEDS }, () => Math.floor(this.#rand() * 2 ** 31));
          this.#eps = new Float32Array(BRAIN_SIZE);
          for (let i = 0; i < BRAIN_SIZE; i++) this.#eps[i] = this.#gauss();
          this.#costs = [[], [], []];
        }
        const arm = Math.floor(this.#runs / SEEDS);
        const w = arm === 0 ? task.w : this.#candidate(task, arm === 1 ? 1 : -1);
        this.#trial = new Trial(this.#c, testPersona(task.skill, this.#seeds[this.#runs % SEEDS]), w);
      }
      if (!this.#trial.step(deadline)) return;
      this.#costs[Math.floor(this.#runs / SEEDS)].push(this.#trial.cost);
      this.#trial = null;
      if (++this.#runs < 3 * SEEDS) continue;
      this.#runs = 0;
      const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
      const [cur, ...arms] = this.#costs;
      const was = sum(cur);
      let pick = -1, best = was * (1 - MIN_GAIN);
      arms.forEach((a, i) => {
        if (sum(a) < best && a.every((v, j) => v <= cur[j])) {
          best = sum(a);
          pick = i;
        }
      });
      if (pick >= 0) {
        task.w = this.#candidate(task, pick === 0 ? 1 : -1);
        this.onBetter(task, best, was);
      }
      this.#gen++;
      this.#at++;
      this.#turn++;
    }
  }

  get generations() {
    return this.#gen;
  }

  dispose() {
    this.#trial?.dispose();
    this.#trial = null;
    this.#drill?.drill.dispose();
    this.#drill?.test?.dispose();
    this.#drill = null;
  }
}
