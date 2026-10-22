// Computer racers: their names, paint jobs and driving personalities. Everything here is
// deterministic, so a bot keeps its look and a cup's bots come out the same on every run.
import type { BotSkill } from '../rules.ts';
import { EXPERT_SKILL, type Persona } from './wire.ts';

export const BOT_NAMES = ['Apex', 'Torque', 'Nitro', 'Camber', 'Redline', 'Gearbox', 'Piston', 'Slick', 'Drift', 'Turbo', 'Axle', 'Boost', 'Clutch', 'Kerb', 'Diesel', 'Spoiler'];

const TIERS = {
  easy: [0.12, 0.25],
  medium: [0.5, 0.62],
  hard: [0.72, 0.82],
  expert: [1, 1],
} as const;
const MIXED = ['easy', 'medium', 'hard', 'expert'] as const;

export function mix(a: number, b: number) {
  let h = (a ^ Math.imul((b + 0x9e3779b9) | 0, 0x85ebca6b)) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}
const unit = (h: number) => h / 4294967296;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function seedOf(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

// The order the cup hands out names in.
export function nameOrder(seed: number) {
  const order = BOT_NAMES.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = mix(seed, i) % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

function hsl(h: number, s: number, l: number) {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return (f(0) << 16) | (f(8) << 8) | f(4);
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Each bot name's own paint: the default car (body, rims and exhaust 0) in its own colours and pattern.
// The game's 16-byte CarStyle: [0, pattern, rims, exhaust | body << 4, then primary, secondary, frame and
// rims colours as little-endian RGB], base64url like CarStyle.serialize().
export function botStyle(name: number) {
  const r = (k: number) => unit(mix(0x5eed + name, k));
  // Neighbouring names get hues far apart.
  const hue = (name * 137.508) % 360;
  const primary = hsl(hue, 0.7 + r(2) * 0.2, 0.42 + r(3) * 0.12);
  const secondary = [0xffffff, 0x161616, hsl((hue + 180) % 360, 0.8, 0.55), hsl((hue + 40) % 360, 0.85, 0.6)][name % 4];
  const frame = [0x1c1c1c, 0x2b2b2b, hsl(hue, 0.5, 0.18)][Math.floor(r(5) * 3)];
  const rims = [0xd0d0d0, 0x1e1e1e, 0xd4a017, secondary][Math.floor(r(6) * 4)];
  const bytes = new Uint8Array(16);
  bytes[1] = (name * 5 + 1) % 16;
  [primary, secondary, frame, rims].forEach((hex, i) => bytes.set([hex & 255, (hex >> 8) & 255, (hex >> 16) & 255], 4 + i * 3));
  return b64url(bytes);
}

// Slot i's rank among `count` slots: a fixed shuffle, so the first bots aren't always the slowest.
function rank(i: number, count: number) {
  const key = (k: number) => (k * 0.6180339887) % 1;
  let below = 0;
  for (let k = 0; k < count; k++) if (key(k) < key(i)) below++;
  return count === 1 ? 0.5 : below / (count - 1);
}

export function tierSkills(skill: BotSkill, count: number) {
  if (skill === 'mixed') return mixedSkills(count);
  const [lo, hi] = TIERS[skill === 'match' ? 'medium' : skill];
  return Array.from({ length: count }, (_, i) => lo + (hi - lo) * rank(i, count));
}

// Mixed: a quarter each of easy, medium, hard and expert, as near as the count allows: how many of each
// for 1 to 8 bots.
const MIXED_COUNTS = [[0, 1, 0, 0], [1, 0, 0, 1], [1, 0, 1, 1], [1, 1, 1, 1], [2, 1, 1, 1], [2, 1, 1, 2], [2, 2, 1, 2], [2, 2, 2, 2]];

function mixedSkills(count: number) {
  const counts = MIXED_COUNTS[count - 1] ?? [0, 1, 2, 3].map((t) => Math.floor((count + 3 - t) / 4));
  const at = counts.flatMap((n, t) => Array<number>(n).fill(t));
  return Array.from({ length: count }, (_, i) => {
    const q = Math.round(rank(i, count) * (count - 1));
    const t = at[q], same = at.filter((x) => x === t).length, nth = at.slice(0, q).filter((x) => x === t).length;
    const [lo, hi] = TIERS[MIXED[t]];
    return lo + (hi - lo) * (same > 1 ? nth / (same - 1) : 0.5);
  });
}

// Driving personalities for `count` bot slots (u is the slot; callers put the bot's own id in).
// adapt[i], when given, is that slot's skill instead of the tier's (Match the field keeps its own);
// names[i] is that slot's bot name.
export function personas(skill: BotSkill, count: number, seedBase: number, adapt?: number[], names?: number[]): Persona[] {
  const list: Persona[] = tierSkills(skill, count).map((tier, i) => {
    // Every bot its own seed each round, from the cup, the round and its name.
    const seed = mix(mix(seedBase, i), 0x51ed + (names?.[i] ?? i));
    const s = clamp01(adapt?.[i] ?? tier);
    return {
      u: i,
      name: names?.[i],
      skill: s,
      risk: clamp01(s ** 1.5 + (unit(mix(seed, 1)) - 0.5) * 0.1),
      // Experts never slip up; easy bots often do.
      mistakes: s >= EXPERT_SKILL ? 0 : clamp01((1 - s) * 0.8 + (s < 0.3 ? 0.15 : 0) + (unit(mix(seed, 2)) - 0.5) * 0.1),
      seed,
    };
  });
  // Every bot takes a top run of its own as a hint while there are enough: experts the fastest ones, by name
  // so the same one every round (they keep learning on it), then the others by skill.
  const experts = list.filter((p) => p.skill >= EXPERT_SKILL).sort((a, b) => (a.name ?? a.u) - (b.name ?? b.u));
  const rest = list.filter((p) => p.skill < EXPERT_SKILL).sort((a, b) => b.skill - a.skill || (a.name ?? a.u) - (b.name ?? b.u));
  [...experts, ...rest].forEach((p, k) => (p.copy = k));
  return list;
}

// Match the field: after a round, a bot that finished in tb moves toward the humans' median th.
export function matchStep(skill: number, tb: number, th: number) {
  const step = Math.max(-0.08, Math.min(0.08, 0.6 * Math.log(tb / th)));
  return Math.min(0.98, Math.max(0.15, skill + step));
}

// What a bot's tag calls its difficulty: the cup's Bot skill, except Mixed, where each bot is named for its own
// skill (0-100) by the nearest tier.
export function botLevel(rule: BotSkill, skill: number) {
  if (rule === 'match') return 'Match';
  const s = rule === 'mixed' ? skill / 100 : null;
  const tier = s == null ? rule : s >= EXPERT_SKILL ? 'expert' : s >= 0.67 ? 'hard' : s >= 0.45 ? 'medium' : 'easy';
  return tier[0].toUpperCase() + tier.slice(1);
}
