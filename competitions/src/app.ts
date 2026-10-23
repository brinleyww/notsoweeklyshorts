// One page's view of a cup: follows the game's multiplayer connection, talks to the organizer,
// and runs the local car, the spectator camera and live timing. The organizer's page also runs
// the Organizer (host.ts).
import { BotView } from './bots/view.ts';
import { CupChat } from './chat.ts';
import { Driver } from './driver.ts';
import type { Bridge, Connection, Game, GameInfo, LobbyPlayer, Native } from './game.ts';
import { background, site } from './game.ts';
import { Organizer } from './host.ts';
import { LiveTiming } from './live.ts';
import { Net } from './net.ts';
import { drawCars, ghostBehind, installSmoothing, nudgeCar } from './smooth.ts';
import { VERSION, type Msg } from './protocol.ts';
import type { Rules } from './rules.ts';
import { Spectate } from './spectate.ts';
import { byPid, isBot, LIVE_PHASES, player, roundDone, type CupState, type RoundResult } from './state.ts';

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
const CLOCK_MS = 30_000;
const PACE_DRIVING = 200;
// Bumper cars draw other cars with the game's own playback (smooth.ts), and go twice as often so it can sit closer to live.
const PACE_BUMPER = 100;
const PACE_IDLE = 1000;
const REJOIN_KEY = 'nsws-sc-rejoin';
const COVERED = ['loading', 'checking', 'results', 'vote', 'podium'];
const REJOIN_SAVE_MS = 20_000;

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
  split: { cp: number; total: number; place: number; gap: number | null; at: number } | null = null;
  panelOpen = false;
  #watchWant: number | null = null;
  #watchSince = 0;
  #watchSentAt = 0;
  notes: Note[] = [];
  error = '';
  revision = 0;
  net: Net;
  live = new LiveTiming();
  // Bot cars and their live timing; the organizer's bot planner hands its chunks to bots.receive().
  bots: BotView;
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
  #lastPing: number | null = null;
  #cupId = '';
  #clockBurst = 0;
  #helloAt = 0;
  #readySent: number | null = null;
  #noteId = 0;
  #lobbyAt = 0;
  #changeQueued = false;
  #lastSeq = -1;
  #savedAt = 0;
  #pageHiding = false;

  constructor() {
    const bridge = site.__nswsCup;
    if (!bridge) throw new Error('The game is still loading.');
    this.bridge = bridge;
    this.native = bridge.native();
    installSmoothing(this.native);
    this.bots = new BotView(this.native, this.live);
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
    this.native.onCars?.((g, dt) => {
      try {
        this.#cars(g, dt);
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
    window.addEventListener('pagehide', () => (this.#pageHiding = true));
    window.addEventListener('pageshow', () => (this.#pageHiding = false));
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
    this.bots.reset();
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
    this.#savedAt = 0;
    this.driver.runs = [];
    site.__nswsMuxPace = undefined;
    site.__nswsMuxQuiet = false;
    site.__nswsMuxCarsUnseen = false;
    site.__nswsMuxCar = undefined;
    site.__nswsCarClocks?.clear();
    site.__nswsFanIds?.clear();
    site.__nswsCupDirect = undefined;
    this.#carStart = null;
  }

  #closed() {
    // Leaving on purpose; a closing tab keeps the record so the menu can offer to rejoin.
    if (!this.#pageHiding)
      try {
        localStorage.removeItem(REJOIN_KEY);
      } catch {}
    this.#reset();
    this.connection = null;
    this.game = null;
    this.info = null;
    this.code = null;
    this.chat.tick();
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
      this.#noteCarClock(own);
    }
    if (!this.native.onCars) this.#cars(g, dt);
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
    // Between rounds the cup draws its own cards, so the game's finish banner and hints stay hidden
    // too, and so do other cars: their states only go out now and then meanwhile (transport.js).
    const covered = COVERED.includes(s.phase);
    if (covered) this.native.visibility(g, this.selfPid == null ? [] : [this.selfPid], this.selfPid);
    else if (onRound) {
      const pids: number[] = [];
      for (const u of r!.racers) {
        const p = player(s, u);
        if (p?.pid != null && (!p.bot || this.bots.shows(p.pid))) pids.push(p.pid);
      }
      let shown = pids;
      if (this.watch.ghostsHidden && !s.rules.collisions) shown = pids.filter((id) => id === this.selfPid || (this.watch.active && id === this.watch.target));
      this.native.visibility(g, shown, this.selfPid);
    } else this.native.visibility(g, null, this.selfPid);
    this.native.presentation(g, true, this.watch.active || covered);
    const crashing = s.rules.collisions && s.phase === 'racing' && this.driver.racing && !this.driver.done;
    this.native.collisions(
      g,
      crashing
        ? r!.racers
            .filter((u) => u !== this.me && !roundDone(s, u) && !isBot(player(s, u)))
            .map((u) => player(s, u)?.pid)
            .filter((id): id is number => id != null)
        : null,
    );
    this.native.leaderboardUploads(g, s.rules.uploads && !s.rules.collisions);
  }

  // Just before the game moves and draws the other cars, so the spectator camera and the car it
  // follows show the same state.
  #cars(g: Game, dt: number) {
    const s = this.state,
      info = this.info;
    if (!s || !info || this.game !== g || info.disposed) return;
    const now = performance.now();
    const clocks = site.__nswsCarClocks;
    const clock = { offset: this.now() - now, startOf: (id: number) => clocks?.get(id) ?? this.playerByPid(id)?.clk ?? undefined };
    drawCars(info.connection, info.sessionId, (id) => this.native.remoteCar(g, id), now, dt * 1000, s.rules.collisions, clock);
    this.bots.sync(s);
    this.bots.frame(g, this.#botRound(s, info), this.now(), !COVERED.includes(s.phase));
    this.#bumps();
  }

  // The round whose bots this page draws: only on that round's own race session.
  #botRound(s: CupState, info: GameInfo) {
    const r = s.round;
    return r && r.session === info.sessionId && s.phase !== 'lobby' && s.phase !== 'draft' ? r : null;
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
    this.#fanIds(c);
    if (this.isHost) this.#relayDirect(c);
    this.chat.tick();
    if (this.org) this.org.tick(Date.now());
    else this.#clientTick();
    const s = this.state,
      info = this.info;
    if (s && info && !info.disposed) {
      this.bots.sync(s);
      this.bots.tick(this.#botRound(s, info), this.now());
    }
    this.#watchSync();
    this.#bumps();
    this.#pace();
    this.#remember();
  }

  // The game's relay (main.bundle.js) skips a racer's states for a page the room already passes them
  // to straight (transport.js) and that can tell whose they are (Organizer.knowsLink).
  #relayDirect(c: Connection) {
    const pcs = new Map<number, { link?: number; _carDirect?: boolean; _peerFan?: boolean }>();
    for (const { id, pc } of this.native.peers(c)) pcs.set(id, pc as never);
    const org = this.org;
    site.__nswsCupDirect = (from, to) => {
      const sender = pcs.get(from);
      return !!sender?._carDirect && !!sender.link && !!pcs.get(to)?._peerFan && !!org?.knowsLink(to, from, sender.link, Date.now());
    };
  }

  // Whose relay link is whose, for car states that come straight from other racers (transport.js):
  // the organizer's page knows its own links, everyone else takes them from the organizer.
  #fanIds(c: Connection) {
    const ids = (site.__nswsFanIds ??= new Map());
    ids.clear();
    if (this.isHost) {
      for (const { id, pc } of this.native.peers(c)) {
        const link = (pc as unknown as { link?: number }).link;
        if (link) ids.set(link, id);
      }
      this.org?.links(ids);
    } else for (const p of this.state?.players ?? []) if (p.lk && p.pid != null) ids.set(p.lk, p.pid);
  }

  // When this page's car started on the cup clock: stamped on its states (transport.js), and in the
  // cup state for the organizer's own car, so other pages can draw it where it is now (smooth.ts).
  #carStart: number | null = null;
  #noteCarClock(own: { hasStarted: boolean; frames: number } | null) {
    if (!own?.hasStarted) this.#carStart = null;
    else {
      const start = this.now() - own.frames;
      if (this.#carStart == null || Math.abs(start - this.#carStart) > 50) this.#carStart = start;
      else this.#carStart += (start - this.#carStart) * 0.05;
    }
    site.__nswsMuxCar = { start: this.#carStart ?? NaN };
    this.org?.carClock(this.#carStart);
  }

  // For mod/nsws_cup_rejoin.js, which offers the cup again if the tab closes by accident.
  #remember() {
    const s = this.state,
      me = this.self;
    if (this.isHost || !s || !me || !this.code) return;
    const now = Date.now();
    if (now - this.#savedAt < REJOIN_SAVE_MS) return;
    this.#savedAt = now;
    try {
      if (s.phase === 'podium') localStorage.removeItem(REJOIN_KEY);
      else localStorage.setItem(REJOIN_KEY, JSON.stringify({ code: this.code, role: me.role, name: s.name, at: now }));
    } catch {}
  }

  #clientTick() {
    const now = Date.now();
    if (!this.net.open(0)) return;
    if (this.me == null && now - this.#helloAt > HELLO_MS && this.code) {
      this.#helloAt = now;
      this.net.send(0, { k: 'hi', v: VERSION, key: identityKey(this.code), role: this.#intent }, true);
    }
    if (this.me != null && (this.#clockBurst < 4 || (now - this.#clockAt > CLOCK_MS && !site.__nswsMuxQuiet)) && now - this.#clockAt > 400) {
      this.#clockAt = now;
      this.#clockBurst++;
      this.net.send(0, this.#lastPing == null ? { k: 't0', a: now } : { k: 't0', a: now, rtt: this.#lastPing }, true);
    }
    const s = this.state,
      info = this.info;
    if (s?.round?.session != null && info && !info.disposed && info.sessionId === s.round.session && this.#readySent !== s.round.session) {
      if (this.net.send(0, { k: 'rdy', s: s.round.session }, true)) this.#readySent = s.round.session;
    }
  }

  // Tells the organizer whose car this page's camera follows, for that racer's "watching" count.
  // Sent once the choice has held for a moment, so the director's cuts don't each cost a message.
  #watchSync() {
    const me = this.self;
    if (!me || site.__nswsMuxQuiet) return;
    const w = this.watch;
    const pid = w.active && w.mode !== 'free' ? w.target : null;
    const want = pid == null ? null : (this.playerByPid(pid)?.u ?? null);
    const now = performance.now();
    if (want !== this.#watchWant) {
      this.#watchWant = want;
      this.#watchSince = now;
    }
    if ((me.watch ?? null) === want || now - this.#watchSince < 800 || now - this.#watchSentAt < 2000) return;
    this.#watchSentAt = now;
    this.report({ k: 'act', a: 'watch', v: want }, false);
  }

  // Typing in one of the layer's text boxes holds the car (keys go to the box, not the game).
  get chatTyping() {
    const host = document.activeElement;
    if (host?.id !== 'nsws-cuppa') return false;
    const el = host.shadowRoot?.activeElement;
    return el instanceof HTMLInputElement && el.type === 'text' && el.getClientRects().length > 0;
  }

  #bumps() {
    const s = this.state,
      g = this.game;
    if (!s || !g || !s.rules.collisions || s.phase !== 'racing') return;
    for (const hit of this.native.bumps(g)) {
      this.report({ k: 'bump', n: s.round!.n, to: hit.id, i: hit.impulse }, false);
      // The other car is pushed here at once; its own states show the push only after a round trip.
      if (hit.impulse.length === 3 && hit.impulse.every(Number.isFinite)) nudgeCar(this.info?.connection, hit.id, hit.impulse as [number, number, number]);
    }
  }

  // Each incoming WebSocket message costs Cloudflare, so a page that isn't driving sends in bigger batches.
  #pace() {
    const s = this.state,
      car = this.info?.car;
    const moving = !!car && car.hasStarted() && !car.hasFinished() && !!this.game && !this.driver.blocks(this.game);
    // Racers switch before GO, so their first moments aren't sent at the slow pace.
    const racing = this.driver.racing && !this.driver.done && (s?.phase === 'countdown' || s?.phase === 'racing');
    // The organizer relays everyone else's car, so it keeps the fast pace while any car moves or a round runs.
    const hostLive = this.isHost && !!s && (performance.now() - this.live.movedAt < 1500 || s.phase === 'countdown' || s.phase === 'racing');
    site.__nswsMuxPace = moving || racing || hostLive ? (s?.rules.collisions ? PACE_BUMPER : PACE_DRIVING) : PACE_IDLE;
    // The organizer keeps everyone's cup running, and a racer in a round keeps racing.
    site.__nswsMuxQuiet = !this.isHost && !moving && !racing && background();
    site.__nswsMuxCarsUnseen = !!s && COVERED.includes(s.phase);
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
        if (rtt >= 0 && rtt < 10000) this.#lastPing = rtt;
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
      case 'bots':
        this.bots.receive(m);
        return;
      case 'bye':
        this.onLeave(typeof m.why === 'string' ? m.why.slice(0, 200) : 'You left the cup.');
        return;
    }
  }

  #apply(next: CupState) {
    const prev = this.state;
    this.state = next;
    // At once, not on the next frame: bot chunks sent after a new cup's first state belong to that cup.
    this.bots.sync(next);
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

  // How far behind where that racer really is now their car is drawn here (ms), or null.
  ghostBehind(pid: number) {
    return ghostBehind(this.info?.connection, pid, performance.now());
  }

  act(m: Msg) {
    if (this.org) return this.report(m);
    if (!this.net.send(0, m, true)) this.notify('Not connected to the organizer right now', 'bad');
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
