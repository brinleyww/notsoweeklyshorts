// The organizer page's bot planners: a few Web Workers built from the game's own simulation worker
// plan every bot's run ahead of the race clock. Their keyframe chunks go to every page (pages never
// simulate bots), and each result is handed to the cup only once the race clock reaches it.
import type { BoardRun, Native, TrackData } from '../game.ts';
import type { Msg } from '../protocol.ts';
import { MAX_BOTS } from '../rules.ts';
import type { TrackRef } from '../state.ts';
import { toB64 } from './codec.ts';
import { EXPERT_SKILL, WORKER_NAME, type FromWorker, type Persona, type RefInput, type ToWorker } from './wire.ts';
import { BASE_BRAIN, brainFromB64, brainGroup, brainToB64, freshBrain } from './worker/brain.ts';
import { FIELDS, notesFromB64, notesToB64 } from './worker/notes.ts';

export type BotsMsg = Extract<Msg, { k: 'bots' }>;
export interface Due {
  u: number;
  finish?: number;
  dnf?: true;
  runFinish?: number;
}
export interface BotJob {
  bots: Persona[];
  mode: 'run' | 'ta';
  // Bot frame where the round stops.
  end: number;
}
export interface BotHost {
  native: Native;
  // The organizer page's own copy of each chunk (still deflated), for drawing the bots there.
  local(n: number, g: number, u: number, seq: number, data: Uint8Array): void;
  // Something the organizer should know (bots can't run on this page or track).
  note(text: string): void;
}

// Committed frames every bot should have ahead of the race clock at GO.
export const LEAD = 6000;
const READY_TIMEOUT_MS = 10_000;
const HAND_MS = 500;
const REFS_KEY = 'nsws-cuppa-refs:';
const REFS_TTL = 24 * 3600_000;
const REFS_EMPTY_TTL = 3600_000;
const REFS_KEEP = 24;
const REFS_WAIT_MS = 8000;
const MSG_CHARS = 48_000;
// What the bots have learned, per track: each skill group's best network weights (worker/learn.ts).
const BRAIN_KEY = 'nsws-cuppa-brain:';
const BRAIN_KEEP = 40;
// Each expert's notes on each track (worker/notes.ts), by bot name and hint run.
const NOTES_KEY = 'nsws-cuppa-notes:';
const NOTES_KEEP = 24;
const NOTES_PER_TRACK = 32;
// Workers go when the organizer stops ticking (the cup is gone) or nothing was planned for a while.
const ORPHAN_MS = 15_000;
const IDLE_MS = 120_000;

interface Slot {
  w: Worker;
  ready: boolean;
  dead: boolean;
  queue: ToWorker[];
  jobs: number;
  key: string | null;
}

type Result = Extract<FromWorker, { b: 'result' }>;

interface Bot {
  u: number;
  id: string;
  persona: Persona;
  slot: Slot | null;
  frontier: number;
  rate: number;
  chunks: string[];
  raw: (Uint8Array | null)[];
  handed: number;
  result: Result | null;
  // The job is over: a final result, an error, a lost worker or a retirement.
  over: boolean;
  failed: boolean;
  // Per GO: readiness checked, everything reported, time attack runs reported.
  checked: boolean;
  closed: boolean;
  runs: number;
}

interface Plan {
  n: number;
  g: number;
  trackId: string;
  key: string | null;
  bad: boolean;
  mode: 'run' | 'ta';
  end: number;
  startAt: number | null;
  endFrame: number;
  bots: Map<number, Bot>;
  first: boolean;
}

// Learning takes a core of its own, so only where there are cores to spare.
function canLearn() {
  const cores = navigator.hardwareConcurrency || 4;
  const memory = (navigator as { deviceMemory?: number }).deviceMemory;
  return cores >= 6 && (memory == null || memory >= 8);
}

const base = BASE_BRAIN ? brainFromB64(BASE_BRAIN) : null;

function poolSize() {
  const cores = navigator.hardwareConcurrency || 4;
  const memory = (navigator as { deviceMemory?: number }).deviceMemory;
  if (cores <= 4 || (memory != null && memory < 8)) return 1;
  return cores >= 12 ? 3 : 2;
}

export class BotManager {
  #slots: Slot[] = [];
  #failed = false;
  #plan: Plan | null = null;
  #byId = new Map<string, Bot>();
  #g = 0;
  #handAt = 0;
  #tickAt = Date.now();
  #usedAt = Date.now();
  #watch: ReturnType<typeof setInterval> | null = null;
  #track: { trackId: string; key: string; best: number; bad: boolean; msg: ToWorker } | null = null;
  #keys = 0;
  #jobs = 0;
  #refs = new Map<string, Promise<RefInput[]>>();
  // The learning worker (besides the planners) and the track key and groups it was given.
  #learner: Slot | null = null;
  #learnSig = '';
  #brains = new Map<string, Map<string, { w: Float32Array; cost: number }>>();
  #notes = new Map<string, Map<string, Float32Array>>();

  constructor(private host: BotHost) {}

  // Bots can't plan on this page (no workers, or a game without the bot hooks).
  get failed() {
    return this.#failed;
  }

  // Bots can't drive the round being planned: failed workers or a track the planner can't read.
  get broken() {
    return this.#failed || !!this.#plan?.bad;
  }

  // Starts fetching a track's reference runs before it is needed.
  prefetch(trackId: string, custom: boolean) {
    void this.#boardRefs(trackId, custom);
  }

  // Plans round n. Called again for the same round and track it only starts jobs for bots added
  // since and cancels those removed; with no bots it ends the plan.
  prepare(n: number, track: TrackRef, trackData: TrackData, cupRuns: RefInput[], job: BotJob) {
    this.#usedAt = Date.now();
    if (!job.bots.length) {
      this.#close();
      this.#plan = null;
      return;
    }
    if (!this.#start()) return;
    const cur = this.#plan;
    if (cur && cur.n === n && cur.trackId === track.id) {
      cur.mode = job.mode;
      cur.end = job.end;
      this.#reconcile(cur, job.bots);
      this.#learn(cur);
      return;
    }
    this.#close();
    const plan: Plan = { n, g: ++this.#g, trackId: track.id, key: null, bad: false, mode: job.mode, end: job.end, startAt: null, endFrame: job.end, bots: new Map(), first: false };
    this.#plan = plan;
    this.#post({ b: 'clock', startAt: null, offset: 0 });
    this.#reconcile(plan, job.bots);
    const custom = track.cat === 'custom';
    const board = this.#boardRefs(track.id, custom);
    const wait = new Promise<RefInput[]>((resolve) => setTimeout(() => resolve([]), REFS_WAIT_MS));
    Promise.race([board, wait])
      .then((refs) => {
        if (this.#plan !== plan) return;
        this.#loadTrack(plan, trackData, [...refs, ...cupRuns]);
        for (const b of plan.bots.values()) if (!b.slot && !b.over) this.#assign(plan, b);
        this.#learn(plan);
      })
      .catch((error) => {
        console.warn('[Cuppa] bot planning', error);
        if (this.#plan === plan) this.#fail(plan, "Bots can't drive this track");
      });
  }

  // GO for round n (again, after a restart: the same plans replay).
  go(n: number, startAt: number, endFrame: number, ta: boolean) {
    const plan = this.#plan;
    if (!plan || plan.n !== n) return;
    plan.startAt = startAt;
    plan.endFrame = endFrame;
    plan.mode = ta ? 'ta' : 'run';
    for (const b of plan.bots.values()) {
      b.checked = false;
      b.closed = false;
      b.runs = 0;
    }
    this.#post({ b: 'clock', startAt, offset: 0 });
  }

  // Whether round n's plan still drives bot u (a lost plan means its bots can't finish).
  drives(n: number, u: number) {
    const plan = this.#plan;
    return !!plan && plan.n === n && plan.bots.has(u);
  }

  // Milliseconds until every bot has LEAD of its run planned; Infinity while that can't be told yet.
  readyIn() {
    const plan = this.#plan;
    if (!plan || this.broken) return 0;
    let worst = 0;
    for (const b of plan.bots.values()) {
      if (b.over || b.frontier >= LEAD) continue;
      if (!(b.rate > 0)) return Infinity;
      worst = Math.max(worst, (LEAD - b.frontier) / b.rate);
    }
    return Math.ceil(worst);
  }

  // Results whose moment has come on the cup clock (never early).
  due(now: number): Due[] {
    const plan = this.#plan;
    const out: Due[] = [];
    if (!plan || plan.startAt == null || now < plan.startAt) return out;
    const t = now - plan.startAt;
    const ta = plan.mode === 'ta';
    for (const b of plan.bots.values()) {
      if (b.closed) continue;
      // A bot that can't be planned at all (its worker failed) sits the try out. One planned too little
      // ahead at GO still races: it is drawn from where its plan has got to, and its result stands.
      if (!b.checked) {
        b.checked = true;
        if (b.failed && b.result == null && b.frontier < 2000) {
          b.closed = true;
          out.push({ u: b.u, dnf: true });
          continue;
        }
      }
      const res = b.result;
      if (ta && res)
        for (; b.runs < res.runs.length; b.runs++) {
          const [start, finish] = res.runs[b.runs];
          if (finish == null) {
            // The run still being driven may finish in a later report.
            if (b.runs === res.runs.length - 1 && !b.over) break;
            continue;
          }
          if (finish > t || finish > plan.endFrame) break;
          out.push({ u: b.u, runFinish: finish - start });
        }
      if (!ta && res?.finish != null) {
        if (res.finish <= t) {
          b.closed = true;
          out.push({ u: b.u, finish: res.finish });
        }
        continue;
      }
      if (res?.dnf != null) {
        if (res.dnf <= t) {
          b.closed = true;
          out.push({ u: b.u, dnf: true });
        }
        continue;
      }
      if (b.over) {
        // Ended without a finish or a give-up frame: it stops where its plan does.
        if ((!ta || b.failed) && b.frontier <= t) {
          b.closed = true;
          out.push({ u: b.u, dnf: true });
        }
        continue;
      }
    }
    return out;
  }

  // Called every organizer tick. Chunks for round n that are due to go out (every HAND_MS, at
  // once for a bot's first one), as messages for every page; the organizer's own page gets them here.
  take(now: number, n: number | undefined): BotsMsg[] | null {
    this.#tickAt = now;
    const plan = this.#plan;
    if (!plan || plan.n !== n || (!plan.first && now - this.#handAt < HAND_MS)) return null;
    this.#handAt = now;
    plan.first = false;
    const c: [number, number, string][] = [];
    for (const b of plan.bots.values()) {
      for (let seq = b.handed; seq < b.chunks.length; seq++) {
        c.push([b.u, seq, b.chunks[seq]]);
        const raw = b.raw[seq];
        b.raw[seq] = null;
        if (raw) this.host.local(plan.n, plan.g, b.u, seq, raw);
      }
      b.handed = b.chunks.length;
    }
    return c.length ? this.#pack(plan, c) : null;
  }

  // Everything already sent for round n, for a page that joins or comes back.
  chunksFor(n: number): BotsMsg[] {
    const plan = this.#plan;
    if (!plan || plan.n !== n) return [];
    const c: [number, number, string][] = [];
    for (const b of plan.bots.values()) for (let seq = 0; seq < b.handed; seq++) c.push([b.u, seq, b.chunks[seq]]);
    return c.length ? this.#pack(plan, c) : [];
  }

  // Forgets every plan (the cup ended or starts over). The workers stay for a while.
  drop() {
    this.#close();
    this.#plan = null;
    if (this.#track) this.#post({ b: 'drop', key: this.#track.key });
    this.#track = null;
    for (const s of this.#slots) s.key = null;
  }

  #pack(plan: Plan, c: [number, number, string][]): BotsMsg[] {
    const out: BotsMsg[] = [];
    let cur: [number, number, string][] = [];
    let size = 0;
    for (const entry of c) {
      if (cur.length && size + entry[2].length > MSG_CHARS) {
        out.push({ k: 'bots', n: plan.n, g: plan.g, c: cur });
        cur = [];
        size = 0;
      }
      cur.push(entry);
      size += entry[2].length + 16;
    }
    if (cur.length) out.push({ k: 'bots', n: plan.n, g: plan.g, c: cur });
    return out;
  }

  // ---- Jobs ----

  #reconcile(plan: Plan, bots: Persona[]) {
    const want = new Set(bots.map((p) => p.u));
    for (const b of [...plan.bots.values()])
      if (!want.has(b.u)) {
        this.#cancel(b);
        plan.bots.delete(b.u);
        this.#byId.delete(b.id);
      }
    for (const persona of bots) {
      let b = plan.bots.get(persona.u);
      if (!b) {
        b = { u: persona.u, id: `${plan.g}.${persona.u}.${++this.#jobs}`, persona, slot: null, frontier: 0, rate: 0, chunks: [], raw: [], handed: 0, result: null, over: false, failed: false, checked: false, closed: false, runs: 0 };
        plan.bots.set(b.u, b);
        this.#byId.set(b.id, b);
        if (plan.bad || this.#failed) b.over = b.failed = true;
      }
      if (!b.slot && !b.over && plan.key) this.#assign(plan, b);
    }
  }

  #assign(plan: Plan, b: Bot) {
    this.#grow(plan.bots.size);
    const live = this.#slots.filter((s) => !s.dead);
    if (!live.length) return this.#fail(plan, "Bots couldn't start on this page");
    const slot = live.reduce((a, s) => (s.jobs < a.jobs ? s : a));
    if (slot.key !== plan.key) {
      if (this.#track?.key !== plan.key) return;
      slot.key = plan.key;
      this.#send(slot, this.#track.msg);
    }
    b.slot = slot;
    slot.jobs++;
    const notes = b.persona.skill >= EXPERT_SKILL ? this.#notesFor(plan.trackId, b.persona) : null;
    const drill = b.persona.skill >= EXPERT_SKILL && b.persona.copy === 0;
    this.#send(slot, { b: 'job', id: b.id, key: plan.key!, bot: b.persona, mode: plan.mode, end: plan.end, brain: this.#brainFor(plan.trackId, b.persona.skill), notes, drill });
  }

  #cancel(b: Bot) {
    if (b.slot && !b.over) {
      this.#send(b.slot, { b: 'cancel', id: b.id });
      b.slot.jobs = Math.max(0, b.slot.jobs - 1);
    }
    b.over = true;
  }

  #finish(b: Bot) {
    if (b.over) return;
    b.over = true;
    if (b.slot) b.slot.jobs = Math.max(0, b.slot.jobs - 1);
  }

  #close() {
    const plan = this.#plan;
    if (!plan) return;
    for (const b of plan.bots.values()) this.#cancel(b);
    this.#byId.clear();
  }

  #fail(plan: Plan, why: string) {
    if (!plan.bad) this.host.note(`${why}, so they sit out.`);
    plan.bad = true;
    for (const b of plan.bots.values())
      if (!b.over) {
        this.#cancel(b);
        b.failed = true;
      }
  }

  // ---- Track and reference runs ----

  #loadTrack(plan: Plan, trackData: TrackData, refs: RefInput[]) {
    const seen = new Set<string>();
    refs = refs.filter((r) => !seen.has(r.recording) && seen.add(r.recording));
    const best = Math.min(...refs.map((r) => r.frames));
    const t = this.#track;
    // Same track: the workers keep it, unless the cup has since made a faster run to follow.
    if (t && t.trackId === plan.trackId && !(best < t.best)) {
      plan.key = t.key;
      if (t.bad) this.#fail(plan, "Bots can't drive this track");
      return;
    }
    const payload = this.host.native.trackPayload?.(trackData);
    if (!payload) return this.#fail(plan, "Bots can't drive this track");
    if (t) this.#post({ b: 'drop', key: t.key });
    const key = `${plan.trackId}:${++this.#keys}`;
    const msg: ToWorker = { b: 'track', key, trackId: plan.trackId, payload, refs };
    this.#track = { trackId: plan.trackId, key, best, bad: false, msg };
    plan.key = key;
    this.#grow(plan.bots.size);
    for (const s of this.#slots) {
      if (s.dead) continue;
      s.key = key;
      this.#send(s, msg);
    }
  }

  #boardRefs(trackId: string, custom: boolean) {
    let p = this.#refs.get(trackId);
    if (!p) {
      p = this.#fetchRefs(trackId, custom).catch(() => []);
      this.#refs.set(trackId, p);
    }
    return p.then((board) => {
      const pb = this.host.native.personalBestRun?.(trackId);
      return pb ? [...board, { id: 'pb', kind: 'pb' as const, recording: pb.recording, frames: pb.frames }] : board;
    });
  }

  async #fetchRefs(trackId: string, custom: boolean): Promise<RefInput[]> {
    // The top runs: each expert bot replays its own one (up to MAX_BOTS of them).
    const toRefs = (runs: BoardRun[]) => {
      return [...runs]
        .sort((a, b) => a.rank - b.rank)
        .slice(0, MAX_BOTS)
        .filter((r): r is BoardRun => !!r && typeof r.recording === 'string' && r.frames > 0)
        .map((r): RefInput => ({ id: `board:${r.rank}`, kind: r.rank === 1 ? 'wr' : 'board', rank: r.rank, recording: r.recording, frames: r.frames }));
    };
    if (custom || !this.host.native.boardRuns) return [];
    const now = Date.now();
    try {
      const cached = JSON.parse(localStorage.getItem(REFS_KEY + trackId) ?? 'null') as { at: number; runs: BoardRun[] } | null;
      if (cached && Array.isArray(cached.runs) && now - cached.at < (cached.runs.length ? REFS_TTL : REFS_EMPTY_TTL)) return toRefs(cached.runs);
    } catch {}
    const runs = await this.host.native.boardRuns(trackId, 10);
    try {
      const old = Object.keys(localStorage)
        .filter((k) => k.startsWith(REFS_KEY) && k !== REFS_KEY + trackId)
        .map((k) => [k, Number(JSON.parse(localStorage.getItem(k) ?? '{}')?.at) || 0] as const)
        .sort((a, b) => b[1] - a[1]);
      for (const [k] of old.slice(REFS_KEEP - 1)) localStorage.removeItem(k);
      localStorage.setItem(REFS_KEY + trackId, JSON.stringify({ at: now, runs }));
    } catch {}
    return toRefs(runs);
  }

  // ---- Learning ----

  #brainsOf(trackId: string) {
    let m = this.#brains.get(trackId);
    if (!m) {
      m = new Map();
      try {
        const saved = JSON.parse(localStorage.getItem(BRAIN_KEY + trackId) ?? 'null') as { g?: Record<string, { w: string; c: number }> } | null;
        for (const [k, v] of Object.entries(saved?.g ?? {})) {
          const w = typeof v?.w === 'string' ? brainFromB64(v.w) : null;
          if (w && Number.isFinite(v.c)) m.set(k, { w, cost: v.c });
        }
      } catch {}
      this.#brains.set(trackId, m);
    }
    return m;
  }

  #brainFor(trackId: string, skill: number) {
    const g = brainGroup(skill);
    return g ? (this.#brainsOf(trackId).get(g.key)?.w ?? base) : null;
  }

  #saveBrains(trackId: string) {
    const g: Record<string, { w: string; c: number }> = {};
    for (const [k, v] of this.#brainsOf(trackId)) g[k] = { w: brainToB64(v.w), c: v.cost };
    try {
      const old = Object.keys(localStorage)
        .filter((k) => k.startsWith(BRAIN_KEY) && k !== BRAIN_KEY + trackId)
        .map((k) => [k, Number(JSON.parse(localStorage.getItem(k) ?? '{}')?.at) || 0] as const)
        .sort((a, b) => b[1] - a[1]);
      for (const [k] of old.slice(BRAIN_KEEP - 1)) localStorage.removeItem(k);
      localStorage.setItem(BRAIN_KEY + trackId, JSON.stringify({ at: Date.now(), g }));
    } catch {}
  }

  #notesOf(trackId: string) {
    let m = this.#notes.get(trackId);
    if (!m) {
      m = new Map();
      try {
        const saved = JSON.parse(localStorage.getItem(NOTES_KEY + trackId) ?? 'null') as { b?: Record<string, string> } | null;
        for (const [k, v] of Object.entries(saved?.b ?? {})) {
          const w = typeof v === 'string' ? notesFromB64(v) : null;
          if (w) m.set(k, w);
        }
      } catch {}
      this.#notes.set(trackId, m);
    }
    return m;
  }

  // An expert's notes on this track, by hint run.
  #notesFor(trackId: string, p: Persona) {
    const prefix = `${p.name ?? p.u}|`, out: Record<string, Float32Array> = {};
    for (const [k, v] of this.#notesOf(trackId)) if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v.slice();
    return out;
  }

  #saveNotes(trackId: string) {
    const m = this.#notesOf(trackId);
    // The oldest go first (a Map keeps the order they were last changed in).
    for (const k of [...m.keys()].slice(0, Math.max(0, m.size - NOTES_PER_TRACK))) m.delete(k);
    const b: Record<string, string> = {};
    for (const [k, v] of m) b[k] = notesToB64(v);
    try {
      const old = Object.keys(localStorage)
        .filter((k) => k.startsWith(NOTES_KEY) && k !== NOTES_KEY + trackId)
        .map((k) => [k, Number(JSON.parse(localStorage.getItem(k) ?? '{}')?.at) || 0] as const)
        .sort((a, b) => b[1] - a[1]);
      for (const [k] of old.slice(NOTES_KEEP - 1)) localStorage.removeItem(k);
      localStorage.setItem(NOTES_KEY + trackId, JSON.stringify({ at: Date.now(), b }));
    } catch {}
  }

  // An expert's notes got better in practice: keep them, and its next run drives them.
  #noted(m: Extract<FromWorker, { b: 'notes' }>) {
    const t = this.#track;
    if (!t || t.key !== m.key || !(m.v instanceof Float32Array) || !m.v.length || m.v.length % FIELDS) return;
    const store = this.#notesOf(t.trackId), key = `${m.name}|${m.ref}`;
    store.delete(key);
    store.set(key, m.v.slice());
    this.#saveNotes(t.trackId);
    for (const s of this.#slots) if (!s.dead && s.key === t.key) this.#send(s, { b: 'notes', key: m.key, name: m.name, ref: m.ref, v: m.v });
  }

  // Keeps the learning worker improving the weights of every skill group racing on this track, and
  // driving practice runs for its experts.
  #learn(plan: Plan) {
    const t = this.#track;
    if (this.#failed || !canLearn() || !t || t.bad || plan.key !== t.key) return;
    const groups = new Map<string, number>();
    const experts: Persona[] = [];
    for (const b of plan.bots.values()) {
      const g = brainGroup(b.persona.skill);
      if (g) groups.set(g.key, g.skill);
      if (b.persona.skill >= EXPERT_SKILL) experts.push(b.persona);
    }
    const sig = t.key + ':' + [...groups.keys()].sort().join('') + ':' + experts.map((p) => `${p.name ?? p.u}/${p.copy}`).sort().join(',');
    if ((!groups.size && !experts.length) || sig === this.#learnSig) return;
    this.#learnSig = sig;
    if (!this.#learner || this.#learner.dead) this.#learner = this.#spawn(false);
    const slot = this.#learner;
    if (!slot) return;
    if (slot.key !== t.key) {
      slot.key = t.key;
      this.#send(slot, t.msg);
    }
    const saved = this.#brainsOf(plan.trackId);
    const tasks = [...groups].map(([key, skill], i) => ({ key, skill, w: (saved.get(key)?.w ?? base ?? freshBrain(i + 1)).slice() }));
    const practice = experts.map((bot) => ({ bot, notes: this.#notesFor(plan.trackId, bot) }));
    this.#send(slot, { b: 'learn', key: t.key, tasks, practice });
  }

  #learned(m: Extract<FromWorker, { b: 'learned' }>) {
    const t = this.#track;
    if (!t || t.key !== m.key) return;
    this.#brainsOf(t.trackId).set(m.task, { w: m.w, cost: m.cost });
    this.#saveBrains(t.trackId);
    // A time attack's bots drive their next runs with it.
    const plan = this.#plan;
    if (plan?.trackId === t.trackId && plan.mode === 'ta')
      for (const b of plan.bots.values()) if (!b.over && b.slot && brainGroup(b.persona.skill)?.key === m.task) this.#send(b.slot, { b: 'brain', id: b.id, w: m.w });
  }

  // ---- Workers ----

  #start() {
    if (this.#failed) return false;
    if (!this.host.native.physicsInit || !this.host.native.trackPayload) {
      this.#failed = true;
      this.host.note("Bots need a newer version of the game page. Reload it to race them");
      return false;
    }
    this.#watch ??= setInterval(() => this.#watchdog(), 5000);
    return true;
  }

  #grow(bots: number) {
    const live = this.#slots.filter((s) => !s.dead);
    const want = Math.min(poolSize(), Math.max(1, bots));
    for (let i = live.length; i < want; i++) this.#spawn();
  }

  // A planner worker, or (pool false) the learning worker, which plans no bots.
  #spawn(pool = true): Slot | null {
    let w: Worker;
    try {
      w = new Worker('simulation_worker.bundle.js', { name: WORKER_NAME });
    } catch (error) {
      console.warn('[Cuppa] bot worker', error);
      if (pool) this.#lost(null);
      return null;
    }
    const slot: Slot = { w, ready: false, dead: false, queue: [], jobs: 0, key: null };
    if (pool) this.#slots.push(slot);
    w.onmessage = (e: MessageEvent<FromWorker>) => this.#receive(slot, e.data);
    w.onerror = (e) => {
      e.preventDefault();
      console.warn('[Cuppa] bot worker', e.message);
      this.#lost(slot);
    };
    setTimeout(() => !slot.ready && !slot.dead && this.#lost(slot), READY_TIMEOUT_MS);
    return slot;
  }

  #send(slot: Slot, m: ToWorker) {
    if (slot.dead) return;
    if (slot.ready) slot.w.postMessage(m);
    else slot.queue.push(m);
  }

  #post(m: ToWorker) {
    for (const s of this.#slots) this.#send(s, m);
  }

  #init(slot: Slot, tries = 0) {
    if (slot.dead) return;
    const init = this.host.native.physicsInit?.();
    // The game builds it once its parts have loaded.
    if (!init) {
      if (tries < 20) setTimeout(() => this.#init(slot, tries + 1), 500);
      else this.#lost(slot);
      return;
    }
    slot.ready = true;
    slot.w.postMessage({ b: 'init', init } satisfies ToWorker);
    for (const m of slot.queue.splice(0)) slot.w.postMessage(m);
  }

  #lost(slot: Slot | null) {
    if (slot && slot === this.#learner) {
      slot.dead = true;
      slot.w.terminate();
      this.#learner = null;
      this.#learnSig = '';
      return;
    }
    if (slot) {
      if (slot.dead) return;
      slot.dead = true;
      slot.w.terminate();
      const plan = this.#plan;
      if (plan)
        for (const b of plan.bots.values())
          if (b.slot === slot && !b.over) {
            b.over = true;
            b.failed = true;
          }
    }
    if (this.#slots.some((s) => !s.dead)) return;
    this.#failed = true;
    if (this.#plan) this.#fail(this.#plan, "Bots couldn't start on this page");
    else this.host.note("Bots couldn't start on this page, so they sit out.");
  }

  #receive(slot: Slot, m: FromWorker) {
    if (!m || typeof m !== 'object') return;
    if (m.b === 'ready') return this.#init(slot);
    if (m.b === 'learned') return this.#learned(m);
    if (m.b === 'notes') return this.#noted(m);
    if (m.b === 'track') {
      if (m.ok) return;
      if (this.#track?.key === m.key) this.#track.bad = true;
      const plan = this.#plan;
      if (plan?.key === m.key) this.#fail(plan, "Bots can't drive this track");
      return;
    }
    if (m.b === 'error') {
      console.warn('[Cuppa] bot planner:', m.message);
      const b = m.id != null ? this.#byId.get(m.id) : undefined;
      if (b && !b.over) {
        this.#finish(b);
        b.failed = true;
      }
      return;
    }
    const b = this.#byId.get(m.id);
    if (!b) return;
    if (m.b === 'chunk') {
      if (m.seq !== b.chunks.length || !(m.data instanceof Uint8Array)) return;
      b.chunks.push(toB64(m.data));
      b.raw.push(m.data);
      b.frontier = Math.max(b.frontier, m.to);
      if (m.seq === 0 && this.#plan) this.#plan.first = true;
    } else if (m.b === 'progress') {
      b.frontier = Math.max(b.frontier, m.frontier);
      b.rate = m.rate;
    } else if (m.b === 'result') {
      b.result = m;
      b.frontier = Math.max(b.frontier, m.frontier);
      const plan = this.#plan;
      // A time attack reports its runs as it goes; it is over once it gives up or reaches the end.
      if (plan?.mode !== 'ta' || m.dnf != null || m.frontier >= plan.end) this.#finish(b);
    }
  }

  #watchdog() {
    const now = Date.now();
    const orphan = now - this.#tickAt > ORPHAN_MS;
    if (!orphan && (this.#plan || now - this.#usedAt < IDLE_MS)) return;
    if (orphan) {
      this.#close();
      this.#plan = null;
    }
    this.#track = null;
    for (const s of this.#slots) {
      s.dead = true;
      s.w.terminate();
    }
    this.#slots = [];
    if (this.#learner) this.#lost(this.#learner);
    if (this.#watch) clearInterval(this.#watch);
    this.#watch = null;
  }
}
