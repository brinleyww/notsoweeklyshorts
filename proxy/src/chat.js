// The universal chat: one Durable Object ("global") holding every player's WebSocket, using
// the hibernation API so idle sockets cost nothing. Networks whose firewall blocks WebSockets
// get the same chat over plain HTTPS long-polling instead (see poll and sendHttp). Messages are censored (chatfilter.js)
// before they are stored or sent. IP addresses are never stored; only a hash is kept on
// each socket to cap connections per address, and on each message so the owner can ban its sender.

import { DurableObject } from "cloudflare:workers";
import { censor, cleanText } from "./chatfilter.js";
import { sniffImage, moderate } from "./chatmedia.js";
import { checkFile, MAX_FILE_NAME } from "./chatfiles.js";
import { IP_BAN_DAYS, readBanReason } from "./traffic.js";

const HISTORY = 60;
const MAX_TEXT = 200;
// Characters of the answered message that a reply keeps to show above itself.
const REPLY_QUOTE = 100;
const MAX_NICK = 32;
const MAX_FRAME = 2048;
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
// Messages one address may send in a window, whatever ids it sends them under (a classroom shares one address).
const IP_SPAM_WINDOW_MS = 20_000;
const IP_SPAM_MAX = 40;
const TIMEOUT_S = 5;
const TIMEOUT_MAX_S = 3600;
const STRIKE_RESET_MS = 10 * 60_000;
const REPEAT_MS = 20_000;
const MUTE_MINUTES = [10, 60, 1440];
// How long the room trusts its copy of a player's tag; equipping a new one updates it at once.
const TAG_CACHE_MS = 10 * 60_000;
// A tag id, with a count for the NSWS King ("king:7").
const TAG_ID = /^[a-z]{1,24}(:[0-9]{1,5})?$/;
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
const POLL_WAIT_MS = 25_000;
// Each event brings every waiting poller straight back. Past POLL_CROWD of them, replies ask the
// page to wait a little (POLL_GAP_STEP_MS per extra poller) before polling again.
const POLL_CROWD = 5;
const POLL_GAP_STEP_MS = 500;
const POLL_GAP_MAX_MS = 10_000;
const POLL_GONE_MS = 45_000;
const EVENTS_KEPT = 200;
const POLLS_PER_UID = SOCKETS_PER_UID;
const POLLS_PER_IP = SOCKETS_PER_IP;
// One emoji, as Unicode lists it (a flag, a skin tone or a family count as one).
const ONE_EMOJI = new RegExp("^\\p{RGI_Emoji}$", "v");

// Cup chats (one room per cup code, see handleChat in worker.js): the organizer's mutes last for the
// cup, and a room nobody has joined for CUP_KEEP_MS is wiped.
const CUP_MUTE_MS = 24 * 3600_000;
const CUP_KEEP_MS = 24 * 3600_000;
// A mute or ban also covers new chat ids on the same address for this long after it is set (see inherited).
const EVADE_MS = 24 * 3600_000;
// Different players one address may have on the long-polling fallback at once.
const POLLERS_PER_IP = 100;
// Model checks one address may use up in a day, out of AI_CHECKS_PER_DAY for everyone.
const AI_CHECKS_PER_IP_DAY = 40;

// Whispers (main room only) go to the sender and the chat ids of the account holding the name, and
// nowhere else: not the history, the events pollers share, "who" or any broadcast. They are kept
// WHISPER_KEEP_MS so a tab that reconnects (or polls) still gets them. A sender reaches at most
// WHISPER_PEOPLE different names per WHISPER_PEOPLE_MS; a name's lookup is trusted WHISPER_NAME_MS.
const WHISPER_KEEP_MS = 30 * 60_000;
const WHISPERS_SHOWN = 40;
const WHISPER_PEOPLE = 8;
const WHISPER_PEOPLE_MS = 10 * 60_000;
const WHISPER_NAME_MS = 5 * 60_000;
const WHISPER_UIDS = 20;

// Uploaded images, GIFs and other files (stored in the main room only; cup rooms ask it through
// cupMedia). A file is kept while a message shows it, and for PENDING_MS after its upload so the
// message can follow. Stored in parts because a SQLite
// value can be at most 2 MB. Only images are checked by the model; other files are served as
// downloads (video and audio as themselves, so the chat can play them).
const MAX_UPLOAD = 10 * 1024 * 1024;
const MAX_STILL = 4 * 1024 * 1024;
const PART = 1_000_000;
const PENDING_MS = 15 * 60_000;
const UPLOADS_PER_MINUTE = 5;
const UPLOADS_PER_DAY = 40;
const UPLOADS_PER_IP_DAY = 200;
// Model checks a day for the whole chat, to stay inside the free Workers AI allowance.
const AI_CHECKS_PER_DAY = 300;
// A verdict is remembered by the file's hash, so posting the same file again costs no check.
const VERDICT_MS = 30 * 86400_000;
const FILE_ID = /^[0-9a-f]{32}$/;
// GIFs from KLIPY's search, which the page calls itself. Only KLIPY media URLs are accepted, so a
// message can't make everyone's browser load an image from anywhere else.
const KLIPY_URL = /^https:\/\/static[12]?\.klipy\.com\/[A-Za-z0-9._~\/-]{1,250}(\?[A-Za-z0-9._~=&%-]{0,200})?$/;
const KLIPY_SLUG = /^[A-Za-z0-9_-]{1,120}$/;

const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
function ownerHashes(value) {
    const list = Array.isArray(value) ? value : String(value ?? "").replace(/[[\]"\s]/g, "").split(",");
    return new Set(list.map((h) => String(h).trim().toLowerCase()).filter((h) => HEX64.test(h)));
}

function banLeft(ms) {
    const hours = Math.ceil(ms / 3600_000);
    if (hours < 48) return hours + (hours === 1 ? " hour" : " hours");
    return Math.ceil(hours / 24) + " days";
}

function duration(ms) {
    const seconds = Math.ceil(ms / 1000);
    if (seconds < 60) return seconds + (seconds === 1 ? " second" : " seconds");
    const minutes = Math.ceil(seconds / 60);
    return minutes + (minutes === 1 ? " minute" : " minutes");
}

// What a message carries for an upload. Files that aren't images also have their name and size.
function fileMedia(row) {
    const f = { id: row.id, type: row.type, w: row.w, h: row.h };
    if (row.name != null) {
        f.name = row.name;
        f.size = row.size;
    }
    return f;
}

function attachmentHeader(name) {
    const plain = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
    const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
    return "attachment; filename=\"" + plain + "\"; filename*=UTF-8''" + encoded;
}

function jsonReply(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
}

// What "You just sent that" compares: the text and whatever image or GIF came with it.
function repeatKey(text, file, gif) {
    return file || gif ? text + "\u0000" + (file || gif) : text;
}

async function sha256Hex(data) {
    const digest = await crypto.subtle.digest("SHA-256", typeof data === "string" ? new TextEncoder().encode(data) : data);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export class ChatRoom extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.sql = ctx.storage.sql;
        this.schema();
        // Per player (uid), not per socket, so several tabs share one limit. See recentActivity.
        this.spam = new Map();
        this.ipSpam = new Map();
        this.ids = new Map();
        // Long-polling state. It lives in memory only: the room can't hibernate while a poll is
        // waiting, and when it does restart the new epoch tells every poller to reload.
        this.epoch = crypto.randomUUID();
        this.seq = 0;
        this.events = [];
        this.waiters = new Set();
        this.pollers = new Map();
        this.tags = new Map();
        this.whisperNames = new Map();
        // Chat ids that got a whisper since this instance started. A poller from before a restart
        // reloads (new epoch), and that reload reads its whispers, so only these need looking up.
        this.whisperUids = new Set();
        this.lastWhisperId = 0;
        ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    }

    schema() {
        this.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, uid TEXT NOT NULL,
            nick TEXT NOT NULL, owner INTEGER NOT NULL DEFAULT 0, text TEXT NOT NULL)`);
        this.sql.exec("CREATE TABLE IF NOT EXISTS ip_blocks (ip TEXT PRIMARY KEY, until INTEGER)");
        // Account bans (src/traffic.js user_bans), by the chat ids linked to the account. chat = chat only.
        this.sql.exec("CREATE TABLE IF NOT EXISTS user_blocks (uid TEXT PRIMARY KEY, user_id TEXT NOT NULL, until INTEGER, chat INTEGER NOT NULL, reason TEXT)");
        for (const column of ["pings TEXT", "reply_to TEXT", "edited INTEGER", "tag TEXT", "media TEXT", "file TEXT", "gif TEXT", "ip TEXT"]) {
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
        this.sql.exec(`CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, hash TEXT NOT NULL, type TEXT NOT NULL,
            w INTEGER NOT NULL, h INTEGER NOT NULL, size INTEGER NOT NULL, at INTEGER NOT NULL)`);
        try {
            this.sql.exec("ALTER TABLE files ADD COLUMN name TEXT");
        } catch {
            // Already there.
        }
        this.sql.exec("CREATE TABLE IF NOT EXISTS file_parts (id TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (id, part))");
        this.sql.exec("CREATE TABLE IF NOT EXISTS verdicts (hash TEXT PRIMARY KEY, ok INTEGER NOT NULL, why TEXT, at INTEGER NOT NULL)");
        this.sql.exec("CREATE TABLE IF NOT EXISTS uploads (at INTEGER NOT NULL, uid TEXT NOT NULL, ip TEXT NOT NULL)");
        this.sql.exec("CREATE INDEX IF NOT EXISTS uploads_uid ON uploads (uid, at)");
        this.sql.exec("CREATE INDEX IF NOT EXISTS uploads_ip ON uploads (ip, at)");
        this.sql.exec("CREATE INDEX IF NOT EXISTS uploads_at ON uploads (at)");
        this.sql.exec("CREATE TABLE IF NOT EXISTS ai_days (day TEXT PRIMARY KEY, checks INTEGER NOT NULL)");
        this.sql.exec("CREATE TABLE IF NOT EXISTS banned_gifs (slug TEXT PRIMARY KEY, at INTEGER NOT NULL)");
        // One row per chat id that may see the whisper (the sender's and the recipient's).
        this.sql.exec("CREATE TABLE IF NOT EXISTS whispers (id INTEGER NOT NULL, uid TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL, ip TEXT, PRIMARY KEY (uid, id))");
        this.sql.exec("CREATE INDEX IF NOT EXISTS whispers_at ON whispers (at)");
        for (const [table, column] of [["mutes", "ip TEXT"], ["mutes", "at INTEGER"], ["user_blocks", "ip TEXT"], ["user_blocks", "at INTEGER"], ["uploads", "checked INTEGER"]]) {
            try {
                this.sql.exec("ALTER TABLE " + table + " ADD COLUMN " + column);
            } catch {
                // Already there.
            }
        }
        this.sql.exec("CREATE INDEX IF NOT EXISTS mutes_ip ON mutes (ip)");
        this.sql.exec("CREATE INDEX IF NOT EXISTS user_blocks_ip ON user_blocks (ip)");
        // When each chat id was first seen and the address it last came from.
        this.sql.exec("CREATE TABLE IF NOT EXISTS chat_ids (uid TEXT PRIMARY KEY, first INTEGER NOT NULL, ip TEXT)");
    }

    async alarm() {
        // Only cup rooms are emptied; the main chat never is, whatever set the alarm.
        if (this.ctx.id.name === "global") return;
        await this.ctx.storage.deleteAll();
        this.schema();
    }

    cupMutes() {
        return this.sql.exec("SELECT uid FROM mutes WHERE until > ?", Date.now()).toArray().map((r) => r.uid);
    }

    // Called by the Worker with the socket's upgrade request, after it has checked the origin.
    async fetch(request) {
        const ipHash = request.headers.get("X-Chat-Ip") || "";
        if (ipHash && this.ipBlocked(ipHash)) return jsonReply({ error: "Banned" }, 403);
        if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
            const path = new URL(request.url).pathname;
            if (path.includes("/file/")) return this.file(path.slice(path.lastIndexOf("/") + 1), request.headers.get("Range"));
            if (path.endsWith("/upload")) return this.upload(request, ipHash);
            return this.http(request, ipHash);
        }
        const open = this.ctx.getWebSockets().filter((ws) => ws.deserializeAttachment()?.ip === ipHash);
        if (ipHash && open.length >= SOCKETS_PER_IP) return new Response("Too many chat windows", { status: 429 });
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1]);
        const cup = request.headers.get("X-Chat-Cup") || null;
        // Set here too, so a cup room nobody ever says hello in is still emptied.
        if (cup && (await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + CUP_KEEP_MS);
        pair[1].serializeAttachment({ ip: ipHash, joined: false, cup });
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

    // The Worker's own ban list reaches its other instances up to a few minutes late. Without this copy, a
    // kicked player could reconnect through one of them and then keep that socket for good.
    ipBlocked(ip) {
        const row = this.sql.exec("SELECT until FROM ip_blocks WHERE ip = ?", ip).toArray()[0];
        return !!row && (row.until == null || row.until > Date.now());
    }

    blockIp(ip, until) {
        this.sql.exec("INSERT OR REPLACE INTO ip_blocks (ip, until) VALUES (?, ?)", ip, until);
        this.sql.exec("DELETE FROM ip_blocks WHERE until IS NOT NULL AND until <= ?", Date.now());
        for (const ws of this.ctx.getWebSockets()) {
            if (ws.deserializeAttachment()?.ip !== ip) continue;
            try {
                ws.close(1008, "Banned");
            } catch {}
        }
        for (const waiter of [...this.waiters]) {
            if (waiter.ip === ip) waiter.wake();
        }
    }

    unblockIp(ip) {
        this.sql.exec("DELETE FROM ip_blocks WHERE ip = ?", ip);
    }

    // Called by the Worker for a ban, and again when a banned account links another browser's chat.
    blockUser(userId, uids, until, chat, reason) {
        for (const uid of (uids ?? []).filter((u) => /^[0-9a-f]{16}$/.test(u))) {
            this.sql.exec(`INSERT INTO user_blocks (uid, user_id, until, chat, reason, ip, at) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (uid) DO UPDATE SET user_id = excluded.user_id, until = excluded.until, chat = excluded.chat, reason = excluded.reason,
                    ip = COALESCE(ip, excluded.ip), at = COALESCE(at, excluded.at)`,
                uid, userId, until, chat ? 1 : 0, reason ?? null, this.ipOfUid(uid), Date.now());
        }
        this.sql.exec("DELETE FROM user_blocks WHERE until IS NOT NULL AND until <= ?", Date.now());
    }

    unblockUser(userId) {
        this.sql.exec("DELETE FROM user_blocks WHERE user_id = ?", userId);
    }

    // What a banned account is told when it tries to post, or null.
    bannedText(me) {
        if (me.ban?.text) return me.ban.text;
        let row = this.sql.exec("SELECT until, chat, reason FROM user_blocks WHERE uid = ?", me.uid).toArray()[0];
        if (!row || (row.until != null && row.until <= Date.now())) row = this.inherited("user_blocks", me);
        if (!row) return null;
        const text = (row.chat ? "You're banned from the chat" : "Your account is banned") + (row.until ? " for another " + banLeft(row.until - Date.now()) + "." : ".");
        return row.reason ? text + " " + row.reason : text;
    }

    // For a cup room, which keeps no account bans of its own.
    chatBan(me) {
        const text = this.bannedText({ uid: me?.uid, ip: me?.ip, owner: me?.owner === true });
        return text ? { text } : null;
    }

    noteId(me) {
        if (!me?.uid || !me.ip || this.ids.get(me.uid) === me.ip) return;
        if (this.ids.size > 5000) this.ids.clear();
        this.ids.set(me.uid, me.ip);
        this.sql.exec("INSERT INTO chat_ids (uid, first, ip) VALUES (?, ?, ?) ON CONFLICT (uid) DO UPDATE SET ip = excluded.ip WHERE ip IS NOT excluded.ip", me.uid, Date.now(), me.ip);
    }

    ipOfUid(uid) {
        const socket = this.ctx.getWebSockets().map((ws) => ws.deserializeAttachment()).find((a) => a?.uid === uid && a.ip);
        return socket?.ip ?? this.sql.exec("SELECT ip FROM chat_ids WHERE uid = ?", uid).toArray()[0]?.ip
            ?? this.sql.exec("SELECT ip FROM messages WHERE uid = ? AND ip IS NOT NULL ORDER BY id DESC LIMIT 1", uid).toArray()[0]?.ip ?? null;
    }

    // A muted or banned player coming back under a new chat id: for EVADE_MS after it was set, a mute or ban also
    // covers ids first seen after it on the same address. Ids already chatting from that address are left alone.
    inherited(table, me) {
        if (!me?.ip || me.owner) return null;
        const now = Date.now();
        const rows = this.sql.exec("SELECT * FROM " + table + " WHERE ip = ? AND uid != ? AND at > ?", me.ip, me.uid, now - EVADE_MS).toArray()
            .filter((r) => r.until == null || r.until > now);
        if (!rows.length) return null;
        const first = this.sql.exec("SELECT first FROM chat_ids WHERE uid = ?", me.uid).toArray()[0]?.first ?? now;
        return rows.find((r) => first > r.at) ?? null;
    }

    // The tag a player's account wears and whether the name they send is another account's (src/accounts.js).
    async whoIs(uid, nick) {
        const hit = this.tags.get(uid);
        if (hit && hit.nick === nick && Date.now() - hit.at < TAG_CACHE_MS) return hit;
        let who;
        try {
            who = this.env.ACCOUNTS ? await this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromName("global")).chatWho(uid, nick) : { tag: null, taken: false };
        } catch {
            return { tag: hit?.tag ?? null, taken: false };
        }
        if (this.tags.size > 5000) this.tags.clear();
        const kept = { tag: who?.tag ?? null, taken: who?.taken === true, nick, at: Date.now() };
        this.tags.set(uid, kept);
        return kept;
    }

    // Someone else's name shows as Guest; the owner's badge is checked by key, so the owner is left alone.
    async settle(me) {
        const who = await this.whoIs(me.uid, me.nick);
        me.tag = who.tag;
        if (who.taken && !me.owner) me.nick = "Guest";
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
        me.ip = ipHash;
        const path = new URL(request.url).pathname;
        if (!path.endsWith("/poll") && !path.endsWith("/send")) return jsonReply({ error: "Not found" }, 404);
        await this.settle(me);
        if (path.endsWith("/poll")) return this.poll(me, body, ipHash);
        if (path.endsWith("/send")) return this.sendHttp(me, body);
        return jsonReply({ error: "Not found" }, 404);
    }

    touch(me) {
        this.pollers.set(me.uid, { nick: me.nick, seen: Date.now(), ip: me.ip });
        this.noteId(me);
    }

    async poll(me, body, ipHash) {
        let mine = 0;
        let sameIp = 0;
        for (const w of this.waiters) {
            if (w.uid === me.uid) mine++;
            if (ipHash && w.ip === ipHash) sameIp++;
        }
        if (mine >= POLLS_PER_UID || sameIp >= POLLS_PER_IP) return jsonReply({ error: "Too many chat windows" }, 429);
        if (ipHash && !this.pollers.has(me.uid) && this.livePollers().length && [...this.pollers.values()].filter((p) => p.ip === ipHash).length >= POLLERS_PER_IP) {
            return jsonReply({ error: "Too many chat windows" }, 429);
        }
        this.touch(me);
        const ready = this.eventsAfter(body.epoch, body.after);
        const wafter = Number.isSafeInteger(body.wafter) ? body.wafter : 0;
        if (ready === null) {
            return jsonReply({ epoch: this.epoch, seq: this.seq, gap: this.pollGap(), init: { you: { uid: me.uid, owner: me.owner }, messages: this.history(), whispers: this.whispersFor(me.uid, 0) } });
        }
        const whispers = this.newWhispers(me.uid, wafter);
        if (ready.length || whispers.length) return jsonReply({ epoch: this.epoch, seq: this.seq, gap: this.pollGap(), events: ready, whispers });
        const after = body.after;
        return new Promise((resolve) => {
            const waiter = {
                uid: me.uid,
                ip: ipHash,
                wake: () => {
                    clearTimeout(waiter.timer);
                    this.waiters.delete(waiter);
                    resolve(jsonReply({ epoch: this.epoch, seq: this.seq, gap: this.pollGap(), events: this.eventsAfter(this.epoch, after) ?? [], whispers: this.newWhispers(me.uid, wafter) }));
                },
            };
            waiter.timer = setTimeout(waiter.wake, POLL_WAIT_MS);
            this.waiters.add(waiter);
        });
    }

    pollGap() {
        const extra = this.livePollers().length - POLL_CROWD;
        return extra > 0 ? Math.min(POLL_GAP_MAX_MS, extra * POLL_GAP_STEP_MS) : 0;
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

    // GET /file/<id>: an upload, while a message (or a pending upload) still has it. Ranges are
    // answered because Safari only plays video that way.
    file(id, range) {
        const row = FILE_ID.test(id) ? this.sql.exec("SELECT type, size, name FROM files WHERE id = ?", id).toArray()[0] : null;
        if (!row) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
        const headers = {
            "Content-Type": row.type,
            // The id is the file's hash, so its bytes never change.
            "Cache-Control": "public, max-age=31536000, immutable",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "Access-Control-Allow-Origin": "*",
            "Accept-Ranges": "bytes",
        };
        if (row.name != null && row.type === "application/octet-stream") headers["Content-Disposition"] = attachmentHeader(row.name);
        let start = 0;
        let end = row.size - 1;
        const asked = /^bytes=(\d*)-(\d*)$/.exec(range ?? "");
        if (asked && (asked[1] || asked[2])) {
            if (asked[1]) {
                start = Number(asked[1]);
                if (asked[2]) end = Math.min(end, Number(asked[2]));
            } else {
                start = Math.max(0, row.size - Number(asked[2]));
            }
            if (start > end || start >= row.size) {
                return new Response(null, { status: 416, headers: { ...headers, "Content-Range": "bytes */" + row.size } });
            }
        }
        const first = Math.floor(start / PART);
        const last = Math.floor(end / PART);
        const parts = this.sql.exec("SELECT data FROM file_parts WHERE id = ? AND part BETWEEN ? AND ? ORDER BY part", id, first, last)
            .toArray().map((r) => new Uint8Array(r.data));
        if (start === 0 && end === row.size - 1) return new Response(new Blob(parts), { headers });
        const body = new Blob(parts).slice(start - first * PART, end + 1 - first * PART);
        return new Response(body, { status: 206, headers: { ...headers, "Content-Range": "bytes " + start + "-" + end + "/" + row.size } });
    }

    // POST /upload: [4-byte little-endian header length][header JSON: v, key, name][file bytes].
    // Images are checked by the model; anything else needs a name and goes through checkFile. Stored
    // under its hash and answered with { file: fileMedia(...) }. A message then shows it with
    // media: { f: id }.
    async upload(request, ipHash) {
        if (request.method !== "POST") return jsonReply({ error: "Method not allowed" }, 405);
        const body = new Uint8Array(await request.arrayBuffer());
        if (body.length < 8 || body.length > MAX_UPLOAD + 4096) return jsonReply({ error: "That file is too big (10 MB at most)." }, 413);
        const headerLength = new DataView(body.buffer).getUint32(0, true);
        if (headerLength > 4096 || 4 + headerLength >= body.length) return jsonReply({ error: "Bad request" }, 400);
        let header;
        try {
            header = JSON.parse(new TextDecoder().decode(body.subarray(4, 4 + headerLength)));
        } catch {
            return jsonReply({ error: "Bad request" }, 400);
        }
        const me = await this.identify(header);
        if (!me) return jsonReply({ error: "Bad request" }, 400);
        me.ip = ipHash;
        this.noteId(me);
        const bytes = body.subarray(4 + headerLength);
        if (bytes.length > MAX_UPLOAD) return jsonReply({ error: "That file is too big (10 MB at most)." }, 413);
        const now = Date.now();
        const banned = this.bannedText(me);
        if (banned) return jsonReply({ error: banned });
        const until = this.mutedUntil(me);
        if (until) return jsonReply({ error: "You're muted for " + duration(until - now) + "." });
        if (!me.owner) {
            const timeout = this.sql.exec("SELECT until FROM timeouts WHERE uid = ?", me.uid).toArray()[0];
            if (timeout && timeout.until > now) return jsonReply({ error: "You're timed out for " + duration(timeout.until - now) + "." });
        }
        let info = sniffImage(bytes);
        if (info) {
            if (info.animated && info.type !== "image/gif") return jsonReply({ error: "Animated images have to be GIFs." });
            if (info.type !== "image/gif" && bytes.length > MAX_STILL) return jsonReply({ error: "That image is too big (4 MB at most)." });
        } else {
            if (typeof header.name !== "string") return jsonReply({ error: "That isn't an image the chat can show (GIF, PNG, JPEG or WebP)." });
            const checked = checkFile(bytes, censor(cleanText(header.name, MAX_FILE_NAME)));
            if (checked.error) return jsonReply({ error: checked.error });
            // Nothing here can look inside a video, so only the owner's play in the chat; anyone else's is a download.
            info = { type: !me.owner && checked.type.startsWith("video/") ? "application/octet-stream" : checked.type, w: 0, h: 0, name: checked.name };
        }

        this.sql.exec("DELETE FROM uploads WHERE at < ?", now - 86400_000);
        if (!me.owner) {
            const count = (where, ...args) => this.sql.exec("SELECT COUNT(*) AS n FROM uploads WHERE " + where, ...args).one().n;
            if (count("uid = ? AND at > ?", me.uid, now - 60_000) >= UPLOADS_PER_MINUTE) return jsonReply({ error: "Slow down on the uploads." });
            if (count("uid = ? AND at > ?", me.uid, now - 86400_000) >= UPLOADS_PER_DAY) return jsonReply({ error: "That's all the uploads for today. GIF search still works." });
            if (ipHash && count("ip = ? AND at > ?", ipHash, now - 86400_000) >= UPLOADS_PER_IP_DAY) return jsonReply({ error: "Your network has hit today's upload limit." });
        }
        const uploadRow = this.sql.exec("INSERT INTO uploads (at, uid, ip) VALUES (?, ?, ?) RETURNING rowid AS id", now, me.uid, ipHash).one().id;

        const hash = await sha256Hex(bytes);
        const id = hash.slice(0, 32);
        this.dropPendingFiles(now);
        const stored = this.sql.exec("SELECT id FROM files WHERE id = ?", id).toArray()[0];
        let verdict = this.sql.exec("SELECT ok, why FROM verdicts WHERE hash = ? AND at > ?", hash, now - VERDICT_MS).toArray()[0];
        if (verdict && !verdict.ok) return jsonReply({ error: "That " + (info.name != null ? "file" : "image") + " isn't allowed in the chat (" + (verdict.why || "blocked") + ")." });
        if (!verdict && !stored && !me.owner && info.name == null) {
            const day = new Date(now).toISOString().slice(0, 10);
            const used = this.sql.exec("SELECT checks FROM ai_days WHERE day = ?", day).toArray()[0]?.checks ?? 0;
            if (used >= AI_CHECKS_PER_DAY || !this.env.AI) return jsonReply({ error: "Image uploads are paused for today. GIF search still works." });
            if (ipHash && this.sql.exec("SELECT COUNT(*) AS n FROM uploads WHERE ip = ? AND checked = 1 AND at > ?", ipHash, now - 86400_000).one().n >= AI_CHECKS_PER_IP_DAY) {
                return jsonReply({ error: "Your network has hit today's limit for new images. GIF search still works." });
            }
            this.sql.exec("UPDATE uploads SET checked = 1 WHERE rowid = ?", uploadRow);
            this.sql.exec("INSERT INTO ai_days (day, checks) VALUES (?, 1) ON CONFLICT (day) DO UPDATE SET checks = checks + 1", day);
            this.sql.exec("DELETE FROM ai_days WHERE day < ?", new Date(now - 7 * 86400_000).toISOString().slice(0, 10));
            let result;
            try {
                result = await moderate(this.env.AI, bytes, info);
            } catch (err) {
                console.error("image check failed:", err && err.message);
                return jsonReply({ error: err?.message === "too big" ? "That GIF is too big to check." : "Couldn't check that image. Try again later." });
            }
            verdict = { ok: result.ok ? 1 : 0, why: result.why ?? null };
            this.sql.exec("INSERT OR REPLACE INTO verdicts (hash, ok, why, at) VALUES (?, ?, ?, ?)", hash, verdict.ok, verdict.why, now);
            this.sql.exec("DELETE FROM verdicts WHERE at < ?", now - VERDICT_MS);
            if (!verdict.ok) return jsonReply({ error: "That image isn't allowed in the chat (" + verdict.why + ")." });
        }
        if (stored) {
            this.sql.exec("UPDATE files SET at = ?, name = ? WHERE id = ?", now, info.name ?? null, id);
        } else {
            this.sql.exec("INSERT INTO files (id, hash, type, w, h, size, at, name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", id, hash, info.type, info.w, info.h, bytes.length, now, info.name ?? null);
            for (let i = 0, part = 0; i < bytes.length; i += PART, part++) {
                this.sql.exec("INSERT INTO file_parts (id, part, data) VALUES (?, ?, ?)", id, part, bytes.slice(i, i + PART).buffer);
            }
        }
        return jsonReply({ file: fileMedia({ id, type: info.type, w: info.w, h: info.h, name: info.name ?? null, size: bytes.length }) });
    }

    // Drops files that no message shows: all of them, or only those in `ids`. Unless `now` is null,
    // uploads newer than PENDING_MS stay, since their message may still be on its way.
    dropPendingFiles(now, ids) {
        let where = "id NOT IN (SELECT file FROM messages WHERE file IS NOT NULL)";
        const args = [];
        if (ids) {
            if (!ids.length) return;
            where += " AND id IN (" + ids.map(() => "?").join(",") + ")";
            args.push(...ids);
        }
        if (now != null) {
            where += " AND at < ?";
            args.push(now - PENDING_MS);
        }
        for (const { id } of this.sql.exec("SELECT id FROM files WHERE " + where, ...args).toArray()) {
            this.sql.exec("DELETE FROM file_parts WHERE id = ?", id);
            this.sql.exec("DELETE FROM files WHERE id = ?", id);
        }
    }

    // Deletes messages, and any uploads only they showed (at once when `now` is null).
    deleteMessages(now, where, ...args) {
        const files = this.sql.exec("SELECT DISTINCT file FROM messages WHERE file IS NOT NULL AND " + where, ...args).toArray().map((r) => r.file);
        this.sql.exec("DELETE FROM messages WHERE " + where, ...args);
        this.dropPendingFiles(now, files);
    }

    // The checked form of a message's media, or a string saying why it can't be posted.
    mediaFor(media) {
        if (media == null) return null;
        if (typeof media !== "object") return "Bad attachment.";
        if (media.f != null) {
            const row = FILE_ID.test(media.f ?? "") ? this.sql.exec("SELECT id, type, w, h, name, size FROM files WHERE id = ?", media.f).toArray()[0] : null;
            return row ? { f: fileMedia(row) } : "That upload has expired. Attach it again.";
        }
        const g = media.g;
        const size = (n) => Number.isSafeInteger(n) && n > 0 && n <= 4096;
        if (!g || !KLIPY_URL.test(g.url ?? "") || !KLIPY_URL.test(g.prev ?? "") || !KLIPY_SLUG.test(g.slug ?? "") || !size(g.w) || !size(g.h)) {
            return "Bad attachment.";
        }
        if (this.sql.exec("SELECT 1 FROM banned_gifs WHERE slug = ?", g.slug).toArray().length) return "That GIF isn't allowed in the chat.";
        return { g: { url: g.url, prev: g.prev, slug: g.slug, w: g.w, h: g.h, title: censor(cleanText(g.title, 100)) } };
    }

    // For a cup room: the main room checks the attachment against its uploads and banned GIFs, and
    // keeps an upload a cup shows for as long as a cup room lasts.
    cupMedia(media) {
        const checked = this.mediaFor(media);
        if (checked?.f) this.sql.exec("UPDATE files SET at = MAX(at, ?) WHERE id = ?", Date.now() + CUP_KEEP_MS - PENDING_MS, checked.f.id);
        return checked;
    }

    history() {
        const messages = this.sql.exec("SELECT id, at, uid, nick, owner, text, pings, reply_to, edited, tag, media FROM messages ORDER BY id DESC LIMIT ?", HISTORY)
            .toArray().reverse().map(({ reply_to, media, ...m }) => ({
                ...m, owner: !!m.owner, pings: m.pings ? JSON.parse(m.pings) : [], reply: reply_to ? JSON.parse(reply_to) : null, reactions: [],
                ...(media ? { media: JSON.parse(media) } : {}),
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
        const row = this.sql.exec("SELECT id, uid, nick, text, media FROM messages WHERE id = ?", replyTo.id).toArray()[0];
        if (!row) return null;
        const quoted = { id: row.id, uid: row.uid, nick: row.nick, text: [...row.text].slice(0, REPLY_QUOTE).join("") };
        if (row.media) quoted.media = true;
        return quoted;
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
        const banned = this.bannedText(me);
        if (banned) return reply({ t: "err", text: banned });
        const until = this.mutedUntil(me);
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

    mutedUntil(me) {
        const row = this.sql.exec("SELECT until FROM mutes WHERE uid = ?", me.uid).toArray()[0];
        if (row && row.until > Date.now()) return row.until;
        return this.inherited("mutes", me)?.until ?? 0;
    }

    // A player's spam and ping counters, rebuilt from the stored messages. The in-memory copy is
    // lost whenever the room hibernates, which a quiet few seconds is enough for.
    recentActivity(uid, now) {
        const s = { last: 0, recent: [], text: "", textAt: 0, pings: [], reacts: [], edits: [] };
        const rows = this.sql.exec("SELECT at, text, pings, file, gif FROM messages WHERE uid = ? AND at > ? ORDER BY id",
            uid, now - Math.max(SPAM_WINDOW_MS, PING_WINDOW_MS, REPEAT_MS)).toArray();
        for (const row of rows) {
            s.last = row.at;
            if (now - row.at < SPAM_WINDOW_MS) s.recent.push(row.at);
            s.text = repeatKey(row.text, row.file, row.gif);
            s.textAt = row.at;
            for (const p of row.pings ? JSON.parse(row.pings) : []) s.pings.push({ uid: p.uid, at: row.at });
        }
        for (const row of this.sql.exec("SELECT at FROM reactions WHERE uid = ? AND at > ?", uid, now - REACT_WINDOW_MS)) s.reacts.push(row.at);
        for (const row of this.sql.exec("SELECT edited FROM messages WHERE uid = ? AND edited > ?", uid, now - EDIT_WINDOW_MS)) s.edits.push(row.edited);
        // A uid's whisper rows also hold the whispers it got; only the ones it sent count.
        for (const row of this.sql.exec("SELECT at, data FROM whispers WHERE uid = ? AND at > ?", uid, now - Math.max(SPAM_WINDOW_MS, WHISPER_PEOPLE_MS))) {
            const m = JSON.parse(row.data);
            if (m.uid !== uid) continue;
            s.last = Math.max(s.last, row.at);
            if (now - row.at < SPAM_WINDOW_MS) s.recent.push(row.at);
            (s.whispers ||= []).push({ to: String(m.to?.nick || "").toLowerCase(), at: row.at });
        }
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

    // A new chat id per message gets past every per-id limit, so the address has one of its own.
    ipFlood(ip, now) {
        if (!ip) return null;
        if (this.ipSpam.size > 2000) this.ipSpam.clear();
        const recent = (this.ipSpam.get(ip) ?? []).filter((at) => now - at < IP_SPAM_WINDOW_MS);
        if (recent.length >= IP_SPAM_MAX) {
            this.ipSpam.set(ip, recent);
            return { t: "err", text: "Too many messages from your network. Wait a few seconds." };
        }
        recent.push(now);
        this.ipSpam.set(ip, recent);
        return null;
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
            who.ip = me.ip;
            await this.settle(who);
            this.noteId(who);
            if (me.cup) {
                // Account bans live in the main room.
                try {
                    who.ban = await this.env.CHAT.get(this.env.CHAT.idFromName("global")).chatBan({ uid: who.uid, ip: me.ip, owner: who.owner });
                } catch {}
                // The organizer proves it with the secret its page gave the cup room when it opened.
                if (HEX32.test(msg.host ?? "") && this.env.LOBBY) {
                    try {
                        who.cupHost = await this.env.LOBBY.get(this.env.LOBBY.idFromName(me.cup)).isHost(msg.host);
                    } catch {}
                }
                await this.ctx.storage.setAlarm(Date.now() + CUP_KEEP_MS);
            }
            Object.assign(me, { joined: true, ...who });
            ws.serializeAttachment(me);
            this.send(ws, { t: "init", you: { uid: me.uid, owner: me.owner, ...(me.cup ? { host: !!me.cupHost } : {}) }, messages: this.history(), ...(me.cup ? { mutes: this.cupMutes() } : { whispers: this.whispersFor(me.uid, 0) }) });
            return;
        }
        if (!me.joined) return;
        return this.handle(me, msg, (data) => this.send(ws, data), () => ws.serializeAttachment(me));
    }

    // The newest whispers this chat id may see, oldest first.
    whispersFor(uid, after) {
        return this.sql.exec("SELECT data FROM whispers WHERE uid = ? AND id > ? AND at > ? ORDER BY id DESC LIMIT ?", uid, after, Date.now() - WHISPER_KEEP_MS, WHISPERS_SHOWN)
            .toArray().reverse().map((r) => JSON.parse(r.data));
    }

    newWhispers(uid, after) {
        return this.whisperUids.has(uid) ? this.whispersFor(uid, after) : [];
    }

    // The account holding a name now and the chat ids linked to it, or null if nobody holds it.
    async whisperTarget(name) {
        const key = name.toLowerCase();
        const hit = this.whisperNames.get(key);
        if (hit && Date.now() - hit.at < WHISPER_NAME_MS) return hit.target;
        const target = this.env.ACCOUNTS ? await this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromName("global")).whisperTarget(name) : null;
        if (this.whisperNames.size > 2000) this.whisperNames.clear();
        // A miss (no such name, or no chat ids yet) is trusted only 30 s, so a new account can be reached soon.
        this.whisperNames.set(key, { target, at: Date.now() - (target?.uids.length ? 0 : Math.max(0, WHISPER_NAME_MS - 30_000)) });
        return target;
    }

    async whisper(me, msg, reply, save) {
        if (me.cup) return reply({ t: "err", text: "Whispers only work in the main chat.", wfail: true });
        const text = cleanText(msg.text, MAX_TEXT);
        const name = cleanText(msg.to, MAX_NICK).trim();
        if (!text || !name) return;
        const banned = this.bannedText(me);
        if (banned) return reply({ t: "err", text: banned, wfail: true });
        const until = this.mutedUntil(me);
        if (until) return reply({ t: "err", text: "You're muted for " + duration(until - Date.now()) + ".", wfail: true });
        const now = Date.now();
        const refused = me.owner ? null : this.checkSpam(me.uid, "\u0001" + name.toLowerCase() + "\u0001" + text, now) ?? this.ipFlood(me.ip, now);
        if (refused) return reply(refused);
        let target;
        try {
            target = await this.whisperTarget(name);
        } catch (err) {
            console.error("whisper lookup failed:", err && err.message);
            return reply({ t: "err", text: "Couldn't send that whisper. Try again in a moment.", wfail: true });
        }
        if (!target) return reply({ t: "err", text: "Nobody is called " + name + ".", wfail: true });
        if (target.uids.includes(me.uid)) return reply({ t: "err", text: "That's you.", wfail: true });
        const to = target.uids.slice(0, WHISPER_UIDS);
        if (!to.length) return reply({ t: "err", text: target.nickname + " hasn't used the chat yet, so they can't get whispers.", wfail: true });
        // Not cached, so a block counts from the next whisper. Ignored whispers still arrive; the page hides them.
        // A failed lookup lets it through: the recipient's page hides blocked whispers anyway.
        if (!me.owner && this.env.ACCOUNTS) {
            let block = null;
            try {
                block = await this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromName("global")).whisperBlock(me.uid, target.nickname);
            } catch (err) {
                console.error("whisper block lookup failed:", err && err.message);
            }
            if (block === "mine") return reply({ t: "err", text: "You blocked " + target.nickname + ". Unblock them to whisper.", wfail: true, unblock: target.nickname });
            if (block === "blocked") return reply({ t: "err", text: "Your whisper to " + target.nickname + " couldn't be delivered.", wfail: true });
        }
        if (!me.owner) {
            const s = this.activity(me.uid, now);
            const key = target.nickname.toLowerCase();
            s.whispers = (s.whispers || []).filter((w) => now - w.at < WHISPER_PEOPLE_MS);
            if (!s.whispers.some((w) => w.to === key) && new Set(s.whispers.map((w) => w.to)).size >= WHISPER_PEOPLE) {
                return reply({ t: "err", text: "You've whispered too many different people. Wait a few minutes.", wfail: true });
            }
            s.whispers.push({ to: key, at: now });
        }
        let nick = censor(cleanText(msg.nick, MAX_NICK)) || "Guest";
        if (!me.owner && nick !== "Guest" && (await this.whoIs(me.uid, nick)).taken) nick = "Guest";
        if (nick !== me.nick) {
            me.nick = nick;
            save();
        }
        const tag = TAG_ID.test(me.tag ?? "") ? me.tag : null;
        const id = this.lastWhisperId = Math.max(now * 100, this.lastWhisperId + 1);
        const m = { id, at: now, uid: me.uid, nick, owner: me.owner, tag, to: { uid: to[0], nick: target.nickname }, text: censor(text) };
        const data = JSON.stringify(m);
        const uids = new Set([me.uid, ...to]);
        this.sql.exec("DELETE FROM whispers WHERE at < ?", now - WHISPER_KEEP_MS);
        for (const uid of uids) this.sql.exec("INSERT OR REPLACE INTO whispers (id, uid, at, data, ip) VALUES (?, ?, ?, ?, ?)", id, uid, now, data, me.ip || null);
        const frame = JSON.stringify({ t: "whisper", m });
        for (const ws of this.ctx.getWebSockets()) {
            const a = ws.deserializeAttachment();
            if (!a?.joined || !uids.has(a.uid)) continue;
            try {
                ws.send(frame);
            } catch {}
        }
        for (const uid of uids) this.whisperUids.add(uid);
        for (const waiter of [...this.waiters]) if (uids.has(waiter.uid)) waiter.wake();
    }

    // Who a ban points at: a public message by id, or (wid) a whisper the owner sent or got.
    modRow(msg, me) {
        if (Number.isSafeInteger(msg.wid)) {
            const row = this.sql.exec("SELECT data, ip FROM whispers WHERE id = ? AND uid = ?", msg.wid, me.uid).toArray()[0];
            if (!row) return null;
            const m = JSON.parse(row.data);
            return { uid: m.uid, nick: m.nick, owner: m.owner ? 1 : 0, ip: row.ip };
        }
        return Number.isSafeInteger(msg.id) ? this.sql.exec("SELECT uid, nick, owner, ip FROM messages WHERE id = ?", msg.id).toArray()[0] : null;
    }

    // Players edit only their own messages; the owner too. The new text is censored like any
    // message. Pings stay as they were sent, so an edit can't notify anyone.
    edit(reply, me, msg) {
        const text = cleanText(msg.text, MAX_TEXT);
        if (!Number.isSafeInteger(msg.id)) return;
        const row = this.sql.exec("SELECT uid, text, media FROM messages WHERE id = ?", msg.id).toArray()[0];
        // A message with an image or GIF may lose its text; any other needs some.
        if (!row || row.uid !== me.uid || (!text && !row.media)) return;
        const now = Date.now();
        const banned = this.bannedText(me);
        if (banned) return reply({ t: "err", text: banned });
        const until = this.mutedUntil(me);
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
        if (msg?.t === "whisper") return this.whisper(me, msg, reply, save);
        // Anyone can delete their own message; the owner can delete anyone's.
        if (msg?.t === "del" && Number.isSafeInteger(msg.id)) {
            const row = this.sql.exec("SELECT uid FROM messages WHERE id = ?", msg.id).toArray()[0];
            if (!row || (row.uid !== me.uid && !me.owner)) return;
            this.deleteMessages(null, "id = ?", msg.id);
            this.sql.exec("DELETE FROM reactions WHERE msg = ?", msg.id);
            this.broadcast({ t: "del", id: msg.id });
            return;
        }

        if (msg?.t === "msg") {
            const text = cleanText(msg.text, MAX_TEXT);
            let media;
            if (msg.media != null && me.cup) {
                try {
                    media = await this.env.CHAT.get(this.env.CHAT.idFromName("global")).cupMedia(msg.media);
                } catch (err) {
                    console.error("cup media check failed:", err && err.message);
                    return reply({ t: "err", text: "Couldn't attach that. Try again in a moment." });
                }
            } else media = this.mediaFor(msg.media);
            if (typeof media === "string") return reply({ t: "err", text: media });
            if (!text && !media) return;
            const banned = this.bannedText(me);
            if (banned) return reply({ t: "err", text: banned });
            const until = this.mutedUntil(me);
            if (until) return reply({ t: "err", text: me.cup ? "The organizer muted you for this cup." : "You're muted for " + duration(until - Date.now()) + "." });
            const now = Date.now();
            const file = media?.f?.id ?? null;
            const gif = media?.g?.slug ?? null;
            const refused = me.owner ? null : this.checkSpam(me.uid, repeatKey(text, file, gif), now) ?? this.ipFlood(me.ip, now);
            if (refused) return reply(refused);

            let nick = censor(cleanText(msg.nick, MAX_NICK)) || "Guest";
            if (!me.owner && nick !== "Guest" && (await this.whoIs(me.uid, nick)).taken) nick = "Guest";
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
            if (media) message.media = media;
            message.id = this.sql.exec("INSERT INTO messages (at, uid, nick, owner, text, pings, reply_to, tag, media, file, gif, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
                message.at, message.uid, message.nick, message.owner ? 1 : 0, message.text, pings.length ? JSON.stringify(pings) : null,
                quoted ? JSON.stringify(quoted) : null, tag, media ? JSON.stringify(media) : null, file, gif, me.ip || null).one().id;
            this.deleteMessages(now, "id <= ?", message.id - HISTORY);
            this.sql.exec("DELETE FROM reactions WHERE msg <= ?", message.id - HISTORY);
            this.broadcast({ t: "msg", m: message });
            return;
        }

        if (msg?.t === "cupmute" && me.cup && this.ctx.id.name !== "global" && (me.cupHost || me.owner) && /^[0-9a-f]{16}$/.test(msg.uid ?? "") && msg.uid !== me.uid) {
            if (msg.on === true) this.sql.exec("INSERT OR REPLACE INTO mutes (uid, until, ip, at) VALUES (?, ?, ?, ?)", msg.uid, Date.now() + CUP_MUTE_MS, this.ipOfUid(msg.uid), Date.now());
            else this.sql.exec("DELETE FROM mutes WHERE uid = ?", msg.uid);
            this.broadcast({ t: "mutes", uids: this.cupMutes() });
            return;
        }
        if (!me.owner) return;
        if (msg?.t === "mute" && /^[0-9a-f]{16}$/.test(msg.uid ?? "") && MUTE_MINUTES.includes(msg.minutes)) {
            this.sql.exec("INSERT OR REPLACE INTO mutes (uid, until, ip, at) VALUES (?, ?, ?, ?)", msg.uid, Date.now() + msg.minutes * 60000, this.ipOfUid(msg.uid), Date.now());
            this.sql.exec("DELETE FROM mutes WHERE until < ?", Date.now());
            reply({ t: "err", text: "Muted for " + msg.minutes + " minutes." });
        } else if (msg?.t === "clear") {
            this.deleteMessages(null, "uid = ?", String(msg.uid ?? ""));
            this.sql.exec("DELETE FROM reactions WHERE uid = ? OR msg NOT IN (SELECT id FROM messages)", String(msg.uid ?? ""));
            this.broadcast({ t: "clear", uid: msg.uid });
        } else if (msg?.t === "ban" && Number.isSafeInteger(msg.id)) {
            // Bans a message's file, image or GIF for good, and takes down every message showing it.
            const row = this.sql.exec("SELECT file, gif FROM messages WHERE id = ?", msg.id).toArray()[0];
            if (!row?.file && !row?.gif) return;
            const now = Date.now();
            if (row.file) {
                const hash = this.sql.exec("SELECT hash FROM files WHERE id = ?", row.file).toArray()[0]?.hash;
                // Dated far ahead so the verdict never expires.
                if (hash) this.sql.exec("INSERT OR REPLACE INTO verdicts (hash, ok, why, at) VALUES (?, 0, 'removed by the owner', ?)", hash, now + 10 * 365 * 86400_000);
            } else {
                this.sql.exec("INSERT OR REPLACE INTO banned_gifs (slug, at) VALUES (?, ?)", row.gif, now);
            }
            const column = row.file ? "file" : "gif";
            const ids = this.sql.exec("SELECT id FROM messages WHERE " + column + " = ?", row.file || row.gif).toArray().map((r) => r.id);
            this.deleteMessages(null, column + " = ?", row.file || row.gif);
            for (const id of ids) {
                this.sql.exec("DELETE FROM reactions WHERE msg = ?", id);
                this.broadcast({ t: "del", id });
            }
            reply({ t: "err", text: "Banned. It can't be posted again." });
        } else if (msg?.t === "ipban" && !me.cup && IP_BAN_DAYS.includes(msg.days)) {
            const row = this.modRow(msg, me);
            if (!row) return;
            // A message from before IP bans existed has no address, but its sender may still be connected.
            const socket = this.ctx.getWebSockets().map((ws) => ws.deserializeAttachment()).find((a) => a?.uid === row.uid && a.ip);
            const ip = row.ip || socket?.ip;
            if (row.owner || (ip && ip === me.ip)) return reply({ t: "err", text: "That's your own address, so it wasn't banned." });
            if (!ip) return reply({ t: "err", text: "No address saved for that message. Try Race Control -> Bans." });
            const until = msg.days ? Date.now() + msg.days * 86400_000 : null;
            try {
                await this.env.TRAFFIC.get(this.env.TRAFFIC.idFromName("global")).banIp(ip, until, row.nick, readBanReason(msg.reason));
            } catch (err) {
                console.error("ip ban failed:", err && err.message);
                return reply({ t: "err", text: "Couldn't ban that address. Try again in a moment." });
            }
            this.blockIp(ip, until);
            reply({ t: "err", text: "IP banned " + (msg.days ? "for " + msg.days + (msg.days === 1 ? " day" : " days") : "for good") + ". Lift it in Race Control -> Bans." });
        } else if (msg?.t === "userban" && !me.cup && IP_BAN_DAYS.includes(msg.days)) {
            const row = this.modRow(msg, me);
            if (!row) return;
            if (row.owner || row.uid === me.uid) return reply({ t: "err", text: "That's your own account, so it wasn't banned." });
            const chat = msg.chat === true;
            const until = msg.days ? Date.now() + msg.days * 86400_000 : null;
            const reason = readBanReason(msg.reason);
            try {
                const accounts = this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromName("global"));
                const userId = await accounts.chatUser(row.uid);
                if (!userId) return reply({ t: "err", text: "That chat isn't linked to an account yet. Try Race Control -> Bans with their name." });
                if (ownerHashes(this.env.OWNER_USER_IDS).has(userId)) return reply({ t: "err", text: "That's your own account, so it wasn't banned." });
                const target = await accounts.banTarget(userId);
                const names = target.names.length ? target.names : [row.nick];
                await this.env.TRAFFIC.get(this.env.TRAFFIC.idFromName("global")).banUser(userId, until, chat, target.nickname || row.nick, reason, names);
                this.blockUser(userId, [...new Set([row.uid, ...target.uids])], until, chat, reason);
            } catch (err) {
                console.error("account ban failed:", err && err.message);
                return reply({ t: "err", text: "Couldn't ban that account. Try again in a moment." });
            }
            const span = msg.days ? "for " + msg.days + (msg.days === 1 ? " day" : " days") : "for good";
            reply({ t: "err", text: (chat ? "Banned from the chat " : "Account banned ") + span + ". Lift it in Race Control -> Bans." });
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
