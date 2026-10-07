// The universal chat: one Durable Object ("global") holding every player's WebSocket, using
// the hibernation API so idle sockets cost nothing. Networks whose firewall blocks WebSockets
// get the same chat over plain HTTPS long-polling instead (see poll and sendHttp). Messages are censored (chatfilter.js)
// before they are stored or sent. IP addresses are never stored; only a hash is kept on
// each socket to cap connections per address.

import { DurableObject } from "cloudflare:workers";
import { censor } from "./chatfilter.js";

const HISTORY = 60;
const MAX_TEXT = 200;
// Characters of the answered message that a reply keeps to show above itself.
const REPLY_QUOTE = 100;
const MAX_NICK = 32;
const MAX_FRAME = 1024;
// A whole school shares one IP address, so the per-address cap is only there to stop one
// machine opening thousands of sockets. The real per-player cap (one per tab) is on the uid.
const SOCKETS_PER_IP = 100;
const SOCKETS_PER_UID = 6;
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
// How long the room trusts its copy of a player's tag; equipping a new one updates it at once.
const TAG_CACHE_MS = 10 * 60_000;
const TAG_ID = /^[a-z]{1,24}$/;
// Pings: at most MAX_PINGS people per message and PING_BUDGET per PING_WINDOW_MS, and the same
// person no more than once per PING_SAME_MS. Extra @names still show, they just don't notify.
const MAX_PINGS = 3;
const PING_BUDGET = 6;
const PING_WINDOW_MS = 60_000;
const PING_SAME_MS = 15_000;
// Reactions: at most REACT_BUDGET added per REACT_WINDOW_MS, and MAX_REACTION_KINDS different
// emoji on one message.
const REACT_BUDGET = 12;
// Edits: at most EDIT_BUDGET per EDIT_WINDOW_MS for each player.
const EDIT_BUDGET = 8;
const EDIT_WINDOW_MS = 20_000;
const REACT_WINDOW_MS = 15_000;
const MAX_REACTION_KINDS = 20;
// Long-polling, for players whose firewall blocks WebSockets. A poll waits up to POLL_WAIT_MS
// for something to happen; a polling player counts as online until POLL_GONE_MS after their last
// request. The room keeps the last EVENTS_KEPT events for pollers to catch up on, and a player
// can have at most POLLS_PER_UID polls waiting (one per tab), the same caps as for sockets.
const POLL_WAIT_MS = 20_000;
const POLL_GONE_MS = 45_000;
const EVENTS_KEPT = 200;
const POLLS_PER_UID = SOCKETS_PER_UID;
const POLLS_PER_IP = SOCKETS_PER_IP;
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

function jsonReply(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
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
        for (const column of ["pings TEXT", "reply_to TEXT", "edited INTEGER", "tag TEXT"]) {
            try {
                this.sql.exec("ALTER TABLE messages ADD COLUMN " + column);
            } catch {
                // Already there.
            }
        }
        this.sql.exec("CREATE TABLE IF NOT EXISTS mutes (uid TEXT PRIMARY KEY, until INTEGER NOT NULL)");
        this.sql.exec("CREATE TABLE IF NOT EXISTS timeouts (uid TEXT PRIMARY KEY, until INTEGER NOT NULL, level INTEGER NOT NULL)");
        this.sql.exec(`CREATE TABLE IF NOT EXISTS reactions (msg INTEGER NOT NULL, emoji TEXT NOT NULL, uid TEXT NOT NULL,
            nick TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (msg, emoji, uid))`);
        // Per player (uid), not per socket, so several tabs share one limit. See recentActivity.
        this.spam = new Map();
        // Long-polling state. It lives in memory only: the room can't hibernate while a poll is
        // waiting, and when it does restart the new epoch tells every poller to reload.
        this.epoch = crypto.randomUUID();
        this.seq = 0;
        this.events = [];
        this.waiters = new Set();
        this.pollers = new Map();
        this.tags = new Map();
        ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    }

    // Called by the Worker with the socket's upgrade request, after it has checked the origin.
    async fetch(request) {
        const ipHash = request.headers.get("X-Chat-Ip") || "";
        if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") return this.http(request, ipHash);
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
        this.pushEvent(data);
        const text = JSON.stringify(data);
        for (const ws of this.ctx.getWebSockets()) {
            if (!ws.deserializeAttachment()?.joined) continue;
            try {
                ws.send(text);
            } catch {}
        }
    }

    // Called by the Worker with the owner's announcements.
    announce(data) {
        this.broadcast(data);
    }

    // The tag a player's account wears (src/accounts.js), or null. Only new messages carry it.
    async tagOf(uid) {
        const hit = this.tags.get(uid);
        if (hit && Date.now() - hit.at < TAG_CACHE_MS) return hit.tag;
        let tag = null;
        try {
            tag = this.env.ACCOUNTS ? await this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromName("global")).chatTag(uid) : null;
        } catch {
            return hit?.tag ?? null;
        }
        if (this.tags.size > 5000) this.tags.clear();
        this.tags.set(uid, { tag, at: Date.now() });
        return tag;
    }

    // Called by the Worker when an account puts on, takes off or loses a tag.
    retag(uids, tag) {
        if (!Array.isArray(uids)) return;
        tag = TAG_ID.test(tag ?? "") ? tag : null;
        const set = new Set(uids.filter((u) => /^[0-9a-f]{16}$/.test(u)));
        for (const uid of set) this.tags.set(uid, { tag, at: Date.now() });
        for (const ws of this.ctx.getWebSockets()) {
            const a = ws.deserializeAttachment();
            if (!a?.joined || !set.has(a.uid)) continue;
            a.tag = tag;
            ws.serializeAttachment(a);
        }
    }

    online() {
        let n = 0;
        for (const ws of this.ctx.getWebSockets()) if (ws.deserializeAttachment()?.joined) n++;
        return n + this.livePollers().length;
    }

    // Players on the long-polling fallback who have been heard from recently.
    livePollers() {
        const now = Date.now();
        const live = [];
        for (const [uid, p] of this.pollers) {
            if (now - p.seen > POLL_GONE_MS) this.pollers.delete(uid);
            else live.push({ uid, nick: p.nick });
        }
        return live;
    }

    // Who a hello (WebSocket) or an HTTP request says it is. Null if the visitor id is malformed.
    async identify(body) {
        if (!HEX32.test(body?.v ?? "")) return null;
        const owner = HEX64.test(body.key ?? "") && ownerHashes(this.env.OWNER_KEY_HASHES).has(await sha256Hex("nsws-owner:" + body.key));
        return {
            uid: (await sha256Hex("nsws-chat:" + body.v)).slice(0, 16),
            owner: !!owner,
            nick: censor(cleanText(body.nick, MAX_NICK)) || "Guest",
        };
    }

    // Every broadcast is also kept, numbered, for pollers, and wakes the polls that are waiting.
    pushEvent(data) {
        this.events.push({ seq: ++this.seq, data });
        if (this.events.length > EVENTS_KEPT) this.events.splice(0, this.events.length - EVENTS_KEPT);
        for (const waiter of [...this.waiters]) waiter.wake();
    }

    // What a poller at `after` hasn't seen yet, or null if they have fallen too far behind (or are
    // from before a restart) and must reload everything.
    eventsAfter(epoch, after) {
        if (epoch !== this.epoch || !Number.isSafeInteger(after) || after < 0 || after > this.seq) return null;
        if (after === this.seq) return [];
        if (!this.events.length || after < this.events[0].seq - 1) return null;
        return this.events.filter((e) => e.seq > after).map((e) => e.data);
    }

    // The long-polling fallback: POST /poll waits for news, POST /send carries what the page would
    // send over the socket. Both carry the player's id (and the owner's key) in every request,
    // since there is no socket to remember them on.
    async http(request, ipHash) {
        if (request.method !== "POST") return jsonReply({ error: "Method not allowed" }, 405);
        const text = await request.text();
        if (text.length > MAX_FRAME * 2) return jsonReply({ error: "Too large" }, 413);
        let body;
        try {
            body = JSON.parse(text);
        } catch {
            return jsonReply({ error: "Bad request" }, 400);
        }
        const me = await this.identify(body);
        if (!me) return jsonReply({ error: "Bad request" }, 400);
        const path = new URL(request.url).pathname;
        if (path.endsWith("/poll")) return this.poll(me, body, ipHash);
        if (path.endsWith("/send")) {
            if (body?.msg?.t === "msg") me.tag = await this.tagOf(me.uid);
            return this.sendHttp(me, body);
        }
        return jsonReply({ error: "Not found" }, 404);
    }

    touch(me) {
        this.pollers.set(me.uid, { nick: me.nick, seen: Date.now() });
    }

    async poll(me, body, ipHash) {
        let mine = 0;
        let sameIp = 0;
        for (const w of this.waiters) {
            if (w.uid === me.uid) mine++;
            if (ipHash && w.ip === ipHash) sameIp++;
        }
        if (mine >= POLLS_PER_UID || sameIp >= POLLS_PER_IP) return jsonReply({ error: "Too many chat windows" }, 429);
        this.touch(me);
        const ready = this.eventsAfter(body.epoch, body.after);
        if (ready === null) {
            return jsonReply({ epoch: this.epoch, seq: this.seq, init: { you: { uid: me.uid, owner: me.owner }, messages: this.history(), online: this.online() } });
        }
        if (ready.length) return jsonReply({ epoch: this.epoch, seq: this.seq, events: ready });
        const after = body.after;
        return new Promise((resolve) => {
            const waiter = {
                uid: me.uid,
                ip: ipHash,
                wake: () => {
                    clearTimeout(waiter.timer);
                    this.waiters.delete(waiter);
                    resolve(jsonReply({ epoch: this.epoch, seq: this.seq, events: this.eventsAfter(this.epoch, after) ?? [] }));
                },
            };
            waiter.timer = setTimeout(waiter.wake, POLL_WAIT_MS);
            this.waiters.add(waiter);
        });
    }

    async sendHttp(me, body) {
        const msg = body?.msg;
        if (!msg || typeof msg !== "object" || msg.t === "hello" || JSON.stringify(msg).length > MAX_FRAME) {
            return jsonReply({ error: "Bad request" }, 400);
        }
        this.touch(me);
        const replies = [];
        await this.handle(me, msg, (data) => replies.push(data), () => this.touch(me));
        return jsonReply({ replies });
    }

    history() {
        const messages = this.sql.exec("SELECT id, at, uid, nick, owner, text, pings, reply_to, edited, tag FROM messages ORDER BY id DESC LIMIT ?", HISTORY)
            .toArray().reverse().map(({ reply_to, ...m }) => ({
                ...m, owner: !!m.owner, pings: m.pings ? JSON.parse(m.pings) : [], reply: reply_to ? JSON.parse(reply_to) : null, reactions: [],
            }));
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

    // What a reply shows of the message it answers. A copy, so the quote still reads right once
    // the original is deleted or has scrolled out of the history.
    quote(replyTo) {
        if (!Number.isSafeInteger(replyTo?.id)) return null;
        const row = this.sql.exec("SELECT id, uid, nick, text FROM messages WHERE id = ?", replyTo.id).toArray()[0];
        return row ? { id: row.id, uid: row.uid, nick: row.nick, text: [...row.text].slice(0, REPLY_QUOTE).join("") } : null;
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

    react(reply, me, msg) {
        const now = Date.now();
        const e = this.reactionEmoji(msg.e);
        if (!e || !Number.isSafeInteger(msg.id)) return;
        if (!this.sql.exec("SELECT 1 FROM messages WHERE id = ?", msg.id).toArray().length) return;
        const until = this.mutedUntil(me.uid);
        if (until) return reply({ t: "err", text: "You're muted for " + duration(until - now) + "." });
        if (this.sql.exec("SELECT 1 FROM reactions WHERE msg = ? AND emoji = ? AND uid = ?", msg.id, e, me.uid).toArray().length) {
            this.sql.exec("DELETE FROM reactions WHERE msg = ? AND emoji = ? AND uid = ?", msg.id, e, me.uid);
            this.broadcast({ t: "react", id: msg.id, e, uid: me.uid, nick: me.nick, on: false });
            return;
        }
        if (!me.owner) {
            const timeout = this.sql.exec("SELECT until FROM timeouts WHERE uid = ?", me.uid).toArray()[0];
            if (timeout && timeout.until > now) return reply({ t: "err", text: "You're timed out for " + duration(timeout.until - now) + "." });
            const s = this.activity(me.uid, now);
            s.reacts = s.reacts.filter((at) => now - at < REACT_WINDOW_MS);
            if (s.reacts.length >= REACT_BUDGET) return reply({ t: "err", text: "Slow down on the reactions." });
            s.reacts.push(now);
        }
        const kinds = this.sql.exec("SELECT DISTINCT emoji FROM reactions WHERE msg = ?", msg.id).toArray();
        if (kinds.length >= MAX_REACTION_KINDS && !kinds.some((k) => k.emoji === e)) {
            return reply({ t: "err", text: "That message can't take any more different reactions." });
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
        for (const p of this.livePollers()) if (!seen.has(p.uid)) seen.set(p.uid, p.nick);
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
        const s = { last: 0, recent: [], text: "", textAt: 0, pings: [], reacts: [], edits: [] };
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
        for (const row of this.sql.exec("SELECT edited FROM messages WHERE uid = ? AND edited > ?", uid, now - EDIT_WINDOW_MS)) s.edits.push(row.edited);
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
            const who = await this.identify(msg);
            if (!who) return ws.close(1008, "Bad hello");
            const mine = this.ctx.getWebSockets().filter((other) => other !== ws && other.deserializeAttachment()?.uid === who.uid).length;
            if (mine >= SOCKETS_PER_UID) return ws.close(1008, "Too many chat windows");
            who.tag = await this.tagOf(who.uid);
            Object.assign(me, { joined: true, ...who });
            ws.serializeAttachment(me);
            this.send(ws, { t: "init", you: { uid: me.uid, owner: me.owner }, messages: this.history(), online: this.online() });
            return;
        }
        if (!me.joined) return;
        return this.handle(me, msg, (data) => this.send(ws, data), () => ws.serializeAttachment(me));
    }

    // Players edit only their own messages; the owner too. The new text is censored like any
    // message. Pings stay as they were sent, so an edit can't notify anyone.
    edit(reply, me, msg) {
        const text = cleanText(msg.text, MAX_TEXT);
        if (!text || !Number.isSafeInteger(msg.id)) return;
        const row = this.sql.exec("SELECT uid, text FROM messages WHERE id = ?", msg.id).toArray()[0];
        if (!row || row.uid !== me.uid) return;
        const now = Date.now();
        const until = this.mutedUntil(me.uid);
        if (until) return reply({ t: "err", text: "You're muted for " + duration(until - now) + "." });
        if (!me.owner) {
            const s = this.activity(me.uid, now);
            s.edits = s.edits.filter((at) => now - at < EDIT_WINDOW_MS);
            if (s.edits.length >= EDIT_BUDGET) return reply({ t: "err", text: "Slow down on the edits." });
            s.edits.push(now);
        }
        const clean = censor(text);
        if (clean === row.text) return;
        this.sql.exec("UPDATE messages SET text = ?, edited = ? WHERE id = ?", clean, now, msg.id);
        this.broadcast({ t: "edit", id: msg.id, text: clean, edited: now });
    }

    // One message from a player, over either transport. `reply` answers only them; `save`
    // stores a changed nickname wherever that transport keeps it.
    async handle(me, msg, reply, save) {
        if (msg?.t === "who") return reply({ t: "who", users: this.users() });
        if (msg?.t === "react") return this.react(reply, me, msg);
        if (msg?.t === "edit") return this.edit(reply, me, msg);
        // Anyone can delete their own message; the owner can delete anyone's.
        if (msg?.t === "del" && Number.isSafeInteger(msg.id)) {
            const row = this.sql.exec("SELECT uid FROM messages WHERE id = ?", msg.id).toArray()[0];
            if (!row || (row.uid !== me.uid && !me.owner)) return;
            this.sql.exec("DELETE FROM messages WHERE id = ?", msg.id);
            this.sql.exec("DELETE FROM reactions WHERE msg = ?", msg.id);
            this.broadcast({ t: "del", id: msg.id });
            return;
        }

        if (msg?.t === "msg") {
            const text = cleanText(msg.text, MAX_TEXT);
            if (!text) return;
            const until = this.mutedUntil(me.uid);
            if (until) return reply({ t: "err", text: "You're muted for " + duration(until - Date.now()) + "." });
            const now = Date.now();
            const refused = me.owner ? null : this.checkSpam(me.uid, text, now);
            if (refused) return reply(refused);

            const nick = censor(cleanText(msg.nick, MAX_NICK)) || "Guest";
            if (nick !== me.nick) {
                me.nick = nick;
                save();
            }
            const quoted = this.quote(msg.reply);
            const wanted = this.findPings(text, me);
            // Like Discord, a reply pings the person answered unless the sender turned that off.
            if (quoted && msg.reply.ping === true && quoted.uid !== me.uid && !wanted.some((p) => p.uid === quoted.uid)) {
                wanted.unshift({ uid: quoted.uid, nick: quoted.nick });
            }
            const pings = me.owner ? wanted : this.limitPings(me.uid, wanted, now);
            if (pings.length < wanted.length) {
                reply({ t: "err", text: "Too many pings - " + (wanted.length - pings.length) + " of them didn't notify anyone." });
            }
            if (quoted) quoted.ping = pings.some((p) => p.uid === quoted.uid);
            const tag = TAG_ID.test(me.tag ?? "") ? me.tag : null;
            const message = { at: now, uid: me.uid, nick, owner: me.owner, tag, text: censor(text), pings, reply: quoted, reactions: [] };
            message.id = this.sql.exec("INSERT INTO messages (at, uid, nick, owner, text, pings, reply_to, tag) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
                message.at, message.uid, message.nick, message.owner ? 1 : 0, message.text, pings.length ? JSON.stringify(pings) : null,
                quoted ? JSON.stringify(quoted) : null, tag).one().id;
            this.sql.exec("DELETE FROM messages WHERE id <= ?", message.id - HISTORY);
            this.sql.exec("DELETE FROM reactions WHERE msg <= ?", message.id - HISTORY);
            this.broadcast({ t: "msg", m: message });
            return;
        }

        if (!me.owner) return;
        if (msg?.t === "mute" && /^[0-9a-f]{16}$/.test(msg.uid ?? "") && MUTE_MINUTES.includes(msg.minutes)) {
            this.sql.exec("INSERT OR REPLACE INTO mutes (uid, until) VALUES (?, ?)", msg.uid, Date.now() + msg.minutes * 60000);
            this.sql.exec("DELETE FROM mutes WHERE until < ?", Date.now());
            reply({ t: "err", text: "Muted for " + msg.minutes + " minutes." });
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
