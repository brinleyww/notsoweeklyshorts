// Messages between the organizer's page and its bot planner workers (mod/cuppa_bots.js, loaded into
// a copy of the game's simulation worker named WORKER_NAME).

export const WORKER_NAME = 'nsws-cuppa-bots';

export interface Persona {
  u: number;
  // 0..1
  skill: number;
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
  | { b: 'job'; id: string; key: string; bot: Persona; mode: 'run' | 'ta'; end: number }
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
  | { b: 'error'; id?: string; message: string };
