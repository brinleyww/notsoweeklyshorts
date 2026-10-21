// Room either side of a reference line, measured with rays: walls and barriers at body height, and
// where the drivable surface ends (an edge or a gap). A bot that is not right on the reference keeps
// a margin from both by shifting its line where the reference passes close.
import type { Reference } from './reference.ts';
import type { TrackRays } from './rays.ts';

// Ray height above the car-state position (the hull spans about +0.23..+1.0; barriers reach +0.8).
const BODY = 0.5;
const SIDE_MAX = 12;
// Edge probes: drop rays this far out to each side, every PROBE_STEP units.
const PROBE_STEP = 1;
const PROBE_MAX = 8;
// A probe that finds no surface within this drop below the line's own surface marks an edge.
const DROP = 1.6;
// Half the car's width plus a little.
export const HALF_WIDTH = 0.85;

export interface Clearance {
  // Room for the car's centre to the left / right of the reference line, units (already less half a car).
  left: Float32Array;
  right: Float32Array;
}

export function clearanceOf(ref: Reference, rays: TrackRays): Clearance {
  const n = ref.n;
  const left = new Float32Array(n), right = new Float32Array(n);
  const out = new Float32Array(3);
  const samples: number[] = [];
  let lastArc = -Infinity;
  for (let i = 0; i < n; i++) {
    if (ref.arc[i] - lastArc >= 1 || i === n - 1) {
      samples.push(i);
      lastArc = ref.arc[i];
    }
  }
  const room = (i: number, side: 1 | -1) => {
    let tx = ref.vx[i], ty = ref.vy[i], tz = ref.vz[i];
    let tn = (tx * tx + ty * ty + tz * tz) ** 0.5;
    if (tn < 1) {
      tx = ref.fx[i];
      ty = ref.fy[i];
      tz = ref.fz[i];
      tn = 1;
    }
    tx /= tn;
    ty /= tn;
    tz /= tn;
    const ux = ref.ux[i], uy = ref.uy[i], uz = ref.uz[i];
    const lx = (uy * tz - uz * ty) * side, ly = (uz * tx - ux * tz) * side, lz = (ux * ty - uy * tx) * side;
    const ox = ref.px[i] + ux * BODY, oy = ref.py[i] + uy * BODY, oz = ref.pz[i] + uz * BODY;
    let wall = rays.cast(ox, oy, oz, lx, ly, lz, SIDE_MAX, out);
    if (!(wall < SIDE_MAX)) wall = SIDE_MAX;
    // In the air there is no surface to keep to; only walls count.
    if (ref.wheels[i] === 0) return wall - HALF_WIDTH;
    let edge = PROBE_MAX;
    for (let d = PROBE_STEP; d <= PROBE_MAX && d < wall; d += PROBE_STEP) {
      const sx = ref.px[i] + lx * d + ux * 1.5, sy = ref.py[i] + ly * d + uy * 1.5, sz = ref.pz[i] + lz * d + uz * 1.5;
      const t = rays.cast(sx, sy, sz, -ux, -uy, -uz, 1.5 + DROP, out);
      if (!(t < 1.5 + DROP)) {
        edge = d - PROBE_STEP * 0.5;
        break;
      }
    }
    return Math.min(wall - HALF_WIDTH, edge);
  };
  let s = 0;
  for (let i = 0; i < n; i++) {
    while (s + 1 < samples.length && samples[s + 1] <= i) s++;
    if (samples[s] === i) {
      left[i] = room(i, 1);
      right[i] = room(i, -1);
    } else {
      left[i] = left[samples[s]];
      right[i] = right[samples[s]];
    }
  }
  return { left, right };
}

// Lateral shift (units, + = left) that keeps `margin` of room on both sides where possible,
// smoothed along the line so it never jerks.
export function marginOffsets(ref: Reference, c: Clearance, margin: number): Float32Array {
  const n = ref.n;
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const l = c.left[i], r = c.right[i];
    let o = 0;
    if (l < margin && r < margin) o = (l - r) / 2;
    else if (l < margin) o = -Math.min(margin - l, r - margin);
    else if (r < margin) o = Math.min(margin - r, l - margin);
    raw[i] = o;
  }
  // Moving average over about 6 units of travel each way.
  const out = new Float32Array(n);
  let a = 0, b = 0, sum = 0;
  for (let i = 0; i < n; i++) {
    while (b < n && ref.arc[b] - ref.arc[i] <= 6) sum += raw[b++];
    while (ref.arc[i] - ref.arc[a] > 6) sum -= raw[a++];
    out[i] = sum / Math.max(1, b - a);
  }
  return out;
}
