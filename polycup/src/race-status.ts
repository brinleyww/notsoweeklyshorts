import type { CupState, Phase } from './types.ts';

export function downtimeLabel(
  phase: Phase | undefined,
  recovering = false,
  sameTrack = false,
): string {
  switch (phase) {
    case 'loading':
      return sameTrack ? 'Preparing next round...' : 'Changing track...';
    case 'warmup':
      return 'Warmup';
    case 'between-rounds':
      return recovering ? 'Waiting for reconnect...' : 'Waiting for next round...';
    case 'registration':
      return 'Waiting for Cup to start...';
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
