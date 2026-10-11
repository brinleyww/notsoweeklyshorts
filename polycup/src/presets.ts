import type { CupState } from './types.ts';

export type TrackCategory = 'official' | 'community' | 'custom';
export interface CupRules {
  allowRacerChanges: boolean;
  allowSpectatorFreecam?: boolean;
  uploadLeaderboardTimes?: boolean;
  roundsPerTrack: number;
  pointsToWin: number;
  finalist: boolean;
  points: number[];
  selection: 'draft' | 'random';
  bansPerRacer: number;
  picksPerRacer: number;
  pool: TrackCategory[];
  warmup: 'off' | 'first-visit' | 'every-visit';
  warmupTiming: 'wr' | 'fixed';
  warmupSeconds: number;
  warmupMultiplier: number;
  warmupMinimumSeconds: number;
  readyEndsWarmup: boolean;
  finishTimeoutSeconds: number;
  roundBreakSeconds: number;
  // Not So Weekly Shorts: the options below are optional so presets saved before them still load.
  roundTimeLimit?: 'auto' | 'off' | 'fixed';
  roundTimeSeconds?: number;
  nextTrack?: 'random' | 'vote' | 'winner' | 'last';
  knockout?: number;
  roundStyle?: 'single' | 'time-attack';
  timeAttackSeconds?: number;
  collisions?: boolean;
}
export type FullRules = Required<CupRules>;
// Not So Weekly Shorts: every place up to 25th has points. 1st gets 200 and the points fall with the
// log of the place, so the last of 25 still gets 10.
export const MAX_PLACES = 25;
const logPoints = (top: number, last: number, from = 1) =>
  Array.from({ length: MAX_PLACES - from + 1 }, (_, i) =>
    Math.round(top - ((top - last) * Math.log((from + i) / from)) / Math.log(MAX_PLACES / from)),
  );
export const DEFAULT_POINTS = logPoints(200, 10);
// Formula keeps the F1 shape for the top 8, then falls the same way to 10.
const FORMULA_POINTS = [200, 144, 120, 96, 80, 64, 48, ...logPoints(32, 10, 8)];
// Tables saved before every place had points carry their last place's points down to 25th.
function fullPoints(points: number[]) {
  if (!Array.isArray(points) || !points.length || points.length >= MAX_PLACES) return points;
  return [...points, ...Array<number>(MAX_PLACES - points.length).fill(points[points.length - 1])];
}
export interface CupPreset {
  format: 'polycup-preset';
  schema: 1;
  name: string;
  rules: CupRules;
}
const standard: FullRules = {
  allowRacerChanges: false,
  allowSpectatorFreecam: true,
  uploadLeaderboardTimes: false,
  roundsPerTrack: 4,
  pointsToWin: 2800,
  finalist: true,
  points: DEFAULT_POINTS,
  selection: 'draft',
  bansPerRacer: 1,
  picksPerRacer: 1,
  pool: ['official', 'community'],
  warmup: 'first-visit',
  warmupTiming: 'wr',
  warmupSeconds: 90,
  warmupMultiplier: 1.5,
  warmupMinimumSeconds: 30,
  readyEndsWarmup: true,
  finishTimeoutSeconds: 10,
  roundBreakSeconds: 5,
  roundTimeLimit: 'auto',
  roundTimeSeconds: 180,
  nextTrack: 'random',
  knockout: 0,
  roundStyle: 'single',
  timeAttackSeconds: 180,
  collisions: false,
};
const OPTIONAL: Partial<FullRules> = {
  allowSpectatorFreecam: true,
  uploadLeaderboardTimes: false,
  roundTimeLimit: 'auto',
  roundTimeSeconds: 180,
  nextTrack: 'random',
  knockout: 0,
  roundStyle: 'single',
  timeAttackSeconds: 180,
  collisions: false,
};
const preset = (name: string, rules: Partial<FullRules>): CupPreset => ({
  format: 'polycup-preset',
  schema: 1,
  name,
  rules: { ...structuredClone(standard), ...structuredClone(rules) },
});
export function standardPreset(): CupPreset {
  return preset('Standard', {});
}
const random = {
  allowRacerChanges: true,
  finalist: false,
  selection: 'random',
  bansPerRacer: 0,
  picksPerRacer: 0,
  warmup: 'off',
} as const;
export function quickplayPreset(): CupPreset {
  return preset('Quickplay', { ...random, roundsPerTrack: 3, pointsToWin: 2000 });
}
// Not So Weekly Shorts: more ready-made formats. Each one is only a set of rules.
export function bundledPresets(): CupPreset[] {
  return [
    quickplayPreset(),
    preset('Sprint', { ...random, roundsPerTrack: 1, pointsToWin: 1200, nextTrack: 'vote' }),
    preset('Formula', {
      ...random,
      roundsPerTrack: 2,
      pointsToWin: 1200,
      points: FORMULA_POINTS,
    }),
    preset('Cup Finals', { ...random, roundsPerTrack: 3, pointsToWin: 1200, finalist: true }),
    preset('Knockout', {
      ...random,
      allowRacerChanges: false,
      roundsPerTrack: 2,
      knockout: 1,
      nextTrack: 'last',
    }),
    preset('Time Attack', {
      ...random,
      roundsPerTrack: 1,
      pointsToWin: 1000,
      roundStyle: 'time-attack',
      timeAttackSeconds: 180,
      nextTrack: 'vote',
    }),
    preset('Bumper Cars', { ...random, roundsPerTrack: 3, pointsToWin: 1200, collisions: true }),
    standardPreset(),
  ];
}
const BUNDLED = ['standard', 'quickplay', 'sprint', 'formula', 'cup finals', 'knockout', 'time attack', 'bumper cars'];
export function rulesFor(state: CupState | null): FullRules {
  // Pre-draft saves have no bans; existing draft saves use the curated pool.
  const rules = state?.preset?.rules ?? {
    ...standard,
    bansPerRacer: state?.draft ? 1 : 0,
    pool: state?.draft ? (['official', 'community'] as TrackCategory[]) : (['official', 'community', 'custom'] as TrackCategory[]),
  };
  return fullRules(rules);
}
export function fullRules(rules: CupRules): FullRules {
  const full = { ...(OPTIONAL as FullRules), ...rules } as FullRules;
  return { ...full, points: fullPoints(full.points) };
}
// Not So Weekly Shorts: the host picks the map pool before the room opens (polycup/nsws/hub.ts), and
// the game only lists those maps, so a preset's pool only decides whether custom tracks are allowed.
export function poolAllows(rules: CupRules, category: string) {
  return category !== 'custom' || rules.pool.includes('custom');
}
export type RuleProblem = { field: keyof FullRules | `points-${number}` | 'name'; message: string };
const integer = (n: unknown, min: number, max: number) =>
  Number.isSafeInteger(n) && Number(n) >= min && Number(n) <= max;
// Every reason a preset is invalid, tied to the field it is about, for the preset editor.
export function presetProblems(value: unknown): RuleProblem[] {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return [{ field: 'name', message: 'This is not a Cup preset.' }];
  const p = value as CupPreset,
    r = p.rules as CupRules | undefined;
  const problems: RuleProblem[] = [];
  const bad = (field: RuleProblem['field'], message: string) => problems.push({ field, message });
  if (
    p.format !== 'polycup-preset' ||
    p.schema !== 1 ||
    !Object.keys(p).every((k) => ['format', 'schema', 'name', 'rules'].includes(k))
  )
    bad('name', 'Unsupported preset format.');
  if (
    typeof p.name !== 'string' ||
    !p.name.trim().length ||
    p.name.length > 64 ||
    /[\u0000-\u001f\u007f]/.test(p.name)
  )
    bad('name', 'Give the preset a name of up to 64 characters.');
  if (!r || typeof r !== 'object' || Array.isArray(r)) {
    bad('name', 'The preset has no rules.');
    return problems;
  }
  const keys = Object.keys(r);
  if (!keys.every((k) => k in standard)) bad('name', 'The preset has rules this version does not know.');
  for (const k of Object.keys(standard) as (keyof FullRules)[])
    if (!(k in OPTIONAL) && !(k in r)) bad(k, 'This rule is missing.');
  const f = fullRules(r);
  if (!integer(f.roundsPerTrack, 1, 30)) bad('roundsPerTrack', 'Use 1 to 30 rounds per track.');
  if (!integer(f.pointsToWin, 1, 100000)) bad('pointsToWin', 'Use 1 to 100000 points.');
  for (const k of ['finalist', 'allowRacerChanges', 'readyEndsWarmup'] as const)
    if (typeof f[k] !== 'boolean') bad(k, 'Turn this on or off.');
  for (const k of ['allowSpectatorFreecam', 'uploadLeaderboardTimes', 'collisions'] as const)
    if (typeof f[k] !== 'boolean') bad(k, 'Turn this on or off.');
  if (!Array.isArray(r.points) || r.points.length < 8 || r.points.length > MAX_PLACES)
    bad('points-0', `Give points for all ${MAX_PLACES} places.`);
  else
    f.points.forEach((n, i) => {
      if (!integer(n, 0, 10000)) bad(`points-${i}`, 'Use 0 to 10000 points.');
      else if (i && n > f.points[i - 1]) bad(`points-${i}`, 'A place can’t earn more than the place above it.');
      else if (!i && n <= 0) bad('points-0', 'First place needs at least 1 point.');
    });
  if (!['draft', 'random'].includes(f.selection)) bad('selection', 'Choose how tracks are picked.');
  if (!integer(f.bansPerRacer, 0, 3)) bad('bansPerRacer', 'Use 0 to 3 bans.');
  if (!integer(f.picksPerRacer, 0, 3)) bad('picksPerRacer', 'Use 1 to 3 picks.');
  if (
    !Array.isArray(f.pool) ||
    !f.pool.length ||
    new Set(f.pool).size !== f.pool.length ||
    !f.pool.every((k) => ['official', 'community', 'custom'].includes(k))
  )
    bad('selection', 'The track pool is invalid.');
  else if (f.bansPerRacer > 0 && f.pool.includes('custom'))
    bad('bansPerRacer', 'Custom tracks need zero bans.');
  if (f.selection === 'random') {
    if (f.bansPerRacer !== 0) bad('bansPerRacer', 'Random tracks have no bans.');
    if (f.picksPerRacer !== 0) bad('picksPerRacer', 'Random tracks have no picks.');
  } else {
    if (f.picksPerRacer < 1) bad('picksPerRacer', 'Each racer needs at least one pick.');
    if (f.bansPerRacer && !f.pool.some((k) => k !== 'custom')) bad('bansPerRacer', 'Bans need official or community tracks.');
    if (f.nextTrack !== 'random') bad('nextTrack', 'Track votes and picks need random tracks.');
  }
  if (!['off', 'first-visit', 'every-visit'].includes(f.warmup)) bad('warmup', 'Choose a warmup.');
  if (!['wr', 'fixed'].includes(f.warmupTiming)) bad('warmupTiming', 'Choose a warmup length.');
  if (!integer(f.warmupSeconds, 10, 600)) bad('warmupSeconds', 'Use 10 to 600 seconds.');
  if (!integer(f.warmupMinimumSeconds, 10, 300)) bad('warmupMinimumSeconds', 'Use 10 to 300 seconds.');
  if (
    typeof f.warmupMultiplier !== 'number' ||
    !Number.isFinite(f.warmupMultiplier) ||
    f.warmupMultiplier < 0.5 ||
    f.warmupMultiplier > 5
  )
    bad('warmupMultiplier', 'Use 0.5 to 5.');
  if (!integer(f.finishTimeoutSeconds, 5, 120)) bad('finishTimeoutSeconds', 'Use 5 to 120 seconds.');
  if (!integer(f.roundBreakSeconds, 3, 60)) bad('roundBreakSeconds', 'Use 3 to 60 seconds.');
  if (!['auto', 'off', 'fixed'].includes(f.roundTimeLimit)) bad('roundTimeLimit', 'Choose a time limit.');
  if (!integer(f.roundTimeSeconds, 30, 1800)) bad('roundTimeSeconds', 'Use 30 to 1800 seconds.');
  if (!['random', 'vote', 'winner', 'last'].includes(f.nextTrack)) bad('nextTrack', 'Choose how the next track is picked.');
  if (!integer(f.knockout, 0, 7)) bad('knockout', 'Knock out 0 to 7 racers a round.');
  else if (f.knockout > 0) {
    if (f.finalist) bad('finalist', 'Knockout cups have no finalists.');
    if (f.allowRacerChanges) bad('allowRacerChanges', 'Knockout cups lock the grid once they start.');
  }
  if (!['single', 'time-attack'].includes(f.roundStyle)) bad('roundStyle', 'Choose a round style.');
  if (!integer(f.timeAttackSeconds, 30, 1800)) bad('timeAttackSeconds', 'Use 30 to 1800 seconds.');
  if (f.collisions && f.uploadLeaderboardTimes) bad('uploadLeaderboardTimes', 'Times can’t upload with collisions on.');
  return problems;
}
export function validPreset(value: unknown): value is CupPreset {
  return presetProblems(value).length === 0;
}
export function parsePreset(text: string): CupPreset {
  if (text.length > 32000) throw new Error('Preset files must be smaller than 32 KB.');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('This is not a valid preset JSON file.');
  }
  const problems = presetProblems(value);
  if (problems.length) throw new Error(`This preset can’t be used: ${problems[0].message}`);
  const p = value as CupPreset;
  return { ...structuredClone(p), rules: fullRules(p.rules) };
}
export function presetText(preset: CupPreset) {
  if (!validPreset(preset)) throw new Error('Fix the preset rules before exporting.');
  return JSON.stringify(preset, null, 2) + '\n';
}
export function presetKey(preset: CupPreset) {
  const rules = fullRules(preset.rules);
  return JSON.stringify({
    name: preset.name,
    rules: Object.fromEntries(Object.entries(rules).sort(([a], [b]) => a.localeCompare(b))),
  });
}
export function isBundledName(name: string) {
  return BUNDLED.includes(name.trim().toLowerCase());
}
export class PresetLibrary {
  #storage: Pick<Storage, 'getItem' | 'setItem'>;
  constructor(storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage) {
    this.#storage = storage;
  }
  list(): CupPreset[] {
    try {
      const values: unknown = JSON.parse(this.#storage.getItem('polycup-presets-v1') ?? '[]');
      return Array.isArray(values)
        ? values
            .filter(validPreset)
            .slice(0, 30)
            .map((preset) => ({ ...preset, rules: fullRules(preset.rules) }))
        : [];
    } catch {
      return [];
    }
  }
  save(preset: CupPreset) {
    if (!validPreset(preset)) throw new Error('Fix the preset rules before saving.');
    if (isBundledName(preset.name))
      throw new Error(
        'Choose a new name for your custom preset. Bundled presets are kept unchanged.',
      );
    const values = this.list().filter((p) => p.name.toLowerCase() !== preset.name.toLowerCase());
    if (values.length >= 30)
      throw new Error('Remove a saved preset before adding another (limit 30).');
    this.#storage.setItem('polycup-presets-v1', JSON.stringify([...values, preset]));
  }
  remove(name: string) {
    this.#storage.setItem(
      'polycup-presets-v1',
      JSON.stringify(this.list().filter((p) => p.name !== name)),
    );
  }
}
