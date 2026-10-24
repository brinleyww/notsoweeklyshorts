// What a bot has learned about driving a track, its own and nobody else's. The bot's hint run (a top run:
// its line and speeds) is cut into one-second sections, and for each one the notes hold how the bot drives
// it: speed against the hint's, how far beside its line, and how early it turns in. A new bot starts from
// rules of its own, hashed from its name. Every race run drives each section a little differently (from
// that run's seed); the notes themselves only change when the bot goes over its run (planner.ts, rethink),
// where a change is kept only if the whole run with it finishes sooner.
import type { Reference } from './reference.ts';

export const SECTION = 1000;
// Per section: pace (log factor on the speed limit), offset (units, + = left), turn-in (frames early).
export const FIELDS = 3;
// Pace goes down to -15% where a bot learned to slow down to get through (Notes.learn).
const LIMITS = [
  [-0.15, 0.06],
  [-1.5, 1.5],
  [-10, 40],
] as const;
// A bot's own rules to start from, a race run's variety, and a practice try.
const OWN = [0.005, 0.1, 4];
const VARIETY = [0.004, 0.1, 3];
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

  // Highest pace (log factor): an expert on a slower hint run may go faster than it by `lift` more. How far
  // beside the hint's line it may go (units), and how big a change going over a run tries.
  readonly top: number;
  readonly room: number;
  readonly step: number;

  // `lift`: how much slower the hint run is than the fastest (log of their times), for an expert, which drives
  // its hint's line at the pace of the best; it starts halfway there and goes over its runs for the rest.
  // `explore`: an expert finds its own way, faster than its hint where it can: this many times the speed and
  // room to try, and bigger changes (it only keeps one that a whole run proved faster). 1 = none.
  constructor(ref: Reference, name: number, saved: Float32Array | null | undefined, lift = 0, explore = 1) {
    this.ref = ref;
    this.n = Math.ceil(ref.n / SECTION);
    this.top = LIMITS[0][1] * explore + lift;
    this.room = LIMITS[1][1] * explore;
    this.step = explore > 1 ? 1 + 0.5 * (explore - 1) ** 0.5 : 1;
    if (saved && saved.length === this.n * FIELDS && saved.every(Number.isFinite)) this.v = saved.slice();
    else {
      this.v = new Float32Array(this.n * FIELDS);
      for (let s = 0; s < this.n; s++) for (let f = 0; f < FIELDS; f++) this.v[s * FIELDS + f] = (hash(name * 7919 + f, s) * 2 - 1) * OWN[f] + (f === 0 ? lift / 2 : 0);
    }
  }

  #clamp(f: number, x: number) {
    return f === 0 ? Math.max(LIMITS[0][0], Math.min(this.top, x)) : f === 1 ? Math.max(-this.room, Math.min(this.room, x)) : clamp(f, x);
  }

  // A run's way of driving, into p: the notes, every section a little different (from `rand`) unless `same`.
  plan(rand: () => number, p: Float32Array, same: boolean) {
    for (let i = 0; i < this.v.length; i++) p[i] = same ? this.v[i] : this.#clamp(i % FIELDS, this.v[i] + (rand() * 2 - 1) * VARIETY[i % FIELDS]);
  }

  // A retry got through section s at `pace` times the speed limit and (if not null) `off` beside the line:
  // drive it that way from now on (most of the way: the next failure there moves it further).
  learn(s: number, pace: number, off: number | null) {
    const o = s * FIELDS;
    this.v[o] = this.#clamp(0, this.v[o] + 0.7 * Math.log(pace));
    if (off != null) this.v[o + 1] = this.#clamp(1, 0.5 * this.v[o + 1] + 0.5 * off);
  }

  // Another way through section s of p, to try in practice.
  vary(p: Float32Array, s: number, rand: () => number) {
    const out = new Float32Array(FIELDS);
    for (let f = 0; f < FIELDS; f++) out[f] = this.#clamp(f, p[s * FIELDS + f] + (rand() * 2 - 1) * TRY[f] * this.step);
    return out;
  }

  // Section s of p with the pace and turn-in of another bot's tip there (v: its notes), this bot's own line
  // beside the hint, and half a practice try's variety of its own, so a tip is a lead, never a copy.
  fromTip(p: Float32Array, s: number, v: number[], rand: () => number) {
    const out = new Float32Array(FIELDS);
    for (let f = 0; f < FIELDS; f++) {
      const x = f === 1 ? NaN : v[f];
      out[f] = this.#clamp(f, (Number.isFinite(x) ? x : p[s * FIELDS + f]) + (rand() * 2 - 1) * TRY[f] * 0.5);
    }
    return out;
  }

  // Another way through section s of p when going over a run (planner.ts, rethink): mostly a little faster.
  nudge(p: Float32Array, s: number, rand: () => number) {
    const out = this.vary(p, s, rand);
    out[0] = this.#clamp(0, p[s * FIELDS] + (rand() * 1.5 - 0.5) * TRY[0] * this.step);
    return out;
  }
}
