// Watching a round: the camera rides another racer's car (the game's own chase or cockpit
// camera on that car), picked by hand or by the director, or flies free.
import type { App } from './app.ts';
import type { Game } from './game.ts';
import { player, roundDone } from './state.ts';

export type WatchMode = 'director' | 'follow' | 'free';
const DIRECTOR_DWELL_MS = 6000;

export class Spectate {
  mode: WatchMode = 'director';
  target: number | null = null;
  cockpit = false;
  #switchedAt = 0;
  #following: Game | null = null;
  #freeGame: Game | null = null;
  #manual = '';
  ghostsHidden = false;

  constructor(private app: App) {}

  // Racers (by game id) who can be watched now.
  watchable() {
    const app = this.app,
      s = app.state,
      r = s?.round;
    if (!s || !r || !['countdown', 'racing', 'checking'].includes(s.phase)) return [];
    const ids: number[] = [];
    for (const u of r.racers) {
      const p = player(s, u);
      if (!p || p.pid == null || p.away || u === app.me) continue;
      if (s.phase !== 'checking' && roundDone(s, u)) continue;
      ids.push(p.pid);
    }
    return ids;
  }

  get active() {
    const app = this.app,
      s = app.state;
    if (!s || !app.game || !app.info || app.info.disposed) return false;
    if (s.round?.session !== app.info.sessionId) return false;
    if (!['countdown', 'racing'].includes(s.phase)) return false;
    if (app.driver.racing && !app.driver.done) return false;
    if (app.driver.racing && app.driver.done && !(app.native.autoSpectate() || this.#manual === `${s.round!.n}.${s.round!.try}`))
      return false;
    return this.mode === 'free' ? s.rules.freecam : this.watchable().length > 0;
  }

  watchNow() {
    const r = this.app.state?.round;
    if (r) this.#manual = `${r.n}.${r.try}`;
    this.app.changed();
  }

  setMode(mode: WatchMode) {
    if (mode === 'free' && !this.app.state?.rules.freecam) {
      this.app.notify('The organizer turned off the free camera', 'bad');
      return;
    }
    this.mode = mode;
    this.#freeGame = null;
    this.#switchedAt = 0;
    this.app.changed();
  }

  cycle(delta: number) {
    const ids = this.watchable();
    if (!ids.length) return;
    const i = this.target == null ? -1 : ids.indexOf(this.target);
    this.follow(ids[(i + delta + ids.length) % ids.length]);
  }

  follow(pid: number) {
    this.mode = 'follow';
    this.target = pid;
    this.#freeGame = null;
    this.app.changed();
  }

  #director(ids: number[]) {
    const live = this.app.live;
    const now = performance.now();
    const current = this.target != null && ids.includes(this.target) ? this.target : null;
    if (current != null && now - this.#switchedAt < DIRECTOR_DWELL_MS) return current;
    let best = ids[0];
    for (const id of ids) if (live.score(id) > live.score(best)) best = id;
    // Stay on a close fight: keep the current car if it is within a second of the best.
    if (current != null) {
      const a = live.get(current),
        b = live.get(best);
      if (a && b && a.cp === b.cp && Math.abs(a.at - b.at) < 1000) best = current;
    }
    if (best !== this.target) this.#switchedAt = now;
    return best;
  }

  frame(g: Game, dt: number) {
    const app = this.app;
    if (this.mode === 'free' && app.state && !app.state.rules.freecam) {
      this.mode = 'director';
      this.#freeGame = null;
    }
    if (!this.active) {
      if (this.#following === g || this.#freeGame === g) {
        app.native.release(g, undefined);
        this.#following = null;
        this.#freeGame = null;
      }
      return;
    }
    if (this.mode === 'free') {
      if (this.#freeGame !== g) {
        app.native.enterFreecam(g);
        this.#freeGame = g;
      }
      this.#following = null;
      return;
    }
    const ids = this.watchable();
    if (this.mode === 'director') {
      const next = this.#director(ids);
      if (next !== this.target) {
        this.target = next;
        app.changed();
      }
    } else if (this.target == null || !ids.includes(this.target)) {
      this.target = ids[0] ?? null;
      app.changed();
    }
    if (this.target != null && app.native.followCar(g, this.target, this.cockpit, dt)) this.#following = g;
  }

  freecamKey(e: KeyboardEvent) {
    const app = this.app;
    if (!app.game || !app.state || !this.active && !(app.driver.done && app.driver.racing)) return false;
    if (!app.native.freecamPressed(app.game, e)) return false;
    if (!e.repeat) this.setMode(this.mode === 'free' ? 'director' : 'free');
    return true;
  }
}
