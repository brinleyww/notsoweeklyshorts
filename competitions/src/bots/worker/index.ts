// mod/cuppa_bots.js: loaded by importScripts into a copy of the game's simulation worker named
// WORKER_NAME (see simulation_worker.bundle.js). Plans bot runs for the organizer's page and streams
// them back as deflated keyframe chunks.
import { deflate, KeyframeEncoder } from '../codec.ts';
import type { FromWorker, RefInput, ToWorker } from '../wire.ts';
import { explore } from './explore.ts';
import { gatesOf } from './gates.ts';
import { Planner, routeTrack, type Job, type Out } from './planner.ts';
import { PartMeshes, TrackRays, type PlacedPart } from './rays.ts';
import { Reference } from './reference.ts';
import { Sim, type SimInternals, type TrackLoad } from './sim.ts';

type Scope = {
  __nswsSimInternals?: SimInternals;
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(m: unknown, transfer?: Transferable[]): void;
  navigator?: { deviceMemory?: number };
};
const scope = self as unknown as Scope;
const post = (m: FromWorker, transfer?: Transferable[]) => scope.postMessage(m, transfer);

// Bot time per chunk: shorter chunks deflate worse, longer ones reach pages later.
const CHUNK_FRAMES = 2000;
const SLICE_MS = 25;
const PROGRESS_MS = 250;

interface TrackState {
  key: string;
  load: TrackLoad;
  refs: Reference[];
  planner: Planner | null;
}

interface Stream {
  job: Job;
  enc: KeyframeEncoder;
  seq: number;
  pending: number;
  from: number;
  last: number;
  chain: Promise<void>;
  // Wall clock and frontier when progress was last reported, for the rate.
  at: number;
  was: number;
  rate: number;
  results: number;
  // Last bot frame in a chunk handed over.
  sent: number;
}

const game = scope.onmessage;
const internals = scope.__nswsSimInternals;
let sim: Sim | null = null;
let meshes: PartMeshes | null = null;
const detectors = new Map<number, { type: number; center: number[]; size: number[] }>();
let track: TrackState | null = null;
const streams = new Map<string, Stream>();
let startAt: number | null = null;
let offset = 0;
let running = false;
let progressAt = 0;

const ringSize = () => ((scope.navigator?.deviceMemory ?? 8) >= 8 ? 6 : 4);

function raceNow() {
  return startAt == null ? 0 : Date.now() + offset - startAt;
}

scope.onmessage = (e: MessageEvent) => {
  const m = e.data as ToWorker;
  if (!m || typeof m !== 'object' || !('b' in m)) {
    game?.call(scope, e);
    return;
  }
  try {
    handle(m);
  } catch (error) {
    post({ b: 'error', message: String((error as Error)?.message ?? error) });
  }
};

function handle(m: ToWorker) {
  switch (m.b) {
    case 'init':
      if (!sim && internals) {
        // The game's Init handler copies the part meshes into the physics and keeps no copy: rays need one.
        const parts = (m.init as { trackParts?: { id: number; vertices: Float32Array }[] }).trackParts;
        try {
          if (parts) {
            meshes = new PartMeshes(parts);
            for (const p of parts as { id: number; detector?: { type: number; center: number[]; size: number[] } | null }[]) if (p.detector) detectors.set(p.id, p.detector);
          }
        } catch (error) {
          post({ b: 'error', message: 'rays: ' + String(error) });
        }
        game?.call(scope, { data: m.init } as MessageEvent);
        sim = new Sim(internals);
      }
      return;
    case 'track':
      return loadTrack(m.key, m.payload, m.refs);
    case 'job': {
      if (!track || track.key !== m.key || !track.planner) {
        post({ b: 'error', id: m.id, message: 'no track for job' });
        return;
      }
      if (streams.has(m.id)) return;
      const job = track.planner.add({ id: m.id, bot: m.bot, mode: m.mode, end: m.end });
      streams.set(m.id, { job, enc: new KeyframeEncoder(), seq: 0, pending: 0, from: -1, last: 0, chain: Promise.resolve(), at: performance.now(), was: 0, rate: 0, results: 0, sent: 0 });
      kick();
      return;
    }
    case 'clock':
      startAt = m.startAt;
      offset = m.offset;
      return;
    case 'cancel': {
      const s = streams.get(m.id);
      if (!s) return;
      streams.delete(m.id);
      track?.planner?.cancel(m.id);
      return;
    }
    case 'drop':
      if (track?.key === m.key) dropTrack();
      return;
  }
}

function dropTrack() {
  track?.planner?.dispose();
  track = null;
  streams.clear();
}

function loadTrack(key: string, payload: { trackData: string; mountainVertices: Float32Array; mountainOffset: { x: number; y: number; z: number } }, inputs: RefInput[]) {
  if (!sim) {
    post({ b: 'track', key, ok: false, refs: [], parts: 0, ms: 0 });
    return;
  }
  if (track?.key === key) return;
  dropTrack();
  const t0 = performance.now();
  const mv = payload.mountainVertices instanceof Float32Array ? payload.mountainVertices : new Float32Array(payload.mountainVertices as ArrayLike<number>);
  const load = sim.load(payload.trackData, mv, payload.mountainOffset);
  if (!load) {
    post({ b: 'track', key, ok: false, refs: [], parts: 0, ms: 0 });
    return;
  }
  const placed: (PlacedPart & { cp: number | null })[] = [];
  load.track.forEachPart((x, y, z, id, rot, axis, _color, cp) => placed.push({ id, x, y, z, rot, axis, cp }));
  const parts = placed.length;
  const refs: Reference[] = [];
  const report: { id: string; valid: boolean; frames: number }[] = [];
  for (const r of inputs) {
    const ref = Reference.build(sim, load, r.id, r.kind, r.rank ?? 0, r.recording, r.frames);
    report.push({ id: r.id, valid: !!ref, frames: r.frames });
    if (ref) refs.push(ref);
  }
  let rays: TrackRays | null = null;
  if (meshes)
    try {
      rays = new TrackRays(meshes, placed, { vertices: mv, offset: payload.mountainOffset });
    } catch (error) {
      post({ b: 'error', message: 'rays: ' + String(error) });
    }
  // Nobody's run to follow: find a route with rays.
  if (!refs.length && rays) {
    const { groups, finish } = gatesOf(placed, detectors);
    const start = load.start as { position: { x: number; y: number; z: number } };
    const path = explore(rays, placed, groups, finish, start.position);
    const ref = path && Reference.fromPath('explore', path, [...groups, finish]);
    if (ref) refs.push(ref);
  }
  const ok = refs.length > 0;
  const route = ok ? routeTrack(sim, load, refs, (id) => detectors.has(id)) : load;
  track = { key, load, refs, planner: ok ? new Planner(sim, route, refs, ringSize(), rays, load) : null };
  if (track.planner) {
    track.planner.onCommit = commit;
    track.planner.onDone = done;
  }
  post({ b: 'track', key, ok, refs: report, parts, ms: Math.round(performance.now() - t0) });
}

function commit(job: Job, outs: Out[]) {
  const s = streams.get(job.id);
  if (!s) return;
  for (const o of outs) {
    if (s.from < 0) s.from = o.f;
    s.enc.add(o.f, o.raw, o.cut);
    s.last = o.f;
    s.pending++;
  }
  if (s.last - s.from >= CHUNK_FRAMES) flush(s);
}

function flush(s: Stream) {
  const bytes = s.enc.take();
  if (!bytes) return;
  const seq = s.seq++;
  const to = s.last;
  s.sent = to;
  s.from = -1;
  s.pending = 0;
  const id = s.job.id;
  s.chain = s.chain
    .then(() => deflate(bytes))
    .then((data) => {
      if (streams.get(id) === s) post({ b: 'chunk', id, seq, data, to }, [data.buffer as ArrayBuffer]);
    })
    .catch((error) => post({ b: 'error', id, message: String(error) }));
}

function report(s: Stream) {
  const job = s.job;
  const done = job.runs.filter((r) => r[1] != null) as [number, number][];
  const best = done.length ? Math.min(...done.map((r) => r[1] - r[0])) : null;
  const run = done.find((r) => r[1] - r[0] === best);
  const finish = job.mode === 'ta' ? best : run ? run[1] : null;
  const frontier = job.live ? job.committed : Math.max(job.committed, job.t);
  s.chain = s.chain.then(() => post({ b: 'result', id: job.id, finish, runs: job.runs.map((r) => [r[0], r[1]]), dnf: job.dnfAt, frontier }));
}

function done(job: Job) {
  const s = streams.get(job.id);
  if (!s) return;
  // The rest of the run is final now.
  queueMicrotask(() => {
    flush(s);
    report(s);
  });
}

function progress(now: number) {
  for (const s of streams.values()) {
    const job = s.job;
    // Frontier: what pages can have; rate: how fast the planner itself moves on (known from its first tick).
    const frontier = job.live ? s.sent : Math.max(job.committed, job.t);
    const dt = now - s.at;
    if (dt > 0) s.rate = s.rate > 0 ? 0.5 * s.rate + (0.5 * Math.max(0, job.t - s.was)) / dt : Math.max(0, job.t - s.was) / dt;
    s.at = now;
    s.was = job.t;
    if (job.live) post({ b: 'progress', id: job.id, frontier, rate: s.rate });
    // A time-attack run that just finished.
    const finished = job.runs.filter((r) => r[1] != null).length;
    if (job.mode === 'ta' && finished > s.results) {
      s.results = finished;
      report(s);
    }
  }
}

function kick() {
  if (running) return;
  running = true;
  setTimeout(pump, 0);
}

function pump() {
  const planner = track?.planner;
  if (!planner || !planner.busy) {
    running = false;
    if (planner) progress(performance.now());
    return;
  }
  const t0 = performance.now();
  const first = progressAt === 0;
  while (performance.now() - t0 < SLICE_MS && planner.tick()) {}
  const now = performance.now();
  if (first || now - progressAt >= PROGRESS_MS) {
    progressAt = now;
    progress(now);
  }
  // Well ahead of the race (GO waits for a lead, and pages need a few seconds of it): leave most of the
  // CPU to the game, which on a weak device shares its cores with this.
  const ahead = planner.frontier - raceNow();
  const rest = ahead > 35_000 ? SLICE_MS * 8 : ahead > 20_000 ? SLICE_MS * 3 : ahead > 12_000 ? SLICE_MS : 0;
  setTimeout(pump, rest);
}

post({ b: 'ready' });
