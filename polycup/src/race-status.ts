import type { CupState, Phase } from './types.ts';
import { rulesFor } from './presets.ts';

export function downtimeLabel(
  phase: Phase | undefined,
  recovering = false,
  sameTrack = false,
): string {
  switch (phase) {
    case 'loading':
      return sameTrack ? 'Preparing next round…' : 'Changing track…';
    case 'between-rounds':
      return recovering ? 'Waiting for racers to reconnect…' : 'Waiting for the next round…';
    case 'registration':
      return 'Waiting for the cup to start…';
    default:
      return '';
  }
}

export function roundSeconds(state: CupState | null | undefined, now: number): number | null {
  const deadline = state?.runtime?.deadline;
  return state?.phase === 'racing' && deadline != null && Number.isFinite(deadline)
    ? Math.max(0, Math.ceil((deadline - now) / 1000))
    : null;
}

export function clock(seconds: number) {
  return seconds >= 60
    ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
    : `${seconds}s`;
}

// Not So Weekly Shorts: what the round clock is counting down to. The finish window starts when the
// first racer finishes; a time limit only shows in its last minute; a time-attack window always shows.
export function roundClock(state: CupState | null | undefined, now: number) {
  const run = state?.runtime;
  const seconds = roundSeconds(state, now);
  if (!state || !run || seconds === null) return null;
  if (rulesFor(state).roundStyle === 'time-attack')
    return { label: 'Time attack', seconds, text: clock(seconds), urgent: seconds <= 10 };
  const finishWindow = run.deadline !== (run.limitAt ?? null);
  if (finishWindow) return { label: 'Finish in', seconds, text: clock(seconds), urgent: seconds <= 3 };
  if (seconds > 60) return null;
  return { label: 'Time limit', seconds, text: clock(seconds), urgent: seconds <= 10 };
}
