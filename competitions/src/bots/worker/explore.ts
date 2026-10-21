// A route for a track nobody has driven yet: rays map every drivable surface on a 2-unit grid (a floor
// is an upward face with room for a car above it), neighbouring floors at nearly the same height
// connect unless a wall or barrier stands between them, and A* (preferring the middle of the road)
// runs from the start through one gate of each checkpoint group to the finish. Wall rides, loops and
// jumps over gaps can't be found this way; the bots then sit the track out.
import type { Gate } from './gates.ts';
import type { PlacedPart, TrackRays } from './rays.ts';

const CELL = 2;
const MAX_LAYERS = 4;
// Floors whose surface leans more than this are walls (normal.y below).
const FLOOR_NY = 0.6;
const CAR_ROOM = 1.1;
const STEP = 0.8;
const STEP_UP = 1.4;
const MAX_DROP = 30;
const JUMP_CELLS = 22;
const MAX_NODES = 600_000;
const MAX_EXPAND = 2_000_000;

export interface PathPoint {
  x: number;
  y: number;
  z: number;
  // Surface normal.
  nx: number;
  ny: number;
  nz: number;
}

interface Grid {
  x0: number;
  z0: number;
  nx: number;
  nz: number;
  // Nodes of cell c: first[c] .. first[c + 1].
  first: Int32Array;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  ny: Float32Array;
  normal: Float32Array;
  clear: Uint8Array;
}

export function mapFloors(rays: TrackRays, parts: PlacedPart[]): Grid | null {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, top = -Infinity;
  for (const p of parts) {
    x0 = Math.min(x0, p.x * 5);
    x1 = Math.max(x1, p.x * 5);
    z0 = Math.min(z0, p.z * 5);
    z1 = Math.max(z1, p.z * 5);
    top = Math.max(top, p.y * 5);
  }
  if (!Number.isFinite(x0)) return null;
  // Off the 5-unit lattice: a ray down a seam between two parts' meshes can miss both.
  x0 -= 25.37;
  z0 -= 25.37;
  const nx = Math.ceil((x1 + 25 - x0) / CELL), nz = Math.ceil((z1 + 25 - z0) / CELL);
  if (nx * nz > 4_000_000) return null;
  top += 30;
  const out = new Float32Array(3), part = new Int32Array(1), up = new Float32Array(3);
  const counts = new Int32Array(nx * nz + 1);
  const xs: number[] = [], ys: number[] = [], zs: number[] = [], ns: number[] = [];
  for (let c = 0; c < nx * nz; c++) {
    const cx = x0 + ((c % nx) + 0.5) * CELL, cz = z0 + (Math.floor(c / nx) + 0.5) * CELL;
    let y = top, found = 0;
    for (let guard = 0; guard < 12 && found < MAX_LAYERS && y > 0.5; guard++) {
      const t = rays.cast(cx, y, cz, 0, -1, 0, y + 1, out, part);
      if (!(t < Infinity) || part[0] < 0) break;
      const hy = y - t;
      if (out[1] >= FLOOR_NY) {
        const above = rays.cast(cx, hy + 0.1, cz, 0, 1, 0, CAR_ROOM, up);
        if (!(above < CAR_ROOM)) {
          xs.push(cx);
          ys.push(hy);
          zs.push(cz);
          ns.push(out[0], out[1], out[2]);
          found++;
        }
      }
      y = hy - 0.05;
    }
    counts[c + 1] = found;
    if (xs.length > MAX_NODES) return null;
  }
  for (let c = 0; c < nx * nz; c++) counts[c + 1] += counts[c];
  const n = xs.length;
  const g: Grid = {
    x0, z0, nx, nz, first: counts, x: Float32Array.from(xs), y: Float32Array.from(ys), z: Float32Array.from(zs),
    ny: new Float32Array(n), normal: Float32Array.from(ns), clear: new Uint8Array(n),
  };
  for (let i = 0; i < n; i++) g.ny[i] = ns[i * 3 + 1];
  clearance(g);
  return g;
}

// The neighbour floor in cell c at about height y, or -1 (a ramp climbs up to STEP_UP a cell).
export function floorNear(g: Grid, c: number, y: number) {
  let best = -1, bd = Infinity;
  for (let j = g.first[c]; j < g.first[c + 1]; j++) {
    const dy = g.y[j] - y;
    if (dy > STEP_UP || dy < -STEP) continue;
    const d = Math.abs(dy);
    if (d < bd) {
      bd = d;
      best = j;
    }
  }
  return best;
}

// The highest floor in cell c that is a drop of at most MAX_DROP below y, or -1.
function floorBelow(g: Grid, c: number, y: number) {
  let best = -1;
  for (let j = g.first[c]; j < g.first[c + 1]; j++) if (g.y[j] < y - STEP && g.y[j] >= y - MAX_DROP && (best < 0 || g.y[j] > g.y[best])) best = j;
  return best;
}

const DX = [1, -1, 0, 0, 1, 1, -1, -1], DZ = [0, 0, 1, -1, 1, -1, 1, -1];

// Cells to the nearest place a car can't go on from (an edge, a barrier, a step), at most 255.
function clearance(g: Grid) {
  const n = g.x.length;
  const cellOf = new Int32Array(n);
  for (let c = 0; c < g.nx * g.nz; c++) for (let j = g.first[c]; j < g.first[c + 1]; j++) cellOf[j] = c;
  g.clear.fill(255);
  let queue: number[] = [];
  for (let i = 0; i < n; i++) {
    const c = cellOf[i], cx = c % g.nx, cz = Math.floor(c / g.nx);
    for (let k = 0; k < 8; k++) {
      const ax = cx + DX[k], az = cz + DZ[k];
      if (ax < 0 || az < 0 || ax >= g.nx || az >= g.nz || floorNear(g, az * g.nx + ax, g.y[i]) < 0) {
        g.clear[i] = 0;
        queue.push(i);
        break;
      }
    }
  }
  for (let d = 1; d < 255 && queue.length; d++) {
    const next: number[] = [];
    for (const i of queue) {
      const c = cellOf[i], cx = c % g.nx, cz = Math.floor(c / g.nx);
      for (let k = 0; k < 4; k++) {
        const ax = cx + DX[k], az = cz + DZ[k];
        if (ax < 0 || az < 0 || ax >= g.nx || az >= g.nz) continue;
        const j = floorNear(g, az * g.nx + ax, g.y[i]);
        if (j >= 0 && g.clear[j] > d) {
          g.clear[j] = d;
          next.push(j);
        }
      }
    }
    queue = next;
  }
}

class Heap {
  #k: number[] = [];
  #v: number[] = [];
  get size() {
    return this.#k.length;
  }
  push(key: number, v: number) {
    const k = this.#k, a = this.#v;
    let i = k.length;
    k.push(key);
    a.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p];
      a[i] = a[p];
      i = p;
    }
    k[i] = key;
    a[i] = v;
  }
  pop() {
    const k = this.#k, a = this.#v;
    const top = a[0];
    const lk = k.pop()!, lv = a.pop()!;
    if (k.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= k.length) break;
        if (c + 1 < k.length && k[c + 1] < k[c]) c++;
        if (k[c] >= lk) break;
        k[i] = k[c];
        a[i] = a[c];
        i = c;
      }
      k[i] = lk;
      a[i] = lv;
    }
    return top;
  }
}

function inGate(g: Grid, i: number, gate: Gate) {
  const m = 1;
  return g.x[i] >= gate.min[0] - m && g.x[i] <= gate.max[0] + m && g.z[i] >= gate.min[2] - m && g.z[i] <= gate.max[2] + m && g.y[i] >= gate.min[1] - 1.5 && g.y[i] <= gate.max[1];
}

function search(rays: TrackRays, g: Grid, from: number, goal: (i: number) => boolean, hx: number, hy: number, hz: number): number[] | null {
  const n = g.x.length;
  const cost = new Float32Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const heap = new Heap();
  const out = new Float32Array(3);
  cost[from] = 0;
  heap.push(0, from);
  let expanded = 0;
  while (heap.size) {
    const i = heap.pop();
    if (goal(i)) {
      const path: number[] = [];
      for (let p = i; p >= 0; p = prev[p]) path.push(p);
      return path.reverse();
    }
    if (++expanded > MAX_EXPAND) return null;
    const c0 = Math.floor((g.z[i] - g.z0) / CELL) * g.nx + Math.floor((g.x[i] - g.x0) / CELL);
    const cx = c0 % g.nx, cz = Math.floor(c0 / g.nx);
    for (let k = 0; k < 8; k++) {
      const ax = cx + DX[k], az = cz + DZ[k];
      if (ax < 0 || az < 0 || ax >= g.nx || az >= g.nz) continue;
      const cell = az * g.nx + ax;
      let j = floorNear(g, cell, g.y[i]);
      // Off a ledge onto a lower floor next to it (one way).
      const drop = j < 0 && g.clear[i] <= 1 ? floorBelow(g, cell, g.y[i]) : -1;
      if (j < 0) j = drop;
      if (j < 0) continue;
      const dx = g.x[j] - g.x[i], dy = g.y[j] - g.y[i], dz = g.z[j] - g.z[i];
      const d = (dx * dx + dy * dy + dz * dz) ** 0.5;
      // Middle of the road costs less; a cell next to an edge costs a lot more; drops cost more again.
      const c = cost[i] + d * (1 + 3 / (1 + g.clear[j])) + (drop >= 0 ? 10 - dy : 0);
      if (c >= cost[j]) continue;
      // A wall or barrier between the two floors (for a drop, at the ledge's height).
      const t = rays.cast(g.x[i], g.y[i] + 0.6, g.z[i], dx, drop >= 0 ? 0 : dy, dz, 1, out);
      if (t < 1) continue;
      cost[j] = c;
      prev[j] = i;
      const ex = g.x[j] - hx, ey = g.y[j] - hy, ez = g.z[j] - hz;
      heap.push(c + (ex * ex + ey * ey + ez * ez) ** 0.5, j);
    }
    // At an edge: a jump over a gap to a floor further on, no higher than here.
    if (g.clear[i] === 0) {
      for (let k = 0; k < 8; k++) {
        for (let s = 3; s <= JUMP_CELLS; s++) {
          const ax = cx + DX[k] * s, az = cz + DZ[k] * s;
          if (ax < 0 || az < 0 || ax >= g.nx || az >= g.nz) break;
          const c1 = az * g.nx + ax;
          let j = -1;
          for (let q = g.first[c1]; q < g.first[c1 + 1]; q++) if (g.y[q] <= g.y[i] + 1 && g.y[q] >= g.y[i] - 20 && g.clear[q] >= 2 && (j < 0 || g.y[q] > g.y[j])) j = q;
          if (j < 0) continue;
          const dx = g.x[j] - g.x[i], dz = g.z[j] - g.z[i];
          const c = cost[i] + (dx * dx + dz * dz) ** 0.5 * 2 + 25;
          if (c < cost[j] && !(rays.cast(g.x[i], g.y[i] + 0.8, g.z[i], dx, 0, dz, 1, out) < 1)) {
            cost[j] = c;
            prev[j] = i;
            const ex = g.x[j] - hx, ey = g.y[j] - hy, ez = g.z[j] - hz;
            heap.push(c + (ex * ex + ey * ey + ez * ez) ** 0.5, j);
          }
          break;
        }
      }
    }
  }
  return null;
}

export function nearestNode(g: Grid, x: number, y: number, z: number) {
  let best = -1, bd = Infinity;
  const cx = Math.floor((x - g.x0) / CELL), cz = Math.floor((z - g.z0) / CELL);
  for (let a = -2; a <= 2; a++)
    for (let b = -2; b <= 2; b++) {
      const ax = cx + a, az = cz + b;
      if (ax < 0 || az < 0 || ax >= g.nx || az >= g.nz) continue;
      const c = az * g.nx + ax;
      for (let j = g.first[c]; j < g.first[c + 1]; j++) {
        const dy = g.y[j] - y;
        if (dy > 1 || dy < -3) continue;
        const d = (g.x[j] - x) ** 2 + (g.z[j] - z) ** 2 + dy * dy;
        if (d < bd) {
          bd = d;
          best = j;
        }
      }
    }
  return best;
}

// Centre of a group's gates nearest to (x, y, z), for the heuristic.
function aim(gates: Gate[], x: number, y: number, z: number) {
  let best = gates[0], bd = Infinity;
  for (const gt of gates) {
    const cx = (gt.min[0] + gt.max[0]) / 2, cy = (gt.min[1] + gt.max[1]) / 2, cz = (gt.min[2] + gt.max[2]) / 2;
    const d = (cx - x) ** 2 + (cy - y) ** 2 + (cz - z) ** 2;
    if (d < bd) {
      bd = d;
      best = gt;
    }
  }
  return [(best.min[0] + best.max[0]) / 2, (best.min[1] + best.max[1]) / 2, (best.min[2] + best.max[2]) / 2];
}

// info (optional) says how far it got.
export function explore(rays: TrackRays, parts: PlacedPart[], groups: Gate[][], finish: Gate[], start: { x: number; y: number; z: number }, info: { why?: string; nodes?: number; legs?: number; from?: number[]; aim?: number[] } = {}): PathPoint[] | null {
  if (!finish.length) return (info.why = 'no finish'), null;
  const g = mapFloors(rays, parts);
  if (!g) return (info.why = 'map'), null;
  info.nodes = g.x.length;
  info.legs = 0;
  let at = nearestNode(g, start.x, start.y - 0.3, start.z);
  if (at < 0) return (info.why = 'start'), null;
  const nodes: number[] = [at];
  for (const group of [...groups, finish]) {
    if (!group.length) continue;
    const [hx, hy, hz] = aim(group, g.x[at], g.y[at], g.z[at]);
    const leg = search(rays, g, at, (i) => group.some((gt) => inGate(g, i, gt)), hx, hy, hz);
    if (!leg) {
      info.from = [g.x[at], g.y[at], g.z[at]];
      info.aim = [hx, hy, hz];
      info.why = 'leg ' + info.legs;
      return null;
    }
    info.legs++;
    nodes.push(...leg.slice(1));
    // Carry on a few cells through the gate so the next leg doesn't turn inside it.
    at = leg[leg.length - 1];
  }
  return smooth(g, nodes);
}

// Moving average over about 6 units, then points every unit.
function smooth(g: Grid, nodes: number[]): PathPoint[] {
  const raw = nodes.map((i) => ({ x: g.x[i], y: g.y[i], z: g.z[i], nx: g.normal[i * 3], ny: g.normal[i * 3 + 1], nz: g.normal[i * 3 + 2] }));
  // Grid steps zig-zag; two moving averages over about 16 units each way leave the real bends.
  const pass = (pts: PathPoint[], w: number) =>
    pts.map((_, i) => {
      let x = 0, y = 0, z = 0, a = 0, b = 0, c = 0, n = 0;
      // Symmetric, so both ends stay where they are.
      const r = Math.min(w, i, pts.length - 1 - i);
      for (let k = i - r; k <= i + r; k++) {
        const p = pts[k];
        x += p.x;
        y += p.y;
        z += p.z;
        a += p.nx;
        b += p.ny;
        c += p.nz;
        n++;
      }
      const nl = (a * a + b * b + c * c) ** 0.5 || 1;
      return { x: x / n, y: y / n, z: z / n, nx: a / nl, ny: b / nl, nz: c / nl };
    });
  const avg = pass(pass(raw, 8), 8);
  const out: PathPoint[] = [avg[0]];
  let carry = 0;
  for (let i = 1; i < avg.length; i++) {
    const a = avg[i - 1], b = avg[i];
    const d = ((b.x - a.x) ** 2 + (b.y - a.y) ** 2 + (b.z - a.z) ** 2) ** 0.5;
    let s = 1 - carry;
    while (s <= d) {
      const u = s / d;
      out.push({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, z: a.z + (b.z - a.z) * u, nx: a.nx + (b.nx - a.nx) * u, ny: a.ny + (b.ny - a.ny) * u, nz: a.nz + (b.nz - a.nz) * u });
      s += 1;
    }
    carry = d - (s - 1);
  }
  return out;
}
