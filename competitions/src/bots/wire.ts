// Messages between the organizer's page and its bot planner workers (mod/cuppa_bots.js, loaded into
// a copy of the game's simulation worker named WORKER_NAME).

export const WORKER_NAME = 'nsws-cuppa-bots';

// From this skill a bot is an expert: it takes a top run of its own as a hint and learns its own way of
// driving the track, round after round (worker/notes.ts).
export const EXPERT_SKILL = 0.95;

export interface Persona {
  u: number;
  // The bot's name (index in BOT_NAMES): what it has learned is kept under it.
  name?: number;
  // 0..1
  skill: number;
  // Which top run (fastest first) is the bot's hint: each bot its own while there are enough.
  copy?: number;
  // 0..1: how readily it takes a reference's risky sections (cuts, long jumps).
  risk: number;
  // 0..1: how often it makes a mistake and lives with it.
  mistakes: number;
  seed: number;
  // The cup's record chaser (an expert): the fastest run is its only hint, it never drives that run's own keys,
  // and it gets the most time going over its runs, to drive faster than the record its own way.
  wr?: boolean;
}

// A bot's best run of its own on a track, as it last went over it (worker/planner.ts, rethink): the notes it
// drove, its keys from the start (bits as in Job.log), its time and the frame it entered each section of its
// hint run (-1 where it didn't). ref: the hint run's refKey.
export interface BotPlan {
  ref: string;
  notes: Float32Array;
  keys: Uint16Array;
  n: number;
  sin: Int32Array;
}

// Something one bot learned on a track that the others may try (worker/shared.ts): a faster way through a
// section of its hint run (win: v = that section's notes, gain = ms the whole run gained) or how a retry got
// past a failure (fix: v = [pace multiplier, offset or NaN]). by: the bot's name; x, y, z: where (the start of
// the section, or where it failed) and cp the next checkpoint there; ref, s: its hint run's refKey and section.
export interface Tip {
  kind: 'win' | 'fix';
  by: number;
  x: number;
  y: number;
  z: number;
  cp: number;
  ref: string;
  s: number;
  v: number[];
  gain: number;
}

export interface RefInput {
  id: string;
  kind: 'wr' | 'board' | 'cup' | 'pb';
  rank?: number;
  recording: string;
  frames: number;
}

export interface Payload {
  trackData: string;
  mountainVertices: Float32Array;
  mountainOffset: { x: number; y: number; z: number };
}

// Frames are bot frames: milliseconds since GO on the race clock.
export type ToWorker =
  | { b: 'init'; init: unknown }
  | { b: 'track'; key: string; trackId: string; payload: Payload; refs: RefInput[] }
  // brain: the bot's network weights (worker/brain.ts), none for driving without it.
  // notes: an expert's notes (worker/notes.ts) by hint run.
  // drill: an expert, which searches its own run as it goes.
  // plans: the bot's own best runs by hint run. warm: rounds it has raced on the track before.
  | { b: 'job'; id: string; key: string; bot: Persona; mode: 'run' | 'ta'; end: number; brain: Float32Array | null; notes: Record<string, Float32Array> | null; drill?: boolean; plans?: BotPlan[]; warm?: number; bumper?: boolean }
  // Bumper cups: another car hit bot job `id` at its frame `at`, changing its velocity by v.
  | { b: 'bump'; id: string; at: number; v: number[] }
  // Weights a running bot takes up from its next run.
  | { b: 'brain'; id: string; w: Float32Array | null }
  // To the learning worker: keep improving these weights on the track (worker/learn.ts).
  // practice: experts to drive practice runs with, and their notes by hint run.
  // polish: experts whose own runs it goes over, with the runs they have.
  | { b: 'learn'; key: string; tasks: { key: string; skill: number; w: Float32Array }[]; practice: { bot: Persona; notes: Record<string, Float32Array> }[]; polish?: { bot: Persona; plans: BotPlan[] }[] }
  // A bot's faster run of its own (by name), found in another worker.
  | { b: 'plan'; key: string; name: number; plan: BotPlan }
  // An expert's notes on its hint run (ref) learned in practice, from its next run.
  | { b: 'notes'; key: string; name: number; ref: string; v: Float32Array }
  // GO on the cup clock (null until set); cup clock = Date.now() + offset.
  | { b: 'clock'; startAt: number | null; offset: number }
  | { b: 'cancel'; id: string }
  | { b: 'drop'; key: string }
  // What other bots learned on the track (from any worker).
  | { b: 'tips'; key: string; tips: Tip[] };

export type FromWorker =
  | { b: 'ready' }
  | { b: 'track'; key: string; ok: boolean; refs: { id: string; valid: boolean; frames: number }[]; parts: number; ms: number }
  // data: a deflated keyframe chunk; to: its last bot frame.
  | { b: 'chunk'; id: string; seq: number; data: Uint8Array; to: number }
  // finish: the counting finish (best run in time attack); runs: [start, finish] per run; dnf: where it gave up;
  // inputs: the counting run's keys from its start (bits as in Job.log).
  | { b: 'result'; id: string; finish: number | null; runs: [number, number | null][]; dnf: number | null; frontier: number; inputs?: Uint16Array | null }
  // frontier: committed bot frame; rate: bot frames planned per wall ms lately.
  | { b: 'progress'; id: string; frontier: number; rate: number }
  | { b: 'error'; id?: string; message: string }
  // The learning worker found better weights for a task: cost (lower is better) now and before.
  | { b: 'learned'; key: string; task: string; w: Float32Array; cost: number; was: number }
  // An expert's notes on its hint run (ref) got better in practice: a run costs `cost` now, `was` before.
  | { b: 'notes'; key: string; name: number; ref: string; v: Float32Array; cost: number; was: number }
  // A bot (by name) found a faster run of its own.
  | { b: 'plan'; key: string; name: number; plan: BotPlan }
  // A bot learned something the others may try.
  | { b: 'tip'; key: string; tip: Tip };
