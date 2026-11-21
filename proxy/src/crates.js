// How many of each crate skin exist across all players (mod/nsws_crates.js), and each account's saved crates. Pages
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

// Bolt figures each page keeps for its profile (mod/nsws_crates.js), all lifetime totals except b (balance) and it (parts held).
// Earned: er runs, eq quests, ew wheel payouts, es sells, el the balance a profile had when tracking began (start + legacy).
// Spent: sc crates, sw wheel bets, ls crates opened before tracking began. Counts: nr runs paid, ns seconds paid, nq quests,
// nw spins, cp/cr/ce/cb crates opened per crate (patterns, rims, exhausts, cars), lo crates opened before tracking began.
const ECON_KEYS = ["b", "it", "er", "eq", "ew", "es", "el", "sc", "sw", "ls", "nr", "ns", "nq", "nw", "cp", "cr", "ce", "cb", "lo"];
const EARN_KEYS = ["er", "eq", "ew", "es", "el"];
const SPEND_KEYS = ["sc", "sw", "ls"];
// Flows a day is credited with; the el/ls/lo baseline arrives in one go with a profile's first report, so it is never a day's.
const DAY_KEYS = ["er", "eq", "ew", "es", "sc", "sw", "nr", "ns", "nq", "nw", "cp", "cr", "ce", "cb"];
const ECON_MAX = 1_000_000_000;
const ECON_GAP_MS = 60_000;
const ECON_DAYS = 14;
// A save holds at most 500 parts (about 35 KB); a page leaving sends it with keepalive, which caps the body at 64 KB.
const MAX_SAVE = 60000;
const MAX_SAVE_ITEMS = 600;

export class CrateStats extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.sql = ctx.storage.sql;
        this.sql.exec("CREATE TABLE IF NOT EXISTS items (u TEXT PRIMARY KEY, user_id TEXT NOT NULL, i INTEGER NOT NULL, gone INTEGER NOT NULL DEFAULT 0)");
        this.sql.exec("CREATE TABLE IF NOT EXISTS counts (i INTEGER PRIMARY KEY, made INTEGER NOT NULL DEFAULT 0, gone INTEGER NOT NULL DEFAULT 0)");
        this.sql.exec("CREATE TABLE IF NOT EXISTS daily (user_id TEXT PRIMARY KEY, day INTEGER NOT NULL, n INTEGER NOT NULL)");
        // Latest figures per profile, plus their running sum (one row) and per-day flows (one row a day), both kept on write.
        this.sql.exec("CREATE TABLE IF NOT EXISTS econ (user_id TEXT PRIMARY KEY, at INTEGER NOT NULL, bal INTEGER NOT NULL, name TEXT, eday INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL)");
        this.sql.exec("CREATE INDEX IF NOT EXISTS econ_bal ON econ (bal)");
        this.sql.exec("CREATE TABLE IF NOT EXISTS econ_sum (id INTEGER PRIMARY KEY, data TEXT NOT NULL)");
        this.sql.exec("CREATE TABLE IF NOT EXISTS econ_day (day INTEGER PRIMARY KEY, data TEXT NOT NULL)");
        // Each account's crates (Bolts, parts, quests), so they follow the account to any device. rev goes up on every save.
        this.sql.exec("CREATE TABLE IF NOT EXISTS saves (user_id TEXT PRIMARY KEY, rev INTEGER NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL) WITHOUT ROWID");
    }

    // data null reads. A save only lands on top of the revision the page last saw; otherwise the page gets the newer copy.
    sync(userId, rev, data) {
        const row = this.sql.exec("SELECT rev, data FROM saves WHERE user_id = ?", userId).toArray()[0];
        const current = row?.rev ?? 0;
        const saved = () => {
            try {
                return row ? JSON.parse(row.data) : null;
            } catch {
                return null;
            }
        };
        if (data == null) return { rev: current, data: saved() };
        if (rev !== current) return { conflict: true, rev: current, data: saved() };
        this.sql.exec(
            "INSERT INTO saves (user_id, rev, at, data) VALUES (?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET rev = excluded.rev, at = excluded.at, data = excluded.data",
            userId, current + 1, Date.now(), data,
        );
        return { rev: current + 1 };
    }

    jsonRow(query, ...args) {
        const row = this.sql.exec(query, ...args).toArray()[0];
        if (!row) return null;
        try {
            return JSON.parse(row.data);
        } catch {
            return null;
        }
    }

    // Totals are the sum of every profile's latest figures, so each report adds only its change since the last one.
    economy(userId, figures, name) {
        const now = Date.now();
        const day = Math.floor(now / 86_400_000);
        const old = this.sql.exec("SELECT at, eday, data FROM econ WHERE user_id = ?", userId).toArray()[0];
        if (old && now - old.at < ECON_GAP_MS) return;
        let prev = {};
        try {
            if (old) prev = JSON.parse(old.data) || {};
        } catch {}
        const drift = figures.b - EARN_KEYS.reduce((n, k) => n + figures[k], 0) + SPEND_KEYS.reduce((n, k) => n + figures[k], 0);
        const next = { ...figures, u: 1, dr: Math.max(0, drift), dn: drift > 0 ? 1 : 0 };
        const sum = this.jsonRow("SELECT data FROM econ_sum WHERE id = 0") ?? {};
        const today = this.jsonRow("SELECT data FROM econ_day WHERE day = ?", day) ?? {};
        for (const k of Object.keys(next)) {
            const d = next[k] - (prev[k] ?? 0);
            if (d) sum[k] = (sum[k] ?? 0) + d;
        }
        let earned = 0;
        for (const k of DAY_KEYS) {
            const d = next[k] - (prev[k] ?? 0);
            if (d <= 0) continue;
            today[k] = (today[k] ?? 0) + d;
            if (EARN_KEYS.includes(k)) earned += d;
        }
        if (!old) today.n = (today.n ?? 0) + 1;
        if (earned > 0 && old?.eday !== day) today.p = (today.p ?? 0) + 1;
        const eday = earned > 0 ? day : old?.eday ?? 0;
        this.sql.exec(
            "INSERT INTO econ (user_id, at, bal, name, eday, data) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET at = excluded.at, bal = excluded.bal, name = excluded.name, eday = excluded.eday, data = excluded.data",
            userId, now, figures.b, name, eday, JSON.stringify(next),
        );
        this.sql.exec("INSERT INTO econ_sum (id, data) VALUES (0, ?) ON CONFLICT (id) DO UPDATE SET data = excluded.data", JSON.stringify(sum));
        this.sql.exec("INSERT INTO econ_day (day, data) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET data = excluded.data", day, JSON.stringify(today));
    }

    // Race Control's Economy tab: a fixed handful of rows (the sum, two weeks of days, ten balances, the part counts).
    economyView() {
        const day = Math.floor(Date.now() / 86_400_000);
        const days = this.sql.exec("SELECT day, data FROM econ_day WHERE day > ? ORDER BY day DESC", day - ECON_DAYS).toArray()
            .map((r) => ({ day: r.day, ...JSON.parse(r.data) }));
        const top = this.sql.exec("SELECT user_id, name, bal, at, data FROM econ ORDER BY bal DESC LIMIT 10").toArray().map((r) => {
            let d = {};
            try {
                d = JSON.parse(r.data) || {};
            } catch {}
            return { userId: r.user_id, name: r.name || null, bal: r.bal, at: r.at, earned: EARN_KEYS.reduce((n, k) => n + (d[k] ?? 0), 0), drift: d.dr ?? 0 };
        });
        const parts = this.sql.exec("SELECT i, made, gone FROM counts").toArray().map((r) => ({ i: r.i, made: r.made, gone: r.gone }));
        return { day, sum: this.jsonRow("SELECT data FROM econ_sum WHERE id = 0") ?? {}, days, top, parts };
    }

    // Returns the ids that are settled (taken, or never going to be); the rest wait for another day's allowance.
    report(userId, events, figures, name) {
        if (figures) this.economy(userId, figures, name);
        if (!events.length) return { done: [] };
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

export function cleanEcon(raw) {
    if (!raw || typeof raw !== "object") return null;
    const out = {};
    for (const k of ECON_KEYS) {
        const v = raw[k] ?? 0;
        if (!Number.isSafeInteger(v) || v < 0 || v > ECON_MAX) return null;
        out[k] = v;
    }
    return out;
}

function cleanName(raw) {
    if (typeof raw !== "string") return null;
    const name = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40);
    return name || null;
}

// The page's own numbers, like everything else about crates; this only keeps a save to a sane shape and size.
export function cleanSave(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    if (!Number.isFinite(raw.bolts) || raw.bolts < 0 || raw.bolts > ECON_MAX) return null;
    if (!Array.isArray(raw.items) || raw.items.length > MAX_SAVE_ITEMS) return null;
    for (const x of raw.items) {
        if (!x || typeof x !== "object" || !ITEM_ID.test(x.u ?? "") || typeof x.k !== "string" || !Number.isSafeInteger(x.n)) return null;
    }
    const text = JSON.stringify(raw);
    return text.length <= MAX_SAVE ? text : null;
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
    const admin = path.startsWith("admin/");
    if (!h.fromSite && !admin) return h.forbidden();
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

    if (admin) {
        if (request.method !== "POST") return h.json({ error: "Method not allowed." }, origin, 405);
        if (h.doLimited()) return h.busy(origin);
        let body = null;
        try {
            body = JSON.parse((await h.readSmallBody(request, 4096)) || "{}");
        } catch {}
        if (!(await h.isOwner(body?.token))) return h.json({ error: "Only the owner can do that." }, origin, 403);
        if (path === "admin/economy") return h.json(await stub.economyView(), origin);
        return h.json({ error: "Not found." }, origin, 404);
    }

    // text/plain JSON {token, rev, data?}: no data reads the account's save, data saves it on top of rev.
    if (path === "sync" && request.method === "POST") {
        if (h.doLimited()) return h.busy(origin);
        const text = await h.readSmallBody(request, MAX_SAVE + 1024);
        if (text == null) return h.json({ error: "Too large." }, origin, 413);
        let body = null;
        try {
            body = JSON.parse(text);
        } catch {}
        if (!h.HEX64.test(body?.token ?? "")) return h.json({ error: "Your profile couldn't be read." }, origin, 400);
        if (!Number.isSafeInteger(body.rev) || body.rev < 0) return h.json({ error: "Bad request." }, origin, 400);
        const data = body.data == null ? null : cleanSave(body.data);
        if (body.data != null && !data) return h.json({ error: "Bad request." }, origin, 400);
        return h.json(await stub.sync(await h.sha256Hex(body.token), body.rev, data), origin);
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
        const figures = cleanEcon(body.econ);
        const result = events.length || figures
            ? await stub.report(await h.sha256Hex(body.token), events, figures, figures ? cleanName(body.name) : null)
            : { done: [] };
        // Malformed entries are settled too, so a page never resends them.
        for (const u of sent) if (!valid.has(u)) result.done.push(u);
        return h.json(result, origin);
    }
    return h.json({ error: "Not found." }, origin, 404);
}
