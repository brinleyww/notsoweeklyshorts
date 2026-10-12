// The organizer's side of a cup: the authoritative state, the round clock, track loading and
// the replay checks. Everyone else only sees the state it broadcasts.
import type { App } from './app.ts';
import * as E from './engine.ts';
import type { LoadedTrack } from './game.ts';
import { site } from './game.ts';
import type { Msg } from './protocol.ts';
import { cleanRules, type Rules } from './rules.ts';
import { byPid, player, roundDone, standings, type CupState, type RoundResult, type TrackRef, type Category } from './state.ts';

const LOAD_WAIT_MS = 15_000;
const SESSION_RETRY_MS = 8_000;
const CHECK_WAIT_MS = 10_000;
const VOTE_MS = 15_000;
const PICK_MS = 15_000;
const HOST_PICK_MS = 45_000;
const BROADCAST_MS = 150;
const STATUS_MS = 2_000;
const RECENT_TRACKS = 8;

export interface PoolTrack extends TrackRef {
  load: () => Promise<LoadedTrack>;
  thumb: Promise<string> | string;
}

interface Peer {
  key: string | null;
  hist: number;
  greeted: boolean;
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
  #pool: PoolTrack[] = [];
  #poolAt = 0;

  constructor(
    private app: App,
    o: { name: string; format: string; rules: Rules; role: 'racer' | 'spectator' },
  ) {
    this.state = E.createCup({ id: randomId(), name: o.name, format: o.format, rules: o.rules, now: Date.now() });
    const me = this.#addPlayer('organizer', app.selfPid, o.role);
    this.state.host = me.u;
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
    }
    peer.key = key;
    peer.greeted = true;
    peer.hist = 0;
    this.app.net.send(pid, { k: 'you', u: p.u });
    this.#sendTo(pid);
    this.touch();
  }

  #syncLobby(now: number) {
    const lobby = this.app.lobby;
    for (const p of this.state.players) {
      if (p.pid == null) continue;
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

  // ---- Messages ----

  receive(pid: number, m: Msg) {
    const now = Date.now();
    if (m.k === 'hi') return this.#hello(pid, String(m.key), m.role === 'spectator' ? 'spectator' : 'racer');
    if (m.k === 't0') {
      if (typeof m.a === 'number') this.app.net.send(pid, { k: 't1', a: m.a, h: now }, true);
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
          if (E.setRole(s, p.u, m.v === 'spectator' ? 'spectator' : 'racer')) this.touch(true);
          else if (m.v === 'racer') this.app.net.send(pid, { k: 'note', text: 'The grid is closed right now', tone: 'bad' });
        } else if (m.a === 'ready') {
          if (s.phase === 'warmup' && r?.racers.includes(p.u)) {
            p.ready = 1;
            this.touch();
          }
        } else if (m.a === 'vote') this.#ballot(p.u, m.v);
        return;
      case 'bump':
        return this.#bump(pid, m);
    }
  }

  #finish(u: number, m: Extract<Msg, { k: 'fin' }>, now: number) {
    const s = this.state,
      r = s.round;
    if (!r || m.n !== r.n || m.t !== r.try) return;
    const result = E.recordFinish(s, u, m.f, now);
    if (!result) return;
    const p = player(s, u)!;
    if (result === 'slower') return this.touch();
    const run = r.runs[u];
    const ta = s.rules.style === 'timeattack';
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
    } else if (!m.rec || !consistent) reject("couldn't be checked");
    else {
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
          }
          this.touch(true);
        });
    }
    this.touch(true);
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
    this.app.net.send(pid, { k: 'st', s: this.state });
  }

  #broadcast(now: number) {
    if (!this.#dirty || now - this.#sentAt < BROADCAST_MS) return;
    this.#dirty = false;
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
    const custom = this.state.rules.customTracks;
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
    const track = await entry.load();
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
    const ms = kind === 'vote' ? VOTE_MS : kind === 'host' ? HOST_PICK_MS : PICK_MS;
    s.vote = { kind, opts, until: now + ms, ballots: {}, picker: chooser };
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

  #limitMs(trackId: string) {
    const r = this.state.rules;
    if (r.style === 'timeattack') return r.taSeconds * 1000;
    if (r.limit === 'off') return null;
    if (r.limit === 'fixed') return r.limitSeconds * 1000;
    const best = this.#best.get(trackId);
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
      case 'warmup': {
        const r = s.round!;
        const racers = r.racers.filter((u) => !player(s, u)?.away);
        if (now >= (r.warmupUntil ?? 0) || (racers.length > 0 && racers.every((u) => player(s, u)?.ready))) this.#go(now);
        break;
      }
      case 'countdown':
        if (now >= (s.round?.startAt ?? Infinity)) {
          E.setPhase(s, 'racing', now);
          this.touch(true);
        }
        break;
      case 'racing':
        if (E.roundOver(s, now)) {
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
        const voters = vote.kind === 'vote' ? s.players.filter((p) => p.role === 'racer' && !p.out && !p.away).map((p) => p.u) : [vote.picker];
        const all = voters.length > 0 && voters.every((u) => u != null && u in vote.ballots);
        if (now >= vote.until || all) {
          this.#loadTrack(vote.opts[E.tally(vote.opts, vote.ballots)]);
        }
        break;
      }
    }
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
    const waiting = r.racers.filter((u) => u !== this.me && !player(s, u)?.away && this.#ready.get(u) !== r.session);
    if (waiting.length && now - (l?.sessionAt ?? 0) < LOAD_WAIT_MS) return;
    this.#loading = null;
    if (s.rules.warmup > 0 && s.rules.style !== 'timeattack' && r.k === 1) {
      r.warmupUntil = now + s.rules.warmup * 1000;
      E.setPhase(s, 'warmup', now, r.warmupUntil);
      this.touch(true);
    } else this.#go(now);
  }

  #go(now: number) {
    const s = this.state;
    E.scheduleStart(s, now, this.#limitMs(s.round!.track.id));
    this.#taBest.clear();
    this.touch(true);
  }

  #closeRound(now: number) {
    const s = this.state;
    const live = this.app.live;
    const result = E.closeRound(s, (u) => {
      const pid = player(s, u)?.pid;
      return pid == null ? -1 : live.score(pid);
    });
    this.history.push(result);
    const best = result.rows.find((row) => row[1] != null)?.[1];
    if (best != null) {
      const id = s.round!.track.id;
      this.#best.set(id, Math.min(best, this.#best.get(id) ?? Infinity));
    }
    const winner = player(s, result.rows.find((row) => row[2] === 1)?.[0]);
    E.setPhase(s, 'results', now, now + s.rules.breakSeconds * 1000);
    if (s.winner != null) s.nextAt = now + Math.max(5000, s.rules.breakSeconds * 1000);
    if (winner) this.app.native.sound('record');
    this.touch(true);
  }

  // Moves on from results: the podium, the same track again, or the next track.
  advance(now = Date.now()) {
    const s = this.state;
    if (this.#pending) return;
    if (s.winner != null) {
      E.setPhase(s, 'podium', now);
      s.round = null;
      this.touch(true);
      return;
    }
    if (E.racers(s).filter((p) => !p.away).length === 0) {
      s.hold = true;
      this.touch();
      return;
    }
    if (E.needsNewTrack(s) || this.#queued) return this.#chooseTrack(now);
    const r = s.round!;
    E.newRound(s, r.track, r.k + 1, r.session);
    this.#go(now);
  }

  #reportStatus(now: number) {
    const s = this.state;
    if (now - this.#statusAt < STATUS_MS) return;
    const phase = s.phase === 'lobby' ? 'setup' : s.phase === 'podium' ? 'done' : ['results', 'vote'].includes(s.phase) ? 'break' : 'racing';
    const status = {
      phase,
      round: s.round?.n ?? s.rounds,
      racers: E.racers(s).length,
      canRace: E.canRace(s),
      format: s.format.slice(0, 24),
    };
    const key = JSON.stringify(status);
    if (key === this.#statusKey) return;
    this.#statusKey = key;
    this.#statusAt = now;
    this.app.connection?.reportCupStatus?.(status);
  }

  // ---- Organizer commands ----

  start() {
    const s = this.state;
    if (s.phase !== 'lobby') return;
    if (E.racers(s).filter((p) => !p.away).length < 1) throw new Error('Nobody is on the grid yet.');
    this.#chooseTrack(Date.now());
  }

  configure(format: string, rules: Rules) {
    const s = this.state;
    if (s.phase !== 'lobby') throw new Error('The format is locked once the cup starts.');
    s.format = format.slice(0, 40);
    s.rules = cleanRules(rules);
    this.#poolAt = 0;
    for (const p of s.players) if (p.role === 'racer' && !E.canRace(s, p.u)) p.role = 'spectator';
    this.touch(true);
  }

  // Changes that are safe mid-cup.
  adjust(change: Partial<Pick<Rules, 'breakSeconds' | 'freecam' | 'lateJoin' | 'finishWindow' | 'next'>>) {
    const s = this.state;
    s.rules = cleanRules({ ...s.rules, ...change });
    this.touch(true);
  }

  rename(name: string) {
    const clean = name.trim().slice(0, 40);
    if (!clean) return;
    this.state.name = clean;
    this.touch();
  }

  setRole(u: number, role: 'racer' | 'spectator') {
    if (!E.setRole(this.state, u, role)) throw new Error(role === 'racer' ? 'The grid is closed or full.' : 'Nothing to change.');
    this.touch(true);
  }

  kick(u: number) {
    const s = this.state,
      p = player(s, u);
    if (!p || u === this.me) return;
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

  voidRound(skip = false) {
    const s = this.state,
      r = s.round;
    if (!r || !['countdown', 'racing', 'checking', 'warmup'].includes(s.phase)) return;
    this.history.push({ n: r.n, track: r.track.name, ta: 0, rows: [], void: 1 });
    r.k = skip ? s.rules.perTrack : Math.max(0, r.k - 1);
    E.setPhase(s, 'results', Date.now(), Date.now() + 4000);
    r.runs = {};
    r.dnf = [];
    this.notifyAll('The organizer voided the round', 'bad');
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

  skipTrack() {
    const s = this.state;
    if (['countdown', 'racing', 'warmup', 'checking'].includes(s.phase)) this.voidRound(true);
    else if (s.phase === 'results') {
      if (s.round) s.round.k = s.rules.perTrack;
      this.advance();
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
    this.#epoch++;
    this.#loading = null;
    if (s.winner == null) s.winner = standings(s, this.history)[0]?.u ?? null;
    E.setPhase(s, 'podium', Date.now());
    s.round = null;
    s.vote = null;
    this.touch(true);
  }

  raceAgain(newTracks: boolean) {
    const s = this.state;
    E.resetScores(s);
    this.#epoch++;
    this.#loading = null;
    // App.history is this same array.
    this.history.length = 0;
    for (const peer of this.#peers.values()) peer.hist = 0;
    if (newTracks) this.#recent = [];
    s.id = randomId();
    E.setPhase(s, 'lobby', Date.now());
    this.touch(true);
  }

  // A one-off snapshot for a page that asks again (after a resume).
  resend(pid: number) {
    const peer = this.#peers.get(pid);
    if (peer) {
      peer.hist = 0;
      this.#sendTo(pid);
    }
  }
}
