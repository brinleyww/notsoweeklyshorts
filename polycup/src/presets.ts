import type { CupState } from './types.ts';

export type TrackCategory = 'official' | 'community' | 'custom';
export interface CupRules {
  allowRacerChanges: boolean;
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
}
export interface CupPreset {
  format: 'polycup-preset';
  schema: 1;
  name: string;
  rules: CupRules;
}
const standard: CupRules = {
  allowRacerChanges: false,
  uploadLeaderboardTimes: false,
  roundsPerTrack: 4,
  pointsToWin: 140,
  finalist: true,
  points: [10, 8, 6, 5, 4, 3, 2, 1],
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
};
export function standardPreset(): CupPreset {
  return {
    format: 'polycup-preset',
    schema: 1,
    name: 'Standard',
    rules: structuredClone(standard),
  };
}
export function quickplayPreset(): CupPreset {
  const preset = standardPreset();
  preset.name = 'Quickplay';
  Object.assign(preset.rules, {
    allowRacerChanges: true,
    roundsPerTrack: 3,
    pointsToWin: 100,
    finalist: false,
    selection: 'random',
    bansPerRacer: 0,
    picksPerRacer: 0,
    warmup: 'off',
  });
  return preset;
}
export function rulesFor(state: CupState | null): CupRules {
  // Pre-draft saves have no bans; existing draft saves use the curated pool.
  return (
    state?.preset?.rules ?? {
      ...standard,
      bansPerRacer: state?.draft ? 1 : 0,
      pool: state?.draft ? ['official', 'community'] : ['official', 'community', 'custom'],
    }
  );
}
// Not So Weekly Shorts: the host picks the map pool before the room opens (polycup/nsws/hub.ts), and
// the game only lists those maps, so a preset's pool only decides whether custom tracks are allowed.
export function poolAllows(rules: CupRules, category: string) {
  return category !== 'custom' || rules.pool.includes('custom');
}
export function validPreset(value: unknown): value is CupPreset {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as CupPreset,
    r = p.rules;
  const integer = (n: unknown, min: number, max: number) =>
    Number.isSafeInteger(n) && Number(n) >= min && Number(n) <= max;
  return (
    p.format === 'polycup-preset' &&
    p.schema === 1 &&
    typeof p.name === 'string' &&
    p.name.trim().length > 0 &&
    p.name.length <= 64 &&
    !/[\u0000-\u001f\u007f]/.test(p.name) &&
    !!r &&
    typeof r === 'object' &&
    !Array.isArray(r) &&
    Object.keys(p).every((k) => ['format', 'schema', 'name', 'rules'].includes(k)) &&
    Object.keys(r).length ===
      Object.keys(standard).length - (r.uploadLeaderboardTimes === undefined ? 1 : 0) &&
    Object.keys(r).every((k) => k in standard) &&
    integer(r.roundsPerTrack, 1, 30) &&
    integer(r.pointsToWin, 1, 10000) &&
    typeof r.finalist === 'boolean' &&
    typeof r.allowRacerChanges === 'boolean' &&
    (r.uploadLeaderboardTimes === undefined || typeof r.uploadLeaderboardTimes === 'boolean') &&
    Array.isArray(r.points) &&
    r.points.length === 8 &&
    r.points[0] > 0 &&
    r.points.every((n, i) => integer(n, 0, 1000) && (!i || n <= r.points[i - 1])) &&
    ['draft', 'random'].includes(r.selection) &&
    integer(r.bansPerRacer, 0, 3) &&
    integer(r.picksPerRacer, 0, 3) &&
    Array.isArray(r.pool) &&
    r.pool.length > 0 &&
    new Set(r.pool).size === r.pool.length &&
    r.pool.every((k) => ['official', 'community', 'custom'].includes(k)) &&
    (r.bansPerRacer === 0 || !r.pool.includes('custom')) &&
    (r.selection === 'random'
      ? r.bansPerRacer === 0 && r.picksPerRacer === 0
      : r.picksPerRacer >= 1 && (!r.bansPerRacer || r.pool.some((k) => k !== 'custom'))) &&
    ['off', 'first-visit', 'every-visit'].includes(r.warmup) &&
    ['wr', 'fixed'].includes(r.warmupTiming) &&
    integer(r.warmupSeconds, 10, 600) &&
    integer(r.warmupMinimumSeconds, 10, 300) &&
    typeof r.warmupMultiplier === 'number' &&
    Number.isFinite(r.warmupMultiplier) &&
    r.warmupMultiplier >= 0.5 &&
    r.warmupMultiplier <= 5 &&
    typeof r.readyEndsWarmup === 'boolean' &&
    integer(r.finishTimeoutSeconds, 5, 120) &&
    integer(r.roundBreakSeconds, 3, 60)
  );
}
export function parsePreset(text: string): CupPreset {
  if (text.length > 32000) throw new Error('Preset files must be smaller than 32 KB.');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('This is not a valid preset JSON file.');
  }
  const rules = (value as { rules?: Partial<CupRules> } | null)?.rules;
  if (
    typeof rules?.bansPerRacer === 'number' &&
    rules.bansPerRacer > 0 &&
    Array.isArray(rules.pool) &&
    rules.pool.includes('custom')
  )
    throw new Error(
      'Custom tracks require zero bans per racer. Update the preset before importing it.',
    );
  if (!validPreset(value))
    throw new Error('Unsupported or invalid preset. Check its rules and preset format.');
  return { ...structuredClone(value), rules: { uploadLeaderboardTimes: false, ...value.rules } };
}
export function presetText(preset: CupPreset) {
  if (!validPreset(preset)) throw new Error('Fix the preset rules before exporting.');
  return JSON.stringify(preset, null, 2) + '\n';
}
export function presetKey(preset: CupPreset) {
  const rules = {
    ...preset.rules,
    uploadLeaderboardTimes: preset.rules.uploadLeaderboardTimes === true,
  };
  return JSON.stringify({
    name: preset.name,
    rules: Object.fromEntries(Object.entries(rules).sort(([a], [b]) => a.localeCompare(b))),
  });
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
            .map((preset) => ({
              ...preset,
              rules: { uploadLeaderboardTimes: false, ...preset.rules },
            }))
        : [];
    } catch {
      return [];
    }
  }
  save(preset: CupPreset) {
    if (!validPreset(preset)) throw new Error('Fix the preset rules before saving.');
    if (['standard', 'quickplay'].includes(preset.name.trim().toLowerCase()))
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
