// Multiplayer lobbies. Every lobby is its own LobbyRoom Durable Object (named by its code) that
// holds every player's WebSocket, runs the match (rounds on random NSWS maps, a time limit per
// round, vote skips, head-to-head scoring) and relays car positions between players. Nothing
// goes peer to peer. LobbyDirectory hands out codes and lists the public lobbies.
//
// Cost on the free plan: incoming WebSocket messages bill 20 to a request, so the page batches
// car states (one message per CAR_BATCH_MS while driving) and the room only persists its state
// on a short debounce, never per car message.

import { DurableObject } from "cloudflare:workers";
import { censor } from "./chatfilter.js";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 5;
export const LOBBY_CODE = /^[A-HJ-NP-Z2-9]{5}$/;

const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_NICK = 32;
const MAX_NAME = 32;
const MAX_CHAT = 200;
const CHAT_KEPT = 40;
const MAX_FRAME = 64 * 1024;
const MAX_CAR_FRAME = 8 * 1024;
const MAX_POOL = 400;
const MAX_FRAMES = 5999999;
// Cars send about 5 batches a second; anything far past that is dropped, not relayed.
const CAR_MSGS_PER_SEC = 25;

const LOAD_MS = 12_000;
const FINAL_MS = 25_000;
// A dropped player keeps their place (and points) this long, so a reconnect picks up where it left.
const DROP_MS = 45_000;
const HEARTBEAT_MS = 60_000;
const SAVE_DELAY_MS = 3_000;
// Records that arrive this late after the buzzer still count (network delay).
const LATE_RECORD_MS = 1_500;
const MAX_SKIPS_PER_ROUND = 3;
const PING_BROADCAST_MS = 5_000;
const CHAT_GAP_MS = 800;
const CHAT_BURST = 8;
const CHAT_WINDOW_MS = 15_000;

const NUMBERS = {
    rounds: [1, 20, 5],
    minutes: [1, 15, 3],
    maxPlayers: [2, 16, 8],
    intermission: [5, 30, 12],
};
const SKIP_RULES = ["majority", "twothirds", "all", "off"];
const SCORING = ["h2h", "wins"];

// Lobby creations allowed per address (hashed) within CREATE_WINDOW_MS.
const CREATES_PER_IP = 6;
const CREATE_WINDOW_MS = 10 * 60_000;
// A public lobby that hasn't checked in for this long has died without saying so.
const LISTING_STALE_MS = 3 * HEARTBEAT_MS;
const LIST_CACHE_MS = 3_000;

const STRIP = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\u034f\u115f\u1160\u3164\uffa0\u2028\u2029]/gu;

function cleanText(value, max) {
    if (typeof value !== "string") return "";
    const text = value.normalize("NFC").replace(STRIP, "").replace(/\s+/g, " ").trim();
    return [...text.replace(/(\p{M}{2})\p{M}+/gu, "$1")].slice(0, max).join("");
}

async function sha256Hex(text) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function clampInt(value, [min, max, fallback]) {
    const n = Math.round(Number(value));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function randomCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
    return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

function shuffle(list) {
    for (let i = list.length - 1; i > 0; i--) {
        const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
        [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
}

// Settings from the page, checked and filled in. `previous` keeps the pool when an update leaves it out.
export function readSettings(raw, previous, nick) {
    const s = raw && typeof raw === "object" ? raw : {};
    const out = {
        name: censor(cleanText(s.name, MAX_NAME)) || previous?.name || (nick ? nick + "'s lobby" : "Lobby"),
        public: s.public === undefined ? previous?.public ?? true : !!s.public,
        rounds: clampInt(s.rounds ?? previous?.rounds, NUMBERS.rounds),
        minutes: clampInt(s.minutes ?? previous?.minutes, NUMBERS.minutes),
        maxPlayers: clampInt(s.maxPlayers ?? previous?.maxPlayers, NUMBERS.maxPlayers),
        intermission: clampInt(s.intermission ?? previous?.intermission, NUMBERS.intermission),
        skip: SKIP_RULES.includes(s.skip) ? s.skip : previous?.skip ?? "majority",
        scoring: SCORING.includes(s.scoring) ? s.scoring : previous?.scoring ?? "h2h",
        lateJoin: s.lateJoin === undefined ? previous?.lateJoin ?? true : !!s.lateJoin,
        liveTimes: s.liveTimes === undefined ? previous?.liveTimes ?? true : !!s.liveTimes,
        ghosts: s.ghosts === undefined ? previous?.ghosts ?? true : !!s.ghosts,
        pool: previous?.pool ?? [],
        weeks: previous?.weeks ?? [],
    };
    if (Array.isArray(s.pool)) {
        out.pool = [...new Set(s.pool.filter((id) => typeof id === "string" && HEX64.test(id)))].slice(0, MAX_POOL);
        out.weeks = Array.isArray(s.weeks) ? [...new Set(s.weeks.filter((w) => Number.isSafeInteger(w) && w > 0 && w < 10000))].slice(0, 200) : [];
    }
    return out;
}

function publicSettings(s) {
    const { pool, ...rest } = s;
    return { ...rest, poolSize: pool.length };
}

export class LobbyRoom extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.state = null;
        this.saveTimer = null;
        this.alarmAt = null;
        this.chat = [];
        this.rate = new Map();
        this.lastPingBroadcast = 0;
        ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
        ctx.blockConcurrencyWhile(async () => {
            this.state = (await ctx.storage.get("lobby")) ?? null;
        });
    }

    get directory() {
        return this.env.LOBBY_DIR ? this.env.LOBBY_DIR.get(this.env.LOBBY_DIR.idFromName("global")) : null;
    }

    async fetch(request) {
        if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
        const code = request.headers.get("X-Lobby-Code") || "";
        const create = request.headers.get("X-Lobby-Create") === "1";
        const pair = new WebSocketPair();
        const server = pair[1];
        if (!this.state && !create) {
            server.accept();
            server.send(JSON.stringify({ t: "err", code: "nolobby", text: "There's no lobby with that code." }));
            server.close(4004, "No lobby");
            return new Response(null, { status: 101, webSocket: pair[0] });
        }
        this.ctx.acceptWebSocket(server);
        server.serializeAttachment({ code, create: create && !this.state, ip: request.headers.get("X-Lobby-Ip") || "", sock: crypto.randomUUID() });
        return new Response(null, { status: 101, webSocket: pair[0] });
    }

    send(ws, data) {
        try {
            ws.send(typeof data === "string" ? data : JSON.stringify(data));
        } catch {}
    }

    sockets() {
        const list = [];
        for (const ws of this.ctx.getWebSockets()) {
            const a = ws.deserializeAttachment();
            if (a?.pid) list.push({ ws, a });
        }
        return list;
    }

    player(pid) {
        return this.state?.players.find((p) => p.pid === pid) ?? null;
    }

    // Times other players may see. With live times off, a rival's time during the round shows
    // only as "has a time" (-1), never the time itself.
    visibleBest(p, viewer) {
        if (p.best == null) return null;
        const racing = this.state.phase === "loading" || this.state.phase === "race";
        return racing && !this.state.settings.liveTimes && p.pid !== viewer ? -1 : p.best;
    }

    snapshot(viewer) {
        const s = this.state;
        return {
            t: "state",
            now: Date.now(),
            code: s.code,
            host: s.host,
            settings: publicSettings(s.settings),
            phase: s.phase,
            round: s.round,
            session: s.session,
            track: s.track,
            endsAt: s.endsAt,
            deadline: s.deadline,
            skipsLeft: Math.max(0, MAX_SKIPS_PER_ROUND - s.skips),
            skipNeed: this.skipNeed(),
            results: s.phase === "results" || s.phase === "final" ? s.lastResults : null,
            history: s.phase === "final" ? s.history : null,
            players: s.players.map((p) => ({
                id: p.pid, nick: p.nick, country: p.country, car: p.car, ready: p.ready, points: p.points, wins: p.wins,
                rounds: p.rounds, places: p.places, best: this.visibleBest(p, viewer), loaded: p.loaded, skip: p.skip,
                inRound: p.inRound, left: p.left, connected: p.connected, ping: p.ping ?? null,
            })),
        };
    }

    broadcastState() {
        for (const { ws, a } of this.sockets()) this.send(ws, this.snapshot(a.pid));
        this.listing();
    }

    broadcast(data, except) {
        const text = JSON.stringify(data);
        for (const { ws, a } of this.sockets()) if (a.pid !== except) this.send(ws, text);
    }

    message(text) {
        this.broadcast({ t: "msg", text });
    }

    dirty() {
        if (this.saveTimer) return;
        this.saveTimer = setTimeout(() => this.save(), SAVE_DELAY_MS);
    }

    async save() {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
        if (this.state) await this.ctx.storage.put("lobby", this.state);
    }

    // The next thing the room has to do on its own: end a phase, drop a player who never came
    // back, or tell the directory it is still alive.
    async schedule() {
        const s = this.state;
        if (!s) return;
        const times = [];
        if (s.phase !== "lobby" && s.deadline) times.push(s.deadline);
        for (const p of s.players) if (!p.connected && p.dropAt) times.push(p.dropAt);
        if (s.players.some((p) => p.connected)) times.push(s.beatAt || Date.now() + HEARTBEAT_MS);
        const next = times.length ? Math.min(...times) : null;
        if (next === this.alarmAt) return;
        this.alarmAt = next;
        if (next == null) await this.ctx.storage.deleteAlarm();
        else await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 50));
    }

    async alarm() {
        this.alarmAt = null;
        const s = this.state;
        if (!s) return;
        const now = Date.now();
        for (const p of [...s.players]) {
            if (!p.connected && p.dropAt && p.dropAt <= now) this.removePlayer(p, "left");
        }
        if (!this.state) return;
        if (s.phase !== "lobby" && s.deadline && s.deadline <= now) this.advance();
        if (!s.beatAt || s.beatAt <= now) {
            s.beatAt = now + HEARTBEAT_MS;
            this.listing(true);
        }
        this.dirty();
        await this.schedule();
    }

    // Keeps the public list (and the code reservation) current. Only the count, names and
    // progress go there; nothing about players beyond the host's nickname.
    listing(force = false) {
        const s = this.state;
        const dir = this.directory;
        if (!s || !dir) return;
        const host = this.player(s.host);
        const info = {
            name: s.settings.name, host: host?.nick ?? "", players: s.players.filter((p) => !p.left).length,
            max: s.settings.maxPlayers, phase: s.phase, round: s.round, rounds: s.settings.rounds, public: s.settings.public,
            minutes: s.settings.minutes, lateJoin: s.settings.lateJoin,
        };
        const key = JSON.stringify(info);
        if (!force && key === this.listed) return;
        this.listed = key;
        dir.update(s.code, info).catch(() => {});
    }

    async destroy() {
        const code = this.state?.code;
        this.state = null;
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
        for (const ws of this.ctx.getWebSockets()) {
            try {
                ws.close(4000, "Lobby closed");
            } catch {}
        }
        await this.ctx.storage.deleteAlarm();
        await this.ctx.storage.deleteAll();
        if (code) this.directory?.remove(code).catch(() => {});
    }

    activePlayers() {
        return this.state.players.filter((p) => !p.left);
    }

    racers() {
        return this.state.players.filter((p) => p.inRound && !p.left && p.connected);
    }

    skipNeed() {
        const s = this.state;
        const n = this.racers().length;
        if (!n) return 0;
        switch (s.settings.skip) {
        case "off":
            return 0;
        case "all":
            return n;
        case "twothirds":
            return Math.ceil((2 * n) / 3);
        default:
            return Math.floor(n / 2) + 1;
        }
    }

    pickTrack() {
        const s = this.state;
        const pool = s.settings.pool;
        let options = pool.filter((id) => !s.used.includes(id));
        if (!options.length) {
            s.used = s.track ? [s.track] : [];
            options = pool.filter((id) => id !== s.track);
            if (!options.length) options = pool;
        }
        const id = shuffle([...options])[0];
        s.used.push(id);
        return id;
    }

    newMap(skipped) {
        const s = this.state;
        s.session = (s.session + 1) >>> 0 || 1;
        s.track = this.pickTrack();
        s.phase = "loading";
        s.deadline = Date.now() + LOAD_MS;
        s.endsAt = null;
        if (!skipped) s.skips = 0;
        for (const p of s.players) {
            p.best = null;
            p.loaded = false;
            p.skip = false;
            p.inRound = !p.left && p.connected;
        }
        if (skipped) this.message("Map skipped.");
        this.dirty();
        this.broadcastState();
    }

    startMatch() {
        const s = this.state;
        if (!s.settings.pool.length) return false;
        s.round = 1;
        s.used = [];
        s.history = [];
        s.lastResults = null;
        s.track = null;
        for (const p of s.players) {
            p.points = 0;
            p.wins = 0;
            p.rounds = 0;
            p.places = 0;
            p.ready = false;
        }
        this.newMap(false);
        return true;
    }

    go() {
        const s = this.state;
        s.phase = "race";
        s.endsAt = Date.now() + s.settings.minutes * 60_000;
        s.deadline = s.endsAt + LATE_RECORD_MS;
        this.dirty();
        this.broadcastState();
    }

    checkLoaded() {
        const s = this.state;
        if (s.phase !== "loading") return;
        const racers = this.racers();
        if (racers.length && racers.every((p) => p.loaded)) this.go();
    }

    // Head to head: every player in the round races every other, and scores a point for each
    // one they beat (a time beats no time; equal times beat nobody). "wins" scores only first place.
    endRound() {
        const s = this.state;
        const field = s.players.filter((p) => p.inRound && (p.best != null || !p.left));
        const rows = field.map((p) => {
            const beaten = p.best == null ? 0 : field.filter((q) => q !== p && (q.best == null || q.best > p.best)).length;
            const place = p.best == null ? null : 1 + field.filter((q) => q.best != null && q.best < p.best).length;
            return { id: p.pid, f: p.best, place, beaten };
        });
        for (const row of rows) {
            const p = this.player(row.id);
            row.gained = s.settings.scoring === "wins" ? (row.place === 1 ? 1 : 0) : row.beaten;
            p.points += row.gained;
            p.rounds += 1;
            if (row.place === 1) p.wins += 1;
            p.places += row.place ?? field.length;
        }
        rows.sort((a, b) => (a.f ?? Infinity) - (b.f ?? Infinity));
        s.lastResults = { round: s.round, track: s.track, rows, last: s.round >= s.settings.rounds };
        s.history.push({ round: s.round, track: s.track, winners: rows.filter((r) => r.place === 1).map((r) => r.id) });
        s.phase = "results";
        s.deadline = Date.now() + s.settings.intermission * 1000;
        this.dirty();
        this.broadcastState();
    }

    afterResults() {
        const s = this.state;
        if (s.round < s.settings.rounds && this.activePlayers().length) {
            s.round += 1;
            this.newMap(false);
            return;
        }
        s.phase = "final";
        s.deadline = Date.now() + FINAL_MS;
        this.dirty();
        this.broadcastState();
    }

    toLobby() {
        const s = this.state;
        s.phase = "lobby";
        s.deadline = null;
        s.endsAt = null;
        s.track = null;
        s.players = s.players.filter((p) => !p.left);
        for (const p of s.players) {
            p.ready = false;
            p.best = null;
            p.inRound = false;
            p.loaded = false;
            p.skip = false;
        }
        this.dirty();
        this.broadcastState();
    }

    advance() {
        switch (this.state.phase) {
        case "loading":
            return this.go();
        case "race":
            return this.endRound();
        case "results":
            return this.afterResults();
        case "final":
            return this.toLobby();
        }
    }

    // `how`: "left" (gone for good), "kicked".
    removePlayer(p, how) {
        const s = this.state;
        const inMatch = s.phase !== "lobby";
        for (const { ws, a } of this.sockets()) {
            if (a.pid !== p.pid) continue;
            if (how === "kicked") this.send(ws, { t: "kicked" });
            try {
                ws.close(4001, how);
            } catch {}
        }
        if (how === "kicked") s.banned.push(p.uid);
        if (inMatch && p.rounds > 0) {
            p.left = true;
            p.connected = false;
            p.dropAt = null;
            p.skip = false;
        } else {
            s.players = s.players.filter((q) => q !== p);
        }
        this.message(how === "kicked" ? '"' + p.nick + '" was kicked.' : '"' + p.nick + '" left.');
        if (!this.activePlayers().length) {
            this.destroy();
            return;
        }
        if (s.host === p.pid) {
            const next = this.activePlayers().filter((q) => q.connected).sort((a, b) => a.joined - b.joined)[0] ?? this.activePlayers()[0];
            s.host = next.pid;
            this.message('"' + next.nick + '" is now the host.');
        }
        if (inMatch) {
            this.checkLoaded();
            this.checkSkip();
        }
        this.dirty();
        this.broadcastState();
    }

    checkSkip() {
        const s = this.state;
        if ((s.phase !== "loading" && s.phase !== "race") || s.skips >= MAX_SKIPS_PER_ROUND) return;
        const need = this.skipNeed();
        if (!need) return;
        const votes = this.racers().filter((p) => p.skip).length;
        if (votes >= need) {
            s.skips += 1;
            this.newMap(true);
        }
    }

    async hello(ws, a, msg) {
        if (!HEX32.test(msg.v ?? "")) return ws.close(1008, "Bad hello");
        const uid = (await sha256Hex("nsws-lobby:" + msg.v)).slice(0, 16);
        const nick = censor(cleanText(msg.nick, MAX_NICK)) || "Guest";
        const country = typeof msg.country === "string" && /^[a-z]{2}(-[a-z]{2,3})?$/i.test(msg.country) ? msg.country : null;
        const car = typeof msg.car === "string" && msg.car.length <= 256 && /^[\x20-\x7e]*$/.test(msg.car) ? msg.car : "";
        const now = Date.now();

        if (a.create && !this.state) {
            const settings = readSettings(msg.settings, null, nick);
            if (!settings.pool.length) {
                this.send(ws, { t: "err", text: "Pick at least one week of maps." });
                return ws.close(4002, "No maps");
            }
            this.state = {
                code: a.code, created: now, host: 1, settings, phase: "lobby", round: 0, session: 0, track: null,
                used: [], history: [], lastResults: null, deadline: null, endsAt: null, skips: 0, nextPid: 1,
                players: [], banned: [], beatAt: now + HEARTBEAT_MS,
            };
        }
        const s = this.state;
        if (!s) return ws.close(4004, "No lobby");
        if (s.banned.includes(uid)) {
            this.send(ws, { t: "err", text: "You were kicked from this lobby." });
            return ws.close(4003, "Banned");
        }

        let p = s.players.find((q) => q.uid === uid);
        if (p) {
            // The same player again (a reconnect or a second tab): the newest socket wins.
            for (const other of this.sockets()) {
                if (other.a.pid === p.pid && other.ws !== ws) {
                    this.send(other.ws, { t: "err", text: "This lobby was opened in another tab." });
                    try {
                        other.ws.close(4005, "Replaced");
                    } catch {}
                }
            }
            const back = !p.connected;
            const racing = s.phase === "loading" || s.phase === "race";
            if (racing && !p.inRound && (s.settings.lateJoin || p.rounds > 0)) p.inRound = true;
            Object.assign(p, { nick, country, car, connected: true, dropAt: null, left: false, sock: a.sock });
            if (back) this.message('"' + nick + '" is back.');
        } else {
            const seats = this.activePlayers().length;
            if (seats >= s.settings.maxPlayers) {
                this.send(ws, { t: "err", text: "That lobby is full." });
                return ws.close(4006, "Full");
            }
            const racing = s.phase === "loading" || s.phase === "race";
            p = {
                pid: s.nextPid++, uid, nick, country, car, joined: now, connected: true, dropAt: null, left: false,
                ready: false, points: 0, wins: 0, rounds: 0, places: 0, best: null, loaded: false, skip: false,
                inRound: racing && s.settings.lateJoin, ping: null, sock: a.sock,
            };
            s.players.push(p);
            if (s.players.length > 1) this.message('"' + nick + '" joined.');
        }
        a.pid = p.pid;
        a.uid = uid;
        a.create = false;
        ws.serializeAttachment(a);
        this.send(ws, { t: "welcome", you: p.pid, chat: this.chat });
        this.dirty();
        this.broadcastState();
        await this.schedule();
    }

    allow(pid, key, gapMs, burst, windowMs) {
        const now = Date.now();
        const id = pid + ":" + key;
        let r = this.rate.get(id);
        if (!r) this.rate.set(id, r = { last: 0, recent: [] });
        if (now - r.last < gapMs) return false;
        r.recent = r.recent.filter((t) => now - t < windowMs);
        if (r.recent.length >= burst) return false;
        r.last = now;
        r.recent.push(now);
        return true;
    }

    // Car batches and resets: [type][session u32][reset u32][...] in, the same with the sender's
    // id after the type byte out. The room never reads the car states themselves.
    relay(ws, a, raw) {
        const s = this.state;
        if (!s || !s.settings.ghosts || (s.phase !== "loading" && s.phase !== "race")) return;
        const data = new Uint8Array(raw);
        if (data.length < 9 || data.length > MAX_CAR_FRAME || (data[0] !== 1 && data[0] !== 2)) return;
        const session = (data[1] | data[2] << 8 | data[3] << 16 | data[4] << 24) >>> 0;
        if (session !== s.session) return;
        const p = this.player(a.pid);
        if (!p || !p.inRound || p.left) return;
        const now = Date.now();
        if (!this.carRate) this.carRate = new Map();
        let r = this.carRate.get(a.pid);
        if (!r || now - r.at >= 1000) this.carRate.set(a.pid, r = { at: now, n: 0 });
        if (++r.n > CAR_MSGS_PER_SEC) return;
        const out = new Uint8Array(data.length + 4);
        out[0] = data[0];
        out[1] = a.pid & 255;
        out[2] = a.pid >> 8 & 255;
        out[3] = a.pid >> 16 & 255;
        out[4] = a.pid >> 24 & 255;
        out.set(data.subarray(1), 5);
        for (const other of this.sockets()) {
            if (other.a.pid === a.pid) continue;
            try {
                other.ws.send(out);
            } catch {}
        }
    }

    async webSocketMessage(ws, raw) {
        const a = ws.deserializeAttachment() || {};
        if (typeof raw !== "string") {
            if (a.pid) this.relay(ws, a, raw);
            return;
        }
        if (raw.length > MAX_FRAME) return ws.close(1009, "Too large");
        let msg;
        try {
            msg = JSON.parse(raw);
        } catch {
            return;
        }
        if (!msg || typeof msg !== "object") return;
        if (msg.t === "hello") {
            if (a.pid) return;
            return this.hello(ws, a, msg);
        }
        const s = this.state;
        if (!s || !a.pid) return;
        const me = this.player(a.pid);
        if (!me || me.left) return;
        const isHost = s.host === me.pid;
        const now = Date.now();

        switch (msg.t) {
        case "rec": {
            const f = msg.f;
            if (msg.s !== s.session || !me.inRound || !Number.isSafeInteger(f) || f <= 0 || f > MAX_FRAMES) return;
            if (s.phase !== "loading" && s.phase !== "race") return;
            if (s.endsAt && now > s.endsAt + LATE_RECORD_MS) return;
            if (me.best != null && f >= me.best) return;
            me.best = f;
            for (const { ws: other, a: oa } of this.sockets()) this.send(other, { t: "rec", id: me.pid, f: this.visibleBest(me, oa.pid) });
            this.dirty();
            return;
        }
        case "loaded":
            if (msg.s !== s.session || me.loaded) return;
            me.loaded = true;
            if (msg.fail) {
                me.inRound = false;
                this.message('"' + me.nick + '" couldn\'t load this map and sits it out.');
            }
            this.checkLoaded();
            this.broadcast({ t: "loaded", id: me.pid, inRound: me.inRound });
            this.dirty();
            return;
        case "skip": {
            if ((s.phase !== "loading" && s.phase !== "race") || !me.inRound || s.settings.skip === "off") return;
            if (!this.allow(me.pid, "skip", 300, 10, 10_000)) return;
            me.skip = !!msg.on;
            if (me.skip && s.skips >= MAX_SKIPS_PER_ROUND) {
                me.skip = false;
                this.send(ws, { t: "msg", text: "No skips left for this round." });
            }
            this.broadcast({ t: "skip", votes: this.racers().filter((p) => p.skip).map((p) => p.pid), need: this.skipNeed(), left: MAX_SKIPS_PER_ROUND - s.skips });
            if (me.skip) {
                const votes = this.racers().filter((p) => p.skip).length;
                if (votes < this.skipNeed()) this.message('"' + me.nick + '" wants to skip (' + votes + "/" + this.skipNeed() + ").");
            }
            this.checkSkip();
            this.dirty();
            return;
        }
        case "ready":
            if (s.phase !== "lobby") return;
            me.ready = !!msg.on;
            this.dirty();
            this.broadcastState();
            return;
        case "ping":
            if (Number.isFinite(msg.ms)) me.ping = Math.max(0, Math.min(9999, Math.round(msg.ms)));
            if (now - this.lastPingBroadcast >= PING_BROADCAST_MS) {
                this.lastPingBroadcast = now;
                const pings = {};
                for (const p of s.players) if (p.ping != null) pings[p.pid] = p.ping;
                this.broadcast({ t: "pings", p: pings });
            }
            return;
        case "chat": {
            const text = cleanText(msg.text, MAX_CHAT);
            if (!text) return;
            if (!this.allow(me.pid, "chat", CHAT_GAP_MS, CHAT_BURST, CHAT_WINDOW_MS)) {
                return this.send(ws, { t: "msg", text: "Slow down a little." });
            }
            const m = { id: me.pid, nick: me.nick, text: censor(text), at: now };
            this.chat.push(m);
            if (this.chat.length > CHAT_KEPT) this.chat.splice(0, this.chat.length - CHAT_KEPT);
            this.broadcast({ t: "chat", m });
            return;
        }
        case "leave":
            this.removePlayer(me, "left");
            await this.schedule();
            return;
        }

        if (!isHost) return;
        switch (msg.t) {
        case "settings": {
            if (s.phase !== "lobby") return this.send(ws, { t: "msg", text: "Settings can only change between matches." });
            const next = readSettings(msg.settings, s.settings, me.nick);
            if (!next.pool.length) return this.send(ws, { t: "msg", text: "Pick at least one week of maps." });
            if (next.maxPlayers < this.activePlayers().length) next.maxPlayers = Math.max(NUMBERS.maxPlayers[0], this.activePlayers().length);
            s.settings = next;
            this.dirty();
            this.broadcastState();
            return;
        }
        case "start":
            if (s.phase !== "lobby") return;
            if (!this.startMatch()) this.send(ws, { t: "msg", text: "Pick at least one week of maps." });
            break;
        case "end":
            if (s.phase === "lobby" || s.phase === "final") return;
            if (s.phase === "loading" || s.phase === "race") {
                for (const p of s.players) p.inRound = false;
            }
            s.phase = "final";
            s.deadline = now + FINAL_MS;
            this.message("The host ended the match.");
            this.dirty();
            this.broadcastState();
            break;
        case "lobby":
            if (s.phase !== "final") return;
            this.toLobby();
            break;
        case "kick": {
            const target = this.player(msg.id);
            if (!target || target.pid === me.pid || target.left) return;
            this.removePlayer(target, "kicked");
            break;
        }
        case "host": {
            const target = this.player(msg.id);
            if (!target || target.pid === me.pid || target.left || !target.connected) return;
            s.host = target.pid;
            this.message('"' + target.nick + '" is now the host.');
            this.dirty();
            this.broadcastState();
            break;
        }
        default:
            return;
        }
        await this.schedule();
    }

    async webSocketClose(ws) {
        const a = ws.deserializeAttachment();
        try {
            ws.close();
        } catch {}
        if (!a?.pid || !this.state) return;
        const p = this.player(a.pid);
        if (!p || p.sock !== a.sock || p.left) return;
        p.connected = false;
        p.dropAt = Date.now() + DROP_MS;
        p.skip = false;
        this.checkLoaded();
        this.checkSkip();
        this.dirty();
        this.broadcastState();
        await this.schedule();
    }

    async webSocketError(ws) {
        await this.webSocketClose(ws);
    }
}

// Lobby codes and the public list. One instance ("global"). Rows are tiny and few; a listing
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
        const lobbies = rows.map((r) => ({ code: r.code, ...JSON.parse(r.info || "{}") }))
            .filter((l) => l.players > 0)
            .sort((a, b) => (a.phase === "lobby" ? 0 : 1) - (b.phase === "lobby" ? 0 : 1) || b.players - a.players);
        const data = { lobbies };
        this.cache = { at: now, data };
        return data;
    }
}
