export const PRODUCT = 'Cuppa';
export const MAX_RACERS = 25;

export type Mode = 'points' | 'rounds' | 'knockout';
export type Style = 'race' | 'timeattack';
export type NextTrack = 'random' | 'vote' | 'winner' | 'last' | 'host';
export type Limit = 'auto' | 'fixed' | 'off';
export type WarmupMode = 'off' | 'first' | 'every';
export type WarmupTiming = 'fixed' | 'wr';

export interface Rules {
  mode: Mode;
  target: number;
  // Points mode: reaching the target makes a racer a finalist, who must then win a round.
  finalist: boolean;
  rounds: number;
  knockout: number;
  points: number[];
  perTrack: number;
  // Before the first round every racer bans and then picks tracks; the cup plays the picks.
  draft: boolean;
  bans: number;
  picks: number;
  style: Style;
  taSeconds: number;
  limit: Limit;
  limitSeconds: number;
  finishWindow: number;
  next: NextTrack;
  warmupMode: WarmupMode;
  warmupTiming: WarmupTiming;
  warmup: number;
  warmupMult: number;
  warmupMin: number;
  readyEnds: boolean;
  breakSeconds: number;
  countdownSeconds: number;
  voteSeconds: number;
  draftSeconds: number;
  // Racers can vote to skip the track being raced; more than half skips it.
  skipVotes: boolean;
  collisions: boolean;
  lateJoin: boolean;
  freecam: boolean;
  uploads: boolean;
}

export interface Format {
  id: string;
  name: string;
  icon: string;
  blurb: string;
  rules: Rules;
}

export type PointsCurve = 'log' | 'f1' | 'linear' | 'flat';

// Points for every place from 1st to 25th. "log" falls with the log of the place, "f1" keeps
// Formula 1's shape for the top 8, "linear" falls evenly, "flat" gives everyone the same.
export function pointsCurve(kind: PointsCurve, top: number, last: number): number[] {
  top = Math.max(1, Math.round(top));
  last = Math.max(0, Math.min(top, Math.round(last)));
  // 70% a log fall and 30% an even one, so the top places are a little closer together.
  const log = (hi: number, lo: number, from = 1) =>
    Array.from({ length: MAX_RACERS - from + 1 }, (_, i) => {
      const curve = Math.log((from + i) / from) / Math.log(MAX_RACERS / from);
      const even = i / (MAX_RACERS - from);
      return Math.round(hi - (hi - lo) * (0.7 * curve + 0.3 * even));
    });
  if (kind === 'flat') return Array(MAX_RACERS).fill(top);
  if (kind === 'linear') return Array.from({ length: MAX_RACERS }, (_, i) => Math.round(top - ((top - last) * i) / (MAX_RACERS - 1)));
  if (kind === 'f1') {
    const head = [1, 0.72, 0.6, 0.48, 0.4, 0.32, 0.24].map((f) => Math.round(top * f));
    return [...head, ...log(Math.max(last, Math.round(top * 0.16)), last, 8)];
  }
  return log(top, last);
}

// 1st gets 200 and the points fall along that curve, so 25th still gets 10.
export const DEFAULT_POINTS = pointsCurve('log', 200, 10);
export const F1_POINTS = pointsCurve('f1', 200, 10);

const base: Rules = {
  mode: 'points',
  target: 2000,
  finalist: false,
  rounds: 10,
  knockout: 1,
  points: DEFAULT_POINTS,
  perTrack: 3,
  draft: false,
  bans: 1,
  picks: 1,
  style: 'race',
  taSeconds: 180,
  limit: 'auto',
  limitSeconds: 240,
  finishWindow: 10,
  next: 'random',
  warmupMode: 'off',
  warmupTiming: 'fixed',
  warmup: 60,
  warmupMult: 1.5,
  warmupMin: 30,
  readyEnds: true,
  breakSeconds: 8,
  countdownSeconds: 3,
  voteSeconds: 15,
  draftSeconds: 30,
  skipVotes: true,
  collisions: false,
  lateJoin: true,
  freecam: true,
  uploads: false,
};

const format = (id: string, name: string, icon: string, blurb: string, rules: Partial<Rules>): Format => ({
  id,
  name,
  icon,
  blurb,
  rules: { ...base, ...rules, points: [...(rules.points ?? base.points)] },
});

export const FORMATS: Format[] = [
  format('quickplay', 'Quickplay', 'bolt', 'Random tracks, three rounds each. First to 2000 points wins.', {}),
  format('sprint', 'Sprint', 'flag', 'One round per track, and everyone votes on the next one. First to 1200.', {
    perTrack: 1,
    target: 1200,
    next: 'vote',
  }),
  format('championship', 'Championship', 'calendar', 'A fixed season of 8 rounds on voted tracks. Most points wins.', {
    mode: 'rounds',
    rounds: 8,
    perTrack: 1,
    next: 'vote',
  }),
  format('formula', 'Formula', 'podium', 'F1-style points: winning is worth far more than placing. First to 1200.', {
    perTrack: 2,
    target: 1200,
    points: F1_POINTS,
  }),
  format('draft', 'Pick & Ban', 'crown', 'Like ranked: everyone bans a track, then picks one. The cup plays the picks. First to 1200.', {
    perTrack: 2,
    target: 1200,
    draft: true,
    bans: 1,
    picks: 1,
    lateJoin: false,
    warmupMode: 'first',
    warmupTiming: 'wr',
    warmup: 60,
    warmupMult: 1.5,
    warmupMin: 30,
  }),
  format('knockout', 'Knockout', 'skull', 'The slowest racer is out after every round, until one is left.', {
    mode: 'knockout',
    perTrack: 2,
    next: 'last',
    lateJoin: false,
  }),
  format('timeattack', 'Time Attack', 'stopwatch', 'Three minutes per track. Unlimited tries, your best lap counts.', {
    style: 'timeattack',
    perTrack: 1,
    target: 1000,
    next: 'vote',
  }),
  format('bumper', 'Bumper Cars', 'burst', 'Cars collide! Shove your rivals off the road. First to 1200.', {
    collisions: true,
    target: 1200,
  }),
];

export const formatById = (id: string) => FORMATS.find((f) => f.id === id) ?? null;

const int = (v: unknown, min: number, max: number, fallback: number) =>
  Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max ? (v as number) : fallback;
const num = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? Math.round(v * 10) / 10 : fallback;
const pick = <T extends string>(v: unknown, options: readonly T[], fallback: T) =>
  options.includes(v as T) ? (v as T) : fallback;
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);

// Rules from anywhere (a saved preset, the organizer's state) clamped into something playable.
export function cleanRules(value: unknown): Rules {
  const o = (value && typeof value === 'object' ? value : {}) as Partial<Rules> & { mode?: string };
  let points = Array.isArray(o.points) ? o.points.slice(0, MAX_RACERS).map((n) => int(n, 0, 10000, 0)) : base.points;
  if (!points.length || points[0] <= 0) points = base.points;
  points = [...points];
  while (points.length < MAX_RACERS) points.push(points[points.length - 1]);
  for (let i = 1; i < points.length; i++) points[i] = Math.min(points[i], points[i - 1]);
  // Presets from before the finalist switch stored it as its own mode.
  const finals = (o as { mode?: string }).mode === 'finals';
  const warmupMode = pick(o.warmupMode, ['off', 'first', 'every'] as const, typeof o.warmup === 'number' && o.warmup > 0 && !o.warmupMode ? 'first' : base.warmupMode);
  const r: Rules = {
    mode: finals ? 'points' : pick(o.mode, ['points', 'rounds', 'knockout'] as const, base.mode),
    target: int(o.target, 1, 100000, base.target),
    finalist: finals || bool(o.finalist, base.finalist),
    rounds: int(o.rounds, 1, 100, base.rounds),
    knockout: int(o.knockout, 1, 8, base.knockout),
    points,
    perTrack: int(o.perTrack, 1, 30, base.perTrack),
    draft: bool(o.draft, base.draft),
    bans: int(o.bans, 0, 3, base.bans),
    picks: int(o.picks, 1, 3, base.picks),
    style: pick(o.style, ['race', 'timeattack'] as const, base.style),
    taSeconds: int(o.taSeconds, 30, 1800, base.taSeconds),
    limit: pick(o.limit, ['auto', 'fixed', 'off'] as const, base.limit),
    limitSeconds: int(o.limitSeconds, 30, 1800, base.limitSeconds),
    finishWindow: int(o.finishWindow, 0, 300, base.finishWindow),
    next: pick(o.next, ['random', 'vote', 'winner', 'last', 'host'] as const, base.next),
    warmupMode,
    warmupTiming: pick(o.warmupTiming, ['fixed', 'wr'] as const, base.warmupTiming),
    warmup: int(o.warmup, 10, 600, base.warmup),
    warmupMult: num(o.warmupMult, 0.5, 5, base.warmupMult),
    warmupMin: int(o.warmupMin, 10, 300, base.warmupMin),
    readyEnds: bool(o.readyEnds, base.readyEnds),
    breakSeconds: int(o.breakSeconds, 3, 60, base.breakSeconds),
    countdownSeconds: int(o.countdownSeconds, 3, 10, base.countdownSeconds),
    voteSeconds: int(o.voteSeconds, 5, 60, base.voteSeconds),
    draftSeconds: int(o.draftSeconds, 10, 120, base.draftSeconds),
    skipVotes: bool(o.skipVotes, base.skipVotes),
    collisions: bool(o.collisions, base.collisions),
    lateJoin: bool(o.lateJoin, base.lateJoin),
    freecam: bool(o.freecam, base.freecam),
    uploads: bool(o.uploads, base.uploads),
  };
  if (r.collisions) r.uploads = false;
  if (r.mode === 'knockout') r.lateJoin = false;
  if (r.mode !== 'points') r.finalist = false;
  return r;
}

export function rulesSummary(r: Rules) {
  const goal =
    r.mode === 'rounds'
      ? `${r.rounds} rounds, most points wins`
      : r.mode === 'knockout'
        ? `Knockout: ${r.knockout} out per round`
        : r.finalist
          ? `Finalist at ${r.target} pts, then win a round`
          : `First to ${r.target} pts`;
  const style = r.style === 'timeattack' ? `${fmtDuration(r.taSeconds)} time attack` : 'one run per round';
  const tracks = r.perTrack === 1 ? '1 round per track' : `${r.perTrack} rounds per track`;
  return [goal, style, tracks, r.draft ? 'drafted tracks' : NEXT_LABEL[r.next]].join(' · ');
}

export const NEXT_LABEL: Record<NextTrack, string> = {
  random: 'random tracks',
  vote: 'tracks voted',
  winner: 'winner picks',
  last: 'last place picks',
  host: 'organizer picks',
};

export function fmtDuration(seconds: number) {
  const m = Math.floor(seconds / 60),
    s = seconds % 60;
  return m ? (s ? `${m}:${String(s).padStart(2, '0')} min` : `${m} min`) : `${s} s`;
}

export interface SavedPreset {
  name: string;
  rules: Rules;
}
const PRESETS_KEY = 'nsws-sc-presets';
export function savedPresets(): SavedPreset[] {
  try {
    const list = JSON.parse(localStorage.getItem(PRESETS_KEY) ?? '[]');
    return Array.isArray(list)
      ? list
          .filter((p) => p && typeof p.name === 'string' && p.name.trim())
          .slice(0, 20)
          .map((p) => ({ name: String(p.name).slice(0, 40), rules: cleanRules(p.rules) }))
      : [];
  } catch {
    return [];
  }
}
export function savePreset(name: string, rules: Rules) {
  const list = savedPresets().filter((p) => p.name.toLowerCase() !== name.toLowerCase());
  list.unshift({ name: name.slice(0, 40), rules });
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(list.slice(0, 20)));
  } catch {}
}
export function deletePreset(name: string) {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(savedPresets().filter((p) => p.name !== name)));
  } catch {}
}

// A preset as text to share (copy and paste), and back.
export function presetText(name: string, rules: Rules) {
  return JSON.stringify({ cuppa: 1, name, rules });
}
export function parsePresetText(text: string): SavedPreset {
  if (text.length > 20000) throw new Error('That preset is too long.');
  let value: { name?: unknown; rules?: unknown } | null = null;
  try {
    value = JSON.parse(text);
  } catch {}
  if (!value || typeof value !== 'object' || !value.rules || typeof value.rules !== 'object') throw new Error("That isn't a Cuppa preset.");
  const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim().slice(0, 40) : 'Imported preset';
  const old = (value as { format?: unknown }).format === 'polycup-preset';
  return { name, rules: old ? fromOldRules(value.rules as Record<string, unknown>) : cleanRules(value.rules) };
}

// Rules saved by the old cup mode (PolyCup presets, "polycup-presets-v1") in today's shape.
export function fromOldRules(o: Record<string, unknown>): Rules {
  const knockout = typeof o.knockout === 'number' && o.knockout > 0 ? o.knockout : 0;
  const warm = o.warmup === 'every-visit' ? 'every' : o.warmup === 'first-visit' ? 'first' : 'off';
  return cleanRules({
    mode: knockout ? 'knockout' : 'points',
    knockout: knockout || 1,
    target: o.pointsToWin,
    finalist: o.finalist,
    points: o.points,
    perTrack: o.roundsPerTrack,
    draft: o.selection === 'draft',
    bans: o.bansPerRacer,
    picks: o.picksPerRacer || 1,
    style: o.roundStyle === 'time-attack' ? 'timeattack' : 'race',
    taSeconds: o.timeAttackSeconds,
    limit: o.roundTimeLimit,
    limitSeconds: o.roundTimeSeconds,
    finishWindow: o.finishTimeoutSeconds,
    next: o.nextTrack,
    warmupMode: warm,
    warmupTiming: o.warmupTiming === 'wr' ? 'wr' : 'fixed',
    warmup: o.warmupSeconds,
    warmupMult: o.warmupMultiplier,
    warmupMin: o.warmupMinimumSeconds,
    readyEnds: o.readyEndsWarmup,
    breakSeconds: o.roundBreakSeconds,
    collisions: o.collisions,
    lateJoin: o.allowRacerChanges,
    freecam: o.allowSpectatorFreecam,
    uploads: o.uploadLeaderboardTimes,
  } as unknown as Rules);
}

// Old saved presets show up among the organizer's own, once.
export function importOldPresets() {
  try {
    if (localStorage.getItem('nsws-sc-presets-imported')) return;
    localStorage.setItem('nsws-sc-presets-imported', '1');
    const old = JSON.parse(localStorage.getItem('polycup-presets-v1') ?? '[]');
    if (!Array.isArray(old)) return;
    for (const p of old.slice(0, 20))
      if (p && typeof p.name === 'string' && p.rules && typeof p.rules === 'object') savePreset(p.name, fromOldRules(p.rules));
  } catch {}
}
