// Bots hitting each other in a bumper cup, found on the organizer's page in their keyframes as they come in (a
// moment ahead of the race clock), with the sim worker's hull boxes and bounce: equal masses, restitution 0.25,
// a little friction. Each bot's half goes to its planner as a hit at that frame, the way a player's hit does
// (`BotManager.bump`). As in the sim worker, a bot that spawned less than SPAWN_MS ago (the start, a restart, a
// respawn) can't hit or be hit, a pair still overlapping after that passes through until it has separated, and
// a pair that hit doesn't hit again for COOL_MS.
import type { BotTimeline } from './timeline.ts';

const HALF = [0.7732, 0.3822, 1.8431];
const CENTER = [0, 0.6162, -0.1532];
const STEP = 10;
// Centres further apart than this can't touch.
const NEAR = 2 * Math.hypot(HALF[0], HALF[1], HALF[2]) + 0.2;
// A bot that was hit is checked only up to the hit until its planner sends its frames from there again (or
// this long has passed: a hit its planner turned down).
const WAIT_MS = 1000;
// Most of the race checked per pair at a time.
const SPAN = 2000;
const SPAWN_MS = 2000;
const COOL_MS = 250;
const BOUNCE = 0.625;
const FRICTION = 0.3;

type V = number[];
interface Box {
  c: V;
  u: V[];
}
interface Pair {
  a: number;
  b: number;
  at: number;
  // Never checked again before this (its last hit).
  floor: number;
  ghost: boolean;
  cool: number;
}
export interface ClashHost {
  // The race clock (ms since GO), or null before GO.
  now(): number | null;
  hit(u: number, at: number, v: number[]): void;
}

const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V, b: V) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V, k: number) => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a: V, b: V) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V) => Math.hypot(a[0], a[1], a[2]);

function box(p: V, q: V): Box {
  const [x, y, z, w] = q;
  const u = [
    [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)],
    [2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w)],
    [2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)],
  ];
  return { c: [0, 1, 2].map((j) => p[j] + u[0][j] * CENTER[0] + u[1][j] * CENTER[1] + u[2][j] * CENTER[2]), u };
}

// Separating axes: the normal from B to A where they overlap, or null.
function overlap(A: Box, B: Box): V | null {
  const d = sub(A.c, B.c);
  let best = Infinity, bn: V | null = null;
  const test = (ax: V) => {
    const L = len(ax);
    if (L < 1e-6) return true;
    const n = mul(ax, 1 / L);
    const ra = HALF[0] * Math.abs(dot(A.u[0], n)) + HALF[1] * Math.abs(dot(A.u[1], n)) + HALF[2] * Math.abs(dot(A.u[2], n));
    const rb = HALF[0] * Math.abs(dot(B.u[0], n)) + HALF[1] * Math.abs(dot(B.u[1], n)) + HALF[2] * Math.abs(dot(B.u[2], n));
    const dist = dot(d, n), o = ra + rb - Math.abs(dist);
    if (o <= 0) return false;
    if (o < best * (L === 1 ? 1 : 0.95)) {
      best = o;
      bn = dist < 0 ? mul(n, -1) : n;
    }
    return true;
  };
  for (let i = 0; i < 3; i++) if (!test(A.u[i]) || !test(B.u[i])) return null;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (!test(cross(A.u[i], B.u[j]))) return null;
  return bn;
}

export class BotClash {
  #bots: Map<number, { tl: BotTimeline }> | null = null;
  #pairs = new Map<string, Pair>();
  #wait = new Map<number, { from: number; until: number }>();
  #last = -Infinity;

  // Bot u has keyframes from f0 on (they replace what it had from there): its pairs are checked from there.
  check(bots: Map<number, { tl: BotTimeline }>, u: number, f0: number, replaced: boolean, host: ClashHost) {
    const now = host.now();
    // Another plan, or the round started again.
    if (bots !== this.#bots || now == null || now < this.#last - 1000) {
      this.#bots = bots;
      this.#pairs.clear();
      this.#wait.clear();
    }
    if (now == null) return;
    this.#last = now;
    if (replaced) this.#wait.delete(u);
    const perf = performance.now();
    for (const [v, x] of this.#wait) if (perf > x.until) this.#wait.delete(v);
    const ids = [...bots.keys()].sort((a, b) => a - b);
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) {
        const key = `${ids[i]}:${ids[j]}`;
        let p = this.#pairs.get(key);
        if (!p) this.#pairs.set(key, (p = { a: ids[i], b: ids[j], at: -Infinity, floor: -Infinity, ghost: true, cool: -Infinity }));
        if (p.a === u || p.b === u) p.at = Math.max(p.floor, Math.min(p.at, f0));
        this.#pair(p, bots.get(p.a)!.tl, bots.get(p.b)!.tl, now, host);
      }
  }

  #pair(p: Pair, A: BotTimeline, B: BotTimeline, now: number, host: ClashHost) {
    let t = Math.max(p.at, Math.ceil(now / STEP) * STEP);
    const end = Math.min(A.end, B.end, t + SPAN, this.#wait.get(p.a)?.from ?? Infinity, this.#wait.get(p.b)?.from ?? Infinity);
    for (; t <= end; t += STEP) {
      const a = A.pose(t), b = B.pose(t);
      if (!a || !b) {
        p.ghost = true;
        continue;
      }
      if (len(sub(a.p, b.p)) > NEAR) {
        p.ghost = false;
        continue;
      }
      const n = overlap(box(a.p, a.q), box(b.p, b.q));
      if (!n) {
        p.ghost = false;
        continue;
      }
      if (a.since < SPAWN_MS || b.since < SPAWN_MS) {
        p.ghost = true;
        continue;
      }
      if (p.ghost || t < p.cool) continue;
      const rel = sub(a.v, b.v), vn = dot(rel, n);
      if (vn >= 0) continue;
      let dv = mul(n, -BOUNCE * vn);
      const vt = sub(rel, mul(n, vn)), vtl = len(vt);
      if (vtl > 1e-4) dv = sub(dv, mul(vt, Math.min(0.5 * vtl, FRICTION * BOUNCE * -vn) / vtl));
      host.hit(p.a, t, dv);
      host.hit(p.b, t, mul(dv, -1));
      p.cool = t + COOL_MS;
      p.floor = t + STEP;
      const until = performance.now() + WAIT_MS;
      this.#wait.set(p.a, { from: t, until });
      this.#wait.set(p.b, { from: t, until });
      t += STEP;
      break;
    }
    p.at = Math.max(p.at, t);
  }
}
