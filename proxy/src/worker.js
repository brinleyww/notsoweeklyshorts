/**
 * NSWS leaderboard proxy.
 *
 * vps.kodub.com only answers requests whose Origin header is one of Kodub's own
 * sites, and it never sends CORS headers, so the browser cannot talk to it
 * directly from notsoweeklyshorts. This Worker sits in front of it: it forwards
 * the request with an accepted Origin and hands the response back with CORS
 * headers attached.
 *
 * It is a pass-through. It does not read, rewrite or store leaderboard data,
 * and it never logs request bodies or query strings (both can carry a player's
 * userToken, which is an account secret).
 */

const DEFAULT_UPSTREAM = "https://vps.kodub.com";
const DEFAULT_UPSTREAM_ORIGIN = "https://www.kodub.com";

// Only these path prefixes are forwarded, so the Worker can't be used as an
// open relay to arbitrary hosts.
const ALLOWED_PREFIXES = ["/v6/"];

// Which sites may call this proxy from a browser.
// Empty array = allow any origin (what ptproxy.cwcinc.dev does today).
// Fill it in to stop other sites from putting your Worker on their bill:
//   ["https://notsoweeklyshorts.com", "http://localhost:8000"]
const ALLOWED_ORIGINS = [];

// Edge cache TTL in seconds, per endpoint. Anything not listed is never cached.
// Keep userToken-bearing endpoints (`user`) out of this map — that query string
// carries a raw account secret and must not be stored.
const CACHE_TTL = {
    "/v6/leaderboard": 10,
    "/v6/leaderboardUserEntry": 10,
    "/v6/recordings": 3600, // recordings are addressed by immutable id
};

// Headers we must not pass upstream: hop-by-hop, Cloudflare-injected, our own
// site's cookies, and the Origin/Referer pair we replace ourselves.
const STRIP_REQUEST_HEADERS = new Set([
    "host", "origin", "referer", "cookie", "connection", "keep-alive",
    "transfer-encoding", "upgrade-insecure-requests", "content-length",
]);

function corsHeaders(request) {
    const origin = request.headers.get("Origin");
    const headers = new Headers({
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
        "Vary": "Origin",
    });
    if (ALLOWED_ORIGINS.length === 0) {
        headers.set("Access-Control-Allow-Origin", "*");
    } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
        headers.set("Access-Control-Allow-Origin", origin);
    }
    return headers;
}

function withCors(response, request) {
    const headers = new Headers(response.headers);
    for (const [key, value] of corsHeaders(request)) headers.set(key, value);
    // The upstream's own CORS/cookie headers are meaningless to our callers.
    headers.delete("set-cookie");
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
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

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const upstream = env.UPSTREAM || DEFAULT_UPSTREAM;
        const upstreamOrigin = env.UPSTREAM_ORIGIN || DEFAULT_UPSTREAM_ORIGIN;

        if (!ALLOWED_PREFIXES.some((p) => url.pathname.startsWith(p))) {
            // Not an API path. If assets are bound, let the site handle it.
            if (env.ASSETS) return env.ASSETS.fetch(request);
            return new Response("Not found", { status: 404 });
        }

        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: corsHeaders(request) });
        }

        const target = new URL(upstream);
        target.pathname = url.pathname;
        target.search = url.search;

        // Multiplayer signalling (/v6/multiplayer/host, /v6/multiplayer/join) is
        // a WebSocket upgrade: forward it untouched and hand back the 101 as-is.
        // A 101 response cannot be cloned or have headers appended.
        if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
            return fetch(new Request(target.toString(), {
                method: request.method,
                headers: upstreamRequestHeaders(request, upstreamOrigin),
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
                if (hit) return withCors(hit, request);
            } catch {
                /* cache unavailable - fall through and fetch upstream */
            }
        }

        let response;
        try {
            response = await fetch(target.toString(), {
                method: request.method,
                headers: upstreamRequestHeaders(request, upstreamOrigin),
                body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
                redirect: "manual",
            });
        } catch {
            return withCors(new Response("Upstream unreachable", { status: 502 }), request);
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
            return withCors(cacheable, request);
        }

        return withCors(response, request);
    },
};
