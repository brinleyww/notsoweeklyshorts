// window.__nswsSocket: a WebSocket that still works on networks (often school or work) whose firewall
// blocks WebSockets but lets ordinary HTTPS through, like the leaderboard's requests. It is a real
// WebSocket whenever one can open. If one can't (refused, or not open within WS_OPEN_TIMEOUT_MS), the
// same socket carries on over HTTPS through the proxy's SocketBridge (proxy/src/bridge.js), and the
// page using it can't tell the difference. Cups use it for the matchmaking sockets (main.bundle.js),
// the relay (competitions/src/transport.js) and the cup chat (competitions/src/chat.ts).
//
// Kept cheap on Cloudflare's free plan (PROXY.md "HTTPS fallback for sockets"):
// - Only sockets that can't open use HTTPS. A network that blocked one is remembered for
//   HTTP_REMEMBER_MS (the same key the main chat uses), checked again once per visit.
// - Every socket a page has in one cup shares one session: one stream down, one stream up.
// - Down: one streamed response every STREAM_MS, however busy the cup is. If the network's proxy
//   holds responses back until they end, it switches to long-polling (and remembers that).
// - Up: one streamed request body per minute where the browser can stream uploads (Chrome on
//   HTTP/2). Otherwise one POST per batch, never more than one at a time, and the cup relay slows its
//   batches to POST_PACE_MS.
// - Records are raw bytes (no JSON or base64), so the Worker spends almost no CPU passing them on.
(() => {
    if (window.__nswsSocket) return;

    const TRANSPORT_KEY = "_nswsChatHttpAt";
    const POLL_KEY = "_nswsSockPollAt";
    const NO_UPLOAD_KEY = "_nswsSockNoUploadAt";
    const HTTP_REMEMBER_MS = 12 * 3600000;
    const WS_OPEN_TIMEOUT_MS = 8000;
    const FIRST_BYTE_MS = 5000;
    const UPLOAD_CONFIRM_MS = 5000;
    const UPLOAD_ROTATE_MS = 50000;
    const UPLOAD_ACK_MS = 2000;
    const POST_PACE_MS = 300;
    const OPEN_ABORT_MS = 15000;
    const POLL_ABORT_MS = 30000;
    const UP_ABORT_MS = 20000;
    const DEAD_MS = 20000;
    const HUB_IDLE_MS = 3000;

    const KIND_TEXT = 0, KIND_BINARY = 1, KIND_CLOSE = 2, KIND_ACK = 8, KIND_PING = 9;
    const HEADER = 11;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    function storageGet(key) {
        try {
            return localStorage.getItem(key);
        } catch {
            return null;
        }
    }

    function storageSet(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch {}
    }

    function recently(key) {
        const at = Number(storageGet(key));
        return at > 0 && Date.now() - at < HTTP_REMEMBER_MS;
    }

    function apiBase() {
        return String(window.__nswsApiBase || "");
    }

    function randomHex(bytes) {
        return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
    }

    function record(kind, seq, ch, payload) {
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

    function concat(parts) {
        const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
        let at = 0;
        for (const p of parts) {
            out.set(p, at);
            at += p.length;
        }
        return out;
    }

    // Records arrive in whatever pieces the network makes; this joins them back up.
    class Parser {
        constructor(onRecord) {
            this.buffer = new Uint8Array(0);
            this.onRecord = onRecord;
        }

        push(chunk) {
            this.buffer = this.buffer.length ? concat([this.buffer, chunk]) : chunk;
            let at = 0;
            while (at + HEADER <= this.buffer.length) {
                const view = new DataView(this.buffer.buffer, this.buffer.byteOffset + at);
                const length = view.getUint32(7, true);
                if (at + HEADER + length > this.buffer.length) break;
                this.onRecord(this.buffer[at], view.getUint32(1, true), view.getUint16(5, true), this.buffer.slice(at + HEADER, at + HEADER + length));
                at += HEADER + length;
            }
            this.buffer = this.buffer.slice(at);
        }
    }

    // Chrome can stream a request body (over HTTP/2); other browsers send one POST per batch.
    const canStreamUploads = (() => {
        try {
            let duplexAccessed = false;
            const hasContentType = new Request("https://example.invalid/", {
                body: new ReadableStream(),
                method: "POST",
                get duplex() {
                    duplexAccessed = true;
                    return "half";
                },
            }).headers.has("Content-Type");
            return duplexAccessed && !hasContentType;
        } catch {
            return false;
        }
    })();

    function post(path, params, body, timeout, extra) {
        const controller = new AbortController();
        const timer = timeout ? setTimeout(() => controller.abort(), timeout) : 0;
        const query = new URLSearchParams(params).toString();
        const promise = fetch(apiBase() + "nsws/sock/" + path + "?" + query, {
            method: "POST",
            // text/plain: a plain request, so the browser sends it with no CORS preflight.
            headers: { "Content-Type": "text/plain" },
            body,
            cache: "no-store",
            credentials: "omit",
            signal: controller.signal,
            ...extra,
        });
        promise.finally(() => clearTimeout(timer)).catch(() => {});
        return { promise, controller };
    }

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    // ---- One cup's session: every HTTPS socket this page has in that cup. ----

    const hubs = new Map();

    function updatePace() {
        // The cup relay batches at least this far apart while any upload goes one POST at a time.
        const slow = [...hubs.values()].some((h) => !h.uploadStreaming);
        window.__nswsMuxMinPace = slow ? POST_PACE_MS : 0;
    }

    class Hub {
        constructor(cup, sid) {
            this.cup = cup;
            this.sid = sid;
            this.channels = new Map();
            this.inSeq = 0;
            this.outSeq = 0;
            this.acked = 0;
            this.pending = [];
            this.dead = false;
            this.lastOk = Date.now();
            this.polling = recently(POLL_KEY);
            this.uploadStreaming = canStreamUploads && !this.polling && !recently(NO_UPLOAD_KEY);
            this.upload = null;
            this.posting = false;
            this.flushQueued = false;
            this.downController = null;
            this.idleTimer = 0;
            this.ackTimer = 0;
            this.ackSent = 0;
            this.running = false;
            hubs.set(cup, this);
            updatePace();
        }

        add(ch, socket) {
            clearTimeout(this.idleTimer);
            this.channels.set(ch, socket);
            if (!this.running) void this.downLoop();
        }

        remove(ch) {
            this.channels.delete(ch);
            if (this.channels.size) return;
            clearTimeout(this.idleTimer);
            this.idleTimer = setTimeout(() => {
                if (!this.channels.size && !this.pending.length) this.stop();
            }, HUB_IDLE_MS);
        }

        stop() {
            if (this.dead) return;
            this.dead = true;
            if (hubs.get(this.cup) === this) hubs.delete(this.cup);
            clearInterval(this.ackTimer);
            this.downController?.abort();
            this.endUpload(true);
            updatePace();
        }

        // Unreachable for too long, or the bridge forgot the session: every socket drops.
        die() {
            if (this.dead) return;
            const channels = [...this.channels.values()];
            this.channels.clear();
            this.stop();
            for (const socket of channels) socket._remoteClose(1006, "", false);
        }

        healthy() {
            this.lastOk = Date.now();
        }

        failing() {
            if (Date.now() - this.lastOk > DEAD_MS) this.die();
            return this.dead;
        }

        // ---- Down ----

        onRecord(kind, seq, ch, payload) {
            this.healthy();
            if (kind === KIND_PING) return;
            if (kind === KIND_ACK) return this.onAck(seq);
            if (seq <= this.inSeq) return;
            this.inSeq = seq;
            const socket = this.channels.get(ch);
            if (!socket) return;
            if (kind === KIND_CLOSE) {
                this.channels.delete(ch);
                const view = new DataView(payload.buffer, payload.byteOffset);
                const code = payload.length >= 2 ? view.getUint16(0, true) : 1006;
                socket._remoteClose(code, decoder.decode(payload.subarray(2)), true);
                this.remove(ch);
            } else {
                socket._deliver(kind === KIND_TEXT ? decoder.decode(payload) : payload);
            }
        }

        // Runs while this page has a socket in the cup.
        async downLoop() {
            this.running = true;
            try {
                await this.downLoopInner();
            } finally {
                this.running = false;
            }
        }

        async downLoopInner() {
            let wait = 500;
            while (!this.dead && this.channels.size) {
                try {
                    const ok = this.polling ? await this.pollOnce() : await this.streamOnce();
                    if (this.dead) return;
                    if (ok === "gone") return this.die();
                    wait = 500;
                } catch {
                    if (this.dead || this.failing()) return;
                    await sleep(wait);
                    wait = Math.min(4000, wait * 2);
                }
            }
        }

        params(extra) {
            return { sid: this.sid, b: this.cup, after: String(this.inSeq), ...extra };
        }

        async streamOnce() {
            const { promise, controller } = post("down", this.params({ mode: "stream" }), "", 0);
            this.downController = controller;
            let gotByte = false;
            // A proxy that holds the response back until it ends can't stream: poll instead.
            const firstByte = setTimeout(() => {
                if (gotByte) return;
                this.polling = true;
                this.uploadStreaming = false;
                this.endUpload(false);
                updatePace();
                storageSet(POLL_KEY, String(Date.now()));
                controller.abort();
            }, FIRST_BYTE_MS);
            try {
                const res = await promise;
                if (res.status === 410) return "gone";
                if (!res.ok || !res.body) throw new Error("down " + res.status);
                const parser = new Parser((...r) => this.onRecord(...r));
                const reader = res.body.getReader();
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    gotByte = true;
                    parser.push(value);
                }
                return "ok";
            } catch (error) {
                // Switching to polling aborts the stream on purpose; that isn't a failure.
                if (this.polling && !gotByte) return "ok";
                throw error;
            } finally {
                clearTimeout(firstByte);
            }
        }

        async pollOnce() {
            const pace = Number(window.__nswsMuxPace) || 300;
            const linger = Math.max(150, Math.min(1000, pace));
            const { promise, controller } = post("down", this.params({ mode: "poll", linger: String(linger) }), "", POLL_ABORT_MS);
            this.downController = controller;
            const res = await promise;
            if (res.status === 410) return "gone";
            if (!res.ok) throw new Error("poll " + res.status);
            const parser = new Parser((...r) => this.onRecord(...r));
            parser.push(new Uint8Array(await res.arrayBuffer()));
            return "ok";
        }

        // ---- Up ----

        send(ch, kind, payload) {
            if (this.dead) return;
            const seq = ++this.outSeq;
            this.pending.push({ seq, rec: record(kind, seq, ch, payload) });
            if (this.flushQueued) return;
            // Everything sent in the same moment leaves together.
            this.flushQueued = true;
            queueMicrotask(() => {
                this.flushQueued = false;
                this.flush();
            });
        }

        onAck(seq) {
            if (seq <= this.acked) return;
            this.acked = seq;
            while (this.pending.length && this.pending[0].seq <= seq) this.pending.shift();
            if (this.upload && !this.upload.confirmed && this.upload.firstSeq && seq >= this.upload.firstSeq) {
                this.upload.confirmed = true;
                clearTimeout(this.upload.confirmTimer);
            }
            if (!this.channels.size && !this.pending.length) this.remove(0);
        }

        flush() {
            if (this.dead || !this.pending.length) return;
            if (this.uploadStreaming) return this.streamUp();
            this.postUp();
        }

        // ---- Up, streamed: one request body carries every batch for a while. ----

        openUpload() {
            const stream = new TransformStream();
            const writer = stream.writable.getWriter();
            const up = { writer, written: this.acked, firstSeq: 0, confirmed: false, confirmTimer: 0, rotateTimer: 0 };
            const { promise, controller } = post("up", { sid: this.sid, b: this.cup }, stream.readable, 0, { duplex: "half" });
            up.controller = controller;
            up.rotateTimer = setTimeout(() => {
                if (this.upload === up) this.endUpload(false);
            }, UPLOAD_ROTATE_MS);
            promise.then(async (res) => {
                if (res.status === 410) return this.die();
                if (res.ok) new Parser((...r) => this.onRecord(...r)).push(new Uint8Array(await res.arrayBuffer()));
            }).catch(() => {
                // Can't stream an upload here (HTTP/1.1, or a proxy in the way): POST each batch.
                if (!up.confirmed && this.upload === up) this.uploadFailed();
            }).finally(() => {
                if (this.upload === up) this.upload = null;
                clearTimeout(up.rotateTimer);
                clearTimeout(up.confirmTimer);
                // Whatever this stream carried that wasn't acknowledged goes again.
                if (this.pending.length && !this.dead) this.flush();
            });
            // Starts the body moving, and keeps the bridge's buffer trimmed between batches.
            writer.write(record(KIND_ACK, this.inSeq, 0)).catch(() => {});
            this.ackSent = this.inSeq;
            clearInterval(this.ackTimer);
            this.ackTimer = setInterval(() => {
                if (this.upload === up && this.inSeq > this.ackSent) {
                    this.ackSent = this.inSeq;
                    writer.write(record(KIND_ACK, this.inSeq, 0)).catch(() => {});
                }
            }, UPLOAD_ACK_MS);
            this.upload = up;
            return up;
        }

        uploadFailed() {
            this.uploadStreaming = false;
            storageSet(NO_UPLOAD_KEY, String(Date.now()));
            this.endUpload(true);
            updatePace();
            this.flush();
        }

        endUpload(abort) {
            const up = this.upload;
            if (!up) return;
            this.upload = null;
            clearTimeout(up.rotateTimer);
            clearTimeout(up.confirmTimer);
            clearInterval(this.ackTimer);
            if (abort) up.controller.abort();
            else up.writer.close().catch(() => {});
        }

        streamUp() {
            const up = this.upload ?? this.openUpload();
            const fresh = this.pending.filter((p) => p.seq > up.written);
            if (!fresh.length) return;
            up.written = fresh[fresh.length - 1].seq;
            if (!up.firstSeq) {
                up.firstSeq = fresh[0].seq;
                // An upload stream that a proxy holds back never gets acknowledged.
                up.confirmTimer = setTimeout(() => {
                    if (this.upload === up && !up.confirmed) this.uploadFailed();
                }, UPLOAD_CONFIRM_MS);
            }
            up.writer.write(concat(fresh.map((p) => p.rec))).catch(() => {});
        }

        // ---- Up, one POST per batch (one at a time; what queues meanwhile goes together). ----

        async postUp() {
            if (this.posting) return;
            this.posting = true;
            let wait = 500;
            try {
                while (!this.dead && this.pending.length) {
                    const batch = this.pending.slice();
                    const body = concat([record(KIND_ACK, this.inSeq, 0), ...batch.map((p) => p.rec)]);
                    try {
                        const { promise } = post("up", { sid: this.sid, b: this.cup }, body, UP_ABORT_MS);
                        const res = await promise;
                        if (res.status === 410) return this.die();
                        if (!res.ok) throw new Error("up " + res.status);
                        new Parser((...r) => this.onRecord(...r)).push(new Uint8Array(await res.arrayBuffer()));
                        wait = 500;
                    } catch {
                        if (this.failing()) return;
                        await sleep(wait);
                        wait = Math.min(4000, wait * 2);
                    }
                }
            } finally {
                this.posting = false;
            }
        }
    }

    // ---- Opening a socket over HTTPS ----

    let nextChannel = 1;

    // The cup a socket path belongs to, when the path says (a new cup's host socket doesn't yet).
    function cupOf(path) {
        try {
            const p = new URL(path, "https://x/").searchParams;
            const code = String(p.get("code") || p.get("cup") || p.get("reclaim") || "").toUpperCase();
            return /^[A-HJ-NP-Z2-9]{5}$/.test(code) ? code : null;
        } catch {
            return null;
        }
    }

    async function openHttp(socket, path) {
        if (nextChannel > 0xffff) nextChannel = 1;
        const ch = nextChannel++;
        const known = cupOf(path);
        const hub = known ? hubs.get(known) : null;
        const sid = hub && !hub.dead ? hub.sid : randomHex(16);
        let result;
        try {
            const { promise } = post("open", { sid, ch: String(ch) }, path, OPEN_ABORT_MS);
            const res = await promise;
            if (!res.ok) throw new Error("open " + res.status);
            result = await res.json();
        } catch {
            return socket._failed();
        }
        if (result.refused) return socket._refused(result.refused);
        if (!/^[A-HJ-NP-Z2-9]{5}$/.test(result.b || "")) return socket._failed();
        let target = hubs.get(result.b);
        if (!target || target.dead || target.sid !== sid) target = new Hub(result.b, sid);
        // The server took it but the page meanwhile closed it.
        if (socket.readyState !== NswsSocket.CONNECTING) {
            target.send(ch, KIND_CLOSE, closePayload(socket._closeCode ?? 1000, socket._closeReason));
            return;
        }
        // A network that refused the WebSocket but takes this: remember it for next time.
        if (socket._wsFailed) storageSet(TRANSPORT_KEY, String(Date.now()));
        target.add(ch, socket);
        socket._attach(target, ch);
    }

    function closePayload(code, reason) {
        const text = encoder.encode(String(reason || "").slice(0, 120));
        const out = new Uint8Array(2 + text.length);
        new DataView(out.buffer).setUint16(0, code, true);
        out.set(text, 2);
        return out;
    }

    // Opens a socket and closes it straight away, once a visit. If it opens, this network allows
    // WebSockets again and the next sockets use them. It never says hello, so it never joins.
    let probed = false;
    function probeWebSocket() {
        if (probed) return;
        probed = true;
        let ws;
        try {
            ws = new WebSocket(apiBase().replace(/^http/, "ws") + "nsws/chat");
        } catch {
            return;
        }
        const timer = setTimeout(() => ws.close(), WS_OPEN_TIMEOUT_MS);
        ws.addEventListener("open", () => {
            clearTimeout(timer);
            storageSet(TRANSPORT_KEY, "");
            ws.close();
        });
        ws.addEventListener("close", () => clearTimeout(timer));
    }

    // ---- The socket the page sees ----

    class NswsSocket extends EventTarget {
        constructor(url) {
            super();
            this.url = String(url);
            this.readyState = NswsSocket.CONNECTING;
            this.protocol = "";
            this.extensions = "";
            this.onopen = this.onmessage = this.onclose = this.onerror = null;
            this._binaryType = "blob";
            this._ws = null;
            this._hub = null;
            this._ch = 0;
            this._wsFailed = false;
            const base = apiBase().replace(/^http/, "ws");
            this._path = this.url.startsWith(base) ? this.url.slice(base.length) : null;
            if (this._path != null && recently(TRANSPORT_KEY)) {
                probeWebSocket();
                void openHttp(this, this._path);
            } else {
                this._tryWebSocket();
            }
        }

        get binaryType() {
            return this._binaryType;
        }

        set binaryType(value) {
            this._binaryType = value === "arraybuffer" ? "arraybuffer" : "blob";
            if (this._ws) this._ws.binaryType = this._binaryType;
        }

        get bufferedAmount() {
            return this._ws ? this._ws.bufferedAmount : 0;
        }

        get transport() {
            return this._hub ? "https" : "websocket";
        }

        _tryWebSocket() {
            let ws;
            try {
                ws = new WebSocket(this.url);
            } catch {
                return this._wsFailedToOpen();
            }
            this._ws = ws;
            ws.binaryType = this._binaryType;
            let opened = false;
            // Some filters hold a blocked socket open forever instead of refusing it.
            const timer = setTimeout(() => {
                if (!opened) ws.close();
            }, WS_OPEN_TIMEOUT_MS);
            ws.addEventListener("open", () => {
                opened = true;
                clearTimeout(timer);
                if (this.readyState !== NswsSocket.CONNECTING) return ws.close();
                this.readyState = NswsSocket.OPEN;
                this._fire("open");
            });
            ws.addEventListener("message", (e) => this._fire("message", { data: e.data }));
            ws.addEventListener("error", () => {
                if (opened) this._fire("error");
            });
            ws.addEventListener("close", (e) => {
                clearTimeout(timer);
                if (!opened && this.readyState === NswsSocket.CONNECTING) return this._wsFailedToOpen();
                if (this.readyState === NswsSocket.CLOSED) return;
                this.readyState = NswsSocket.CLOSED;
                this._fire("close", { code: e.code, reason: e.reason, wasClean: e.wasClean });
            });
        }

        // The WebSocket never got going: carry on over HTTPS.
        _wsFailedToOpen() {
            this._ws = null;
            if (this._path == null) return this._failed();
            this._wsFailed = true;
            void openHttp(this, this._path);
        }

        _attach(hub, ch) {
            this._hub = hub;
            this._ch = ch;
            this.readyState = NswsSocket.OPEN;
            this._fire("open");
        }

        // The server turned it down. A WebSocket hears that as an error message and a close.
        _refused(error) {
            if (this.readyState !== NswsSocket.CONNECTING) return;
            this.readyState = NswsSocket.OPEN;
            this._fire("open");
            this._deliver(JSON.stringify({ type: "error", error }));
            this._remoteClose(4029, "Refused", true);
        }

        _failed() {
            if (this.readyState === NswsSocket.CLOSED) return;
            this.readyState = NswsSocket.CLOSED;
            this._fire("error");
            this._fire("close", { code: 1006, reason: "", wasClean: false });
        }

        _deliver(data) {
            if (this.readyState !== NswsSocket.OPEN) return;
            if (typeof data !== "string") {
                const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
                data = this._binaryType === "arraybuffer" ? bytes.slice().buffer : new Blob([bytes]);
            }
            this._fire("message", { data });
        }

        _remoteClose(code, reason, clean) {
            if (this.readyState === NswsSocket.CLOSED) return;
            this.readyState = NswsSocket.CLOSED;
            if (!clean) this._fire("error");
            this._fire("close", { code, reason, wasClean: clean });
        }

        send(data) {
            if (this.readyState === NswsSocket.CONNECTING) throw new DOMException("Still in CONNECTING state.", "InvalidStateError");
            if (this.readyState !== NswsSocket.OPEN) return;
            if (this._ws) return this._ws.send(data);
            let kind = KIND_BINARY;
            let bytes;
            if (typeof data === "string") {
                kind = KIND_TEXT;
                bytes = encoder.encode(data);
            } else if (data instanceof ArrayBuffer) {
                bytes = new Uint8Array(data.slice(0));
            } else if (ArrayBuffer.isView(data)) {
                bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
            } else {
                throw new TypeError("Unsupported socket payload");
            }
            this._hub.send(this._ch, kind, bytes);
        }

        close(code, reason) {
            if (this.readyState === NswsSocket.CLOSING || this.readyState === NswsSocket.CLOSED) return;
            if (this._ws) {
                this.readyState = NswsSocket.CLOSING;
                return this._ws.close(code, reason);
            }
            const wasOpen = this.readyState === NswsSocket.OPEN;
            this._closeCode = code ?? 1000;
            this._closeReason = reason ?? "";
            this.readyState = NswsSocket.CLOSED;
            if (wasOpen && this._hub) {
                this._hub.send(this._ch, KIND_CLOSE, closePayload(this._closeCode, this._closeReason));
                this._hub.remove(this._ch);
            }
            // A WebSocket closed by the page itself reports 1005 when no code was given.
            setTimeout(() => this._fire("close", { code: code ?? 1005, reason: reason ?? "", wasClean: true }), 0);
        }

        _fire(type, init) {
            let event;
            if (type === "message") event = new MessageEvent("message", init);
            else if (type === "close") event = new CloseEvent("close", init);
            else event = new Event(type);
            try {
                this["on" + type]?.call(this, event);
            } catch (error) {
                console.error(error);
            }
            this.dispatchEvent(event);
        }
    }

    for (const [name, value] of Object.entries({ CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })) {
        Object.defineProperty(NswsSocket, name, { value });
        Object.defineProperty(NswsSocket.prototype, name, { value });
    }

    window.__nswsSocket = NswsSocket;
})();
