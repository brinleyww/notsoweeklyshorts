// How many of each crate skin exist across all players (mod/nsws_crates.js). Inventories stay in each browser; pages
// report items made (opened, traded into) and gone (signed away, sold), each item once by its own id. One instance ("global").

import { DurableObject } from "cloudflare:workers";

export const CRATES_PREFIX = "/nsws/crates/";
const MAX_ITEM = 64;
const MAX_EVENTS = 60;
// A day's worth of honest openings and trade-ups is far below this; it only stops a script inflating the counts.
const MADE_PER_DAY = 40;
const COUNTS_CACHE_S = 300;
const COUNTS_KEY = new Request("https://nsws-crate-counts.invalid/");
const ITEM_ID = /^[0-9a-z]{6,24}$/;

export class CrateStats extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.sql = ctx.storage.sql;
        this.sql.exec("CREATE TABLE IF NOT EXISTS items (u TEXT PRIMARY KEY, user_id TEXT NOT NULL, i INTEGER NOT NULL, gone INTEGER NOT NULL DEFAULT 0)");
        this.sql.exec("CREATE TABLE IF NOT EXISTS counts (i INTEGER PRIMARY KEY, made INTEGER NOT NULL DEFAULT 0, gone INTEGER NOT NULL DEFAULT 0)");
        this.sql.exec("CREATE TABLE IF NOT EXISTS daily (user_id TEXT PRIMARY KEY, day INTEGER NOT NULL, n INTEGER NOT NULL)");
    }

    // Returns the ids that are settled (taken, or never going to be); the rest wait for another day's allowance.
    report(userId, events) {
        const day = Math.floor(Date.now() / 86_400_000);
        const row = this.sql.exec("SELECT day, n FROM daily WHERE user_id = ?", userId).toArray()[0];
        let made = row && row.day === day ? row.n : 0;
        const done = [];
        for (const ev of events) {
            const existing = this.sql.exec("SELECT user_id, i, gone FROM items WHERE u = ?", ev.u).toArray()[0];
            if (ev.e === 1) {
                if (existing) {
                    done.push(ev.u);
                    continue;
                }
                if (made >= MADE_PER_DAY) continue;
                made++;
                this.sql.exec("INSERT INTO items (u, user_id, i) VALUES (?, ?, ?)", ev.u, userId, ev.i);
                this.sql.exec("INSERT INTO counts (i, made) VALUES (?, 1) ON CONFLICT (i) DO UPDATE SET made = made + 1", ev.i);
                done.push(ev.u);
            } else {
                if (existing && existing.user_id === userId && !existing.gone) {
                    this.sql.exec("UPDATE items SET gone = 1 WHERE u = ?", ev.u);
                    this.sql.exec("UPDATE counts SET gone = gone + 1 WHERE i = ?", existing.i);
                }
                if (existing || made < MADE_PER_DAY) done.push(ev.u);
            }
        }
        this.sql.exec("INSERT INTO daily (user_id, day, n) VALUES (?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET day = excluded.day, n = excluded.n", userId, day, made);
        return { done };
    }

    counts() {
        const out = {};
        for (const r of this.sql.exec("SELECT i, made, gone FROM counts").toArray()) out[r.i] = Math.max(0, r.made - r.gone);
        return out;
    }
}

export function cleanEvents(list) {
    if (!Array.isArray(list)) return null;
    const out = [];
    const seen = new Set();
    for (const ev of list.slice(0, MAX_EVENTS)) {
        if (!ev || !ITEM_ID.test(ev.u ?? "") || (ev.e !== 1 && ev.e !== -1)) continue;
        if (ev.e === 1 && !(Number.isSafeInteger(ev.i) && ev.i >= 0 && ev.i < MAX_ITEM)) continue;
        const key = ev.u + ev.e;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ u: ev.u, i: ev.e === 1 ? ev.i : null, e: ev.e });
    }
    return out;
}

export async function handleCrates(request, url, env, ctx, h) {
    const origin = h.origin || "*";
    const path = url.pathname.slice(CRATES_PREFIX.length);
    if (!h.fromSite) return h.forbidden();
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: h.corsHeaders(origin) });
    if (!env.CRATES) return h.json({ error: "Crate counts aren't switched on yet." }, origin, 503);
    const stub = env.CRATES.get(env.CRATES.idFromName("global"));

    if (path === "counts" && request.method === "GET") {
        const hit = await caches.default.match(COUNTS_KEY);
        if (hit) return h.withCors(hit, origin);
        if (h.doLimited()) return h.busy(origin);
        const response = h.cachedJson({ counts: await stub.counts() }, COUNTS_CACHE_S);
        ctx.waitUntil(caches.default.put(COUNTS_KEY, response.clone()).catch(() => {}));
        return h.withCors(response, origin);
    }

    if (path === "report" && request.method === "POST") {
        if (h.doLimited()) return h.busy(origin);
        const text = await h.readSmallBody(request, 8192);
        let body = null;
        try {
            body = JSON.parse(text || "null");
        } catch {}
        if (!h.HEX64.test(body?.token ?? "")) return h.json({ error: "Your profile couldn't be read." }, origin, 400);
        const events = cleanEvents(body.events);
        if (!events) return h.json({ error: "Bad request." }, origin, 400);
        const sent = new Set((Array.isArray(body.events) ? body.events : []).map((e) => e?.u).filter((u) => typeof u === "string"));
        const valid = new Set(events.map((e) => e.u));
        const result = events.length ? await stub.report(await h.sha256Hex(body.token), events) : { done: [] };
        // Malformed entries are settled too, so a page never resends them.
        for (const u of sent) if (!valid.has(u)) result.done.push(u);
        return h.json(result, origin);
    }
    return h.json({ error: "Not found." }, origin, 404);
}
