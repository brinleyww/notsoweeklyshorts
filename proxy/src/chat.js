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
// Pings: at most MAX_PINGS people per message and PING_BUDGET per PING_WINDOW_MS, and the same
// person no more than once per PING_SAME_MS. Extra @names still show, they just don't notify.
const MAX_PINGS = 3;
const PING_BUDGET = 6;
const PING_WINDOW_MS = 60_000;
const PING_SAME_MS = 15_000;
// Reactions: at most REACT_BUDGET added per REACT_WINDOW_MS, and MAX_REACTION_KINDS different
// emoji on one message.
const REACT_BUDGET = 12;
const REACT_WINDOW_MS = 15_000;
const MAX_REACTION_KINDS = 20;
// One emoji, as Unicode lists it (a flag, a skin tone or a family count as one).
const ONE_EMOJI = new RegExp("^\\p{RGI_Emoji}$", "v");

const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
// Invisible characters, bidi overrides and other controls, which could hide or reorder text.
const STRIP = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\u034f\u115f\u1160\u3164\uffa0\u2028\u2029]/gu;
// Joins the pieces of emoji like a coder or a family; anywhere else it is just invisible.
const EMOJI_ZWJ = /(?<=\p{Extended_Pictographic}[\u{fe0f}\u{1f3fb}-\u{1f3ff}]?)\u200d(?=\p{Extended_Pictographic})/uy;
// The tag characters that spell out the England, Scotland and Wales flags; elsewhere they hide text.
const FLAG_TAGS = /(\u{1f3f4}[\u{e0061}-\u{e007a}]{4,6}\u{e007f})/u;

function stripInvisible(text) {
    return text.split(FLAG_TAGS).map((part, i) => i % 2 ? part : part.replace(STRIP, (ch, at, all) => {
        if (ch !== "\u200d") return "";
        EMOJI_ZWJ.lastIndex = at;
        return EMOJI_ZWJ.test(all) ? ch : "";
    })).join("");
}

function cleanText(value, max) {
    if (typeof value !== "string") return "";
    const text = stripInvisible(value.normalize("NFC")).replace(/\s+/g, " ").trim();
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
        try {
            this.sql.exec("ALTER TABLE messages ADD COLUMN pings TEXT");
        } catch {
            // Already there.
        }
        this.sql.exec("CREATE TABLE IF NOT EXISTS mutes (uid TEXT PRIMARY KEY, until INTEGER NOT NULL)");
        this.sql.exec("CREATE TABLE IF NOT EXISTS timeouts (uid TEXT PRIMARY KEY, until INTEGER NOT NULL, level INTEGER NOT NULL)");
        this.sql.exec(`CREATE TABLE IF NOT EXISTS reactions (msg INTEGER NOT NULL, emoji TEXT NOT NULL, uid TEXT NOT NULL,
            nick TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (msg, emoji, uid))`);
        // Per player (uid), not per socket, so several tabs share one limit. See recentActivity.
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
        const messages = this.sql.exec("SELECT id, at, uid, nick, owner, text, pings FROM messages ORDER BY id DESC LIMIT ?", HISTORY)
            .toArray().reverse().map((m) => ({ ...m, owner: !!m.owner, pings: m.pings ? JSON.parse(m.pings) : [], reactions: [] }));
        if (!messages.length) return messages;
        const byId = new Map(messages.map((m) => [m.id, m]));
        for (const r of this.sql.exec("SELECT msg, emoji, uid, nick FROM reactions WHERE msg >= ? ORDER BY at", messages[0].id)) {
            const m = byId.get(r.msg);
            if (!m) continue;
            let kind = m.reactions.find((k) => k.e === r.emoji);
            if (!kind) m.reactions.push(kind = { e: r.emoji, users: [] });
            kind.users.push({ uid: r.uid, nick: r.nick });
        }
        return messages;
    }

    // The same emoji can arrive with or without the invisible "show as emoji" selector (U+FE0F);
    // keep one spelling so both land on the same reaction.
    reactionEmoji(value) {
        if (typeof value !== "string" || value.length > 32) return null;
        const bare = value.replaceAll("\uFE0F", "");
        if (ONE_EMOJI.test(bare)) return bare;
        if (ONE_EMOJI.test(value)) return value;
        return ONE_EMOJI.test(bare + "\uFE0F") ? bare + "\uFE0F" : null;
    }

    react(ws, me, msg) {
        const now = Date.now();
        const e = this.reactionEmoji(msg.e);
        if (!e || !Number.isSafeInteger(msg.id)) return;
        if (!this.sql.exec("SELECT 1 FROM messages WHERE id = ?", msg.id).toArray().length) return;
        const until = this.mutedUntil(me.uid);
        if (until) return this.send(ws, { t: "err", text: "You're muted for " + duration(until - now) + "." });
        if (this.sql.exec("SELECT 1 FROM reactions WHERE msg = ? AND emoji = ? AND uid = ?", msg.id, e, me.uid).toArray().length) {
            this.sql.exec("DELETE FROM reactions WHERE msg = ? AND emoji = ? AND uid = ?", msg.id, e, me.uid);
            this.broadcast({ t: "react", id: msg.id, e, uid: me.uid, nick: me.nick, on: false });
            return;
        }
        if (!me.owner) {
            const timeout = this.sql.exec("SELECT until FROM timeouts WHERE uid = ?", me.uid).toArray()[0];
            if (timeout && timeout.until > now) return this.send(ws, { t: "err", text: "You're timed out for " + duration(timeout.until - now) + "." });
            const s = this.activity(me.uid, now);
            s.reacts = s.reacts.filter((at) => now - at < REACT_WINDOW_MS);
            if (s.reacts.length >= REACT_BUDGET) return this.send(ws, { t: "err", text: "Slow down on the reactions." });
            s.reacts.push(now);
        }
        const kinds = this.sql.exec("SELECT DISTINCT emoji FROM reactions WHERE msg = ?", msg.id).toArray();
        if (kinds.length >= MAX_REACTION_KINDS && !kinds.some((k) => k.emoji === e)) {
            return this.send(ws, { t: "err", text: "That message can't take any more different reactions." });
        }
        this.sql.exec("INSERT INTO reactions (msg, emoji, uid, nick, at) VALUES (?, ?, ?, ?, ?)", msg.id, e, me.uid, me.nick, now);
        this.broadcast({ t: "react", id: msg.id, e, uid: me.uid, nick: me.nick, on: true });
    }

    // Everyone online, once per player, for pings and the page's @ suggestions.
    users() {
        const seen = new Map();
        for (const ws of this.ctx.getWebSockets()) {
            const a = ws.deserializeAttachment();
            if (a?.joined && a.nick) seen.set(a.uid, a.nick);
        }
        return [...seen].map(([uid, nick]) => ({ uid, nick }));
    }

    // "@Name" pings whoever is online under that nickname. Nicknames can hold spaces, so the
    // longest one that fits wins ("@Bob Smith" over "@Bob"). Only the owner can ping @everyone.
    findPings(text, me) {
        const users = this.users().filter((u) => u.uid !== me.uid).sort((a, b) => b.nick.length - a.nick.length);
        const lower = text.toLowerCase();
        const found = new Map();
        for (let i = lower.indexOf("@"); i >= 0; i = lower.indexOf("@", i + 1)) {
            // "bob@site.com" isn't a ping.
            if (i > 0 && /[\p{L}\p{N}_]/u.test(lower[i - 1])) continue;
            const rest = lower.slice(i + 1);
            if (me.owner && /^everyone(?![\p{L}\p{N}_])/u.test(rest)) {
                found.set("*", "everyone");
                continue;
            }
            let length = 0;
            for (const u of users) {
                const nick = u.nick.toLowerCase();
                if (nick.length < length) break;
                if (rest.startsWith(nick) && !/^[\p{L}\p{N}_]/u.test(rest.slice(nick.length))) {
                    length = nick.length;
                    found.set(u.uid, u.nick);
                }
            }
        }
        return [...found].map(([uid, nick]) => ({ uid, nick }));
    }

    limitPings(uid, pings, now) {
        const s = this.spam.get(uid);
        if (!s) return pings.slice(0, MAX_PINGS);
        s.pings = (s.pings || []).filter((p) => now - p.at < PING_WINDOW_MS);
        const kept = [];
        for (const p of pings) {
            if (kept.length >= MAX_PINGS || s.pings.length >= PING_BUDGET) break;
            if (s.pings.some((q) => q.uid === p.uid && now - q.at < PING_SAME_MS)) continue;
            s.pings.push({ uid: p.uid, at: now });
            kept.push(p);
        }
        return kept;
    }

    mutedUntil(uid) {
        const row = this.sql.exec("SELECT until FROM mutes WHERE uid = ?", uid).toArray()[0];
        return row && row.until > Date.now() ? row.until : 0;
    }

    // A player's spam and ping counters, rebuilt from the stored messages. The in-memory copy is
    // lost whenever the room hibernates, which a quiet few seconds is enough for.
    recentActivity(uid, now) {
        const s = { last: 0, recent: [], text: "", textAt: 0, pings: [], reacts: [] };
        const rows = this.sql.exec("SELECT at, text, pings FROM messages WHERE uid = ? AND at > ? ORDER BY id",
            uid, now - Math.max(SPAM_WINDOW_MS, PING_WINDOW_MS, REPEAT_MS)).toArray();
        for (const row of rows) {
            s.last = row.at;
            if (now - row.at < SPAM_WINDOW_MS) s.recent.push(row.at);
            s.text = row.text;
            s.textAt = row.at;
            for (const p of row.pings ? JSON.parse(row.pings) : []) s.pings.push({ uid: p.uid, at: row.at });
        }
        for (const row of this.sql.exec("SELECT at FROM reactions WHERE uid = ? AND at > ?", uid, now - REACT_WINDOW_MS)) s.reacts.push(row.at);
        return s;
    }

    activity(uid, now) {
        let s = this.spam.get(uid);
        if (!s) {
            if (this.spam.size > 1000) {
                for (const [key, old] of this.spam) if (now - old.last > PING_WINDOW_MS) this.spam.delete(key);
            }
            this.spam.set(uid, s = this.recentActivity(uid, now));
        }
        return s;
    }

    // Returns the reply that refuses this message, or null to let it through.
    checkSpam(uid, text, now) {
        const timeout = this.sql.exec("SELECT until, level FROM timeouts WHERE uid = ?", uid).toArray()[0];
        if (timeout && timeout.until > now) {
            return { t: "timeout", ms: timeout.until - now, text: "You're timed out for " + duration(timeout.until - now) + "." };
        }
        const s = this.activity(uid, now);
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
                nick: censor(cleanText(msg.nick, MAX_NICK)) || "Guest",
            });
            ws.serializeAttachment(me);
            this.send(ws, { t: "init", you: { uid: me.uid, owner: me.owner }, messages: this.history(), online: this.online() });
            return;
        }
        if (!me.joined) return;

        if (msg?.t === "who") return this.send(ws, { t: "who", users: this.users() });
        if (msg?.t === "react") return this.react(ws, me, msg);

        if (msg?.t === "msg") {
            const text = cleanText(msg.text, MAX_TEXT);
            if (!text) return;
            const until = this.mutedUntil(me.uid);
            if (until) return this.send(ws, { t: "err", text: "You're muted for " + duration(until - Date.now()) + "." });
            const now = Date.now();
            const refused = me.owner ? null : this.checkSpam(me.uid, text, now);
            if (refused) return this.send(ws, refused);

            const nick = censor(cleanText(msg.nick, MAX_NICK)) || "Guest";
            if (nick !== me.nick) {
                me.nick = nick;
                ws.serializeAttachment(me);
            }
            const wanted = this.findPings(text, me);
            const pings = me.owner ? wanted : this.limitPings(me.uid, wanted, now);
            if (pings.length < wanted.length) {
                this.send(ws, { t: "err", text: "Too many pings - " + (wanted.length - pings.length) + " of them didn't notify anyone." });
            }
            const message = { at: now, uid: me.uid, nick, owner: me.owner, text: censor(text), pings, reactions: [] };
            message.id = this.sql.exec("INSERT INTO messages (at, uid, nick, owner, text, pings) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
                message.at, message.uid, message.nick, message.owner ? 1 : 0, message.text, pings.length ? JSON.stringify(pings) : null).one().id;
            this.sql.exec("DELETE FROM messages WHERE id <= ?", message.id - HISTORY);
            this.sql.exec("DELETE FROM reactions WHERE msg <= ?", message.id - HISTORY);
            this.broadcast({ t: "msg", m: message });
            return;
        }

        if (!me.owner) return;
        if (msg?.t === "del" && Number.isSafeInteger(msg.id)) {
            this.sql.exec("DELETE FROM messages WHERE id = ?", msg.id);
            this.sql.exec("DELETE FROM reactions WHERE msg = ?", msg.id);
            this.broadcast({ t: "del", id: msg.id });
        } else if (msg?.t === "mute" && /^[0-9a-f]{16}$/.test(msg.uid ?? "") && MUTE_MINUTES.includes(msg.minutes)) {
            this.sql.exec("INSERT OR REPLACE INTO mutes (uid, until) VALUES (?, ?)", msg.uid, Date.now() + msg.minutes * 60000);
            this.sql.exec("DELETE FROM mutes WHERE until < ?", Date.now());
            this.send(ws, { t: "err", text: "Muted for " + msg.minutes + " minutes." });
        } else if (msg?.t === "clear") {
            this.sql.exec("DELETE FROM messages WHERE uid = ?", String(msg.uid ?? ""));
            this.sql.exec("DELETE FROM reactions WHERE uid = ? OR msg NOT IN (SELECT id FROM messages)", String(msg.uid ?? ""));
            this.broadcast({ t: "clear", uid: msg.uid });
        }
    }

    async webSocketClose(ws) {
        ws.serializeAttachment({ joined: false });
        try {
            ws.close();
        } catch {}
    }

    async webSocketError(ws) {
        await this.webSocketClose(ws);
    }
}
