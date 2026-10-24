// Bots on every page, the organizer's included. Their keyframes come in {k:'bots'} chunks (the organizer's
// page hands its own over directly) and each car is drawn at exactly cupNow - startAt on the race clock,
// never ahead of the keyframes it has.
import type { CarState, Game, Native } from '../game.ts';
import type { LiveTiming } from '../live.ts';
import type { Msg } from '../protocol.ts';
import { MAX_BOTS } from '../rules.ts';
import { botPid, player, type CupState, type Round } from '../state.ts';
import { decodeChunk, fromB64, inflate, type Keyframe } from './codec.ts';
import { BotTimeline } from './timeline.ts';

const MAX_ROUNDS = 3;
const MAX_CHUNKS = 8000;
const MAX_CHUNK_CHARS = 200_000;
// A bot whose keyframes ended (finished, or none yet for this moment) stays this long, then leaves the track.
const HOLD_MS = 1500;
// Clock corrections ease in at up to 5% of real time; bigger ones jump.
const SLEW = 0.05;
const SNAP_MS = 250;
// With no frames drawn for this long (a hidden tab), live timing is kept from the tick instead.
const STALE_MS = 500;
const GAP_MS = 1000;

interface Bot {
  u: number;
  pid: number;
  style: string;
  nickname: string;
}
// From bot frame f0 on, race time = the car's own frames + c (c changes when the bot starts its run again).
interface Run {
  f0: number;
  c: number;
}
interface Track {
  // Deflated chunks by seq, and how many of them are in tl.
  data: (Uint8Array | undefined)[];
  decoded: number;
  epoch: number;
  busy: boolean;
  tl: BotTimeline;
  runs: Run[];
  cutNext: boolean;
  sampled: boolean;
  // Respawns, restarts and jumps drawn so far (another car's collision step passes through across one).
  cuts: number;
}
interface Plan {
  g: number;
  bots: Map<number, Track>;
}

const NONE: Bot[] = [];

const newTrack = (): Track => ({ data: [], decoded: 0, epoch: 0, busy: false, tl: new BotTimeline(), runs: [], cutNext: false, sampled: false, cuts: 0 });
// Keyframes after now a bumper cup's hit list gets for each bot.
const HIT_KEYS = 3;

export class BotView {
  // This page's car can hit bots (a bumper cup round it is racing in).
  bumper = false;
  #plans = new Map<number, Plan>();
  #floor = -Infinity;
  #cup = '';
  #sig = '';
  #list: Bot[] = NONE;
  #ta = false;
  #dnf = new Set<number>();
  #over = new Set<number>();
  #runKey = '';
  #plan: Plan | null = null;
  #carsGame: Game | null = null;
  #carsFor: Bot[] | null = null;
  #cars = new Map<number, string>();
  // pid -> the frame it was last drawn on.
  #drawn = new Map<number, number>();
  #last = new Map<number, CarState>();
  #frameNo = 0;
  #frameAt = -Infinity;
  #base: number | null = null;
  #perfAt = 0;

  constructor(
    private native: Native,
    private live: LiveTiming,
  ) {}

  reset() {
    this.#clearPlans();
    this.#cup = '';
    this.#sig = '';
    this.#list = NONE;
    this.#dnf.clear();
    this.#over.clear();
    this.#runKey = '';
    this.#plan = null;
    this.#carsFor = null;
    this.#drawn.clear();
    this.#last.clear();
    this.#base = null;
  }

  #clearPlans() {
    for (const plan of this.#plans.values()) this.#dropPlan(plan);
    this.#plans.clear();
    this.#floor = -Infinity;
  }

  #dropPlan(plan: Plan) {
    for (const t of plan.bots.values()) t.epoch++;
  }

  receive(m: Msg) {
    if (m.k !== 'bots' || !Array.isArray(m.c)) return;
    for (const e of m.c) {
      if (!Array.isArray(e) || typeof e[2] !== 'string' || e[2].length > MAX_CHUNK_CHARS) continue;
      let bytes: Uint8Array;
      try {
        bytes = fromB64(e[2]);
      } catch {
        continue;
      }
      this.local(m.n, m.g, e[0], e[1], bytes);
    }
  }

  // One deflated chunk: bot u's chunk seq of plan generation g for round n.
  local(n: number, g: number, u: number, seq: number, bytes: Uint8Array) {
    if (![n, g, u, seq].every(Number.isSafeInteger) || seq < 0 || seq >= MAX_CHUNKS || n < this.#floor || !(bytes instanceof Uint8Array)) return;
    let plan = this.#plans.get(n);
    if (plan && g < plan.g) return;
    if (!plan || g > plan.g) {
      if (plan) this.#dropPlan(plan);
      plan = { g, bots: new Map() };
      this.#plans.set(n, plan);
      while (this.#plans.size > MAX_ROUNDS) {
        const oldest = Math.min(...this.#plans.keys());
        this.#dropPlan(this.#plans.get(oldest)!);
        this.#plans.delete(oldest);
      }
      if (!this.#plans.has(n)) return;
    }
    let track = plan.bots.get(u);
    if (!track) {
      if (plan.bots.size >= 2 * MAX_BOTS) return;
      plan.bots.set(u, (track = newTrack()));
    }
    if (track.data[seq]) return;
    track.data[seq] = bytes;
    void this.#pump(track);
  }

  // Chunks go into the timeline in seq order; inflating is async, so one decoder per bot at a time.
  async #pump(track: Track) {
    if (track.busy) return;
    track.busy = true;
    const epoch = track.epoch;
    try {
      while (track.epoch === epoch) {
        const bytes = track.data[track.decoded];
        if (!bytes) break;
        let frames: Keyframe[] | null;
        try {
          frames = decodeChunk(await inflate(bytes));
        } catch {
          frames = null;
        }
        if (track.epoch !== epoch) return;
        track.decoded++;
        // A chunk that can't be read leaves a hole: the car holds before it and jumps after it.
        if (!frames) {
          track.cutNext = true;
          continue;
        }
        if (!frames.length) continue;
        if (track.cutNext) {
          frames[0] = { ...frames[0], cut: true };
          track.cutNext = false;
        }
        for (const k of frames) {
          if (!k.hasStarted) continue;
          const c = k.f - k.frames,
            last = track.runs[track.runs.length - 1];
          if (!last || Math.abs(c - last.c) > 1) track.runs.push({ f0: k.f, c });
        }
        track.tl.push(frames);
      }
    } finally {
      if (track.epoch === epoch) track.busy = false;
    }
  }

  // The same plan from the start again (the round was restarted).
  #rewind(track: Track) {
    track.epoch++;
    track.busy = false;
    track.decoded = 0;
    track.tl = new BotTimeline();
    track.runs = [];
    track.cutNext = false;
    track.sampled = false;
    void this.#pump(track);
  }

  sync(s: CupState | null) {
    if (!s) return;
    if (s.id !== this.#cup) {
      if (this.#cup) this.reset();
      this.#cup = s.id;
    }
    const r = s.round;
    const sig = `${s.seq}|${s.phase}|${s.players.length}|${r ? `${r.n}.${r.try}.${r.racers.length}.${r.dnf.length}` : ''}`;
    if (sig === this.#sig) return;
    this.#sig = sig;
    if (r && r.n > this.#floor) {
      this.#floor = r.n;
      for (const [n, plan] of this.#plans)
        if (n < r.n) {
          this.#dropPlan(plan);
          this.#plans.delete(n);
        }
    }
    this.#ta = s.rules.style === 'timeattack';
    const list: Bot[] = [];
    this.#dnf.clear();
    this.#over.clear();
    if (r && s.phase !== 'lobby' && s.phase !== 'draft')
      for (const u of r.racers) {
        const p = player(s, u);
        if (!p?.bot) continue;
        list.push({ u, pid: p.pid ?? botPid(u), style: p.bot.cs, nickname: p.name });
        if (r.dnf.includes(u)) this.#dnf.add(u);
        if (r.dnf.includes(u) || (!this.#ta && u in r.runs)) this.#over.add(u);
      }
    const same = list.length === this.#list.length && list.every((b, i) => {
      const o = this.#list[i];
      return b.u === o.u && b.pid === o.pid && b.style === o.style && b.nickname === o.nickname;
    });
    if (!same) this.#list = list.length ? list : NONE;
  }

  // Whether the game shows this bot's car now (it has a place to be drawn at).
  shows(pid: number) {
    return this.#drawn.get(pid) === this.#frameNo;
  }

  // Once a frame, just before the game moves and draws the other cars. `round` is null unless this
  // page's race session is that round's; `show` is false while the cup covers the race.
  frame(g: Game, round: Round | null, cupNow: number, show: boolean) {
    this.#syncCars(g, round ? this.#list : NONE);
    const perf = performance.now();
    // After a long gap (a hidden tab, a stall) the cars jump rather than draw one long skid.
    const jump = perf - this.#frameAt > GAP_MS;
    this.#frameNo++;
    this.#frameAt = perf;
    this.#step(round, cupNow, g, show, jump);
  }

  // Ten times a second: live timing for a page that draws no frames (a hidden tab).
  tick(round: Round | null, cupNow: number) {
    if (performance.now() - this.#frameAt < STALE_MS) return;
    this.#step(round, cupNow, null, false, false);
  }

  #step(round: Round | null, cupNow: number, g: Game | null, show: boolean, jump: boolean) {
    if (!round || round.startAt == null) return;
    const plan = this.#plans.get(round.n) ?? null;
    const key = `${round.n}.${round.try}`;
    if (key !== this.#runKey || plan !== this.#plan) {
      if (plan && key !== this.#runKey) for (const t of plan.bots.values()) if (t.sampled) this.#rewind(t);
      for (const b of this.#list) {
        this.live.forget(b.pid);
        this.#drawn.delete(b.pid);
      }
      this.#runKey = key;
      this.#plan = plan;
    }
    const t = this.#clock(cupNow) - round.startAt;
    const lerp = this.native.lerpCarState;
    for (const b of this.#list) {
      const track = plan?.bots.get(b.u);
      const tl = track?.tl;
      if (!track || !tl || tl.end === -Infinity) continue;
      track.sampled = true;
      if (this.#over.has(b.u) && !tl.done) tl.markDone();
      for (const ev of tl.events(t)) this.live.bot(b.pid, this.#raceTime(track, ev, t));
      const at = tl.sample(t, lerp);
      if (!at) continue;
      if (at.reset) track.cuts++;
      this.live.bot(b.pid, this.#raceTime(track, at.state, t));
      if (!g) continue;
      const was = this.#drawn.get(b.pid);
      if (!show || this.#dnf.has(b.u) || t > tl.end + (this.#over.has(b.u) ? 0 : HOLD_MS)) {
        // Leaving the track: one last still state, so a hidden car doesn't keep its engine running.
        const last = this.#last.get(b.pid);
        if (was === this.#frameNo - 1 && last)
          this.native.botState?.(g, b.pid, { ...last, speedKmh: 0, wheelDeltaRotation: [0, 0, 0, 0], wheelSkidInfo: [0, 0, 0, 0], collisionImpulses: [], brakeLightEnabled: false, controls: { up: false, right: false, down: false, left: false, reset: false } }, false);
        this.native.botKeys?.(g, b.pid, b.pid, null, 0);
        continue;
      }
      if (!this.native.botState || !this.#cars.has(b.pid)) continue;
      this.native.botState(g, b.pid, at.state, at.reset || jump || was !== this.#frameNo - 1);
      if (this.bumper && at.state.hasStarted && at.state.finishFrames == null) {
        const p = at.state.position, q = at.state.quaternion;
        this.native.botKeys?.(g, b.pid, b.pid, tl.next(t, HIT_KEYS, [{ f: Math.round(t), p: [p.x, p.y, p.z], q: [q.x, q.y, q.z, q.w] }]), track.cuts);
      } else this.native.botKeys?.(g, b.pid, b.pid, null, 0);
      this.#drawn.set(b.pid, this.#frameNo);
      this.#last.set(b.pid, at.state);
    }
  }

  // The race clock, eased so a clock sync never makes a bot jump.
  #clock(cupNow: number) {
    const perf = performance.now();
    const want = cupNow - perf;
    if (this.#base == null || Math.abs(want - this.#base) > SNAP_MS) this.#base = want;
    else {
      const most = Math.max(0, perf - this.#perfAt) * SLEW;
      this.#base += Math.max(-most, Math.min(most, want - this.#base));
    }
    this.#perfAt = perf;
    return perf + this.#base;
  }

  // Live timing counts one-run rounds on the race clock, like the local car with its offset; time
  // attack runs on their own clock.
  #raceTime(track: Track, st: CarState, t: number): CarState {
    if (this.#ta || !st.hasStarted || !track.runs.length) return st;
    let c = track.runs[0].c;
    for (let i = track.runs.length - 1; i >= 0; i--) {
      const run = track.runs[i],
        f = st.frames + run.c;
      if (f >= run.f0 - 2 && f <= t + 2) {
        c = run.c;
        break;
      }
    }
    return c === 0 ? st : { ...st, frames: st.frames + c, finishFrames: st.finishFrames == null ? null : st.finishFrames + c };
  }

  // The game's bot cars for this session follow the list, one new car a frame (each builds its own textures).
  #syncCars(g: Game, want: Bot[]) {
    if (g !== this.#carsGame) {
      this.#carsGame = g;
      this.#cars.clear();
      this.#carsFor = null;
    }
    if (this.#carsFor === want && this.#cars.size === want.length) return;
    const next: Bot[] = [];
    let changed = false,
      added = false;
    for (const b of want) {
      const was = this.#cars.get(b.pid);
      if (was == null) {
        if (added) continue;
        added = changed = true;
        this.#drawn.delete(b.pid);
      } else if (was !== b.style + '\n' + b.nickname) changed = true;
      next.push(b);
    }
    if (changed || next.length !== this.#cars.size) {
      this.native.bots?.(g, next.map((b) => ({ id: b.pid, style: b.style, nickname: b.nickname })));
      this.#cars = new Map(next.map((b) => [b.pid, b.style + '\n' + b.nickname]));
    }
    if (next.length === want.length) this.#carsFor = want;
  }
}
