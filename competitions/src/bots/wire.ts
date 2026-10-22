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
  // drill: the top expert, which searches its own run as it goes.
  | { b: 'job'; id: string; key: string; bot: Persona; mode: 'run' | 'ta'; end: number; brain: Float32Array | null; notes: Record<string, Float32Array> | null; drill?: boolean }
  // Weights a running bot takes up from its next run.
  | { b: 'brain'; id: string; w: Float32Array | null }
  // To the learning worker: keep improving these weights on the track (worker/learn.ts).
  // practice: experts to drive practice runs with, and their notes by hint run.
  | { b: 'learn'; key: string; tasks: { key: string; skill: number; w: Float32Array }[]; practice: { bot: Persona; notes: Record<string, Float32Array> }[] }
  // An expert's notes on its hint run (ref) learned in practice, from its next run.
  | { b: 'notes'; key: string; name: number; ref: string; v: Float32Array }
  // GO on the cup clock (null until set); cup clock = Date.now() + offset.
  | { b: 'clock'; startAt: number | null; offset: number }
  | { b: 'cancel'; id: string }
  | { b: 'drop'; key: string };

export type FromWorker =
  | { b: 'ready' }
  | { b: 'track'; key: string; ok: boolean; refs: { id: string; valid: boolean; frames: number }[]; parts: number; ms: number }
  // data: a deflated keyframe chunk; to: its last bot frame.
  | { b: 'chunk'; id: string; seq: number; data: Uint8Array; to: number }
  // finish: the counting finish (best run in time attack); runs: [start, finish] per run; dnf: where it gave up.
  | { b: 'result'; id: string; finish: number | null; runs: [number, number | null][]; dnf: number | null; frontier: number }
  // frontier: committed bot frame; rate: bot frames planned per wall ms lately.
  | { b: 'progress'; id: string; frontier: number; rate: number }
  | { b: 'error'; id?: string; message: string }
  // The learning worker found better weights for a task: cost (lower is better) now and before.
  | { b: 'learned'; key: string; task: string; w: Float32Array; cost: number; was: number }
  // An expert's notes on its hint run (ref) got better in practice: a run costs `cost` now, `was` before.
  | { b: 'notes'; key: string; name: number; ref: string; v: Float32Array; cost: number; was: number };
