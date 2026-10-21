// The organizer's tournament logic: pure functions over the shared CupState, no game access.
import { cleanRules, MAX_RACERS, type Rules } from './rules.ts';
import { player, roundDone, standings, type CupState, type Phase, type ResultRow, type Round, type RoundResult, type TrackRef } from './state.ts';

// A finish claimed this much shorter than the time since GO is refused.
export const FINISH_SLACK_MS = 5000;

export function createCup(o: { id: string; name: string; format: string; rules: Rules; now: number }): CupState {
  return {
    v: 1,
    id: o.id,
    name: o.name,
    seq: 0,
    format: o.format,
    rules: cleanRules(o.rules),
    phase: 'lobby',
    phaseAt: o.now,
    nextAt: null,
    hold: false,
    host: 0,
    players: [],
    round: null,
    vote: null,
    draft: null,
    playlist: [],
    playIndex: 0,
    winner: null,
    shout: null,
    rounds: 0,
  };
}

export function setPhase(s: CupState, phase: Phase, now: number, nextAt: number | null = null) {
  s.phase = phase;
  s.phaseAt = now;
  s.nextAt = nextAt;
}

export const started = (s: CupState) => s.phase !== 'lobby';
// Racers include the bots; the human-only lists are for whatever waits on real people.
export const racers = (s: CupState) => s.players.filter((p) => p.role === 'racer' && !p.out);
export const activeRacers = (s: CupState) => racers(s).filter((p) => !p.away);
export const humans = (s: CupState) => s.players.filter((p) => !p.bot);
export const humanRacers = (s: CupState) => racers(s).filter((p) => !p.bot);

// A human can always take a bot's grid slot (the organizer then benches a bot).
export function canRace(s: CupState, u?: number) {
  const p = player(s, u);
  if (p?.out) return false;
  if (s.phase === 'podium') return false;
  if (humanRacers(s).filter((r) => r.u !== u).length >= MAX_RACERS) return false;
  if (!started(s)) return true;
  return s.rules.lateJoin && s.rules.mode !== 'knockout';
}

export function setRole(s: CupState, u: number, role: 'racer' | 'spectator') {
  const p = player(s, u);
  if (!p || p.role === role) return false;
  if (role === 'racer' && !canRace(s, u)) return false;
  p.role = role;
  if (role === 'spectator' && s.round && s.round.racers.includes(u) && !roundDone(s, u) && s.phase !== 'lobby') s.round.dnf.push(u);
  return true;
}

export function newRound(s: CupState, track: TrackRef, k: number, session: number | null): Round {
  const r: Round = {
    n: s.rounds + 1,
    k,
    try: s.round?.try ?? 0,
    session,
    track,
    racers: activeRacers(s).map((p) => p.u),
    startAt: null,
    endAt: null,
    closeAt: null,
    warmupUntil: null,
    runs: {},
    dnf: [],
    skip: [],
  };
  for (const p of s.players) delete p.ready;
  s.round = r;
  s.vote = null;
  return r;
}

// GO for the current round. limitMs is the hard time limit (time attack: the attack itself).
export function scheduleStart(s: CupState, now: number, limitMs: number | null) {
  const r = s.round!;
  r.try++;
  r.runs = {};
  r.dnf = [];
  r.racers = activeRacers(s).map((p) => p.u).filter((u) => r.racers.includes(u) || s.rules.lateJoin);
  r.startAt = now + s.rules.countdownSeconds * 1000 + 600;
  r.endAt = limitMs != null ? r.startAt + limitMs : null;
  r.closeAt = null;
  r.warmupUntil = null;
  setPhase(s, 'countdown', now, r.startAt);
}

// `sentBy` is the latest the finish can have been sent: `now`, or when a proxy outage that held it began.
export function recordFinish(s: CupState, u: number, frames: number, now: number, sentBy = now) {
  const r = s.round;
  if (!r || s.phase !== 'racing' || r.startAt == null || !r.racers.includes(u) || r.dnf.includes(u)) return false;
  if (!Number.isSafeInteger(frames) || frames <= 0) return false;
  const ta = s.rules.style === 'timeattack';
  if (!ta && u in r.runs) return false;
  if (!ta && frames < sentBy - r.startAt - FINISH_SLACK_MS) return false;
  if (frames > now - r.startAt + FINISH_SLACK_MS) return false;
  const prev = r.runs[u];
  if (ta && prev && prev.f <= frames && prev.chk !== 2) {
    prev.a = (prev.a ?? 1) + 1;
    return 'slower';
  }
  r.runs[u] = { f: frames, a: (prev?.a ?? 0) + 1, chk: 0 };
  if (!ta && s.rules.finishWindow > 0 && r.closeAt == null) r.closeAt = now + s.rules.finishWindow * 1000;
  return true;
}

export function recordDnf(s: CupState, u: number) {
  const r = s.round;
  if (!r || !['warmup', 'countdown', 'racing'].includes(s.phase) || !r.racers.includes(u) || r.dnf.includes(u)) return false;
  if (s.rules.style !== 'timeattack' && u in r.runs) return false;
  r.dnf.push(u);
  return true;
}

export function roundOver(s: CupState, now: number) {
  const r = s.round;
  if (!r || s.phase !== 'racing') return false;
  if (r.endAt != null && now >= r.endAt) return true;
  if (r.closeAt != null && now >= r.closeAt) return true;
  const live = r.racers.filter((u) => !player(s, u)?.away);
  if (s.rules.style === 'timeattack') {
    // Bots attack until the end; once every human has retired there is nobody left to race them.
    const people = live.filter((u) => !player(s, u)?.bot);
    return (people.length ? people : live).every((u) => r.dnf.includes(u));
  }
  return live.every((u) => roundDone(s, u));
}

// Who places where in the round. Equal times share a place.
function placings(r: Round) {
  const timed = r.racers.filter((u) => r.runs[u] && r.runs[u].chk !== 2);
  timed.sort((a, b) => r.runs[a].f - r.runs[b].f);
  const place = new Map<number, number>();
  timed.forEach((u, i) => place.set(u, i && r.runs[timed[i - 1]].f === r.runs[u].f ? place.get(timed[i - 1])! : i + 1));
  return { timed, place };
}

// Scores the finished round and moves the cup on: points, wins, knockouts, finalists, champion.
// progress(u) ranks racers without a finish (higher is further).
export function closeRound(s: CupState, progress: (u: number) => number): RoundResult {
  const r = s.round!;
  const rules = s.rules;
  const { timed, place } = placings(r);
  const rows: ResultRow[] = [];
  for (const u of timed) {
    const p = player(s, u);
    const pl = place.get(u)!;
    const pts = rules.mode === 'knockout' ? 0 : (rules.points[pl - 1] ?? 0);
    const run = r.runs[u];
    rows.push([u, run.f, pl, pts, 0, (run.pb ? 1 : 0) | (run.wr ? 2 : 0)]);
    if (!p) continue;
    p.pts += pts;
    if (pl <= 8) p.places[pl - 1] = (p.places[pl - 1] ?? 0) + 1;
    if (pl === 1) p.wins++;
    if (p.best == null || r.runs[u].f < p.best) p.best = r.runs[u].f;
  }
  const missing = r.racers.filter((u) => !place.has(u)).sort((a, b) => progress(b) - progress(a));
  for (const u of missing) rows.push([u, null, null, 0, 0]);
  s.rounds = r.n;

  if (rules.mode === 'knockout') {
    // Racers who left are out on their own; the cut falls on those still here.
    for (const p of s.players) if (p.role === 'racer' && !p.out && p.away) p.out = r.n;
    const alive = r.racers.filter((u) => !player(s, u)?.out);
    const order = rows.filter((row) => alive.includes(row[0]));
    const cut = Math.min(rules.knockout, Math.max(0, alive.length - 1));
    if (cut > 0 && timed.length > 0) {
      const boundary = order.length - cut;
      const edge = order[boundary - 1];
      for (let i = order.length - 1; i >= boundary; i--) {
        const row = order[i];
        // Exact ties at the cut both stay in.
        if (row[1] != null && edge && row[1] === edge[1]) continue;
        const p = player(s, row[0]);
        if (p) p.out = r.n;
        row[4] = 1;
      }
    }
    const left = s.players.filter((p) => p.role === 'racer' && !p.out);
    // With no human left in, the bots don't knock each other out on their own.
    if (left.length <= 1 || !left.some((p) => !p.bot)) s.winner = (left.length === 1 ? left[0].u : standings(s)[0]?.u) ?? null;
  } else if (rules.mode === 'points' && rules.finalist) {
    // A finalist who wins a round outright takes the cup; reaching the target makes a finalist.
    const first = timed.filter((u) => place.get(u) === 1);
    if (first.length === 1 && player(s, first[0])?.fin) s.winner = first[0];
    else for (const p of s.players) if (!p.fin && p.pts >= rules.target && p.role === 'racer') p.fin = 1;
  } else if (rules.mode === 'points') {
    if (s.players.some((p) => p.pts >= rules.target)) s.winner = standings(s)[0]?.u ?? null;
  } else if (rules.mode === 'rounds') {
    if (r.n >= rules.rounds) s.winner = standings(s)[0]?.u ?? null;
  }
  return { n: r.n, track: r.track.name, ta: rules.style === 'timeattack' ? 1 : 0, rows };
}

export function needsNewTrack(s: CupState) {
  return !s.round || s.round.k >= s.rules.perTrack;
}

// Most votes wins; ties and no votes are settled at random among the leaders.
export function tally(opts: TrackRef[], ballots: Record<number, number>, random = Math.random) {
  const counts = opts.map(() => 0);
  for (const v of Object.values(ballots)) if (Number.isInteger(v) && v >= 0 && v < opts.length) counts[v]++;
  const top = Math.max(...counts);
  const leaders = counts.map((c, i) => (c === top ? i : -1)).filter((i) => i >= 0);
  return leaders[Math.floor(random() * leaders.length)];
}

// Who chooses the next track for winner / last picks: the round's winner, or its last placed racer.
export function picker(s: CupState, result: RoundResult | undefined, kind: 'winner' | 'last') {
  if (!result) return null;
  const rows = result.rows.filter((row) => {
    const p = player(s, row[0]);
    return !!p && !p.away && !p.out;
  });
  const pick = kind === 'winner' ? rows.find((row) => row[2] === 1) : [...rows].reverse()[0];
  return pick?.[0] ?? null;
}

// The most points anyone in the cup has. Reaching the cap wins it (`pts >= rules.target`), so a
// points cap moved mid-cup has to stay above this or the cup would end on the spot.
export function leaderPoints(s: CupState) {
  return s.players.reduce((top, p) => Math.max(top, p.pts), 0);
}

export function resetScores(s: CupState) {
  for (const p of s.players) {
    p.pts = 0;
    p.wins = 0;
    p.places = [];
    delete p.out;
    delete p.fin;
    delete p.best;
    delete p.ready;
  }
  s.winner = null;
  s.round = null;
  s.vote = null;
  s.draft = null;
  s.playlist = [];
  s.playIndex = 0;
  s.rounds = 0;
}

// ---- Pick and ban ----


export function startDraft(s: CupState, opts: TrackRef[], now: number) {
  const stage = s.rules.bans > 0 ? 'ban' : 'pick';
  s.draft = { stage, until: now + s.rules.draftSeconds * 1000, opts, bans: {}, picks: {} };
  setPhase(s, 'draft', now, s.draft.until);
}

// A racer toggles a ban or a pick. Picks can't be banned tracks, and nobody goes over their quota.
export function draftChoose(s: CupState, u: number, kind: 'ban' | 'pick', id: string) {
  const d = s.draft;
  const p = player(s, u);
  if (!d || s.phase !== 'draft' || d.stage !== kind || !p || p.role !== 'racer' || p.out) return false;
  if (!d.opts.some((t) => t.id === id)) return false;
  const banned = new Set(Object.values(d.bans).flat());
  if (kind === 'pick' && banned.has(id)) return false;
  // Bans always leave something to pick.
  if (kind === 'ban' && !banned.has(id) && banned.size + 1 >= d.opts.length) return false;
  const book = kind === 'ban' ? d.bans : d.picks;
  const mine = book[u] ?? [];
  const quota = kind === 'ban' ? s.rules.bans : s.rules.picks;
  if (mine.includes(id)) book[u] = mine.filter((x) => x !== id);
  else if (mine.length < quota) book[u] = [...mine, id];
  else return false;
  return true;
}

export function draftComplete(s: CupState) {
  const d = s.draft;
  if (!d) return false;
  const quota = d.stage === 'ban' ? s.rules.bans : s.rules.picks;
  const book = d.stage === 'ban' ? d.bans : d.picks;
  const voters = humanRacers(s).filter((p) => !p.away);
  return voters.length > 0 && voters.every((p) => (book[p.u]?.length ?? 0) >= quota);
}

// Bans close into picks; picks close into the playlist (racers who didn't pick get random ones).
export function draftAdvance(s: CupState, now: number, random = Math.random) {
  const d = s.draft!;
  if (d.stage === 'ban') {
    d.stage = 'pick';
    d.until = now + s.rules.draftSeconds * 1000;
    setPhase(s, 'draft', now, d.until);
    return false;
  }
  const banned = new Set(Object.values(d.bans).flat());
  const free = () => d.opts.filter((t) => !banned.has(t.id));
  // Humans' picks are played before the bots'.
  const shuffled = (list: number[]) => list.sort(() => random() - 0.5);
  const order = [...shuffled(humanRacers(s).map((p) => p.u)), ...shuffled(racers(s).filter((p) => p.bot).map((p) => p.u))];
  const lists = order.map((u) => {
    const mine = [...(d.picks[u] ?? [])];
    while (mine.length < s.rules.picks) {
      const left = free().filter((t) => !mine.includes(t.id));
      if (!left.length) break;
      mine.push(left[Math.floor(random() * left.length)].id);
    }
    return mine;
  });
  const playlist: TrackRef[] = [];
  for (let i = 0; i < s.rules.picks; i++)
    for (const list of lists) {
      const t = d.opts.find((x) => x.id === list[i]);
      if (t && !playlist.some((x) => x.id === t.id)) playlist.push(t);
    }
  if (!playlist.length) playlist.push(...free().slice(0, 1));
  s.playlist = playlist;
  s.playIndex = 0;
  s.draft = null;
  return true;
}

export function nextFromPlaylist(s: CupState) {
  if (!s.playlist.length) return null;
  const t = s.playlist[s.playIndex % s.playlist.length];
  s.playIndex++;
  return t;
}
