import type { ScoredRound, Match } from './types.ts';
import * as Cup from './cup.ts';
import { validDraft } from './draft.ts';
import { rulesFor, validPreset } from './presets.ts';
import type { CupState, PublicCupState, RaceRecord } from './types.ts';
export function validSnapshot(value: unknown): value is PublicCupState {
  const s = value as CupState;
  const obj = (o: unknown) => !!o && typeof o === 'object' && !Array.isArray(o);
  const text = (t: unknown) => typeof t === 'string' && t.length <= 128;
  const num = (n: unknown): n is number =>
    typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  const frames = (n: unknown) =>
    typeof n === 'number' && Number.isSafeInteger(n) && n > 0 && n <= 3600000;
  if (
    !obj(s) ||
    s.schema !== 2 ||
    (s.preset !== undefined && !validPreset(s.preset)) ||
    !text(s.id) ||
    !text(s.name) ||
    !num(s.revision) ||
    ![
      'registration',
      'loading',
      'warmup',
      'countdown',
      'racing',
      'between-rounds',
      'complete',
    ].includes(s.phase) ||
    !['dnf', 'void'].includes(s.disconnectPolicy) ||
    !Array.isArray(s.roster) ||
    s.roster.length > (rulesFor(s).allowRacerChanges ? 128 : 8) ||
    !s.roster.every(
      (p) =>
        obj(p) &&
        Number.isSafeInteger(p.id) &&
        p.id !== 0 &&
        text(p.name) &&
        (p.countryCode == null ||
          (typeof p.countryCode === 'string' && /^[a-z]{2}$/i.test(p.countryCode))),
    ) ||
    new Set(s.roster.map((p) => p.id)).size !== s.roster.length ||
    !Array.isArray(s.tracks) ||
    s.tracks.length > (s.preset ? 1000 : 8) ||
    !s.tracks.every(
      (t) => obj(t) && typeof t.id === 'string' && /^[a-f0-9]{64}$/i.test(t.id) && text(t.name),
    ) ||
    new Set(s.tracks.map((t) => t.id)).size !== s.tracks.length
  )
    return false;
  const ids = (values: unknown) =>
    Array.isArray(values) &&
    values.length <= 128 &&
    values.every((id) => s.roster.some((p) => p.id === id)) &&
    new Set(values).size === values.length;
  const times = (o: Record<string, number>) =>
    obj(o) &&
    Object.keys(o).length <= 128 &&
    Object.entries(o).every(([id, n]) => s.roster.some((p) => p.id === Number(id)) && num(n));
  const trackId = (id: string) => s.tracks.some((t) => t.id === id);
  if (
    (s.withdrawn !== undefined && !ids(s.withdrawn)) ||
    (s.pendingRacers !== undefined && !ids(s.pendingRacers)) ||
    s.pendingRacers?.some((id) => s.withdrawn?.includes(id)) ||
    ((!rulesFor(s).allowRacerChanges || s.phase === 'registration') &&
      (s.withdrawn?.length ?? 0) + (s.pendingRacers?.length ?? 0) > 0)
  )
    return false;
  if (
    !obj(s.picks) ||
    Object.entries(s.picks).some(([id, t]) => !ids([Number(id)]) || !trackId(t)) ||
    !obj(s.records) ||
    Object.keys(s.records).length > 1000 ||
    !validDraft(s)
  )
    return false;
  if (
    s.selections !== undefined &&
    (!obj(s.selections) ||
      Object.entries(s.selections).some(
        ([id, picks]) =>
          !ids([Number(id)]) ||
          !Array.isArray(picks) ||
          picks.length > rulesFor(s).picksPerRacer ||
          new Set(picks).size !== picks.length ||
          !picks.every(trackId) ||
          s.picks[Number(id)] !== picks[0],
      ))
  )
    return false;
  if (s.preset && rulesFor(s).selection === 'random' && Object.keys(s.picks).length) return false;
  for (const [id, r] of Object.entries(s.records)) {
    if (!trackId(id) || !obj(r) || !obj(r.pbs) || Object.keys(r.pbs).length > 128) return false;
    for (const [id, p] of Object.entries(r.pbs))
      if (!ids([Number(id)]) || !validPB(p)) return false;
    if (r.wr && !validWR(r.wr)) return false;
    if (r.tr && (!obj(r.tr) || !frames(r.tr.frames) || !ids(r.tr.ids))) return false;
  }
  const awards = (value: unknown, finishes: Record<number, number>) =>
    value === undefined ||
    (obj(value) &&
      Object.keys(value as object).length <= 8 &&
      Object.entries(value as Record<string, unknown>).every(
        ([id, award]) =>
          ids([Number(id)]) && id in finishes && ['PB', 'TR', 'WR'].includes(award as string),
      ));
  const round = (r: ScoredRound) =>
    obj(r) &&
    num(r.round) &&
    trackId(r.trackId) &&
    times(r.finishes) &&
    awards(r.recordAwards, r.finishes) &&
    times(r.points) &&
    ids(r.dnfs) &&
    ids(r.winners) &&
    ids(r.beforeRanking);
  const match = (m: Match) =>
    obj(m) &&
    text(m.name) &&
    ids(m.players) &&
    m.players.length >= 2 &&
    ids(m.winners) &&
    ids(m.ranking) &&
    (s.preset
      ? m.target === rulesFor(s).pointsToWin && obj(m.trackRounds)
      : (m.target === 100 && m.trackRounds === undefined) ||
        (m.target === Cup.RULES.target && obj(m.trackRounds))) &&
    m.winnerCount === 1 &&
    m.winners.length <= 1 &&
    num(m.rounds) &&
    Array.isArray(m.order) &&
    m.order.length >= 1 &&
    m.order.length <= (s.preset ? 1000 : 8) &&
    m.order.every(trackId) &&
    new Set(m.order).size === m.order.length &&
    (m.trackRounds === undefined ||
      (Object.keys(m.trackRounds).length === m.order.length &&
        m.order.every(
          (id) =>
            num(m.trackRounds![id]) &&
            m.trackRounds![id] >= 1 &&
            m.trackRounds![id] <= (s.preset ? 30 : 240000),
        ))) &&
    (m.trackWarmups === undefined ||
      (obj(m.trackWarmups) &&
        Object.keys(m.trackWarmups).length === m.order.length &&
        m.order.every(
          (id) =>
            num(m.trackWarmups![id]) &&
            m.trackWarmups![id] >= (s.preset ? 0 : 30000) &&
            m.trackWarmups![id] <= 18000000,
        ))) &&
    times(m.scores) &&
    m.players.every(
      (id) => num(m.scores[id]) && (!rulesFor(s).finalist || m.scores[id] <= m.target),
    ) &&
    obj(m.finalists) &&
    (rulesFor(s).finalist || !Object.keys(m.finalists).length) &&
    (rulesFor(s).selection !== 'random' ||
      (obj(m.randomTrack) &&
        trackId(m.randomTrack!.id) &&
        num(m.randomTrack!.fromRound) &&
        num(m.randomTrack!.rounds) &&
        m.randomTrack!.rounds === rulesFor(s).roundsPerTrack &&
        m.randomTrack!.fromRound <= m.rounds &&
        m.rounds <= m.randomTrack!.fromRound + m.randomTrack!.rounds)) &&
    Object.entries(m.finalists).every(
      ([id, f]) =>
        m.players.includes(Number(id)) &&
        obj(f) &&
        num(f.round) &&
        num(f.position) &&
        (f.checkpoint === null || num(f.checkpoint)),
    ) &&
    Array.isArray(m.roundsLog) &&
    m.roundsLog.every(round);
  if (
    !Array.isArray(s.matches) ||
    s.matches.length > 1 ||
    !s.matches.every(match) ||
    s.matchIndex !== (s.matches.length ? 0 : -1) ||
    (s.phase !== 'registration' && !s.matches.length) ||
    !Array.isArray(s.audit) ||
    !s.audit.every((a) => obj(a) && text(a.message) && text(a.at)) ||
    !Array.isArray(s.results) ||
    s.results.length > 128 ||
    !s.results.every(
      (r) => obj(r) && ids([r.id]) && Number.isInteger(r.place) && r.place >= 1 && r.place <= 128,
    ) ||
    (s.history !== undefined &&
      (!Array.isArray(s.history) ||
        !s.history.every((h) => obj(h) && h.matchIndex === 0 && match(h.before))))
  )
    return false;
  if (Cup.occupiedSlots(s) > 8) return false;
  const r = s.runtime;
  if (!['loading', 'warmup', 'countdown', 'racing'].includes(s.phase)) return r === null;
  return (
    !!r &&
    obj(r) &&
    text(r.id) &&
    num(r.round) &&
    trackId(r.trackId) &&
    (r.sessionId === null || num(r.sessionId)) &&
    typeof r.warmup === 'boolean' &&
    (r.racers === undefined || (ids(r.racers) && r.racers.length <= 8)) &&
    ids(r.ready) &&
    (r.practiceReady === undefined || ids(r.practiceReady)) &&
    ids(r.dnfs) &&
    times(r.finishes) &&
    (r.sittingOut === undefined ||
      (ids(r.sittingOut) &&
        r.sittingOut.every((id) => r.dnfs.includes(id) && !(id in r.finishes)))) &&
    times(r.checkpoints) &&
    awards(r.recordAwards, r.finishes) &&
    (r.recordBaselines === undefined ||
      (obj(r.recordBaselines) &&
        (r.recordBaselines.wr === undefined || frames(r.recordBaselines.wr)) &&
        (r.recordBaselines.tr === undefined || frames(r.recordBaselines.tr)) &&
        obj(r.recordBaselines.pbs) &&
        Object.keys(r.recordBaselines.pbs).length <= 128 &&
        Object.entries(r.recordBaselines.pbs).every(
          ([id, time]) => ids([Number(id)]) && (time === null || frames(time)),
        ))) &&
    (r.splits === undefined ||
      (obj(r.splits) &&
        Object.keys(r.splits).length <= 8 &&
        Object.entries(r.splits).every(
          ([id, p]) =>
            ids([Number(id)]) &&
            obj(p) &&
            num(p.index) &&
            num(p.frames) &&
            p.frames! > 0 &&
            p.frames! <= 3600000 &&
            num(p.bestFrames) &&
            p.bestFrames > 0 &&
            p.bestFrames <= p.frames,
        ))) &&
    (r.liveMovement === undefined ||
      (obj(r.liveMovement) &&
        Object.keys(r.liveMovement).length <= 8 &&
        Object.entries(r.liveMovement).every(
          ([id, n]) => ids([Number(id)]) && Number.isInteger(n) && Math.abs(n) <= 7,
        ))) &&
    (r.startsAt === null || Number.isFinite(r.startsAt)) &&
    (r.deadline === null || Number.isFinite(r.deadline))
  );
}
export function validWR(value: unknown): value is RaceRecord {
  const wr = value as RaceRecord;
  return (
    !!wr &&
    !Array.isArray(wr) &&
    ['ready', 'missing', 'unavailable'].includes(wr.status) &&
    (wr.status !== 'ready' ||
      (Number.isSafeInteger(wr.frames) &&
        wr.frames! > 0 &&
        wr.frames! <= 3600000 &&
        typeof wr.name === 'string' &&
        wr.name.length <= 128))
  );
}
export function validPB(value: unknown): value is RaceRecord {
  const p = value as RaceRecord;
  return (
    !!p &&
    ['ready', 'missing', 'unavailable'].includes(p.status) &&
    (p.status !== 'ready' ||
      (Number.isSafeInteger(p.frames) &&
        p.frames! > 0 &&
        p.frames! <= 3600000 &&
        ['profile', 'online'].includes(p.source ?? '')))
  );
}
