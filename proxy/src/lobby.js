// Competitions (PolyCup) networking. The game's multiplayer normally finds players through
// Kodub's matchmaking server and then talks peer to peer over WebRTC. Here both go through this
// Worker instead: every cup code is one LobbyRoom Durable Object that answers the same matchmaking
// handshake (host / join sockets) and relays the "peer to peer" data channels (mux sockets).
// The page side is polycup/nsws/transport.js.
//
// Cost on the free plan: incoming WebSocket messages bill 20 to a request, so each page bundles
// everything it sends into at most one binary frame per flush (about 5 a second while racing).
// Nothing here touches storage: a room only lives as long as its sockets.

import { DurableObject } from "cloudflare:workers";
import { moderate } from "./chatfilter.js";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 5;
export const LOBBY_CODE = /^[A-HJ-NP-Z2-9]{5}$/;

const MAX_NICK = 32;
const MAX_NAME = 40;
const MAX_SIGNAL = 16 * 1024;
const MAX_FRAME = 1024 * 1024;
// A 25-player room: two sockets a page while joining, plus reconnects.
const MAX_SOCKETS = 64;
const MAX_PAIRS_PER_SOCKET = 40;
const PAIR_ID = /^[A-HJ-NP-Z2-9]{5}\.[0-9a-f]{16}$/;
// A page flushes about 5 times a second; far more than this is a broken or hostile client.
const FRAMES_PER_SEC = 60;
// How often a live public room refreshes its row in the directory.
const LISTING_MS = 60_000;

// Cup creations allowed per address (hashed) within CREATE_WINDOW_MS.
const CREATES_PER_IP = 10;
const CREATE_WINDOW_MS = 10 * 60_000;
// A public room that hasn't checked in for this long has died without saying so.
const LISTING_STALE_MS = 3 * LISTING_MS;
const LIST_CACHE_MS = 3_000;

function randomCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
    return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

function randomHex(bytes) {
    return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

// The maps a cup draws from, picked before the room opens: the weekly shorts, the main tracks of
// each environment, and the community tracks of each game version.
function cleanPool(value) {
    const o = value && typeof value === "object" ? value : {};
    const list = (v, ok) => [...new Set(Array.isArray(v) ? v : [])].filter(ok).slice(0, 20);
    return {
        shorts: o.shorts !== false,
        main: list(o.main, (e) => ["Summer", "Winter", "Desert"].includes(e)),
        community: list(o.community, (v) => typeof v === "string" && /^\d{1,2}\.\d{1,2}\.\d{1,2}$/.test(v)),
    };
}

function text(ws, data) {
    try {
        ws.send(JSON.stringify(data));
    } catch {}
}

// A mux socket that drops keeps its links parked this long, so the page can reconnect and resume
// them; frames for it wait in memory (up to MAX_PARKED_BYTES).
const RESUME_MS = 20_000;
const MAX_PARKED_BYTES = 1024 * 1024;
const TOKEN = /^[0-9a-f]{24}$/;
// An organizer whose matchmaking socket drops can take the same code back for this long.
const RECLAIM_MS = 60_000;
const STATUS_MIN_MS = 2_000;

async function sha256Hex(text) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function ownerHashes(value) {
    const list = Array.isArray(value) ? value : String(value ?? "").replace(/[[\]"\s]/g, "").split(",");
    return new Set(list.map((h) => String(h).trim().toLowerCase()).filter((h) => /^[0-9a-f]{64}$/.test(h)));
}

// What an organizer's page reports about its cup (polycup/nsws/hub.ts reportStatus).
function cleanStatus(value) {
    const o = value && typeof value === "object" ? value : null;
    if (!o || !["setup", "racing", "break", "done"].includes(o.phase)) return null;
    const int = (n, max) => (Number.isSafeInteger(n) && n >= 0 && n <= max ? n : 0);
    return {
        phase: o.phase,
        round: int(o.round, 100000),
        racers: int(o.racers, 128),
        canRace: o.canRace === true,
        format: moderate(o.format, 24) || "Custom",
    };
}

export class LobbyRoom extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        // link number -> [host mux socket, client mux socket]; rebuilt from attachments after a wake.
        // A parked end is { parked: token } until its page resumes.
        this.links = null;
        this.nextLink = 1;
        this.rate = new Map();
        this.listedAt = 0;
        this.parked = new Map();
        this.reclaim = null;
        ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    }

    get directory() {
        return this.env.LOBBY_DIR ? this.env.LOBBY_DIR.get(this.env.LOBBY_DIR.idFromName("global")) : null;
    }

    async fetch(request) {
        if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
        const code = request.headers.get("X-Cup-Code") || "";
        const role = request.headers.get("X-Cup-Role") || "";
        const reclaiming = request.headers.get("X-Cup-Reclaim") === "1";
        const params = new URL(request.url).searchParams;
        const token = TOKEN.test(params.get("token") || "") ? params.get("token") : null;
        const pair = new WebSocketPair();
        const server = pair[1];
        const refuse = (error) => {
            server.accept();
            text(server, { type: "error", error });
            server.close(4000, error);
            return new Response(null, { status: 101, webSocket: pair[0] });
        };
        if (!LOBBY_CODE.test(code) || !["host", "join", "mux"].includes(role)) return refuse("BadRequest");
        if (this.ctx.getWebSockets().length >= MAX_SOCKETS) return refuse("SessionFull");
        if (role === "join" && !this.host()) return refuse("ExpiredInvite");
        if (role === "host" && this.sockets("host").length) return refuse("AlreadyHosted");
        if (role === "host" && reclaiming && !(await this.reclaimRecord())) return refuse("ExpiredInvite");
        this.ctx.acceptWebSocket(server);
        if (role === "mux" && params.get("resume") === "1") {
            const parked = token ? this.parked.get(token) : null;
            server.serializeAttachment({ role, code, pairs: parked ? parked.pairs : {}, token });
            if (parked) this.unpark(token, server, parked);
            else text(server, { t: "resumed", ok: false });
        } else server.serializeAttachment({ role, code, pairs: {}, token, reclaiming });
        return new Response(null, { status: 101, webSocket: pair[0] });
    }

    sockets(role) {
        return this.ctx.getWebSockets().filter((ws) => ws.deserializeAttachment()?.role === role);
    }

    host() {
        return this.sockets("host").find((ws) => ws.deserializeAttachment().invited) ?? null;
    }

    // For players about to join (worker.js /cup/info): the cup's name, map pool and what it is doing.
    info() {
        const host = this.host();
        if (!host) return null;
        const a = host.deserializeAttachment();
        return { name: a.name, host: a.nick, pool: a.pool ?? cleanPool(null), official: !!a.official, status: a.status ?? null };
    }

    // Called by the cup's chat room (chat.js) to recognise the organizer.
    isHost(secret) {
        const host = this.host();
        return !!host && typeof secret === "string" && host.deserializeAttachment().chatKey === secret;
    }

    joinFor(session) {
        return this.sockets("join").find((ws) => ws.deserializeAttachment().session === session) ?? null;
    }

    // ---- Matchmaking: the same JSON the game speaks to Kodub's server. ----

    async hostMessage(ws, a, m) {
        if (m.type === "createInvite") {
            if (a.invited) return;
            const o = m.nsws && typeof m.nsws === "object" ? m.nsws : {};
            const key = typeof o.reclaim === "string" && /^[0-9a-f]{32}$/.test(o.reclaim) ? o.reclaim : null;
            if (a.reclaiming) {
                // The same organizer coming back: same code, same cup details.
                const saved = await this.reclaimRecord();
                if (!saved || !key || saved.key !== key) {
                    text(ws, { type: "error", error: "ExpiredInvite" });
                    try {
                        ws.close(4000, "ExpiredInvite");
                    } catch {}
                    return;
                }
                Object.assign(a, saved.cup);
                await this.clearReclaim();
            } else {
                a.nick = moderate(m.nickname, MAX_NICK) || "Host";
                a.public = o.public === true;
                a.max = Number.isSafeInteger(o.max) ? Math.min(25, Math.max(2, o.max)) : 8;
                a.name = moderate(o.name, MAX_NAME) || a.nick + "'s cup";
                a.pool = cleanPool(o.pool);
                a.chatKey = typeof o.chat === "string" && /^[0-9a-f]{32}$/.test(o.chat) ? o.chat : null;
                a.official =
                    typeof o.ownerKey === "string" &&
                    /^[0-9a-f]{64}$/.test(o.ownerKey) &&
                    ownerHashes(this.env.OWNER_KEY_HASHES).has(await sha256Hex("nsws-owner:" + o.ownerKey));
            }
            a.invited = true;
            a.reclaimKey = key;
            ws.serializeAttachment(a);
            text(ws, { type: "createInvite", inviteCode: a.code, key: randomHex(16), timeoutMilliseconds: null, censoredNickname: a.nick });
            this.listing(true);
            if (a.official && !a.announced) await this.announceCup(ws, a);
            return;
        }
        if (m.type === "nswsStatus") {
            if (!a.invited || Date.now() - (a.statusAt ?? 0) < STATUS_MIN_MS) return;
            a.status = cleanStatus(m.status);
            a.statusAt = Date.now();
            ws.serializeAttachment(a);
            this.listing(false);
            return;
        }
        if (!a.invited || typeof m.session !== "string") return;
        const join = this.joinFor(m.session);
        if (!join) return;
        if (m.type === "acceptJoin") {
            if (typeof m.answer !== "string" || !Number.isSafeInteger(m.clientId)) return;
            text(join, { type: "acceptJoin", answer: m.answer, mods: [], isModsVanillaCompatible: true, clientId: m.clientId });
        } else if (m.type === "declineJoin") {
            text(join, { type: "declineJoin", reason: String(m.reason ?? "Declined").slice(0, 40) });
            try {
                join.close(1000, "Declined");
            } catch {}
        } else if (m.type === "iceCandidate") {
            text(join, { type: "iceCandidate", candidate: null });
        }
    }

    // ---- Official cups (hosted with the owner key): announced to everyone online. ----

    async announceCup(ws, a) {
        if (!this.env.TRAFFIC) return;
        try {
            const stub = this.env.TRAFFIC.get(this.env.TRAFFIC.idFromName("global"));
            const result = await stub.announce({
                name: "Competitions",
                text: `${a.name} is open: join the official cup now!`,
                color: "#ffd26b",
                show: 15,
                reach: 60,
                cup: a.code,
            });
            a.announced = result?.current?.id ?? null;
            ws.serializeAttachment(a);
            if (result?.current && this.env.CHAT)
                await this.env.CHAT.get(this.env.CHAT.idFromName("global")).announce({ t: "ann", a: result.current });
        } catch (err) {
            console.error("cup announce failed:", err && err.message);
        }
    }

    async withdrawCup(id) {
        if (id == null || !this.env.TRAFFIC) return;
        try {
            const result = await this.env.TRAFFIC.get(this.env.TRAFFIC.idFromName("global")).stopAnnouncement(id);
            if (result?.stopped != null && this.env.CHAT)
                await this.env.CHAT.get(this.env.CHAT.idFromName("global")).announce({ t: "ann-stop", id: result.stopped });
        } catch {}
    }

    // ---- Reclaiming a code after the organizer's matchmaking socket dropped. ----

    async reclaimRecord() {
        const saved = this.reclaim ?? (await this.ctx.storage.get("reclaim")) ?? null;
        return saved && saved.until > Date.now() ? saved : null;
    }

    async clearReclaim() {
        this.reclaim = null;
        clearTimeout(this.reclaimTimer);
        await this.ctx.storage.delete("reclaim");
    }

    async hostGone(a, dropped) {
        const live = this.sockets("mux").length > 0;
        if (dropped && a.reclaimKey && live) {
            const cup = { nick: a.nick, public: a.public, max: a.max, name: a.name, pool: a.pool, chatKey: a.chatKey, official: a.official, announced: a.announced, status: a.status };
            this.reclaim = { key: a.reclaimKey, until: Date.now() + RECLAIM_MS, cup };
            await this.ctx.storage.put("reclaim", this.reclaim);
            // Hidden from the list but still reserved, so nobody else can get the code meanwhile.
            this.directory?.update(a.code, { name: a.name, host: a.nick, players: 1, max: a.max, public: false }).catch(() => {});
            clearTimeout(this.reclaimTimer);
            this.reclaimTimer = setTimeout(() => {
                if (this.host()) return;
                this.directory?.remove(a.code).catch(() => {});
                void this.withdrawCup(a.announced);
                void this.clearReclaim();
            }, RECLAIM_MS);
            return;
        }
        this.directory?.remove(a.code).catch(() => {});
        await this.withdrawCup(a.announced);
    }

    joinMessage(ws, a, m) {
        const host = this.host();
        if (!host) {
            text(ws, { type: "error", error: "ExpiredInvite" });
            try {
                ws.close(1000, "No host");
            } catch {}
            return;
        }
        if (!a.session) {
            if (typeof m.offer !== "string" || m.offer.length > 200) return;
            a.session = randomHex(12);
            ws.serializeAttachment(a);
            text(host, {
                type: "joinInvite", session: a.session, offer: m.offer, mods: [], isModsVanillaCompatible: true,
                nickname: moderate(m.nickname, MAX_NICK) || "Player",
                countryCode: typeof m.countryCode === "string" && /^[a-z]{2}(-[a-z]{2,3})?$/i.test(m.countryCode) ? m.countryCode : null,
                carStyle: typeof m.carStyle === "string" && m.carStyle.length <= 256 ? m.carStyle : "",
                iceServers: [],
            });
            return;
        }
        if ("candidate" in m) text(host, { type: "iceCandidate", session: a.session, candidate: null });
    }

    // ---- Relay: one mux socket per page carries every data channel of every pair. ----

    rebuildLinks() {
        this.links = new Map();
        for (const ws of this.sockets("mux")) {
            const pairs = ws.deserializeAttachment().pairs || {};
            for (const p of Object.values(pairs)) {
                if (!p.link) continue;
                this.nextLink = Math.max(this.nextLink, p.link + 1);
                const entry = this.links.get(p.link) || [null, null];
                entry[p.side === "host" ? 0 : 1] = ws;
                this.links.set(p.link, entry);
            }
        }
        for (const [token, parked] of this.parked) {
            for (const p of Object.values(parked.pairs)) {
                if (!p.link) continue;
                const entry = this.links.get(p.link) || [null, null];
                entry[p.side === "host" ? 0 : 1] = { parked: token };
                this.links.set(p.link, entry);
            }
        }
    }

    muxControl(ws, a, m) {
        const id = String(m.pair ?? "");
        if (!PAIR_ID.test(id) || id.slice(0, 5) !== a.code) return;
        if (m.t === "open") {
            if (a.pairs[id] || Object.keys(a.pairs).length >= MAX_PAIRS_PER_SOCKET) return;
            const side = m.side === "host" ? "host" : "client";
            a.pairs[id] = { side, link: 0 };
            ws.serializeAttachment(a);
            const other = this.sockets("mux").find((o) => o !== ws && o.deserializeAttachment().pairs?.[id]?.side === (side === "host" ? "client" : "host"));
            if (!other) return;
            if (!this.links) this.rebuildLinks();
            const link = this.nextLink++;
            a.pairs[id].link = link;
            ws.serializeAttachment(a);
            const oa = other.deserializeAttachment();
            oa.pairs[id].link = link;
            other.serializeAttachment(oa);
            this.links.set(link, side === "host" ? [ws, other] : [other, ws]);
            text(ws, { t: "up", pair: id, link });
            text(other, { t: "up", pair: id, link });
            this.listing(false);
        } else if (m.t === "close") {
            this.dropPair(ws, a, id);
        }
    }

    dropPair(ws, a, id) {
        const p = a.pairs[id];
        if (!p) return;
        delete a.pairs[id];
        try {
            ws.serializeAttachment(a);
        } catch {}
        this.downPair(id, ws);
        if (this.links && p.link) this.links.delete(p.link);
        this.listing(false);
    }

    // Tells the other end of a pair (live or parked) that it is gone.
    downPair(id, except) {
        for (const other of this.sockets("mux")) {
            if (other === except) continue;
            const oa = other.deserializeAttachment();
            if (!oa.pairs?.[id]) continue;
            delete oa.pairs[id];
            other.serializeAttachment(oa);
            text(other, { t: "down", pair: id });
        }
        for (const parked of this.parked.values()) delete parked.pairs[id];
    }

    park(ws, a) {
        if (!this.links) this.rebuildLinks();
        for (const p of Object.values(a.pairs)) {
            if (!p.link) continue;
            const entry = this.links.get(p.link) || [null, null];
            entry[p.side === "host" ? 0 : 1] = { parked: a.token };
            this.links.set(p.link, entry);
        }
        const parked = { pairs: a.pairs, frames: [], bytes: 0, timer: 0 };
        parked.timer = setTimeout(() => this.expire(a.token), RESUME_MS);
        this.parked.set(a.token, parked);
    }

    unpark(token, ws, parked) {
        clearTimeout(parked.timer);
        this.parked.delete(token);
        if (!this.links) this.rebuildLinks();
        for (const p of Object.values(parked.pairs)) {
            if (!p.link) continue;
            const entry = this.links.get(p.link) || [null, null];
            entry[p.side === "host" ? 0 : 1] = ws;
            this.links.set(p.link, entry);
        }
        text(ws, { t: "resumed", ok: true });
        for (const frame of parked.frames) {
            try {
                ws.send(frame);
            } catch {}
        }
        this.listing(false);
    }

    expire(token) {
        const parked = this.parked.get(token);
        if (!parked) return;
        clearTimeout(parked.timer);
        this.parked.delete(token);
        for (const [id, p] of Object.entries(parked.pairs)) {
            this.downPair(id, null);
            if (this.links && p.link) this.links.delete(p.link);
        }
        this.listing(false);
    }

    allowFrame(ws) {
        const now = Date.now();
        let r = this.rate.get(ws);
        if (!r || now - r.at >= 1000) this.rate.set(ws, r = { at: now, n: 0 });
        return ++r.n <= FRAMES_PER_SEC;
    }

    // A frame is records of [u32 link][u16 channel][u8 kind][u32 length][bytes]. Each record goes to
    // the other end of its link; records for one destination leave as one frame.
    relay(ws, buffer) {
        const data = new Uint8Array(buffer);
        if (!this.links) this.rebuildLinks();
        const out = new Map();
        let at = 0;
        while (at + 11 <= data.length) {
            const link = (data[at] | data[at + 1] << 8 | data[at + 2] << 16 | data[at + 3] << 24) >>> 0;
            const length = (data[at + 7] | data[at + 8] << 8 | data[at + 9] << 16 | data[at + 10] << 24) >>> 0;
            const end = at + 11 + length;
            if (end > data.length) break;
            const ends = this.links.get(link);
            const to = ends && (ends[0] === ws ? ends[1] : ends[1] === ws ? ends[0] : null);
            if (to) {
                const key = to.parked ?? to;
                let parts = out.get(key);
                if (!parts) out.set(key, parts = []);
                parts.push(data.subarray(at, end));
            }
            at = end;
        }
        for (const [to, parts] of out) {
            let frame = parts[0];
            if (parts.length > 1) {
                frame = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
                let o = 0;
                for (const p of parts) {
                    frame.set(p, o);
                    o += p.length;
                }
            }
            if (typeof to === "string") {
                const parked = this.parked.get(to);
                if (!parked) continue;
                parked.frames.push(frame.slice());
                parked.bytes += frame.length;
                if (parked.bytes > MAX_PARKED_BYTES) this.expire(to);
                continue;
            }
            try {
                to.send(frame);
            } catch {}
        }
        if (Date.now() - this.listedAt > LISTING_MS) this.listing(true);
    }

    // Public rooms show in the Competitions list. Only the host's name, a player count and the cup's
    // status leave here.
    listing(force) {
        const dir = this.directory;
        const host = this.host();
        if (!dir || !host) return;
        const a = host.deserializeAttachment();
        let players = 1;
        for (const ws of this.sockets("mux")) {
            if (Object.values(ws.deserializeAttachment().pairs || {}).some((p) => p.side === "client" && p.link)) players++;
        }
        const info = { name: a.name, host: a.nick, players, max: a.max, public: a.public, official: !!a.official, status: a.status ?? null };
        const key = JSON.stringify(info);
        if (!force && key === this.listed) return;
        this.listed = key;
        this.listedAt = Date.now();
        dir.update(a.code, info).catch(() => {});
    }

    async webSocketMessage(ws, raw) {
        const a = ws.deserializeAttachment() || {};
        if (typeof raw !== "string") {
            if (a.role !== "mux" || raw.byteLength > MAX_FRAME || !this.allowFrame(ws)) return;
            this.relay(ws, raw);
            return;
        }
        if (raw.length > MAX_SIGNAL) return ws.close(1009, "Too large");
        let m;
        try {
            m = JSON.parse(raw);
        } catch {
            return;
        }
        if (!m || typeof m !== "object") return;
        if (a.role === "host") await this.hostMessage(ws, a, m);
        else if (a.role === "join") this.joinMessage(ws, a, m);
        else if (a.role === "mux") this.muxControl(ws, a, m);
    }

    // A page closing its socket itself sends 1000 or no code (1005); anything else is a dropped
    // connection that may come back.
    async webSocketClose(ws, code) {
        const a = ws.deserializeAttachment() || {};
        const dropped = code !== 1000 && code !== 1005;
        try {
            ws.close();
        } catch {}
        this.rate.delete(ws);
        if (a.role === "mux") {
            if (dropped && a.token && Object.keys(a.pairs || {}).length) this.park(ws, a);
            else for (const id of Object.keys(a.pairs || {})) this.dropPair(ws, a, id);
        } else if (a.role === "join" && a.session) {
            const host = this.host();
            if (host) text(host, { type: "joinDisconnect", session: a.session });
        } else if (a.role === "host" && a.invited) {
            await this.hostGone(a, dropped);
        }
    }

    async webSocketError(ws) {
        await this.webSocketClose(ws, 1006);
    }
}

// Cup codes and the public list. One instance ("global"). Rows are tiny and few; a listing
// reads only live rows and is cached for a few seconds.
export class LobbyDirectory extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.sql = ctx.storage.sql;
        this.sql.exec(`CREATE TABLE IF NOT EXISTS lobbies (
            code TEXT PRIMARY KEY, updated INTEGER NOT NULL, public INTEGER NOT NULL DEFAULT 0, info TEXT)`);
        this.creates = new Map();
        this.cache = null;
    }

    reserve(ipHash) {
        const now = Date.now();
        const recent = (this.creates.get(ipHash) || []).filter((t) => now - t < CREATE_WINDOW_MS);
        if (ipHash && recent.length >= CREATES_PER_IP) return null;
        if (this.creates.size > 5000) this.creates.clear();
        this.sql.exec("DELETE FROM lobbies WHERE updated < ?", now - 10 * LISTING_STALE_MS);
        for (let i = 0; i < 20; i++) {
            const code = randomCode();
            if (this.sql.exec("SELECT 1 FROM lobbies WHERE code = ?", code).toArray().length) continue;
            this.sql.exec("INSERT INTO lobbies (code, updated, public, info) VALUES (?, ?, 0, NULL)", code, now);
            recent.push(now);
            this.creates.set(ipHash, recent);
            return code;
        }
        return null;
    }

    update(code, info) {
        if (!LOBBY_CODE.test(code)) return;
        this.sql.exec("INSERT OR REPLACE INTO lobbies (code, updated, public, info) VALUES (?, ?, ?, ?)",
            code, Date.now(), info?.public ? 1 : 0, JSON.stringify(info ?? {}));
        this.cache = null;
    }

    remove(code) {
        this.sql.exec("DELETE FROM lobbies WHERE code = ?", code);
        this.cache = null;
    }

    list() {
        const now = Date.now();
        if (this.cache && now - this.cache.at < LIST_CACHE_MS) return this.cache.data;
        const rows = this.sql.exec("SELECT code, info FROM lobbies WHERE public = 1 AND updated > ? LIMIT 100", now - LISTING_STALE_MS).toArray();
        const cups = rows.map((r) => ({ code: r.code, ...JSON.parse(r.info || "{}") }))
            .filter((l) => l.players > 0)
            .sort((a, b) => b.players - a.players);
        const data = { cups };
        this.cache = { at: now, data };
        return data;
    }
}
