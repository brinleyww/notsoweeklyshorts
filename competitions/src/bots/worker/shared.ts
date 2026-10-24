// What the bots on a track learn from each other: where one found a faster way through a section, and how a
// retry got past a failure. Another bot only tries a tip as one more way of its own (planner.ts: a fix decides
// its first retry at the same place, a win is one of the ways it tries when going over its run, kept only if
// its whole run gets faster), so each still drives and finds its own run.
import type { Tip } from '../wire.ts';
import { SECTION } from './notes.ts';
import type { Reference } from './reference.ts';

const MAX_TIPS = 400;
// Tips this close (units) are about the same place.
export const NEAR = 20;

const valid = (t: Tip) =>
  (t.kind === 'win' || t.kind === 'fix') && [t.x, t.y, t.z, t.cp, t.s, t.gain, t.by].every(Number.isFinite) && Array.isArray(t.v) && t.v.length <= 4 && typeof t.ref === 'string';

export class Shared {
  readonly tips: Tip[] = [];

  // False when it adds nothing (not valid, or no better than one already held from the same bot and place).
  add(t: Tip) {
    if (!valid(t)) return false;
    const i = this.tips.findIndex((o) => o.kind === t.kind && o.by === t.by && o.ref === t.ref && o.s === t.s && (t.kind === 'win' || (o.x - t.x) ** 2 + (o.y - t.y) ** 2 + (o.z - t.z) ** 2 < 25));
    if (i >= 0) {
      if (t.kind === 'win' && this.tips[i].gain >= t.gain) return false;
      if (t.kind === 'fix' && this.tips[i].v.every((x, j) => Object.is(x, t.v[j]))) return false;
      this.tips.splice(i, 1);
    }
    this.tips.push({ ...t, v: [...t.v] });
    if (this.tips.length > MAX_TIPS) this.tips.splice(0, this.tips.length - MAX_TIPS);
    return true;
  }

  // Other bots' tips of a kind within `r` units of a place before checkpoint cp, nearest first.
  near(kind: Tip['kind'], x: number, y: number, z: number, cp: number, not: number, r = NEAR) {
    const out: [number, Tip][] = [];
    for (const t of this.tips) {
      if (t.kind !== kind || t.by === not || t.cp !== cp) continue;
      const d = (t.x - x) ** 2 + (t.y - y) ** 2 + (t.z - z) ** 2;
      if (d < r * r) out.push([d, t]);
    }
    return out.sort((a, b) => a[0] - b[0]).map(([, t]) => t);
  }

  // Other bots' wins that fall in section s of `ref` (a bot's own hint run): where each one starts, mapped onto
  // that run (within NEAR of its line), lands in that section.
  wins(ref: Reference, s: number, not: number) {
    let at = this.#at.get(ref);
    if (!at) this.#at.set(ref, (at = new WeakMap()));
    const out: Tip[] = [];
    for (const t of this.tips) {
      if (t.kind !== 'win' || t.by === not) continue;
      let q = at.get(t);
      if (q === undefined) {
        const i = ref.search(t.x, t.y, t.z, t.cp, this.#d);
        q = i >= 0 && this.#d[0] < NEAR * NEAR && ref.cp[i] === t.cp ? Math.floor(i / SECTION) : -1;
        at.set(t, q);
      }
      if (q === s) out.push(t);
    }
    return out;
  }

  #at = new WeakMap<Reference, WeakMap<Tip, number>>();
  #d = new Float64Array(1);
}
