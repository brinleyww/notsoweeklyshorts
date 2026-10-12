export const PRODUCT = 'Cuppa';
export const MAX_RACERS = 25;

export type Mode = 'points' | 'rounds' | 'finals' | 'knockout';
export type Style = 'race' | 'timeattack';
export type NextTrack = 'random' | 'vote' | 'winner' | 'last' | 'host';
export type Limit = 'auto' | 'fixed' | 'off';

export interface Rules {
  mode: Mode;
  target: number;
  rounds: number;
  knockout: number;
  points: number[];
  perTrack: number;
  style: Style;
  taSeconds: number;
  limit: Limit;
  limitSeconds: number;
  finishWindow: number;
  next: NextTrack;
  warmup: number;
  breakSeconds: number;
  collisions: boolean;
  lateJoin: boolean;
  freecam: boolean;
  uploads: boolean;
  customTracks: boolean;
}

export interface Format {
  id: string;
  name: string;
  icon: string;
  blurb: string;
  rules: Rules;
}

const logPoints = (top: number, last: number, from = 1) =>
  Array.from({ length: MAX_RACERS - from + 1 }, (_, i) =>
    Math.round(top - ((top - last) * Math.log((from + i) / from)) / Math.log(MAX_RACERS / from)),
  );
// 1st gets 200 and the points fall with the log of the place, so 25th still gets 10.
export const DEFAULT_POINTS = logPoints(200, 10);
export const F1_POINTS = [200, 144, 120, 96, 80, 64, 48, ...logPoints(32, 10, 8)];

const base: Rules = {
  mode: 'points',
  target: 2000,
  rounds: 10,
  knockout: 1,
  points: DEFAULT_POINTS,
  perTrack: 3,
  style: 'race',
  taSeconds: 180,
  limit: 'auto',
  limitSeconds: 240,
  finishWindow: 30,
  next: 'random',
  warmup: 0,
  breakSeconds: 8,
  collisions: false,
  lateJoin: true,
  freecam: true,
  uploads: false,
  customTracks: false,
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
  format('finals', 'Cup Finals', 'crown', 'Reach 1200 points to become a finalist, then win a round to take the cup.', {
    mode: 'finals',
    target: 1200,
  }),
  format('knockout', 'Knockout', 'skull', 'The slowest racer is out after every round, until one is left.', {
    mode: 'knockout',
    perTrack: 2,
    next: 'last',
    lateJoin: false,
    finishWindow: 20,
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
const pick = <T extends string>(v: unknown, options: readonly T[], fallback: T) =>
  options.includes(v as T) ? (v as T) : fallback;
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);

// Rules from anywhere (a saved preset, the organizer's state) clamped into something playable.
export function cleanRules(value: unknown): Rules {
  const o = (value && typeof value === 'object' ? value : {}) as Partial<Rules>;
  let points = Array.isArray(o.points) ? o.points.slice(0, MAX_RACERS).map((n) => int(n, 0, 10000, 0)) : base.points;
  if (!points.length || points[0] <= 0) points = base.points;
  while (points.length < MAX_RACERS) points.push(points[points.length - 1]);
  for (let i = 1; i < points.length; i++) points[i] = Math.min(points[i], points[i - 1]);
  const r: Rules = {
    mode: pick(o.mode, ['points', 'rounds', 'finals', 'knockout'] as const, base.mode),
    target: int(o.target, 1, 100000, base.target),
    rounds: int(o.rounds, 1, 100, base.rounds),
    knockout: int(o.knockout, 1, 8, base.knockout),
    points,
    perTrack: int(o.perTrack, 1, 20, base.perTrack),
    style: pick(o.style, ['race', 'timeattack'] as const, base.style),
    taSeconds: int(o.taSeconds, 30, 1800, base.taSeconds),
    limit: pick(o.limit, ['auto', 'fixed', 'off'] as const, base.limit),
    limitSeconds: int(o.limitSeconds, 30, 1800, base.limitSeconds),
    finishWindow: int(o.finishWindow, 0, 300, base.finishWindow),
    next: pick(o.next, ['random', 'vote', 'winner', 'last', 'host'] as const, base.next),
    warmup: int(o.warmup, 0, 600, base.warmup),
    breakSeconds: int(o.breakSeconds, 4, 60, base.breakSeconds),
    collisions: bool(o.collisions, base.collisions),
    lateJoin: bool(o.lateJoin, base.lateJoin),
    freecam: bool(o.freecam, base.freecam),
    uploads: bool(o.uploads, base.uploads),
    customTracks: bool(o.customTracks, base.customTracks),
  };
  if (r.collisions) r.uploads = false;
  if (r.mode === 'knockout') r.lateJoin = false;
  return r;
}

export function rulesSummary(r: Rules) {
  const goal =
    r.mode === 'rounds'
      ? `${r.rounds} rounds, most points wins`
      : r.mode === 'knockout'
        ? `Knockout: ${r.knockout} out per round`
        : r.mode === 'finals'
          ? `Finalist at ${r.target} pts, then win a round`
          : `First to ${r.target} pts`;
  const style = r.style === 'timeattack' ? `${fmtDuration(r.taSeconds)} time attack` : 'one run per round';
  const tracks = r.perTrack === 1 ? '1 round per track' : `${r.perTrack} rounds per track`;
  return [goal, style, tracks, NEXT_LABEL[r.next]].join(' · ');
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
