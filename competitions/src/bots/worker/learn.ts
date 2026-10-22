// How the bots' network learns (brain.ts): evolution strategies on the game's own physics. A test drives
// one bot's whole run through the planner (with its retries, respawns and restarts) and costs what a
// viewer would see: the finish time, and a little more for every wreck the bot had to live with. A change
// to the weights is kept only if it costs less than the current weights on the same test, so learning
// never makes a bot worse on what it was tested on. Used offline in the lab and online during a cup.
import type { Persona } from '../wire.ts';
import { BRAIN_SIZE } from './brain.ts';
import type { Clearance } from './clearance.ts';
import { Planner, type Job } from './planner.ts';
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

  constructor(c: Course, skill: number, seed: number, w: Float32Array | null) {
    this.#planner = new Planner(c.sim, c.route, c.refs, 3, c.clear, c.full);
    this.#end = c.refs[0].n * 3 + 20000;
    this.#job = this.#planner.add({ id: 'test', bot: testPersona(skill, seed), mode: 'run', end: this.#end, brain: w });
  }

  // Plans until the deadline (performance.now()) or the end of the run; true once it has ended.
  step(deadline: number) {
    if (this.done) return true;
    while (performance.now() < deadline) {
      if (this.#planner.tick()) continue;
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
  onBetter: (task: Task, cost: number, was: number) => void = () => {};

  constructor(c: Course, tasks: Task[], seed: number) {
    this.#c = c;
    this.#tasks = tasks;
    this.#rand = rng(seed);
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
    while (this.#tasks.length && performance.now() < deadline) {
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
        this.#trial = new Trial(this.#c, task.skill, this.#seeds[this.#runs % SEEDS], w);
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
    }
  }

  get generations() {
    return this.#gen;
  }

  dispose() {
    this.#trial?.dispose();
    this.#trial = null;
  }
}
