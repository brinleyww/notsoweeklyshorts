// The universal chat: one Durable Object ("global") holding every player's WebSocket, using
// the hibernation API so idle sockets cost nothing. Messages are censored (chatfilter.js)
// before they are stored or sent. IP addresses are never stored; only a hash is kept on
// each socket to cap connections per address.

import { DurableObject } from "cloudflare:workers";
import { censor } from "./chatfilter.js";

const HISTORY = 60;
const MAX_TEXT = 200;
const MAX_NICK = 32;
const MAX_FRAME = 1024;
const SOCKETS_PER_IP = 6;
// Token bucket per socket: BURST messages at once, then one every REFILL_MS.
const BURST = 4;
const REFILL_MS = 1500;
const REPEAT_MS = 20_000;
const MUTE_MINUTES = [10, 60, 1440];

const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
// Invisible characters, bidi overrides and other controls, which could hide or reorder text.
const STRIP = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\u034f\u115f\u1160\u3164\uffa0\u2028\u2029]/gu;

function cleanText(value, max) {
    if (typeof value !== "string") return "";
    const text = value.normalize("NFC").replace(STRIP, "").replace(/\s+/g, " ").trim();
    // Zalgo text: at most two combining marks on any character.
    return [...text.replace(/(\p{M}{2})\p{M}+/gu, "$1")].slice(0, max).join("");
}

function ownerHashes(value) {
    const list = Array.isArray(value) ? value : String(value ?? "").replace(/[[\]"\s]/g, "").split(",");
    return new Set(list.map((h) => String(h).trim().toLowerCase()).filter((h) => HEX64.test(h)));
}

async function sha256Hex(text) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export class ChatRoom extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.sql = ctx.storage.sql;
        this.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, uid TEXT NOT NULL,
            nick TEXT NOT NULL, owner INTEGER NOT NULL DEFAULT 0, text TEXT NOT NULL)`);
        this.sql.exec("CREATE TABLE IF NOT EXISTS mutes (uid TEXT PRIMARY KEY, until INTEGER NOT NULL)");
        ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    }

    // Called by the Worker with the socket's upgrade request, after it has checked the origin.
    async fetch(request) {
        const ipHash = request.headers.get("X-Chat-Ip") || "";
        const open = this.ctx.getWebSockets().filter((ws) => ws.deserializeAttachment()?.ip === ipHash);
        if (ipHash && open.length >= SOCKETS_PER_IP) return new Response("Too many chat windows", { status: 429 });
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1]);
        pair[1].serializeAttachment({ ip: ipHash, joined: false });
        return new Response(null, { status: 101, webSocket: pair[0] });
    }

    send(ws, data) {
        try {
            ws.send(JSON.stringify(data));
        } catch {}
    }

    broadcast(data) {
        const text = JSON.stringify(data);
        for (const ws of this.ctx.getWebSockets()) {
            if (!ws.deserializeAttachment()?.joined) continue;
            try {
                ws.send(text);
            } catch {}
        }
    }

    online() {
        let n = 0;
        for (const ws of this.ctx.getWebSockets()) if (ws.deserializeAttachment()?.joined) n++;
        return n;
    }

    history() {
        return this.sql.exec("SELECT id, at, uid, nick, owner, text FROM messages ORDER BY id DESC LIMIT ?", HISTORY)
            .toArray().reverse().map((m) => ({ ...m, owner: !!m.owner }));
    }

    mutedUntil(uid) {
        const row = this.sql.exec("SELECT until FROM mutes WHERE uid = ?", uid).toArray()[0];
        return row && row.until > Date.now() ? row.until : 0;
    }

    async webSocketMessage(ws, raw) {
        if (typeof raw !== "string" || raw.length > MAX_FRAME) return ws.close(1009, "Too large");
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch {
            return;
        }
        const me = ws.deserializeAttachment() || {};

        if (msg?.t === "hello") {
            if (me.joined) return;
            // A random id the page keeps in localStorage; only its hash is ever shown.
            if (!HEX32.test(msg.v ?? "")) return ws.close(1008, "Bad hello");
            const owner = HEX64.test(msg.key ?? "") && ownerHashes(this.env.OWNER_KEY_HASHES).has(await sha256Hex("nsws-owner:" + msg.key));
            Object.assign(me, {
                joined: true,
                uid: (await sha256Hex("nsws-chat:" + msg.v)).slice(0, 16),
                owner: !!owner,
                tokens: BURST,
                refilled: Date.now(),
                last: "",
                lastAt: 0,
            });
            ws.serializeAttachment(me);
            this.send(ws, { t: "init", you: { uid: me.uid, owner: me.owner }, messages: this.history(), online: this.online() });
            this.broadcast({ t: "online", n: this.online() });
            return;
        }
        if (!me.joined) return;

        if (msg?.t === "msg") {
            const text = cleanText(msg.text, MAX_TEXT);
            if (!text) return;
            const until = this.mutedUntil(me.uid);
            if (until) return this.send(ws, { t: "err", text: "You're muted for " + Math.ceil((until - Date.now()) / 60000) + " more minutes." });
            const now = Date.now();
            me.tokens = Math.min(BURST, me.tokens + (now - me.refilled) / REFILL_MS);
            me.refilled = now;
            if (me.tokens < 1 && !me.owner) return this.send(ws, { t: "err", text: "Slow down a little." });
            if (text === me.last && now - me.lastAt < REPEAT_MS && !me.owner) return this.send(ws, { t: "err", text: "You just sent that." });
            me.tokens -= 1;
            me.last = text;
            me.lastAt = now;
            ws.serializeAttachment(me);

            const nick = censor(cleanText(msg.nick, MAX_NICK)) || "Guest";
            const message = { at: now, uid: me.uid, nick, owner: me.owner, text: censor(text) };
            message.id = this.sql.exec("INSERT INTO messages (at, uid, nick, owner, text) VALUES (?, ?, ?, ?, ?) RETURNING id",
                message.at, message.uid, message.nick, message.owner ? 1 : 0, message.text).one().id;
            this.sql.exec("DELETE FROM messages WHERE id <= ?", message.id - HISTORY);
            this.broadcast({ t: "msg", m: message });
            return;
        }

        if (!me.owner) return;
        if (msg?.t === "del" && Number.isSafeInteger(msg.id)) {
            this.sql.exec("DELETE FROM messages WHERE id = ?", msg.id);
            this.broadcast({ t: "del", id: msg.id });
        } else if (msg?.t === "mute" && /^[0-9a-f]{16}$/.test(msg.uid ?? "") && MUTE_MINUTES.includes(msg.minutes)) {
            this.sql.exec("INSERT OR REPLACE INTO mutes (uid, until) VALUES (?, ?)", msg.uid, Date.now() + msg.minutes * 60000);
            this.sql.exec("DELETE FROM mutes WHERE until < ?", Date.now());
            this.send(ws, { t: "err", text: "Muted for " + msg.minutes + " minutes." });
        } else if (msg?.t === "clear") {
            this.sql.exec("DELETE FROM messages WHERE uid = ?", String(msg.uid ?? ""));
            this.broadcast({ t: "clear", uid: msg.uid });
        }
    }

    async webSocketClose(ws) {
        const was = ws.deserializeAttachment()?.joined;
        ws.serializeAttachment({ joined: false });
        try {
            ws.close();
        } catch {}
        if (was) this.broadcast({ t: "online", n: this.online() });
    }

    async webSocketError(ws) {
        await this.webSocketClose(ws);
    }
}
