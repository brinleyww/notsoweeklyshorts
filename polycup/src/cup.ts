import { recordAward, recordBaselines } from './record-awards.ts';
import type { CupState, Match, RaceRecord, Track } from './types.ts';
// Competition state is owned by the native multiplayer host. No game internals here.
import { isBanned, picksOpen, resetDraft, rosterOpen } from './draft.ts';
import { rulesFor, standardPreset, validPreset, type CupPreset, type CupRules } from './presets.ts';
export const VERSION = '0.3.0';
export const RULES = Object.freeze({
  points: [10, 8, 6, 5, 4, 3, 2, 1],
  target: 140,
  fallbackRounds: 4,
  warmupMs: 15000,
  finishTimeoutMs: 10000,
});
const copy = <T>(value: T): T => structuredClone(value);
function requireThat(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
const safeName = (value: unknown) =>
  String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, 64);

export function newCup(name = 'Simple Cup', preset = standardPreset()): CupState {
  requireThat(validPreset(preset), 'Invalid Cup preset.');
  return {
    preset: copy(preset),
    schema: 2,
    version: VERSION,
    id: crypto.randomUUID(),
    name: safeName(name) || 'Simple Cup',
    revision: 0,
    phase: 'registration',
    roster: [],
    tracks: [],
    picks: {},
    records: {},
    matches: [],
    matchIndex: -1,
    runtime: null,
    history: [],
    audit: [],
    results: [],
    disconnectPolicy: 'dnf',
  };
}
export function currentMatch(state: CupState) {
  return state.matches[state.matchIndex] ?? null;
}
export function activeIds(state: CupState | null) {
  const m = state && currentMatch(state);
  return m
    ? m.players.filter(
        (id) =>
          !m.winners.includes(id) &&
          !state?.withdrawn?.includes(id) &&
          !state?.pendingRacers?.includes(id),
      )
    : [];
}
export function occupiedSlots(state: CupState) {
  return state.phase === 'registration'
    ? state.roster.length
    : activeIds(state).length + (state.pendingRacers?.length ?? 0);
}
export function enterRunningCup(state: CupState, id: number, name: string) {
  requireThat(
    rulesFor(state).allowRacerChanges &&
      state.phase !== 'registration' &&
      state.phase !== 'complete',
    'This preset locks the racer roster during the Cup.',
  );
  requireThat(Number.isSafeInteger(id) && id > 0, 'Invalid lobby player.');
  requireThat(
    !activeIds(state).includes(id) && !state.pendingRacers?.includes(id),
    'You already have a racer slot.',
  );
  requireThat(occupiedSlots(state) < 8, 'All eight racer places are filled.');
  const match = currentMatch(state);
  if (!player(state, id)) {
    requireThat(
      state.roster.length < 128,
      'This Cup has reached its participant limit. Start a new Cup.',
    );
    state.roster.push({ id, name: safeName(name) });
    match.players.push(id);
    match.scores[id] = 0;
  }
  state.withdrawn = (state.withdrawn ?? []).filter((other) => other !== id);
  if (state.runtime) (state.pendingRacers ??= []).push(id);
  touch(state);
}
export function leaveRunningCup(state: CupState, id: number) {
  requireThat(
    rulesFor(state).allowRacerChanges &&
      state.phase !== 'registration' &&
      state.phase !== 'complete',
    'This preset locks the racer roster during the Cup.',
  );
  requireThat(player(state, id), 'You are not registered in this Cup.');
  const run = state.runtime;
  if (run && activeIds(state).includes(id) && !(id in run.finishes) && !run.dnfs.includes(id))
    run.dnfs.push(id);
  state.pendingRacers = (state.pendingRacers ?? []).filter((other) => other !== id);
  if (!state.withdrawn?.includes(id)) (state.withdrawn ??= []).push(id);
  touch(state);
}
export function admitPendingRacers(state: CupState, online: number[]) {
  if (state.runtime || state.phase !== 'between-rounds') return;
  for (const id of state.pendingRacers ?? [])
    if (!online.includes(id)) {
      if (!state.withdrawn?.includes(id)) (state.withdrawn ??= []).push(id);
    }
  if (state.pendingRacers?.length) {
    state.pendingRacers = [];
    touch(state);
  }
}
export function player(state: CupState | null, id: number | null) {
  return state?.roster.find((p) => p.id === id);
}
export function racingIds(state: CupState | null) {
  return activeIds(state).filter((id) => !state?.runtime?.sittingOut?.includes(id));
}
export function sitOut(state: CupState, id: number) {
  const run = state.runtime;
  if (!run || !activeIds(state).includes(id) || id in run.finishes) return;
  const excluded = (run.sittingOut ??= []);
  if (excluded.includes(id)) return;
  excluded.push(id);
  if (!run.dnfs.includes(id)) run.dnfs.push(id);
  touch(state);
}
export function roundDone(state: CupState | null, id: number | null) {
  return (
    state?.phase === 'racing' &&
    !!state.runtime &&
    ((id !== null && id in state.runtime.finishes) || state.runtime.dnfs.includes(id!))
  );
}
export function mayWatch(state: CupState | null, id: number | null) {
  return (
    !!state &&
    state.phase !== 'complete' &&
    (!racingIds(state).includes(id!) || roundDone(state, id))
  );
}
export function rematch(state: CupState, newTracks = false) {
  requireThat(state.phase === 'complete', 'Finish the Cup before starting a rematch.');
  const next = newCup(state.name, state.preset ?? standardPreset());
  next.roster = copy(state.roster.filter((p) => !state.withdrawn?.includes(p.id)));
  next.disconnectPolicy = state.disconnectPolicy;
  if (!newTracks) {
    next.tracks = copy(state.tracks);
    next.picks = copy(state.picks);
    next.selections = copy(state.selections ?? {});
    for (const id of state.withdrawn ?? []) {
      delete next.picks[id];
      delete next.selections[id];
    }
    if (state.draft && !state.withdrawn?.length) next.draft = copy(state.draft);
    if (rulesFor(next).selection === 'draft' && next.roster.some((p) => !picksComplete(next, p.id)))
      resetDraft(next);
  } else resetDraft(next);
  return next;
}
export function applyPreset(state: CupState, preset: CupPreset) {
  requireThat(rosterOpen(state), 'Reopen setup before changing the preset.');
  requireThat(validPreset(preset), 'Invalid Cup preset.');
  resetDraft(state);
  state.preset = copy(preset);
  touch(state);
}
export function chosenTracks(state: CupState, id: number): string[] {
  return state.selections?.[id] ?? (state.picks[id] ? [state.picks[id]] : []);
}
export function picksComplete(state: CupState, id: number) {
  return chosenTracks(state, id).length === rulesFor(state).picksPerRacer;
}
export function removePick(state: CupState, actor: number, trackId: string) {
  requireThat(picksOpen(state) && player(state, actor), 'Picks can only be changed during setup.');
  const picks = chosenTracks(state, actor).filter((id) => id !== trackId);
  (state.selections ??= {})[actor] = picks;
  if (picks.length) state.picks[actor] = picks[0];
  else delete state.picks[actor];
  pruneTracks(state);
  touch(state);
}
export function note(state: CupState, message: string) {
  state.audit.push({ at: new Date().toISOString(), message: safeName(message) });
  state.audit = state.audit.slice(-500);
}
export function touch(state: CupState) {
  state.revision++;
}
export function addPlayer(state: CupState, id: number, name: string) {
  requireThat(rosterOpen(state), 'Roster is locked for the draft. Ask the organizer to reopen it.');
  requireThat(Number.isSafeInteger(id) && id > 0, 'Invalid lobby player.');
  requireThat(state.roster.length < 8, 'All eight racer places are filled.');
  requireThat(!player(state, id), 'This player is already registered.');
  state.roster.push({ id, name: safeName(name) });
  touch(state);
}
export function removePlayer(state: CupState, id: number) {
  requireThat(rosterOpen(state), 'Roster is locked for the draft. Ask the organizer to reopen it.');
  state.roster = state.roster.filter((p) => p.id !== id);
  delete state.picks[id];
  if (state.selections) delete state.selections[id];
  for (const r of Object.values(state.records)) delete r.pbs[id];
  pruneTracks(state);
  touch(state);
}
function pruneTracks(state: CupState) {
  state.tracks = state.tracks.filter((t) =>
    state.roster.some((p) => chosenTracks(state, p.id).includes(t.id)),
  );
  for (const id of Object.keys(state.records))
    if (!state.tracks.some((t) => t.id === id)) delete state.records[id];
}
export function chooseTrack(state: CupState, actor: number, track: Track) {
  requireThat(picksOpen(state), 'Finish all bans before picking tracks.');
  requireThat(player(state, actor), 'Join as a racer before choosing a track.');
  requireThat(
    typeof track.id === 'string' && /^[a-f0-9]{64}$/i.test(track.id),
    'Invalid track ID.',
  );
  requireThat(!isBanned(state, track.id), 'That track was banned.');
  const rules = rulesFor(state),
    selected = chosenTracks(state, actor);
  requireThat(rules.selection === 'draft', 'This Cup chooses tracks randomly.');
  requireThat(!selected.includes(track.id), 'You already picked that track.');
  requireThat(
    rules.picksPerRacer === 1 || selected.length < rules.picksPerRacer,
    'Remove a pick before choosing another track.',
  );
  if (!state.tracks.some((t) => t.id === track.id))
    state.tracks.push({ id: track.id, name: safeName(track.name) });
  (state.selections ??= {})[actor] =
    rules.picksPerRacer === 1 ? [track.id] : [...selected, track.id];
  state.picks[actor] = state.selections[actor][0];
  pruneTracks(state);
  touch(state);
}
export function lockRegistration(state: CupState, random = Math.random) {
  const rules = rulesFor(state);
  requireThat(state.phase === 'registration', 'The Cup has already started.');
  requireThat(
    rules.selection === 'random' || picksOpen(state),
    'Finish the bans before starting the Cup.',
  );
  requireThat(
    state.roster.length >= 2 && state.roster.length <= 8,
    'Two to eight racers can start a Cup.',
  );
  requireThat(
    rules.selection === 'random'
      ? state.tracks.length > 0
      : state.roster.every(
          (p) =>
            picksComplete(state, p.id) &&
            chosenTracks(state, p.id).every((id) => state.tracks.some((t) => t.id === id)),
        ),
    `Each racer needs ${rules.picksPerRacer} track pick${rules.picksPerRacer === 1 ? '' : 's'}.`,
  );
  const order = state.tracks.map((t) => t.id);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const players = state.roster.map((p) => p.id);
  // Freeze the host's schedule before racing. Live WR updates cannot alter it.
  const trackRounds = Object.fromEntries(order.map((id) => [id, rules.roundsPerTrack]));
  const trackWarmups = Object.fromEntries(
    order.map((id) => [id, practiceForRecord(state.records[id]?.wr, rules)]),
  );
  state.matches = [
    {
      name: 'Simple Cup',
      players,
      target: rules.pointsToWin,
      winnerCount: 1,
      order,
      trackRounds,
      trackWarmups,
      rounds: 0,
      winners: [],
      scores: Object.fromEntries(players.map((id) => [id, 0])),
      finalists: {},
      roundsLog: [],
      ranking: [],
      ...(rules.selection === 'random'
        ? { randomTrack: { id: order[0], fromRound: 0, rounds: rules.roundsPerTrack } }
        : {}),
    },
  ];
  state.matchIndex = 0;
  state.phase = 'between-rounds';
  touch(state);
}
export function practiceForRecord(wr: RaceRecord | undefined, rules: CupRules = rulesFor(null)) {
  if (rules.warmup === 'off') return 0;
  if (rules.warmupTiming === 'fixed') return rules.warmupSeconds * 1000;
  const duration =
    typeof wr?.frames === 'number' &&
    wr?.status === 'ready' &&
    Number.isSafeInteger(wr.frames) &&
    wr.frames > 0 &&
    wr.frames <= 3600000
      ? wr.frames
      : null;
  return duration === null
    ? rules.warmupSeconds * 1000
    : Math.max(rules.warmupMinimumSeconds * 1000, Math.ceil(duration * rules.warmupMultiplier));
}
export function practiceReady(state: CupState, id: number, roundId: string) {
  if (!rulesFor(state).readyEndsWarmup) return false;
  if (state.phase !== 'warmup' || state.runtime?.id !== roundId || !racingIds(state).includes(id))
    return false;
  const ready = (state.runtime.practiceReady ??= []);
  if (ready.includes(id)) return false;
  ready.push(id);
  touch(state);
  return true;
}
export function trackProgress(state: CupState, completedRounds = currentMatch(state)?.rounds ?? 0) {
  const m = state && currentMatch(state);
  if (!m?.order.length) return null;
  if (rulesFor(state).selection === 'random') {
    const block = m.randomTrack;
    if (
      !block ||
      completedRounds < block.fromRound ||
      completedRounds >= block.fromRound + block.rounds
    )
      return null;
    return {
      trackId: block.id,
      round: completedRounds - block.fromRound + 1,
      rounds: block.rounds,
    };
  }
  // Saves created before 0.2.8 retain their original four-round rotation.
  const count = (id: string) => m.trackRounds?.[id] ?? RULES.fallbackRounds;
  const cycle = m.order.reduce((sum, id) => sum + count(id), 0);
  let offset = completedRounds % cycle;
  for (const trackId of m.order) {
    const rounds = count(trackId);
    if (offset < rounds) return { trackId, round: offset + 1, rounds };
    offset -= rounds;
  }
}
export function nextTrack(state: CupState) {
  return trackProgress(state)?.trackId ?? null;
}
export function scheduleRandomTrack(state: CupState, track: Track, wr: RaceRecord) {
  requireThat(
    state.phase === 'between-rounds' && rulesFor(state).selection === 'random',
    'Random tracks can only change between rounds.',
  );
  const m = currentMatch(state),
    rules = rulesFor(state);
  if (!state.tracks.some((t) => t.id === track.id))
    state.tracks.push({ ...track, name: safeName(track.name) });
  if (!m.order.includes(track.id)) m.order.push(track.id);
  (state.records[track.id] ??= { pbs: {} }).wr = wr;
  (m.trackRounds ??= {})[track.id] = rules.roundsPerTrack;
  (m.trackWarmups ??= {})[track.id] = practiceForRecord(wr, rules);
  m.randomTrack = { id: track.id, fromRound: m.rounds, rounds: rules.roundsPerTrack };
  touch(state);
}
export function beginRound(state: CupState) {
  requireThat(state.phase === 'between-rounds', 'Finish setup or the current round first.');
  const m = state && currentMatch(state);
  const visit = trackProgress(state);
  requireThat(visit, 'No track scheduled.');
  const firstVisit = !m.roundsLog.some((r) => r.trackId === visit.trackId);
  state.runtime = {
    racers: activeIds(state),
    id: crypto.randomUUID(),
    round: m.rounds + 1,
    trackId: visit.trackId,
    warmup:
      rulesFor(state).warmup !== 'off' &&
      visit.round === 1 &&
      (rulesFor(state).warmup === 'every-visit' || m.trackWarmups === undefined || firstVisit),
    sessionId: null,
    ready: [],
    practiceReady: [],
    startsAt: null,
    deadline: null,
    finishes: {},
    dnfs: [],
    checkpoints: {},
    splits: {},
    liveMovement: {},
  };
  state.phase = 'loading';
  touch(state);
}
export function startRace(state: CupState, now: number) {
  requireThat(state.phase === 'countdown', 'A countdown is required before racing.');
  requireThat(state.runtime, 'No active round.');
  state.runtime.recordBaselines = recordBaselines(state.records[state.runtime.trackId]);
  state.runtime.startsAt = now;
  state.phase = 'racing';
  touch(state);
}
export function recordFinish(state: CupState, id: number, frames: number, now: number) {
  if (state.phase !== 'racing' || !activeIds(state).includes(id)) return false;
  const run = state.runtime;
  if (!run || run.startsAt === null) return false;
  if (id in run.finishes || run.dnfs.includes(id)) return false;
  if (!Number.isSafeInteger(frames) || frames <= 0 || frames > 3600000) return false;
  // PolyTrack uses 1000 physics frames per second. Do not accept a finish from a prior run.
  if (frames > now - run.startsAt + 2000) return false;
  if (run.deadline !== null && (now > run.deadline + 1500 || frames > run.deadline - run.startsAt))
    return false;
  const award = recordAward(run, id, frames);
  if (award) (run.recordAwards ??= {})[id] = award;
  run.finishes[id] = frames;
  const finishAt = run.startsAt + frames;
  run.deadline = Math.min(
    run.deadline ?? Infinity,
    finishAt + rulesFor(state).finishTimeoutSeconds * 1000,
  );
  touch(state);
  return true;
}
export function markDNF(state: CupState, id: number) {
  requireThat(state.phase === 'racing', 'There is no live round.');
  requireThat(state.runtime && activeIds(state).includes(id), 'This player is not racing.');
  requireThat(!(id in state.runtime.finishes), 'A finished run cannot be changed to DNF.');
  if (!state.runtime.dnfs.includes(id)) {
    state.runtime.dnfs.push(id);
    touch(state);
  }
}
export function allFinished(state: CupState) {
  if (!state.runtime) return false;
  const run = state.runtime;
  return activeIds(state).every((id) => id in run.finishes || run.dnfs.includes(id));
}
export function completeRound(state: CupState) {
  const rules = rulesFor(state);
  requireThat(state.phase === 'racing', 'There is no live round.');
  const m = currentMatch(state),
    run = state.runtime;
  requireThat(run, 'No active round.');
  const before = copy(m),
    beforeRanking = rankMatch(state, m).filter(
      (id) => !state.withdrawn?.includes(id) && !state.pendingRacers?.includes(id),
    ),
    ids = run.racers ?? activeIds(state);
  const order = ids
    .filter((id) => id in run.finishes)
    .sort((a, b) => run.finishes[a] - run.finishes[b]);
  const placements: Record<number, number> = {};
  for (let i = 0; i < order.length; i++) {
    const id = order[i];
    placements[id] =
      i > 0 && run.finishes[id] === run.finishes[order[i - 1]] ? placements[order[i - 1]] : i + 1;
  }
  // Exact ties share points. A tied first never awards a finalist win: another round resolves it.
  const first = order[0],
    firstIsTied = order.length > 1 && run.finishes[first] === run.finishes[order[1]];
  if (rules.finalist && first !== undefined && !firstIsTied && first in m.finalists)
    m.winners.push(first);
  const points: Record<number, number> = {};
  for (const id of order) {
    points[id] =
      id in m.finalists
        ? 0
        : rules.finalist
          ? Math.min(m.target - m.scores[id], rules.points[placements[id] - 1])
          : rules.points[placements[id] - 1];
    if (!(id in m.finalists)) {
      m.scores[id] = rules.finalist
        ? Math.min(m.target, m.scores[id] + points[id])
        : m.scores[id] + points[id];
      if (rules.finalist && m.scores[id] === m.target)
        m.finalists[id] = {
          round: run.round,
          position: placements[id],
          checkpoint: run.checkpoints[id] ?? null,
        };
    }
  }
  if (!rules.finalist) {
    const eligible = m.players.filter((id) => !state.withdrawn?.includes(id) || id in run.finishes),
      best = Math.max(...eligible.map((id) => m.scores[id])),
      leaders = eligible.filter((id) => m.scores[id] === best);
    if (best >= m.target && leaders.length === 1) m.winners.push(leaders[0]);
  }
  m.rounds++;
  m.roundsLog.push({
    beforeRanking,
    round: run.round,
    trackId: run.trackId,
    finishes: copy(run.finishes),
    ...(run.recordAwards ? { recordAwards: copy(run.recordAwards) } : {}),
    points,
    dnfs: ids.filter((id) => !(id in run.finishes)),
    winners: [...m.winners],
    tiedFirst: firstIsTied,
  });
  state.history.push({ matchIndex: state.matchIndex, before });
  state.runtime = null;
  if (m.winners.length) {
    m.ranking = rankMatch(state, m);
    state.results = m.ranking.map((id, i) => ({ id, place: i + 1 }));
    state.phase = 'complete';
  } else state.phase = 'between-rounds';
  refreshSessionRecords(state);
  touch(state);
}
export function rankMatch(_state: CupState, m: Match) {
  return [
    ...m.winners,
    ...m.players
      .filter((id) => !m.winners.includes(id))
      .sort((a, b) => {
        if (m.scores[a] !== m.scores[b]) return m.scores[b] - m.scores[a];
        const x = m.finalists[a],
          y = m.finalists[b];
        if (x && y) {
          if (x.round !== y.round) return x.round - y.round;
          if (x.position !== y.position) return x.position - y.position;
          if (x.checkpoint !== null && y.checkpoint !== null && x.checkpoint !== y.checkpoint)
            return x.checkpoint - y.checkpoint;
        }
        return 0; // Stable join order for display only; exact race ties always share points.
      }),
  ];
}
export function refreshSessionRecords(state: CupState) {
  for (const t of state.tracks) {
    const records = (state.records[t.id] ??= { pbs: {} });
    records.tr = null;
    for (const m of state.matches)
      for (const r of m.roundsLog)
        if (r.trackId === t.id) {
          for (const [id, frames] of Object.entries(r.finishes)) {
            if (!records.tr || frames < records.tr.frames)
              records.tr = { frames, ids: [Number(id)] };
            else if (frames === records.tr.frames && !records.tr.ids.includes(Number(id)))
              records.tr.ids.push(Number(id));
          }
        }
  }
}
export function voidRound(state: CupState) {
  requireThat(
    ['loading', 'warmup', 'countdown', 'racing'].includes(state.phase),
    'There is no round to void.',
  );
  state.runtime = null;
  state.phase = 'between-rounds';
  note(state, 'Organizer voided the current round.');
  touch(state);
}
export function undoRound(state: CupState) {
  requireThat(
    ['between-rounds', 'match-complete', 'complete'].includes(state.phase),
    'Void the live round first.',
  );
  const last = state.history.at(-1);
  requireThat(
    last && last.matchIndex === state.matchIndex,
    'No round in this match can be undone.',
  );
  const current = currentMatch(state),
    restored = copy(last.before);
  for (const id of current.players)
    if (!restored.players.includes(id)) {
      restored.players.push(id);
      restored.scores[id] = 0;
    }
  state.matches[state.matchIndex] = restored;
  state.history.pop();
  refreshSessionRecords(state);
  state.results = [];
  state.phase = 'between-rounds';
  note(state, 'Organizer undid the last scored round.');
  touch(state);
}
export function rebindPlayer(state: CupState, oldId: number, newId: number, name: string) {
  requireThat(
    ['registration', 'between-rounds', 'complete'].includes(state.phase),
    'Void the round before reconnecting a racer.',
  );
  requireThat(
    player(state, oldId) && !player(state, newId) && Number.isSafeInteger(newId) && newId > 0,
    'Choose a new lobby identity.',
  );
  remapIdentities(state, new Map([[oldId, newId]]));
  player(state, newId)!.name = safeName(name);
  note(state, 'Organizer reassigned a disconnected racer.');
  touch(state);
}
export function detachIdentities(state: CupState) {
  requireThat(!state.runtime, 'Void the round before detaching saved identities.');
  // A separate negative namespace avoids collisions with newly issued native peer IDs.
  remapIdentities(state, new Map(state.roster.map((p, i) => [p.id, -i - 1])));
}
function remapIdentities(state: CupState, mapping: Map<number, number>) {
  const idFor = (id: string | number) => mapping.get(Number(id)) ?? Number(id);
  const replace = (values: number[]) => values.map(idFor);
  const keys = <T>(value: Record<number, T>): Record<number, T> =>
    Object.fromEntries(Object.entries(value).map(([id, v]) => [idFor(id), v]));
  const updateMatch = (m: Match) => {
    m.players = replace(m.players);
    m.winners = replace(m.winners);
    m.ranking = replace(m.ranking);
    m.scores = keys(m.scores);
    m.finalists = keys(m.finalists);
    for (const round of m.roundsLog) {
      round.finishes = keys(round.finishes);
      if (round.recordAwards) round.recordAwards = keys(round.recordAwards);
      round.points = keys(round.points);
      round.beforeRanking = replace(round.beforeRanking);
      round.dnfs = replace(round.dnfs);
      round.winners = replace(round.winners);
    }
  };
  state.roster.forEach((p) => {
    p.id = idFor(p.id);
  });
  if (state.withdrawn) state.withdrawn = replace(state.withdrawn);
  if (state.pendingRacers) state.pendingRacers = replace(state.pendingRacers);
  state.picks = keys(state.picks);
  if (state.selections) state.selections = keys(state.selections);
  if (state.draft) {
    state.draft.order = replace(state.draft.order);
    state.draft.bans = keys(state.draft.bans);
    state.draft.banHistory?.forEach((b) => {
      b.racerId = idFor(b.racerId);
    });
  }
  for (const r of Object.values(state.records)) {
    r.pbs = keys(r.pbs);
    if (r.tr) r.tr.ids = replace(r.tr.ids);
  }
  state.matches.forEach(updateMatch);
  state.history.forEach((h) => updateMatch(h.before));
  state.results.forEach((r) => {
    r.id = idFor(r.id);
  });
}
export function publicState(state: CupState) {
  const { history, ...rest } = state;
  return copy(rest);
}
// Not So Weekly Shorts: racers vote to skip a random track; more than half of them skips it.
export function skipTarget(state: CupState | null) {
  if (!state || rulesFor(state).selection !== 'random' || !currentMatch(state)) return null;
  if (state.runtime && ['loading', 'warmup', 'countdown', 'racing'].includes(state.phase))
    return state.runtime.trackId;
  return state.phase === 'between-rounds' ? nextTrack(state) : null;
}
export function skipVotes(state: CupState | null) {
  const target = skipTarget(state);
  return target && state?.skipVote?.trackId === target
    ? state.skipVote.ids.filter((id) => activeIds(state).includes(id))
    : [];
}
export function skipNeeded(state: CupState | null) {
  return Math.floor(activeIds(state).length / 2) + 1;
}
export function voteSkip(state: CupState, id: number) {
  const target = skipTarget(state);
  requireThat(target, 'There is no track to skip right now.');
  requireThat(activeIds(state).includes(id), 'Only racers can vote to skip.');
  const ids = skipVotes(state);
  const at = ids.indexOf(id);
  if (at >= 0) ids.splice(at, 1);
  else ids.push(id);
  state.skipVote = { trackId: target, ids };
  touch(state);
  return ids.length >= skipNeeded(state);
}
