import * as Cup from './cup.ts';
import { standings, updateLiveMovement } from './standings.ts';
import type { CupState } from './types.ts';

// Earlier benchmarks stay on the organizer. Snapshots carry at most eight
// current readings, even on tracks with many checkpoints.
export class CheckpointProgress {
  #round: string | null = null;
  #bests: Map<number, number> = new Map();

  constructor() {}
  record(
    state: CupState,
    id: number,
    index: number,
    frames: number,
    now: number,
    checkpointCount: number,
  ) {
    const run = state?.runtime;
    if (
      state?.phase !== 'racing' ||
      !run ||
      !Cup.activeIds(state).includes(id) ||
      Cup.roundDone(state, id) ||
      !Number.isSafeInteger(checkpointCount) ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= checkpointCount - 1 ||
      !Number.isSafeInteger(frames) ||
      frames <= 0 ||
      frames > 3600000 ||
      run.startsAt === null ||
      frames > now - run.startsAt + 2000 ||
      (run.deadline !== null && (now > run.deadline + 1500 || frames > run.deadline - run.startsAt))
    )
      return false;
    const previous = run.splits?.[id];
    if (previous && (index <= previous.index || frames < previous.frames)) return false;
    const key = `${state.id}:${run.id}`;
    if (this.#round !== key) {
      this.#round = key;
      this.#bests.clear();
    }
    const before = standings(state).map((r) => r.id);
    const bestFrames = Math.min(this.#bests.get(index) ?? Infinity, frames);
    this.#bests.set(index, bestFrames);
    (run.splits ??= {})[id] = { index, frames, bestFrames };
    // Delayed faster readings correct racers already on this checkpoint too.
    for (const split of Object.values(run.splits))
      if (split.index === index) split.bestFrames = bestFrames;
    updateLiveMovement(state, before);
    Cup.touch(state);
    return true;
  }
}
