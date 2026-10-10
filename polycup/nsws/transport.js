// Stands in for WebRTC. The game's multiplayer (and PolyCup on top of it) builds RTCPeerConnections
// and data channels; these do the same job through the proxy (proxy/src/lobby.js): every page keeps
// one "mux" WebSocket per cup code, and every data channel message rides on it.
//
// Cloudflare bills each incoming WebSocket message, so nothing is sent per message: everything
// queued within FLUSH_MS goes out as one binary frame of records
// [u32 link][u16 channel][u8 kind][u32 length][bytes] (kind 0 = text, 1 = binary).

const FLUSH_MS = 200;
// Past this much queued, flush at once (track transfers) instead of waiting for the timer.
const FLUSH_BYTES = 256 * 1024;
const MAX_EARLY = 64;
const IDLE_CLOSE_MS = 5000;
const PAIR_SDP = /^nsws:([A-HJ-NP-Z2-9]{5}\.[0-9a-f]{16})$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function socketBase() {
    return String(window.__nswsApiBase || "").replace(/^http/, "ws");
}

function randomHex(bytes) {
    return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

function fire(target, type, init) {
    const event = type === "message" ? new MessageEvent("message", init) : new Event(type);
    // The game's onicecandidate handler reads event.candidate; null marks the end of candidates.
    if (type === "icecandidate") Object.defineProperty(event, "candidate", { value: null });
    try {
        target["on" + type]?.call(target, event);
    } catch (error) {
        console.error(error);
    }
    target.dispatchEvent(event);
}

const muxes = new Map();

class Mux {
    constructor(code) {
        this.code = code;
        this.pcs = new Map();
        this.links = new Map();
        this.queue = [];
        this.bytes = 0;
        this.timer = 0;
        this.controls = [];
        this.closeTimer = 0;
        this.ws = new WebSocket(socketBase() + "nsws/cup/mux?code=" + code);
        this.ws.binaryType = "arraybuffer";
        this.ws.addEventListener("open", () => {
            for (const c of this.controls.splice(0)) this.ws.send(c);
            if (this.queue.length) this.flush();
        });
        this.ws.addEventListener("message", (e) => this.receive(e.data));
        this.ws.addEventListener("close", () => this.closed());
    }

    control(data) {
        const text = JSON.stringify(data);
        if (this.ws.readyState === WebSocket.OPEN) this.ws.send(text);
        else if (this.ws.readyState === WebSocket.CONNECTING) this.controls.push(text);
    }

    register(pc) {
        clearTimeout(this.closeTimer);
        this.pcs.set(pc.pair, pc);
        this.control({ t: "open", pair: pc.pair, side: pc.side });
    }

    unregister(pc) {
        if (this.pcs.get(pc.pair) !== pc) return;
        this.pcs.delete(pc.pair);
        if (pc.link) this.links.delete(pc.link);
        this.control({ t: "close", pair: pc.pair });
        if (!this.pcs.size) {
            this.closeTimer = setTimeout(() => {
                if (!this.pcs.size) this.ws.close();
            }, IDLE_CLOSE_MS);
        }
    }

    enqueue(link, channel, kind, bytes) {
        this.queue.push({ link, channel, kind, bytes });
        this.bytes += bytes.length + 11;
        if (this.bytes >= FLUSH_BYTES) this.flush();
        else if (!this.timer) this.timer = setTimeout(() => this.flush(), FLUSH_MS);
    }

    flush() {
        clearTimeout(this.timer);
        this.timer = 0;
        if (!this.queue.length || this.ws.readyState !== WebSocket.OPEN) return;
        const frame = new Uint8Array(this.bytes);
        const view = new DataView(frame.buffer);
        let at = 0;
        for (const r of this.queue) {
            view.setUint32(at, r.link, true);
            view.setUint16(at + 4, r.channel, true);
            frame[at + 6] = r.kind;
            view.setUint32(at + 7, r.bytes.length, true);
            frame.set(r.bytes, at + 11);
            at += 11 + r.bytes.length;
        }
        this.queue.length = 0;
        this.bytes = 0;
        try {
            this.ws.send(frame);
        } catch {}
    }

    receive(data) {
        if (typeof data === "string") {
            let m;
            try {
                m = JSON.parse(data);
            } catch {
                return;
            }
            const pc = this.pcs.get(m?.pair);
            if (!pc) return;
            if (m.t === "up") {
                this.links.set(m.link, pc);
                pc._up(m.link);
            } else if (m.t === "down") {
                if (pc.link) this.links.delete(pc.link);
                pc._down();
            }
            return;
        }
        const frame = new Uint8Array(data);
        const view = new DataView(data);
        let at = 0;
        while (at + 11 <= frame.length) {
            const link = view.getUint32(at, true);
            const channel = view.getUint16(at + 4, true);
            const kind = frame[at + 6];
            const length = view.getUint32(at + 7, true);
            const end = at + 11 + length;
            if (end > frame.length) break;
            this.links.get(link)?._deliver(channel, kind, frame.subarray(at + 11, end));
            at = end;
        }
    }

    closed() {
        clearTimeout(this.timer);
        muxes.delete(this.code);
        for (const pc of [...this.pcs.values()]) pc._down();
        this.pcs.clear();
        this.links.clear();
    }
}

function muxFor(code) {
    let mux = muxes.get(code);
    if (!mux || mux.ws.readyState > WebSocket.OPEN) muxes.set(code, mux = new Mux(code));
    return mux;
}

export class NswsDataChannel extends EventTarget {
    constructor(pc, label, options) {
        super();
        this._pc = pc;
        this.label = label;
        this.id = options.id;
        this.negotiated = !!options.negotiated;
        this.ordered = options.ordered !== false;
        this.maxRetransmits = options.maxRetransmits ?? null;
        this.protocol = "";
        this.binaryType = "blob";
        this.readyState = "connecting";
        this.bufferedAmountLowThreshold = 0;
        this.onopen = this.onclose = this.onmessage = this.onerror = this.onclosing = this.onbufferedamountlow = null;
    }

    get bufferedAmount() {
        return this._pc._mux?.bytes ?? 0;
    }

    send(data) {
        if (this.readyState !== "open") throw new DOMException("Data channel is not open", "InvalidStateError");
        let kind = 1;
        let bytes;
        if (typeof data === "string") {
            kind = 0;
            bytes = encoder.encode(data);
        } else if (data instanceof ArrayBuffer) {
            bytes = new Uint8Array(data.slice(0));
        } else if (ArrayBuffer.isView(data)) {
            bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
        } else {
            throw new TypeError("Unsupported data channel payload");
        }
        this._pc._mux.enqueue(this._pc.link, this.id, kind, bytes);
    }

    close() {
        this._close();
    }

    _open() {
        if (this.readyState !== "connecting") return;
        this.readyState = "open";
        fire(this, "open");
    }

    _close() {
        if (this.readyState === "closed") return;
        this.readyState = "closed";
        setTimeout(() => fire(this, "close"), 0);
    }

    _deliver(kind, bytes) {
        if (this.readyState !== "open") return;
        const data = kind === 0 ? decoder.decode(bytes) : bytes.slice().buffer;
        fire(this, "message", { data });
    }
}

export class NswsPeerConnection extends EventTarget {
    constructor() {
        super();
        this.connectionState = "new";
        this.iceConnectionState = "new";
        this.iceGatheringState = "new";
        this.signalingState = "stable";
        this.localDescription = null;
        this.remoteDescription = null;
        this.onicecandidate = this.onconnectionstatechange = this.oniceconnectionstatechange = null;
        this.ondatachannel = this.onicegatheringstatechange = this.onsignalingstatechange = this.onnegotiationneeded = null;
        this.pair = null;
        this.side = null;
        this.link = 0;
        this._mux = null;
        this._channels = new Map();
        this._early = new Map();
        this._closed = false;
        this._nextChannel = 2;
    }

    createDataChannel(label, options = {}) {
        if (this._closed) throw new DOMException("Peer connection is closed", "InvalidStateError");
        const id = Number.isInteger(options.id) ? options.id : this._nextChannel++;
        const channel = new NswsDataChannel(this, label, { ...options, id });
        this._channels.set(id, channel);
        if (this.link) {
            queueMicrotask(() => {
                channel._open();
                for (const [kind, bytes] of this._early.get(id) ?? []) channel._deliver(kind, bytes);
                this._early.delete(id);
            });
        }
        return channel;
    }

    async createOffer() {
        const code = String(window.__nswsCupJoinCode || "");
        this.pair = code + "." + randomHex(8);
        this.side = "client";
        return { type: "offer", sdp: "nsws:" + this.pair };
    }

    async createAnswer() {
        return { type: "answer", sdp: "nsws:" + this.pair };
    }

    async setLocalDescription(description) {
        this.localDescription = description;
        this.iceGatheringState = "complete";
        // No real candidates exist; the end-of-candidates marker lets the game's handshake finish.
        setTimeout(() => {
            if (!this._closed) fire(this, "icecandidate", undefined);
        }, 0);
    }

    async setRemoteDescription(description) {
        const match = PAIR_SDP.exec(description?.sdp ?? "");
        if (!match) throw new DOMException("Unsupported session description", "InvalidAccessError");
        this.remoteDescription = description;
        if (description.type === "offer") {
            this.pair = match[1];
            this.side = "host";
        } else if (match[1] !== this.pair) {
            throw new DOMException("Answer does not match the offer", "InvalidAccessError");
        }
        if (!this._mux && !this._closed) {
            this._mux = muxFor(this.pair.slice(0, 5));
            this._mux.register(this);
            this._state("connecting");
        }
    }

    addIceCandidate() {
        return Promise.resolve();
    }

    getStats() {
        return Promise.resolve(new Map());
    }

    close() {
        if (this._closed) return;
        this._closed = true;
        this.connectionState = "closed";
        this.iceConnectionState = "closed";
        this.signalingState = "closed";
        this._mux?.unregister(this);
        for (const channel of this._channels.values()) channel._close();
    }

    _state(state) {
        if (this.connectionState === state) return;
        this.connectionState = state;
        this.iceConnectionState = state === "connecting" ? "checking" : state;
        fire(this, "iceconnectionstatechange");
        fire(this, "connectionstatechange");
    }

    _up(link) {
        if (this._closed) return;
        this.link = link;
        this._state("connected");
        for (const channel of this._channels.values()) channel._open();
    }

    _down() {
        if (this._closed) return;
        this.link = 0;
        this._state("failed");
        for (const channel of this._channels.values()) channel._close();
    }

    _deliver(channelId, kind, bytes) {
        const channel = this._channels.get(channelId);
        if (channel) return channel._deliver(kind, bytes);
        let early = this._early.get(channelId);
        if (!early) this._early.set(channelId, early = []);
        if (early.length < MAX_EARLY) early.push([kind, bytes.slice()]);
    }
}

export function installTransport() {
    window.__nswsPeerConnection = NswsPeerConnection;
}
