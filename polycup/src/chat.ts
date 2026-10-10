// Not So Weekly Shorts: the cup chat runs on the site's universal chat (proxy/src/chat.js), in a
// room of its own for each cup code, so it has the same filter, slow mode and timeouts as the main
// chat. Only the panel (chat-ui.ts) is PolyCup's. The organizer's mutes are enforced by that room.
export const CHAT_LIMIT = 200;
const MAX_LINES = 2000;
const KEEPALIVE_MS = 30000;
const RETRY_MS = 3000;
const SEND_TIMEOUT_MS = 8000;

export interface ChatLine {
  seq: number;
  at: number;
  speaker: number;
  color: number;
  name: string;
  text: string;
}
interface ServerMessage {
  id: number;
  at: number;
  uid: string;
  nick: string;
  text: string;
}
interface Speaker {
  uid: string;
  id: number;
  color: number;
  name: string;
}
export interface ChatContext {
  cupId: string;
  host: boolean;
}
interface ChatOptions {
  context: () => ChatContext | null;
  changed: () => void;
}
interface Identity {
  visitorId(): string;
  nickname(): string;
  ownerKey(): Promise<string | null>;
}

const site = window as unknown as {
  __nswsApiBase?: string;
  __nswsChatIdentity?: Identity;
  __nswsCupRoom?: () => { code: string; secret: string | null } | null;
};

function colorOf(uid: string) {
  let hash = 0;
  for (const c of uid) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  return hash % 8;
}

export class CupChat {
  #options: ChatOptions;
  #cupId = '';
  #code = '';
  #ws: WebSocket | null = null;
  #retryAt = 0;
  #keepAlive = 0;
  #uid: string | null = null;
  #messages: (ServerMessage & { line: ChatLine })[] = [];
  #lines: ChatLine[] = [];
  #speakers = new Map<string, Speaker>();
  #mutes = new Set<string>();
  #pending: { resolve: () => void; reject: (e: Error) => void; timer: number } | null = null;
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
    return !!this.#uid && this.#mutes.has(this.#uid);
  }
  get speakers() {
    const host = !!this.#options.context()?.host;
    return [...this.#speakers.values()].map(({ uid, id, name, color }) => ({
      id,
      name,
      color,
      muted: this.#mutes.has(uid),
      canMute: host && uid !== this.#uid,
    }));
  }
  tick() {
    const context = this.#options.context();
    const room = context ? (site.__nswsCupRoom?.() ?? null) : null;
    if (context) this.#cupId = context.cupId;
    const code = room?.code ?? '';
    if (code !== this.#code) {
      this.#close();
      this.#code = code;
      this.#reset([]);
      this.#retryAt = 0;
    }
    if (room && !this.#ws && Date.now() >= this.#retryAt) this.#open(room);
  }
  #open(room: { code: string; secret: string | null }) {
    const identity = site.__nswsChatIdentity;
    if (!identity || !site.__nswsApiBase) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(
        site.__nswsApiBase.replace(/^http/, 'ws') + 'nsws/chat?cup=' + encodeURIComponent(room.code),
      );
    } catch {
      this.#retryAt = Date.now() + RETRY_MS;
      return;
    }
    this.#ws = ws;
    ws.addEventListener('open', async () => {
      const hello: Record<string, string> = {
        t: 'hello',
        v: identity.visitorId(),
        nick: identity.nickname(),
      };
      const key = await identity.ownerKey();
      if (key) hello.key = key;
      if (room.secret) hello.host = room.secret;
      if (this.#ws !== ws) return;
      ws.send(JSON.stringify(hello));
      this.#keepAlive = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('ping');
      }, KEEPALIVE_MS);
    });
    ws.addEventListener('message', (event) => {
      if (this.#ws !== ws || event.data === 'pong') return;
      try {
        this.#server(JSON.parse(event.data));
      } catch {}
    });
    ws.addEventListener('close', () => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#uid = null;
      clearInterval(this.#keepAlive);
      this.#retryAt = Date.now() + RETRY_MS;
      this.#settle('Chat disconnected. Try again in a moment.');
    });
  }
  #close() {
    const ws = this.#ws;
    this.#ws = null;
    this.#uid = null;
    clearInterval(this.#keepAlive);
    this.#settle('The cup changed.');
    try {
      ws?.close();
    } catch {}
  }
  #settle(error?: string) {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = null;
    clearTimeout(pending.timer);
    if (error) pending.reject(new Error(error));
    else pending.resolve();
  }
  #speaker(m: ServerMessage) {
    let speaker = this.#speakers.get(m.uid);
    if (!speaker) {
      speaker = { uid: m.uid, id: this.#speakers.size + 1, color: colorOf(m.uid), name: m.nick };
      this.#speakers.set(m.uid, speaker);
    }
    speaker.name = m.nick;
    return speaker;
  }
  #reset(messages: ServerMessage[]) {
    this.#messages = [];
    this.#speakers.clear();
    for (const m of messages) this.#add(m);
    this.#relist();
  }
  #add(m: ServerMessage) {
    if (!m || typeof m.text !== 'string' || typeof m.uid !== 'string') return;
    const speaker = this.#speaker(m);
    const line = { seq: 0, at: m.at, speaker: speaker.id, color: speaker.color, name: m.nick, text: m.text };
    this.#messages.push({ ...m, line });
    if (this.#messages.length > MAX_LINES) this.#messages.splice(0, this.#messages.length - MAX_LINES);
  }
  #relist() {
    this.#lines = this.#messages.map((m, i) => ((m.line.seq = i + 1), m.line));
    this.#revision++;
    this.#options.changed();
  }
  #server(data: { t?: string; [key: string]: unknown }) {
    if (data.t === 'init') {
      this.#uid = (data.you as { uid?: string })?.uid ?? null;
      this.#mutes = new Set(Array.isArray(data.mutes) ? (data.mutes as string[]) : []);
      this.#reset(Array.isArray(data.messages) ? (data.messages as ServerMessage[]) : []);
    } else if (data.t === 'msg') {
      const m = data.m as ServerMessage;
      this.#add(m);
      this.#relist();
      if (m?.uid === this.#uid) this.#settle();
    } else if (data.t === 'edit') {
      const m = this.#messages.find((x) => x.id === data.id);
      if (m && typeof data.text === 'string') {
        m.line.text = m.text = data.text;
        this.#relist();
      }
    } else if (data.t === 'del' || data.t === 'clear') {
      this.#messages = this.#messages.filter((m) =>
        data.t === 'del' ? m.id !== data.id : m.uid !== data.uid,
      );
      this.#relist();
    } else if (data.t === 'mutes') {
      this.#mutes = new Set(Array.isArray(data.uids) ? (data.uids as string[]) : []);
      this.#revision++;
      this.#options.changed();
    } else if (data.t === 'err' || data.t === 'timeout') {
      this.#settle(typeof data.text === 'string' ? data.text : 'Message not sent.');
    } else if (data.t === 'slow') {
      this.#settle('Slow mode: one message a second.');
    }
  }
  async post(text: string) {
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.#uid)
      throw new Error('Chat is connecting. Try again in a moment.');
    text = text.trim();
    if (!text || text.length > CHAT_LIMIT) throw new Error(`Use 1–${CHAT_LIMIT} characters.`);
    if (this.#pending) throw new Error('Wait for your last message to send.');
    const sent = new Promise<void>((resolve, reject) => {
      this.#pending = {
        resolve,
        reject,
        timer: window.setTimeout(() => this.#settle('Message not sent. Try again.'), SEND_TIMEOUT_MS),
      };
    });
    ws.send(JSON.stringify({ t: 'msg', text, nick: site.__nswsChatIdentity?.nickname() ?? '' }));
    return sent;
  }
  mute(speakerId: number, muted: boolean) {
    if (!this.#options.context()?.host) throw new Error('Only the organizer can mute chat.');
    const speaker = [...this.#speakers.values()].find((s) => s.id === speakerId);
    if (!speaker || speaker.uid === this.#uid || this.#ws?.readyState !== WebSocket.OPEN) return;
    this.#ws.send(JSON.stringify({ t: 'cupmute', uid: speaker.uid, on: muted }));
  }
  archive() {
    return { cupId: this.#cupId, lines: structuredClone(this.#lines) };
  }
}
