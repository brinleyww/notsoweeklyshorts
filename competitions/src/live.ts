// Live timing from the car states the game already sends for every racer: checkpoint splits,
// running order and gaps, with no messages of its own.
import type { CarState, Connection, CarUpdate } from './game.ts';
import { rawCarUpdates } from './smooth.ts';

export interface Progress {
  cp: number;
  at: number;
  frames: number;
  speed: number;
  finished: number | null;
  started: boolean;
  controls: CarState['controls'] | null;
  splits: number[];
}

export class LiveTiming {
  #session: number | null = null;
  #cars = new Map<number, Progress & { resets: number }>();
  #connection: Connection | null = null;
  #listener: CarUpdate = rawCarUpdates((session, id, resets, state) => this.#update(session, id, resets, state));

  attach(connection: Connection | null) {
    if (connection === this.#connection) return;
    this.#connection?.removeCarUpdateCallback(this.#listener);
    this.#connection = connection;
    connection?.addCarUpdateCallback(this.#listener);
    this.#cars.clear();
  }

  setSession(session: number | null) {
    if (session === this.#session) return;
    this.#session = session;
    this.#cars.clear();
  }

  // A new round on the same track: everyone starts again.
  clear() {
    this.#cars.clear();
  }

  // When another racer's car last moved (for the relay pace).
  movedAt = 0;

  #update(session: number, id: number, resets: number, state: CarState) {
    if (!state) return;
    if (state.hasStarted && state.finishFrames == null) this.movedAt = performance.now();
    if (session !== this.#session) return;
    let car = this.#cars.get(id);
    if (!car || resets > car.resets) {
      car = { cp: 0, at: 0, frames: 0, speed: 0, finished: null, started: false, controls: null, splits: [], resets };
      this.#cars.set(id, car);
    } else if (resets < car.resets) return;
    if (state.frames < car.frames) return;
    this.#apply(car, state);
  }

  #apply(car: Progress, state: CarState) {
    const next = state.nextCheckpointIndex | 0;
    while (car.cp < next) {
      car.splits[car.cp] = state.frames;
      car.cp++;
      car.at = state.frames;
    }
    car.frames = state.frames;
    car.speed = state.speedKmh;
    car.started = state.hasStarted;
    car.finished = state.finishFrames;
    car.controls = state.controls;
  }

  #self: number | null = null;
  // The local car is read each frame (it is never sent back to us).
  local(id: number, state: CarState | null) {
    this.#self = id;
    if (!state) return;
    let car = this.#cars.get(id);
    if (!car || state.frames < car.frames) {
      car = { cp: 0, at: 0, frames: 0, speed: 0, finished: null, started: false, controls: null, splits: [], resets: 0 };
      this.#cars.set(id, car);
    }
    this.#apply(car, state);
  }

  clearLocal() {
    if (this.#self != null) this.#cars.delete(this.#self);
  }

  get(id: number): Progress | undefined {
    return this.#cars.get(id);
  }

  // Further along is better: more checkpoints, then the earlier time at the last one.
  score(id: number) {
    const c = this.#cars.get(id);
    if (!c) return -1;
    if (c.finished != null) return 1e9 - c.finished;
    return c.cp * 1e6 - Math.min(c.at, 999_999);
  }

  // Gap to whoever reached checkpoint cp first (frames), or null.
  gapAt(id: number, cp: number, among: number[]) {
    const mine = this.#cars.get(id)?.splits[cp];
    if (mine == null) return null;
    let best = mine;
    for (const other of among) {
      const t = this.#cars.get(other)?.splits[cp];
      if (t != null && t < best) best = t;
    }
    return mine - best;
  }
}
