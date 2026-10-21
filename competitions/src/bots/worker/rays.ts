// Ray casts against what the physics collides with: the Init part meshes placed like the game places
// them (5 * tile, then the eo rotation), the ground plane y = 0 and the mountain ring. One BVH per part
// type, built once per worker, and one over a track's part instances. The cast paths allocate nothing
// and use no Math: the sim worker swaps Math for slow deterministic versions.

const H = 0.7071067811865476;
// The game's eo[axis][rotation] as (x, y, z, w).
const EO = [
  [0, 0, 0, 1], [0, H, 0, H], [0, 1, 0, 0], [0, H, 0, -H],
  [0, 0, 1, 0], [H, 0, H, 0], [1, 0, 0, 0], [H, 0, -H, 0],
  [0, 0, -H, H], [0.5, 0.5, -0.5, 0.5], [H, H, 0, 0], [0.5, 0.5, 0.5, -0.5],
  [0, 0, H, H], [0.5, -0.5, 0.5, 0.5], [H, -H, 0, 0], [0.5, -0.5, -0.5, -0.5],
  [H, 0, 0, H], [0.5, 0.5, 0.5, 0.5], [0, H, H, 0], [-0.5, 0.5, 0.5, -0.5],
  [-H, 0, 0, H], [-0.5, -0.5, 0.5, 0.5], [0, -H, H, 0], [0.5, -0.5, 0.5, -0.5],
];

// Row-major rotation matrix of a unit quaternion: world = B * local.
export function quatBasis(x: number, y: number, z: number, w: number, out: Float64Array | Float32Array | number[]): void {
  out[0] = 1 - 2 * (y * y + z * z); out[1] = 2 * (x * y - z * w); out[2] = 2 * (x * z + y * w);
  out[3] = 2 * (x * y + z * w); out[4] = 1 - 2 * (x * x + z * z); out[5] = 2 * (y * z - x * w);
  out[6] = 2 * (x * z - y * w); out[7] = 2 * (y * z + x * w); out[8] = 1 - 2 * (x * x + y * y);
}

// The 24 part orientations as exact signed permutation matrices (9 each, row-major, world = R * local),
// indexed by orientIndex.
export const ORIENT = new Float64Array(24 * 9);
for (let o = 0; o < 24; o++) {
  const q = EO[o];
  quatBasis(q[0], q[1], q[2], q[3], ORIENT.subarray(o * 9, o * 9 + 9));
  for (let k = o * 9; k < o * 9 + 9; k++) ORIENT[k] = Math.round(ORIENT[k]) + 0;
}
export const orientIndex = (rot: number, axis: number) => axis * 4 + rot;

const NONE = 0, MESH = 1, BOX = 2;
const BINS = 16;

interface Bvh {
  // 6 per node (min xyz, max xyz), rounded outwards to float32.
  box: Float32Array;
  // 2 per node: [left child, 0] (the right child follows it) or [first primitive, count] for a leaf.
  link: Int32Array;
  // Primitive index per leaf slot.
  order: Int32Array;
  nodes: number;
  depth: number;
}

function down32(v: number) {
  const r = Math.fround(v);
  return r <= v ? r : Math.fround(v - (v < 0 ? -v : v) * 2.4e-7 - 1e-30);
}
function up32(v: number) {
  const r = Math.fround(v);
  return r >= v ? r : Math.fround(v + (v < 0 ? -v : v) * 2.4e-7 + 1e-30);
}
const area = (x: number, y: number, z: number) => x * y + y * z + z * x;

// Binned SAH over primitive boxes (3 per primitive in lo/hi); n >= 1.
function buildBvh(n: number, lo: Float64Array, hi: Float64Array, leafMax: number): Bvh {
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const cap = 2 * n - 1;
  const box = new Float32Array(cap * 6), link = new Int32Array(cap * 2);
  const cen = new Float64Array(n * 3);
  for (let i = 0; i < n * 3; i++) cen[i] = lo[i] + hi[i];
  const bLo = new Float64Array(BINS * 3), bHi = new Float64Array(BINS * 3), bN = new Int32Array(BINS);
  const rA = new Float64Array(BINS), rN = new Int32Array(BINS);
  // Centroid bounds of the node being split: min xyz, max xyz.
  const cb = new Float64Array(6);
  const work = [0, 0, n, 1];
  let nodes = 1, depth = 0;
  while (work.length) {
    const d = work.pop()!, e = work.pop()!, s = work.pop()!, node = work.pop()!;
    if (d > depth) depth = d;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    cb[0] = cb[1] = cb[2] = Infinity;
    cb[3] = cb[4] = cb[5] = -Infinity;
    for (let k = s; k < e; k++) {
      const i = order[k] * 3;
      if (lo[i] < x0) x0 = lo[i];
      if (lo[i + 1] < y0) y0 = lo[i + 1];
      if (lo[i + 2] < z0) z0 = lo[i + 2];
      if (hi[i] > x1) x1 = hi[i];
      if (hi[i + 1] > y1) y1 = hi[i + 1];
      if (hi[i + 2] > z1) z1 = hi[i + 2];
      for (let a = 0; a < 3; a++) {
        const c = cen[i + a];
        if (c < cb[a]) cb[a] = c;
        if (c > cb[a + 3]) cb[a + 3] = c;
      }
    }
    const b = node * 6;
    box[b] = down32(x0); box[b + 1] = down32(y0); box[b + 2] = down32(z0);
    box[b + 3] = up32(x1); box[b + 4] = up32(y1); box[b + 5] = up32(z1);
    const count = e - s;
    if (count <= leafMax) {
      link[node * 2] = s;
      link[node * 2 + 1] = count;
      continue;
    }
    let bestCost = Infinity, bestAxis = -1, bestBin = 0, bestScale = 0;
    // Big nodes only try their widest axis: a quarter off the build time, no slower rays.
    let wide = 0;
    for (let a = 1; a < 3; a++) if (cb[a + 3] - cb[a] > cb[wide + 3] - cb[wide]) wide = a;
    for (let a = 0; a < 3; a++) {
      if (count > 256 && a !== wide) continue;
      const ext = cb[a + 3] - cb[a];
      if (!(ext > 0)) continue;
      const scale = BINS / ext, c0 = cb[a];
      bN.fill(0); bLo.fill(Infinity); bHi.fill(-Infinity);
      for (let k = s; k < e; k++) {
        const i = order[k] * 3;
        let bin = ((cen[i + a] - c0) * scale) | 0;
        if (bin >= BINS) bin = BINS - 1;
        bN[bin]++;
        const q = bin * 3;
        for (let c = 0; c < 3; c++) {
          if (lo[i + c] < bLo[q + c]) bLo[q + c] = lo[i + c];
          if (hi[i + c] > bHi[q + c]) bHi[q + c] = hi[i + c];
        }
      }
      let ax0 = Infinity, ay0 = Infinity, az0 = Infinity, ax1 = -Infinity, ay1 = -Infinity, az1 = -Infinity, cnt = 0;
      for (let bin = BINS - 1; bin > 0; bin--) {
        const q = bin * 3;
        if (bN[bin]) {
          if (bLo[q] < ax0) ax0 = bLo[q];
          if (bLo[q + 1] < ay0) ay0 = bLo[q + 1];
          if (bLo[q + 2] < az0) az0 = bLo[q + 2];
          if (bHi[q] > ax1) ax1 = bHi[q];
          if (bHi[q + 1] > ay1) ay1 = bHi[q + 1];
          if (bHi[q + 2] > az1) az1 = bHi[q + 2];
        }
        cnt += bN[bin];
        rN[bin] = cnt;
        rA[bin] = cnt ? area(ax1 - ax0, ay1 - ay0, az1 - az0) : 0;
      }
      ax0 = ay0 = az0 = Infinity; ax1 = ay1 = az1 = -Infinity; cnt = 0;
      for (let bin = 0; bin < BINS - 1; bin++) {
        const q = bin * 3;
        if (bN[bin]) {
          if (bLo[q] < ax0) ax0 = bLo[q];
          if (bLo[q + 1] < ay0) ay0 = bLo[q + 1];
          if (bLo[q + 2] < az0) az0 = bLo[q + 2];
          if (bHi[q] > ax1) ax1 = bHi[q];
          if (bHi[q + 1] > ay1) ay1 = bHi[q + 1];
          if (bHi[q + 2] > az1) az1 = bHi[q + 2];
        }
        cnt += bN[bin];
        if (!cnt || !rN[bin + 1]) continue;
        const cost = area(ax1 - ax0, ay1 - ay0, az1 - az0) * cnt + rA[bin + 1] * rN[bin + 1];
        if (cost < bestCost) {
          bestCost = cost;
          bestAxis = a;
          bestBin = bin + 1;
          bestScale = scale;
        }
      }
    }
    let mid = s;
    if (bestAxis >= 0) {
      const c0 = cb[bestAxis];
      let i0 = s, i1 = e - 1;
      while (i0 <= i1) {
        let bin = ((cen[order[i0] * 3 + bestAxis] - c0) * bestScale) | 0;
        if (bin >= BINS) bin = BINS - 1;
        if (bin < bestBin) i0++;
        else {
          const t = order[i0]; order[i0] = order[i1]; order[i1] = t;
          i1--;
        }
      }
      mid = i0;
    }
    // Every centroid in one place (stacked duplicates): split by index.
    if (mid <= s || mid >= e) mid = (s + e) >> 1;
    const left = nodes;
    nodes += 2;
    link[node * 2] = left;
    link[node * 2 + 1] = 0;
    work.push(left, s, mid, d + 1, left + 1, mid, e, d + 1);
  }
  return { box: box.slice(0, nodes * 6), link: link.slice(0, nodes * 2), order, nodes, depth };
}

// A closed axis-aligned box of 12 triangles: cast by its bounds alone.
function closedBox(v: Float32Array, lo: Float64Array, hi: Float64Array): boolean {
  if (v.length !== 108) return false;
  for (let a = 0; a < 3; a++) if (!(hi[a] > lo[a])) return false;
  const face = new Float64Array(6);
  for (let t = 0; t < 108; t += 9) {
    let on = -1;
    for (let a = 0; a < 3; a++) {
      const p = v[t + a], q = v[t + 3 + a], r = v[t + 6 + a];
      if ((p !== lo[a] && p !== hi[a]) || (q !== lo[a] && q !== hi[a]) || (r !== lo[a] && r !== hi[a])) return false;
      if (p === q && q === r) on = a * 2 + (p === hi[a] ? 1 : 0);
    }
    if (on < 0) return false;
    const e1x = v[t + 3] - v[t], e1y = v[t + 4] - v[t + 1], e1z = v[t + 5] - v[t + 2];
    const e2x = v[t + 6] - v[t], e2y = v[t + 7] - v[t + 1], e2z = v[t + 8] - v[t + 2];
    const cx = e1y * e2z - e1z * e2y, cy = e1z * e2x - e1x * e2z, cz = e1x * e2y - e1y * e2x;
    face[on] += (cx * cx + cy * cy + cz * cz) ** 0.5 / 2;
  }
  for (let a = 0; a < 3; a++) {
    const b = (a + 1) % 3, c = (a + 2) % 3, want = (hi[b] - lo[b]) * (hi[c] - lo[c]);
    for (let s = 0; s < 2; s++) if (!(face[a * 2 + s] > want * 0.999999 && face[a * 2 + s] < want * 1.000001)) return false;
  }
  return true;
}

// Triangles as v0, e1, e2 (9 floats each) in BVH leaf order.
function packTriangles(v: Float32Array, order: Int32Array, out: Float32Array, at: number) {
  for (let k = 0; k < order.length; k++) {
    const s = order[k] * 9, o = (at + k) * 9;
    out[o] = v[s]; out[o + 1] = v[s + 1]; out[o + 2] = v[s + 2];
    out[o + 3] = v[s + 3] - v[s]; out[o + 4] = v[s + 4] - v[s + 1]; out[o + 5] = v[s + 5] - v[s + 2];
    out[o + 6] = v[s + 6] - v[s]; out[o + 7] = v[s + 7] - v[s + 1]; out[o + 8] = v[s + 8] - v[s + 2];
  }
}

function triangleBounds(v: Float32Array, n: number) {
  const lo = new Float64Array(n * 3), hi = new Float64Array(n * 3);
  for (let t = 0; t < n; t++) {
    for (let a = 0; a < 3; a++) {
      const p = v[t * 9 + a], q = v[t * 9 + 3 + a], r = v[t * 9 + 6 + a];
      lo[t * 3 + a] = p < q ? (p < r ? p : r) : q < r ? q : r;
      hi[t * 3 + a] = p > q ? (p > r ? p : r) : q > r ? q : r;
    }
  }
  return { lo, hi };
}

// Rays reach the functions below through these, not as arguments: V8 boxes a double argument or return
// value on every call it does not inline. RAY: the world ray (origin, direction), maxT, then t.
// LOC: a ray in a part's frame and the best t so far.
const RAY = new Float64Array(7), LOC = new Float64Array(7);
// Set by meshHit: the triangle that gave its result, or -1 if nothing beat LOC[6].
let meshTri = -1;

const inv = (d: number) => (d > 1e-30 || d < -1e-30 ? 1 / d : 1e30);

// Entry distance of the ray into box i (6 floats at b[i]), or Infinity when it misses or enters past best.
function slab(b: Float32Array, i: number, ox: number, oy: number, oz: number, ix: number, iy: number, iz: number, best: number): number {
  let n = (b[i] - ox) * ix, f = (b[i + 3] - ox) * ix;
  if (n > f) { const s = n; n = f; f = s; }
  let p = (b[i + 1] - oy) * iy, q = (b[i + 4] - oy) * iy;
  if (p > q) { const s = p; p = q; q = s; }
  if (p > n) n = p;
  if (q < f) f = q;
  p = (b[i + 2] - oz) * iz; q = (b[i + 5] - oz) * iz;
  if (p > q) { const s = p; p = q; q = s; }
  if (p > n) n = p;
  if (q < f) f = q;
  return n <= f && f > 0 && n <= best ? n : Infinity;
}

// Nearest triangle of one BVH (from node `root`) along LOC with 0 < t <= LOC[6], which it lowers to that t.
// Kept out of TrackRays.#run so its inner loop is optimised the same way on every track.
function meshHit(box: Float32Array, link: Int32Array, tri: Float32Array, root: number, stN: Int32Array, stT: Float64Array): void {
  const ox = LOC[0], oy = LOC[1], oz = LOC[2], dx = LOC[3], dy = LOC[4], dz = LOC[5];
  const ix = inv(dx), iy = inv(dy), iz = inv(dz);
  let best = LOC[6];
  meshTri = -1;
  const t0 = slab(box, root * 6, ox, oy, oz, ix, iy, iz, best);
  if (t0 > best) return;
  stN[0] = root; stT[0] = t0;
  let sp = 1;
  while (sp > 0) {
    sp--;
    if (stT[sp] > best) continue;
    const n = stN[sp], first = link[n * 2], count = link[n * 2 + 1];
    if (count === 0) {
      const tl = slab(box, first * 6, ox, oy, oz, ix, iy, iz, best), tr = slab(box, first * 6 + 6, ox, oy, oz, ix, iy, iz, best);
      // Nearer child on top.
      if (tl <= best) {
        if (tr <= best && tr < tl) {
          stN[sp] = first; stT[sp++] = tl;
          stN[sp] = first + 1; stT[sp++] = tr;
        } else {
          if (tr <= best) { stN[sp] = first + 1; stT[sp++] = tr; }
          stN[sp] = first; stT[sp++] = tl;
        }
      } else if (tr <= best) {
        stN[sp] = first + 1; stT[sp++] = tr;
      }
      continue;
    }
    // Möller-Trumbore, two-sided; triangles are v0, e1, e2.
    for (let q = first, end = first + count; q < end; q++) {
      const i = q * 9;
      const e1x = tri[i + 3], e1y = tri[i + 4], e1z = tri[i + 5], e2x = tri[i + 6], e2y = tri[i + 7], e2z = tri[i + 8];
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (det === 0) continue;
      const id = 1 / det;
      const sx = ox - tri[i], sy = oy - tri[i + 1], sz = oz - tri[i + 2];
      const u = (sx * px + sy * py + sz * pz) * id;
      if (u < 0 || u > 1) continue;
      const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * id;
      if (v < 0 || u + v > 1) continue;
      const t = (e2x * qx + e2y * qy + e2z * qz) * id;
      if (t > 0 && t <= best) { best = t; meshTri = q; }
    }
  }
  LOC[6] = best;
}

// Unit normal of triangle i turned by orientation o, facing RAY's direction, into out[oi..oi+2].
function normal(T: Float32Array, i: number, o: number, out: Float32Array, oi: number) {
  i *= 9;
  const e1x = T[i + 3], e1y = T[i + 4], e1z = T[i + 5], e2x = T[i + 6], e2y = T[i + 7], e2z = T[i + 8];
  const ax = e1y * e2z - e1z * e2y, ay = e1z * e2x - e1x * e2z, az = e1x * e2y - e1y * e2x, r = o * 9;
  const nx = ORIENT[r] * ax + ORIENT[r + 1] * ay + ORIENT[r + 2] * az;
  const ny = ORIENT[r + 3] * ax + ORIENT[r + 4] * ay + ORIENT[r + 5] * az;
  const nz = ORIENT[r + 6] * ax + ORIENT[r + 7] * ay + ORIENT[r + 8] * az;
  const s = (nx * RAY[3] + ny * RAY[4] + nz * RAY[5] > 0 ? -1 : 1) / (nx * nx + ny * ny + nz * nz) ** 0.5;
  out[oi] = nx * s; out[oi + 1] = ny * s; out[oi + 2] = nz * s;
}

// The physics' part meshes (Init trackParts), one BVH per part type. Build once per worker.
export class PartMeshes {
  // Per part id: NONE, MESH or BOX.
  readonly kind = new Uint8Array(256);
  readonly root = new Int32Array(256).fill(-1);
  // Each type's local bounds turned by each orientation, relative to the part's position: 6 per (id * 24 + orientation).
  readonly turned = new Float64Array(256 * 24 * 6);
  readonly box: Float32Array;
  readonly link: Int32Array;
  readonly tri: Float32Array;
  readonly depth: number;
  readonly triangles: number;
  readonly bytes: number;
  readonly buildMs: number;

  constructor(initTrackParts: { id: number; vertices: Float32Array }[]) {
    const t0 = performance.now();
    const built: { v: Float32Array; bvh: Bvh }[] = [];
    let nodes = 0, tris = 0, depth = 0;
    const lo = new Float64Array(3), hi = new Float64Array(3);
    for (const p of initTrackParts) {
      const id = p.id, v = p.vertices, n = (v.length / 9) | 0;
      if (!(id >= 0 && id < 256) || n === 0) continue;
      lo.fill(Infinity); hi.fill(-Infinity);
      for (let i = 0; i < n * 9; i += 3) {
        for (let a = 0; a < 3; a++) {
          if (v[i + a] < lo[a]) lo[a] = v[i + a];
          if (v[i + a] > hi[a]) hi[a] = v[i + a];
        }
      }
      for (let o = 0; o < 24; o++) {
        const r = o * 9, t = (id * 24 + o) * 6;
        for (let d = 0; d < 3; d++) {
          let mn = 0, mx = 0;
          for (let k = 0; k < 3; k++) {
            const a = ORIENT[r + d * 3 + k] * lo[k], b = ORIENT[r + d * 3 + k] * hi[k];
            mn += a < b ? a : b;
            mx += a < b ? b : a;
          }
          this.turned[t + d] = mn;
          this.turned[t + 3 + d] = mx;
        }
      }
      if (closedBox(v, lo, hi)) {
        this.kind[id] = BOX;
        continue;
      }
      const { lo: tl, hi: th } = triangleBounds(v, n);
      const bvh = buildBvh(n, tl, th, 4);
      this.kind[id] = MESH;
      this.root[id] = nodes;
      built.push({ v, bvh });
      nodes += bvh.nodes;
      tris += n;
      if (bvh.depth > depth) depth = bvh.depth;
    }
    this.box = new Float32Array(nodes * 6);
    this.link = new Int32Array(nodes * 2);
    this.tri = new Float32Array(tris * 9);
    let nodeAt = 0, triAt = 0;
    for (const { v, bvh } of built) {
      this.box.set(bvh.box, nodeAt * 6);
      for (let k = 0; k < bvh.nodes; k++) {
        const leaf = bvh.link[k * 2 + 1] > 0;
        this.link[(nodeAt + k) * 2] = bvh.link[k * 2] + (leaf ? triAt : nodeAt);
        this.link[(nodeAt + k) * 2 + 1] = bvh.link[k * 2 + 1];
      }
      packTriangles(v, bvh.order, this.tri, triAt);
      nodeAt += bvh.nodes;
      triAt += bvh.order.length;
    }
    this.depth = depth;
    this.triangles = tris;
    this.bytes = this.box.byteLength + this.link.byteLength + this.tri.byteLength + this.turned.byteLength + 256 * 5;
    this.buildMs = performance.now() - t0;
  }
}

export interface PlacedPart { id: number; x: number; y: number; z: number; rot: number; axis: number }

const HIT_NONE = 0, HIT_GROUND = 1, HIT_MESH = 2, HIT_BOX = 3, HIT_MOUNTAIN = 4;
const INSTANCE_LEAF = 2;

// One track's collision world for rays. partOut values: index into the parts given, -1 ground,
// -2 mountain, -3 nothing hit (normal 0, 0, 0).
export class TrackRays {
  readonly parts: number;
  readonly buildMs: number;
  readonly bytes: number;
  #m: PartMeshes;
  #n: number;
  // Instances in leaf order.
  #type: Uint8Array;
  #ori: Uint8Array;
  #pos: Float32Array;
  #part: Int32Array;
  #box: Float32Array;
  #link: Int32Array;
  // Mountain triangles relative to its offset.
  #mo: Float64Array;
  #mBox: Float32Array;
  #mLink: Int32Array;
  #mTri: Float32Array;
  #stN: Int32Array;
  #stT: Float64Array;
  #lsN: Int32Array;
  #lsT: Float64Array;

  constructor(meshes: PartMeshes, parts: PlacedPart[], mountain: { vertices: Float32Array; offset: { x: number; y: number; z: number } } | null) {
    const t0 = performance.now();
    this.#m = meshes;
    this.parts = parts.length;
    const kind = meshes.kind, turned = meshes.turned;
    const keep = new Int32Array(parts.length);
    let n = 0;
    for (let j = 0; j < parts.length; j++) {
      const p = parts[j], o = orientIndex(p.rot, p.axis);
      if (p.id >= 0 && p.id < 256 && kind[p.id] !== NONE && o >= 0 && o < 24) keep[n++] = j;
    }
    this.#n = n;
    this.#type = new Uint8Array(n);
    this.#ori = new Uint8Array(n);
    this.#pos = new Float32Array(n * 3);
    this.#part = new Int32Array(n);
    let depth = 0;
    if (n > 0) {
      const lo = new Float64Array(n * 3), hi = new Float64Array(n * 3);
      for (let i = 0; i < n; i++) {
        const p = parts[keep[i]], t = (p.id * 24 + orientIndex(p.rot, p.axis)) * 6;
        const px = p.x * 5, py = p.y * 5, pz = p.z * 5;
        lo[i * 3] = px + turned[t]; lo[i * 3 + 1] = py + turned[t + 1]; lo[i * 3 + 2] = pz + turned[t + 2];
        hi[i * 3] = px + turned[t + 3]; hi[i * 3 + 1] = py + turned[t + 4]; hi[i * 3 + 2] = pz + turned[t + 5];
      }
      const bvh = buildBvh(n, lo, hi, INSTANCE_LEAF);
      for (let k = 0; k < n; k++) {
        const j = keep[bvh.order[k]], p = parts[j];
        this.#type[k] = p.id;
        this.#ori[k] = orientIndex(p.rot, p.axis);
        this.#pos[k * 3] = p.x * 5; this.#pos[k * 3 + 1] = p.y * 5; this.#pos[k * 3 + 2] = p.z * 5;
        this.#part[k] = j;
      }
      this.#box = bvh.box;
      this.#link = bvh.link;
      depth = bvh.depth;
    } else {
      this.#box = new Float32Array(0);
      this.#link = new Int32Array(0);
    }
    this.#mo = new Float64Array(3);
    let mDepth = 0;
    const mv = mountain?.vertices, mn = mv ? (mv.length / 9) | 0 : 0;
    if (mountain && mv && mn > 0) {
      this.#mo[0] = mountain.offset.x; this.#mo[1] = mountain.offset.y; this.#mo[2] = mountain.offset.z;
      const { lo, hi } = triangleBounds(mv, mn);
      const bvh = buildBvh(mn, lo, hi, 4);
      this.#mBox = bvh.box;
      this.#mLink = bvh.link;
      this.#mTri = new Float32Array(mn * 9);
      packTriangles(mv, bvh.order, this.#mTri, 0);
      mDepth = bvh.depth;
    } else {
      this.#mBox = new Float32Array(0);
      this.#mLink = new Int32Array(0);
      this.#mTri = new Float32Array(0);
    }
    this.#stN = new Int32Array(depth * 2 + 4);
    this.#stT = new Float64Array(depth * 2 + 4);
    const ld = meshes.depth > mDepth ? meshes.depth : mDepth;
    this.#lsN = new Int32Array(ld * 2 + 4);
    this.#lsT = new Float64Array(ld * 2 + 4);
    this.bytes = this.#type.byteLength * 2 + this.#pos.byteLength + this.#part.byteLength + this.#box.byteLength + this.#link.byteLength +
      this.#mBox.byteLength + this.#mLink.byteLength + this.#mTri.byteLength;
    this.buildMs = performance.now() - t0;
  }

  // Nearest hit along o + d*t, 0 < t <= maxT (d need not be unit; t is in units of |d|). Writes the
  // normal (unit, facing the ray) into out[0..2] and returns t, or Infinity.
  cast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number, out?: Float32Array, partOut?: Int32Array): number {
    RAY[0] = ox; RAY[1] = oy; RAY[2] = oz; RAY[3] = dx; RAY[4] = dy; RAY[5] = dz; RAY[6] = maxT;
    this.#run(out, 0, partOut, 0);
    return RAY[6];
  }

  // Ray j goes from origin along basis * dirs[3j..3j+2] (car-relative directions; basis row-major,
  // e.g. from quatBasis). outT[j] = its t (Infinity for a miss); outN gets 3 floats and outPart one
  // value per ray, as cast writes them.
  castFan(origin: ArrayLike<number>, basis: ArrayLike<number>, dirs: Float32Array, maxT: number | Float32Array, outT: Float32Array, outN?: Float32Array, outPart?: Int32Array): void {
    const ox = origin[0], oy = origin[1], oz = origin[2];
    const b0 = basis[0], b1 = basis[1], b2 = basis[2], b3 = basis[3], b4 = basis[4], b5 = basis[5], b6 = basis[6], b7 = basis[7], b8 = basis[8];
    const n = (dirs.length / 3) | 0;
    for (let j = 0; j < n; j++) {
      const lx = dirs[j * 3], ly = dirs[j * 3 + 1], lz = dirs[j * 3 + 2];
      RAY[0] = ox; RAY[1] = oy; RAY[2] = oz;
      RAY[3] = b0 * lx + b1 * ly + b2 * lz; RAY[4] = b3 * lx + b4 * ly + b5 * lz; RAY[5] = b6 * lx + b7 * ly + b8 * lz;
      RAY[6] = typeof maxT === 'number' ? maxT : maxT[j];
      this.#run(outN, j * 3, outPart, j);
      outT[j] = RAY[6];
    }
  }

  // Casts RAY and leaves its t in RAY[6].
  #run(out: Float32Array | undefined, oi: number, partOut: Int32Array | undefined, pi: number): void {
    const ox = RAY[0], oy = RAY[1], oz = RAY[2], dx = RAY[3], dy = RAY[4], dz = RAY[5];
    let best = RAY[6], hit = HIT_NONE, hitA = 0, hitB = 0;
    if ((oy > 0 && dy < 0) || (oy < 0 && dy > 0)) {
      const t = -oy / dy;
      if (t <= best) { best = t; hit = HIT_GROUND; }
    }
    const m = this.#m, kind = m.kind, root = m.root, turned = m.turned, mBox = m.box, mLink = m.link, mTri = m.tri;
    const lsN = this.#lsN, lsT = this.#lsT;
    if (this.#n > 0) {
      const ix = inv(dx), iy = inv(dy), iz = inv(dz);
      const nb = this.#box, nl = this.#link, stN = this.#stN, stT = this.#stT;
      const itype = this.#type, iori = this.#ori, ipos = this.#pos;
      let sp = 0;
      const t0 = slab(nb, 0, ox, oy, oz, ix, iy, iz, best);
      if (t0 <= best) { stN[0] = 0; stT[0] = t0; sp = 1; }
      while (sp > 0) {
        sp--;
        if (stT[sp] > best) continue;
        const node = stN[sp], first = nl[node * 2], count = nl[node * 2 + 1];
        if (count === 0) {
          const tl = slab(nb, first * 6, ox, oy, oz, ix, iy, iz, best), tr = slab(nb, first * 6 + 6, ox, oy, oz, ix, iy, iz, best);
          // Nearer child on top.
          if (tl <= best) {
            if (tr <= best && tr < tl) {
              stN[sp] = first; stT[sp++] = tl;
              stN[sp] = first + 1; stT[sp++] = tr;
            } else {
              if (tr <= best) { stN[sp] = first + 1; stT[sp++] = tr; }
              stN[sp] = first; stT[sp++] = tl;
            }
          } else if (tr <= best) {
            stN[sp] = first + 1; stT[sp++] = tr;
          }
          continue;
        }
        for (let k = first, end = first + count; k < end; k++) {
          const ty = itype[k], o = iori[k], px = ipos[k * 3], py = ipos[k * 3 + 1], pz = ipos[k * 3 + 2];
          if (kind[ty] === BOX) {
            const t = (ty * 24 + o) * 6;
            let n = (turned[t] + px - ox) * ix, f = (turned[t + 3] + px - ox) * ix, na = 0, fa = 0;
            if (n > f) { const s = n; n = f; f = s; }
            let p = (turned[t + 1] + py - oy) * iy, q = (turned[t + 4] + py - oy) * iy;
            if (p > q) { const s = p; p = q; q = s; }
            if (p > n) { n = p; na = 1; }
            if (q < f) { f = q; fa = 1; }
            p = (turned[t + 2] + pz - oz) * iz; q = (turned[t + 5] + pz - oz) * iz;
            if (p > q) { const s = p; p = q; q = s; }
            if (p > n) { n = p; na = 2; }
            if (q < f) { f = q; fa = 2; }
            if (n <= f) {
              if (n > 0) {
                if (n <= best) { best = n; hit = HIT_BOX; hitA = k; hitB = na; }
              } else if (f > 0 && f <= best) { best = f; hit = HIT_BOX; hitA = k; hitB = fa; }
            }
            continue;
          }
          // The ray in the part's frame: local = Rᵀ (p - position).
          const r = o * 9, rx = ox - px, ry = oy - py, rz = oz - pz;
          const R0 = ORIENT[r], R1 = ORIENT[r + 1], R2 = ORIENT[r + 2], R3 = ORIENT[r + 3], R4 = ORIENT[r + 4], R5 = ORIENT[r + 5], R6 = ORIENT[r + 6], R7 = ORIENT[r + 7], R8 = ORIENT[r + 8];
          LOC[0] = R0 * rx + R3 * ry + R6 * rz; LOC[1] = R1 * rx + R4 * ry + R7 * rz; LOC[2] = R2 * rx + R5 * ry + R8 * rz;
          LOC[3] = R0 * dx + R3 * dy + R6 * dz; LOC[4] = R1 * dx + R4 * dy + R7 * dz; LOC[5] = R2 * dx + R5 * dy + R8 * dz;
          LOC[6] = best;
          meshHit(mBox, mLink, mTri, root[ty], lsN, lsT);
          if (meshTri >= 0) { best = LOC[6]; hit = HIT_MESH; hitA = k; hitB = meshTri; }
        }
      }
    }
    if (this.#mBox.length > 0) {
      const mo = this.#mo;
      LOC[0] = ox - mo[0]; LOC[1] = oy - mo[1]; LOC[2] = oz - mo[2]; LOC[3] = dx; LOC[4] = dy; LOC[5] = dz; LOC[6] = best;
      meshHit(this.#mBox, this.#mLink, this.#mTri, 0, lsN, lsT);
      if (meshTri >= 0) { best = LOC[6]; hit = HIT_MOUNTAIN; hitB = meshTri; }
    }
    if (hit === HIT_NONE) {
      if (out) { out[oi] = 0; out[oi + 1] = 0; out[oi + 2] = 0; }
      if (partOut) partOut[pi] = -3;
      RAY[6] = Infinity;
      return;
    }
    if (out) {
      if (hit === HIT_MESH) normal(mTri, hitB, this.#ori[hitA], out, oi);
      else if (hit === HIT_MOUNTAIN) normal(this.#mTri, hitB, 0, out, oi);
      else {
        // Ground or box face: the axis normal, sign against the ray.
        const a = oi + (hit === HIT_GROUND ? 1 : hitB);
        out[oi] = 0; out[oi + 1] = 0; out[oi + 2] = 0;
        out[a] = RAY[3 + a - oi] > 0 ? -1 : 1;
      }
    }
    if (partOut) partOut[pi] = hit === HIT_GROUND ? -1 : hit === HIT_MOUNTAIN ? -2 : this.#part[hitA];
    RAY[6] = best;
  }
}
