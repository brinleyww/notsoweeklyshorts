import { cleanChatText, filterChat } from './chat-filter.ts';
import { PendingActions } from './pending-actions.ts';

export const CHAT_LIMIT = 400;
export interface ChatLine {
  seq: number;
  at: number;
  speaker: number;
  color: number;
  name: string;
  text: string;
}
interface Speaker {
  key: string;
  id: number;
  color: number;
  name: string;
  muted: boolean;
}
export interface ChatArchive {
  cupId: string;
  lines: ChatLine[];
  speakers: Speaker[];
}
export type ChatMessage =
  | { type: 'chat-post'; cupId: string; requestId: string; text: string }
  | { type: 'chat-ack'; cupId: string; requestId: string; error?: string }
  | { type: 'chat-read'; cupId: string; after: number }
  | { type: 'chat-page'; cupId: string; lines: ChatLine[]; total: number; muted: boolean }
  | { type: 'chat-line'; cupId: string; line: ChatLine };
export interface ChatContext {
  cupId: string;
  host: boolean;
  selfId: number;
  peers: { id: number; name: string; key?: string }[];
}
interface ChatOptions {
  context: () => ChatContext | null;
  send: (id: number, message: ChatMessage) => boolean;
  changed: () => void;
}

function validLine(value: unknown): value is ChatLine {
  if (!value || typeof value !== 'object') return false;
  const l = value as ChatLine;
  return (
    Number.isSafeInteger(l.seq) &&
    l.seq > 0 &&
    Number.isSafeInteger(l.at) &&
    l.at >= 0 &&
    Number.isSafeInteger(l.speaker) &&
    l.speaker > 0 &&
    Number.isInteger(l.color) &&
    l.color >= 0 &&
    l.color < 8 &&
    typeof l.name === 'string' &&
    l.name.length <= 64 &&
    typeof l.text === 'string' &&
    l.text.length > 0 &&
    l.text.length <= CHAT_LIMIT
  );
}
export class CupChat {
  #options: ChatOptions;
  #cupId = '';
  #lines: ChatLine[] = [];
  #speakers: Speaker[] = [];
  #requests = new PendingActions();
  #seen = new Map<string, number>();
  #rates = new Map<string, number[]>();
  #reads = new Map<number, number>();
  #nextRead = 0;
  #muted = false;
  #revision = 0;
  constructor(options: ChatOptions) {
    this.#options = options;
  }
  get cupId() {
    return this.#cupId;
  }
  get lines(): readonly ChatLine[] {
    return this.#lines;
  }
  get revision() {
    return this.#revision;
  }
  get muted() {
    return this.#muted;
  }
  get speakers() {
    return this.#speakers.map(({ id, name, color, muted, key }) => ({
      id,
      name,
      color,
      muted,
      canMute: key !== 'host',
    }));
  }
  #context() {
    const context = this.#options.context();
    if (context && context.cupId !== this.#cupId) {
      this.#requests.cancel('The Cup changed.');
      this.#cupId = context.cupId;
      this.#lines = [];
      this.#speakers = [];
      this.#seen.clear();
      this.#rates.clear();
      this.#reads.clear();
      this.#nextRead = 0;
      this.#muted = false;
      this.#revision++;
    }
    return context;
  }
  tick() {
    const context = this.#context();
    if (!context || context.host || Date.now() < this.#nextRead) return;
    this.#nextRead = Date.now() + 2000;
    this.#options.send(0, { type: 'chat-read', cupId: context.cupId, after: this.#lines.length });
  }
  async post(text: string) {
    const context = this.#context();
    if (!context) throw new Error('Join a Cup to chat.');
    text = cleanChatText(text);
    if (!text || text.length > CHAT_LIMIT) throw new Error(`Use 1–${CHAT_LIMIT} characters.`);
    await this.#requests.run('chat', (requestId) => {
      const message: ChatMessage = { type: 'chat-post', cupId: context.cupId, requestId, text };
      if (context.host) {
        this.receive(context.selfId, message);
        return true;
      }
      return this.#options.send(0, message);
    });
  }
  receive(id: number, message: ChatMessage) {
    const context = this.#context();
    if (!context || message.cupId !== context.cupId) return;
    if (!context.host) {
      if (id !== 0) return;
      if (message.type === 'chat-ack' && typeof message.requestId === 'string') {
        this.#requests.acknowledge(
          message.requestId,
          typeof message.error === 'string' ? message.error.slice(0, 200) : undefined,
        );
      } else if (message.type === 'chat-line') this.#append(message.line);
      else if (
        message.type === 'chat-page' &&
        Array.isArray(message.lines) &&
        message.lines.length <= 32 &&
        Number.isSafeInteger(message.total) &&
        message.total >= this.#lines.length &&
        typeof message.muted === 'boolean'
      ) {
        if (message.muted !== this.#muted) {
          this.#muted = message.muted;
          this.#revision++;
        }
        for (const line of message.lines) this.#append(line);
        if (this.#lines.length < message.total) this.#nextRead = 0;
      }
      this.#options.changed();
      return;
    }
    const peer = context.peers.find((p) => p.id === id);
    if (!peer) return;
    if (message.type === 'chat-read') {
      if (
        !Number.isSafeInteger(message.after) ||
        message.after < 0 ||
        message.after > this.#lines.length ||
        Date.now() < (this.#reads.get(id) ?? 0)
      )
        return;
      this.#reads.set(id, Date.now() + 200);
      this.#options.send(id, {
        type: 'chat-page',
        cupId: context.cupId,
        lines: this.#lines.slice(message.after, message.after + 32),
        total: this.#lines.length,
        muted: !!this.#speakers.find((s) => s.key === peer.key)?.muted,
      });
    } else if (
      message.type === 'chat-post' &&
      typeof message.requestId === 'string' &&
      /^[a-zA-Z0-9-]{1,80}$/.test(message.requestId)
    ) {
      let error: string | undefined;
      try {
        if (!peer.key) throw new Error('Verifying your profile. Try again in a moment.');
        const nonce = `${peer.key}:${message.requestId}`;
        if (!this.#seen.has(nonce)) {
          if (typeof message.text !== 'string' || message.text.length > CHAT_LIMIT)
            throw new Error('Message is too long.');
          if (this.#lines.length >= 100000)
            throw new Error('This Cup has reached its chat limit. Export the log to keep it.');
          const text = filterChat(cleanChatText(message.text));
          if (!text) throw new Error('Enter a message.');
          let speaker = this.#speakers.find((s) => s.key === peer.key);
          if (!speaker) {
            speaker = {
              key: peer.key,
              id: this.#speakers.length + 1,
              color: Math.abs(id) % 8,
              name: '',
              muted: false,
            };
            this.#speakers.push(speaker);
          }
          if (speaker.muted) throw new Error('The organizer muted you for this Cup.');
          const recent = (this.#rates.get(peer.key) ?? []).filter((at) => Date.now() - at < 5000);
          if (recent.length >= 3) throw new Error('Slow down—try again in a few seconds.');
          recent.push(Date.now());
          this.#rates.set(peer.key, recent);
          speaker.name = filterChat(cleanChatText(peer.name).slice(0, 64));
          const line: ChatLine = {
            seq: this.#lines.length + 1,
            at: Date.now(),
            speaker: speaker.id,
            color: speaker.color,
            name: speaker.name,
            text,
          };
          this.#lines.push(line);
          this.#seen.set(nonce, line.seq);
          this.#revision++;
          for (const target of context.peers)
            if (target.id !== context.selfId)
              this.#options.send(target.id, { type: 'chat-line', cupId: context.cupId, line });
        }
      } catch (e) {
        error = e instanceof Error ? e.message : 'Could not send message.';
      }
      const ack: ChatMessage = {
        type: 'chat-ack',
        cupId: context.cupId,
        requestId: message.requestId,
        error,
      };
      if (id === context.selfId) this.#requests.acknowledge(message.requestId, error);
      else this.#options.send(id, ack);
      this.#options.changed();
    }
  }
  #append(line: ChatLine) {
    if (!validLine(line) || line.seq !== this.#lines.length + 1) {
      this.#nextRead = 0;
      return;
    }
    this.#lines.push({
      ...line,
      name: filterChat(cleanChatText(line.name)),
      text: filterChat(cleanChatText(line.text)),
    });
    this.#revision++;
  }
  mute(speakerId: number, muted: boolean) {
    const context = this.#context();
    if (!context?.host) throw new Error('Only the organizer can mute chat.');
    const speaker = this.#speakers.find((s) => s.id === speakerId);
    if (!speaker || speaker.key === 'host') return;
    speaker.muted = muted;
    this.#revision++;
    this.#options.changed();
  }
  archive(): ChatArchive {
    this.#context();
    return {
      cupId: this.#cupId,
      lines: structuredClone(this.#lines),
      speakers: structuredClone(this.#speakers),
    };
  }
  restore(value: unknown, cupId: string) {
    if (value === undefined) return;
    const data = value as ChatArchive;
    if (
      !data ||
      data.cupId !== cupId ||
      !Array.isArray(data.lines) ||
      !Array.isArray(data.speakers) ||
      data.lines.length > 100000 ||
      data.speakers.length > 10000 ||
      !data.lines.every((line, i) => validLine(line) && line.seq === i + 1) ||
      !data.speakers.every(
        (s, i) =>
          s &&
          s.id === i + 1 &&
          typeof s.key === 'string' &&
          s.key.length <= 100 &&
          typeof s.name === 'string' &&
          s.name.length <= 64 &&
          typeof s.muted === 'boolean' &&
          Number.isInteger(s.color) &&
          s.color >= 0 &&
          s.color < 8,
      ) ||
      !data.lines.every((line) => data.speakers.some((s) => s.id === line.speaker))
    )
      throw new Error('Invalid saved chat.');
    this.#requests.cancel('Chat restored.');
    this.#cupId = cupId;
    this.#lines = data.lines.map((l) => ({
      ...l,
      text: filterChat(cleanChatText(l.text)),
      name: filterChat(cleanChatText(l.name)),
    }));
    this.#speakers = structuredClone(data.speakers);
    this.#seen.clear();
    this.#rates.clear();
    this.#reads.clear();
    this.#nextRead = 0;
    this.#revision++;
  }
}
