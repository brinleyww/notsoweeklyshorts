import type {
  CameraPose,
  CupState,
  InputContext,
  InputEvent,
  InputPacket,
  PublicCupState,
  RaceRecord,
} from './types.ts';
export type ActionType =
  | 'join'
  | 'leave'
  | 'ban'
  | 'dnf'
  | 'practice-ready'
  | 'remove-pick'
  | 'skip-vote';
export interface ActionMessage {
  type: ActionType;
  requestId?: string;
  cupId?: string;
  value?: string;
}
export interface FinishMessage {
  type: 'finish';
  roundId: string;
  sessionId: number | null;
  frames: number;
  checkpoint: number | null;
}
export interface CheckpointMessage {
  type: 'checkpoint';
  cupId: string;
  roundId: string;
  sessionId: number | null;
  index: number;
  frames: number;
}
export interface ReadyMessage {
  type: 'ready';
  roundId: string;
  sessionId: number;
  trackId: string;
}
export type TrackMessage = { cupId: string; transferId: string } & (
  | { type: 'track-begin'; length: number }
  | { type: 'track-chunk'; seq: number; data: string }
  | { type: 'track-end' }
);
export interface InputViewMessage extends InputContext {
  type: 'input-view';
  racerId: number;
  attempt: number;
  through: number;
  events: InputEvent[];
}
export type Message =
  | { type: 'identity-open'; cupId: string; publicKey: string }
  | { type: 'identity-challenge'; cupId: string; nonce: string }
  | { type: 'identity-proof'; cupId: string; nonce: string; signature: string }
  | { type: 'reconnect-queued'; cupId: string; racerId: number }
  | ActionMessage
  | { type: 'action-ack'; requestId: string; error?: string }
  | FinishMessage
  | CheckpointMessage
  | ReadyMessage
  | TrackMessage
  | InputPacket
  | InputViewMessage
  | { type: 'hello'; version: string; sentAt: number }
  | { type: 'hello-ack'; version: string; sentAt: number; hostAt: number }
  | { type: 'watch'; value: number | null; previous?: number | null }
  | { type: 'pb'; cupId: string; trackId: string; pb: RaceRecord }
  | { type: 'track-ack'; transferId: string; error?: string }
  | { type: 'state'; sequence: number; state: PublicCupState | null }
  | { type: 'error'; message: string }
  | { type: 'camera'; pose: CameraPose; racerId?: number };
export type StateMutation = (state: CupState) => void;
