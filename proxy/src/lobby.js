// Competitions (Cuppa) networking. The game's multiplayer normally finds players through
// Kodub's matchmaking server and then talks peer to peer over WebRTC. Here both go through this
// Worker instead: every cup code is one LobbyRoom Durable Object that answers the same matchmaking
// handshake (host / join sockets) and relays the "peer to peer" data channels (mux sockets).
// The page side is competitions/src/transport.js.
//
// Cost on the free plan: incoming WebSocket messages bill 20 to a request, so each page bundles
// everything it sends into at most one binary frame per flush (about 5 a second while racing).
// A deploy restarts every room and drops every socket at once. The only thing stored is the
// organizer's reclaim record, so the organizer can take the code back; the pages then re-link
// their pairs and resend what the other end never got (transport.js keeps what it sent).

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
// A racer's car state with its car clock in front ([u32 link][f64 start]), from a page that opened
// its mux socket with fan=1. The room passes it to the organizer and also straight to every other
// page that asked for them, so other cars arrive without the organizer's page in between. The room
// writes the link it came in on over the first four bytes, so a page can't pass its states off as
// another racer's; pages learn whose link is whose from the organizer (transport.js).
const FAN_KIND = 2;
const FAN_HEADER = 12;
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
        // Empty means every week.
        weeks: [...new Set(Array.isArray(o.weeks) ? o.weeks : [])].filter((w) => Number.isInteger(w) && w > 0 && w < 1000).slice(0, 100),
        main: list(o.main, (e) => ["Summer", "Winter", "Desert"].includes(e)),
        community: list(o.community, (v) => typeof v === "string" && /^\d{1,2}\.\d{1,2}\.\d{1,2}$/.test(v)),
    };
}

function text(ws, data) {
    try {
        ws.send(JSON.stringify(data));
    } catch {}
}

// One relay record for `link`, copied from the record at `at` minus `skip` bytes of its payload,
// with `from` (the sender's link) over the payload's first four bytes when given.
function record(link, data, at, skip, kind, from) {
    const length = (data[at + 7] | data[at + 8] << 8 | data[at + 9] << 16 | data[at + 10] << 24) >>> 0;
    const size = length - skip;
    const out = new Uint8Array(11 + size);
    out[0] = link & 255;
    out[1] = link >>> 8 & 255;
    out[2] = link >>> 16 & 255;
    out[3] = link >>> 24 & 255;
    out[4] = data[at + 4];
    out[5] = data[at + 5];
    out[6] = kind;
    out[7] = size & 255;
    out[8] = size >>> 8 & 255;
    out[9] = size >>> 16 & 255;
    out[10] = size >>> 24 & 255;
    out.set(data.subarray(at + 11 + skip, at + 11 + length), 11);
    if (from !== undefined) {
        out[11] = from & 255;
        out[12] = from >>> 8 & 255;
        out[13] = from >>> 16 & 255;
        out[14] = from >>> 24 & 255;
    }
    return out;
}

// A mux socket that drops keeps its links parked this long, so the page can reconnect and resume
// them. Frames for a parked end are dropped: the sender resends them once the link is back.
const RESUME_MS = 20_000;
const TOKEN = /^[0-9a-f]{24}$/;
// An organizer whose matchmaking socket drops can take the same code back for this long.
const RECLAIM_MS = 60_000;
// While the organizer is connected its reclaim record has no end, because a restart never says
// that the socket went. This alarm notices a missing organizer and starts the RECLAIM_MS clock.
const RECLAIM_CHECK_MS = 10 * 60_000;
const STATUS_MIN_MS = 2_000;

// What an organizer's page reports about its cup (competitions/src/host.ts #reportStatus).
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
        // From the clock, so a restarted room never hands out a link number a page still holds.
        this.nextLink = (Date.now() / 1000) >>> 0;
        this.rate = new Map();
        this.listedAt = 0;
        this.parked = new Map();
        this.expired = new Set();
        this.fans = new WeakMap();
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
            // A page that can't re-link (from before relinking) tears its links down as before.
            // An unknown token that never expired here is a page coming back after a restart.
            let parked = token ? this.parked.get(token) : null;
            const ok = params.get("relink") === "1" && !!token && !this.expired.has(token);
            // The page's old socket can still look open here; its pairs move to the new one.
            for (const old of token ? this.sockets("mux") : []) {
                const oa = old.deserializeAttachment();
                if (oa.token !== token) continue;
                if (ok && !parked) parked = { pairs: oa.pairs, timer: 0 };
                else for (const id of Object.keys(oa.pairs || {})) this.dropPair(old, oa, id);
                oa.pairs = {};
                old.serializeAttachment(oa);
                try {
                    old.close(4002, "Replaced");
                } catch {}
            }
            server.serializeAttachment({ role, code, pairs: ok && parked ? parked.pairs : {}, token, fan: params.get("fan") === "1" });
            if (ok && parked) this.unpark(token, server, parked);
            else if (parked) this.expire(token);
            text(server, { t: "resumed", ok, relink: ok });
        } else server.serializeAttachment({ role, code, pairs: {}, token, reclaiming, fan: role === "mux" && params.get("fan") === "1" });
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
        return { name: a.name, host: a.nick, pool: a.pool ?? cleanPool(null), status: a.status ?? null };
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
            } else {
                a.nick = moderate(m.nickname, MAX_NICK) || "Host";
                a.public = o.public === true;
                a.max = Number.isSafeInteger(o.max) ? Math.min(25, Math.max(2, o.max)) : 8;
                a.name = moderate(o.name, MAX_NAME) || a.nick + "'s cup";
                a.pool = cleanPool(o.pool);
                a.chatKey = typeof o.chat === "string" && /^[0-9a-f]{32}$/.test(o.chat) ? o.chat : null;
            }
            a.invited = true;
            a.reclaimKey = key;
            ws.serializeAttachment(a);
            if (key) await this.saveReclaim(a, null);
            text(ws, { type: "createInvite", inviteCode: a.code, key: randomHex(16), timeoutMilliseconds: null, censoredNickname: a.nick });
            this.listing(true);
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

    // ---- Reclaiming a code after the organizer's matchmaking socket dropped. ----
    // The record is written when the room opens, so it is already there when a restart drops
    // every socket without a close event. `until` is null while the organizer is connected.

    async reclaimRecord() {
        const saved = (await this.ctx.storage.get("reclaim")) ?? null;
        return saved && (saved.until === null || saved.until > Date.now()) ? saved : null;
    }

    async saveReclaim(a, until) {
        const cup = { nick: a.nick, public: a.public, max: a.max, name: a.name, pool: a.pool, chatKey: a.chatKey, status: a.status ?? null };
        await this.ctx.storage.put("reclaim", { key: a.reclaimKey, code: a.code, until, cup });
        await this.ctx.storage.setAlarm(until ?? Date.now() + RECLAIM_CHECK_MS);
    }

    async clearReclaim() {
        await this.ctx.storage.delete("reclaim");
        await this.ctx.storage.deleteAlarm();
    }

    async hostGone(a, dropped) {
        if (dropped && a.reclaimKey) {
            await this.saveReclaim(a, Date.now() + RECLAIM_MS);
            // Hidden from the list but still reserved, so nobody else can get the code meanwhile.
            this.directory?.update(a.code, { name: a.name, host: a.nick, players: 1, max: a.max, public: false }).catch(() => {});
            return;
        }
        await this.clearReclaim();
        this.directory?.remove(a.code).catch(() => {});
    }

    async alarm() {
        const saved = await this.ctx.storage.get("reclaim");
        if (!saved) return;
        if (this.host()) return void (await this.ctx.storage.setAlarm(Date.now() + RECLAIM_CHECK_MS));
        if (saved.until === null) {
            saved.until = Date.now() + RECLAIM_MS;
            await this.ctx.storage.put("reclaim", saved);
            await this.ctx.storage.setAlarm(saved.until);
            this.directory?.update(saved.code, { name: saved.cup.name, host: saved.cup.nick, players: 1, max: saved.cup.max, public: false }).catch(() => {});
            return;
        }
        if (saved.until > Date.now()) return void (await this.ctx.storage.setAlarm(saved.until));
        await this.clearReclaim();
        this.directory?.remove(saved.code).catch(() => {});
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
        if (m.t === "rejoin") {
            // A page back on a new socket lists the pairs it still has; the rest are gone.
            const listed = new Set();
            for (const e of Array.isArray(m.pairs) ? m.pairs.slice(0, MAX_PAIRS_PER_SOCKET) : []) {
                if (e && typeof e === "object" && this.openPair(ws, a, e)) listed.add(e.pair);
            }
            for (const id of Object.keys(a.pairs)) if (!listed.has(id)) this.dropPair(ws, a, id);
            return;
        }
        const id = String(m.pair ?? "");
        if (!PAIR_ID.test(id) || id.slice(0, 5) !== a.code) return;
        if (m.t === "open") this.openPair(ws, a, m);
        else if (m.t === "close") this.dropPair(ws, a, id);
    }

    // `recv` is how many records the page got from the other end, so a link that starts over can
    // be told where to resend from. A link starts over whenever one end comes back on a new socket.
    openPair(ws, a, m) {
        const id = String(m.pair ?? "");
        if (!PAIR_ID.test(id) || id.slice(0, 5) !== a.code) return false;
        const own = a.pairs[id];
        if (!own && Object.keys(a.pairs).length >= MAX_PAIRS_PER_SOCKET) return false;
        if (!this.links) this.rebuildLinks();
        if (own?.link) this.links.delete(own.link);
        const side = m.side === "host" ? "host" : "client";
        const recv = Number.isSafeInteger(m.recv) && m.recv >= 0 ? m.recv : null;
        a.pairs[id] = { side, link: 0, recv };
        ws.serializeAttachment(a);
        const other = this.sockets("mux").find((o) => o !== ws && o.deserializeAttachment().pairs?.[id]?.side === (side === "host" ? "client" : "host"));
        if (!other) return true;
        const oa = other.deserializeAttachment();
        const theirs = oa.pairs[id];
        if (theirs.link) {
            // The other end is still on the old link: it answers with its own count.
            this.links.delete(theirs.link);
            theirs.link = 0;
            theirs.recv = null;
            other.serializeAttachment(oa);
            text(other, { t: "relink", pair: id });
            return true;
        }
        const link = this.nextLink++;
        a.pairs[id].link = link;
        ws.serializeAttachment(a);
        theirs.link = link;
        other.serializeAttachment(oa);
        this.links.set(link, side === "host" ? [ws, other] : [other, ws]);
        text(ws, { t: "up", pair: id, link, recv: theirs.recv, fan: a.fan === true, peerFan: oa.fan === true });
        text(other, { t: "up", pair: id, link, recv, fan: oa.fan === true, peerFan: a.fan === true });
        this.listing(false);
        return true;
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
        const parked = { pairs: a.pairs, timer: 0 };
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
    }

    expire(token) {
        const parked = this.parked.get(token);
        if (!parked) return;
        clearTimeout(parked.timer);
        this.parked.delete(token);
        if (this.expired.size > 500) this.expired.clear();
        this.expired.add(token);
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
        const add = (to, part) => {
            const key = to.parked ?? to;
            let parts = out.get(key);
            if (!parts) out.set(key, parts = []);
            parts.push(part);
        };
        let fanTo = null;
        let at = 0;
        while (at + 11 <= data.length) {
            const link = (data[at] | data[at + 1] << 8 | data[at + 2] << 16 | data[at + 3] << 24) >>> 0;
            const length = (data[at + 7] | data[at + 8] << 8 | data[at + 9] << 16 | data[at + 10] << 24) >>> 0;
            const end = at + 11 + length;
            if (end > data.length) break;
            const ends = this.links.get(link);
            const to = ends && (ends[0] === ws ? ends[1] : ends[1] === ws ? ends[0] : null);
            if (data[at + 6] !== FAN_KIND) {
                if (to) add(to, data.subarray(at, end));
            } else if (ends && ends[1] === ws && length > FAN_HEADER) {
                if (to) add(to, this.fanned(to) ? record(link, data, at, 0, FAN_KIND, link) : record(link, data, at, FAN_HEADER, 1));
                fanTo ??= this.fanTargets(ws);
                for (const [theirs, other] of fanTo) add(other, record(theirs, data, at, 0, FAN_KIND, link));
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
            if (typeof to === "string") continue;
            try {
                to.send(frame);
            } catch {}
        }
        if (Date.now() - this.listedAt > LISTING_MS) this.listing(true);
    }

    fanned(ws) {
        if (typeof ws?.deserializeAttachment !== "function") return false;
        let on = this.fans.get(ws);
        if (on === undefined) this.fans.set(ws, on = ws.deserializeAttachment()?.fan === true);
        return on;
    }

    // Every other page's link to the organizer, where that page takes car states straight from racers.
    fanTargets(from) {
        const list = [];
        for (const [link, [, client]] of this.links) if (client && client !== from && this.fanned(client)) list.push([link, client]);
        return list;
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
        const info = { name: a.name, host: a.nick, players, max: a.max, public: a.public, status: a.status ?? null };
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
