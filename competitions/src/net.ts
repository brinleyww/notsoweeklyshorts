// Cup messages ride a channel of their own on the game's multiplayer connections (which the proxy
// relays, see transport.js). The game's own channels are 0 and 1.
import type { Native, Connection } from './game.ts';
import { site } from './game.ts';
import type { Msg } from './protocol.ts';

const CHANNEL = 40;
const MAX_TEXT = 120_000;
const MAX_PER_SECOND = 40;

interface Link {
  id: number;
  channel: RTCDataChannel;
  windowAt: number;
  count: number;
}

export class Net {
  #links = new Map<RTCPeerConnection, Link>();
  #byId = new Map<number, RTCDataChannel>();
  constructor(
    private onMessage: (from: number, m: Msg) => void,
    private onChange: () => void,
  ) {}

  sync(native: Native, connection: Connection) {
    const peers = native.peers(connection);
    const live = new Set(peers.map((p) => p.pc));
    for (const [pc, link] of this.#links)
      if (!live.has(pc)) {
        link.channel.close();
        this.#links.delete(pc);
        if (this.#byId.get(link.id) === link.channel) this.#byId.delete(link.id);
        this.onChange();
      }
    for (const { id, pc } of peers) {
      if (this.#links.has(pc) || pc.connectionState === 'closed') continue;
      const channel = pc.createDataChannel('nsws-sc', { negotiated: true, id: CHANNEL, ordered: true });
      const link: Link = { id, channel, windowAt: 0, count: 0 };
      this.#links.set(pc, link);
      this.#byId.set(id, channel);
      channel.onopen = channel.onclose = () => this.onChange();
      channel.onmessage = (e) => this.#receive(link, e.data);
    }
  }

  #receive(link: Link, data: unknown) {
    if (typeof data !== 'string' || data.length > MAX_TEXT) return;
    const now = performance.now();
    if (now - link.windowAt > 1000) {
      link.windowAt = now;
      link.count = 0;
    }
    // The organizer's link (id 0 on everyone else's page) is trusted; a resumed batch can be long.
    if (++link.count > MAX_PER_SECOND && link.id !== 0) return;
    let m: Msg;
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    if (!m || typeof m !== 'object' || typeof (m as { k?: unknown }).k !== 'string') return;
    try {
      this.onMessage(link.id, m);
    } catch (error) {
      console.error('[Cuppa]', error);
    }
  }

  open(id: number) {
    return this.#byId.get(id)?.readyState === 'open';
  }

  send(id: number, m: Msg, urgent = false) {
    const channel = this.#byId.get(id);
    if (channel?.readyState !== 'open') return false;
    const text = JSON.stringify(m);
    if (text.length > MAX_TEXT) return false;
    try {
      channel.send(text);
    } catch {
      return false;
    }
    if (urgent) site.__nswsMuxFlush?.();
    return true;
  }

  ids() {
    return [...this.#byId.keys()];
  }

  dispose() {
    for (const link of this.#links.values()) link.channel.close();
    this.#links.clear();
    this.#byId.clear();
  }
}
