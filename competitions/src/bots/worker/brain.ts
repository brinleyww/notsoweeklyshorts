// The bots' neural network: a small multilayer perceptron that sits on top of the hand-made driver.
// Each frame it reads the car and the reference ahead (features below) and returns two corrections: to
// the steering target and to the speed limit. Its output layer starts at zero, so untrained it changes
// nothing; it is trained by evolution strategies on the game's own physics (learn.ts), offline in the
// lab for the weights shipped here and online per track during a cup.

import { EXPERT_SKILL } from '../wire.ts';

export const BRAIN_IN = 24;
const H = 16;
export const BRAIN_OUT = 2;
export const BRAIN_SIZE = BRAIN_IN * H + H + H * H + H + H * BRAIN_OUT + BRAIN_OUT;
// Most a correction may do: steering target (input units), speed limit (log factor).
export const STEER_RANGE = 0.25;
export const PACE_RANGE = 0.06;

export class Brain {
  readonly w: Float32Array;
  readonly #h1 = new Float32Array(H);
  readonly #h2 = new Float32Array(H);

  constructor(w: Float32Array) {
    if (w.length !== BRAIN_SIZE) throw new Error('brain size');
    this.w = w;
  }

  // out[0]: steering correction, out[1]: speed limit factor exponent, both already scaled.
  run(x: Float32Array, out: Float32Array) {
    const w = this.w, h1 = this.#h1, h2 = this.#h2;
    let o = 0;
    for (let j = 0; j < H; j++) {
      let s = w[BRAIN_IN * H + j];
      for (let i = 0; i < BRAIN_IN; i++) s += w[o + i * H + j] * x[i];
      h1[j] = Math.tanh(s);
    }
    o = BRAIN_IN * H + H;
    for (let j = 0; j < H; j++) {
      let s = w[o + H * H + j];
      for (let i = 0; i < H; i++) s += w[o + i * H + j] * h1[i];
      h2[j] = Math.tanh(s);
    }
    o += H * H + H;
    for (let j = 0; j < BRAIN_OUT; j++) {
      let s = w[o + H * BRAIN_OUT + j];
      for (let i = 0; i < H; i++) s += w[o + i * BRAIN_OUT + j] * h2[i];
      out[j] = Math.tanh(s);
    }
    out[0] *= STEER_RANGE;
    out[1] *= PACE_RANGE;
    return out;
  }
}

// Hidden layers get small random weights (so the output layer has something to learn from), the output
// layer zeros (so the network starts out doing nothing).
export function freshBrain(seed: number): Float32Array {
  const w = new Float32Array(BRAIN_SIZE);
  let a = seed | 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
  const hidden = BRAIN_IN * H + H + H * H + H;
  for (let i = 0; i < hidden; i++) w[i] = rand() * (i < BRAIN_IN * H ? 0.8 : 0.6);
  return w;
}

// Bots learn per track in four skill groups (experts learn their own notes instead, notes.ts); each group's
// weights are tested at its typical skill.
export function brainGroup(skill: number): { key: string; skill: number } | null {
  if (skill >= EXPERT_SKILL) return null;
  if (skill < 0.45) return { key: 'a', skill: 0.35 };
  if (skill < 0.7) return { key: 'b', skill: 0.6 };
  if (skill < 0.9) return { key: 'c', skill: 0.8 };
  return { key: 'd', skill: 0.92 };
}

// Weights trained offline in the lab (cup-test-tools/botlab/t23_train.mjs), the start for every track;
// empty while none have beaten driving without the network.
export const BASE_BRAIN = '';

export function brainToB64(w: Float32Array): string {
  const b = new Uint8Array(w.buffer, w.byteOffset, w.byteLength);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

export function brainFromB64(s: string): Float32Array | null {
  try {
    const bin = atob(s);
    if (bin.length !== BRAIN_SIZE * 4) return null;
    const b = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
    const w = new Float32Array(b.buffer);
    return w.every(Number.isFinite) ? w : null;
  } catch {
    return null;
  }
}
