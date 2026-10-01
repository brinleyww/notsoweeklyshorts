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
// Slow mode: one message a second per player. The page waits the full second; the server
// allows a little less so network jitter between two sends doesn't reject the second one.
const SLOW_MS = 1000;
const SLOW_SLACK_MS = 150;
// More than SPAM_MAX messages within SPAM_WINDOW_MS earns a timeout of TIMEOUT_S, doubling
// with each repeat, until the player has gone STRIKE_RESET_MS since their last timeout ended.
const SPAM_WINDOW_MS = 20_000;
const SPAM_MAX = 10;
const TIMEOUT_S = 5;
const TIMEOUT_MAX_S = 3600;
const STRIKE_RESET_MS = 10 * 60_000;
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

function duration(ms) {
    const seconds = Math.ceil(ms / 1000);
    if (seconds < 60) return seconds + (seconds === 1 ? " second" : " seconds");
    const minutes = Math.ceil(seconds / 60);
    return minutes + (minutes === 1 ? " minute" : " minutes");
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
        this.sql.exec("CREATE TABLE IF NOT EXISTS timeouts (uid TEXT PRIMARY KEY, until INTEGER NOT NULL, level INTEGER NOT NULL)");
        // Per player (uid), not per socket, so several tabs share one limit. Lost if the room
        // hibernates, which only happens once nobody is sending anything.
        this.spam = new Map();
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

    // Returns the reply that refuses this message, or null to let it through.
    checkSpam(uid, text, now) {
        const timeout = this.sql.exec("SELECT until, level FROM timeouts WHERE uid = ?", uid).toArray()[0];
        if (timeout && timeout.until > now) {
            return { t: "timeout", ms: timeout.until - now, text: "You're timed out for " + duration(timeout.until - now) + "." };
        }
        let s = this.spam.get(uid);
        if (!s) {
            if (this.spam.size > 1000) {
                for (const [key, old] of this.spam) if (now - old.last > SPAM_WINDOW_MS) this.spam.delete(key);
            }
            this.spam.set(uid, s = { last: 0, recent: [], text: "", textAt: 0 });
        }
        if (now - s.last < SLOW_MS - SLOW_SLACK_MS) return { t: "slow", ms: SLOW_MS - (now - s.last) };
        if (text === s.text && now - s.textAt < REPEAT_MS) return { t: "err", text: "You just sent that." };
        s.recent = s.recent.filter((at) => now - at < SPAM_WINDOW_MS);
        if (s.recent.length >= SPAM_MAX) {
            const level = timeout && now - timeout.until < STRIKE_RESET_MS ? timeout.level + 1 : 0;
            const ms = Math.min(TIMEOUT_S * 2 ** level, TIMEOUT_MAX_S) * 1000;
            this.sql.exec("INSERT OR REPLACE INTO timeouts (uid, until, level) VALUES (?, ?, ?)", uid, now + ms, level);
            this.sql.exec("DELETE FROM timeouts WHERE until < ?", now - STRIKE_RESET_MS);
            s.recent = [];
            return { t: "timeout", ms, text: "Too many messages. You're timed out for " + duration(ms) + "." };
        }
        s.last = now;
        s.recent.push(now);
        s.text = text;
        s.textAt = now;
        return null;
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
            if (until) return this.send(ws, { t: "err", text: "You're muted for " + duration(until - Date.now()) + "." });
            const now = Date.now();
            const refused = me.owner ? null : this.checkSpam(me.uid, text, now);
            if (refused) return this.send(ws, refused);

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
