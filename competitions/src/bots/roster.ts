// Computer racers: their names, paint jobs and driving personalities. Everything here is
// deterministic, so a bot keeps its look and a cup's bots come out the same on every run.
import type { BotSkill } from '../rules.ts';
import type { Persona } from './wire.ts';

export const BOT_NAMES = ['Apex', 'Torque', 'Nitro', 'Camber', 'Redline', 'Gearbox', 'Piston', 'Slick', 'Drift', 'Turbo', 'Axle', 'Boost', 'Clutch', 'Kerb', 'Diesel', 'Spoiler'];

const TIERS = {
  easy: [0.25, 0.4],
  medium: [0.5, 0.62],
  hard: [0.72, 0.82],
  expert: [0.9, 0.98],
} as const;
const MIXED = [0.3, 0.95] as const;

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

// The game's 16-byte CarStyle: [0, pattern, rims, exhaust | body << 4, then primary, secondary,
// frame and rims colours as little-endian RGB], base64url like CarStyle.serialize().
export function botStyle(name: number) {
  const r = (k: number) => unit(mix(0x5eed + name, k));
  // Neighbouring names get hues far apart.
  const hue = ((name * 7) % 16) * 22.5 + r(1) * 10;
  const primary = hsl(hue, 0.65 + r(2) * 0.25, 0.4 + r(3) * 0.14);
  const secondary = [0xffffff, 0x161616, hsl((hue + 180) % 360, 0.75, 0.55), 0xf2c230][Math.floor(r(4) * 4)];
  const frame = [0x1c1c1c, 0x2b2b2b, 0x3a3a3a][Math.floor(r(5) * 3)];
  const rims = [0xc8c8c8, 0x1e1e1e, 0xd4a017, secondary][Math.floor(r(6) * 4)];
  const bytes = new Uint8Array(16);
  bytes[1] = Math.floor(r(7) * 16);
  bytes[2] = Math.floor(r(8) * 12);
  bytes[3] = Math.floor(r(9) * 8) | (Math.floor(r(10) * 6) << 4);
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
  const [lo, hi] = skill === 'mixed' ? MIXED : TIERS[skill === 'match' ? 'medium' : skill];
  return Array.from({ length: count }, (_, i) => lo + (hi - lo) * rank(i, count));
}

// Driving personalities for `count` bot slots (u is the slot; callers put the bot's own id in).
// adapt[i], when given, is that slot's skill instead of the tier's (Match the field keeps its own).
export function personas(skill: BotSkill, count: number, seedBase: number, adapt?: number[]): Persona[] {
  return tierSkills(skill, count).map((tier, i) => {
    const seed = mix(seedBase, i);
    const s = clamp01(adapt?.[i] ?? tier);
    return {
      u: i,
      skill: s,
      risk: clamp01(s ** 1.5 + (unit(mix(seed, 1)) - 0.5) * 0.1),
      mistakes: clamp01((1 - s) * 0.8 + (unit(mix(seed, 2)) - 0.5) * 0.1),
      seed,
    };
  });
}

// Match the field: after a round, a bot that finished in tb moves toward the humans' median th.
export function matchStep(skill: number, tb: number, th: number) {
  const step = Math.max(-0.08, Math.min(0.08, 0.6 * Math.log(tb / th)));
  return Math.min(0.98, Math.max(0.15, skill + step));
}
