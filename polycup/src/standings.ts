import * as Cup from './cup.ts';
import { rulesFor } from './presets.ts';
import type { CupState, SessionRecord } from './types.ts';
export function standings(s: CupState) {
  const m = Cup.currentMatch(s);
  if (!m) return [];
  const ranking = Cup.rankMatch(s, m).filter(
      (id) =>
        s.phase === 'complete' || (!s.withdrawn?.includes(id) && !s.pendingRacers?.includes(id)),
    ),
    live = s.phase === 'racing';
  const last = m.roundsLog.at(-1),
    scored = !s.runtime && !!last;
  const finishes = live ? s.runtime!.finishes : scored ? last.finishes : {};
  const finishOrder = ranking
    .filter((id) => id in finishes)
    .sort((a, b) => finishes[a] - finishes[b]);
  const splits = live ? (s.runtime!.splits ?? {}) : {};
  const pending = ranking.filter((id) => !finishOrder.includes(id));
  if (live)
    pending.sort(
      (a, b) =>
        Number(s.runtime!.dnfs.includes(a)) - Number(s.runtime!.dnfs.includes(b)) ||
        (splits[b]?.index ?? -1) - (splits[a]?.index ?? -1) ||
        (splits[a]?.frames ?? Infinity) - (splits[b]?.frames ?? Infinity),
    );
  const order = live ? [...finishOrder, ...pending] : ranking;
  const best = finishOrder.length ? finishes[finishOrder[0]] : null;
  return order.map((id) => {
    const finishPlace = finishOrder.findIndex((other) => finishes[other] === finishes[id]) + 1;
    const gain =
      live && finishPlace > 0 && !(id in m.finalists)
        ? rulesFor(s).finalist
          ? Math.min(m.target - m.scores[id], rulesFor(s).points[finishPlace - 1])
          : rulesFor(s).points[finishPlace - 1]
        : scored
          ? (last.points[id] ?? 0)
          : 0;
    return {
      id,
      position: live && finishPlace ? finishPlace : order.indexOf(id) + 1,
      score: m.scores[id],
      finalist: id in m.finalists,
      winner: m.winners.includes(id),
      gain,
      provisional: live,
      movement: live
        ? (s.runtime!.liveMovement?.[id] ?? 0)
        : scored
          ? last.beforeRanking.indexOf(id) - ranking.indexOf(id)
          : 0,
      frames: finishes[id],
      checkpoint: splits[id]?.index,
      splitFrames: splits[id]?.frames,
      delta:
        finishes[id] !== undefined && best !== null
          ? finishes[id] - best
          : splits[id]
            ? splits[id].frames - splits[id].bestFrames
            : null,
      dnf: (live ? s.runtime!.dnfs : scored ? last.dnfs : []).includes(id),
    };
  });
}
export function updateLiveMovement(s: CupState, before: number[]) {
  if (s.phase !== 'racing') return;
  s.runtime!.liveMovement = Object.fromEntries(
    standings(s).map((r, i) => [r.id, before.indexOf(r.id) - i]),
  );
}
export function recordTrack(s: CupState) {
  const m = Cup.currentMatch(s);
  return s.runtime?.trackId ?? m?.roundsLog.at(-1)?.trackId ?? Cup.nextTrack(s);
}
export function sessionRecord(s: CupState, trackId: string) {
  const existing = s.records[trackId]?.tr;
  const values =
    s.runtime?.trackId === trackId && s.phase === 'racing'
      ? Object.entries(s.runtime!.finishes)
      : [];
  let record: SessionRecord | null = existing ? structuredClone(existing) : null;
  for (const [id, frames] of values) {
    if (!record || frames < record.frames)
      record = { frames, ids: [Number(id)], provisional: true };
    else if (frames === record.frames && !record.ids.includes(Number(id)))
      record.ids.push(Number(id));
  }
  return record;
}
