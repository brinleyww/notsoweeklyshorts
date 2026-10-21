// Checkpoint and finish detector boxes in world space, grouped the way the physics counts them:
// nextCheckpointIndex k needs any part of the k-th smallest distinct checkpoint order (gaps in the orders
// don't matter), and the finish counts once k equals the number of groups.
import { ORIENT, orientIndex, quatBasis, type PlacedPart } from './rays.ts';

export interface Gate {
  // checkpointOrder; -1 for a finish.
  order: number;
  // The nextCheckpointIndex this gate is crossed at.
  rank: number;
  // Index into the parts given.
  part: number;
  min: [number, number, number];
  max: [number, number, number];
  // The thin axis of the box (crossing direction; either sign counts).
  normal: [number, number, number];
}

const CHECKPOINT = 0, FINISH = 1;

export function gatesOf(
  parts: (PlacedPart & { cp: number | null })[],
  detectors: Map<number, { type: number; center: number[]; size: number[] }>,
): { groups: Gate[][]; finish: Gate[] } {
  const cps: Gate[] = [], finish: Gate[] = [];
  for (let j = 0; j < parts.length; j++) {
    const p = parts[j], d = detectors.get(p.id), o = orientIndex(p.rot, p.axis);
    if (!d || !(o >= 0 && o < 24) || (d.type !== CHECKPOINT && d.type !== FINISH)) continue;
    if (d.type === CHECKPOINT && p.cp == null) continue;
    const r = o * 9, at = [p.x * 5, p.y * 5, p.z * 5];
    const min: [number, number, number] = [0, 0, 0], max: [number, number, number] = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      let c = at[a], h = 0;
      for (let k = 0; k < 3; k++) {
        const m = ORIENT[r + a * 3 + k];
        c += m * d.center[k];
        h += (m < 0 ? -m : m) * d.size[k] / 2;
      }
      min[a] = c - h;
      max[a] = c + h;
    }
    const gate: Gate = {
      order: d.type === FINISH ? -1 : p.cp!, rank: 0, part: j, min, max,
      normal: [ORIENT[r + 2] + 0, ORIENT[r + 5] + 0, ORIENT[r + 8] + 0],
    };
    (d.type === FINISH ? finish : cps).push(gate);
  }
  const orders = [...new Set(cps.map((g) => g.order))].sort((a, b) => a - b);
  const rank = new Map(orders.map((o, i) => [o, i]));
  const groups: Gate[][] = orders.map(() => []);
  for (const g of cps) {
    g.rank = rank.get(g.order)!;
    groups[g.rank].push(g);
  }
  for (const g of finish) g.rank = orders.length;
  return { groups, finish };
}

// The car's collision hull as a box in the car-state frame (+z front): the Init hull's bounds with the mass
// offset and a 0.02 margin. On the 71 community-track WRs it starts touching the gate within one frame of
// the physics' own checkpoint step 96% of the time.
const HC = new Float64Array([0, 0.616, -0.153]), HH = new Float64Array([0.773, 0.382, 1.843]);
const B = new Float64Array(9), A = new Float64Array(9), T = new Float64Array(3), G = new Float64Array(3);

// Whether the hull box of a car at (x, y, z) with rotation q overlaps the gate's box. A prediction only:
// the physics' nextCheckpointIndex is what counts.
export function hullTouches(g: Gate, x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number): boolean {
  quatBasis(qx, qy, qz, qw, B);
  for (let k = 0; k < 9; k++) A[k] = (B[k] < 0 ? -B[k] : B[k]) + 1e-9;
  T[0] = x; T[1] = y; T[2] = z;
  for (let i = 0; i < 3; i++) {
    T[i] += B[i * 3] * HC[0] + B[i * 3 + 1] * HC[1] + B[i * 3 + 2] * HC[2] - (g.min[i] + g.max[i]) / 2;
    G[i] = (g.max[i] - g.min[i]) / 2;
  }
  // Separating axes: the world axes, the hull's axes (column j of B), and their cross products.
  for (let i = 0; i < 3; i++) {
    const t = T[i] < 0 ? -T[i] : T[i];
    if (t > G[i] + HH[0] * A[i * 3] + HH[1] * A[i * 3 + 1] + HH[2] * A[i * 3 + 2]) return false;
  }
  for (let j = 0; j < 3; j++) {
    const p = T[0] * B[j] + T[1] * B[3 + j] + T[2] * B[6 + j];
    if ((p < 0 ? -p : p) > G[0] * A[j] + G[1] * A[3 + j] + G[2] * A[6 + j] + HH[j]) return false;
  }
  for (let i = 0; i < 3; i++) {
    const i1 = (i + 1) % 3, i2 = (i + 2) % 3;
    for (let j = 0; j < 3; j++) {
      const j1 = (j + 1) % 3, j2 = (j + 2) % 3;
      const p = T[i2] * B[i1 * 3 + j] - T[i1] * B[i2 * 3 + j];
      if ((p < 0 ? -p : p) > G[i1] * A[i2 * 3 + j] + G[i2] * A[i1 * 3 + j] + HH[j1] * A[i * 3 + j2] + HH[j2] * A[i * 3 + j1]) return false;
    }
  }
  return true;
}
