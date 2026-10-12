// Cup chat on the site's universal chat server (proxy/src/chat.js): a room of its own per cup
// code, plus the main chat as a second tab that only connects once opened. Same filter, slow
// mode and timeouts as everywhere else; the organizer can mute people in the cup room.
import { site } from './game.ts';

export const CHAT_MAX = 200;
const KEEPALIVE_MS = 30_000;
const RETRY_MS = 3_000;
const KEEP = 300;

export interface ChatMessage {
  id: number;
  at: number;
  uid: string;
  nick: string;
  text: string;
}

class Room {
  messages: ChatMessage[] = [];
  mutes = new Set<string>();
  uid: string | null = null;
  status: 'off' | 'connecting' | 'on' = 'off';
  unread = 0;
  #ws: WebSocket | null = null;
  #key = '';
  #retryAt = 0;
  #fails = 0;
  #keepAlive = 0;
  #waiting: { resolve(): void; reject(e: Error): void; timer: number } | null = null;

  constructor(private changed: () => void) {}

  sync(key: string, query: string, secret: string | null) {
    if (key !== this.#key) {
      this.#close();
      this.#key = key;
      this.messages = [];
      this.unread = 0;
      this.#retryAt = 0;
    }
    if (key && !this.#ws && Date.now() >= this.#retryAt) this.#open(query, secret);
  }

  #open(query: string, secret: string | null) {
    const id = site.__nswsChatIdentity;
    if (!id || !site.__nswsApiBase) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(site.__nswsApiBase.replace(/^http/, 'ws') + 'nsws/chat' + query);
    } catch {
      this.#retryAt = Date.now() + RETRY_MS;
      return;
    }
    this.#ws = ws;
    this.status = 'connecting';
    ws.onopen = async () => {
      const hello: Record<string, string> = { t: 'hello', v: id.visitorId(), nick: id.nickname() };
      const owner = await id.ownerKey().catch(() => null);
      if (owner) hello.key = owner;
      if (secret) hello.host = secret;
      if (this.#ws !== ws) return;
      ws.send(JSON.stringify(hello));
      this.#keepAlive = window.setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('ping'), KEEPALIVE_MS);
    };
    ws.onmessage = (e) => {
      if (this.#ws !== ws || e.data === 'pong') return;
      try {
        this.#server(JSON.parse(e.data));
      } catch {}
    };
    ws.onclose = () => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.uid = null;
      this.status = 'off';
      clearInterval(this.#keepAlive);
      this.#retryAt = Date.now() + Math.min(30_000, RETRY_MS * 2 ** this.#fails++);
      this.#settle('Chat disconnected. Try again in a moment.');
      this.changed();
    };
  }

  #close() {
    const ws = this.#ws;
    this.#ws = null;
    this.uid = null;
    this.status = 'off';
    clearInterval(this.#keepAlive);
    this.#settle('The chat closed.');
    try {
      ws?.close();
    } catch {}
  }

  #settle(error?: string) {
    const w = this.#waiting;
    if (!w) return;
    this.#waiting = null;
    clearTimeout(w.timer);
    if (error) w.reject(new Error(error));
    else w.resolve();
  }

  #valid(m: ChatMessage) {
    return !!m && typeof m.text === 'string' && typeof m.uid === 'string' && typeof m.nick === 'string';
  }

  #server(d: { t?: string; [k: string]: unknown }) {
    if (d.t === 'init') {
      this.#fails = 0;
      this.uid = (d.you as { uid?: string } | undefined)?.uid ?? null;
      this.status = 'on';
      this.mutes = new Set(Array.isArray(d.mutes) ? (d.mutes as string[]) : []);
      this.messages = (Array.isArray(d.messages) ? (d.messages as ChatMessage[]) : []).filter((m) => this.#valid(m)).slice(-KEEP);
    } else if (d.t === 'msg') {
      const m = d.m as ChatMessage;
      if (!this.#valid(m)) return;
      this.messages.push(m);
      if (this.messages.length > KEEP) this.messages.splice(0, this.messages.length - KEEP);
      if (m.uid === this.uid) this.#settle();
      else this.unread++;
    } else if (d.t === 'edit') {
      const m = this.messages.find((x) => x.id === d.id);
      if (m && typeof d.text === 'string') m.text = d.text;
    } else if (d.t === 'del') this.messages = this.messages.filter((m) => m.id !== d.id);
    else if (d.t === 'clear') this.messages = this.messages.filter((m) => m.uid !== d.uid);
    else if (d.t === 'mutes') this.mutes = new Set(Array.isArray(d.uids) ? (d.uids as string[]) : []);
    else if (d.t === 'err' || d.t === 'timeout') this.#settle(typeof d.text === 'string' ? d.text : 'Message not sent.');
    else if (d.t === 'slow') this.#settle('Slow mode: one message a second.');
    else return;
    this.changed();
  }

  post(text: string) {
    const ws = this.#ws;
    text = text.trim();
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.uid) return Promise.reject(new Error('Chat is connecting. Try again in a moment.'));
    if (!text || text.length > CHAT_MAX) return Promise.reject(new Error(`Use 1 to ${CHAT_MAX} characters.`));
    if (this.#waiting) return Promise.reject(new Error('Wait for your last message to send.'));
    const sent = new Promise<void>((resolve, reject) => {
      this.#waiting = { resolve, reject, timer: window.setTimeout(() => this.#settle('Message not sent. Try again.'), 8000) };
    });
    ws.send(JSON.stringify({ t: 'msg', text, nick: site.__nswsChatIdentity?.nickname() ?? '' }));
    return sent;
  }

  mute(uid: string, on: boolean) {
    if (uid !== this.uid && this.#ws?.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify({ t: 'cupmute', uid, on }));
  }

  get muted() {
    return !!this.uid && this.mutes.has(this.uid);
  }
}

// What the main chat (mod/nsws_chat.js) lends Cuppa: its messages and its connection.
interface MainFeed {
  active(): boolean;
  uid(): string | null;
  recent(): ChatMessage[];
  subscribe(fn: (m: ChatMessage) => void): () => void;
  post(text: string): Promise<void>;
}
const mainChat = () => (window as unknown as { __nswsChat?: { feed?: MainFeed; setTucked?(on: boolean): void; setEnabled?(on: boolean): void } }).__nswsChat;

export type ChatTarget = 'cup' | 'all';
export interface ChatLine {
  key: string;
  room: ChatTarget;
  m: ChatMessage;
}

// Two tabs in a cup: the cup's own room, and everyone online through the main chat (its messages and
// its connection, when the player has it on). The main chat's window steps aside meanwhile.
export class CupChat {
  cup: Room;
  target: ChatTarget = 'cup';
  #unsubscribe: (() => void) | null = null;
  unreadAll = 0;
  constructor(private o: { context: () => { cupId: string; host: boolean } | null; changed: () => void }) {
    this.cup = new Room(o.changed);
  }
  get isHost() {
    return !!this.o.context()?.host;
  }
  get mainOn() {
    return !!mainChat()?.feed?.active();
  }
  turnMainOn() {
    mainChat()?.setEnabled?.(true);
    this.o.changed();
  }
  messages(room: ChatTarget): ChatMessage[] {
    if (room === 'cup') return this.cup.messages;
    return this.mainOn ? (mainChat()?.feed?.recent() ?? []) : [];
  }
  // The open tab's messages.
  lines(limit = 300): ChatLine[] {
    const room = this.target;
    return this.messages(room)
      .slice(-limit)
      .map((m) => ({ key: room + m.id, room, m }));
  }
  setTarget(target: ChatTarget) {
    this.target = target;
    this.o.changed();
  }
  post(text: string) {
    if (this.target === 'cup') return this.cup.post(text);
    if (!this.mainOn) return Promise.reject(new Error('Turn the main chat on to talk to everyone.'));
    return mainChat()!.feed!.post(text);
  }
  tick() {
    const context = this.o.context();
    const room = context ? (site.__nswsCupRoom?.() ?? null) : null;
    this.cup.sync(room ? room.code : '', room ? '?cup=' + encodeURIComponent(room.code) : '', room?.secret ?? null);
    const feed = mainChat()?.feed;
    if (room && feed && !this.#unsubscribe) {
      this.#unsubscribe = feed.subscribe((m) => {
        if (m.uid !== feed.uid()) this.unreadAll++;
        this.o.changed();
      });
      mainChat()?.setTucked?.(true);
      this.o.changed();
    } else if (!room && this.#unsubscribe) {
      this.#unsubscribe();
      this.#unsubscribe = null;
      this.target = 'cup';
      mainChat()?.setTucked?.(false);
    }
  }
}
