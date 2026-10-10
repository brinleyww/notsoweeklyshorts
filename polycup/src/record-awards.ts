import type { RecordBaselines, RecordAward, Round, TrackRecords } from './types.ts';

export function recordBaselines(records: TrackRecords | undefined): RecordBaselines {
  return {
    ...(records?.wr?.status === 'ready' ? { wr: records.wr.frames } : {}),
    ...(records?.tr ? { tr: records.tr.frames } : {}),
    pbs: Object.fromEntries(
      Object.entries(records?.pbs ?? {}).flatMap<[string, number | null]>(([id, pb]) =>
        pb.status === 'ready' ? [[id, pb.frames!]] : pb.status === 'missing' ? [[id, null]] : [],
      ),
    ),
  };
}
export function recordAward(run: Round, id: number, frames: number): RecordAward | null {
  const baseline = run.recordBaselines;
  const fastest = Math.min(...Object.values(run.finishes));
  if (baseline?.wr !== undefined && frames < Math.min(baseline.wr, fastest)) return 'WR';
  if (frames < Math.min(baseline?.tr ?? Infinity, fastest)) return 'TR';
  const pb = baseline?.pbs[id];
  return pb === null || (pb !== undefined && frames < pb) ? 'PB' : null;
}
