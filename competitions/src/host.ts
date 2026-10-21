// The organizer's side of a cup: the authoritative state, the round clock, track loading and
// the replay checks. Everyone else only sees the state it broadcasts.
import type { App } from './app.ts';
import { BotManager } from './bots/manager.ts';
import { BOT_NAMES, botStyle, matchStep, nameOrder, personas, seedOf, tierSkills } from './bots/roster.ts';
import type { RefInput } from './bots/wire.ts';
import * as E from './engine.ts';
import type { LoadedTrack, TrackData } from './game.ts';
import { site } from './game.ts';
import type { Msg } from './protocol.ts';
import { cleanRules, MAX_RACERS, type Rules } from './rules.ts';
import { botPid, byPid, isBot, player, roundDone, standings, type CupState, type Player, type RoundResult, type TrackRef, type Category } from './state.ts';

const LOAD_WAIT_MS = 15_000;
const SESSION_RETRY_MS = 8_000;
const CHECK_WAIT_MS = 10_000;
const BROADCAST_MS = 150;
// Pings and who watches whom go out with the next real change, or after this long between rounds.
const SOFT_MS = 10_000;
// How long after a page is sent a racer's link before the game stops relaying that racer to it.
const LINK_SETTLE_MS = 1_000;
const STATUS_MS = 2_000;
const OUTAGE_GRACE_MS = 10_000;
const RECENT_TRACKS = 8;
// GO waits at most this much longer for the bots' plans.
const BOT_WAIT_MS = 15_000;
// How far a bot's run is planned in a round without a time limit.
const BOT_PLAN_MS = 600_000;
// The cup's own fastest checked runs per track, which bots may follow.
const CUP_REFS = 3;

export interface PoolTrack extends TrackRef {
  load: () => Promise<LoadedTrack>;
  thumb: Promise<string> | string;
}

interface Peer {
  key: string | null;
  hist: number;
  greeted: boolean;
  // A bot chunk didn't reach this page: it gets the whole round's chunks again.
  botsStale?: boolean;
  // Each player's link as last sent to this page, and when it was first sent.
  links?: Map<number, { link: number; at: number }>;
}

const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
const shuffle = <T>(list: T[]) => {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
};

export class Organizer {
  state: CupState;
  history: RoundResult[] = [];
  #keys = new Map<string, number>();
  #banned = new Set<string>();
  #peers = new Map<number, Peer>();
  #nextU = 1;
  #dirty = true;
  #soft = false;
  #urgent = false;
  #sentAt = 0;
  #ready = new Map<number, number>();
  #recent: string[] = [];
  #queued: TrackRef | null = null;
  #loading: { ref: TrackRef; at: number; from: number | undefined; track: LoadedTrack; sessionAt: number } | null = null;
  // Replay checks in flight, by "round.try.uid".
  #checks = new Map<string, number>();
  // A track is being fetched; the round only changes once it arrives. The epoch drops a load
  // that finishes after the cup ended or restarted.
  #pending = false;
  #epoch = 0;
  #retries = 0;
  #taBest = new Map<number, number>();
  #best = new Map<string, number>();
  #statusKey = '';
  #statusAt = 0;
  #statusInvite: unknown = null;
  #pool: PoolTrack[] = [];
  #wr = new Map<string, number | null>();
  #runHashes = new Map<string, Set<number>>();
  #visited = new Set<string>();
  #poolAt = 0;
  #bots: BotManager | null = null;
  #botNames: number[] = [];
  #botTier = '';
  #planTrack: { ref: TrackRef; data: TrackData } | null = null;
  #cupRuns = new Map<string, RefInput[]>();

  constructor(
    private app: App,
    o: { name: string; format: string; rules: Rules; role: 'racer' | 'spectator' },
  ) {
    this.state = E.createCup({ id: randomId(), name: o.name, format: o.format, rules: o.rules, now: Date.now() });
    const me = this.#addPlayer('organizer', app.selfPid, o.role);
    this.state.host = me.u;
    this.#botNames = nameOrder(seedOf(this.state.id));
    this.#syncBots();
    // The new session's id straight from the game (works in a hidden tab, where frames stop).
    app.connection?.addNewSessionCallback(null, (id) => this.#sessionStarted(id));
  }

  #sessionStarted(id: number) {
    const s = this.state,
      r = s.round;
    if (!this.#loading || s.phase !== 'loading' || !r || r.session != null) return;
    r.session = id;
    this.#loading.sessionAt = Date.now();
    this.touch(true);
  }

  #pendingChecks() {
    const r = this.state.round;
    if (!r) return false;
    const prefix = `${r.n}.${r.try}.`;
    for (const [key, n] of this.#checks) if (n > 0 && key.startsWith(prefix)) return true;
    return false;
  }

  get me() {
    return this.state.host;
  }

  touch(urgent = false) {
    this.#dirty = true;
    if (urgent) this.#urgent = true;
    this.app.changed();
  }

  links(ids: Map<number, number>) {
    for (const p of this.state.players) {
      if (p.u === this.me) continue;
      let link: number | undefined;
      for (const [l, pid] of ids) if (pid === p.pid) link = l;
      if (p.lk === link) continue;
      if (link == null) delete p.lk;
      else p.lk = link;
      this.#softTouch();
    }
  }

  // Page `to` has known `from`'s current link long enough to draw the copies the room passes it (app.ts).
  knowsLink(to: number, from: number, link: number, now: number) {
    const known = this.#peers.get(to)?.links?.get(from);
    return known?.link === link && now - known.at >= LINK_SETTLE_MS;
  }

  carClock(start: number | null) {
    const me = player(this.state, this.me);
    if (!me) return;
    if (start == null) {
      if (me.clk == null) return;
      delete me.clk;
    } else if (me.clk != null && Math.abs(me.clk - start) <= 30) return;
    else me.clk = Math.round(start);
    this.#softTouch();
  }

  #softTouch() {
    this.#soft = true;
    this.app.changed();
  }

  // ---- Players ----

  #addPlayer(key: string, pid: number | null, role: 'racer' | 'spectator') {
    const lobby = this.app.lobby.find((p) => p.id === pid);
    const p = {
      u: this.#nextU++,
      pid,
      name: lobby?.nickname ?? 'Racer',
      cc: lobby?.countryCode ?? null,
      role: role === 'racer' && E.canRace(this.state) ? 'racer' : 'spectator',
      pts: 0,
      wins: 0,
      places: [],
    } as CupState['players'][number];
    this.state.players.push(p);
    this.#keys.set(key, p.u);
    return p;
  }

  #hello(pid: number, key: string, role: 'racer' | 'spectator') {
    if (!/^[0-9a-f]{32}$/.test(key)) return;
    const peer = this.#peers.get(pid) ?? { key: null, hist: 0, greeted: false };
    this.#peers.set(pid, peer);
    if (this.#banned.has(key)) {
      this.app.net.send(pid, { k: 'bye', why: 'The organizer removed you from this cup.' }, true);
      setTimeout(() => this.app.connection?.kickPlayer?.(pid), 500);
      return;
    }
    let u = this.#keys.get(key);
    let p = player(this.state, u);
    if (p) {
      if (p.pid !== pid) {
        for (const other of this.state.players) if (other.pid === pid && other !== p) other.pid = null;
        p.pid = pid;
      }
      if (p.away) {
        delete p.away;
        this.notifyAll(`${p.name} is back`, 'info');
      }
    } else {
      p = this.#addPlayer(key, pid, role);
      u = p.u;
      this.notifyAll(`${p.name} joined ${p.role === 'racer' ? 'the grid' : 'as a spectator'}`, 'info');
      this.#syncBots();
    }
    peer.key = key;
    peer.greeted = true;
    peer.hist = 0;
    this.app.net.send(pid, { k: 'you', u: p.u });
    this.#sendTo(pid);
    this.#sendBots(pid, peer);
    this.touch();
  }

  #syncLobby(now: number) {
    const lobby = this.app.lobby;
    for (const p of this.state.players) {
      if (p.pid == null || p.bot) continue;
      const seen = lobby.find((l) => l.id === p.pid);
      if (seen) {
        if (seen.nickname && seen.nickname !== p.name && p.u !== this.me) {
          p.name = seen.nickname;
          this.touch();
        }
        continue;
      }
      this.#peers.delete(p.pid);
      p.pid = null;
      p.away = 1;
      const s = this.state;
      if (s.round && ['warmup', 'countdown', 'racing'].includes(s.phase) && s.round.racers.includes(p.u) && !roundDone(s, p.u)) E.recordDnf(s, p.u);
      this.notifyAll(`${p.name} left`, 'info');
      this.touch();
    }
    for (const pid of [...this.#peers.keys()]) if (!lobby.some((l) => l.id === pid)) this.#peers.delete(pid);
    const self = player(this.state, this.me);
    if (self && self.pid !== this.app.selfPid) self.pid = this.app.selfPid;
    void now;
  }

  // ---- Bots ----

  #manager() {
    return (this.#bots ??= new BotManager({
      native: this.app.native,
      local: (n, g, u, seq, data) => this.app.bots.local(n, g, u, seq, data),
      note: (text) => this.app.notify(text, 'bad'),
    }));
  }

  #seatedBots() {
    return this.state.players.filter((p) => p.bot && p.role === 'racer' && !p.out).sort((a, b) => a.u - b.u);
  }

  // Keeps rules.bots computer racers on the grid. Once the cup has started a bot taken off stays as a
  // benched spectator, so its results keep a name. A human can always take a bot's slot, and bumper
  // cars have no bots (a planned run can't take a shove).
  #syncBots() {
    const s = this.state;
    const lobby = s.phase === 'lobby';
    const seated = this.#seatedBots();
    let target = s.rules.collisions ? 0 : Math.max(0, Math.min(s.rules.bots, MAX_RACERS - E.humanRacers(s).length));
    // A knockout's grid is locked once it starts.
    if (!lobby && s.rules.mode === 'knockout') target = Math.min(target, seated.length);
    let changed = false;
    const fresh = new Set<Player>();
    while (seated.length > target) {
      const p = seated.pop()!;
      if (lobby) p.role = 'spectator';
      else E.setRole(s, p.u, 'spectator');
      changed = true;
    }
    for (const p of s.players)
      if (seated.length < target && p.bot && p.role !== 'racer' && !p.out) {
        p.role = 'racer';
        seated.push(p);
        changed = true;
      }
    while (seated.length < target) {
      const p = this.#newBot();
      if (!p) break;
      seated.push(p);
      fresh.add(p);
      changed = true;
    }
    if (lobby && s.players.some((p) => p.bot && p.role !== 'racer')) s.players = s.players.filter((p) => !p.bot || p.role === 'racer');
    seated.sort((a, b) => a.u - b.u);
    // Skills are spread again only when the organizer changes the tier or the count, so a bot keeps
    // its skill through knockouts. Match the field starts everyone at medium once, then they adapt.
    const tier = s.rules.botSkill;
    const sig = `${tier}:${s.rules.bots}`;
    const spread = tier === 'match' ? !this.#botTier.startsWith('match:') : sig !== this.#botTier;
    const skills = tierSkills(tier, seated.length);
    seated.forEach((p, i) => {
      if (spread || fresh.has(p)) p.bot!.s = Math.round(skills[i] * 100);
    });
    if (sig !== this.#botTier) {
      this.#botTier = sig;
      changed = true;
    }
    if (!changed) return;
    this.#botsReady();
    if (s.phase === 'draft') this.#botDraft();
    if (s.phase === 'loading' || s.phase === 'warmup') this.#planBots();
    if (s.phase === 'results') this.#prePlan();
    this.touch(true);
  }

  #newBot() {
    const s = this.state;
    const taken = new Set(s.players.filter((p) => p.bot).map((p) => p.name));
    const k = this.#botNames.find((i) => !taken.has(BOT_NAMES[i]));
    if (k == null) return null;
    const u = this.#nextU++;
    const p: Player = { u, pid: botPid(u), name: BOT_NAMES[k], cc: null, role: 'racer', pts: 0, wins: 0, places: [], bot: { s: 50, cs: botStyle(k) } };
    s.players.push(p);
    return p;
  }

  // Takes one bot off the grid, and the bot count down with it.
  removeBot(u: number) {
    const s = this.state,
      p = player(s, u);
    if (!p?.bot) return;
    if (p.role === 'racer' && !p.out) s.rules = cleanRules({ ...s.rules, bots: Math.max(0, this.#seatedBots().length - 1) });
    if (s.phase === 'lobby') s.players = s.players.filter((x) => x !== p);
    else if (p.role === 'racer') E.setRole(s, u, 'spectator');
    this.#syncBots();
    this.touch(true);
  }

  // Bots never hold up the end of a warm-up.
  #botsReady() {
    const s = this.state,
      r = s.round;
    if (s.phase !== 'warmup' || !r) return;
    for (const u of r.racers) {
      const p = player(s, u);
      if (p?.bot) p.ready = 1;
    }
  }

  // Bots ban and pick at random, straight away (a track nobody picked yet if there is one).
  #botDraft() {
    const s = this.state,
      d = s.draft;
    if (!d || s.phase !== 'draft') return;
    const quota = d.stage === 'ban' ? s.rules.bans : s.rules.picks;
    const book = d.stage === 'ban' ? d.bans : d.picks;
    for (const p of E.racers(s)) {
      if (!p.bot) continue;
      for (let tries = 0; (book[p.u]?.length ?? 0) < quota && tries < 8; tries++) {
        const taken = new Set([...Object.values(d.bans), ...Object.values(d.picks)].flat());
        const banned = new Set(Object.values(d.bans).flat());
        const free = d.opts.filter((t) => !banned.has(t.id) && !(book[p.u] ?? []).includes(t.id));
        const fresh = free.filter((t) => !taken.has(t.id));
        const from = fresh.length ? fresh : free;
        if (!from.length) break;
        E.draftChoose(s, p.u, d.stage, from[Math.floor(Math.random() * from.length)].id);
      }
    }
    this.touch();
  }

  // The bots in the current round: its racers, and before GO also those who join it then.
  #roundBots(atGo = false) {
    const s = this.state,
      r = s.round;
    if (!r) return [];
    const joining = !atGo && r.startAt == null && s.rules.lateJoin;
    return this.#seatedBots().filter((p) => r.racers.includes(p.u) || joining);
  }

  // Starts (or tops up) the plans of round n on the loaded track; with no bots it ends the running plan.
  #planBots(n = this.state.round?.n, bots = this.#roundBots()) {
    const s = this.state,
      t = this.#planTrack;
    const mgr = bots.length ? this.#manager() : this.#bots;
    if (n == null || !t || !mgr) return;
    const list = personas(s.rules.botSkill, bots.length, seedOf(`${s.id}:${n}`), bots.map((p) => p.bot!.s / 100));
    list.forEach((persona, i) => (persona.u = bots[i].u));
    mgr.prepare(n, t.ref, t.data, this.#cupRuns.get(t.ref.id) ?? [], { bots: list, mode: s.rules.style === 'timeattack' ? 'ta' : 'run', end: this.#limitMs(t.ref.id) ?? BOT_PLAN_MS });
    const r = s.round;
    if (mgr.failed && r && r.startAt == null) r.racers = r.racers.filter((u) => !isBot(player(s, u)));
  }

  // Another round on the same track: its bots plan during the results.
  #prePlan() {
    const s = this.state,
      r = s.round;
    if (s.phase !== 'results' || s.winner != null || !r || E.needsNewTrack(s) || this.#queued || this.#planTrack?.ref.id !== r.track.id) return;
    this.#planBots(s.rounds + 1, this.#seatedBots());
  }

  // GO waits a little for the bots' plans (at most BOT_WAIT_MS); bots that can't be planned at all
  // stay out of the round.
  #botsGo(now: number) {
    const s = this.state,
      r = s.round!;
    const bots = this.#roundBots(true);
    this.#planBots(r.n, bots);
    if (!bots.length) return;
    const mgr = this.#bots;
    if (!mgr || mgr.broken) {
      r.racers = r.racers.filter((u) => !isBot(player(s, u)));
      return;
    }
    const normal = r.startAt!;
    const startAt = Math.min(normal + BOT_WAIT_MS, Math.max(normal, now + mgr.readyIn() + 600));
    r.startAt = startAt;
    if (r.endAt != null) r.endAt += startAt - normal;
    s.nextAt = startAt;
    mgr.go(r.n, startAt, r.endAt != null ? r.endAt - startAt : BOT_PLAN_MS, s.rules.style === 'timeattack');
  }

  // Bots' finishes and retirements, each once the race clock reaches it. They are checked runs by
  // construction, earn no PB or WR badges, and don't start the finish window (that stays the humans').
  #botResults(now: number) {
    const s = this.state,
      r = s.round,
      mgr = this.#bots;
    if (!r || r.startAt == null) return;
    let changed = false;
    const sat: string[] = [];
    for (const d of mgr?.due(now) ?? []) {
      if (!r.racers.includes(d.u)) continue;
      if (d.dnf) {
        if (E.recordDnf(s, d.u)) {
          changed = true;
          if (d.sat) sat.push(player(s, d.u)?.name ?? '?');
        }
        continue;
      }
      const f = d.finish ?? d.runFinish;
      if (f == null) continue;
      const close = r.closeAt;
      const got = E.recordFinish(s, d.u, f, now, r.startAt + f);
      if (!got) continue;
      r.closeAt = close;
      if (got === true) r.runs[d.u].chk = 1;
      changed = true;
    }
    // A bot whose plan is gone can't finish any more.
    for (const u of r.racers) if (isBot(player(s, u)) && !roundDone(s, u) && !mgr?.drives(r.n, u)) changed = E.recordDnf(s, u) || changed;
    if (sat.length) this.app.notify(`${sat.join(', ')} ${sat.length > 1 ? "weren't" : "wasn't"} ready in time and ${sat.length > 1 ? 'sit' : 'sits'} this round out`, 'info');
    if (changed) this.touch();
  }

  // Match the field: each bot that finished moves toward the humans' median time.
  #matchField(result: RoundResult) {
    const s = this.state;
    if (s.rules.botSkill !== 'match') return;
    const times = result.rows.filter((row) => row[1] != null && !isBot(player(s, row[0]))).map((row) => row[1]!);
    if (!times.length) return;
    times.sort((a, b) => a - b);
    const mid = times.length >> 1;
    const median = times.length % 2 ? times[mid] : (times[mid - 1] + times[mid]) / 2;
    for (const row of result.rows) {
      const p = player(s, row[0]);
      if (p?.bot && row[1] != null) p.bot.s = Math.round(matchStep(p.bot.s / 100, row[1], median) * 100);
    }
  }

  // A checked run the bots may follow on this track later.
  #keepRun(trackId: string, u: number, rec: string | undefined, frames: number | null) {
    if (!rec || frames == null || this.state.rules.collisions) return;
    const list = (this.#cupRuns.get(trackId) ?? []).filter((r) => r.recording !== rec);
    list.push({ id: `cup:${u}:${frames}`, kind: 'cup', recording: rec, frames });
    list.sort((a, b) => a.frames - b.frames);
    this.#cupRuns.set(trackId, list.slice(0, CUP_REFS));
  }

  // ---- Messages ----

  receive(pid: number, m: Msg) {
    const now = Date.now();
    if (m.k === 'hi') return this.#hello(pid, String(m.key), m.role === 'spectator' ? 'spectator' : 'racer');
    if (m.k === 't0') {
      if (typeof m.a === 'number') this.app.net.send(pid, { k: 't1', a: m.a, h: now }, true);
      const p = byPid(this.state, pid);
      if (p && typeof m.rtt === 'number' && Number.isFinite(m.rtt) && m.rtt >= 0) {
        const ping = Math.min(9999, Math.round(m.rtt));
        // Small wobbles aren't worth a broadcast.
        if (p.ping == null || Math.abs(p.ping - ping) >= 15) {
          p.ping = ping;
          this.#softTouch();
        }
      }
      return;
    }
    const p = byPid(this.state, pid);
    if (!p) return;
    const s = this.state,
      r = s.round;
    switch (m.k) {
      case 'rdy':
        if (Number.isSafeInteger(m.s)) this.#ready.set(p.u, m.s);
        return;
      case 'fin':
        return this.#finish(p.u, m, now);
      case 'dnf':
        if (r && m.n === r.n && m.t === r.try && E.recordDnf(s, p.u)) {
          this.notifyAll(`${p.name} retired`, 'bad');
          this.touch(true);
        }
        return;
      case 'act':
        if (m.a === 'role') {
          if (E.setRole(s, p.u, m.v === 'spectator' ? 'spectator' : 'racer')) {
            this.#syncBots();
            this.touch(true);
          }
          else if (m.v === 'racer') this.app.net.send(pid, { k: 'note', text: 'The grid is closed right now', tone: 'bad' });
        } else if (m.a === 'ready') {
          if (s.phase === 'warmup' && r?.racers.includes(p.u)) {
            p.ready = 1;
            this.touch();
          }
        } else if (m.a === 'vote') this.#ballot(p.u, m.v);
        else if (m.a === 'skip') this.voteSkip(p.u);
        else if (m.a === 'watch') this.#watching(p.u, m.v);
        else if ((m.a === 'ban' || m.a === 'pick') && typeof m.v === 'string') {
          if (E.draftChoose(s, p.u, m.a, m.v)) this.touch();
        }
        return;
      case 'bump':
        return this.#bump(pid, m);
    }
  }

  #finish(u: number, m: Extract<Msg, { k: 'fin' }>, now: number) {
    const s = this.state,
      r = s.round;
    if (!r || m.n !== r.n || m.t !== r.try) return;
    const result = E.recordFinish(s, u, m.f, now, Math.min(now, this.#outageFrom(now) ?? now));
    if (!result) return;
    const p = player(s, u)!;
    if (result === 'slower') return this.touch();
    const run = r.runs[u];
    const ta = s.rules.style === 'timeattack';
    if (!s.rules.collisions) {
      const wr = this.#wr.get(r.track.id);
      if (m.pb) run.pb = 1;
      if (wr != null && (m.af ?? m.f) < wr) {
        run.wr = 1;
        this.#wr.set(r.track.id, m.af ?? m.f);
        this.notifyAll(`${p.name} beat the world record on ${r.track.name}!`, 'good');
      }
    }
    const reject = (why: string) => {
      const prev = ta ? this.#taBest.get(u) : undefined;
      if (prev != null) r.runs[u] = { f: prev, a: run.a, chk: 1 };
      else run.chk = 2;
      this.notifyAll(`${p.name}'s run ${why}`, 'bad');
    };
    // The replay is checked at its own length (af). The claimed time may only add the time lost
    // before the car started (one-run rounds), and nothing in time attack.
    const af = Number.isSafeInteger(m.af) && m.af! > 0 ? m.af! : null;
    const consistent = af != null && (ta ? af === m.f : af <= m.f && m.f - af <= now - (r.startAt ?? now) + E.FINISH_SLACK_MS);
    if (u === this.me || s.rules.collisions || !this.app.game) {
      run.chk = 1;
      if (ta) this.#taBest.set(u, run.f);
      this.#keepRun(r.track.id, u, m.rec, af);
    } else if (!m.rec || !consistent) reject("couldn't be checked");
    else {
      this.#flagRepeat(u, r.track.id, m.rec);
      const key = `${r.n}.${r.try}.${u}`;
      this.#checks.set(key, (this.#checks.get(key) ?? 0) + 1);
      this.app.native
        .verifyRun(this.app.game, m.rec, af!)
        .catch(() => null)
        .then((ok) => {
          this.#checks.set(key, Math.max(0, (this.#checks.get(key) ?? 1) - 1));
          const cur = this.state.round;
          if (cur !== r || `${cur.n}.${cur.try}.${u}` !== key || !['racing', 'checking'].includes(this.state.phase)) return;
          const mine = cur.runs[u];
          if (!mine || mine.f !== m.f) return this.touch();
          if (ok === false) reject("didn't pass the replay check");
          else {
            mine.chk = 1;
            if (ta) this.#taBest.set(u, mine.f);
            this.#keepRun(cur.track.id, u, m.rec, af);
          }
          this.touch(true);
        });
    }
    this.touch(true);
  }

  // Only the organizer is told; the run itself still counts if it replays correctly.
  #flagRepeat(u: number, trackId: string, rec: string) {
    let hash = 0;
    for (let i = 0; i < rec.length; i++) hash = (hash * 31 + rec.charCodeAt(i)) | 0;
    const key = `${u}:${trackId}`;
    const seen = this.#runHashes.get(key) ?? new Set<number>();
    if (seen.has(hash)) this.app.notify(`${player(this.state, u)?.name ?? 'A racer'} sent a run identical to one they drove before. Worth a look.`, 'bad');
    seen.add(hash);
    this.#runHashes.set(key, seen);
  }

  #bump(pid: number, m: Extract<Msg, { k: 'bump' }>) {
    const s = this.state;
    if (!s.rules.collisions || s.phase !== 'racing' || !Array.isArray(m.i) || m.i.length !== 3 || !m.i.every(Number.isFinite)) return;
    if (m.n !== s.round?.n || typeof m.to !== 'number') return;
    const impulse = m.i.map((v) => Math.max(-50, Math.min(50, v)));
    if (m.to === this.app.selfPid) {
      if (this.app.game) this.app.native.bump(this.app.game, impulse);
    } else this.app.net.send(m.to, { k: 'bump', n: m.n, from: pid, i: impulse });
  }

  #watchAt = new Map<number, number>();
  #watching(u: number, v: unknown) {
    const p = player(this.state, u);
    const now = Date.now();
    // At most one change a second per player; pages resend until their choice shows in the state.
    if (!p || now - (this.#watchAt.get(u) ?? 0) < 1000) return;
    const to = typeof v === 'number' && v !== u && player(this.state, v) ? v : undefined;
    if (p.watch === to) return;
    this.#watchAt.set(u, now);
    if (to == null) delete p.watch;
    else p.watch = to;
    this.#softTouch();
  }

  #ballot(u: number, v: number) {
    const vote = this.state.vote;
    if (!vote || this.state.phase !== 'vote' || !Number.isInteger(v) || v < 0 || v >= vote.opts.length) return;
    if (vote.kind === 'vote') {
      if (!player(this.state, u) || player(this.state, u)!.role !== 'racer') return;
    } else if (vote.picker !== u) return;
    vote.ballots[u] = v;
    this.touch();
  }

  // ---- Sending ----

  #sendTo(pid: number) {
    const peer = this.#peers.get(pid);
    if (!peer?.greeted) return;
    if (peer.hist < this.history.length) {
      if (this.app.net.send(pid, { k: 'hist', from: peer.hist, rows: this.history.slice(peer.hist) })) peer.hist = this.history.length;
    }
    if (!this.app.net.send(pid, { k: 'st', s: this.state })) return;
    const links = (peer.links ??= new Map());
    const now = Date.now();
    for (const p of this.state.players) {
      if (p.pid == null || p.lk == null) continue;
      if (links.get(p.pid)?.link !== p.lk) links.set(p.pid, { link: p.lk, at: now });
    }
    for (const pid of links.keys()) if (!this.state.players.some((p) => p.pid === pid && p.lk != null)) links.delete(pid);
  }

  // The round's bot chunks so far, for a page that just said hello (or missed some).
  #sendBots(pid: number, peer: Peer) {
    const n = this.state.round?.n;
    peer.botsStale = false;
    if (n == null || !this.#bots) return;
    for (const m of this.#bots.chunksFor(n))
      if (!this.app.net.send(pid, m)) {
        peer.botsStale = true;
        return;
      }
  }

  // New bot chunks ride the next flush to every page, like the state (never a frame of their own).
  #shipBots(now: number) {
    const out = this.#bots?.take(now, this.state.round?.n);
    if (!out) return;
    for (const [pid, peer] of this.#peers) {
      if (!peer.greeted) continue;
      if (peer.botsStale) {
        this.#sendBots(pid, peer);
        continue;
      }
      for (const m of out)
        if (!this.app.net.send(pid, m)) {
          peer.botsStale = true;
          break;
        }
    }
  }

  #broadcast(now: number) {
    // While cars race the organizer sends every 200 ms anyway, so a soft change costs nothing extra.
    const soft = this.#soft && ((site.__nswsMuxPace ?? 1000) <= 200 || now - this.#sentAt >= SOFT_MS);
    if ((!this.#dirty && !soft) || now - this.#sentAt < BROADCAST_MS) return;
    this.#dirty = false;
    this.#soft = false;
    this.#sentAt = now;
    this.state.seq++;
    for (const pid of this.#peers.keys()) this.#sendTo(pid);
    this.app.changed();
    if (this.#urgent) site.__nswsMuxFlush?.();
    this.#urgent = false;
  }

  notifyAll(text: string, tone: 'good' | 'bad' | 'info' = 'info') {
    for (const [pid, peer] of this.#peers) if (peer.greeted) this.app.net.send(pid, { k: 'note', text, tone });
    this.app.notify(text, tone);
  }

  // ---- Tracks ----

  pool(): PoolTrack[] {
    if (this.#pool.length && Date.now() - this.#poolAt < 30_000) return this.#pool;
    const list: PoolTrack[] = [];
    // Saved custom tracks only join a cup for local testing (a pool marked custom by hand).
    const custom = (site.__nswsCupPool as { custom?: boolean } | undefined)?.custom === true;
    this.app.native.trackLibrary.forEachTrack((id, meta, category, _env, load, thumb) => {
      if (category === 'custom' && !custom) return;
      list.push({ id, name: meta?.name ?? 'Track', author: meta?.author, cat: (['official', 'community', 'custom'].includes(category) ? category : 'custom') as Category, load, thumb });
    });
    this.#pool = list;
    this.#poolAt = Date.now();
    return list;
  }

  #randomTracks(count: number) {
    const pool = this.pool();
    const fresh = pool.filter((t) => !this.#recent.includes(t.id));
    const pick = shuffle([...(fresh.length >= count ? fresh : pool)]).slice(0, count);
    return pick.map(({ id, name, author, cat }) => ({ id, name, author, cat }));
  }

  queue(track: TrackRef | null) {
    this.#queued = track;
    this.touch();
  }
  get queued() {
    return this.#queued;
  }

  async #load(ref: TrackRef, epoch: number) {
    const entry = this.pool().find((t) => t.id === ref.id);
    if (!entry) throw new Error(`${ref.name} isn't in this cup's maps any more.`);
    const wr = this.#wr.has(ref.id) || ref.cat === 'custom' ? Promise.resolve() : this.app.native.worldRecord(ref.id, true).then((f) => void this.#wr.set(ref.id, f));
    if (this.#seatedBots().length) this.#manager().prefetch(ref.id, ref.cat === 'custom');
    const track = await entry.load();
    await Promise.race([wr, new Promise((r) => setTimeout(r, 3000))]);
    if (epoch !== this.#epoch) return;
    if (!track?.trackData?.hasStartingPoint()) throw new Error(`${ref.name} has no start, so it can't be raced.`);
    const s = this.state;
    E.newRound(s, ref, 1, null);
    E.setPhase(s, 'loading', Date.now());
    this.#recent = [ref.id, ...this.#recent.filter((id) => id !== ref.id)].slice(0, RECENT_TRACKS);
    this.#loading = { ref, at: Date.now(), from: this.app.info?.sessionId, track, sessionAt: 0 };
    this.#retries = 0;
    this.#ready.clear();
    this.#taBest.clear();
    this.#planTrack = { ref, data: track.trackData };
    this.#planBots();
    this.#startSession();
    this.touch(true);
  }

  #startSession() {
    const l = this.#loading!;
    const bridge = site.__nswsCup!;
    const mode = this.state.rules.uploads && !this.state.rules.collisions ? bridge.GameMode.Casual : bridge.GameMode.Competitive;
    l.at = Date.now();
    l.from = this.app.info?.sessionId;
    this.app.connection?.startNewSession?.(mode, l.track.trackMetadata, l.track.trackData);
  }

  #loadTrack(ref: TrackRef) {
    if (this.#pending) return;
    this.#pending = true;
    const epoch = this.#epoch;
    this.#load(ref, epoch)
      .catch((error) => {
        if (epoch !== this.#epoch) return;
        this.app.fail(error);
        // Another track instead, so an automatic cup keeps going; with none, the cup waits for the organizer.
        const other = this.#randomTracks(2).find((t) => t.id !== ref.id);
        if (other) setTimeout(() => epoch === this.#epoch && this.#loadTrack(other), 1500);
        else {
          const s = this.state;
          s.vote = null;
          s.hold = true;
          E.setPhase(s, 'results', Date.now(), Date.now());
          this.touch(true);
        }
      })
      .finally(() => (this.#pending = false));
  }

  #chooseTrack(now: number) {
    const s = this.state;
    if (s.playlist.length && !this.#queued) return this.#loadTrack(E.nextFromPlaylist(s)!);
    if (this.#queued) {
      const next = this.#queued;
      this.#queued = null;
      return this.#loadTrack(next);
    }
    const kind = s.rules.next;
    const last = this.history.findLast((h) => !h.void);
    const chooser = kind === 'winner' || kind === 'last' ? E.picker(s, last, kind) : kind === 'host' ? this.me : null;
    if (kind === 'random' || ((kind === 'winner' || kind === 'last') && chooser == null)) {
      const [ref] = this.#randomTracks(1);
      if (!ref) return this.app.fail(new Error('There are no tracks in this cup.'));
      return this.#loadTrack(ref);
    }
    const opts = this.#randomTracks(kind === 'vote' ? 3 : 4);
    if (!opts.length) return this.app.fail(new Error('There are no tracks in this cup.'));
    // The organizer gets three times as long, since they can browse every track.
    const ms = s.rules.voteSeconds * 1000 * (kind === 'host' ? 3 : 1);
    s.vote = { kind, opts, until: now + ms, ballots: {}, picker: chooser };
    // A bot picks at random on the spot.
    if (chooser != null && isBot(player(s, chooser))) s.vote.ballots[chooser] = Math.floor(Math.random() * opts.length);
    E.setPhase(s, 'vote', now, now + ms);
    this.touch(true);
  }

  // The organizer picks any track while choosing (it replaces the options).
  hostPick(ref: TrackRef) {
    const vote = this.state.vote;
    if (this.state.phase === 'vote' && vote?.kind === 'host') {
      vote.opts = [ref];
      vote.ballots = { [this.me]: 0 };
      vote.until = Date.now();
      this.touch(true);
    } else this.queue(ref);
  }

  // Fixed, or the world record times the multiplier (never under the minimum).
  #warmupMs(trackId: string) {
    const r = this.state.rules;
    const wr = this.#wr.get(trackId);
    if (r.warmupTiming === 'wr' && wr) return Math.max(r.warmupMin * 1000, Math.round(wr * r.warmupMult));
    return r.warmup * 1000;
  }

  #limitMs(trackId: string) {
    const r = this.state.rules;
    if (r.style === 'timeattack') return r.taSeconds * 1000;
    if (r.limit === 'off') return null;
    if (r.limit === 'fixed') return r.limitSeconds * 1000;
    const known = [this.#best.get(trackId), this.#wr.get(trackId)].filter((x): x is number => !!x);
    const best = known.length ? Math.min(...known) : undefined;
    return best ? Math.min(600_000, Math.max(60_000, Math.round(best * 3))) : r.limitSeconds * 1000;
  }

  // ---- The clock ----

  tick(now: number) {
    const s = this.state;
    this.#syncLobby(now);
    switch (s.phase) {
      case 'loading':
        this.#tickLoading(now);
        break;
      case 'draft':
        if (!this.#pending && (now >= (s.draft?.until ?? 0) || E.draftComplete(s))) {
          if (E.draftAdvance(s, now)) this.#chooseTrack(now);
          else this.#botDraft();
          this.touch(true);
        }
        break;
      case 'warmup': {
        const r = s.round!;
        const racers = r.racers.filter((u) => !player(s, u)?.away);
        const allReady = s.rules.readyEnds && racers.length > 0 && racers.every((u) => player(s, u)?.ready);
        if (now >= (r.warmupUntil ?? 0) || allReady) this.#go(now);
        break;
      }
      case 'countdown':
        if (now >= (s.round?.startAt ?? Infinity)) {
          E.setPhase(s, 'racing', now);
          this.touch(true);
        }
        break;
      case 'racing':
        this.#botResults(now);
        if (E.roundOver(s, now) && this.#outageFrom(now) == null) {
          if (this.#pendingChecks()) {
            E.setPhase(s, 'checking', now, now + CHECK_WAIT_MS);
            this.touch(true);
          } else this.#closeRound(now);
        }
        break;
      case 'checking':
        if (now >= (s.nextAt ?? 0) || !this.#pendingChecks()) this.#closeRound(now);
        break;
      case 'results':
        if (!s.hold && !this.#pending && now >= (s.nextAt ?? Infinity)) this.advance(now);
        break;
      case 'vote': {
        const vote = s.vote;
        if (!vote || this.#pending) break;
        const voters = vote.kind === 'vote' ? s.players.filter((p) => p.role === 'racer' && !p.out && !p.away && !p.bot).map((p) => p.u) : [vote.picker];
        const all = voters.length > 0 && voters.every((u) => u != null && u in vote.ballots);
        if (now >= vote.until || all) {
          this.#loadTrack(vote.opts[E.tally(vote.opts, vote.ballots)]);
        }
        break;
      }
    }
    this.#shipBots(now);
    this.#broadcast(now);
    this.#reportStatus(now);
  }

  #tickLoading(now: number) {
    const s = this.state,
      r = s.round!,
      l = this.#loading;
    const info = this.app.info;
    if (l && r.session == null) {
      const id = info?.trackData?.getId?.();
      // The new session normally carries the track's id; after a while any new session will do.
      const fresh = !!info && !info.disposed && info.sessionId !== l.from;
      if (fresh && (id === l.ref.id || now - l.at > 3000)) {
        r.session = info.sessionId ?? null;
        l.sessionAt = now;
        this.touch(true);
      } else if (now - l.at > SESSION_RETRY_MS && !document.hidden && this.#retries < 3) {
        this.#retries++;
        this.#startSession();
      }
      return;
    }
    const waiting = r.racers.filter((u) => u !== this.me && !player(s, u)?.away && !player(s, u)?.bot && this.#ready.get(u) !== r.session);
    if (waiting.length && now - (l?.sessionAt ?? 0) < LOAD_WAIT_MS) return;
    // Until the bots' planners say how fast they go, GO can't be timed for them (a few seconds at most).
    const mgr = this.#bots;
    if (mgr && !mgr.broken && this.#roundBots(true).length && mgr.readyIn() === Infinity && now - (l?.sessionAt ?? 0) < BOT_WAIT_MS) return;
    this.#loading = null;
    const fresh = !this.#visited.has(r.track.id);
    this.#visited.add(r.track.id);
    const warm = s.rules.style !== 'timeattack' && r.k === 1 && (s.rules.warmupMode === 'every' || (s.rules.warmupMode === 'first' && fresh));
    if (warm) {
      r.warmupUntil = now + this.#warmupMs(r.track.id);
      E.setPhase(s, 'warmup', now, r.warmupUntil);
      this.#botsReady();
      this.touch(true);
    } else this.#go(now);
  }

  #go(now: number) {
    const s = this.state;
    E.scheduleStart(s, now, this.#limitMs(s.round!.track.id));
    this.#taBest.clear();
    this.#botsGo(now);
    this.touch(true);
  }

  #closeRound(now: number) {
    const s = this.state;
    const live = this.app.live;
    const leaderBefore = standings(s, this.history)[0]?.u;
    const finalistsBefore = new Set(s.players.filter((p) => p.fin).map((p) => p.u));
    const result = E.closeRound(s, (u) => {
      const pid = player(s, u)?.pid;
      return pid == null ? -1 : live.score(pid);
    });
    this.history.push(result);
    // The auto time limit goes by people: a bot's time says nothing about how long they need.
    const best = result.rows.find((row) => row[1] != null && !isBot(player(s, row[0])))?.[1];
    if (best != null) {
      const id = s.round!.track.id;
      this.#best.set(id, Math.min(best, this.#best.get(id) ?? Infinity));
    }
    const winner = player(s, result.rows.find((row) => row[2] === 1)?.[0]);
    E.setPhase(s, 'results', now, now + s.rules.breakSeconds * 1000);
    if (s.winner != null) s.nextAt = now + Math.max(5000, s.rules.breakSeconds * 1000);
    if (winner) this.app.native.sound('record');
    this.#announce(result, leaderBefore, finalistsBefore);
    this.#matchField(result);
    this.#prePlan();
    this.touch(true);
  }

  // What the round changed, for everyone: photo finishes, lead changes, finalists, match points.
  #matchPoint = new Set<number>();
  #announce(result: RoundResult, leaderBefore: number | undefined, finalistsBefore: Set<number>) {
    const s = this.state;
    const timed = result.rows.filter((row) => row[1] != null);
    if (timed.length >= 2 && timed[0][1] !== timed[1][1] && timed[1][1]! - timed[0][1]! <= 50) {
      const a = player(s, timed[0][0]),
        b = player(s, timed[1][0]);
      if (a && b) this.notifyAll(`Photo finish! ${a.name} beat ${b.name} by ${timed[1][1]! - timed[0][1]!} ms`, 'good');
    }
    if (s.winner != null) return;
    const lead = standings(s, this.history)[0];
    if (lead && leaderBefore != null && lead.u !== leaderBefore && s.rules.mode !== 'knockout') this.notifyAll(`${lead.name} takes the lead`, 'info');
    for (const p of s.players) if (p.fin && !finalistsBefore.has(p.u)) this.notifyAll(`${p.name} is a finalist! A round win takes the cup`, 'good');
    if (s.rules.mode === 'points' && !s.rules.finalist)
      for (const p of s.players)
        if (p.role === 'racer' && !this.#matchPoint.has(p.u) && p.pts + s.rules.points[0] >= s.rules.target) {
          this.#matchPoint.add(p.u);
          this.notifyAll(`Match point for ${p.name}`, 'info');
        }
    if (s.rules.mode === 'rounds' && s.rounds === s.rules.rounds - 1) this.notifyAll('Final round next!', 'info');
  }

  // Moves on from results: the podium, the same track again, or the next track.
  advance(now = Date.now()) {
    const s = this.state;
    if (this.#pending) return;
    if (s.winner != null) {
      E.setPhase(s, 'podium', now);
      s.round = null;
      this.#bots?.drop();
      this.touch(true);
      return;
    }
    if (E.humanRacers(s).filter((p) => !p.away).length === 0) {
      s.hold = true;
      this.touch();
      return;
    }
    if (E.needsNewTrack(s) || this.#queued) return this.#chooseTrack(now);
    const r = s.round!;
    E.newRound(s, r.track, r.k + 1, r.session);
    this.#go(now);
  }

  // While this page is cut off from the proxy (a Worker deploy restarts every room), and for a
  // while after, racers' finishes are still coming: the round doesn't end, and a late finish is
  // judged from when the outage began.
  #outageFrom(now: number) {
    const o = site.__nswsMuxOutage;
    return o && (!o.until || now - o.until < OUTAGE_GRACE_MS) ? o.from : null;
  }

  #reportStatus(now: number) {
    const s = this.state;
    if (now - this.#statusAt < STATUS_MS) return;
    const phase = s.phase === 'lobby' || s.phase === 'draft' ? 'setup' : s.phase === 'podium' ? 'done' : ['results', 'vote'].includes(s.phase) ? 'break' : 'racing';
    const status = {
      phase,
      round: s.round?.n ?? s.rounds,
      racers: E.humanRacers(s).length,
      canRace: E.canRace(s),
      format: s.format.slice(0, 24),
    };
    const key = JSON.stringify(status);
    // A reclaimed code is a new matchmaking socket, which starts with no status.
    const invite = this.app.connection?.getInvite?.() ?? null;
    if (key === this.#statusKey && invite === this.#statusInvite) return;
    this.#statusKey = key;
    this.#statusAt = now;
    this.#statusInvite = invite;
    this.app.connection?.reportCupStatus?.(status);
  }

  // ---- Organizer commands ----

  start() {
    const s = this.state;
    if (s.phase !== 'lobby') return;
    if (E.humanRacers(s).filter((p) => !p.away).length < 1) throw new Error('Nobody is on the grid yet.');
    this.#syncBots();
    if (s.rules.draft) {
      const n = Math.min(24, Math.max(8, E.racers(s).length * (s.rules.bans + s.rules.picks) + 3));
      const opts = this.#randomTracks(n);
      if (opts.length < 2) throw new Error('A pick and ban needs at least two tracks in the cup.');
      E.startDraft(s, opts, Date.now());
      this.#botDraft();
      this.touch(true);
      return;
    }
    this.#chooseTrack(Date.now());
  }

  configure(format: string, rules: Rules) {
    const s = this.state;
    if (s.phase !== 'lobby') throw new Error('The format is locked once the cup starts.');
    s.format = format.slice(0, 40);
    s.rules = cleanRules(rules);
    this.#poolAt = 0;
    for (const p of s.players) if (p.role === 'racer' && !p.bot && !E.canRace(s, p.u)) p.role = 'spectator';
    this.#syncBots();
    this.touch(true);
  }

  // Changes that are safe mid-cup.
  adjust(change: Partial<Pick<Rules, 'breakSeconds' | 'freecam' | 'lateJoin' | 'finishWindow' | 'next' | 'readyEnds' | 'target' | 'bots' | 'botSkill'>>) {
    const s = this.state;
    const next = { ...change };
    // The points cap can still move during a cup, but never onto a total someone already has.
    if (next.target != null && s.phase !== 'lobby') next.target = Math.max(next.target, E.leaderPoints(s) + 1);
    s.rules = cleanRules({ ...s.rules, ...next });
    this.#syncBots();
    this.touch(true);
  }

  rename(name: string) {
    const clean = name.trim().slice(0, 40);
    if (!clean) return;
    this.state.name = clean;
    this.touch();
  }

  setRole(u: number, role: 'racer' | 'spectator') {
    if (isBot(player(this.state, u))) {
      if (role === 'spectator') this.removeBot(u);
      return;
    }
    if (!E.setRole(this.state, u, role)) throw new Error(role === 'racer' ? 'The grid is closed or full.' : 'Nothing to change.');
    this.#syncBots();
    this.touch(true);
  }

  kick(u: number) {
    const s = this.state,
      p = player(s, u);
    if (!p || u === this.me) return;
    if (p.bot) return this.removeBot(u);
    for (const [key, id] of this.#keys) if (id === u) this.#banned.add(key);
    if (p.pid != null) {
      this.app.net.send(p.pid, { k: 'bye', why: 'The organizer removed you from this cup.' }, true);
      const pid = p.pid;
      setTimeout(() => this.app.connection?.kickPlayer?.(pid), 600);
    }
    if (s.round) {
      s.round.racers = s.round.racers.filter((x) => x !== u);
      delete s.round.runs[u];
    }
    s.players = s.players.filter((x) => x !== p);
    this.notifyAll(`${p.name} was removed`, 'bad');
    this.#syncBots();
    this.touch(true);
  }

  restartRound() {
    const s = this.state;
    if (!s.round || !['countdown', 'racing', 'warmup'].includes(s.phase)) return;
    this.#go(Date.now());
    this.notifyAll('The organizer restarted the round', 'info');
  }

  endRoundNow() {
    const s = this.state;
    if (s.phase !== 'racing' && s.phase !== 'countdown') return;
    const r = s.round!;
    r.endAt = Math.min(r.endAt ?? Infinity, Date.now());
    if (s.phase === 'countdown') E.setPhase(s, 'racing', Date.now());
    this.touch(true);
  }

  voidRound(skip = false, note = 'The organizer voided the round') {
    const s = this.state,
      r = s.round;
    if (!r || !['countdown', 'racing', 'checking', 'warmup'].includes(s.phase)) return;
    this.history.push({ n: r.n, track: r.track.name, ta: 0, rows: [], void: 1 });
    r.k = skip ? s.rules.perTrack : Math.max(0, r.k - 1);
    E.setPhase(s, 'results', Date.now(), Date.now() + 4000);
    r.runs = {};
    r.dnf = [];
    if (note) this.notifyAll(note, 'bad');
    this.touch(true);
  }

  extend(seconds: number) {
    const r = this.state.round;
    if (!r || this.state.phase !== 'racing') return;
    if (r.endAt != null) r.endAt += seconds * 1000;
    if (r.closeAt != null) r.closeAt += seconds * 1000;
    this.notifyAll(`+${seconds} s added to the round`, 'info');
    this.touch(true);
  }

  skipTrack(note = 'The organizer skipped this track') {
    const s = this.state;
    if (['countdown', 'racing', 'warmup', 'checking'].includes(s.phase)) this.voidRound(true, note);
    else if (s.phase === 'results') {
      if (s.round) s.round.k = s.rules.perTrack;
      this.advance();
    }
  }

  // A racer toggles their vote to skip the track. Over half of the racers still here skips it: at
  // once if nobody has finished yet, otherwise after this round.
  voteSkip(u: number) {
    const s = this.state,
      r = s.round;
    if (!s.rules.skipVotes || !r || !r.racers.includes(u) || !['warmup', 'countdown', 'racing'].includes(s.phase)) return;
    r.skip = r.skip.includes(u) ? r.skip.filter((x) => x !== u) : [...r.skip, u];
    const here = r.racers.filter((x) => !player(s, x)?.away && !player(s, x)?.bot);
    if (r.skip.filter((x) => here.includes(x)).length * 2 > here.length) {
      r.skip = [];
      if (Object.keys(r.runs).length) {
        r.k = s.rules.perTrack;
        this.notifyAll('Vote passed: a new track after this round', 'info');
      } else {
        this.notifyAll('Vote passed: skipping this track', 'info');
        this.skipTrack('');
        return;
      }
    }
    this.touch(true);
  }

  // Ends the current pick and ban step early.
  draftNow() {
    if (this.state.phase === 'draft' && this.state.draft) {
      this.state.draft.until = Date.now();
      this.touch(true);
    }
  }

  setHold(hold: boolean) {
    this.state.hold = hold;
    if (!hold && this.state.phase === 'results' && (this.state.nextAt ?? 0) < Date.now()) this.state.nextAt = Date.now() + 3000;
    this.touch();
  }

  shout(text: string) {
    const clean = text.trim().slice(0, 140);
    this.state.shout = clean ? { text: clean, at: Date.now() } : null;
    this.touch(true);
  }

  endCup() {
    const s = this.state;
    s.draft = null;
    this.#epoch++;
    this.#loading = null;
    if (s.winner == null) s.winner = standings(s, this.history)[0]?.u ?? null;
    E.setPhase(s, 'podium', Date.now());
    s.round = null;
    s.vote = null;
    this.#bots?.drop();
    this.touch(true);
  }

  raceAgain(newTracks: boolean) {
    const s = this.state;
    E.resetScores(s);
    this.#epoch++;
    this.#loading = null;
    // App.history is this same array.
    this.history.length = 0;
    this.#visited.clear();
    this.#matchPoint.clear();
    for (const peer of this.#peers.values()) peer.hist = 0;
    if (newTracks) this.#recent = [];
    s.id = randomId();
    E.setPhase(s, 'lobby', Date.now());
    this.#bots?.drop();
    this.#botTier = '';
    this.#syncBots();
    this.touch(true);
  }

  // A one-off snapshot for a page that asks again (after a resume).
  resend(pid: number) {
    const peer = this.#peers.get(pid);
    if (peer) {
      peer.hist = 0;
      this.#sendTo(pid);
      this.#sendBots(pid, peer);
    }
  }
}
