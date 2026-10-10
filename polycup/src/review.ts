import { frameNumber, validInputEvents } from './inputs.ts';
import type {
  CupState,
  InputEvent,
  InputPacket,
  ReviewArchive,
  ReviewFlag,
  ReviewOutcome,
  ReviewRun,
} from './types.ts';

export const REVIEW_LIMITS = Object.freeze({
  runs: 256,
  events: 2048,
  totalEvents: 32768,
  checkpoints: 256,
  bytes: 1500000,
});
const eligible = (r: ReviewRun) =>
  r.outcome === 'finished' && r.finish !== null && r.finish >= 10000;
const completeInputs = (r: ReviewRun) =>
  !r.gap && r.inputs[0]?.[0] === 0 && r.finish !== null && r.through >= r.finish;
const complex = (r: ReviewRun) =>
  r.inputs.length >= 13 &&
  new Set(r.inputs.map((e) => e[1])).size >= 3 &&
  r.inputs.filter((e, i, a) => i && (e[1] & 10) !== (a[i - 1][1] & 10)).length >= 8;
const canonical = (events: InputEvent[]) => {
  const out: InputEvent[] = [];
  for (const e of events) {
    if (out.at(-1)?.[0] === e[0]) out[out.length - 1] = e;
    else out.push(e);
  }
  return out.filter((e, i) => !i || e[1] !== out[i - 1][1]);
};

export function compareRuns(a: ReviewRun, b: ReviewRun): ReviewFlag | null {
  if (!eligible(a) || !eligible(b) || a.racerKey !== b.racerKey || a.trackId !== b.trackId)
    return null;
  const exactCheckpoints =
    a.checkpoints.length >= 4 &&
    a.checkpoints.length === a.expectedCheckpoints &&
    b.checkpoints.length === b.expectedCheckpoints &&
    a.finish === b.finish &&
    JSON.stringify(a.checkpoints) === JSON.stringify(b.checkpoints);
  if (completeInputs(a) && completeInputs(b)) {
    const x = { ...a, inputs: canonical(a.inputs) },
      y = { ...b, inputs: canonical(b.inputs) };
    // Simple full-throttle tracks and ordinary repeated finishes are not flags.
    if (!complex(x) || !complex(y)) return null;
    if (x.inputs.length === y.inputs.length && x.inputs.every((e, i) => e[1] === y.inputs[i][1])) {
      const delta = Math.max(
        Math.abs(a.finish! - b.finish!),
        ...x.inputs.map((e, i) => Math.abs(e[0] - y.inputs[i][0])),
      );
      if (delta <= 10)
        return {
          kind: 'inputs',
          otherId: b.id,
          transitions: x.inputs.length - 1,
          maxDelta: delta,
          exactCheckpoints,
        };
    }
  }
  return exactCheckpoints
    ? { kind: 'checkpoints', otherId: b.id, checkpoints: a.checkpoints.length }
    : null;
}

export class ReviewLog {
  get cupId() {
    return this.#cupId;
  }
  get revision() {
    return this.#revision;
  }
  get runs() {
    return this.#runs;
  }
  get dropped() {
    return this.#dropped;
  }

  #cupId: string | null;
  #runs: ReviewRun[] = [];
  #identities: Record<number, string> = {};
  #dropped: number = 0;
  #revision: number = 0;

  constructor(cupId: string | null = null) {
    this.#cupId = cupId;
  }
  actor(id: number) {
    return (this.#identities[id] ??= crypto.randomUUID());
  }
  rebind(oldId: number, newId: number) {
    if (this.#identities[oldId]) {
      this.#identities[newId] = this.#identities[oldId];
      delete this.#identities[oldId];
    }
  }
  begin(state: CupState, checkpointCount: number) {
    if (!state?.runtime || state.runtime.sessionId === null) return;
    const run = state.runtime;
    for (const p of state.roster) {
      const racerKey = this.actor(p.id);
      if (this.#runs.some((r) => r.roundId === run.id && r.racerKey === racerKey)) continue;
      this.#runs.push({
        id: crypto.randomUUID(),
        roundId: run.id,
        round: run.round,
        trackId: run.trackId,
        racerKey,
        name: p.name,
        outcome: 'pending',
        finish: null,
        expectedCheckpoints: Math.max(0, checkpointCount - 1),
        checkpoints: [],
        inputs: [],
        through: -1,
        nextSeq: 0,
        gap: false,
        flag: null,
        reviewed: false,
      });
      this.#revision++;
    }
    this.trim();
  }
  current(roundId: string, actor: number) {
    return this.#runs.find((r) => r.roundId === roundId && r.racerKey === this.#identities[actor]);
  }
  inputs(roundId: string, actor: number, message: InputPacket) {
    const r = this.current(roundId, actor);
    if (!r || r.outcome !== 'pending' || message.seq < r.nextSeq || message.through < r.through)
      return false;
    if (message.events.length && r.inputs.length && message.events[0][0] < r.inputs.at(-1)![0])
      return false;
    if (
      message.seq !== r.nextSeq ||
      message.gap ||
      (!r.inputs.length && message.events[0]?.[0] !== 0)
    )
      r.gap = true;
    r.nextSeq = message.seq + 1;
    r.through = message.through;
    const remaining = REVIEW_LIMITS.events - r.inputs.length;
    if (message.events.length > remaining) r.gap = true;
    r.inputs.push(...message.events.slice(0, remaining).map((e) => [...e] as InputEvent));
    this.#revision++;
    return true;
  }
  checkpoint(roundId: string, actor: number, index: number, frames: number) {
    const r = this.current(roundId, actor);
    if (
      !r ||
      r.checkpoints.length >= REVIEW_LIMITS.checkpoints ||
      r.checkpoints.some((e) => e[0] >= index)
    )
      return;
    r.checkpoints.push([index, frames]);
    this.#revision++;
  }
  close(state: Pick<CupState, 'runtime'>, outcome: 'scored' | ReviewOutcome = 'scored') {
    const run = state?.runtime;
    if (!run) return;
    for (const r of this.#runs.filter((r) => r.roundId === run.id && r.outcome === 'pending')) {
      const actor = Object.keys(this.#identities).find(
        (id) => this.#identities[Number(id)] === r.racerKey,
      );
      r.finish = run.finishes[Number(actor)] ?? null;
      r.outcome = outcome === 'scored' ? (r.finish === null ? 'dnf' : 'finished') : outcome;
    }
    this.analyze();
    this.trim();
    this.#revision++;
  }
  undo(round: number, trackId: string) {
    const last = [...this.#runs]
      .reverse()
      .find(
        (r) =>
          r.round === round && r.trackId === trackId && ['finished', 'dnf'].includes(r.outcome),
      );
    if (!last) return;
    for (const r of this.#runs) if (r.roundId === last.roundId) r.outcome = 'undone';
    this.analyze();
    this.#revision++;
  }
  analyze() {
    const seen = [];
    for (const r of this.#runs) {
      const old = JSON.stringify(r.flag);
      r.flag = null;
      if (eligible(r)) {
        const candidates = seen
          .filter((p) => p.racerKey === r.racerKey && p.trackId === r.trackId)
          .map((p) => compareRuns(r, p))
          .filter((flag): flag is ReviewFlag => flag !== null);
        r.flag = candidates.find((f) => f.kind === 'inputs') ?? null;
        // Timing-only evidence needs three whole runs, never a single equal time.
        if (!r.flag && candidates.filter((f) => f.kind === 'checkpoints').length >= 2)
          r.flag = {
            ...candidates.find((f) => f.kind === 'checkpoints')!,
            repeats: candidates.filter((f) => f.kind === 'checkpoints').length + 1,
          };
        seen.push(r);
      }
      if (old !== JSON.stringify(r.flag)) r.reviewed = false;
    }
  }
  trim() {
    const before = this.#dropped;
    let events = this.#runs.reduce((n, r) => n + r.inputs.length, 0);
    while (this.#runs.length > REVIEW_LIMITS.runs || events > REVIEW_LIMITS.totalEvents) {
      const i = this.#runs.findIndex((r) => r.outcome !== 'pending');
      if (i < 0) break;
      events -= this.#runs[i].inputs.length;
      this.#runs.splice(i, 1);
      this.#dropped++;
    }
    if (this.#dropped !== before) {
      this.analyze();
      this.#revision++;
    }
  }
  data() {
    this.trim();
    const before = this.#dropped;
    const data = {
      schema: 1,
      cupId: this.#cupId,
      identities: this.#identities,
      runs: this.#runs,
      dropped: this.#dropped,
    };
    while (JSON.stringify(data).length > REVIEW_LIMITS.bytes) {
      const i = this.#runs.findIndex((r) => r.outcome !== 'pending');
      if (i < 0) break;
      this.#runs.splice(i, 1);
      data.dropped = ++this.#dropped;
    }
    if (this.#dropped !== before) {
      this.analyze();
      this.#revision++;
    }
    return data;
  }
  markReviewed(id: string, value: boolean) {
    const r = this.#runs.find((r) => r.id === id);
    if (!r?.flag) return;
    r.reviewed = !!value;
    this.#revision++;
  }
  static restore(value: unknown, state: CupState) {
    const data = value as ReviewArchive;
    const log = new ReviewLog(state.id);
    if (data === undefined) return log;
    const text = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 128;
    const obj = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v);
    if (
      !obj(data) ||
      data.schema !== 1 ||
      data.cupId !== state.id ||
      JSON.stringify(data).length > REVIEW_LIMITS.bytes ||
      !obj(data.identities) ||
      Object.keys(data.identities).length > 128 ||
      !Object.entries(data.identities).every(
        ([id, key]) => state.roster.some((p) => p.id === Number(id)) && text(key),
      ) ||
      new Set(Object.values(data.identities)).size !== Object.keys(data.identities).length ||
      !Array.isArray(data.runs) ||
      data.runs.length > REVIEW_LIMITS.runs ||
      !Number.isSafeInteger(data.dropped) ||
      data.dropped < 0
    )
      throw new Error('Invalid organizer review log.');
    const runs: ReviewRun[] = data.runs.map((r) => {
      if (
        !obj(r) ||
        !text(r.id) ||
        !text(r.roundId) ||
        !Number.isSafeInteger(r.round) ||
        r.round < 1 ||
        !text(r.name) ||
        !Object.values(data.identities).includes(r.racerKey) ||
        !state.tracks.some((t) => t.id === r.trackId) ||
        !['pending', 'finished', 'dnf', 'void', 'undone', 'interrupted'].includes(r.outcome) ||
        !(r.finish === null || (frameNumber(r.finish) && r.finish > 0)) ||
        (r.outcome === 'finished' && r.finish === null) ||
        !Number.isSafeInteger(r.expectedCheckpoints) ||
        r.expectedCheckpoints < 0 ||
        r.expectedCheckpoints > 100000 ||
        !Array.isArray(r.checkpoints) ||
        r.checkpoints.length > REVIEW_LIMITS.checkpoints ||
        !r.checkpoints.every(
          (e, i) =>
            Array.isArray(e) &&
            e.length === 2 &&
            Number.isSafeInteger(e[0]) &&
            e[0] >= 0 &&
            e[0] < r.expectedCheckpoints &&
            frameNumber(e[1]) &&
            e[1] > 0 &&
            (!i || (e[0] > r.checkpoints[i - 1][0] && e[1] >= r.checkpoints[i - 1][1])),
        ) ||
        !(r.through === -1 || frameNumber(r.through)) ||
        !validInputEvents(r.inputs, r.through, REVIEW_LIMITS.events) ||
        !Number.isSafeInteger(r.nextSeq) ||
        r.nextSeq < 0 ||
        typeof r.gap !== 'boolean' ||
        typeof r.reviewed !== 'boolean'
      )
        throw new Error('Invalid saved run evidence.');
      return {
        id: r.id,
        roundId: r.roundId,
        round: r.round,
        trackId: r.trackId,
        racerKey: r.racerKey,
        name: r.name,
        outcome: r.outcome === 'pending' ? 'interrupted' : r.outcome,
        finish: r.finish,
        expectedCheckpoints: r.expectedCheckpoints,
        checkpoints: r.checkpoints.map((e) => [...e]),
        inputs: r.inputs.map((e) => [...e]),
        through: r.through,
        nextSeq: r.nextSeq,
        gap: r.gap,
        reviewed: r.reviewed,
        flag: null,
      };
    });
    if (
      new Set(runs.map((r) => r.id)).size !== runs.length ||
      runs.reduce((n, r) => n + r.inputs.length, 0) > REVIEW_LIMITS.totalEvents
    )
      throw new Error('Invalid review history size.');
    log.#identities = { ...data.identities };
    log.#runs = runs;
    log.#dropped = data.dropped;
    log.analyze();
    runs.forEach((r, i) => {
      r.reviewed = data.runs[i].reviewed && !!r.flag;
    });
    return log;
  }
}

export function evidenceStatus(r: ReviewRun) {
  if (!r.inputs.length) return 'No input data';
  if (r.outcome === 'pending') return 'Recording';
  if (r.finish !== null && completeInputs(r)) return 'Inputs recorded';
  return 'Partial input data';
}
