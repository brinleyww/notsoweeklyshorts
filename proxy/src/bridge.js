// WebSockets over plain HTTPS, for networks (often school or work) whose firewall blocks
// WebSockets but lets ordinary requests like the leaderboard's through. The page side is
// mod/nsws_socket.js; PROXY.md "HTTPS fallback for sockets" has the whole picture.
//
// One SocketBridge per cup code, shared by every fallback page in that cup (so the Durable Object
// time is per cup, not per player). It opens the real WebSockets to LobbyRoom / ChatRoom on a page's
// behalf, so those rooms see ordinary sockets and need no changes. Each page is a session (a random
// id it picks) with up to MAX_CHANNELS sockets ("channels"), all carried by the same requests:
//
//   open  (RPC from worker.js)        opens channel `ch` to a target worker.js already checked
//   POST /down?sid&after&mode&linger  what the page receives. mode=stream keeps the response open
//                                     for STREAM_MS and writes records as they come (two requests a
//                                     minute however busy the cup is); mode=poll answers once there
//                                     is something (after `linger` ms) or after POLL_WAIT_MS, for
//                                     networks whose proxy holds a response back until it ends.
//   POST /up?sid                      what the page sends: either one batch, or a streamed body that
//                                     stays open (browsers that can stream uploads) and carries
//                                     every batch for up to a minute. Answered with an ack record.
//
// Bodies are records, never JSON or base64, so nothing costs much CPU:
//   [u8 kind][u32 seq][u16 ch][u32 length][bytes]       (little-endian)
// kind 0 text (UTF-8), 1 binary, 2 close (u16 code + UTF-8 reason), 8 ack, 9 ping.
// Both directions number their records. The page passes the last seq it received as `after`
// (and sends ack records on /up), and everything past it is sent again on the next /down, so a
// dropped stream loses nothing. Records the page sends are acked (kind 8) and a seq already
// delivered is skipped, so a retried batch is never delivered twice.
//
// Nothing is stored. A session nobody has asked for in IDLE_MS is gone: its sockets close with 4001,
// which the rooms treat as a dropped connection (the relay parks, the organizer can reclaim the code).

import { DurableObject } from "cloudflare:workers";

export const KIND_TEXT = 0;
export const KIND_BINARY = 1;
export const KIND_CLOSE = 2;
export const KIND_ACK = 8;
export const KIND_PING = 9;
export const HEADER = 11;

const STREAM_MS = 30_000;
const STREAM_PING_MS = 10_000;
const POLL_WAIT_MS = 20_000;
const MAX_LINGER_MS = 1_000;
const UPLOAD_MAX_MS = 60_000;
const IDLE_MS = 45_000;
const SWEEP_MS = 15_000;
const MAX_SESSIONS = 64;
const MAX_CHANNELS = 8;
// Received but not yet acknowledged. Past this the page isn't collecting and has gone.
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const MAX_POLL_REPLY_BYTES = 2 * 1024 * 1024;
const MAX_RECORD = 1024 * 1024 + 64;
const SID = /^[0-9a-f]{32}$/;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function record(kind, seq, ch, payload) {
    const bytes = payload ?? new Uint8Array(0);
    const out = new Uint8Array(HEADER + bytes.length);
    const view = new DataView(out.buffer);
    out[0] = kind;
    view.setUint32(1, seq >>> 0, true);
    view.setUint16(5, ch, true);
    view.setUint32(7, bytes.length, true);
    out.set(bytes, HEADER);
    return out;
}

function closePayload(code, reason) {
    const text = encoder.encode(String(reason || "").slice(0, 120));
    const out = new Uint8Array(2 + text.length);
    new DataView(out.buffer).setUint16(0, code, true);
    out.set(text, 2);
    return out;
}

// What the page may close a socket with: a normal close, or an application code.
function closeCode(code) {
    return code === 1000 || (Number.isInteger(code) && code >= 3000 && code <= 4999) ? code : 1000;
}

function concat(parts, size) {
    const out = new Uint8Array(size);
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}

const BINARY_HEADERS = {
    "Content-Type": "application/octet-stream",
    // no-transform: nothing on the way may compress (and so hold back) the stream.
    "Cache-Control": "no-store, no-transform",
    "X-Accel-Buffering": "no",
};

class Session {
    constructor(sid) {
        this.sid = sid;
        this.channels = new Map();
        this.events = [];
        this.bytes = 0;
        this.seq = 0;
        this.inSeq = 0;
        this.seen = Date.now();
        this.down = null;
        this.uploads = 0;
    }
}

export class SocketBridge extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.sessions = new Map();
        this.sweeper = 0;
    }

    session(sid, create) {
        let s = this.sessions.get(sid);
        if (!s && create && SID.test(sid) && this.sessions.size < MAX_SESSIONS) this.sessions.set(sid, s = new Session(sid));
        if (s) s.seen = Date.now();
        if (s && !this.sweeper) this.sweeper = setInterval(() => this.sweep(), SWEEP_MS);
        return s ?? null;
    }

    sweep() {
        const now = Date.now();
        for (const s of this.sessions.values()) {
            if (!s.down && !s.uploads && now - s.seen > IDLE_MS) this.drop(s, 4001, "Gone");
        }
        if (!this.sessions.size) {
            clearInterval(this.sweeper);
            this.sweeper = 0;
        }
    }

    // Closes a page's sockets and forgets it.
    drop(s, code, reason) {
        this.sessions.delete(s.sid);
        for (const ws of s.channels.values()) {
            try {
                ws.close(code, reason);
            } catch {}
        }
        s.channels.clear();
        s.events = [];
        s.bytes = 0;
        s.down?.end();
    }

    push(s, kind, ch, payload) {
        const rec = record(kind, ++s.seq, ch, payload);
        s.events.push({ seq: s.seq, rec });
        s.bytes += rec.length;
        if (s.bytes > MAX_BUFFERED_BYTES) return this.drop(s, 4001, "Gone");
        s.down?.add(rec);
    }

    trim(s, after) {
        while (s.events.length && s.events[0].seq <= after) s.bytes -= s.events.shift().rec.length;
    }

    // RPC from worker.js. `target` is where the socket goes, already resolved and checked there.
    async open(sid, ch, target) {
        const s = this.session(sid, true);
        if (!s) return { refused: "SessionFull" };
        if (!Number.isSafeInteger(ch) || ch < 1 || ch > 0xffff) return { refused: "BadRequest" };
        if (s.channels.has(ch)) return { ok: true };
        if (s.channels.size >= MAX_CHANNELS) return { refused: "SessionFull" };
        const ns = this.env[target.ns];
        if (!ns) return { refused: "ServerUnavailable" };
        let res;
        try {
            res = await ns.get(ns.idFromName(target.name)).fetch(new Request("https://socket.internal/" + target.path, {
                headers: { ...target.headers, Upgrade: "websocket" },
            }));
        } catch {
            return { refused: "ServerUnavailable" };
        }
        const ws = res.webSocket;
        if (!ws) return { refused: "ServerUnavailable" };
        ws.accept();
        try {
            ws.binaryType = "arraybuffer";
        } catch {}
        s.channels.set(ch, ws);
        // Binary can still arrive as a Blob, which reads asynchronously; `order` keeps every message
        // (and the close) in the order the room sent them.
        let order = Promise.resolve();
        const inOrder = (fn) => {
            order = order.then(fn).catch(() => {});
        };
        ws.addEventListener("message", (e) => {
            const data = e.data;
            if (typeof data === "string") {
                inOrder(() => {
                    if (s.channels.get(ch) === ws) this.push(s, KIND_TEXT, ch, encoder.encode(data));
                });
            } else {
                const bytes = data instanceof ArrayBuffer ? Promise.resolve(data) : data.arrayBuffer();
                inOrder(async () => {
                    const buffer = await bytes;
                    if (s.channels.get(ch) === ws) this.push(s, KIND_BINARY, ch, new Uint8Array(buffer));
                });
            }
        });
        const closed = (code, reason) => inOrder(() => {
            if (s.channels.get(ch) !== ws) return;
            s.channels.delete(ch);
            try {
                ws.close(closeCode(code), String(reason || "").slice(0, 120));
            } catch {}
            this.push(s, KIND_CLOSE, ch, closePayload(code || 1006, reason));
        });
        ws.addEventListener("close", (e) => closed(e.code, e.reason));
        ws.addEventListener("error", () => closed(1006, ""));
        return { ok: true };
    }

    async fetch(request) {
        const url = new URL(request.url);
        const s = this.session(url.searchParams.get("sid") || "", false);
        if (!s) return new Response("Gone", { status: 410, headers: BINARY_HEADERS });
        if (url.pathname === "/down") return this.downstream(s, url);
        if (url.pathname === "/up") return this.upstream(s, request);
        return new Response("Not found", { status: 404 });
    }

    // ---- To the page ----

    downstream(s, url) {
        const after = Number(url.searchParams.get("after")) || 0;
        this.trim(s, after);
        s.down?.end();
        if (url.searchParams.get("mode") === "stream") return this.stream(s);
        return this.poll(s, Math.max(0, Math.min(MAX_LINGER_MS, Number(url.searchParams.get("linger")) || 0)));
    }

    stream(s) {
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        let open = true;
        const write = (bytes) => {
            if (!open) return;
            writer.write(bytes).catch(end);
        };
        const ping = () => write(record(KIND_PING, 0, 0));
        const timers = [setInterval(ping, STREAM_PING_MS), setTimeout(() => end(), STREAM_MS)];
        const sink = {
            add: write,
            ack: () => write(record(KIND_ACK, s.inSeq, 0)),
            end,
        };
        function end() {
            if (!open) return;
            open = false;
            for (const t of timers) clearTimeout(t);
            if (s.down === sink) {
                s.down = null;
                s.seen = Date.now();
            }
            writer.close().catch(() => {});
        }
        s.down = sink;
        // The first record says the stream is through; then everything not yet acknowledged.
        ping();
        sink.ack();
        for (const e of s.events) write(e.rec);
        return new Response(readable, { headers: BINARY_HEADERS });
    }

    poll(s, linger) {
        return new Promise((resolve) => {
            let lingerTimer = 0;
            const reply = () => {
                const parts = [record(KIND_ACK, s.inSeq, 0)];
                let size = parts[0].length;
                for (const e of s.events) {
                    if (parts.length > 1 && size + e.rec.length > MAX_POLL_REPLY_BYTES) break;
                    parts.push(e.rec);
                    size += e.rec.length;
                }
                resolve(new Response(concat(parts, size), { headers: BINARY_HEADERS }));
            };
            const sink = {
                add: () => {
                    if (!lingerTimer) lingerTimer = setTimeout(() => sink.end(), linger);
                },
                ack: () => {},
                end: () => {
                    clearTimeout(timer);
                    clearTimeout(lingerTimer);
                    if (s.down === sink) {
                        s.down = null;
                        s.seen = Date.now();
                    }
                    reply();
                },
            };
            const timer = setTimeout(() => sink.end(), POLL_WAIT_MS);
            s.down = sink;
            if (s.events.length || !s.channels.size) sink.end();
        });
    }

    // ---- From the page ----

    async upstream(s, request) {
        s.uploads++;
        const reader = request.body?.getReader();
        let buffer = new Uint8Array(0);
        const deadline = setTimeout(() => reader?.cancel().catch(() => {}), UPLOAD_MAX_MS);
        try {
            while (reader) {
                const { value, done } = await reader.read();
                if (done) break;
                s.seen = Date.now();
                buffer = buffer.length ? concat([buffer, value], buffer.length + value.length) : value;
                let at = 0;
                let acked = false;
                while (at + HEADER <= buffer.length) {
                    const view = new DataView(buffer.buffer, buffer.byteOffset + at);
                    const length = view.getUint32(7, true);
                    if (length > MAX_RECORD) throw new Error("record too large");
                    if (at + HEADER + length > buffer.length) break;
                    acked = this.apply(s, buffer[at], view.getUint32(1, true), view.getUint16(5, true), buffer.subarray(at + HEADER, at + HEADER + length)) || acked;
                    at += HEADER + length;
                }
                buffer = buffer.subarray(at);
                // A streamed upload is acknowledged on the page's stream as it goes.
                if (acked) s.down?.ack();
            }
        } catch {
            // A broken upload: the page sends what wasn't acknowledged again.
        } finally {
            clearTimeout(deadline);
            s.uploads--;
            s.seen = Date.now();
        }
        return new Response(record(KIND_ACK, s.inSeq, 0), { headers: BINARY_HEADERS });
    }

    // One record from the page. Returns true when it was a numbered record (worth acknowledging).
    apply(s, kind, seq, ch, payload) {
        if (kind === KIND_ACK) {
            this.trim(s, seq);
            return false;
        }
        if (kind === KIND_PING) return true;
        if (seq <= s.inSeq) return true;
        s.inSeq = seq;
        const ws = s.channels.get(ch);
        if (!ws) return true;
        try {
            if (kind === KIND_TEXT) ws.send(decoder.decode(payload));
            else if (kind === KIND_BINARY) ws.send(payload.slice());
            else if (kind === KIND_CLOSE) {
                // The page closed it; nothing goes back for it.
                s.channels.delete(ch);
                const code = payload.length >= 2 ? new DataView(payload.buffer, payload.byteOffset).getUint16(0, true) : 1000;
                ws.close(closeCode(code), decoder.decode(payload.subarray(2)).slice(0, 120));
            }
        } catch {}
        return true;
    }
}
