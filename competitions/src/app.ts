// One page's view of a cup: follows the game's multiplayer connection, talks to the organizer,
// and runs the local car, the spectator camera and live timing. The organizer's page also runs
// the Organizer (host.ts).
import { CupChat } from './chat.ts';
import { Driver } from './driver.ts';
import type { Bridge, Connection, Game, GameInfo, LobbyPlayer, Native } from './game.ts';
import { site } from './game.ts';
import { Organizer } from './host.ts';
import { LiveTiming } from './live.ts';
import { Net } from './net.ts';
import { VERSION, type Msg } from './protocol.ts';
import type { Rules } from './rules.ts';
import { Spectate } from './spectate.ts';
import { byPid, LIVE_PHASES, player, roundDone, type CupState, type RoundResult } from './state.ts';

export interface HostPlan {
  name: string;
  format: string;
  rules: Rules;
  role: 'racer' | 'spectator';
  chatSecret: string;
}
export interface Note {
  id: number;
  text: string;
  tone: 'good' | 'bad' | 'info';
  at: number;
}

const HELLO_MS = 2000;
const CLOCK_MS = 60_000;
const PACE_DRIVING = 200;
const PACE_IDLE = 1000;

function identityKey(code: string) {
  const name = 'nsws-sc-key:' + code;
  try {
    let key = localStorage.getItem(name);
    if (!key || !/^[0-9a-f]{32}$/.test(key)) {
      key = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem(name, key);
      const all = Object.keys(localStorage).filter((k) => k.startsWith('nsws-sc-key:') && k !== name);
      for (const old of all.slice(0, Math.max(0, all.length - 10))) localStorage.removeItem(old);
    }
    return key;
  } catch {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  }
}

export class App {
  bridge: Bridge;
  native: Native;
  game: Game | null = null;
  info: GameInfo | null = null;
  connection: Connection | null = null;
  isHost = false;
  lobby: LobbyPlayer[] = [];
  selfPid: number | null = null;
  state: CupState | null = null;
  history: RoundResult[] = [];
  me: number | null = null;
  org: Organizer | null = null;
  code: string | null = null;
  chatSecret: string | null = null;
  chatTyping = false;
  split: { cp: number; total: number; place: number; gap: number | null; at: number } | null = null;
  panelOpen = false;
  notes: Note[] = [];
  error = '';
  revision = 0;
  net: Net;
  live = new LiveTiming();
  driver: Driver;
  watch: Spectate;
  chat: CupChat;
  onChange: () => void = () => {};
  onLeave: (message: string) => void = () => {};

  #plan: HostPlan | null = null;
  #intent: 'racer' | 'spectator' = 'racer';
  #offset = 0;
  #rtt = Infinity;
  #clockAt = 0;
  #clockOkAt = 0;
  #cupId = '';
  #clockBurst = 0;
  #helloAt = 0;
  #readySent: number | null = null;
  #noteId = 0;
  #lobbyAt = 0;
  #changeQueued = false;
  #lastSeq = -1;

  constructor() {
    const bridge = site.__nswsCup;
    if (!bridge) throw new Error('The game is still loading.');
    this.bridge = bridge;
    this.native = bridge.native();
    this.net = new Net(
      (from, m) => this.#receive(from, m),
      () => this.changed(),
    );
    this.driver = new Driver(this);
    this.watch = new Spectate(this);
    this.chat = new CupChat({
      context: () => (this.state && this.me != null ? { cupId: this.state.id, host: this.isHost } : null),
      changed: () => this.changed(),
    });
    this.native.onFrame((g, dt) => {
      try {
        this.#frame(g, dt);
      } catch (error) {
        this.fail(error);
      }
    });
    this.native.guard((g) => this.driver.blocks(g));
    this.native.guardRestart((g) => this.driver.blocksRestart(g));
    for (const C of [this.native.Host, this.native.Client]) {
      const dispose = C.prototype.dispose;
      const app = this;
      C.prototype.dispose = function (this: Connection) {
        if (app.connection === this) app.#closed();
        return dispose.call(this);
      };
    }
    const tick = () => {
      try {
        this.#tick();
      } catch (error) {
        this.fail(error);
      }
    };
    if (site.__nswsTicker) site.__nswsTicker.every(100, tick);
    else setInterval(tick, 100);
  }

  // ---- Lifecycle ----

  planHost(plan: HostPlan) {
    this.#plan = plan;
    this.chatSecret = plan.chatSecret;
  }

  planJoin(code: string, role: 'racer' | 'spectator') {
    this.#plan = null;
    this.#intent = role;
    this.code = code;
    this.chatSecret = null;
  }

  get inCup() {
    return !!this.connection;
  }

  now() {
    return Date.now() + (this.isHost ? 0 : this.#offset);
  }

  changed() {
    this.revision++;
    if (this.#changeQueued) return;
    this.#changeQueued = true;
    queueMicrotask(() => {
      this.#changeQueued = false;
      this.onChange();
    });
  }

  notify(text: string, tone: Note['tone'] = 'info') {
    this.notes.push({ id: ++this.#noteId, text, tone, at: Date.now() });
    if (this.notes.length > 6) this.notes.shift();
    this.changed();
  }

  #failAt = 0;
  fail(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const repeat = message === this.error && Date.now() - this.#failAt < 5000;
    this.#failAt = Date.now();
    this.error = message;
    if (repeat) return;
    console.error('[Cuppa]', error);
    this.notify(message, 'bad');
  }

  refreshInfo() {
    if (this.game) this.info = this.native.read(this.game);
  }

  #reset() {
    this.net.dispose();
    this.live.attach(null);
    this.state = null;
    this.history = [];
    this.me = null;
    this.org = null;
    this.isHost = false;
    this.#offset = 0;
    this.#rtt = Infinity;
    this.#clockAt = 0;
    this.#clockOkAt = 0;
    this.#clockBurst = 0;
    this.#helloAt = 0;
    this.#readySent = null;
    this.#lastSeq = -1;
    this.driver.runs = [];
    site.__nswsMuxPace = undefined;
  }

  #closed() {
    this.#reset();
    this.connection = null;
    this.game = null;
    this.info = null;
    this.code = null;
    this.changed();
  }

  #adopt(connection: Connection) {
    this.#reset();
    this.connection = connection;
    this.isHost = connection instanceof this.native.Host;
    this.live.attach(connection);
    this.lobby = connection.getPlayers();
    this.selfPid = this.lobby.find((p) => p.isSelf)?.id ?? null;
    if (this.isHost) {
      const plan = this.#plan ?? {
        name: 'Cup',
        format: 'quickplay',
        rules: undefined as unknown as Rules,
        role: 'racer' as const,
        chatSecret: '',
      };
      this.org = new Organizer(this, plan);
      this.state = this.org.state;
      this.history = this.org.history;
      this.me = this.org.me;
      this.#plan = null;
    }
    this.changed();
  }

  // ---- Every frame of the race session ----

  #frame(g: Game, dt: number) {
    const info = this.native.read(g);
    if (!info.connection || info.disposed) return;
    if (info.connection !== this.connection) this.#adopt(info.connection);
    this.game = g;
    this.info = info;
    const s = this.state;
    if (!s) return;
    this.live.setSession(info.sessionId ?? null);
    if (this.selfPid != null) {
      const own = info.car.getCarState();
      this.live.local(this.selfPid, own && this.driver.offset ? { ...own, frames: own.frames + this.driver.offset } : own);
    }
    if (s.id !== this.#cupId) {
      this.#cupId = s.id;
      this.driver.runs = [];
    }
    if (!this.watch.active) this.driver.rememberView(g);
    this.driver.frame(g);
    this.watch.frame(g, dt);
    const r = s.round;
    const live = !!r && LIVE_PHASES.includes(s.phase) || s.phase === 'checking';
    const onRound = live && r!.session === info.sessionId;
    if (onRound) {
      const pids = r!.racers.map((u) => player(s, u)?.pid).filter((id): id is number => id != null);
      let shown = pids;
      if (this.watch.ghostsHidden && !s.rules.collisions) shown = pids.filter((id) => id === this.selfPid || (this.watch.active && id === this.watch.target));
      this.native.visibility(g, shown, this.selfPid);
    } else this.native.visibility(g, null, this.selfPid);
    // Between rounds the cup draws its own cards, so the game's finish banner and hints stay hidden too.
    const covered = ['loading', 'checking', 'results', 'vote', 'podium'].includes(s.phase);
    this.native.presentation(g, true, this.watch.active || covered);
    const crashing = s.rules.collisions && s.phase === 'racing' && this.driver.racing && !this.driver.done;
    this.native.collisions(
      g,
      crashing
        ? r!.racers
            .filter((u) => u !== this.me && !roundDone(s, u))
            .map((u) => player(s, u)?.pid)
            .filter((id): id is number => id != null)
        : null,
    );
    this.native.leaderboardUploads(g, s.rules.uploads && !s.rules.collisions);
  }

  // ---- Ten times a second ----

  #tick() {
    const c = this.connection;
    if (!c) return;
    const now = performance.now();
    if (now - this.#lobbyAt > 250) {
      this.#lobbyAt = now;
      this.lobby = c.getPlayers();
      this.selfPid = this.lobby.find((p) => p.isSelf)?.id ?? null;
      if (this.isHost) this.code = c.getInvite?.()?.inviteCode ?? this.code;
    }
    // A player whose connection died for good leaves the game's list (and the cup) at once.
    if (this.isHost) this.native.pruneClosedPeers(c);
    this.net.sync(this.native, c);
    this.chat.tick();
    if (this.org) this.org.tick(Date.now());
    else this.#clientTick();
    this.#bumps();
    this.#pace();
  }

  #clientTick() {
    const now = Date.now();
    if (!this.net.open(0)) return;
    if (this.me == null && now - this.#helloAt > HELLO_MS && this.code) {
      this.#helloAt = now;
      this.net.send(0, { k: 'hi', v: VERSION, key: identityKey(this.code), role: this.#intent }, true);
    }
    if (this.me != null && (this.#clockBurst < 4 || now - this.#clockAt > CLOCK_MS) && now - this.#clockAt > 400) {
      this.#clockAt = now;
      this.#clockBurst++;
      this.net.send(0, { k: 't0', a: now }, true);
    }
    const s = this.state,
      info = this.info;
    if (s?.round?.session != null && info && !info.disposed && info.sessionId === s.round.session && this.#readySent !== s.round.session) {
      if (this.net.send(0, { k: 'rdy', s: s.round.session }, true)) this.#readySent = s.round.session;
    }
  }

  #bumps() {
    const s = this.state,
      g = this.game;
    if (!s || !g || !s.rules.collisions || s.phase !== 'racing') return;
    for (const hit of this.native.bumps(g)) this.report({ k: 'bump', n: s.round!.n, to: hit.id, i: hit.impulse }, false);
  }

  // Each incoming WebSocket message costs Cloudflare, so a page that isn't driving sends in bigger batches.
  #pace() {
    const s = this.state,
      car = this.info?.car;
    const moving = !!car && car.hasStarted() && !car.hasFinished() && !!this.game && !this.driver.blocks(this.game);
    // The organizer relays everyone else's car, so it keeps the fast pace while any car moves.
    const hostLive = this.isHost && !!s && performance.now() - this.live.movedAt < 1500;
    site.__nswsMuxPace = moving || hostLive ? PACE_DRIVING : PACE_IDLE;
  }

  // To the organizer (or straight into the Organizer on its own page).
  report(m: Msg, urgent = true) {
    if (this.org) {
      if (this.selfPid != null) this.org.receive(this.selfPid, m);
      return;
    }
    this.net.send(0, m, urgent);
  }

  #receive(from: number, m: Msg) {
    if (this.org) {
      this.org.receive(from, m);
      return;
    }
    if (from !== 0) return;
    switch (m.k) {
      case 'you':
        if (Number.isSafeInteger(m.u)) this.me = m.u;
        this.changed();
        return;
      case 'st':
        if (!m.s || typeof m.s !== 'object' || m.s.v !== 1) return;
        if (this.state && this.state.id !== m.s.id) this.history = [];
        if (m.s.seq < this.#lastSeq && this.state?.id === m.s.id) return;
        this.#lastSeq = m.s.seq;
        this.#apply(m.s);
        return;
      case 'hist':
        if (!Array.isArray(m.rows) || !Number.isSafeInteger(m.from)) return;
        this.history = [...this.history.slice(0, m.from), ...m.rows].slice(-200);
        this.changed();
        return;
      case 't1': {
        const now = Date.now();
        const rtt = now - m.a;
        if (rtt >= 0 && rtt < 10000 && (rtt <= this.#rtt * 1.5 || now - this.#clockOkAt > CLOCK_MS * 3)) {
          this.#rtt = now - this.#clockOkAt > CLOCK_MS * 3 ? rtt : Math.min(rtt, this.#rtt);
          this.#clockOkAt = now;
          this.#offset = m.h + rtt / 2 - now;
        }
        return;
      }
      case 'note':
        if (typeof m.text === 'string') this.notify(m.text.slice(0, 200), m.tone ?? 'info');
        return;
      case 'bump':
        if (this.game && Array.isArray(m.i) && m.n === this.state?.round?.n) this.native.bump(this.game, m.i);
        return;
      case 'bye':
        this.onLeave(typeof m.why === 'string' ? m.why.slice(0, 200) : 'You left the cup.');
        return;
    }
  }

  #apply(next: CupState) {
    const prev = this.state;
    this.state = next;
    if (prev?.round && next.round && (prev.round.n !== next.round.n || prev.round.try !== next.round.try)) this.live.clear();
    if (prev && prev.phase !== next.phase && next.phase === 'countdown') this.watch.target = null;
    this.changed();
  }

  // ---- For the UI ----

  keyNames() {
    const k = site.__nswsCupKeys;
    const name = (code: string | undefined) => (code ? (k?.format(code) ?? code) : '?');
    return { chat: name(k?.chat()), panel: name(k?.scoreboard()), prev: name(k?.spectatePrevious()), next: name(k?.spectateNext()) };
  }

  get self() {
    return this.state ? player(this.state, this.me) : undefined;
  }

  playerByPid(pid: number | null) {
    return this.state ? byPid(this.state, pid) : undefined;
  }

  act(m: Msg) {
    if (this.org) return this.report(m);
    if (!this.net.send(0, m, true)) this.notify('Not connected to the organizer right now', 'bad');
  }

  ping(pid: number | null) {
    if (pid == null || !this.connection) return null;
    const ping = this.connection.getPing(pid);
    return typeof ping === 'number' && Number.isFinite(ping) ? Math.round(ping) : null;
  }

  // The best placed of this page's own finishes, for "Clip my best run".
  bestRun() {
    const runs = this.driver.runs;
    let best: (typeof runs)[number] | null = null;
    let bestPlace = Infinity;
    for (const run of runs) {
      const row = this.history.find((h) => h.n === run.n && !h.void)?.rows.find((r) => r[0] === this.me);
      const place = row?.[2] ?? Infinity;
      if (place < bestPlace || (place === bestPlace && best && run.frames < best.frames)) {
        best = run;
        bestPlace = place;
      }
    }
    return best;
  }

  async saveBestRun() {
    const run = this.bestRun();
    if (!run || !this.game) throw new Error('There is no run to save yet.');
    return this.native.saveClip({
      recording: run.recording,
      frames: run.attemptFrames,
      trackId: run.trackId,
      carStyle: this.native.carStyle(this.game),
      nickname: this.self?.name ?? 'Racer',
      name: `${this.state?.name ?? 'Cup'} · ${run.track}`.slice(0, 60),
    });
  }
}
