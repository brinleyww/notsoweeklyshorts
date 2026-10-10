import type { CupState, Track } from './types.ts';
import { rulesFor } from './presets.ts';
// Optional on old saves; every newly created Cup enables the ban draft.
function requireThat(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
export const rosterOpen = (s: CupState) =>
  s.phase === 'registration' && (!s.draft || s.draft.stage === 'roster');
export const picksOpen = (s: CupState) =>
  rulesFor(s).selection === 'draft' &&
  s.phase === 'registration' &&
  (!s.draft || s.draft.stage === 'picks');
export const banEntries = (s: CupState) =>
  s.draft?.banHistory ??
  Object.entries(s.draft?.bans ?? {}).map(([id, track]) => ({ racerId: Number(id), track }));
export const banTurn = (s: CupState) =>
  s.draft?.stage === 'bans' ? s.draft.order[banEntries(s).length % s.draft.order.length] : null;
export const isBanned = (s: CupState, id: string) => banEntries(s).some((b) => b.track.id === id);
export function resetDraft(s: CupState) {
  requireThat(s.phase === 'registration', 'The Cup has already started.');
  s.draft = { stage: 'roster', order: [], bans: {} };
  s.picks = {};
  s.selections = {};
  s.tracks = [];
  s.records = {};
  s.revision++;
}
export function beginBans(s: CupState, random = Math.random) {
  requireThat(rulesFor(s).selection === 'draft', 'Random Cups do not have a draft.');
  requireThat(rosterOpen(s), 'Bans have already started.');
  requireThat(s.roster.length >= 2, 'At least two racers are required.');
  const order = s.roster.map((p) => p.id);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  s.draft = { stage: rulesFor(s).bansPerRacer ? 'bans' : 'picks', order, bans: {} };
  s.picks = {};
  s.selections = {};
  s.tracks = [];
  s.records = {};
  s.revision++;
}
export function banTrack(
  s: CupState,
  actor: number,
  track: (Track & { category: string }) | undefined,
) {
  requireThat(
    s.draft && s.phase === 'registration' && banTurn(s) === actor,
    'Wait for your ban turn.',
  );
  requireThat(
    track && ['official', 'community'].includes(track.category) && /^[a-f0-9]{64}$/i.test(track.id),
    'Bans must come from the main or community track pool.',
  );
  requireThat(
    rulesFor(s).pool.includes(track.category as 'official' | 'community'),
    'That track category is not allowed by this preset.',
  );
  requireThat(!isBanned(s, track.id), 'That track is already banned.');
  const history = banEntries(s);
  s.draft.bans[actor] = {
    id: track.id,
    name: String(track.name)
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .slice(0, 64),
  };
  s.draft.banHistory = [...history, { racerId: actor, track: s.draft.bans[actor] }];
  if (s.draft.banHistory.length === s.draft.order.length * rulesFor(s).bansPerRacer)
    s.draft.stage = 'picks';
  s.revision++;
}
export function validDraft(s: CupState) {
  const d = s.draft;
  if (d === undefined) return true; // Continue pre-draft saved Cups.
  if (
    !d ||
    !['roster', 'bans', 'picks'].includes(d.stage) ||
    !Array.isArray(d.order) ||
    !d.bans ||
    typeof d.bans !== 'object' ||
    Array.isArray(d.bans) ||
    (d.banHistory !== undefined &&
      (!Array.isArray(d.banHistory) ||
        d.banHistory.some((b) => !b || !b.track || typeof b.track.id !== 'string')))
  )
    return false;
  const keys = Object.keys(d.bans),
    bans = Object.values(d.bans);
  if (d.stage === 'roster')
    return (
      (s.phase === 'registration' || rulesFor(s).selection === 'random') &&
      !d.order.length &&
      !keys.length &&
      (!s.tracks.length || rulesFor(s).selection === 'random') &&
      !Object.keys(s.picks).length
    );
  if (
    d.order.length < 2 ||
    (d.order.length !== s.roster.length &&
      (s.phase === 'registration' || !rulesFor(s).allowRacerChanges)) ||
    new Set(d.order).size !== d.order.length ||
    !d.order.every((id) => s.roster.some((p) => p.id === id)) ||
    keys.length > d.order.length ||
    !keys.every((id) => d.order.includes(Number(id))) ||
    !bans.every(
      (t) =>
        t &&
        typeof t.id === 'string' &&
        /^[a-f0-9]{64}$/i.test(t.id) &&
        typeof t.name === 'string' &&
        t.name.length <= 64,
    ) ||
    new Set(bans.map((t) => t.id)).size !== bans.length ||
    s.tracks.some((t) => isBanned(s, t.id))
  )
    return false;
  const entries = banEntries(s),
    total = d.order.length * rulesFor(s).bansPerRacer;
  if (d.banHistory !== undefined && (!Array.isArray(d.banHistory) || entries.length > 24))
    return false;
  if (
    entries.length > total ||
    entries.some(
      (b, i) =>
        !b ||
        b.racerId !== d.order[i % d.order.length] ||
        !b.track ||
        typeof b.track.id !== 'string' ||
        !/^[a-f0-9]{64}$/i.test(b.track.id) ||
        typeof b.track.name !== 'string' ||
        b.track.name.length > 64,
    ) ||
    new Set(entries.map((b) => b.track.id)).size !== entries.length ||
    keys.some(
      (id) =>
        entries.filter((b) => b.racerId === Number(id)).at(-1)?.track.id !== d.bans[Number(id)].id,
    )
  )
    return false;
  return d.stage === 'bans'
    ? s.phase === 'registration' &&
        entries.length < total &&
        !s.tracks.length &&
        !Object.keys(s.picks).length
    : entries.length === total;
}
