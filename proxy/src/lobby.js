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
const MAX_SOCKETS = 48;
const MAX_PAIRS_PER_SOCKET = 32;
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

export class LobbyRoom extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        // link number -> [host mux socket, client mux socket]; rebuilt from attachments after a wake.
        this.links = null;
        this.nextLink = 1;
        this.rate = new Map();
        this.listedAt = 0;
        ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    }

    get directory() {
        return this.env.LOBBY_DIR ? this.env.LOBBY_DIR.get(this.env.LOBBY_DIR.idFromName("global")) : null;
    }

    async fetch(request) {
        if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
        const code = request.headers.get("X-Cup-Code") || "";
        const role = request.headers.get("X-Cup-Role") || "";
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
        this.ctx.acceptWebSocket(server);
        server.serializeAttachment({ role, code, pairs: {} });
        return new Response(null, { status: 101, webSocket: pair[0] });
    }

    sockets(role) {
        return this.ctx.getWebSockets().filter((ws) => ws.deserializeAttachment()?.role === role);
    }

    host() {
        return this.sockets("host").find((ws) => ws.deserializeAttachment().invited) ?? null;
    }

    // For players about to join (worker.js /cup/info): the cup's name and map pool.
    info() {
        const host = this.host();
        if (!host) return null;
        const a = host.deserializeAttachment();
        return { name: a.name, host: a.nick, pool: a.pool ?? cleanPool(null) };
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

    hostMessage(ws, a, m) {
        if (m.type === "createInvite") {
            if (a.invited) return;
            a.invited = true;
            a.nick = moderate(m.nickname, MAX_NICK) || "Host";
            const o = m.nsws && typeof m.nsws === "object" ? m.nsws : {};
            a.public = o.public === true;
            a.max = Number.isSafeInteger(o.max) ? Math.min(16, Math.max(2, o.max)) : 8;
            a.name = moderate(o.name, MAX_NAME) || a.nick + "'s cup";
            a.pool = cleanPool(o.pool);
            a.chatKey = typeof o.chat === "string" && /^[0-9a-f]{32}$/.test(o.chat) ? o.chat : null;
            ws.serializeAttachment(a);
            text(ws, { type: "createInvite", inviteCode: a.code, key: randomHex(16), timeoutMilliseconds: null, censoredNickname: a.nick });
            this.listing(true);
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
        for (const other of this.sockets("mux")) {
            if (other === ws) continue;
            const oa = other.deserializeAttachment();
            if (!oa.pairs?.[id]) continue;
            delete oa.pairs[id];
            other.serializeAttachment(oa);
            text(other, { t: "down", pair: id });
        }
        if (this.links && p.link) this.links.delete(p.link);
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
                let parts = out.get(to);
                if (!parts) out.set(to, parts = []);
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
            try {
                to.send(frame);
            } catch {}
        }
        if (Date.now() - this.listedAt > LISTING_MS) this.listing(true);
    }

    // Public rooms show in the Competitions list. Only the host's name and a player count leave here.
    listing(force) {
        const dir = this.directory;
        const host = this.host();
        if (!dir || !host) return;
        const a = host.deserializeAttachment();
        let players = 1;
        for (const ws of this.sockets("mux")) {
            if (Object.values(ws.deserializeAttachment().pairs || {}).some((p) => p.side === "client" && p.link)) players++;
        }
        const info = { name: a.name, host: a.nick, players, max: a.max, public: a.public };
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
        if (a.role === "host") this.hostMessage(ws, a, m);
        else if (a.role === "join") this.joinMessage(ws, a, m);
        else if (a.role === "mux") this.muxControl(ws, a, m);
    }

    async webSocketClose(ws) {
        const a = ws.deserializeAttachment() || {};
        try {
            ws.close();
        } catch {}
        this.rate.delete(ws);
        if (a.role === "mux") {
            for (const id of Object.keys(a.pairs || {})) this.dropPair(ws, a, id);
        } else if (a.role === "join" && a.session) {
            const host = this.host();
            if (host) text(host, { type: "joinDisconnect", session: a.session });
        } else if (a.role === "host" && a.invited) {
            this.directory?.remove(a.code).catch(() => {});
        }
    }

    async webSocketError(ws) {
        await this.webSocketClose(ws);
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
