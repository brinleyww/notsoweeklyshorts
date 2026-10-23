// Car states straight between pages, so other cars can be drawn where they are now (smooth.ts). Every
// page in a cup keeps a WebRTC data channel to every other page, unordered and never resent, and
// carries only car states on it; everything else stays on the mux (transport.js), which also still
// carries every car state, so a page that can't connect this way loses nothing but time.
//
// Addresses: peer connections use TURN relays only (iceTransportPolicy "relay"), so a page never
// gathers or sends its own address, and the room (proxy/src/lobby.js) drops any other candidate.
// Each side sees only the relay's address. The room also says who sent each offer and answer: the
// sender's link to the organizer (0 for the organizer's page), the same number its car states carry
// on the mux, so a page can't pass its states off as another's.
//
// Messages: [u8 kind][f64 car start on the cup clock][u32 player id (the organizer's own car)][body]
//   kind 1: the game's own car update ([1][u32 session][u32 resets][state]), as the mux carries it;
//   kind 2: a pose between those (POSE_MS): [u32 session][u32 resets][u24 frames][f32 speed]
//           [3 f32 position][4 f32 quaternion][f32 steering][u8 controls]. The receiver fills in the
//           rest from that car's last full state (withPose).

const NativePeerConnection = window.RTCPeerConnection;
const HEADER = 13;
const FULL = 1, POSE = 2;
const POSE_BYTES = 8 + 3 + 4 + 12 + 16 + 4 + 1;
// A peer still not connected after this long is dropped and tried again later, each time later.
const CONNECT_MS = 15000;
const GATHER_MS = 4000;
const RETRY_MS = [3000, 10000, 30000, 60000];
const MAX_BUFFERED = 64 * 1024;

function randomHex(bytes) {
    return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

function gathered(pc) {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
        const done = () => {
            clearTimeout(timer);
            pc.removeEventListener("icegatheringstatechange", check);
            resolve();
        };
        const check = () => pc.iceGatheringState === "complete" && done();
        const timer = setTimeout(done, GATHER_MS);
        pc.addEventListener("icegatheringstatechange", check);
    });
}

class Peer {
    constructor(mesh, link, nonce) {
        this.mesh = mesh;
        this.link = link;
        this.nonce = nonce;
        this.since = performance.now();
        this.closed = false;
        this.pc = new NativePeerConnection({ iceServers: mesh.ice, iceTransportPolicy: "relay", bundlePolicy: "max-bundle" });
        this.dc = this.pc.createDataChannel("cars", { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 });
        this.dc.binaryType = "arraybuffer";
        this.dc.onmessage = (e) => mesh.received(this.link, e.data);
        this.pc.onconnectionstatechange = () => {
            const s = this.pc.connectionState;
            if (s === "failed" || s === "closed") mesh.lost(this);
        };
    }

    get open() {
        return !this.closed && this.dc.readyState === "open";
    }

    async offer() {
        await this.pc.setLocalDescription(await this.pc.createOffer());
        await gathered(this.pc);
        if (!this.closed) this.mesh.signal(this.link, { type: "offer", sdp: this.pc.localDescription.sdp, n: this.nonce });
    }

    async answer(sdp) {
        await this.pc.setRemoteDescription({ type: "offer", sdp });
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        await gathered(this.pc);
        if (!this.closed) this.mesh.signal(this.link, { type: "answer", sdp: this.pc.localDescription.sdp, n: this.nonce });
    }

    close() {
        if (this.closed) return;
        this.closed = true;
        try {
            this.pc.close();
        } catch {}
    }
}

export class Mesh {
    // `mux` gives control(), rtcSelf() and rtcCar(); see transport.js.
    constructor(mux) {
        this.mux = mux;
        this.peers = new Map();
        this.retry = new Map();
        // undefined: not asked yet; null: this cup has no relay (or the browser no WebRTC).
        this.ice = NativePeerConnection ? undefined : null;
        this.self = null;
        this.sent = 0;
        this.got = 0;
    }

    get usable() {
        return Array.isArray(this.ice) && this.ice.length > 0;
    }

    // The room's credentials (or that it has none).
    setIce(list) {
        this.ice = Array.isArray(list) && list.length ? list : null;
    }

    askIce() {
        if (this.ice !== undefined || this.asked) return;
        this.asked = true;
        this.mux.control({ t: "rtcIce" });
    }

    signal(to, d) {
        this.mux.control({ t: "rtc", to, d });
    }

    // Every page in the cup but this one: the organizer (0) and every racer's or spectator's link.
    // The page with the lower number calls; a fresh call from a peer replaces what was there.
    tick(wanted) {
        if (!this.usable) return;
        const self = this.mux.rtcSelf();
        if (self !== this.self) {
            this.reset();
            this.self = self;
        }
        if (self == null) return;
        const now = performance.now();
        for (const [link, peer] of this.peers) {
            if (!wanted.has(link)) this.drop(link);
            else if (!peer.open && now - peer.since > CONNECT_MS) this.lost(peer);
        }
        for (const link of wanted) {
            if (link === self || this.peers.has(link) || self > link) continue;
            const r = this.retry.get(link);
            if (r && now < r.at) continue;
            this.call(link);
        }
    }

    call(link) {
        const peer = new Peer(this, link, randomHex(8));
        this.peers.set(link, peer);
        peer.offer().catch(() => this.lost(peer));
    }

    // An offer or answer the room passed on, from page `from`.
    async signalled(from, d) {
        if (!this.usable || !d) return;
        const self = this.mux.rtcSelf();
        if (self !== this.self) {
            this.reset();
            this.self = self;
        }
        if (self == null) return;
        if (d.type === "offer") {
            this.drop(from);
            const peer = new Peer(this, from, d.n);
            this.peers.set(from, peer);
            peer.answer(d.sdp).catch(() => this.lost(peer));
        } else if (d.type === "answer") {
            const peer = this.peers.get(from);
            if (!peer || peer.nonce !== d.n || peer.pc.signalingState !== "have-local-offer") return;
            peer.pc.setRemoteDescription({ type: "answer", sdp: d.sdp }).catch(() => this.lost(peer));
        }
    }

    lost(peer) {
        if (this.peers.get(peer.link) !== peer) return peer.close();
        this.drop(peer.link);
        const r = this.retry.get(peer.link) ?? { n: 0, at: 0 };
        r.at = performance.now() + RETRY_MS[Math.min(r.n++, RETRY_MS.length - 1)];
        this.retry.set(peer.link, r);
    }

    drop(link) {
        this.peers.get(link)?.close();
        this.peers.delete(link);
    }

    reset() {
        for (const link of [...this.peers.keys()]) this.drop(link);
        this.retry.clear();
    }

    get openCount() {
        let n = 0;
        for (const p of this.peers.values()) if (p.open) n++;
        return n;
    }

    send(kind, start, pid, body) {
        if (!this.peers.size) return;
        const out = new Uint8Array(HEADER + body.length);
        const view = new DataView(out.buffer);
        out[0] = kind;
        view.setFloat64(1, Number.isFinite(start) ? start : NaN, true);
        view.setUint32(9, pid >>> 0, true);
        out.set(body, HEADER);
        for (const p of this.peers.values()) {
            if (!p.open || p.dc.bufferedAmount > MAX_BUFFERED) continue;
            try {
                p.dc.send(out);
                this.sent++;
            } catch {}
        }
    }

    sendFull(start, pid, game) {
        this.send(FULL, start, pid, game);
    }

    // `head` is the 8 bytes of session and resets of this car's last full state.
    sendPose(start, pid, head, s) {
        const body = new Uint8Array(POSE_BYTES);
        const v = new DataView(body.buffer);
        body.set(head, 0);
        body[8] = s.frames & 255;
        body[9] = (s.frames >> 8) & 255;
        body[10] = (s.frames >> 16) & 255;
        v.setFloat32(11, s.speedKmh, true);
        v.setFloat32(15, s.position.x, true);
        v.setFloat32(19, s.position.y, true);
        v.setFloat32(23, s.position.z, true);
        v.setFloat32(27, s.quaternion.x, true);
        v.setFloat32(31, s.quaternion.y, true);
        v.setFloat32(35, s.quaternion.z, true);
        v.setFloat32(39, s.quaternion.w, true);
        v.setFloat32(43, s.steering, true);
        const c = s.controls;
        body[47] = (c.up ? 1 : 0) | (c.right ? 2 : 0) | (c.down ? 4 : 0) | (c.left ? 8 : 0) | (c.reset ? 16 : 0) | (s.brakeLightEnabled ? 32 : 0);
        this.send(POSE, start, pid, body);
    }

    received(link, data) {
        if (!(data instanceof ArrayBuffer) || data.byteLength <= HEADER) return;
        const bytes = new Uint8Array(data);
        const view = new DataView(data);
        const kind = bytes[0];
        if (kind !== FULL && kind !== POSE) return;
        this.got++;
        this.mux.rtcCar(link, kind === POSE, view.getFloat64(1, true), view.getUint32(9, true), bytes.subarray(HEADER));
    }
}

// Where the fields after the position sit in a game state (the game's serializer, module 2108).
function layout(s) {
    let o = 3 + 4;
    const flags = s[o];
    o += 1 + (flags & 2 ? 3 : 0) + 2;
    const pos = o;
    o += 12 + 16;
    const imp = o;
    o += 1 + 4 * s[imp];
    const wheels = o;
    let n = 0;
    for (let b = 3; b <= 6; b++) if (flags & (1 << b)) n++;
    return { flags, pos, imp, wheels, n, tail: wheels + 24 * n };
}

// A full car update ([1][u32 session][u32 resets][state]) made from `full` (that car's last one, same
// session and resets) moved to a pose: no hits, wheel contacts carried along with the car.
export function withPose(full, pose) {
    const s = full.subarray(9);
    const L = layout(s);
    const extra = s.length - L.tail;
    if (extra !== 69) return null;
    const out = new Uint8Array(9 + s.length - 4 * s[L.imp]);
    out.set(full.subarray(0, 9));
    const o = out.subarray(9);
    const pv = new DataView(pose.buffer, pose.byteOffset, pose.byteLength);
    const sv = new DataView(s.buffer, s.byteOffset, s.byteLength);
    o.set(pose.subarray(8, 11), 0);
    o.set(pose.subarray(11, 15), 3);
    o.set(s.subarray(7, L.pos), 7);
    o.set(pose.subarray(15, 43), L.pos);
    o[L.imp] = 0;
    const ov = new DataView(o.buffer, o.byteOffset, o.byteLength);
    const dx = pv.getFloat32(15, true) - sv.getFloat32(L.pos, true);
    const dy = pv.getFloat32(19, true) - sv.getFloat32(L.pos + 4, true);
    const dz = pv.getFloat32(23, true) - sv.getFloat32(L.pos + 8, true);
    let w = L.imp + 1;
    o.set(s.subarray(L.wheels, s.length), w);
    for (let i = 0; i < L.n; i++, w += 24) {
        ov.setFloat32(w, ov.getFloat32(w, true) + dx, true);
        ov.setFloat32(w + 4, ov.getFloat32(w + 4, true) + dy, true);
        ov.setFloat32(w + 8, ov.getFloat32(w + 8, true) + dz, true);
    }
    // Steering, then controls and brake light.
    o.set(pose.subarray(43, 48), o.length - 5);
    return out;
}

// Session, resets and frames of a full car update, as one key.
export function carKey(game) {
    return (game[1] | game[2] << 8 | game[3] << 16 | game[4] << 24) + ":" + (game[5] | game[6] << 8 | game[7] << 16 | game[8] << 24) + ":" + (game[9] | game[10] << 8 | game[11] << 16);
}

export function poseKey(pose) {
    return (pose[0] | pose[1] << 8 | pose[2] << 16 | pose[3] << 24) + ":" + (pose[4] | pose[5] << 8 | pose[6] << 16 | pose[7] << 24) + ":" + (pose[8] | pose[9] << 8 | pose[10] << 16);
}
