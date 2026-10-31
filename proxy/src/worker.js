// NSWS leaderboard proxy; PROXY.md explains what it hides and why. Never log request
// URLs or bodies: both can carry a player's userToken, which is an account secret.

import { TrafficStats, readBeat, readAnnouncement, readVote, readLike, describeClient, IP_BANS_KEY, IP_BAN_DAYS } from "./traffic.js";
import { AntiCheat, RunChecker, SNAPSHOT_KEY } from "./anticheat.js";
import { inputFlags } from "./inputflags.js";
import { ChatRoom } from "./chat.js";
import { Accounts, nameKey } from "./accounts.js";
import { LobbyRoom, LobbyDirectory, LOBBY_CODE } from "./lobby.js";
import { SocketBridge } from "./bridge.js";
import { censor, findSlurs } from "./chatfilter.js";
import { describeCup, CARD_W, CARD_H } from "./cupcard.js";

export { TrafficStats, AntiCheat, RunChecker, ChatRoom, Accounts, LobbyRoom, LobbyDirectory, SocketBridge };

const DEFAULT_UPSTREAM = "https://vps.kodub.com";
const DEFAULT_UPSTREAM_ORIGIN = "https://www.kodub.com";
const DEFAULT_ALLOWED_ORIGINS = ["https://brinleyww.github.io"];
const DEFAULT_VERSION = "0.6.2";

// Only these path prefixes are forwarded, so the Worker can't be used as an
// open relay to arbitrary hosts.
const ALLOWED_PREFIXES = ["/v6/"];

// A shared cup link: /c/RW7EW, and /c/RW7EW/card.png, the picture under it. Chat apps run no
// scripts, so the Worker is the only place that can say what a cup link is about; the page itself
// just sends a player on to the site. SHARE_SITE is the copy of the site they land on.
const CUP_LINK = /^\/c\/([A-Za-z0-9]{5})(\/card\.png)?$/;
const DEFAULT_SHARE_SITE = "https://notweeklyshorts.github.io/";
// Cup pages an address may ask for in a minute. A link is read once or twice when it is posted,
// so this is only here to stop someone sweeping the codes for open cups.
const CUP_LINK_LIMIT = 40;
const CUP_LINK_WINDOW_MS = 60_000;

// Edge cache TTLs (seconds) for passed-through GETs; anything unlisted is never cached.
// Never add an endpoint whose URL carries a userToken, such as `user`.
const CACHE_TTL = {
    "/v6/recordings": 3600, // recordings are addressed by immutable id
};

// Upstream refuses to return more than this many entries per request.
const PAGE_SIZE = 500;
// How far into a leaderboard the Worker reads to find banned players and the
// caller's own entry. Community boards are a few hundred runs, so they are read
// whole. Official tracks can have far larger boards; past what is read there,
// ranks are corrected only for the bans found in the part that was read.
const SCAN_LIMIT_COMMUNITY = 5000;
const SCAN_LIMIT_OTHER = PAGE_SIZE;
const BOARD_TTL_MS = 10_000;
const BOARD_CACHE_MAX = 64;
// Shorter than this, TRACK_SALT could be guessed, so it is ignored.
const MIN_SALT_LENGTH = 16;
const OWNER_KEY_PREFIX = "nsws-owner:";
const TRAFFIC_PREFIX = "/nsws/";
const MAX_TRAFFIC_BODY = 4096;
const MAX_CHAT_BODY = 6144;
// A chat upload: the 10 MB file plus a small header (see ChatRoom.upload).
const MAX_CHAT_UPLOAD = 10 * 1024 * 1024 + 4096;
// Big tracks reach ~470 KB; the stored payload must stay under Durable Object SQLite's 2 MB value limit.
const MAX_TRACK_SYNC_BODY = 1_500_000;
const MAX_ACCOUNT_BODY = 400_000;
// How long a Worker instance reuses a board's anti-cheat verdicts. Any entry it hasn't
// seen yet is always classified at once.
const ANTICHEAT_TTL_MS = 120_000;
const TRACK_WEEKS_TTL_MS = 10 * 60_000;
// Once Cloudflare refuses Durable Object calls (the free plan's daily limits), this instance stops
// making them for a while and tells pages to come back later, instead of every page retrying.
const DO_LIMIT_PAUSE_MS = 10 * 60_000;
const DO_LIMIT_RETRY_S = 600;
// Cloudflare resets those limits at 00:00 UTC but lifted the block about 14 minutes later.
const DO_LIMIT_LIFT_MS = 15 * 60_000;
const DO_LIMIT_LATE_MS = 3 * 3600_000;
// How long an instance reuses the anti-cheat snapshot it read from KV (see AntiCheat.saveSnapshot).
const SNAPSHOT_TTL_MS = 5 * 60_000;
// Every instance rereads the ban list from KV this often; each read counts against the free plan's 100k a day.
const IP_BANS_TTL_MS = 2 * 60_000;
// These routes check the owner's key themselves, so the owner can always lift a ban from a banned network.
const OWNER_ROUTE = /^\/nsws\/(live|stats|anticheat|announce|tagadmin|ipban)(\/|$)/;
// A track the list doesn't have yet (a new week) is looked up again after this long.
const TRACK_WEEKS_RETRY_MS = 60_000;
const WR_SEEN_MAX = 2000;
// KV (FALLBACK): [{from, to}] spells in which this Worker refused uploads for the daily limits. A run the
// page kept and sent later counts as set when it says only if that moment is inside one of them, give or
// take the slack (the run was finished a little before its upload was refused).
const OUTAGES_KEY = "upload-outages";
const OUTAGES_MAX = 60;
const ACHIEVED_SLACK_MS = 10 * 60_000;
const LATE_CACHE_S = 300;

// Track ids, user tokens and token hashes are all 64 lowercase hex characters.
const HEX64 = /^[0-9a-f]{64}$/;

// Headers we must not pass upstream: hop-by-hop, Cloudflare-injected, our own
// site's cookies, and the Origin/Referer pair we replace ourselves.
const STRIP_REQUEST_HEADERS = new Set([
    "host", "origin", "referer", "cookie", "connection", "keep-alive",
    "transfer-encoding", "upgrade-insecure-requests", "content-length",
]);

class BadRequest extends Error {}

class UpstreamError extends Error {
    constructor(status) {
        super("Upstream answered " + status);
        this.status = status;
    }
}

// A list var may be a TOML array, a JSON array string, or a comma-separated string.
function listVar(value, fallback) {
    if (value == null || value === "") return fallback;
    if (Array.isArray(value)) return value.map(String);
    const text = String(value).trim();
    if (text.startsWith("[")) {
        try {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed)) return parsed.map(String);
        } catch {
            /* not JSON - read it as comma-separated */
        }
    }
    return text.split(",").map((s) => s.trim()).filter(Boolean);
}

function intVar(value) {
    if (value == null || value === "") return null;
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
}

function normalizeNickname(name) {
    return String(name ?? "").trim().toLowerCase();
}

function hashSet(value) {
    return new Set(listVar(value, []).map((h) => h.trim().toLowerCase()).filter((h) => HEX64.test(h)));
}

let warnedShortSalt = false;

function readConfig(env) {
    const salt = typeof env.TRACK_SALT === "string" ? env.TRACK_SALT : "";
    if (salt && salt.length < MIN_SALT_LENGTH && !warnedShortSalt) {
        warnedShortSalt = true;
        console.warn("TRACK_SALT is shorter than " + MIN_SALT_LENGTH + " characters and is being ignored");
    }
    return {
        upstream: env.UPSTREAM || DEFAULT_UPSTREAM,
        upstreamOrigin: env.UPSTREAM_ORIGIN || DEFAULT_UPSTREAM_ORIGIN,
        allowedOrigins: listVar(env.ALLOWED_ORIGINS, DEFAULT_ALLOWED_ORIGINS),
        banned: new Set(listVar(env.BANNED_NICKNAMES, []).map(normalizeNickname)),
        publicNicknames: new Set(listVar(env.PUBLIC_NICKNAMES, []).map(normalizeNickname)),
        currentWeek: intVar(env.CURRENT_WEEK),
        hiddenFromWeek: intVar(env.HIDDEN_FROM_WEEK),
        trackSalt: salt.length >= MIN_SALT_LENGTH ? salt : null,
        ownerKeys: hashSet(env.OWNER_KEY_HASHES),
        // The owner's public userId (sha256 of the token), whose runs may come from anywhere.
        ownerUserIds: [...hashSet(env.OWNER_USER_IDS)],
        // Ids of runs the anti-cheat hides on this request's board; set per request.
        blocked: null,
        // blocked came from fallbackBlocked, not a fresh anti-cheat answer.
        blockedFallback: false,
        // The request carries the owner's key in nswsOwner; set per request.
        owner: false,
    };
}

// Hidden from a board: a banned player, or a run the anti-cheat hasn't passed.
function isBanned(entry, cfg) {
    return cfg.banned.has(normalizeNickname(entry.nickname)) || (cfg.blocked?.has(entry.id) ?? false);
}

function isAllowedOrigin(origin, cfg) {
    return !!origin && (cfg.allowedOrigins.includes(origin) || cfg.allowedOrigins.includes("*"));
}

// Opening a proxy URL in a tab (from the network panel, a copied link, ...) is
// a navigation. The game only ever calls the API with XHR/fetch/WebSocket.
function isNavigation(request) {
    const mode = request.headers.get("Sec-Fetch-Mode");
    const dest = request.headers.get("Sec-Fetch-Dest");
    return mode === "navigate" || mode === "nested-navigate"
        || dest === "document" || dest === "iframe" || dest === "frame";
}

function corsHeaders(origin) {
    return {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
        "Vary": "Origin",
    };
}

const BLANK_PAGE = '<!doctype html><html style="background:#000"><head><meta name="color-scheme" content="dark"><title></title></head><body style="margin:0;background:#000"></body></html>';

function forbidden() {
    return new Response(BLANK_PAGE, {
        status: 403,
        headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
}

function plain(status, text, origin) {
    return new Response(text, {
        status,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...corsHeaders(origin) },
    });
}

function json(data, origin, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            // These replies can hold the caller's own entry; no cache may hand
            // them to anyone else.
            "Cache-Control": "no-store",
            ...corsHeaders(origin),
        },
    });
}

function withCors(response, origin) {
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(corsHeaders(origin))) headers.set(key, value);
    // The upstream's own CORS/cookie headers are meaningless to our callers.
    headers.delete("set-cookie");
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

function errorResponse(err, origin) {
    if (err instanceof BadRequest) return plain(400, "Bad request", origin);
    if (err instanceof UpstreamError) {
        return err.status >= 400 && err.status < 500
            ? plain(err.status, "Upstream refused the request", origin)
            : plain(502, "Upstream unreachable", origin);
    }
    noteDoError(err);
    console.error("leaderboard proxy error:", err && err.message);
    return plain(502, "Upstream unreachable", origin);
}

function upstreamRequestHeaders(request, upstreamOrigin) {
    const headers = new Headers();
    for (const [key, value] of request.headers) {
        const name = key.toLowerCase();
        if (STRIP_REQUEST_HEADERS.has(name)) continue;
        if (name.startsWith("cf-") || name.startsWith("x-forwarded-")) continue;
        headers.set(key, value);
    }
    headers.set("Origin", upstreamOrigin);
    headers.set("Referer", upstreamOrigin + "/");
    return headers;
}

const encoder = new TextEncoder();
let saltKey = null;

function hex(buffer) {
    return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

// The game's userTokenHash is the SHA-256 of the token, as hex.
async function sha256Hex(text) {
    return hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

// A home IPv6 connection holds a whole /64 and can hop around inside it, so that counts as one address.
function ipScope(ip) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (mapped) return mapped[1];
    if (!ip.includes(":")) return ip;
    const [head, tail] = ip.toLowerCase().split("::");
    const left = head ? head.split(":") : [];
    const right = tail ? tail.split(":") : [];
    const zeros = tail === undefined ? [] : Array(Math.max(0, 8 - left.length - right.length)).fill("0");
    return [...left, ...zeros, ...right].slice(0, 4).map((group) => group.replace(/^0+(?=.)/, "")).join(":");
}

async function ipHash(ip) {
    return (await sha256Hex("nsws-chat-ip:" + ipScope(ip || ""))).slice(0, 16);
}

function readIp(text) {
    const ip = typeof text === "string" ? text.trim() : "";
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
    if (v4) return v4.slice(1).every((part) => Number(part) <= 255) ? ip : null;
    return /^[0-9a-f:.]{2,45}$/i.test(ip) && ip.split(":").length >= 3 && ip.split("::").length <= 2 ? ip : null;
}

let ipBanList = null;

async function currentIpBans(env) {
    if (!env.FALLBACK) return {};
    if (!ipBanList || Date.now() - ipBanList.at > IP_BANS_TTL_MS) {
        const kept = ipBanList?.bans ?? {};
        ipBanList = { at: Date.now(), bans: kept };
        const read = await env.FALLBACK.get(IP_BANS_KEY, "json").catch((err) => {
            console.error("ban list unavailable:", err && err.message);
            return kept;
        });
        ipBanList.bans = read ?? {};
    }
    return ipBanList.bans;
}

// { until } (null = for good) if this request's address is banned, otherwise null.
async function ipBanOf(request, env) {
    const bans = await currentIpBans(env);
    const ip = request.headers.get("CF-Connecting-IP");
    if (!ip || !Object.keys(bans).length) return null;
    const until = bans[await ipHash(ip)];
    if (until === undefined || (until && until <= Date.now())) return null;
    return { until: until || null };
}

// Same shape as a real track id, but nobody without TRACK_SALT can work it out.
// The week is part of it, so claiming the wrong week for a track only ever
// reaches an empty board.
async function hiddenTrackId(salt, week, trackId) {
    if (saltKey?.salt !== salt) {
        const key = await crypto.subtle.importKey(
            "raw", encoder.encode(salt), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        saltKey = { salt, key };
    }
    return hex(await crypto.subtle.sign("HMAC", saltKey.key, encoder.encode(`nsws-week-${week}:${trackId}`)));
}

async function trackContext(cfg, trackId, weekParam) {
    if (!HEX64.test(trackId ?? "")) throw new BadRequest();
    // The page adds nswsWeek for Not So Weekly Shorts tracks only.
    const week = /^[1-9][0-9]{0,3}$/.test(weekParam ?? "") ? Number(weekParam) : null;
    return {
        trackId,
        week,
        secret: week != null && cfg.currentWeek != null && week >= cfg.currentWeek,
        hiddenId: week != null && cfg.trackSalt && cfg.hiddenFromWeek != null && week >= cfg.hiddenFromWeek
            ? await hiddenTrackId(cfg.trackSalt, week, trackId)
            : null,
    };
}

function intParam(value, min, max) {
    if (value == null || !/^[0-9]{1,16}$/.test(value)) throw new BadRequest();
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new BadRequest();
    return n;
}

function readOptions(params) {
    return {
        version: params.get("version") || DEFAULT_VERSION,
        onlyVerified: params.get("onlyVerified") === "true" ? "true" : "false",
    };
}

// Whose own entry to report, if anyone's.
async function callerHash(params, track) {
    const token = params.get("userToken");
    if (token && HEX64.test(token)) return sha256Hex(token);
    // The hash on its own is public, so for a week still in progress it can't be
    // taken as "this is me" - it would hand out anyone's time.
    if (track.secret) return null;
    const claimed = params.get("userTokenHash");
    return claimed && HEX64.test(claimed) ? claimed : null;
}

// Only the owner's key proves ownership: OWNER_KEY_HASHES holds sha256(OWNER_KEY_PREFIX + token),
// which, unlike the plain token hash, is not anyone's public userId. The owner gets
// past every restriction here; nobody else gets any exception.
async function isOwner(token, cfg) {
    if (!cfg.ownerKeys.size || typeof token !== "string" || !HEX64.test(token)) return false;
    return cfg.ownerKeys.has(await sha256Hex(OWNER_KEY_PREFIX + token));
}

// For a request from outside the allowed sites (another tool or site, or a tab):
// it is let through only if it carries the owner's key, as nswsOwner, as the userToken
// of a read, or as the userToken of an upload.
async function carriesOwnerKey(request, url, cfg) {
    if (cfg.owner || await isOwner(url.searchParams.get("userToken"), cfg)) return true;
    if (request.method !== "POST") return false;
    const length = Number(request.headers.get("Content-Length"));
    if (length > 2_000_000) return false;
    const form = new URLSearchParams(await request.clone().text());
    return isOwner(form.get("userToken"), cfg);
}

async function fetchUpstreamJson(cfg, request, path, params) {
    const target = new URL(path, cfg.upstream);
    for (const [key, value] of Object.entries(params)) target.searchParams.set(key, String(value));
    let response;
    try {
        response = await fetch(target.toString(), {
            headers: upstreamRequestHeaders(request, cfg.upstreamOrigin),
        });
    } catch {
        throw new UpstreamError(502);
    }
    if (!response.ok) throw new UpstreamError(response.status);
    return response.json();
}

async function fetchBoard(cfg, request, trackId, read, limit) {
    const entries = [];
    for (;;) {
        const data = await fetchUpstreamJson(cfg, request, "/v6/leaderboard", {
            version: read.version,
            trackId,
            skip: entries.length,
            amount: PAGE_SIZE,
            onlyVerified: read.onlyVerified,
        });
        if (!data || !Number.isSafeInteger(data.total) || !Array.isArray(data.entries)) {
            throw new UpstreamError(502);
        }
        entries.push(...data.entries);
        if (data.entries.length < PAGE_SIZE || entries.length >= data.total) {
            return { total: data.total, entries, complete: true };
        }
        if (entries.length >= limit) return { total: data.total, entries, complete: false };
    }
}

// Boards are the same for every caller until they are filtered and hidden per
// request, so each Worker instance keeps the last copy for a few seconds.
// Only finished data is kept: a pending fetch belongs to the request that
// started it and must not be awaited by another one.
const boards = new Map();

async function loadBoard(cfg, request, trackId, read, limit, fresh) {
    const key = [cfg.upstream, trackId, read.version, read.onlyVerified, limit].join("|");
    const hit = boards.get(key);
    if (!fresh && hit && Date.now() - hit.at < BOARD_TTL_MS) return hit.board;
    const board = await fetchBoard(cfg, request, trackId, read, limit);
    boards.delete(key);
    boards.set(key, { at: Date.now(), board });
    if (boards.size > BOARD_CACHE_MAX) boards.delete(boards.keys().next().value);
    return board;
}

// A hidden week still shows the runs that were set under the real id before
// it was hidden: one entry per player, whichever run is faster.
function mergeBoards(real, hidden) {
    const best = new Map();
    for (const entry of real.entries.concat(hidden.entries)) {
        const key = typeof entry.userId === "string" && entry.userId ? entry.userId : "#" + entry.id;
        const kept = best.get(key);
        if (!kept || entry.frames < kept.frames) best.set(key, entry);
    }
    // Stable sort, so equal times keep upstream order (real-id runs first).
    const entries = [...best.values()].sort((a, b) => a.frames - b.frames);
    const complete = real.complete && hidden.complete;
    return { total: complete ? entries.length : real.total + hidden.total, entries, complete };
}

// The board as this track's players see it, banned players still included.
async function loadView(cfg, request, track, read, fresh = false) {
    const limit = track.week != null ? SCAN_LIMIT_COMMUNITY : SCAN_LIMIT_OTHER;
    if (!track.hiddenId) return loadBoard(cfg, request, track.trackId, read, limit, fresh);
    const [real, hidden] = await Promise.all([
        loadBoard(cfg, request, track.trackId, read, limit, fresh),
        loadBoard(cfg, request, track.hiddenId, read, limit, fresh),
    ]);
    return mergeBoards(real, hidden);
}

function bannedCount(entries, cfg) {
    let n = 0;
    for (const entry of entries) if (isBanned(entry, cfg)) n++;
    return n;
}

// Rank of a player's run counting only players who aren't banned. A banned
// player still gets a rank for their own run - it is only ever shown to them,
// and without their own entry the game would keep uploading the run again.
function rankOf(view, hash, cfg) {
    const index = view.entries.findIndex((e) => e.userId === hash);
    if (index < 0) return null;
    return { entry: view.entries[index], position: index + 1 - bannedCount(view.entries.slice(0, index), cfg) };
}

// An upstream position on an unmerged board, minus the banned players above it.
function withoutBannedAbove(view, position, cfg) {
    if (!Number.isSafeInteger(position) || position <= 0) return position;
    return position - bannedCount(view.entries.slice(0, position - 1), cfg);
}

function filteredTotal(view, cfg) {
    const banned = bannedCount(view.entries, cfg);
    return view.complete ? view.entries.length - banned : Math.max(0, view.total - banned);
}

async function ownEntry(cfg, request, track, read, view, hash) {
    const rank = rankOf(view, hash, cfg);
    if (rank) {
        const { entry, position } = rank;
        return { position, frames: entry.frames, verifiedState: entry.verifiedState, id: entry.id };
    }
    if (view.complete || track.hiddenId) return null;
    // Further down a big board than was read: ask upstream, then take off the
    // banned players found in the part that was read - they are all ahead.
    const data = await fetchUpstreamJson(cfg, request, "/v6/leaderboardUserEntry", {
        version: read.version,
        trackId: track.trackId,
        userTokenHash: hash,
        onlyVerified: read.onlyVerified,
    });
    if (!data || typeof data !== "object" || !Number.isSafeInteger(data.position)) return null;
    return { ...data, position: Math.max(1, data.position - bannedCount(view.entries, cfg)) };
}

// Page rows past what was read (big official boards only). Assumes no banned
// player sits between the end of the read and this page.
async function readPastScan(cfg, request, track, read, rawSkip, count) {
    const data = await fetchUpstreamJson(cfg, request, "/v6/leaderboard", {
        version: read.version,
        trackId: track.trackId,
        skip: rawSkip,
        amount: Math.min(PAGE_SIZE, count + cfg.banned.size),
        onlyVerified: read.onlyVerified,
    });
    const entries = data && Array.isArray(data.entries) ? data.entries : [];
    return entries.filter((e) => !isBanned(e, cfg)).slice(0, count);
}

// Someone else's run on a week still in progress: keep who they are and where
// they rank; drop the time, the recording id (so their ghost can't be fetched)
// and when it was set. PUBLIC_NICKNAMES keep their time - the medals' Author
// Time is read from it - but not their recording.
function shield(entry, position, callerHashValue, cfg) {
    if (callerHashValue && entry.userId === callerHashValue) return entry;
    const isPublic = cfg.publicNicknames.has(normalizeNickname(entry.nickname));
    return {
        id: -position,
        userId: "",
        nickname: entry.nickname,
        countryCode: entry.countryCode ?? null,
        carStyle: entry.carStyle,
        // A stand-in that still passes the game's checks and sorts in rank order.
        frames: isPublic ? entry.frames : position,
        verifiedState: entry.verifiedState,
        hidden: !isPublic,
    };
}

// Every nickname the boards hand out goes through the chat's slur filter. Bans and name
// matching use the raw name, so this is only ever applied on the way out.
function censorNames(value) {
    if (Array.isArray(value)) return value.map(censorNames);
    if (!value || typeof value !== "object") return value;
    const out = { ...value };
    if (typeof out.nickname === "string") out.nickname = censor(out.nickname);
    if (out.entry && typeof out.entry === "object") out.entry = censorNames(out.entry);
    return out;
}

let doLimitedUntil = 0;

function doLimited() {
    return Date.now() < doLimitedUntil;
}

function noteDoError(err) {
    if (/free tier|exceeded allowed/i.test(err?.message ?? "")) doLimitedUntil = Date.now() + DO_LIMIT_PAUSE_MS;
}

// When the daily limits are expected to lift, for pages to tell players. Still refused soon after the
// reset means Cloudflare is late lifting yesterday's block (10-30: past 00:40), not a new day used up.
function limitLiftsAt() {
    const now = Date.now();
    const today = now - (now % 86_400_000) + DO_LIMIT_LIFT_MS;
    if (now < today) return today;
    if (now < today + DO_LIMIT_LATE_MS) return now + DO_LIMIT_RETRY_S * 1000;
    return today + 86_400_000;
}

function busy(origin) {
    return json({ error: "busy", retry: DO_LIMIT_RETRY_S, until: limitLiftsAt() }, origin, 503);
}

// Until when this instance has already written the outage it is in.
let outageNotedUntil = 0;

function noteUploadOutage(env, ctx) {
    const now = Date.now();
    if (!env.FALLBACK || now < outageNotedUntil) return;
    const to = limitLiftsAt();
    outageNotedUntil = to;
    ctx.waitUntil((async () => {
        const list = (await env.FALLBACK.get(OUTAGES_KEY, "json")) ?? [];
        if (list.some((o) => o.from <= now && now <= o.to)) return;
        list.push({ from: now, to });
        await env.FALLBACK.put(OUTAGES_KEY, JSON.stringify(list.slice(-OUTAGES_MAX)));
    })().catch((err) => {
        outageNotedUntil = 0;
        console.error("outage note failed:", err && err.message);
    }));
}

// The page's nswsAchievedAt (ms) if it falls in a noted outage, else null: the run then counts from its upload.
async function achievedAt(env, value) {
    if (!env.FALLBACK || !/^[0-9]{13}$/.test(value ?? "")) return null;
    const at = Number(value);
    if (at > Date.now()) return null;
    const list = await env.FALLBACK.get(OUTAGES_KEY, "json").catch(() => null);
    return Array.isArray(list) && list.some((o) => o.from - ACHIEVED_SLACK_MS <= at && at <= o.to) ? at : null;
}

function antiCheat(env) {
    return env.ANTICHEAT ? env.ANTICHEAT.get(env.ANTICHEAT.idFromName("global")) : null;
}

// One instance: each replay is its own call, so an upload waits behind at most one
// background replay, and only one copy of the physics is in memory.
function runChecker(env) {
    return env.RUN_CHECKER.get(env.RUN_CHECKER.idFromName("main"));
}

function accounts(env) {
    return env.ACCOUNTS ? env.ACCOUNTS.get(env.ACCOUNTS.idFromName("global")) : null;
}

// "userId|name" pairs this instance has already passed on, so a busy board isn't re-sent.
const seenNames = new Set();

function observeNames(env, ctx, entries) {
    const stub = accounts(env);
    if (!stub || doLimited() || !entries.length) return;
    const fresh = [];
    for (const e of entries) {
        if (!HEX64.test(e?.userId ?? "") || typeof e.nickname !== "string") continue;
        const pair = e.userId + "|" + e.nickname;
        if (seenNames.has(pair)) continue;
        seenNames.add(pair);
        fresh.push({ userId: e.userId, nickname: e.nickname });
    }
    if (seenNames.size > 50_000) seenNames.clear();
    if (fresh.length) ctx.waitUntil(stub.observeNames(fresh).catch(() => {}));
}

// track id -> { at, known: Set of classified ids, blocked: Set }
const verdicts = new Map();

// track id -> week, from the anti-cheat's synced tracks, so a made-up nswsWeek on some other
// board can't count towards the NSWS King.
let trackWeeks = null;

async function knownWeek(env, trackId) {
    const saved = (await verdictSnapshot(env))?.weeks?.[trackId];
    if (Number.isSafeInteger(saved)) return saved;
    const stale = !trackWeeks || Date.now() - trackWeeks.at > TRACK_WEEKS_TTL_MS;
    const missing = trackWeeks && !trackWeeks.map.has(trackId) && Date.now() - trackWeeks.at > TRACK_WEEKS_RETRY_MS;
    if (stale || missing) {
        const anti = antiCheat(env);
        if (!anti) return null;
        trackWeeks = { at: Date.now(), map: new Map(await anti.trackWeeks()) };
    }
    return trackWeeks.map.get(trackId) ?? null;
}

// track id -> the first place this instance last passed to Accounts.
const wrSeen = new Map();

function noteWr(env, ctx, track, entry) {
    const stub = accounts(env);
    if (!stub || doLimited()) return;
    const holder = HEX64.test(entry?.userId ?? "") ? entry : null;
    const key = holder ? holder.userId + "|" + holder.frames + "|" + holder.nickname : "";
    if (wrSeen.get(track.trackId) === key) return;
    wrSeen.set(track.trackId, key);
    if (wrSeen.size > WR_SEEN_MAX) wrSeen.delete(wrSeen.keys().next().value);
    // Accounts already had this holder when the snapshot was saved.
    const snap = snapshot?.data;
    if (snap?.wrs && snap.weeks?.[track.trackId] === track.week
        && (snap.wrs[track.trackId] ?? "") === (holder ? holder.userId + "|" + holder.frames : "")) return;
    ctx.waitUntil((async () => {
        if (await knownWeek(env, track.trackId) !== track.week) return;
        const { retags } = await stub.noteWrs([{
            track: track.trackId, week: track.week,
            userId: holder?.userId ?? null, nickname: holder?.nickname ?? "", frames: holder?.frames ?? 0,
        }]);
        for (const retag of retags ?? []) await chatRetag(env, retag);
    })().catch((err) => {
        wrSeen.delete(track.trackId);
        console.error("WR note failed:", err && err.message);
    }));
}

let snapshot = null;

async function verdictSnapshot(env) {
    if (!env.FALLBACK) return null;
    if (!snapshot || Date.now() - snapshot.at > SNAPSHOT_TTL_MS) {
        snapshot = { at: Date.now(), data: null };
        snapshot.data = await env.FALLBACK.get(SNAPSHOT_KEY, "json").catch((err) => {
            console.error("anti-cheat snapshot unavailable:", err && err.message);
            return null;
        });
    }
    return snapshot.data;
}

// While the anti-cheat can't be reached: this instance's last verdicts, then the snapshot in KV.
// A run newer than both was never checked, so it stays hidden until the anti-cheat is back.
// A board neither has seen counts as all legacy, as it would on its first anti-cheat visit.
async function fallbackBlocked(env, cfg, track, view) {
    const saved = (await verdictSnapshot(env))?.tracks?.[track.trackId];
    const hit = verdicts.get(track.trackId);
    if (!saved && !hit) return null;
    const owners = new Set(cfg.ownerUserIds);
    const blocked = new Set([...(hit?.blocked ?? []), ...(saved?.blocked ?? [])]);
    const holds = new Set(saved?.holds ?? []);
    const ok = new Set(saved?.ok ?? []);
    const top = saved?.top ?? 0;
    for (const e of view.entries) {
        if (!Number.isSafeInteger(e.id) || e.id <= 0 || owners.has(e.userId) || hit?.known.has(e.id)) continue;
        if (holds.has(e.userId + "|" + e.frames) || holds.has("#" + e.id)) blocked.add(e.id);
        else if (e.id > top && !ok.has(e.id)) blocked.add(e.id);
    }
    cfg.blockedFallback = true;
    return blocked;
}

// The anti-cheat's verdicts as of the last snapshot, when it had already seen every run on this board.
// A newer run, or a board it hasn't saved, needs the anti-cheat itself (null).
async function snapshotBlocked(env, cfg, track, view) {
    const saved = (await verdictSnapshot(env))?.tracks?.[track.trackId];
    if (!saved) return null;
    const owners = new Set(cfg.ownerUserIds);
    const hidden = new Set(saved.blocked);
    const holds = new Set(saved.holds);
    const ok = new Set(saved.ok);
    const blocked = new Set();
    for (const e of view.entries) {
        if (!Number.isSafeInteger(e.id) || e.id <= 0 || owners.has(e.userId)) continue;
        if (e.id > saved.top && !ok.has(e.id)) return null;
        if (hidden.has(e.id) || holds.has(e.userId + "|" + e.frames) || holds.has("#" + e.id)) blocked.add(e.id);
    }
    return blocked;
}

// Equal times go to whoever set theirs first. Upstream already orders them by upload; a run set during an
// outage and uploaded after it sorts by where the anti-cheat placed it (tie id, then when it was set).
async function orderTies(env, track, view) {
    const late = track.week != null ? (await verdictSnapshot(env))?.tracks?.[track.trackId]?.late : null;
    if (!late?.length) return view;
    const keys = new Map(late.map(([id, tie, at]) => [id, [tie, at]]));
    const key = (e) => keys.get(e.id) ?? [e.id, Infinity];
    const entries = view.entries.slice().sort((a, b) => {
        if (a.frames !== b.frames) return a.frames - b.frames;
        const ka = key(a);
        const kb = key(b);
        return ka[0] - kb[0] || ka[1] - kb[1];
    });
    return { ...view, entries };
}

// An ended week's runs that were set during an outage and uploaded after it, for the page to add to standings
// locked before they arrived (it keeps those set before the lock).
async function handleLate(url, env, cfg, origin) {
    const week = Number(url.searchParams.get("week"));
    const tracks = {};
    const snap = Number.isSafeInteger(week) && cfg.currentWeek != null && week < cfg.currentWeek
        ? await verdictSnapshot(env) : null;
    for (const [id, saved] of Object.entries(snap?.tracks ?? {})) {
        if ((snap.weeks?.[id] ?? week) !== week || !saved.late?.length) continue;
        const blocked = new Set(saved.blocked);
        const runs = saved.late
            .filter(([runId, , , nickname, , runWeek]) => runWeek === week && !blocked.has(runId) && !cfg.banned.has(normalizeNickname(nickname)))
            .map(([, tie, at, nickname, frames]) => ({ nickname: censor(nickname), frames, at, tie }));
        if (runs.length) tracks[id] = runs;
    }
    return new Response(JSON.stringify({ week, tracks }), {
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "public, max-age=" + LATE_CACHE_S,
            ...corsHeaders(origin),
        },
    });
}

// Runs on the board the snapshot hasn't seen; everything when there is no snapshot of it.
async function unseenRuns(env, track, entries) {
    const saved = (await verdictSnapshot(env))?.tracks?.[track.trackId];
    return saved ? entries.filter((e) => !(e.id <= saved.top)) : entries;
}

async function blockedRuns(env, cfg, track, view) {
    const anti = antiCheat(env);
    if (!anti || track.week == null) return null;
    const hit = verdicts.get(track.trackId);
    const known = hit && view.entries.every((e) => hit.known.has(e.id));
    if (known && (Date.now() - hit.at < ANTICHEAT_TTL_MS || doLimited())) return hit.blocked;
    if (doLimited()) return fallbackBlocked(env, cfg, track, view);
    const saved = await snapshotBlocked(env, cfg, track, view);
    if (saved) return saved;
    const entries = view.entries.map((e) => ({ id: e.id, userId: e.userId, frames: e.frames, nickname: e.nickname }));
    const blocked = new Set(await anti.classify(track.trackId, track.week, entries, cfg.ownerUserIds));
    verdicts.delete(track.trackId);
    verdicts.set(track.trackId, { at: Date.now(), known: new Set(view.entries.map((e) => e.id)), blocked });
    if (verdicts.size > BOARD_CACHE_MAX) verdicts.delete(verdicts.keys().next().value);
    return blocked;
}

async function handleLeaderboard(request, url, env, cfg, origin, ctx) {
    const params = url.searchParams;
    const track = await trackContext(cfg, params.get("trackId"), params.get("nswsWeek"));
    const skip = intParam(params.get("skip"), 0, Number.MAX_SAFE_INTEGER);
    const amount = intParam(params.get("amount"), 1, PAGE_SIZE);
    const read = readOptions(params);
    const hash = await callerHash(params, track);
    const owner = cfg.owner || await isOwner(params.get("userToken"), cfg);

    const view = await orderTies(env, track, await loadView(cfg, request, track, read));
    if (track.week != null) observeNames(env, ctx, await unseenRuns(env, track, view.entries));
    // If the anti-cheat is unreachable the board still loads, filtered by its last verdicts.
    cfg.blocked = await blockedRuns(env, cfg, track, view).catch((err) => {
        noteDoError(err);
        console.error("anti-cheat unavailable:", err && err.message);
        return fallbackBlocked(env, cfg, track, view);
    });
    const ranked = view.entries.filter((e) => !isBanned(e, cfg));
    if (skip === 0 && cfg.blocked && !cfg.blockedFallback && read.version === DEFAULT_VERSION && read.onlyVerified === "false") noteWr(env, ctx, track, ranked[0]);
    let page = ranked.slice(skip, skip + amount);
    if (!view.complete && !track.hiddenId && page.length < amount) {
        const rawSkip = Math.max(skip, ranked.length) + (view.entries.length - ranked.length);
        page = page.concat(await readPastScan(cfg, request, track, read, rawSkip, amount - page.length));
    }
    if (track.secret && !owner) page = page.map((entry, i) => shield(entry, skip + i + 1, hash, cfg));

    const body = {
        total: filteredTotal(view, cfg),
        entries: censorNames(page),
        userEntry: hash ? censorNames(await ownEntry(cfg, request, track, read, view, hash)) : null,
    };
    if (owner && track.secret) body.owner = true;
    // Only the owner's reply says which runs are flagged, so no one else can read it from the network panel.
    if (owner && track.week != null) {
        const flagged = await antiCheat(env)?.flaggedOn(track.trackId).catch(() => null);
        if (flagged) body.flagged = page.map((e) => e.id).filter((id) => flagged.includes(id));
    }
    return json(body, origin);
}

async function handleUserEntry(request, url, env, cfg, origin) {
    const params = url.searchParams;
    const track = await trackContext(cfg, params.get("trackId"), params.get("nswsWeek"));
    const hash = await callerHash(params, track);
    if (!hash) return json(null, origin);
    const read = readOptions(params);
    const view = await orderTies(env, track, await loadView(cfg, request, track, read));
    return json(censorNames(await ownEntry(cfg, request, track, read, view, hash)), origin);
}

function postUpstream(request, cfg, path, body) {
    return fetch(new URL(path, cfg.upstream).toString(), {
        method: "POST",
        headers: upstreamRequestHeaders(request, cfg.upstreamOrigin),
        body,
        redirect: "manual",
    });
}

// Replaces one field of a form body and leaves every other byte as it came, so
// the recording and car style reach upstream exactly as the game encoded them.
function replaceFormValue(body, name, value) {
    return body.split("&").map((part) => (part.split("=", 1)[0] === name ? name + "=" + value : part)).join("&");
}

// Where the run lands on the board as it stood just before it was sent,
// counting only players who aren't banned. Upstream keeps each player's best
// run, and a run tying someone else's ranks behind it.
function recountPositions(before, hash, frames, upstreamPrevious, cfg) {
    const rank = rankOf(before, hash, cfg);
    const best = rank ? Math.min(frames, rank.entry.frames) : frames;
    let ahead = 0;
    for (const e of before.entries) if (e.userId !== hash && !isBanned(e, cfg) && e.frames <= best) ahead++;
    const positions = { newPosition: ahead + 1 };
    if (rank) positions.previousPosition = rank.position;
    // No earlier run: keep upstream's "unranked" value (0) or its "last place".
    else if (upstreamPrevious > 0) positions.previousPosition = filteredTotal(before, cfg) + 1;
    return positions;
}

// A new run makes the kept copies of its board stale.
function forgetBoards(...trackIds) {
    for (const key of boards.keys()) {
        if (trackIds.some((id) => id && key.includes("|" + id + "|"))) boards.delete(key);
    }
    for (const id of trackIds) verdicts.delete(id);
}

function antiCheatRejected(origin) {
    return plain(422, "Run failed the anti-cheat check", origin);
}

async function handleSubmit(request, url, env, cfg, origin, ctx) {
    const raw = await request.text();
    const form = new URLSearchParams(raw);
    const trackId = form.get("trackId") ?? "";
    const token = form.get("userToken") ?? "";
    const frames = Number(form.get("frames"));
    // Not a submission this Worker understands: forward it as it came.
    if (!HEX64.test(trackId) || !HEX64.test(token) || !Number.isSafeInteger(frames)) {
        return withCors(await postUpstream(request, cfg, url.pathname, raw), origin);
    }

    const track = await trackContext(cfg, trackId, url.searchParams.get("nswsWeek"));
    const hash = await sha256Hex(token);
    observeNames(env, ctx, [{ userId: hash, nickname: form.get("nickname") }]);
    const ownerUpload = cfg.owner || await isOwner(token, cfg);
    const read = readOptions(form);
    let body = track.hiddenId ? replaceFormValue(raw, "trackId", track.hiddenId) : raw;
    const uploadNick = form.get("nickname");
    if (typeof uploadNick === "string" && censor(uploadNick) !== uploadNick) body = replaceFormValue(body, "nickname", censor(uploadNick));

    // Upstream reports positions on the board it stored the run on, counting
    // banned players (and, for a hidden week, missing the runs still under the
    // real id). The board from just before the run lets both be recounted the
    // way the leaderboard shows them.
    // Runs on these boards are replayed first; a run that doesn't really finish on the
    // time it claims never reaches Kodub.
    const anti = track.week != null && !ownerUpload ? antiCheat(env) : null;
    let check = null;
    if (anti && doLimited()) {
        noteUploadOutage(env, ctx);
        return busy(origin);
    }
    if (anti) {
        const recording = form.get("recording") ?? "";
        const nickname = (form.get("nickname") ?? "").slice(0, 64);
        const key = await sha256Hex(trackId + "|" + frames + "|" + recording);
        const prep = await anti.prepareSubmit(trackId, key);
        if (prep.rejected) return antiCheatRejected(origin);
        let state = "pending";
        if (prep.payload) {
            const result = await runChecker(env).check(prep.payload, recording, frames);
            if (!result.valid) {
                await anti.reject({ key, track: trackId, week: track.week, userId: hash, nickname, frames, reason: result.reason });
                return antiCheatRejected(origin);
            }
            state = "valid";
        }
        await anti.expect({ track: trackId, userId: hash, frames, state });
        check = { recording, nickname, state, hold: null };
        const lobby = (url.searchParams.get("nswsLobby") || "").toUpperCase();
        if (LOBBY_CODE.test(lobby)) {
            check.hold = await anti.lobbyHold({
                track: trackId, week: track.week, userId: hash, nickname, frames, lobby,
                carStyle: (form.get("carStyle") ?? "").slice(0, 256), recording,
            });
        }
    }

    const before = await loadView(cfg, request, track, read).catch(() => null);
    if (before) cfg.blocked = await blockedRuns(env, cfg, track, before).catch(() => null);
    const response = await postUpstream(request, cfg, url.pathname, body);
    forgetBoards(track.trackId, track.hiddenId);
    const text = await response.text();
    let result = null;
    try {
        result = JSON.parse(text);
    } catch {
        /* not JSON - handed back untouched below */
    }
    // A referred player's first upload to an NSWS board is what earns their referrer the point.
    if (response.ok && track.week != null) {
        const stub = accounts(env);
        if (stub) ctx.waitUntil(stub.uploaded(hash).catch(() => {}));
    }
    if (check && response.ok) {
        const uploadId = typeof result === "number" ? result : result?.uploadId;
        await anti.confirm({
            track: trackId, week: track.week, uploadId, userId: hash, nickname: check.nickname, frames,
            state: check.state, recording: check.state === "pending" ? check.recording : null,
            achieved: await achievedAt(env, url.searchParams.get("nswsAchievedAt")),
            flags: await inputFlags(check.recording, frames).catch(() => null),
        });
        if (check.hold != null) await anti.lobbyUploaded(check.hold, uploadId);
    } else if (check?.hold != null) {
        await anti.lobbyDiscard(check.hold);
    }
    if (!response.ok || !result || typeof result !== "object" || !Number.isSafeInteger(result.newPosition)) {
        return new Response(text, {
            status: response.status,
            headers: {
                "Content-Type": response.headers.get("Content-Type") || "text/plain; charset=utf-8",
                "Cache-Control": "no-store",
                ...corsHeaders(origin),
            },
        });
    }

    if (before?.complete) {
        const positions = recountPositions(before, hash, frames, result.previousPosition, cfg);
        result.newPosition = positions.newPosition;
        if (Number.isSafeInteger(result.previousPosition) && positions.previousPosition != null) {
            result.previousPosition = positions.previousPosition;
        }
    } else if (before && !track.hiddenId) {
        // Only part of a big board was read: take off the banned players found in it.
        result.newPosition = withoutBannedAbove(before, result.newPosition, cfg);
        result.previousPosition = withoutBannedAbove(before, result.previousPosition, cfg);
    }
    return json(result, origin);
}

async function passThrough(request, url, cfg, origin, ctx) {
    const target = new URL(cfg.upstream);
    target.pathname = url.pathname;
    target.search = url.search;

    // Multiplayer signalling (/v6/multiplayer/host, /v6/multiplayer/join) is
    // a WebSocket upgrade: forward it untouched and hand back the 101 as-is.
    // A 101 response cannot be cloned or have headers appended.
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
        return fetch(new Request(target.toString(), {
            method: request.method,
            headers: upstreamRequestHeaders(request, cfg.upstreamOrigin),
            body: request.body,
        }));
    }

    const ttl = request.method === "GET" ? CACHE_TTL[url.pathname] : undefined;
    // Key on the URL alone. CORS headers are added per-request afterwards,
    // so a response cached for one origin is still correct for the next.
    const cacheKey = ttl ? new Request(target.toString(), { method: "GET" }) : null;

    if (cacheKey) {
        // A broken or unavailable cache must never take the proxy down with
        // it, so every cache operation falls open to the upstream fetch.
        try {
            const hit = await caches.default.match(cacheKey);
            if (hit) return withCors(hit, origin);
        } catch {
            /* cache unavailable - fall through and fetch upstream */
        }
    }

    let response;
    try {
        response = await fetch(target.toString(), {
            method: request.method,
            headers: upstreamRequestHeaders(request, cfg.upstreamOrigin),
            body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
            redirect: "manual",
        });
    } catch {
        return plain(502, "Upstream unreachable", origin);
    }

    if (cacheKey && response.status === 200) {
        const headers = new Headers(response.headers);
        headers.delete("set-cookie");
        headers.set("Cache-Control", `public, max-age=${ttl}`);
        const cacheable = new Response(response.body, {
            status: 200,
            statusText: response.statusText,
            headers,
        });
        ctx.waitUntil(caches.default.put(cacheKey, cacheable.clone()).catch(() => {}));
        return withCors(cacheable, origin);
    }

    return withCors(response, origin);
}

// The game syncs the profile from here at startup, so this is where most players' names are seen.
async function handleUserRead(request, url, env, cfg, origin, ctx) {
    const response = await passThrough(request, url, cfg, origin, ctx);
    const token = url.searchParams.get("userToken") ?? "";
    if (response.ok && HEX64.test(token)) {
        const [user, userId] = await Promise.all([response.clone().json().catch(() => null), sha256Hex(token)]);
        observeNames(env, ctx, [{ userId, nickname: user?.nickname }]);
    }
    return response;
}

// A profile save may only take a name nobody else holds. A player who already had the
// name upstream before it was registered to someone else keeps it.
async function handleUserUpdate(request, url, env, cfg, origin) {
    const raw = await request.text();
    const form = new URLSearchParams(raw);
    const token = form.get("userToken") ?? "";
    const nickname = form.get("nickname");
    if (nickname != null && findSlurs(nickname).length) return json({ nicknameBlocked: true }, origin, 422);
    const stub = accounts(env);
    if (stub && HEX64.test(token) && nickname != null && !doLimited()) {
        let taken = false;
        try {
            taken = !(await stub.claimName(await sha256Hex(token), nickname)).available;
        } catch (err) {
            noteDoError(err);
            console.error("accounts unavailable:", err && err.message);
        }
        if (taken) {
            const current = await fetchUpstreamJson(cfg, request, "/v6/user", {
                version: form.get("version") || DEFAULT_VERSION,
                userToken: token,
            }).catch(() => null);
            if (nameKey(current?.nickname) !== nameKey(nickname)) return json({ nicknameTaken: true }, origin, 409);
        }
    }
    return withCors(await postUpstream(request, cfg, url.pathname, raw), origin);
}

const ACCOUNT_PATHS = new Set(["names/check", "names/claim", "clips/list", "clips/get", "clips/add", "clips/view",
    "clips/rename", "clips/delete", "clips/share", "share/get", "refer/me", "refer/redeem", "tags/buy", "tags/equip", "bingo/mark", "bingo/reset", "grind/sync"]);
const HEX32 = /^[0-9a-f]{32}$/;

// The chat only learns about a tag change here, so its players' next messages show the new tag.
async function chatRetag(env, retag) {
    if (!env.CHAT || !retag?.uids?.length) return;
    try {
        await env.CHAT.get(env.CHAT.idFromName("global")).retag(retag.uids, retag.tag);
    } catch (err) {
        console.error("chat retag failed:", err && err.message);
    }
}

// Sent as text/plain JSON, like the chat, so no preflight is needed. Everything but opening
// a shared link needs the player's token; the account is its hash.
async function handleAccounts(request, url, env, fromSite, origin) {
    if (!fromSite) return forbidden();
    const path = url.pathname.slice(TRAFFIC_PREFIX.length);
    if (!ACCOUNT_PATHS.has(path)) return plain(404, "Not found", origin);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (request.method !== "POST") return plain(405, "Method not allowed", origin);
    const stub = accounts(env);
    if (!stub) return plain(503, "Accounts are off", origin);
    const text = await readSmallBody(request, MAX_ACCOUNT_BODY);
    if (text == null) return plain(413, "Too large", origin);
    let body;
    try {
        body = JSON.parse(text);
    } catch {
        return plain(400, "Bad request", origin);
    }
    if (path === "share/get") {
        const share = await stub.getShare(body?.id);
        return share ? json(share, origin) : plain(404, "Not found", origin);
    }
    if (!HEX64.test(body?.userToken ?? "")) return plain(400, "Bad request", origin);
    const userId = await sha256Hex(body.userToken);
    let result;
    switch (path) {
        case "names/check": result = await stub.checkName(userId, body.nickname); break;
        case "names/claim": result = await stub.claimName(userId, body.nickname); break;
        case "clips/list": result = { clips: await stub.listClips(userId) }; break;
        case "clips/get": result = await stub.getClip(userId, body.id); break;
        case "clips/add": result = await stub.addClip(userId, body.clip); break;
        case "clips/rename": result = await stub.renameClip(userId, body.id, body.name); break;
        case "clips/delete": result = await stub.deleteClip(userId, body.id); break;
        case "clips/share": result = await stub.shareClip(userId, body.code); break;
        case "clips/view": result = await stub.recordView(userId, body.key); break;
        case "refer/me": {
            // The chat's uid for this browser, derived the same way the ChatRoom does.
            const uid = HEX32.test(body.v ?? "") ? (await sha256Hex("nsws-chat:" + body.v)).slice(0, 16) : null;
            const { state, linked } = await stub.refState(userId, uid);
            await chatRetag(env, linked);
            result = state;
            break;
        }
        case "refer/redeem": {
            const ip = (await sha256Hex("nsws-refer-ip:" + (request.headers.get("CF-Connecting-IP") || ""))).slice(0, 16);
            result = await stub.redeem(userId, body.code, ip);
            break;
        }
        case "bingo/mark":
        case "bingo/reset": {
            // Pages from before rounds send none; their squares mean other things, so they mark nothing.
            const round = body.round ?? -1;
            const marked = path === "bingo/mark" ? await stub.markBingo(userId, body.week, round, body.squares) : await stub.resetBingo(userId, body.week, round);
            result = marked.error ? marked : marked.state;
            break;
        }
        case "grind/sync": result = await stub.syncGrind(userId, body.id, body.add); break;
        case "tags/buy":
        case "tags/equip": {
            const changed = path === "tags/buy" ? await stub.buyTag(userId, body.tag) : await stub.equipTag(userId, body.tag ?? null);
            if (changed.error) {
                result = changed;
                break;
            }
            await chatRetag(env, changed.retag);
            result = changed.state;
            break;
        }
    }
    if (result == null) return plain(404, "Not found", origin);
    if (result.error === "code" || result.error === "expired" || result.error === "self" || result.error === "already" || result.error === "mutual"
        || result.error === "points" || result.error === "locked" || result.error === "closed") {
        return json({ error: result.error }, origin, 409);
    }
    if (result.error === "bad") return plain(400, "Bad request", origin);
    if (result.error === "full") return plain(507, "Too many clips", origin);
    if (result.error === "busy") return plain(429, "Too many links", origin);
    return json(result, origin);
}

async function readSmallBody(request, limit) {
    const length = Number(request.headers.get("Content-Length"));
    if (length > limit) return null;
    const text = await request.text();
    return text.length > limit ? null : text;
}

// A track as the owner's game builds it for the physics check.
function readTrackSync(t) {
    const p = t?.payload;
    const v = p?.mountainVertices;
    const o = p?.mountainOffset;
    if (!HEX64.test(t?.id ?? "") || !Number.isSafeInteger(t.week)) return null;
    if (typeof p?.trackData !== "string" || !p.trackData || !Array.isArray(v) || v.length > 200_000) return null;
    if (!v.every(Number.isFinite) || ![o?.x, o?.y, o?.z].every(Number.isFinite)) return null;
    return { id: t.id, week: t.week, payload: { trackData: p.trackData, mountainVertices: v, mountainOffset: { x: o.x, y: o.y, z: o.z } } };
}

async function handleTraffic(request, url, env, cfg, origin, ctx) {
    if (request.method !== "POST") return plain(405, "Method not allowed", origin);
    if (!env.TRAFFIC) return plain(503, "Traffic stats are off", origin);
    const stub = env.TRAFFIC.get(env.TRAFFIC.idFromName("global"));
    const syncing = url.pathname === TRAFFIC_PREFIX + "anticheat/tracks";
    const text = await readSmallBody(request, syncing ? MAX_TRACK_SYNC_BODY : MAX_TRAFFIC_BODY);
    if (text == null) return plain(413, "Too large", origin);

    if (url.pathname === TRAFFIC_PREFIX + "beat") {
        const beat = readBeat(text);
        if (!beat) return plain(400, "Bad request", origin);
        const client = describeClient(request);
        const connectingIp = request.headers.get("CF-Connecting-IP");
        const meta = { ...client, site: new URL(origin).host, ip: connectingIp, ipKey: connectingIp ? await ipHash(connectingIp) : null };
        // The reply carries how many people are on the site, which the chat shows, and the
        // owner's live announcement.
        let reply = null;
        if (!doLimited()) {
            try {
                reply = await stub.beat(beat, meta);
            } catch (err) {
                noteDoError(err);
                console.error("traffic beat failed:", err && err.message);
            }
        }
        if (reply) return json({ online: reply.online ?? null, away: reply.away ?? null, ann: reply.ann ?? null, pv: reply.pv ?? null, nv: reply.nv ?? null }, origin);
        // Nothing was stored, so the page keeps this beat's counts for the next one, and leaves any
        // announcement or poll it is showing alone.
        return json(doLimited() ? { busy: true, nv: DO_LIMIT_RETRY_S, until: limitLiftsAt() } : { busy: true, nv: null }, origin);
    }
    if (url.pathname === TRAFFIC_PREFIX + "poll") {
        const vote = readVote(text);
        if (!vote) return plain(400, "Bad request", origin);
        if (doLimited()) return busy(origin);
        const result = await stub.vote(vote.visitor, vote.id, vote.choice, request.headers.get("CF-Connecting-IP"));
        if (result.error) return json(result, origin, result.error === "busy" ? 429 : 409);
        return json(result, origin);
    }
    if (url.pathname === TRAFFIC_PREFIX + "like") {
        const like = readLike(text);
        if (!like) return plain(400, "Bad request", origin);
        if (doLimited()) return busy(origin);
        const result = await stub.like(like.visitor, like.id, like.on, request.headers.get("CF-Connecting-IP"));
        if (result.error) return json(result, origin, result.error === "busy" ? 429 : 409);
        return json(result, origin);
    }

    let body;
    try {
        body = JSON.parse(text);
    } catch {
        return plain(400, "Bad request", origin);
    }
    if (!(await isOwner(body?.token, cfg))) return plain(403, "Forbidden", origin);
    if (url.pathname === TRAFFIC_PREFIX + "live") return json(await stub.liveStats(), origin);
    if (url.pathname === TRAFFIC_PREFIX + "stats") {
        return json(await stub.stats(String(body.range ?? "day"), Number(body.tz) || 0), origin);
    }
    if (url.pathname === TRAFFIC_PREFIX + "ipban" || url.pathname.startsWith(TRAFFIC_PREFIX + "ipban/")) {
        return handleIpBans(request, url, env, stub, body, origin);
    }
    const anti = antiCheat(env);
    if (url.pathname.startsWith(TRAFFIC_PREFIX + "anticheat") && !anti) return plain(503, "Anti-cheat is off", origin);
    if (url.pathname === TRAFFIC_PREFIX + "anticheat") return json(await anti.summary(), origin);
    if (syncing) {
        if (!Array.isArray(body.tracks) || body.tracks.length > 2) return plain(400, "Bad request", origin);
        const tracks = body.tracks.map(readTrackSync);
        if (tracks.some((t) => !t)) return plain(400, "Bad request", origin);
        return json(await anti.putTracks(tracks), origin);
    }
    if (url.pathname === TRAFFIC_PREFIX + "announce/list") return json(await stub.announcements(), origin);
    if (url.pathname === TRAFFIC_PREFIX + "announce") {
        const announcement = readAnnouncement(body);
        if (!announcement) return plain(400, "Bad request", origin);
        const result = await stub.announce(announcement);
        await chatBroadcast(env, { t: "ann", a: result.current });
        return json(result, origin);
    }
    if (url.pathname === TRAFFIC_PREFIX + "announce/close-poll") {
        if (!Number.isSafeInteger(body.id)) return plain(400, "Bad request", origin);
        return json(await stub.closePoll(body.id), origin);
    }
    if (url.pathname === TRAFFIC_PREFIX + "announce/stop") {
        const result = await stub.stopAnnouncement();
        if (result.stopped != null) await chatBroadcast(env, { t: "ann-stop", id: result.stopped });
        return json(result, origin);
    }
    if (url.pathname.startsWith(TRAFFIC_PREFIX + "tagadmin")) {
        const accountsStub = accounts(env);
        if (!accountsStub) return plain(503, "Accounts are off", origin);
        const sub = url.pathname.slice((TRAFFIC_PREFIX + "tagadmin").length);
        if (sub === "") return json(await accountsStub.tagOverview(), origin);
        if (sub === "/lookup") {
            const found = await accountsStub.lookupTags(body.nickname, body.userId);
            return found.error ? plain(404, "Not found", origin) : json(found, origin);
        }
        if (sub === "/search") return json(await accountsStub.searchPlayers(body.query), origin);
        if (sub === "/grant" || sub === "/bonus") {
            const changed = sub === "/grant"
                ? await accountsStub.grantTag(body.userId, body.tag, body.on === true)
                : await accountsStub.addBonus(body.userId, body.amount);
            if (changed.error) return plain(400, "Bad request", origin);
            await chatRetag(env, changed.retag);
            return json({ state: changed.state, granted: changed.granted }, origin);
        }
        return plain(404, "Not found", origin);
    }
    if (url.pathname === TRAFFIC_PREFIX + "anticheat/lobby") {
        if (!Number.isSafeInteger(body.id)) return plain(400, "Bad request", origin);
        return json(await anti.lobbyVerdict(body.id, body.verdict), origin);
    }
    if (url.pathname === TRAFFIC_PREFIX + "anticheat/lobby/all") return json(await anti.lobbyVerifyAll(), origin);
    if (url.pathname === TRAFFIC_PREFIX + "anticheat/lobby/run") {
        if (!Number.isSafeInteger(body.id)) return plain(400, "Bad request", origin);
        const run = await anti.lobbyRecording(body.id);
        return run ? json(run, origin) : plain(404, "Not found", origin);
    }
    if (url.pathname === TRAFFIC_PREFIX + "anticheat/unflag") {
        if (!Number.isSafeInteger(body.id)) return plain(400, "Bad request", origin);
        return json(await anti.unflag(body.id), origin);
    }
    if (url.pathname === TRAFFIC_PREFIX + "anticheat/scanflags") {
        if (!Number.isSafeInteger(body.after)) return plain(400, "Bad request", origin);
        return json(await anti.scanFlags(body.after), origin);
    }
    if (url.pathname === TRAFFIC_PREFIX + "anticheat/approve") {
        if (!Number.isSafeInteger(body.id)) return plain(400, "Bad request", origin);
        return json(await anti.approve(body.id), origin);
    }
    return plain(404, "Not found", origin);
}

async function handleIpBans(request, url, env, stub, body, origin) {
    const sub = url.pathname.slice((TRAFFIC_PREFIX + "ipban").length);
    const chat = env.CHAT?.get(env.CHAT.idFromName("global"));
    if (sub === "") return json(await stub.ipBans(), origin);
    if (sub === "/lookup") {
        const nickname = typeof body.nickname === "string" ? body.nickname.trim().slice(0, 64) : "";
        if (!nickname) return plain(400, "Bad request", origin);
        return json(await stub.ipLookup(nickname), origin);
    }
    if (sub === "/ban") {
        if (!IP_BAN_DAYS.includes(body.days)) return plain(400, "Bad request", origin);
        const typed = body.ip != null ? readIp(body.ip) : null;
        if (body.ip != null && !typed) return plain(400, "Bad request", origin);
        const hash = typed ? await ipHash(typed) : body.hash;
        if (!/^[0-9a-f]{16}$/.test(hash ?? "")) return plain(400, "Bad request", origin);
        if (hash === await ipHash(request.headers.get("CF-Connecting-IP"))) return json({ error: "self" }, origin);
        const until = body.days ? Date.now() + body.days * 86_400_000 : null;
        const who = typed ? "Typed address" : typeof body.who === "string" ? body.who.slice(0, 64) : null;
        const result = await stub.banIp(hash, until, who);
        await chat?.blockIp(hash, until);
        if (ipBanList) ipBanList.bans = { ...ipBanList.bans, [hash]: until ?? 0 };
        return json(result, origin);
    }
    if (sub === "/unban") {
        if (!/^[0-9a-f]{16}$/.test(body.hash ?? "")) return plain(400, "Bad request", origin);
        const result = await stub.unbanIp(body.hash);
        await chat?.unblockIp(body.hash);
        if (ipBanList) {
            const { [body.hash]: lifted, ...rest } = ipBanList.bans;
            ipBanList.bans = rest;
        }
        return json(result, origin);
    }
    return plain(404, "Not found", origin);
}

// Players with the chat open hear about announcements straight away; everyone else on their next beat.
async function chatBroadcast(env, data) {
    if (!env.CHAT) return;
    try {
        await env.CHAT.get(env.CHAT.idFromName("global")).announce(data);
    } catch (err) {
        console.error("chat announce failed:", err && err.message);
    }
}

// Where a socket goes: { ns, name, path, headers } (a Durable Object namespace, the instance and the
// request it gets), or { refused } with the error a page reads. Shared by the WebSocket routes below
// and the HTTPS fallback (handleSockets), so both take the same checks and limits.
async function chatTarget(url, connectingIp) {
    // ?cup=CODE is that cup's own chat room (src/chat.js), used by the Competitions panel.
    const cup = String(url.searchParams.get("cup") || "").toUpperCase();
    if (cup && !LOBBY_CODE.test(cup)) return { refused: "BadRequest" };
    const ip = await ipHash(connectingIp);
    const headers = { "X-Chat-Ip": ip };
    if (cup) headers["X-Chat-Cup"] = cup;
    return { ns: "CHAT", name: cup ? "cup:" + cup : "global", cup: cup || null, path: "nsws/chat" + url.search, headers };
}

async function cupTarget(url, env, role, connectingIp) {
    if (!env.LOBBY || !env.LOBBY_DIR) return { refused: "ServerUnavailable" };
    let code = String(url.searchParams.get("code") || "").trim().toUpperCase();
    // An organizer whose matchmaking socket dropped asks for its own code back (lobby.js reclaim).
    const reclaim = role === "host" ? String(url.searchParams.get("reclaim") || "").trim().toUpperCase() : "";
    if (role === "host" && LOBBY_CODE.test(reclaim)) {
        code = reclaim;
    } else if (role === "host") {
        const ip = (await sha256Hex("nsws-lobby-ip:" + (connectingIp || ""))).slice(0, 16);
        code = await env.LOBBY_DIR.get(env.LOBBY_DIR.idFromName("global")).reserve(ip);
        if (!code) return { refused: "IpLimit" };
    } else if (!LOBBY_CODE.test(code)) {
        return { refused: "ExpiredInvite" };
    }
    const headers = { "X-Cup-Code": code, "X-Cup-Role": role };
    if (role === "host" && reclaim === code) headers["X-Cup-Reclaim"] = "1";
    return { ns: "LOBBY", name: code, cup: code, path: "nsws/cup/" + role + url.search, headers };
}

function connectSocket(env, request, target) {
    const headers = new Headers(request.headers);
    for (const [k, v] of Object.entries(target.headers)) headers.set(k, v);
    return env[target.ns].get(env[target.ns].idFromName(target.name)).fetch(new Request(request, { headers }));
}

// Browsers send the page's Origin on a WebSocket upgrade too, so only the site can open the chat.
// /chat is the WebSocket. /chat/poll and /chat/send are the same chat over plain HTTPS, for
// networks whose firewall blocks WebSockets; the page sends them as text/plain so no preflight
// is needed.
async function handleChat(request, url, env, fromSite, origin) {
    // Uploaded images load in plain <img> tags, which send no Origin. Their ids are hashes, so only
    // someone who saw one in the chat can ask for it.
    const file = /^\/nsws\/chat\/file\/([0-9a-f]{32})$/.exec(url.pathname);
    if (file && request.method === "GET") {
        if (!env.CHAT) return new Response("Not found", { status: 404 });
        if (doLimited()) return new Response("Busy", { status: 503, headers: { "Cache-Control": "no-store" } });
        try {
            const range = request.headers.get("Range");
            return await env.CHAT.get(env.CHAT.idFromName("global")).fetch(new Request("https://chat.internal/nsws/chat/file/" + file[1], { headers: range ? { Range: range } : {} }));
        } catch (err) {
            noteDoError(err);
            return new Response("Busy", { status: 503, headers: { "Cache-Control": "no-store" } });
        }
    }
    if (!fromSite) return forbidden();
    if (url.pathname === TRAFFIC_PREFIX + "chat/upload") {
        if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
        if (request.method !== "POST") return plain(405, "Method not allowed", origin);
        if (!env.CHAT) return plain(503, "Chat is off", origin);
        if (Number(request.headers.get("Content-Length")) > MAX_CHAT_UPLOAD) return plain(413, "Too large", origin);
        const body = await request.arrayBuffer();
        if (body.byteLength > MAX_CHAT_UPLOAD) return plain(413, "Too large", origin);
        if (doLimited()) return busy(origin);
        const ip = await ipHash(request.headers.get("CF-Connecting-IP"));
        let reply;
        try {
            reply = await env.CHAT.get(env.CHAT.idFromName("global")).fetch(new Request("https://chat.internal/nsws/chat/upload", {
                method: "POST", headers: { "X-Chat-Ip": ip }, body,
            }));
        } catch (err) {
            noteDoError(err);
            console.error("chat upload error:", err && err.message);
            return doLimited() ? busy(origin) : plain(500, "Upload failed", origin);
        }
        return new Response(reply.body, {
            status: reply.status,
            headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...corsHeaders(origin) },
        });
    }
    const isSocket = url.pathname === TRAFFIC_PREFIX + "chat";
    if (isSocket && (request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") return forbidden();
    if (!isSocket && url.pathname !== TRAFFIC_PREFIX + "chat/poll" && url.pathname !== TRAFFIC_PREFIX + "chat/send") {
        return plain(404, "Not found", origin);
    }
    if (!isSocket && request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (!env.CHAT) return plain(503, "Chat is off", origin);
    if (doLimited()) return isSocket ? plain(503, "Chat is busy", origin) : busy(origin);
    if (isSocket) {
        const target = await chatTarget(url, request.headers.get("CF-Connecting-IP"));
        if (target.refused) return plain(404, "Not found", origin);
        try {
            return await connectSocket(env, request, target);
        } catch (err) {
            noteDoError(err);
            return plain(503, "Chat is busy", origin);
        }
    }
    const ip = await ipHash(request.headers.get("CF-Connecting-IP"));
    const room = env.CHAT.get(env.CHAT.idFromName("global"));
    if (request.method !== "POST") return plain(405, "Method not allowed", origin);
    const text = await readSmallBody(request, MAX_CHAT_BODY);
    if (text == null) return plain(413, "Too large", origin);
    let reply;
    try {
        reply = await room.fetch(new Request(url.toString(), { method: "POST", headers: { "X-Chat-Ip": ip }, body: text }));
    } catch (err) {
        noteDoError(err);
        console.error("chat error:", err && err.message);
        return doLimited() ? busy(origin) : plain(500, "Chat failed", origin);
    }
    return new Response(reply.body, {
        status: reply.status,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...corsHeaders(origin) },
    });
}

// A refusal the game can read: a failed WebSocket handshake only ever shows as a bare close.
function socketRefusal(error) {
    const pair = new WebSocketPair();
    pair[1].accept();
    pair[1].send(JSON.stringify({ type: "error", error }));
    pair[1].close(4029, "Refused");
    return new Response(null, { status: 101, webSocket: pair[0] });
}

// Competitions (src/lobby.js). /cup/list is the public cup list. The sockets stand in for Kodub's
// matchmaking server and for WebRTC: /cup/host (a new cup code), /cup/join?code= and /cup/mux?code=
// (the relayed data channels). Only the site can use them.
async function handleCup(request, url, env, fromSite, origin, cfg) {
    if (!fromSite) return forbidden();
    if (doLimited() && request.method !== "OPTIONS") {
        const upgrade = (request.headers.get("Upgrade") || "").toLowerCase() === "websocket";
        return upgrade ? socketRefusal("ServerUnavailable") : busy(origin);
    }
    if (url.pathname === TRAFFIC_PREFIX + "cup/list") {
        if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
        if (!env.LOBBY_DIR) return plain(503, "Competitions are off", origin);
        if (request.method !== "GET") return plain(405, "Method not allowed", origin);
        return json(await env.LOBBY_DIR.get(env.LOBBY_DIR.idFromName("global")).list(), origin);
    }
    if (url.pathname === TRAFFIC_PREFIX + "cup/info") {
        if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
        if (!env.LOBBY) return plain(503, "Competitions are off", origin);
        const code = String(url.searchParams.get("code") || "").trim().toUpperCase();
        if (!LOBBY_CODE.test(code)) return json({ cup: null }, origin);
        return json({ cup: await env.LOBBY.get(env.LOBBY.idFromName(code)).info() }, origin);
    }
    const role = { "cup/host": "host", "cup/join": "join", "cup/mux": "mux" }[url.pathname.slice(TRAFFIC_PREFIX.length)];
    if (!role) return plain(404, "Not found", origin);
    if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") return forbidden();
    const target = await cupTarget(url, env, role, request.headers.get("CF-Connecting-IP"));
    if (target.refused) return socketRefusal(target.refused);
    return connectSocket(env, request, target);
}

// The HTTPS fallback for sockets (src/bridge.js, mod/nsws_socket.js). /sock/open opens one of the
// page's sockets on its cup's SocketBridge; /sock/down and /sock/up carry the traffic. All three are
// site only and text/plain or binary POSTs, so no CORS preflight is needed. The Worker never reads
// /down or /up bodies: they stream straight to and from the bridge, so a busy cup costs it no CPU.
const SOCK_SID = /^[0-9a-f]{32}$/;
const MAX_SOCK_PATH = 512;

async function handleSockets(request, url, env, fromSite, origin) {
    if (!fromSite) return forbidden();
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
    if (request.method !== "POST") return plain(405, "Method not allowed", origin);
    if (!env.BRIDGE) return plain(503, "Sockets over HTTPS are off", origin);
    if (doLimited()) return url.pathname.endsWith("/open") ? json({ refused: "ServerUnavailable" }, origin) : busy(origin);
    const sid = url.searchParams.get("sid") || "";
    const cup = String(url.searchParams.get("b") || "").toUpperCase();
    if (!SOCK_SID.test(sid)) return plain(400, "Bad request", origin);
    const op = url.pathname.slice((TRAFFIC_PREFIX + "sock/").length);
    if (op === "open") {
        const ch = Number(url.searchParams.get("ch"));
        const text = await readSmallBody(request, MAX_SOCK_PATH);
        if (text == null || !Number.isSafeInteger(ch)) return plain(400, "Bad request", origin);
        const target = await sockTarget(text, env, request.headers.get("CF-Connecting-IP"));
        if (target.refused) return json({ refused: target.refused }, origin);
        const bridge = env.BRIDGE.get(env.BRIDGE.idFromName(target.cup));
        const result = await bridge.open(sid, ch, { ns: target.ns, name: target.name, path: target.path, headers: target.headers });
        return json(result.refused ? result : { b: target.cup }, origin);
    }
    if (op !== "down" && op !== "up") return plain(404, "Not found", origin);
    if (!LOBBY_CODE.test(cup)) return plain(400, "Bad request", origin);
    const bridge = env.BRIDGE.get(env.BRIDGE.idFromName(cup));
    const inner = new URL("https://bridge.internal/" + op + url.search);
    const res = await bridge.fetch(new Request(inner.toString(), {
        method: "POST",
        body: op === "up" ? request.body : null,
        duplex: "half",
    }));
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v);
    return new Response(res.body, { status: res.status, headers });
}

// ---- Shared cup links (/c/<code>) ----

const cupLinkHits = new Map();

function cupLinkFlood(ip) {
    if (!ip) return false;
    const now = Date.now();
    if (cupLinkHits.size > 2000) cupLinkHits.clear();
    const seen = cupLinkHits.get(ip);
    if (!seen || now - seen.at > CUP_LINK_WINDOW_MS) {
        cupLinkHits.set(ip, { at: now, count: 1 });
        return false;
    }
    return ++seen.count > CUP_LINK_LIMIT;
}

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// The page a cup link opens. A player is sent straight on to the site; a chat app stops at the meta
// tags, which is the whole point of the page. It never says more about a cup than its join card
// does, and whoever has the link can open that card anyway.
async function handleCupLink(request, url, env, code, wantsCard) {
    if (request.method !== "GET" && request.method !== "HEAD") return plain(405, "Method not allowed", null);
    const site = ((typeof env.SHARE_SITE === "string" && env.SHARE_SITE) || DEFAULT_SHARE_SITE).replace(/\/*$/, "/");
    const open = new URL(site);
    open.search = "";
    open.hash = "";
    open.searchParams.set("cup", code);
    const here = url.origin + "/c/" + code;
    const flooded = cupLinkFlood(request.headers.get("CF-Connecting-IP"));

    // A cup that can't be looked up (the daily Durable Object limits, or a swept code) reads as one
    // that has ended, which is what an old link looks like anyway.
    let info = null;
    let drawn = false;
    if (env.LOBBY && LOBBY_CODE.test(code) && !doLimited() && !flooded) {
        try {
            const room = env.LOBBY.get(env.LOBBY.idFromName(code));
            if (wantsCard) {
                const png = await room.card(code, site);
                return new Response(png, {
                    headers: {
                        "Content-Type": "image/png",
                        "Cache-Control": "public, max-age=300",
                        "Content-Length": String(png.byteLength),
                    },
                });
            }
            info = await room.info();
            drawn = true;
        } catch (err) {
            noteDoError(err);
            console.error("cup link error:", err && err.message);
            if (wantsCard) return plain(503, "No card", null);
        }
    } else if (wantsCard) {
        return plain(503, "No card", null);
    }

    const cup = describeCup(code, info);
    const description = cup.lines.filter(Boolean).map(escapeHtml).join("&#10;");
    const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(cup.title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<meta name="description" content="${description}">
<meta name="theme-color" content="${cup.color}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Cuppa · Not So Weekly Shorts">
<meta property="og:title" content="${escapeHtml(cup.title)}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${escapeHtml(here)}">
<meta property="og:image" content="${escapeHtml(drawn ? here + "/card.png" : site + "images/og.png")}">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="${CARD_W}">
<meta property="og:image:height" content="${CARD_H}">
<meta property="og:image:alt" content="${escapeHtml(cup.title)} on Not So Weekly Shorts">
<meta name="twitter:card" content="summary_large_image">
<link rel="canonical" href="${escapeHtml(open.toString())}">
<meta http-equiv="refresh" content="0;url=${escapeHtml(open.toString())}">
<style>html{color-scheme:dark}body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#192042;color:#e6ebff;font:16px/1.5 system-ui,sans-serif;text-align:center}a{color:#ffc94a}</style>
</head>
<body>
<p>Opening <b>${escapeHtml(cup.name)}</b> on Not So Weekly Shorts…<br><a href="${escapeHtml(open.toString())}">Open the cup</a></p>
<script>location.replace(${JSON.stringify(open.toString())})</script>
</body>
</html>`;
    return new Response(page, {
        headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": info ? "public, max-age=60" : "public, max-age=30",
            "Referrer-Policy": "no-referrer",
        },
    });
}

// A socket path the page asks for, checked like the WebSocket routes check theirs. Only the cup
// sockets and cup chats can be carried (the main chat has its own HTTPS fallback in src/chat.js).
async function sockTarget(text, env, connectingIp) {
    let url;
    try {
        url = new URL(String(text).trim(), "https://socket.internal/");
    } catch {
        return { refused: "BadRequest" };
    }
    const role = { "/nsws/cup/host": "host", "/nsws/cup/join": "join", "/nsws/cup/mux": "mux" }[url.pathname];
    if (role) return cupTarget(url, env, role, connectingIp);
    if (url.pathname === "/nsws/chat" && url.searchParams.get("cup")) {
        if (!env.CHAT) return { refused: "ServerUnavailable" };
        return chatTarget(url, connectingIp);
    }
    return { refused: "BadRequest" };
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const cfg = readConfig(env);
        cfg.owner = await isOwner(url.searchParams.get("nswsOwner"), cfg);
        url.searchParams.delete("nswsOwner");

        // A shared cup link. It is opened from chat apps and address bars, so unlike the API it
        // takes no Origin and no key.
        const cupLink = CUP_LINK.exec(url.pathname);
        if (cupLink) {
            try {
                return await handleCupLink(request, url, env, cupLink[1].toUpperCase(), !!cupLink[2]);
            } catch (err) {
                noteDoError(err);
                console.error("cup link error:", err && err.message);
                return plain(500, "Cup links failed", null);
            }
        }

        if (request.method !== "OPTIONS" && !OWNER_ROUTE.test(url.pathname)) {
            const ban = await ipBanOf(request, env);
            if (ban && !(await carriesOwnerKey(request, url, cfg))) {
                return json({ banned: true, until: ban.until }, request.headers.get("Origin") || "*", 403);
            }
        }

        if (url.pathname.startsWith(TRAFFIC_PREFIX)) {
            const requestOrigin = request.headers.get("Origin");
            const fromSite = !isNavigation(request) && isAllowedOrigin(requestOrigin, cfg);
            if (url.pathname === TRAFFIC_PREFIX + "chat" || url.pathname.startsWith(TRAFFIC_PREFIX + "chat/")) {
                return handleChat(request, url, env, fromSite, requestOrigin);
            }
            if (url.pathname.startsWith(TRAFFIC_PREFIX + "sock/")) {
                try {
                    return await handleSockets(request, url, env, fromSite, requestOrigin);
                } catch (err) {
                    noteDoError(err);
                    console.error("sock error:", err && err.message);
                    return doLimited() ? busy(requestOrigin) : plain(500, "Sockets failed", requestOrigin);
                }
            }
            if (url.pathname.startsWith(TRAFFIC_PREFIX + "cup/")) {
                try {
                    return await handleCup(request, url, env, fromSite, requestOrigin, cfg);
                } catch (err) {
                    noteDoError(err);
                    console.error("cup error:", err && err.message);
                    return doLimited() ? busy(requestOrigin) : plain(500, "Competitions failed", requestOrigin);
                }
            }
            if (/^\/nsws\/(names|clips|share|refer|tags|bingo|grind)\//.test(url.pathname)) {
                if (fromSite && doLimited() && request.method !== "OPTIONS") return busy(requestOrigin);
                try {
                    return await handleAccounts(request, url, env, fromSite, requestOrigin);
                } catch (err) {
                    noteDoError(err);
                    console.error("accounts error:", err && err.message);
                    return doLimited() ? busy(requestOrigin) : plain(500, "Accounts failed", requestOrigin);
                }
            }
            if (url.pathname === TRAFFIC_PREFIX + "late" && request.method === "GET") {
                if (!fromSite) return forbidden();
                return handleLate(url, env, cfg, requestOrigin);
            }
            // Owner endpoints check the owner's key themselves, so they work from anywhere.
            if (!fromSite && ["beat", "poll", "like"].some((p) => url.pathname === TRAFFIC_PREFIX + p)) return forbidden();
            const origin = requestOrigin || "*";
            if (request.method === "OPTIONS") {
                return new Response(null, { status: 204, headers: corsHeaders(origin) });
            }
            try {
                return await handleTraffic(request, url, env, cfg, origin, ctx);
            } catch (err) {
                noteDoError(err);
                console.error("traffic error:", err && err.message);
                return doLimited() ? busy(origin) : plain(500, "Traffic stats failed", origin);
            }
        }

        if (!ALLOWED_PREFIXES.some((p) => url.pathname.startsWith(p))) {
            // Not an API path. If assets are bound, let the site handle it.
            if (env.ASSETS) return env.ASSETS.fetch(request);
            return new Response("Not found", { status: 404 });
        }

        // The API is only for the game on our own site. Opening a proxy URL in
        // a tab sends no Origin, and another site sends its own - both get 403,
        // and without CORS headers a page on another site can't read it anyway.
        // The owner's key is the one exception.
        const requestOrigin = request.headers.get("Origin");
        const fromSite = !isNavigation(request) && isAllowedOrigin(requestOrigin, cfg);
        if (request.method === "OPTIONS") {
            if (!fromSite && !requestOrigin) return forbidden();
            // A preflight carries no key; the request that follows is checked in full.
            return new Response(null, { status: 204, headers: corsHeaders(requestOrigin) });
        }
        if (!fromSite && !(await carriesOwnerKey(request, url, cfg))) return forbidden();
        const origin = requestOrigin || "*";

        try {
            if (url.pathname === "/v6/leaderboard") {
                if (request.method === "GET") return await handleLeaderboard(request, url, env, cfg, origin, ctx);
                if (request.method === "POST") return await handleSubmit(request, url, env, cfg, origin, ctx);
            } else if (url.pathname === "/v6/leaderboardUserEntry" && request.method === "GET") {
                return await handleUserEntry(request, url, env, cfg, origin);
            } else if (url.pathname === "/v6/user") {
                if (request.method === "GET") return await handleUserRead(request, url, env, cfg, origin, ctx);
                if (request.method === "POST") return await handleUserUpdate(request, url, env, cfg, origin);
            }
        } catch (err) {
            const response = errorResponse(err, origin);
            if (request.method === "POST" && url.pathname === "/v6/leaderboard" && doLimited()) noteUploadOutage(env, ctx);
            return response;
        }

        return passThrough(request, url, cfg, origin, ctx);
    },

    // Every few minutes (wrangler.toml): the anti-cheat saves its verdicts to KV if they changed,
    // for leaderboards to keep their filter while Durable Objects are refused.
    async scheduled(event, env, ctx) {
        const anti = antiCheat(env);
        if (!anti || !env.FALLBACK) return;
        ctx.waitUntil((async () => {
            const stub = new Date(event.scheduledTime).getUTCMinutes() % 15 < 5 ? accounts(env) : null;
            const wrs = stub ? await stub.wrKeys().catch(() => null) : null;
            await anti.saveSnapshot(wrs);
        })().catch((err) => console.error("anti-cheat snapshot failed:", err && err.message)));
    },
};
