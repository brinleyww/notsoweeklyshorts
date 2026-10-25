// The local racer's car during a cup: held at the line until GO, started on GO, times reported
// to the organizer, restarts handled by the cup's rules.
import type { App } from './app.ts';
import type { Car, Controls, Game } from './game.ts';
import { roundDone } from './state.ts';

const RETIRE_CONFIRM_MS = 2000;

const editing = (e: Event) =>
  e.composedPath().some((t) => {
    const el = t as HTMLElement;
    return ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable;
  });

// Driving keys held before GO, so a racer holding accelerate launches on GO.
class HeldKeys {
  #down = new Set<string>();
  bindings: Record<keyof Controls, (string | null)[]> = { up: [], right: [], down: [], left: [] };
  press(code: string) {
    this.#down.add(code);
  }
  release(code: string) {
    this.#down.delete(code);
  }
  clear() {
    this.#down.clear();
  }
  controls(): Controls {
    const held = (k: keyof Controls) => this.bindings[k].some((b) => !!b && this.#down.has(b));
    return { up: held('up'), right: held('right'), down: held('down'), left: held('left') };
  }
}

export class Driver {
  #key = '';
  #goCar: Car | null = null;
  #hooked = new WeakSet<Car>();
  offset = 0;
  #retireArmed = 0;
  held = new HeldKeys();
  #view: 0 | 1 | undefined;
  #sentFinish = '';
  // The racer's own best on this track, for the PB badge.
  #pb: number | null = null;
  #pbOf = '';
  attempt = 0;
  // This page's finished runs, for "Clip my best run".
  runs: { n: number; trackId: string; track: string; frames: number; attemptFrames: number; recording: string }[] = [];

  constructor(private app: App) {
    window.addEventListener('keydown', (e) => this.#keydown(e), { capture: true });
    window.addEventListener('keyup', (e) => this.held.release(e.code), { capture: true });
    window.addEventListener('blur', () => this.clearInput());
    document.addEventListener('visibilitychange', () => document.hidden && this.clearInput());
  }

  clearInput() {
    this.held.clear();
    const g = this.app.game;
    if (g && this.app.state) this.app.native.clearInput(g);
  }

  // The round this page drives in right now, if any.
  get racing() {
    const s = this.app.state,
      r = s?.round,
      me = this.app.me;
    if (!s || !r || me == null || !r.racers.includes(me)) return false;
    if (!['warmup', 'countdown', 'racing'].includes(s.phase)) return false;
    return this.app.info?.sessionId === r.session;
  }

  get done() {
    const s = this.app.state,
      me = this.app.me;
    return !!s && me != null && roundDone(s, me);
  }

  // True blocks the car's controls (the game's own check is OR-ed in).
  blocks(g: Game) {
    const s = this.app.state;
    if (!s || g !== this.app.game) return false;
    if (this.app.chatTyping) return true;
    if (s.phase === 'lobby') return false;
    if (!this.racing) return true;
    if (s.phase === 'warmup') return false;
    const r = s.round!,
      now = this.app.now();
    if (s.phase !== 'racing' && s.phase !== 'countdown') return true;
    if (r.startAt == null || now < r.startAt) return true;
    if (s.rules.style === 'timeattack') return r.endAt != null && now >= r.endAt;
    return this.done;
  }

  // True stops the game's own restart. Practice and time attack restart freely.
  blocksRestart(g: Game) {
    const s = this.app.state;
    if (!s || g !== this.app.game) return false;
    if (s.phase === 'lobby') return false;
    if (s.phase === 'warmup' && this.racing) {
      this.#afterReset();
      return false;
    }
    if (s.phase === 'racing' && this.racing && s.rules.style === 'timeattack' && !this.blocks(g)) {
      this.offset = 0;
      this.attempt++;
      return false;
    }
    return true;
  }

  #afterReset() {
    this.offset = 0;
    this.app.live.clearLocal();
  }

  frame(g: Game) {
    const app = this.app,
      s = app.state,
      info = app.info;
    if (!s || !info || info.disposed) return;
    const r = s.round;
    if (!r || !this.racing) {
      this.#key = '';
      return;
    }
    const key = `${r.n}.${r.try}.${s.phase === 'warmup' ? 'w' : 'r'}`;
    if (key !== this.#key) {
      this.#key = key;
      this.#goCar = null;
      this.offset = 0;
      this.attempt = 0;
      this.#sentFinish = '';
      if (this.#pbOf !== r.track.id) {
        this.#pb = app.native.personalBest(r.track.id);
        this.#pbOf = r.track.id;
      }
      this.#view ??= app.native.drivingView(g);
      app.native.reset(g);
      app.native.resetRoundBest?.(g);
      if (app.connection) app.native.clearRecords(app.connection);
      app.native.release(g, this.#view);
      app.refreshInfo();
      app.live.clearLocal();
    }
    const car = app.info!.car;
    if (!this.#hooked.has(car)) {
      this.#hooked.add(car);
      car.addFinishCallback(() => this.#finished(car));
      car.addCheckpointCallback(() => {
        const frames = car.getTime().numberOfFrames + this.offset;
        if (this.offset > 0 && app.game) app.native.showRoundCheckpoint(app.game, frames);
        // Other cars arrive about 0.6 s late, so the comparison waits for them.
        const index = car.getNextCheckpointIndex() - 1,
          key = this.#key;
        setTimeout(() => key === this.#key && this.#split(index, frames), 700);
      });
    }
    if (s.phase === 'warmup') return;
    const now = app.now();
    if (r.startAt != null && now >= r.startAt && (s.phase === 'racing' || s.phase === 'countdown') && !this.#goCar) {
      this.#goCar = car;
      this.held.bindings = app.native.drivingBindings(g);
      app.native.release(g, this.#view);
      app.native.applyDrivingInput(g, this.held.controls());
      // A late frame (a busy or hidden tab) still counts from GO. Time attack runs are timed on their own.
      this.offset = s.rules.style === 'timeattack' ? 0 : Math.max(0, Math.floor(now - r.startAt) - car.getTime().numberOfFrames);
      car.start();
      app.native.sound('go');
    }
    if (this.offset > 0 && !car.hasFinished()) app.native.showRoundTime(g, car.getTime().numberOfFrames + this.offset);
  }

  // Where this racer stands at a checkpoint, against everyone who already passed it.
  #split(index: number, frames: number) {
    const app = this.app,
      s = app.state,
      r = s?.round;
    if (!s || !r || s.phase !== 'racing' || !this.racing || index < 0 || app.info == null) return;
    let place = 1,
      best: number | null = null;
    for (const u of r.racers) {
      const pid = s.players.find((p) => p.u === u)?.pid;
      if (pid == null || pid === app.selfPid) continue;
      const t = app.live.get(pid)?.splits[index];
      if (t == null) continue;
      if (t < frames) place++;
      if (best == null || t < best) best = t;
    }
    app.split = { cp: index + 1, total: Math.max(1, app.info.checkpointCount - 1), place, gap: best == null ? null : frames - best, at: performance.now() };
    app.changed();
  }

  #finished(car: Car) {
    const app = this.app,
      s = app.state,
      r = s?.round;
    if (!s || !r || !this.racing || s.phase !== 'racing' || app.info?.car !== car) return;
    const own = (car.getFinishTime() ?? car.getTime()).numberOfFrames;
    const frames = own + this.offset;
    const tag = `${r.n}.${r.try}.${this.attempt}`;
    if (this.#sentFinish === tag) return;
    this.#sentFinish = tag;
    let recording: string | undefined;
    if (!s.rules.collisions) {
      try {
        const text = car.getRecording()?.serialize();
        if (text && text.length <= 100_000) recording = text;
      } catch {}
    }
    if (recording) {
      this.runs = this.runs.filter((x) => !(x.n === r.n && x.frames > frames)).slice(-40);
      if (!this.runs.some((x) => x.n === r.n)) this.runs.push({ n: r.n, trackId: r.track.id, track: r.track.name, frames, attemptFrames: own, recording });
    }
    if (this.offset > 0 && app.game) app.native.showRoundFinish(app.game, frames);
    const pb = !s.rules.collisions && this.#pb != null && own < this.#pb;
    if (pb) this.#pb = own;
    app.report({ k: 'fin', n: r.n, t: r.try, f: frames, rec: recording, af: own, ...(pb ? { pb: 1 as const } : {}) });
  }

  #keydown(e: KeyboardEvent) {
    const app = this.app,
      g = app.game,
      s = app.state;
    if (!s || !g || app.chatTyping || editing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    this.held.press(e.code);
    if (app.watch.freecamKey(e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (!this.racing || s.phase !== 'racing' || s.rules.style === 'timeattack' || this.done) return;
    const r = s.round!;
    if (r.startAt == null || app.now() < r.startAt) return;
    if (app.native.restartPressed(g, e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat) return;
      if (Date.now() - this.#retireArmed > RETIRE_CONFIRM_MS) {
        this.#retireArmed = Date.now();
        this.#restartRun(g, r.startAt);
        app.notify('Run restarted. Press restart again to retire', 'bad');
        return;
      }
      this.#retireArmed = 0;
      app.report({ k: 'dnf', n: r.n, t: r.try });
      return;
    }
    // Respawning with no checkpoint yet restarts the car, and the clock keeps running.
    if (app.native.startRespawnPressed(g, e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat) return;
      this.#restartRun(g, r.startAt);
    }
  }

  // Back to the start line with the race clock still running.
  #restartRun(g: Game, startAt: number) {
    const app = this.app;
    const elapsed = Math.floor(app.now() - startAt);
    app.native.reset(g);
    app.refreshInfo();
    app.live.clearLocal();
    this.offset = elapsed;
    this.#goCar = app.info!.car;
    app.native.applyDrivingInput(g, this.held.controls());
    app.info!.car.start();
  }

  // The camera the racer drives with, carried into the next round.
  rememberView(g: Game) {
    const s = this.app.state;
    if (!this.racing || this.done || this.app.info?.spectator.isEnabled || (s?.phase !== 'racing' && s?.phase !== 'warmup')) return;
    this.#view = this.app.native.drivingView(g);
  }
}
