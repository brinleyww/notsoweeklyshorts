// Stands in for WebRTC. The game's multiplayer (and the cup on top of it) builds RTCPeerConnections
// and data channels; these do the same job through the proxy (proxy/src/lobby.js): every page keeps
// one "mux" WebSocket per cup code, and every data channel message rides on it.
//
// Cloudflare bills each incoming WebSocket message, so nothing is sent per message: everything
// queued within the pace goes out as one binary frame of records
// [u32 link][u16 channel][u8 kind][u32 length][bytes] (kind 0 = text, 1 = binary).
// The pace is 200 ms while this page drives (or organizes a live round) and longer otherwise;
// the cup sets window.__nswsMuxPace, and window.__nswsMuxFlush() sends at once (a click, a finish).
// A racer's batch goes the moment its car state that closes the pace is queued (the game samples
// one every 50 ms, so the fifth at 200 ms: a batch every 250 ms), not on a timer that races it.
// On a network that blocks WebSockets the socket is mod/nsws_socket.js's HTTPS fallback; while that
// sends one POST per batch, it sets window.__nswsMuxMinPace so batches go out a little less often.
//
// Records can be lost when a socket drops, and a proxy deploy drops every socket at once. So each
// connection counts the records it got and keeps the last LOG_BYTES it sent. A page back on a new
// socket re-links its pairs (`rejoin`), the proxy gives each end the other's count with the new
// link (`up`), and each end resends from there. A restarted proxy knows nothing, so both ends
// re-link from their own pages.
//
// Car states also go straight between pages over WebRTC (rtc.js) the moment they are made, with a
// pose in between (main.bundle.js); whichever copy of a state comes first reaches the game, the other
// is dropped (Mux.#firstSeen). The mux copies still go, so nothing depends on WebRTC working.

import { Mesh, carKey, poseKey, withPose } from "./rtc.js";

const FLUSH_MS = 200;
// Bumper cars send every 100 ms while driving (app.ts).
const MIN_PACE_MS = 100;
const pace = () => Math.max(MIN_PACE_MS, Number(window.__nswsMuxMinPace) || 0, Math.min(1000, Number(window.__nswsMuxPace) || FLUSH_MS));
// How many of the racer's own car states a batch holds: from its first to its last is the pace.
// Read at every check, so a pace change applies at once.
const SAMPLE_MS = 50;
const carsPerFrame = () => Math.round(pace() / SAMPLE_MS) + 1;
// Past this much queued, flush at once (track transfers) instead of waiting for the timer.
const FLUSH_BYTES = 256 * 1024;
const MAX_EARLY = 64;
const IDLE_CLOSE_MS = 5000;
// A dropped socket keeps reconnecting for this long; what is queued meanwhile is sent on resume,
// up to MAX_RESUME_BYTES. The proxy parks a live room's links for 20 s; a restarted proxy has
// none, so the page keeps trying for as long as an organizer can reclaim its code.
const RESUME_MS = 60000;
const MAX_RESUME_BYTES = 4 * 1024 * 1024;
const LOG_BYTES = 1024 * 1024;
// A connection still waiting for its other end this long after re-linking is gone.
const RELINK_MS = 30000;
// The game's unreliable channel may lose messages, so on it:
// - an empty car batch (the organizer's game sends everyone one every 100 ms) or a car state the
//   other end already has never goes;
// - at the slow pace, pings go once per PING_MS;
// - while the cup covers the race with its own cards (window.__nswsMuxCarsUnseen: results, votes,
//   loading), car states wait in a slot of one, the newest, for the next frame or HOLD_MS, and are
//   dropped once the race shows again (the next round resets the cars, and a late one would undo it);
// - a page the cup marks quiet (window.__nswsMuxQuiet: in the background, not organizing, its car
//   not moving) answers no pings and sends its slot only with a frame that goes anyway.
const UNRELIABLE = 1;
const PING_MS = 10000;
const HOLD_MS = 10000;
const HOST_CARS = 3, HOST_PING = 9, HOST_PING_DATA = 10, CLIENT_CAR = 1, CLIENT_PONG = 3;
const slow = () => pace() >= 1000;
// With a room that passes car states straight between pages (proxy/src/lobby.js, FAN_KIND), a
// racer's own states go out as [u32 0][f64 its car's start on the cup clock][the game's bytes],
// the start from window.__nswsMuxCar. The room writes the sender's link over the first four
// bytes; window.__nswsFanIds (app.ts, from the organizer) says whose link it is, and a copy from
// a link nobody vouched for is dropped. The start tells every page how old a state is (smooth.ts,
// window.__nswsCarClocks by player id). These copies don't count as the link's records.
// On the organizer's page, a racer whose latest state came that way (pc._carDirect) isn't relayed
// again by the game to pages whose sockets take them (pc._peerFan; app.ts, __nswsCupDirect).
const FAN_KIND = 2;
const FAN_HEADER = 12;
// Copies of a car's states remembered per sender, to drop the second of each.
const SEEN_KEYS = 256;

function stamped(bytes) {
    const car = window.__nswsMuxCar;
    if (!car) return null;
    const out = new Uint8Array(FAN_HEADER + bytes.length);
    new DataView(out.buffer).setFloat64(4, Number.isFinite(car.start) ? car.start : NaN, true);
    out.set(bytes, FAN_HEADER);
    return out;
}

// The game's client only reads other cars from the organizer's batches ([3][u32 session][zlib of
// [u32 id][u32 resets][state]...]), so a racer's [1][u32 session][u32 resets][state]s (one session)
// are rewrapped as one, in stored (uncompressed) zlib blocks. The game inflates once per message,
// with a fresh 64 KB window each time, so a frame's states go as one message.
function asHostCars(id, states) {
    const payload = new Uint8Array(states.reduce((n, s) => n + s.length - 1, 0));
    const ids = new DataView(payload.buffer);
    let p = 0;
    for (const s of states) {
        ids.setUint32(p, id >>> 0, true);
        payload.set(s.subarray(5), p + 4);
        p += s.length - 1;
    }
    const blocks = Math.max(1, Math.ceil(payload.length / 65535));
    const out = new Uint8Array(5 + 2 + payload.length + blocks * 5 + 4);
    out[0] = HOST_CARS;
    out.set(states[0].subarray(1, 5), 1);
    out[5] = 0x78;
    out[6] = 0x01;
    let at = 7;
    for (let i = 0; i < blocks; i++) {
        const part = payload.subarray(i * 65535, (i + 1) * 65535);
        out[at] = i === blocks - 1 ? 1 : 0;
        out[at + 1] = part.length & 255;
        out[at + 2] = part.length >> 8;
        out[at + 3] = ~part.length & 255;
        out[at + 4] = (~part.length >> 8) & 255;
        out.set(part, at + 5);
        at += 5 + part.length;
    }
    let a = 1, b = 0;
    for (let i = 0; i < payload.length; i++) {
        a = (a + payload[i]) % 65521;
        b = (b + a) % 65521;
    }
    new DataView(out.buffer).setUint32(at, ((b << 16) | a) >>> 0, false);
    return out;
}

function sameBytes(a, b) {
    if (!a || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

function passCars(batch) {
    if (batch) batch.pc._deliver(batch.channel, 1, asHostCars(batch.id, batch.states));
    return null;
}

// "send", "drop" or "hold".
function sortRecord(pc, channel, kind, bytes) {
    if (channel !== UNRELIABLE || kind !== 1 || !bytes.length) return "send";
    const type = bytes[0];
    const host = pc.side === "host";
    if (host ? type === HOST_CARS : type === CLIENT_CAR) {
        // Deflated nothing: 5 header bytes, then 8 bytes ending in the empty input's Adler-32 (1).
        if (host && bytes.length === 13 && bytes[9] === 0 && bytes[10] === 0 && bytes[11] === 0 && bytes[12] === 1) return "drop";
        if (sameBytes(pc._lastCar, bytes)) return "drop";
        pc._lastCar = bytes;
        return window.__nswsMuxCarsUnseen ? "hold" : "send";
    }
    if (!host && type === CLIENT_PONG) return window.__nswsMuxQuiet ? "drop" : "send";
    if (host && (type === HOST_PING || type === HOST_PING_DATA)) {
        const now = performance.now();
        if (slow() && now - (pc._pingAt[type] ?? -Infinity) < PING_MS) return "drop";
        pc._pingAt[type] = now;
    }
    return "send";
}
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
        this.queuedAt = 0;
        // The racer's own car states in the queue, and when the first of them was queued.
        this.cars = 0;
        this.carAt = 0;
        this.frames = 0;
        this.heldAt = 0;
        this.timer = 0;
        this.controls = [];
        this.closeTimer = 0;
        this.token = randomHex(12);
        this.dead = false;
        this.idle = false;
        this.resumeUntil = 0;
        this.retries = 0;
        // Per sender link: its last full car update, and the states already passed to the game.
        this.lastFull = new Map();
        this.seen = new Map();
        // This page's own car: session and resets of its last full update, its frames, its player id.
        this.own = null;
        this.mesh = new Mesh(this);
        this.connect(false);
        this.mesh.askIce();
    }

    connect(resume) {
        const ws = new (window.__nswsSocket || WebSocket)(socketBase() + "nsws/cup/mux?code=" + this.code + "&token=" + this.token + "&fan=1" + (resume ? "&resume=1&relink=1" : ""));
        this.ws = ws;
        ws.binaryType = "arraybuffer";
        ws.addEventListener("open", () => {
            if (resume) return;
            for (const c of this.controls.splice(0)) ws.send(c);
            if (this.queue.length) this.flush();
        });
        ws.addEventListener("message", (e) => this.receive(e.data));
        ws.addEventListener("close", () => {
            if (this.ws === ws) this.dropped();
        });
    }

    // A socket that closes while links are in use reconnects and resumes them.
    // window.__nswsMuxOutage tells the organizer (host.ts) when this page was cut off from the proxy.
    dropped() {
        if (this.dead) return;
        if (this.idle || !this.pcs.size) return this.closed();
        const now = Date.now();
        if (!this.resumeUntil) window.__nswsMuxOutage = { from: now, until: 0 };
        this.resumeUntil ||= now + RESUME_MS;
        if (now >= this.resumeUntil || this.bytes > MAX_RESUME_BYTES) return this.closed();
        const wait = Math.min(3000, 400 * 2 ** this.retries++);
        setTimeout(() => {
            if (!this.dead) this.connect(true);
        }, wait);
    }

    resumed(m) {
        if (m.ok !== true) return this.closed();
        if (window.__nswsMuxOutage?.until === 0) window.__nswsMuxOutage.until = Date.now();
        this.resumeUntil = 0;
        this.retries = 0;
        if (m.relink) {
            // The rejoin covers every open and close queued meanwhile.
            this.controls.length = 0;
            const pairs = [];
            for (const pc of this.pcs.values()) {
                this.unlink(pc);
                pairs.push({ pair: pc.pair, side: pc.side, recv: pc._recv });
            }
            this.ws.send(JSON.stringify({ t: "rejoin", pairs }));
            this.awaitRelink();
        } else {
            for (const c of this.controls.splice(0)) this.ws.send(c);
        }
        if (this.queue.length) this.flush();
    }

    // Until its new link is up, what a connection sends waits in the queue.
    unlink(pc) {
        if (pc.link) this.links.delete(pc.link);
        pc.link = 0;
    }

    awaitRelink() {
        clearTimeout(this.relinkTimer);
        this.relinkTimer = setTimeout(() => {
            for (const pc of [...this.pcs.values()]) if (!pc.link && pc._linked) pc._down();
        }, RELINK_MS);
    }

    // The other end got `recv` records; everything after that goes again, in order.
    relinked(pc, link, recv) {
        pc.link = link;
        const from = Number.isSafeInteger(recv) ? recv - pc._logStart : -1;
        if (from < 0 || recv > pc._sent) {
            this.links.delete(link);
            return pc._down();
        }
        this.queue = this.queue.filter((r) => r.pc !== pc);
        for (let i = from; i < pc._log.length; i++) this.queue.push(pc._log[i]);
        this.bytes = this.queue.reduce((n, r) => n + 11 + r.bytes.length, 0);
        if (this.queue.length) this.flush();
    }

    forget(pc) {
        if (!this.queue.some((r) => r.pc === pc)) return;
        this.queue = this.queue.filter((r) => r.pc !== pc);
        this.bytes = this.queue.reduce((n, r) => n + 11 + r.bytes.length, 0);
        if (pc.side === "client") this.cars = 0;
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
        this.unlink(pc);
        this.forget(pc);
        this.control({ t: "close", pair: pc.pair });
        if (!this.pcs.size) {
            this.closeTimer = setTimeout(() => {
                if (this.pcs.size) return;
                this.idle = true;
                this.ws.close();
                if (this.ws.readyState !== WebSocket.OPEN) this.closed();
            }, IDLE_CLOSE_MS);
        }
    }

    enqueue(pc, channel, kind, bytes) {
        const sort = sortRecord(pc, channel, kind, bytes);
        if (sort === "drop") return;
        const car = channel === UNRELIABLE && pc._lastCar === bytes;
        if (car && sort === "send" && pc.side === "client" && bytes[0] === CLIENT_CAR) this.ownCar(bytes, 0);
        if (car) {
            pc._held = null;
            const fan = pc._fan && pc.side === "client" ? stamped(bytes) : null;
            if (fan) {
                kind = FAN_KIND;
                bytes = fan;
            }
        }
        if (sort === "hold") {
            pc._held = { channel, kind, bytes };
            this.heldAt ||= performance.now();
            return;
        }
        const now = performance.now();
        if (!this.queue.length) {
            this.queuedAt = now;
            this.cars = 0;
        }
        this.push(pc, channel, kind, bytes);
        // The racer's first car state restarts the batch's clock, and what was queued before rides
        // along, unless it has already waited a pace (it was queued at the slow pace). A hidden tab
        // isn't counted: its timers crawl, so it has always sent less often, on the ticker.
        if (car && pc.side === "client" && !document.hidden && !this.cars++) {
            this.carAt = now;
            clearTimeout(this.timer);
            this.timer = 0;
            if (now - this.queuedAt >= pace()) return this.flush();
        }
        if (this.bytes >= FLUSH_BYTES || (this.cars && now >= this.due())) this.flush();
        else if (!this.timer) this.timer = setTimeout(() => this.flush(), this.due() - now);
    }

    // When the queue goes without waiting for more. With the racer's car states in it, they decide
    // (a SAMPLE_MS past the pace is the backstop for a stalled car); otherwise a pace after the first record.
    due() {
        if (!this.cars) return this.queuedAt + pace();
        return this.cars >= carsPerFrame() ? 0 : this.carAt + pace() + SAMPLE_MS;
    }

    push(pc, channel, kind, bytes) {
        const record = { pc, channel, kind, bytes };
        this.queue.push(record);
        this.bytes += bytes.length + 11;
        pc._log.push(record);
        pc._sent++;
        pc._logBytes += bytes.length;
        if (pc._logBytes > LOG_BYTES) {
            let n = 0;
            while (n < pc._log.length - 1 && pc._logBytes > LOG_BYTES * 0.75) pc._logBytes -= pc._log[n++].bytes.length;
            pc._log.splice(0, n);
            pc._logStart += n;
        }
    }

    // Held car states ride along with a frame that goes anyway, or go on their own (force).
    flush(force = false) {
        clearTimeout(this.timer);
        this.timer = 0;
        if (this.ws.readyState !== WebSocket.OPEN) return;
        if (!force && !this.queue.some((r) => r.pc.link)) return;
        this.heldAt = 0;
        for (const pc of this.pcs.values()) {
            const held = pc._held;
            if (!held) continue;
            if (!window.__nswsMuxCarsUnseen) {
                pc._held = null;
                continue;
            }
            if (!pc.link) {
                this.heldAt ||= performance.now();
                continue;
            }
            pc._held = null;
            this.push(pc, held.channel, held.kind, held.bytes);
        }
        const ready = [], waiting = [];
        let size = 0;
        for (const r of this.queue) {
            if (r.pc.link) {
                ready.push(r);
                size += 11 + r.bytes.length;
            } else waiting.push(r);
        }
        if (!ready.length) return;
        const frame = new Uint8Array(size);
        const view = new DataView(frame.buffer);
        let at = 0;
        for (const r of ready) {
            view.setUint32(at, r.pc.link, true);
            view.setUint16(at + 4, r.channel, true);
            frame[at + 6] = r.kind;
            view.setUint32(at + 7, r.bytes.length, true);
            frame.set(r.bytes, at + 11);
            at += 11 + r.bytes.length;
        }
        this.queue = waiting;
        this.bytes -= size;
        this.cars = 0;
        this.frames++;
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
            if (m?.t === "resumed") return this.resumed(m);
            if (m?.t === "rtcIce") return this.mesh.setIce(m.iceServers);
            if (m?.t === "rtc") return void this.mesh.signalled(m.from, m.d);
            const pc = this.pcs.get(m?.pair);
            if (!pc) return;
            if (m.t === "up") {
                pc._fan = m.fan === true;
                pc._peerFan = m.peerFan === true;
                pc._carDirect = false;
                if (pc.link) this.links.delete(pc.link);
                this.links.set(m.link, pc);
                if (pc._linked) this.relinked(pc, m.link, m.recv);
                else pc._up(m.link);
            } else if (m.t === "relink") {
                this.unlink(pc);
                this.control({ t: "open", pair: pc.pair, side: pc.side, recv: pc._recv });
                this.awaitRelink();
            } else if (m.t === "down") {
                this.unlink(pc);
                pc._down();
            }
            return;
        }
        const frame = new Uint8Array(data);
        const view = new DataView(data);
        let batch = null;
        let at = 0;
        while (at + 11 <= frame.length) {
            const link = view.getUint32(at, true);
            const channel = view.getUint16(at + 4, true);
            const kind = frame[at + 6];
            const length = view.getUint32(at + 7, true);
            const end = at + 11 + length;
            if (end > frame.length) break;
            const pc = this.links.get(link);
            if (pc && kind === FAN_KIND) batch = this.fanned(pc, channel, frame.subarray(at + 11, end), batch, link);
            else if (pc) {
                batch = passCars(batch);
                if (pc.side === "host" && channel === UNRELIABLE && kind === 1 && frame[at + 11] === CLIENT_CAR) pc._carDirect = false;
                pc._recv++;
                pc._deliver(channel, kind, frame.subarray(at + 11, end));
            }
            at = end;
        }
        passCars(batch);
    }

    // One racer's states in a row (same link, session and start) reach the game as one message;
    // the start changes when the car resets, and each state must still see its own in __nswsCarClocks.
    fanned(pc, channel, bytes, batch, link) {
        if (bytes.length <= FAN_HEADER + 9) return batch;
        const view = new DataView(bytes.buffer, bytes.byteOffset, FAN_HEADER);
        const from = pc.side === "host" ? link : view.getUint32(0, true);
        const id = window.__nswsFanIds?.get(from);
        const start = view.getFloat64(4, true);
        const game = bytes.subarray(FAN_HEADER);
        const full = game[0] === CLIENT_CAR && game.length >= 12;
        if (full) this.#noteFull(from, game);
        const fresh = !full || this.#firstSeen(from, carKey(game));
        const joins = !!batch && pc.side !== "host" && batch.pc === pc && batch.channel === channel && batch.id === id &&
            Object.is(batch.start, start) && sameBytes(batch.states[0].subarray(1, 5), game.subarray(1, 5));
        if (!joins) batch = passCars(batch);
        if (id != null && Number.isFinite(start)) (window.__nswsCarClocks ??= new Map()).set(id, start);
        if (pc.side === "host") {
            pc._carDirect = true;
            pc._recv++;
            if (fresh) pc._deliver(channel, 1, game);
        } else if (id != null && game[0] === CLIENT_CAR && fresh) {
            if (joins) batch.states.push(game);
            else batch = { pc, channel, id, start, states: [game] };
        }
        return batch;
    }

    // ---- Car states over WebRTC (rtc.js) ----

    // Who this page is to the others: 0 on the organizer's page, else its own link to the organizer.
    rtcSelf() {
        let self = null;
        for (const pc of this.pcs.values()) {
            if (pc.side === "host") return 0;
            if (pc.link && pc._fan) self = pc.link;
        }
        return self;
    }

    #firstSeen(from, key) {
        let seen = this.seen.get(from);
        if (!seen) this.seen.set(from, seen = new Set());
        if (seen.has(key)) return false;
        seen.add(key);
        if (seen.size > SEEN_KEYS) seen.delete(seen.values().next().value);
        return true;
    }

    #noteFull(from, game) {
        const last = this.lastFull.get(from);
        const frames = game[9] | game[10] << 8 | game[11] << 16;
        if (last && sameBytes(last.head, game.subarray(1, 9)) && last.frames >= frames) return;
        this.lastFull.set(from, { game: game.slice(), head: game.slice(1, 9), frames });
    }

    // This page's car update (the game's bytes), or the organizer's own (main.bundle.js's Host).
    ownCar(game, pid) {
        if (game.length < 12 || window.__nswsMuxCarsUnseen) return;
        this.own = { head: game.slice(1, 9), frames: game[9] | game[10] << 8 | game[11] << 16, pid };
        this.mesh.sendFull(window.__nswsMuxCar?.start, pid, game);
    }

    ownPose(state) {
        const own = this.own;
        if (!own || state.frames <= own.frames || !this.mesh.openCount || window.__nswsMuxCarsUnseen) return;
        this.mesh.sendPose(window.__nswsMuxCar?.start, own.pid, own.head, state);
    }

    // A car state from page `from` over WebRTC. A pose becomes a full update from that car's last one.
    rtcCar(from, pose, start, pid, body) {
        const id = from === 0 ? pid : window.__nswsFanIds?.get(from);
        if (id == null || body.length < 12) return;
        let game = body;
        if (pose) {
            const full = this.lastFull.get(from);
            if (!full || !sameBytes(full.head, body.subarray(0, 8))) return;
            if ((body[8] | body[9] << 8 | body[10] << 16) <= full.frames) return;
            if (!this.#firstSeen(from, poseKey(body))) return;
            game = withPose(full.game, body);
            if (!game) return;
        } else {
            if (game[0] !== CLIENT_CAR) return;
            this.#noteFull(from, game);
            if (!this.#firstSeen(from, carKey(game))) return;
        }
        if (Number.isFinite(start)) (window.__nswsCarClocks ??= new Map()).set(id, start);
        if (this.rtcSelf() === 0) {
            this.links.get(from)?._deliver(UNRELIABLE, 1, game);
            return;
        }
        for (const pc of this.pcs.values()) {
            if (pc.side !== "client" || !pc.link) continue;
            passCars({ pc, channel: UNRELIABLE, id, start, states: [game] });
            return;
        }
    }

    closed() {
        if (this.dead) return;
        this.dead = true;
        this.mesh.reset();
        if (window.__nswsMuxOutage?.until === 0) window.__nswsMuxOutage.until = Date.now();
        clearTimeout(this.timer);
        clearTimeout(this.relinkTimer);
        if (muxes.get(this.code) === this) muxes.delete(this.code);
        for (const pc of [...this.pcs.values()]) pc._down();
        this.pcs.clear();
        this.links.clear();
    }
}

function muxFor(code) {
    let mux = muxes.get(code);
    if (!mux || mux.dead || mux.idle) muxes.set(code, mux = new Mux(code));
    return mux;
}

// Timers in a hidden tab fire at most once a second (once a minute after a while), but a worker's
// don't. The cup clock (app.ts) and the flushes below use this.
function createTicker() {
    const handlers = new Map();
    let next = 0, worker = null;
    try {
        const source = "const t=new Map();onmessage=e=>{const[id,ms]=e.data;t.set(id,setInterval(()=>postMessage(id),ms))}";
        worker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
        worker.onmessage = (e) => handlers.get(e.data)?.();
    } catch {
        worker = null;
    }
    return {
        every(ms, fn) {
            const id = ++next;
            handlers.set(id, fn);
            if (worker) worker.postMessage([id, ms]);
            else setInterval(fn, ms);
        },
    };
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
        this._pc._mux.enqueue(this._pc, this.id, kind, bytes);
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
        this._linked = false;
        this._recv = 0;
        this._sent = 0;
        this._log = [];
        this._logStart = 0;
        this._logBytes = 0;
        this._held = null;
        this._lastCar = null;
        this._pingAt = {};
        this._fan = false;
        this._peerFan = false;
        this._carDirect = false;
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
        this._linked = true;
        this._state("connected");
        for (const channel of this._channels.values()) channel._open();
    }

    _down() {
        if (this._closed) return;
        this._mux?.forget(this);
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
    // Soon rather than now, so everything the same click queues still goes out together.
    window.__nswsMuxFlush = () => {
        for (const mux of muxes.values()) {
            if (!mux.queue.length) continue;
            mux.soonAfter = mux.frames;
            if (mux.soon) continue;
            mux.soon = true;
            setTimeout(() => {
                mux.soon = false;
                // A frame that went meanwhile took everything asked for.
                if (mux.frames === mux.soonAfter) mux.flush();
            }, 15);
        }
    };
    if (!window.__nswsTicker) {
        window.__nswsTicker = createTicker();
        // Flushes whatever is due (Mux.due): in a hidden tab (whose timers crawl), and as soon as
        // the pace drops (a car starts moving), so a batch queued at the slow pace doesn't hold it up.
        window.__nswsTicker.every(100, () => {
            const now = performance.now();
            for (const mux of muxes.values()) {
                if (mux.queue.length && now >= mux.due()) mux.flush();
                else if (mux.heldAt && !window.__nswsMuxQuiet && now - mux.heldAt >= HOLD_MS) mux.flush(true);
            }
        });
        // Every page of a cup: the organizer (0) and the links the cup lists for its players.
        window.__nswsTicker.every(500, () => {
            for (const mux of muxes.values()) mux.mesh.tick(new Set([0, ...(window.__nswsFanIds?.keys() ?? [])]));
        });
    }
    // main.bundle.js: the organizer's own car update, and a pose of this page's car between updates.
    window.__nswsRtcHostCar = (game, pid) => {
        for (const mux of muxes.values()) if (mux.rtcSelf() === 0) mux.ownCar(game, pid);
    };
    window.__nswsCarSample = (state) => {
        for (const mux of muxes.values()) mux.ownPose(state);
    };
    window.__nswsRtcStats = () => [...muxes.values()].map((m) => ({
        code: m.code, self: m.rtcSelf(), ice: m.mesh.ice === undefined ? "asking" : !!m.mesh.ice, sent: m.mesh.sent, got: m.mesh.got,
        peers: [...m.mesh.peers.values()].map((p) => ({ link: p.link, state: p.pc.connectionState, open: p.open })),
    }));
}
