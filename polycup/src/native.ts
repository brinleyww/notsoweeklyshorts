import type { Controller } from './controller.ts';
import type { NativeApi, PolyModLoader } from './game-types.ts';
import type { Message } from './protocol.ts';
import { renderCarPose } from './spectator.ts';
import { profileIdentity } from './reconnect.ts';
import type { NativeGame } from './game-types.ts';

export function watchGameSessions<T>(
  sessions: WeakMap<NativeGame, T>,
  created: (game: NativeGame) => void,
) {
  const set = sessions.set;
  sessions.set = function (game, session) {
    const result = set.call(this, game, session);
    // Session fields are assigned during construction; wait until the car and HUD exist.
    if (session) queueMicrotask(() => created(game));
    return result;
  };
}

export function beforeGameRender(
  renderer: { update: (...args: unknown[]) => unknown },
  prepare: () => void,
  update: () => unknown,
) {
  const descriptor = Object.getOwnPropertyDescriptor(renderer, 'update'),
    original = renderer.update;
  renderer.update = function (...args) {
    prepare();
    return original.apply(this, args);
  };
  try {
    return update();
  } finally {
    if (descriptor) Object.defineProperty(renderer, 'update', descriptor);
    else Reflect.deleteProperty(renderer, 'update');
  }
}

// Not So Weekly Shorts: this build is a deobfuscated 0.6.0 game without PolyModLoader, so the
// version-specific access below comes from window.__nswsCup, which main.bundle.js builds on its own
// private fields (cupNative there). Nothing patches the game's source at load time.
export function connectNative(_pml: PolyModLoader, controller: Controller) {
  const bridge = (window as unknown as { __nswsCup?: { native(): NativeApi } }).__nswsCup;
  if (!bridge) throw new Error('Competitions need the game to finish loading first.');
  const api = bridge.native();
  api.reconnectIdentity = (game, cupId) =>
    profileIdentity(api.records(game).profiles.getCurrentUserProfile().token, cupId);
  for (const key of [
    'Host',
    'Client',
    'Game',
    'read',
    'peers',
    'parse',
    'reset',
    'guard',
  ] as const) {
    if (typeof api[key] !== 'function')
      throw new Error(`Unsupported game build: ${key} is unavailable.`);
  }
  const onlinePB = new Map<
    string,
    { until: number; value: Promise<{ ok: boolean; frames: number | null }> }
  >();
  const verified = (id: string) =>
    !!(api.trackLibrary?.isOfficialTrack(id) || api.trackLibrary?.isCommunityTrack(id));
  api.personalBest = async (game, id) => {
    const { server, profiles, store } = api.records(game);
    const profile = profiles.getCurrentUserProfile(),
      slot = profiles.profileSlot;
    // Use the game's own identity locally; only the time and its source leave this client.
    const key = `${slot}:${profile.tokenHash}:${id}`,
      cached = onlinePB.get(key);
    if (!cached || cached.until < Date.now()) {
      onlinePB.set(key, {
        until: Date.now() + 60000,
        value: server
          .getLeaderboardUserEntry(profile.tokenHash, id, verified(id))
          .then((record) => ({ ok: true, frames: record?.time?.numberOfFrames ?? null }))
          .catch(() => ({ ok: false, frames: null })),
      });
    }
    const online = await onlinePB.get(key)!.value;
    const local = store.getRecordTime(slot, id)?.numberOfFrames ?? null;
    if (online.frames !== null && (local === null || online.frames <= local))
      return { status: 'ready', frames: online.frames, source: 'online' };
    if (local !== null) return { status: 'ready', frames: local, source: 'profile' };
    return { status: online.ok ? 'missing' : 'unavailable' };
  };
  api.worldRecord = async (game, id) => {
    const { server, profiles } = api.records(game);
    try {
      const data = await server.getLeaderboard(
        profiles.getCurrentUserProfile().tokenHash,
        id,
        0,
        1,
        verified(id),
      );
      const best = data.entries[0];
      return best
        ? {
            status: 'ready',
            frames: best.frames.numberOfFrames,
            name: String(best.nickname).slice(0, 64),
            ...(best.countryCode ? { countryCode: best.countryCode } : {}),
          }
        : { status: 'missing' };
    } catch {
      return { status: 'unavailable' };
    }
  };
  const follow = api.follow;
  api.follow = (game, pose, id) => {
    follow(game, pose, id);
    renderCarPose(api.remoteCar(game, id), pose);
  };
  const original = api.Game.prototype.update;
  api.Game.prototype.update = function (...args) {
    controller.observeGame(this);
    // Game.update draws the frame itself. Apply visibility and the buffered POV
    // after native car updates, but before that draw can consume their transforms.
    return beforeGameRender(
      api.renderer(this),
      () => controller.beforeRender(this),
      () => original.apply(this, args),
    );
  };
  const dispose = api.Game.prototype.dispose;
  api.Game.prototype.dispose = function (...args) {
    controller.rememberDrivingView(this);
    const result = dispose.apply(this, args);
    controller.gameDisposed(this);
    return result;
  };
  for (const Connection of [api.Host, api.Client]) {
    const disposeConnection = Connection.prototype.dispose;
    if (!disposeConnection) continue;
    Connection.prototype.dispose = function () {
      controller.connectionDisposed(this);
      return disposeConnection.call(this);
    };
  }
  api.guard((game) => controller.shouldBlock(game));
  api.guardRestart((game) => controller.handleRestart(game));
  return api;
}

// A dedicated, negotiated channel shares the game's existing WebRTC peer connection.
// Never place new messages on PolyTrack's binary channels 0 and 1.
export class CupTransport {
  #onMessage: (id: number, message: Message) => void;
  #onChange: () => void;
  #channels: Map<number, RTCDataChannel> = new Map();
  #peers: Map<
    RTCPeerConnection,
    { id: number; channel: RTCDataChannel; windowAt: number; count: number }
  > = new Map();
  #channelId: number;
  #realtime: boolean;

  constructor(
    onMessage: (id: number, message: Message) => void,
    onChange: () => void,
    { channelId = 42, realtime = false } = {},
  ) {
    this.#onMessage = onMessage;
    this.#onChange = onChange;

    this.#channelId = channelId;
    this.#realtime = realtime;
  }
  sync(peers: { id: number; pc: RTCPeerConnection }[]) {
    const pcs = new Set(peers.map((p) => p.pc));
    for (const [pc, entry] of this.#peers)
      if (!pcs.has(pc)) {
        entry.channel.close();
        this.#peers.delete(pc);
        this.#channels.delete(entry.id);
        this.#onChange();
      }
    for (const { id, pc } of peers)
      if (!this.#peers.has(pc) && pc.connectionState !== 'closed') {
        const channel = pc.createDataChannel(
          `polytrack-world-cup-${this.#channelId}`,
          this.#realtime
            ? { negotiated: true, id: this.#channelId, ordered: false, maxRetransmits: 0 }
            : { negotiated: true, id: this.#channelId, ordered: true },
        );
        const entry = { id, channel, windowAt: performance.now(), count: 0 };
        this.#peers.set(pc, entry);
        this.#channels.set(id, channel);
        channel.onopen = () => this.#onChange();
        channel.onclose = () => this.#onChange();
        channel.onerror = () => this.#onChange();
        channel.onmessage = (event) => {
          if (typeof event.data !== 'string' || event.data.length > (this.#realtime ? 2000 : 60000))
            return;
          const now = performance.now();
          if (now - entry.windowAt > 1000) {
            entry.windowAt = now;
            entry.count = 0;
          }
          // A spectator handoff temporarily carries two camera streams at 20 Hz each.
          if (++entry.count > (this.#realtime ? 60 : 35)) return;
          try {
            const candidate: unknown = JSON.parse(event.data);
            if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return;
            const message = candidate as Message & { protocol?: number };
            if (!message || message.protocol !== 1 || typeof message.type !== 'string') return;
            this.#onMessage(id, message); // Native peer ID, never an ID supplied by a client.
          } catch (error) {
            console.warn('[PolyCup] Rejected peer message:', String(error));
          }
        };
      }
  }
  send(id: number, message: Message) {
    const channel = this.#channels.get(id);
    if (channel?.readyState !== 'open' || channel.bufferedAmount > 256000) return false;
    const text = JSON.stringify({ ...message, protocol: 1 });
    if (text.length > 60000)
      throw new Error('Tournament update exceeds the network message limit.');
    try {
      channel.send(text);
      return true;
    } catch {
      return false;
    }
  }
  broadcast(message: Message) {
    for (const id of this.#channels.keys()) this.send(id, message);
  }
  has(id: number) {
    return this.#channels.get(id)?.readyState === 'open';
  }
  dispose() {
    for (const entry of this.#peers.values()) entry.channel.close();
    this.#peers.clear();
    this.#channels.clear();
  }
}
