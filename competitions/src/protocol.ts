import type { CupState, RoundResult } from './state.ts';

export const VERSION = 1;

export type Action =
  | { a: 'role'; v: 'racer' | 'spectator' }
  | { a: 'ready' }
  | { a: 'vote'; v: number }
  | { a: 'ban' | 'pick'; v: string }
  | { a: 'skip' }
  | { a: 'watch'; v: number | null };

export type Msg =
  // Racer or spectator page to the organizer.
  | { k: 'hi'; v: number; key: string; role: 'racer' | 'spectator' }
  | { k: 't0'; a: number; rtt?: number }
  | { k: 'rdy'; s: number }
  | { k: 'fin'; n: number; t: number; f: number; rec?: string; af?: number; pb?: 1 }
  | { k: 'dnf'; n: number; t: number }
  | ({ k: 'act' } & Action)
  | { k: 'bump'; n: number; to?: number; from?: number; i: number[] }
  // Organizer to everyone.
  | { k: 'st'; s: CupState }
  | { k: 'hist'; from: number; rows: RoundResult[] }
  | { k: 't1'; a: number; h: number }
  | { k: 'you'; u: number }
  | { k: 'note'; text: string; tone?: 'good' | 'bad' | 'info' }
  | { k: 'bye'; why: string };
