// What an expert bot has learned about driving a track, its own and nobody else's. The bot's hint run (a
// top run: its line and speeds) is cut into one-second sections, and for each one the notes hold how the bot
// drives it: speed against the hint's, how far beside its line, and how early it turns in. A new bot starts
// from rules of its own, hashed from its name. Every race run drives each section a little differently
// (from that run's seed), so no two rounds are alike; the notes themselves only change in practice
// (learn.ts), where a change is kept only if a whole run with it beats one without.
import type { Reference } from './reference.ts';

export const SECTION = 1000;
// Per section: pace (log factor on the speed limit), offset (units, + = left), turn-in (frames early).
export const FIELDS = 3;
const LIMITS = [
  [-0.04, 0.06],
  [-1.5, 1.5],
  [-10, 40],
] as const;
// A bot's own rules to start from, a race run's variety, and a practice try.
const OWN = [0.005, 0.25, 4];
const VARIETY = [0.006, 0.2, 3];
const TRY = [0.02, 0.5, 12];

const hash = (a: number, b: number) => {
  let h = (a ^ Math.imul((b + 0x9e3779b9) | 0, 0x85ebca6b)) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

const clamp = (f: number, x: number) => Math.max(LIMITS[f][0], Math.min(LIMITS[f][1], x));

export const refKey = (ref: Reference) => `${ref.id}:${ref.n}`;

export function notesToB64(v: Float32Array): string {
  const b = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

export function notesFromB64(s: string): Float32Array | null {
  try {
    const bin = atob(s);
    if (!bin.length || bin.length % (FIELDS * 4)) return null;
    const b = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    const v = new Float32Array(b.buffer);
    return v.every(Number.isFinite) ? v : null;
  } catch {
    return null;
  }
}

export class Notes {
  readonly ref: Reference;
  readonly n: number;
  readonly v: Float32Array;

  constructor(ref: Reference, name: number, saved: Float32Array | null | undefined) {
    this.ref = ref;
    this.n = Math.ceil(ref.n / SECTION);
    if (saved && saved.length === this.n * FIELDS && saved.every(Number.isFinite)) this.v = saved.slice();
    else {
      this.v = new Float32Array(this.n * FIELDS);
      for (let s = 0; s < this.n; s++) for (let f = 0; f < FIELDS; f++) this.v[s * FIELDS + f] = (hash(name * 7919 + f, s) * 2 - 1) * OWN[f];
    }
  }

  // A run's way of driving, into p: the notes, every section a little different (from `rand`) unless `same`.
  plan(rand: () => number, p: Float32Array, same: boolean) {
    for (let i = 0; i < this.v.length; i++) p[i] = same ? this.v[i] : clamp(i % FIELDS, this.v[i] + (rand() * 2 - 1) * VARIETY[i % FIELDS]);
  }

  // Another way through section s of p, to try in practice.
  vary(p: Float32Array, s: number, rand: () => number) {
    const out = new Float32Array(FIELDS);
    for (let f = 0; f < FIELDS; f++) out[f] = clamp(f, p[s * FIELDS + f] + (rand() * 2 - 1) * TRY[f]);
    return out;
  }
}
