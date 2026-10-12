import type { Rules } from './rules.ts';

export type Phase =
  | 'lobby'
  | 'loading'
  | 'warmup'
  | 'countdown'
  | 'racing'
  | 'checking'
  | 'results'
  | 'vote'
  | 'podium';

export type Category = 'official' | 'community' | 'custom';

export interface TrackRef {
  id: string;
  name: string;
  author?: string;
  cat: Category;
}

export interface Player {
  u: number;
  pid: number | null;
  name: string;
  cc: string | null;
  role: 'racer' | 'spectator';
  pts: number;
  wins: number;
  // Finishes per place (1st..8th), for countback on equal points.
  places: number[];
  out?: number;
  fin?: 1;
  away?: 1;
  ready?: 1;
  best?: number;
}

export interface Run {
  f: number;
  a?: number;
  chk?: 0 | 1 | 2;
}

export interface Round {
  n: number;
  k: number;
  try: number;
  session: number | null;
  track: TrackRef;
  racers: number[];
  startAt: number | null;
  endAt: number | null;
  closeAt: number | null;
  warmupUntil: number | null;
  runs: Record<number, Run>;
  dnf: number[];
}

// [uid, frames or null for no finish, place or null, points earned, knocked out]
export type ResultRow = [number, number | null, number | null, number, 0 | 1];
export interface RoundResult {
  n: number;
  track: string;
  ta: 0 | 1;
  rows: ResultRow[];
  void?: 1;
}

export interface Vote {
  kind: 'vote' | 'winner' | 'last' | 'host';
  opts: TrackRef[];
  until: number;
  ballots: Record<number, number>;
  picker: number | null;
}

export interface CupState {
  v: 1;
  id: string;
  name: string;
  seq: number;
  format: string;
  rules: Rules;
  phase: Phase;
  phaseAt: number;
  nextAt: number | null;
  hold: boolean;
  host: number;
  players: Player[];
  round: Round | null;
  vote: Vote | null;
  winner: number | null;
  shout: { text: string; at: number } | null;
  rounds: number;
}

export const LIVE_PHASES: Phase[] = ['warmup', 'countdown', 'racing'];

export function player(s: CupState, u: number | null | undefined) {
  return u == null ? undefined : s.players.find((p) => p.u === u);
}
export function byPid(s: CupState, pid: number | null | undefined) {
  return pid == null ? undefined : s.players.find((p) => p.pid === pid);
}

export function roundDone(s: CupState, u: number) {
  const r = s.round;
  if (!r || !r.racers.includes(u)) return true;
  if (r.dnf.includes(u)) return true;
  return s.rules.style !== 'timeattack' && u in r.runs;
}

// Equal points are split by countback: more wins, then more 2nds, and so on, then the better
// place in the latest round. Knocked-out racers rank below everyone still in, later exits higher.
export function standings(s: CupState, history: RoundResult[] = []): Player[] {
  const last = new Map<number, number>();
  const latest = history.findLast((h) => !h.void);
  for (const row of latest?.rows ?? []) if (row[2] != null) last.set(row[0], row[2]);
  const ranked = s.players.filter((p) => p.role === 'racer' || p.pts > 0 || p.out || p.wins);
  return ranked.sort((a, b) => {
    if (s.winner != null) {
      if (a.u === s.winner) return -1;
      if (b.u === s.winner) return 1;
    }
    if (s.rules.mode === 'knockout') {
      const ao = a.out ?? Infinity,
        bo = b.out ?? Infinity;
      if (ao !== bo) return bo - ao;
    }
    if (s.rules.mode === 'finals' && !!a.fin !== !!b.fin) return a.fin ? -1 : 1;
    if (b.pts !== a.pts) return b.pts - a.pts;
    for (let i = 0; i < 8; i++) if ((b.places[i] ?? 0) !== (a.places[i] ?? 0)) return (b.places[i] ?? 0) - (a.places[i] ?? 0);
    return (last.get(a.u) ?? 99) - (last.get(b.u) ?? 99);
  });
}

// Live order of a round: finishers by time, then everyone else.
export function roundOrder(s: CupState) {
  const r = s.round;
  if (!r) return [];
  const finished = r.racers
    .filter((u) => r.runs[u] && r.runs[u].chk !== 2)
    .sort((a, b) => r.runs[a].f - r.runs[b].f);
  return finished;
}

export function placeOf(r: Round, u: number) {
  const mine = r.runs[u];
  if (!mine || mine.chk === 2) return null;
  let place = 1;
  for (const v of r.racers) {
    const other = r.runs[v];
    if (v !== u && other && other.chk !== 2 && other.f < mine.f) place++;
  }
  return place;
}
