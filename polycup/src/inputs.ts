import type { DrivingControls, InputContext, InputEvent, InputPacket } from './types.ts';
// Driving controls only. Never capture keyboard text or modify car state.
export const inputMask = (c: DrivingControls) =>
  (c.up ? 1 : 0) | (c.right ? 2 : 0) | (c.down ? 4 : 0) | (c.left ? 8 : 0) | (c.reset ? 16 : 0);
export const inputControls = (mask: number) => ({
  up: !!(mask & 1),
  right: !!(mask & 2),
  down: !!(mask & 4),
  left: !!(mask & 8),
  reset: !!(mask & 16),
});
export const frameNumber = (n: number) => Number.isSafeInteger(n) && n >= 0 && n <= 3600000;
export function validInputEvents(events: InputEvent[], through: number, limit = 128) {
  return (
    Array.isArray(events) &&
    events.length <= limit &&
    events.every(
      (e, i) =>
        Array.isArray(e) &&
        e.length === 2 &&
        frameNumber(e[0]) &&
        e[0] <= through &&
        Number.isInteger(e[1]) &&
        e[1] >= 0 &&
        e[1] <= 31 &&
        (!i || e[0] >= events[i - 1][0]),
    )
  );
}

export class InputCapture {
  get gap() {
    return this.#gap;
  }

  #context: InputContext;
  #events: InputEvent[] = [];
  #seq: number = 0;
  #attempt: number = 0;
  #mask: number | null = null;
  #through: number = 0;
  #gap: boolean = false;

  constructor(context: InputContext) {
    this.#context = context;
  }
  markGap() {
    this.#gap = true;
  }
  capture(frames: number, mask: number) {
    if (frameNumber(frames) && frames < this.#through && this.#context.stage === 'warmup') {
      this.#events = [];
      this.#through = 0;
      this.#mask = null;
      this.#attempt++;
    }
    if (!frameNumber(frames) || frames < this.#through) {
      this.#gap = true;
      return;
    }
    this.#through = frames;
    if (mask === this.#mask) return;
    this.#mask = mask;
    this.#events.push([frames, mask]);
    if (this.#events.length > 128) {
      this.#events.shift();
      this.#gap = true;
    }
  }
  flush(send: (message: InputPacket) => boolean) {
    const message: InputPacket = {
      type: 'inputs',
      ...this.#context,
      seq: this.#seq,
      attempt: this.#attempt,
      through: this.#through,
      events: this.#events,
      gap: this.#gap,
    };
    if (!send(message)) return false;
    this.#seq++;
    this.#events = [];
    this.#gap = false;
    return true;
  }
}

export class InputTimeline {
  get attempt() {
    return this.#attempt;
  }
  get through() {
    return this.#through;
  }
  get events() {
    return this.#events;
  }

  #events: InputEvent[] = [];
  #through: number = -1;
  #receivedAt: number = -Infinity;
  #attempt: number;

  constructor(attempt = 0) {
    this.#attempt = attempt;
  }
  push(events: InputEvent[], through: number, now: number) {
    if (!frameNumber(through) || through < this.#through || !validInputEvents(events, through))
      return false;
    // Same-frame changes are kept in arrival order; the final one wins on display.
    for (const e of events)
      if (!this.#events.length || e[0] >= this.#events.at(-1)![0]) this.#events.push([...e]);
    this.#events = this.#events.slice(-512);
    this.#through = through;
    this.#receivedAt = now;
    return true;
  }
  sample(frames: number, now: number) {
    if (now - this.#receivedAt > 1500 || frames > this.#through || frames < this.#events[0]?.[0])
      return null;
    for (let i = this.#events.length - 1; i >= 0; i--)
      if (this.#events[i][0] <= frames) return this.#events[i][1];
    return null;
  }
  snapshot() {
    return { events: this.#events.slice(-128), through: this.#through, attempt: this.#attempt };
  }
}
