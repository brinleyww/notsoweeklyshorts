// NSWS leaderboard proxy; PROXY.md explains what it hides and why. Never log request
// URLs or bodies: both can carry a player's userToken, which is an account secret.

const DEFAULT_UPSTREAM = "https://vps.kodub.com";
const DEFAULT_UPSTREAM_ORIGIN = "https://www.kodub.com";
const DEFAULT_ALLOWED_ORIGINS = ["https://brinleyww.github.io"];
const DEFAULT_VERSION = "0.6.2";

// Only these path prefixes are forwarded, so the Worker can't be used as an
// open relay to arbitrary hosts.
const ALLOWED_PREFIXES = ["/v6/"];

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
const CREATOR_KEY_PREFIX = "nsws-creator:";

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
        creatorKeys: new Set(listVar(env.CREATOR_KEY_HASHES, []).map((h) => h.trim().toLowerCase()).filter((h) => HEX64.test(h))),
    };
}

function isBanned(entry, cfg) {
    return cfg.banned.has(normalizeNickname(entry.nickname));
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

function forbidden() {
    return new Response("Forbidden", {
        status: 403,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
}

function plain(status, text, origin) {
    return new Response(text, {
        status,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...corsHeaders(origin) },
    });
}

function json(data, origin) {
    return new Response(JSON.stringify(data), {
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

// Creators see every run in full, even on the week in progress. Only the token
// itself can prove it: CREATOR_KEY_HASHES holds sha256(CREATOR_KEY_PREFIX + token),
// which, unlike the plain token hash, is not anyone's public userId.
async function isCreator(params, cfg) {
    const token = params.get("userToken");
    if (!cfg.creatorKeys.size || !token || !HEX64.test(token)) return false;
    return cfg.creatorKeys.has(await sha256Hex(CREATOR_KEY_PREFIX + token));
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

async function handleLeaderboard(request, url, cfg, origin) {
    const params = url.searchParams;
    const track = await trackContext(cfg, params.get("trackId"), params.get("nswsWeek"));
    const skip = intParam(params.get("skip"), 0, Number.MAX_SAFE_INTEGER);
    const amount = intParam(params.get("amount"), 1, PAGE_SIZE);
    const read = readOptions(params);
    const hash = await callerHash(params, track);
    const creator = track.secret && await isCreator(params, cfg);

    const view = await loadView(cfg, request, track, read);
    const ranked = view.entries.filter((e) => !isBanned(e, cfg));
    let page = ranked.slice(skip, skip + amount);
    if (!view.complete && !track.hiddenId && page.length < amount) {
        const rawSkip = Math.max(skip, ranked.length) + (view.entries.length - ranked.length);
        page = page.concat(await readPastScan(cfg, request, track, read, rawSkip, amount - page.length));
    }
    if (track.secret && !creator) page = page.map((entry, i) => shield(entry, skip + i + 1, hash, cfg));

    const body = {
        total: filteredTotal(view, cfg),
        entries: page,
        userEntry: hash ? await ownEntry(cfg, request, track, read, view, hash) : null,
    };
    if (creator) body.creator = true;
    return json(body, origin);
}

async function handleUserEntry(request, url, cfg, origin) {
    const params = url.searchParams;
    const track = await trackContext(cfg, params.get("trackId"), params.get("nswsWeek"));
    const hash = await callerHash(params, track);
    if (!hash) return json(null, origin);
    const read = readOptions(params);
    const view = await loadView(cfg, request, track, read);
    return json(await ownEntry(cfg, request, track, read, view, hash), origin);
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
}

async function handleSubmit(request, url, cfg, origin) {
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
    const read = readOptions(form);
    const body = track.hiddenId ? replaceFormValue(raw, "trackId", track.hiddenId) : raw;

    // Upstream reports positions on the board it stored the run on, counting
    // banned players (and, for a hidden week, missing the runs still under the
    // real id). The board from just before the run lets both be recounted the
    // way the leaderboard shows them.
    const before = await loadView(cfg, request, track, read).catch(() => null);
    const response = await postUpstream(request, cfg, url.pathname, body);
    forgetBoards(track.trackId, track.hiddenId);
    const text = await response.text();
    let result = null;
    try {
        result = JSON.parse(text);
    } catch {
        /* not JSON - handed back untouched below */
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

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const cfg = readConfig(env);

        if (!ALLOWED_PREFIXES.some((p) => url.pathname.startsWith(p))) {
            // Not an API path. If assets are bound, let the site handle it.
            if (env.ASSETS) return env.ASSETS.fetch(request);
            return new Response("Not found", { status: 404 });
        }

        // The API is only for the game on our own site. Opening a proxy URL in
        // a tab sends no Origin, and another site sends its own - both get 403,
        // and without CORS headers a page on another site can't read it anyway.
        const origin = request.headers.get("Origin");
        if (isNavigation(request) || !isAllowedOrigin(origin, cfg)) return forbidden();

        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: corsHeaders(origin) });
        }

        try {
            if (url.pathname === "/v6/leaderboard") {
                if (request.method === "GET") return await handleLeaderboard(request, url, cfg, origin);
                if (request.method === "POST") return await handleSubmit(request, url, cfg, origin);
            } else if (url.pathname === "/v6/leaderboardUserEntry" && request.method === "GET") {
                return await handleUserEntry(request, url, cfg, origin);
            }
        } catch (err) {
            return errorResponse(err, origin);
        }

        return passThrough(request, url, cfg, origin, ctx);
    },
};
