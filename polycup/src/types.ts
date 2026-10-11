export type PlayerId = number;
export type TrackId = string;
export type Phase =
  | 'registration'
  | 'loading'
  | 'warmup'
  | 'countdown'
  | 'racing'
  | 'between-rounds'
  | 'complete';
export interface Racer {
  countryCode?: string | null;
  id: PlayerId;
  name: string;
}
export interface Track {
  id: TrackId;
  name: string;
}
export interface Draft {
  stage: 'roster' | 'bans' | 'picks';
  order: PlayerId[];
  bans: Record<PlayerId, Track>;
  banHistory?: { racerId: PlayerId; track: Track }[];
}
export interface RaceRecord {
  countryCode?: string | null;
  status: 'ready' | 'missing' | 'unavailable';
  frames?: number;
  name?: string;
  source?: 'online' | 'profile';
}
export interface SessionRecord {
  frames: number;
  ids: PlayerId[];
  provisional?: boolean;
}
export interface TrackRecords {
  pbs: Record<PlayerId, RaceRecord>;
  wr?: RaceRecord;
  tr?: SessionRecord | null;
}
export interface Split {
  index: number;
  frames: number;
  bestFrames: number;
}
export type RecordAward = 'PB' | 'TR' | 'WR';
export interface RecordBaselines {
  wr?: number;
  tr?: number;
  pbs: Record<PlayerId, number | null>;
}
export interface Round {
  recordBaselines?: RecordBaselines;
  recordAwards?: Record<PlayerId, RecordAward>;
  racers?: PlayerId[];
  id: string;
  round: number;
  trackId: TrackId;
  warmup: boolean;
  sessionId: number | null;
  ready: PlayerId[];
  sittingOut?: PlayerId[];
  practiceReady?: PlayerId[];
  startsAt: number | null;
  deadline: number | null;
  finishes: Record<PlayerId, number>;
  dnfs: PlayerId[];
  checkpoints: Record<PlayerId, number>;
  splits?: Record<PlayerId, Split>;
  liveMovement?: Record<PlayerId, number>;
  // Not So Weekly Shorts: when the round ends whatever happens (time limit or time-attack window).
  limitAt?: number | null;
  // Finishes the organizer is still replaying through the physics.
  verifying?: PlayerId[];
}
export interface Finalist {
  round: number;
  position: number;
  checkpoint: number | null;
}
export interface ScoredRound {
  recordAwards?: Record<PlayerId, RecordAward>;
  beforeRanking: PlayerId[];
  round: number;
  trackId: TrackId;
  finishes: Record<PlayerId, number>;
  points: Record<PlayerId, number>;
  dnfs: PlayerId[];
  winners: PlayerId[];
  tiedFirst: boolean;
}
export interface Match {
  currentVisit?: { trackId: TrackId; fromRound: number };
  rotationOffset?: number;
  randomTrack?: { id: TrackId; fromRound: number; rounds: number };
  name: string;
  players: PlayerId[];
  target: number;
  winnerCount: number;
  order: TrackId[];
  trackRounds?: Record<TrackId, number>;
  trackWarmups?: Record<TrackId, number>;
  rounds: number;
  winners: PlayerId[];
  scores: Record<PlayerId, number>;
  finalists: Record<PlayerId, Finalist>;
  roundsLog: ScoredRound[];
  ranking: PlayerId[];
  // Not So Weekly Shorts: how often each racer took each place (countback), and knockout exits.
  placings?: Record<PlayerId, number[]>;
  knockedOut?: { id: PlayerId; round: number }[];
}
export interface CupState {
  removedTracks?: TrackId[];
  withdrawn?: PlayerId[];
  pendingRacers?: PlayerId[];
  preset?: import('./presets.ts').CupPreset;
  selections?: Record<PlayerId, TrackId[]>;
  schema: 2;
  version: string;
  id: string;
  name: string;
  revision: number;
  phase: Phase;
  roster: Racer[];
  tracks: Track[];
  picks: Record<PlayerId, TrackId>;
  records: Record<TrackId, TrackRecords>;
  matches: Match[];
  matchIndex: number;
  runtime: Round | null;
  history: { matchIndex: number; before: Match }[];
  audit: { at: string; message: string }[];
  results: { id: PlayerId; place: number }[];
  disconnectPolicy: 'dnf' | 'void';
  draft?: Draft;
  // Not So Weekly Shorts: vote-skip (cup.ts voteSkip). A vote that passes after someone finished
  // ends the track after the live round instead of voiding it.
  skipVote?: { trackId: TrackId; ids: PlayerId[]; passed?: boolean };
  // When the next round starts on its own (organizer clock), for every player's countdown.
  nextRoundAt?: number | null;
  // Choosing the next random track: everyone votes, or one racer picks.
  trackVote?: TrackVote | null;
}
export interface TrackVote {
  id: string;
  mode: 'vote' | 'winner' | 'last';
  picker: PlayerId | null;
  options: Track[];
  votes: Record<PlayerId, TrackId>;
  endsAt: number;
}
export type PublicCupState = Omit<CupState, 'history'> & { history?: CupState['history'] };
export type InputEvent = [frame: number, mask: number];
export interface DrivingControls {
  up: boolean;
  right: boolean;
  down: boolean;
  left: boolean;
  reset: boolean;
}
export interface InputContext {
  cupId: string;
  roundId: string;
  sessionId: number;
  stage: 'warmup' | 'race';
}
export interface InputPacket extends InputContext {
  type: 'inputs';
  seq: number;
  attempt: number;
  through: number;
  events: InputEvent[];
  gap: boolean;
}
export interface CameraPose {
  sessionId: number;
  at: number;
  position: number[];
  quaternion: number[];
  fov: number;
  frames: number;
  speed: number;
  carPosition: number[];
  carQuaternion: number[];
  view: number;
  resetCounter?: number;
}
export type ReviewOutcome = 'pending' | 'finished' | 'dnf' | 'void' | 'undone' | 'interrupted';
export interface ReviewFlag {
  kind: 'inputs' | 'checkpoints';
  otherId: string;
  transitions?: number;
  maxDelta?: number;
  exactCheckpoints?: boolean;
  checkpoints?: number;
  repeats?: number;
}
export interface ReviewRun {
  id: string;
  roundId: string;
  round: number;
  trackId: string;
  racerKey: string;
  name: string;
  outcome: ReviewOutcome;
  finish: number | null;
  expectedCheckpoints: number;
  checkpoints: InputEvent[];
  inputs: InputEvent[];
  through: number;
  nextSeq: number;
  gap: boolean;
  flag: ReviewFlag | null;
  reviewed: boolean;
}

export type CameraView = Omit<CameraPose, 'carPosition' | 'carQuaternion' | 'at'> & {
  carPosition?: number[];
  carQuaternion?: number[];
  at?: number;
};
