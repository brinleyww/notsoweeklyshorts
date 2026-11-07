// A player's profile window: where they place on NSWS, official and Kodub community boards, their weekly
// standings, their car and their tags. Opened from a name on a leaderboard, in the standings or in the chat.
// NSWS boards come from the same proxied leaderboard requests the game makes, kept here (and in the browser's
// cache) for a while so opening more profiles is free; the account part (tags, hours, bingos) is one cached
// GET /nsws/profile, and official/community places are GET /nsws/profile-runs, 20 boards a call.
(function () {
    const API = window.__nswsApiBase;
    const PAGE = 500;
    const LIVE_TTL_MS = 3 * 60_000;
    const ENDED_TTL_MS = 20 * 60_000;
    const ACCOUNT_TTL_MS = 5 * 60_000;
    const ACCOUNT_FRESH_MS = 2 * 60_000;
    const RUNS_TTL_MS = 10 * 60_000;
    const RUNS_CHUNK = 20;
    const REFRESH_GAP_MS = 60_000;
    // Per-player lookups: a burst of LOOKUP_BURST goes straight out, then one every LOOKUP_REFILL_MS, kept across reloads.
    const LOOKUP_BURST = 12;
    const LOOKUP_REFILL_MS = 4000;
    const LOOKUP_KEY = "nsws_profile_lookups";
    const SCOPE_KEY = "nsws_profile_scope";
    const PARALLEL = 6;
    const TURN_PER_PX = 1.2 * Math.PI / 180;
    const IGNORED_IN_NAMES = /[\p{Cc}\p{Cf}\p{Z}\s]/gu;
    const LOG102 = Math.log10(2);
    const BUCKETS = [["World record", 1], ["Top 3", 3], ["Top 10", 10], ["Top 50", 50], ["Top 100", 100], ["Ranked", Infinity]];
    const SCOPES = [["nsws", "NSWS"], ["official", "Main"], ["kodub", "Community"], ["all", "All"]];
    const SCOPE_TEXT = {
        nsws: { tracks: "NSWS tracks", loading: "Reading every NSWS board...", ranked: "Every NSWS track they are ranked on", none: "Not ranked on any NSWS track yet." },
        official: { tracks: "Official tracks", loading: "Looking up their official tracks...", ranked: "Every official track they are ranked on", none: "Not ranked on any official track yet." },
        kodub: { tracks: "Community tracks", loading: "Looking up their community tracks...", ranked: "Every community track they are ranked on", none: "Not ranked on any community track yet." },
        all: { tracks: "Tracks", loading: "Reading every board...", ranked: "Every track they are ranked on", none: "Not ranked on any track yet." },
    };

    const qmul = (a, b) => [
        a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
        a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
        a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
        a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ];
    const qaxis = (x, y, z, angle) => [x * Math.sin(angle / 2), y * Math.sin(angle / 2), z * Math.sin(angle / 2), Math.cos(angle / 2)];
    // The leaderboard thumbnails' view: 45 degrees round, looking down from the cube's corner.
    const DEFAULT_TURN = qmul(qaxis(0, 1, 0, Math.PI / 4), qaxis(1, 0, 0, -Math.atan(Math.SQRT1_2)));

    const boards = new Map();
    const accountCache = new Map();
    const runCache = new Map();
    let view = null;

    const CSS = `
#nsws-profile{position:fixed;inset:0;z-index:10050;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.7);}
#nsws-profile *{box-sizing:border-box;}
#nsws-profile>.box{position:relative;display:flex;flex-direction:column;width:min(920px,96vw);max-height:94vh;background:var(--surface-color);color:var(--text-color);clip-path:polygon(0 0,100% 0,calc(100% - 14px) 100%,0 100%);outline:none;}
#nsws-profile .checker{height:8px;flex-shrink:0;background:repeating-conic-gradient(#fff 0 25%,#112052 0 50%) 0 0/8px 8px;opacity:.85;}
#nsws-profile .top{display:flex;align-items:center;gap:12px;padding:10px 20px;background:var(--surface-secondary-color);}
#nsws-profile .top>.flag{width:36px;height:27px;flex-shrink:0;filter:drop-shadow(2px 2px 1px rgba(0,0,0,.5));}
#nsws-profile .top>h1{margin:0;min-width:0;font-size:32px;font-weight:normal;color:#b3c1ff;text-shadow:0 2px 0 #112052;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#nsws-profile .top>h1>small{font-size:20px;color:rgba(255,255,255,.6);text-shadow:none;}
#nsws-profile .top>.nsws-tag{font-size:17px;flex-shrink:0;}
#nsws-profile .top>.sub{margin-left:auto;font-size:14px;font-style:italic;color:rgba(255,255,255,.6);text-align:right;white-space:nowrap;}
#nsws-profile .scopes{display:flex;flex-shrink:0;background:var(--surface-secondary-color);border-top:1px solid rgba(255,255,255,.1);}
#nsws-profile .scopes>button{flex:1;margin:0 -3px;padding:7px 0;border:0;background:transparent;color:rgba(255,255,255,.6);font:inherit;font-size:18px;cursor:pointer;clip-path:polygon(8px 0,100% 0,calc(100% - 8px) 100%,0 100%);}
#nsws-profile .scopes>button:first-child{margin-left:0;clip-path:polygon(0 0,100% 0,calc(100% - 8px) 100%,0 100%);}
#nsws-profile .scopes>button:last-child{margin-right:0;clip-path:polygon(8px 0,100% 0,100% 100%,0 100%);}
#nsws-profile .scopes>button:hover{color:#fff;background:rgba(255,255,255,.05);}
#nsws-profile .scopes>button.on{color:#fff;background:var(--surface-tertiary-color);box-shadow:inset 0 -3px 0 #7272c2;}
#nsws-profile .body{overflow-y:auto;padding:12px 20px 20px;}
#nsws-profile .head{display:flex;gap:16px;align-items:stretch;}
#nsws-profile .car{position:relative;flex-shrink:0;width:200px;background:var(--surface-tertiary-color);cursor:grab;touch-action:none;user-select:none;}
#nsws-profile .car.drag{cursor:grabbing;}
#nsws-profile .car>img{display:block;width:200px;height:200px;pointer-events:none;}
#nsws-profile .car>span{position:absolute;left:0;right:0;bottom:4px;font-size:12px;font-style:italic;text-align:center;color:rgba(255,255,255,.45);pointer-events:none;}
#nsws-profile .tiles{flex:1;display:grid;grid-template-columns:repeat(auto-fill,minmax(148px,1fr));gap:6px;align-content:start;min-width:0;}
#nsws-profile .tile{padding:7px 10px 8px;background:var(--surface-secondary-color);min-width:0;}
#nsws-profile .tile>b{display:block;font-weight:normal;font-size:22px;color:#b3c1ff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums;}
#nsws-profile .tile>b.gold{color:#ffd700;}
#nsws-profile .tile>span{display:block;margin-top:2px;font-size:13px;color:rgba(255,255,255,.6);}
#nsws-profile .sec{margin:18px 0 4px;padding-bottom:3px;border-bottom:1px solid rgba(255,255,255,.8);font-size:15px;font-style:italic;color:rgba(255,255,255,.65);}
#nsws-profile .tags{display:flex;flex-wrap:wrap;gap:8px;padding:8px 0 2px;font-size:15px;}
#nsws-profile .tags>.wearing{outline:2px solid #fff;outline-offset:2px;}
#nsws-profile .line{display:flex;justify-content:space-between;gap:16px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.1);font-size:18px;}
#nsws-profile .line>b{font-weight:normal;color:#b3c1ff;text-align:right;}
#nsws-profile .bars{display:grid;grid-template-columns:auto 1fr auto;gap:5px 12px;align-items:center;padding-top:8px;font-size:16px;}
#nsws-profile .bars>i{display:block;height:14px;background:rgba(255,255,255,.08);}
#nsws-profile .bars>i>i{display:block;height:100%;background:#8f8ff0;}
#nsws-profile .bars>b{font-weight:normal;text-align:right;font-variant-numeric:tabular-nums;}
#nsws-profile table{width:100%;border-collapse:collapse;font-size:17px;font-variant-numeric:tabular-nums;}
#nsws-profile th{position:sticky;top:-12px;padding:6px 8px;background:var(--surface-color);font-weight:normal;font-size:14px;font-style:italic;text-align:right;white-space:nowrap;color:rgba(255,255,255,.65);border-bottom:1px solid rgba(255,255,255,.8);}
#nsws-profile th.sort{cursor:pointer;}
#nsws-profile th.sort:hover{color:#fff;}
#nsws-profile th.on{color:#fff;box-shadow:inset 0 -3px 0 #7272c2;}
#nsws-profile td{padding:6px 8px;text-align:right;white-space:nowrap;border-bottom:1px solid rgba(255,255,255,.1);}
#nsws-profile th:first-child,#nsws-profile td:first-child{padding-left:0;text-align:left;}
#nsws-profile th:last-child,#nsws-profile td:last-child{padding-right:0;}
#nsws-profile td.name{max-width:320px;overflow:hidden;text-overflow:ellipsis;}
#nsws-profile td.name>small{margin-left:8px;font-size:13px;color:rgba(255,255,255,.5);}
#nsws-profile td.gold{color:#ffd700;}
#nsws-profile td.dim{color:rgba(255,255,255,.5);}
#nsws-profile .msg{padding:30px 10px;text-align:center;font-size:17px;line-height:1.5;color:rgba(255,255,255,.65);}
#nsws-profile .note{margin:8px 0 0;font-size:14px;line-height:1.4;color:rgba(255,255,255,.55);}
#nsws-profile .progress{height:3px;margin-top:10px;background:rgba(255,255,255,.08);}
#nsws-profile .progress>i{display:block;height:100%;background:#8f8ff0;transition:width .2s;}
#nsws-profile .bottom{display:flex;justify-content:space-between;gap:10px;padding:10px 20px;background:var(--surface-secondary-color);}
#nsws-profile .bottom>.button{margin:0;font-size:20px;padding:7px 18px;}
#nsws-profile .bottom>.button:disabled{opacity:.35;}
.nsws-profile-link{cursor:pointer;}
.nsws-profile-link:hover{text-decoration:underline;}
@media (max-width:640px){#nsws-profile .head{flex-direction:column;align-items:center;}#nsws-profile .tiles{width:100%;grid-template-columns:repeat(2,1fr);}#nsws-profile .wide{display:none;}#nsws-profile table{font-size:14px;}#nsws-profile td.name{max-width:150px;}#nsws-profile th,#nsws-profile td{padding:5px 4px;}#nsws-profile .top{flex-wrap:wrap;row-gap:6px;}#nsws-profile .top>h1{flex-shrink:0;max-width:calc(100% - 50px);font-size:24px;}#nsws-profile .top>.nsws-tag{font-size:14px;}#nsws-profile .top>.sub{display:none;}}
`;

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function button(text, onClick) {
        const b = el("button", "button", text);
        b.addEventListener("click", (e) => {
            window.__nswsUIClick?.();
            onClick(e);
        });
        return b;
    }

    const nameKey = (name) => String(name ?? "").normalize("NFKC").toLowerCase().replace(IGNORED_IN_NAMES, "");
    const num = (n) => Number(n).toLocaleString();
    const plural = (n, word, suffix = "s") => num(n) + " " + word + (n === 1 ? "" : suffix);
    const points = (rank) => (rank ? Math.round(20000 / Math.pow(rank, LOG102)) : 0);
    const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th");

    // As the game writes times: frames are milliseconds.
    function raceTime(frames) {
        const m = Math.floor(frames / 60000);
        const s = Math.floor((frames % 60000) / 1000);
        const ms = frames % 1000;
        return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0") + "." + String(ms).padStart(3, "0");
    }

    function longTime(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        return h ? h + "h " + m + "m" : m + "m " + Math.floor(seconds % 60) + "s";
    }

    function percent(rank, total) {
        const p = (rank / total) * 100;
        return "top " + (p < 0.01 ? String(+p.toPrecision(1)) : p < 1 ? p.toFixed(2) : p < 10 ? p.toFixed(1) : Math.round(p)) + "%";
    }

    function median(values) {
        const s = [...values].sort((a, b) => a - b);
        return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
    }

    function allTracks() {
        const seen = new Set();
        const out = [];
        for (const w of window.__nswsWeeks || []) {
            const parts = w.parts || [{ label: w.label, tracks: w.tracks || [] }];
            for (const p of parts) {
                for (const t of p.tracks || []) {
                    if (seen.has(t.id)) continue;
                    seen.add(t.id);
                    out.push({ id: t.id, name: t.name, week: w.week, event: !!w.event, group: p.label || w.label || "Week " + w.week, order: out.length });
                }
            }
        }
        return out;
    }

    const isLive = (track) => !!window.__nswsIsCurrentWeek?.(track.id);

    // Refresh reads only the week in progress again: ended boards barely change.
    async function loadBoard(track, fresh) {
        const hit = boards.get(track.id);
        const live = isLive(track);
        if (!(fresh && live) && hit && Date.now() - hit.at < (live ? LIVE_TTL_MS : ENDED_TTL_MS)) return hit.data;
        const url = API + "v6/leaderboard?version=0.6.2&trackId=" + track.id + "&skip=0&amount=" + PAGE + "&onlyVerified=false&nswsProfile=1" + window.__nswsTrackQuery(track.id);
        const r = await fetch(url, fresh && live ? { cache: "reload" } : {});
        if (!r.ok) throw new Error("HTTP " + r.status);
        const raw = await r.json();
        const data = { total: raw.total ?? 0, entries: Array.isArray(raw) ? raw : raw.entries || [] };
        boards.set(track.id, { at: Date.now(), data });
        return data;
    }

    async function loadBoards(tracks, fresh, onProgress) {
        const out = new Map();
        let next = 0;
        let done = 0;
        const worker = async () => {
            while (next < tracks.length) {
                const t = tracks[next++];
                try {
                    out.set(t.id, await loadBoard(t, fresh));
                } catch {
                    out.set(t.id, null);
                }
                onProgress(++done, tracks.length);
            }
        };
        await Promise.all(Array.from({ length: PARALLEL }, worker));
        return out;
    }

    function readBucket() {
        try {
            const saved = JSON.parse(localStorage.getItem(LOOKUP_KEY));
            if (Number.isFinite(saved?.tokens) && Number.isFinite(saved?.at)) return saved;
        } catch {}
        return { tokens: LOOKUP_BURST, at: Date.now() };
    }

    // Waits for a lookup slot; false if the window closed meanwhile.
    async function slot(v) {
        for (;;) {
            if (v.closed) return false;
            const bucket = readBucket();
            const now = Date.now();
            const tokens = Math.min(LOOKUP_BURST, bucket.tokens + Math.max(0, now - bucket.at) / LOOKUP_REFILL_MS);
            if (tokens >= 1) {
                try {
                    localStorage.setItem(LOOKUP_KEY, JSON.stringify({ tokens: tokens - 1, at: now }));
                } catch {}
                if (v.waiting) {
                    v.waiting = false;
                    render(v);
                }
                return true;
            }
            if (!v.waiting) {
                v.waiting = true;
                render(v);
            }
            await new Promise((resolve) => setTimeout(resolve, (1 - tokens) * LOOKUP_REFILL_MS + 50));
        }
    }

    async function lookUp(v, path, cache, key, ttl) {
        const hit = cache.get(key);
        if (hit && Date.now() - hit.at < ttl) return hit.data;
        if (!(await slot(v))) return { error: true };
        try {
            const r = await fetch(API + path);
            if (!r.ok) return { error: true, slow: r.status === 429 };
            const data = await r.json();
            if (!data.error && !data.failed?.length) cache.set(key, { at: Date.now(), data });
            return data;
        } catch {
            return { error: true };
        }
    }

    function loadAccount(v, fresh) {
        const key = nameKey(v.nick);
        if (fresh && Date.now() - (accountCache.get(key)?.at ?? 0) > ACCOUNT_FRESH_MS) accountCache.delete(key);
        return lookUp(v, "nsws/profile?nick=" + encodeURIComponent(v.nick), accountCache, key, ACCOUNT_TTL_MS);
    }

    // Official or Kodub community places: Kodub's own positions, looked up by the Worker for the account that holds the name.
    async function loadSet(v, set) {
        const list = (window.__nswsTrackSets?.()[set] || []).map((t, i) => ({
            id: t.id, name: t.name, set, order: (set === "official" ? 10000 : 20000) + i,
            group: set === "official" ? "Official" : "Community" + (t.group ? " " + t.group : ""),
        }));
        const ids = list.map((t) => t.id).sort();
        const chunks = [];
        for (let i = 0; i < ids.length; i += RUNS_CHUNK) chunks.push(ids.slice(i, i + RUNS_CHUNK));
        const runs = new Map();
        let failed = 0;
        let found = true;
        let slow = false;
        await Promise.all(chunks.map(async (chunk) => {
            const path = "nsws/profile-runs?nick=" + encodeURIComponent(v.nick) + "&tracks=" + chunk.join(",");
            const data = await lookUp(v, path, runCache, nameKey(v.nick) + "|" + chunk.join(","), RUNS_TTL_MS);
            if (data.error) {
                failed += chunk.length;
                slow ||= !!data.slow;
                return;
            }
            if (!data.found) found = false;
            failed += data.failed?.length ?? 0;
            for (const id of chunk) if (data.runs?.[id]) runs.set(id, data.runs[id]);
        }));
        if (v.closed) return;
        const rows = list.filter((t) => runs.has(t.id)).map((t) => ({ track: t, ...runs.get(t.id), secret: false }));
        v.sets[set] = { rows, tracks: list, failed: found ? failed : 0, found, slow };
        render(v);
    }

    function ensureSets(v) {
        for (const set of ["official", "kodub"]) {
            if ((v.scope === set || v.scope === "all") && !v.sets[set] && !v.pending.has(set)) {
                v.pending.add(set);
                loadSet(v, set).finally(() => v.pending.delete(set));
            }
        }
    }

    // What the chosen tab shows; null while part of it is still loading.
    function scopeData(v) {
        const parts = [];
        if (v.scope === "nsws" || v.scope === "all") parts.push(v.result && { rows: v.result.rows, tracks: v.result.tracks, failed: v.result.failed, found: true });
        for (const set of ["official", "kodub"]) if (v.scope === set || v.scope === "all") parts.push(v.sets[set]);
        if (parts.some((p) => !p)) return null;
        return {
            rows: parts.flatMap((p) => p.rows),
            tracks: parts.flatMap((p) => p.tracks),
            failed: parts.reduce((n, p) => n + p.failed, 0),
            unfound: parts.some((p) => !p.found),
            slow: parts.some((p) => p.slow),
            weeks: v.scope === "nsws" || v.scope === "all" ? v.result.weeks : null,
        };
    }

    // A board past its first page (rare on NSWS boards): ask for this account's own place on it.
    async function deepEntry(track, userId) {
        try {
            const r = await fetch(API + "v6/leaderboardUserEntry?version=0.6.2&trackId=" + track.id + "&userTokenHash=" + userId + "&onlyVerified=false" + window.__nswsTrackQuery(track.id));
            const data = r.ok ? await r.json() : null;
            const frames = data?.frames ?? data?.entry?.frames;
            return Number.isSafeInteger(data?.position) ? { position: data.position, frames: Number.isSafeInteger(frames) ? frames : null } : null;
        } catch {
            return null;
        }
    }

    // Names are unique to one account on NSWS, but a player may have raced old weeks under another name:
    // ended weeks' boards carry userIds, so runs under the same account count whatever name they show.
    async function collect(nick, tracks, data) {
        const key = nameKey(nick);
        const ids = new Map();
        for (const t of tracks) {
            for (const e of data.get(t.id)?.entries || []) {
                if (!e.hidden && e.userId && nameKey(e.nickname) === key) ids.set(e.userId, Math.max(ids.get(e.userId) ?? 0, e.id));
            }
        }
        const owner = [...ids].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
        const rows = [];
        const names = new Set();
        let latest = null;
        for (const t of tracks) {
            const board = data.get(t.id);
            if (!board) continue;
            const index = board.entries.findIndex((e) => (owner && e.userId === owner) || (!e.userId && nameKey(e.nickname) === key) || (!owner && nameKey(e.nickname) === key));
            let row = null;
            if (index >= 0) {
                const e = board.entries[index];
                names.add((e.nickname || "").trim());
                row = { track: t, position: index + 1, total: board.total || board.entries.length, frames: e.hidden ? null : e.frames, secret: !!e.hidden };
                const rank = isLive(t) ? Infinity : e.id;
                if (!latest || rank > latest.rank) latest = { rank, carStyle: e.carStyle, countryCode: e.countryCode };
            } else if (owner && board.total > board.entries.length && !isLive(t)) {
                const deep = await deepEntry(t, owner);
                if (deep) row = { track: t, position: deep.position, total: board.total, frames: deep.frames, secret: false };
            }
            if (row) rows.push(row);
        }
        return { rows, names, latest };
    }

    async function standings(nick, names, tracks, data) {
        const keys = new Set([nameKey(nick), ...[...names].map(nameKey)]);
        const weeks = [...new Set(tracks.filter((t) => !t.event).map((t) => t.week))].sort((a, b) => b - a);
        const out = [];
        await Promise.all(weeks.map(async (week) => {
            let result = null;
            if (week === window.__nswsMaxWeek) {
                const maps = tracks.filter((t) => t.week === week).map((t) => {
                    const m = {};
                    (data.get(t.id)?.entries || []).forEach((e, i) => {
                        const nm = (e.nickname || "").trim();
                        if (nm && !(nm in m)) m[nm] = i + 1;
                    });
                    return m;
                });
                const all = new Set(maps.flatMap((m) => Object.keys(m)));
                const sorted = [...all].map((nm) => [nm, maps.reduce((sum, m) => sum + points(m[nm]), 0)]).sort((a, b) => b[1] - a[1]);
                result = { sorted, live: true };
            } else {
                result = await window.__nswsStandingsData?.(week).catch(() => null);
            }
            if (!result) return;
            const index = result.sorted.findIndex(([nm]) => keys.has(nameKey(nm)));
            if (index < 0) return;
            const label = (window.__nswsWeeks || []).find((w) => w.week === week)?.label || "Week " + week;
            out.push({ week, label, rank: index + 1, of: result.sorted.length, points: result.sorted[index][1], live: !!result.live });
        }));
        return out.sort((a, b) => b.week - a.week);
    }

    function selfNick() {
        try {
            const slot = parseInt(localStorage.getItem("polytrack_v5_prod_user_slot") ?? "0", 10);
            return JSON.parse(localStorage.getItem("polytrack_v5_prod_user_" + (slot >= 0 ? slot : 0)))?.nickname ?? "";
        } catch {
            return "";
        }
    }

    function close() {
        if (!view) return;
        view.closed = true;
        clearTimeout(view.tick);
        view.overlay.remove();
        view = null;
    }

    function open(nick, hint = {}) {
        nick = String(nick ?? "").trim();
        if (!nick) return;
        close();
        const overlay = el("div");
        overlay.id = "nsws-profile";
        const box = el("div", "box");
        box.tabIndex = -1;
        const top = el("div", "top");
        const scopes = el("div", "scopes");
        const body = el("div", "body");
        const bottom = el("div", "bottom");
        box.append(el("div", "checker"), top, scopes, body, bottom);
        overlay.appendChild(box);
        overlay.addEventListener("pointerdown", (e) => {
            if (e.target === overlay) close();
        });
        for (const type of ["keydown", "keyup", "keypress"]) overlay.addEventListener(type, (e) => e.stopPropagation());
        document.body.appendChild(overlay);
        box.focus();
        let scope = "nsws";
        try {
            scope = SCOPES.some(([id]) => id === localStorage.getItem(SCOPE_KEY)) ? localStorage.getItem(SCOPE_KEY) : "nsws";
        } catch {}
        view = { nick, hint, overlay, top, scopes, body, bottom, scope, sets: {}, pending: new Set(), sort: "week", turn: DEFAULT_TURN, carStyle: hint.carStyle ?? null, countryCode: hint.countryCode ?? null };
        load(view, false);
    }

    function scopeBar(v) {
        v.scopes.innerHTML = "";
        for (const [id, label] of SCOPES) {
            const b = el("button", v.scope === id ? "on" : null, label);
            b.addEventListener("click", () => {
                if (v.scope === id) return;
                window.__nswsUIClick?.();
                v.scope = id;
                v.sort = "week";
                try {
                    localStorage.setItem(SCOPE_KEY, id);
                } catch {}
                ensureSets(v);
                render(v);
            });
            v.scopes.appendChild(b);
        }
    }

    async function load(v, fresh) {
        v.result = null;
        v.account = undefined;
        v.pct = null;
        v.loadedAt = null;
        ensureSets(v);
        render(v);
        const tracks = allTracks();
        const accountReq = loadAccount(v, fresh).then((a) => {
            v.account = a;
            if (!v.closed) render(v);
        });
        const data = await loadBoards(tracks, fresh, (done, total) => {
            v.pct = Math.round((done / total) * 100) + "%";
            if (v.progress) v.progress.style.width = v.pct;
        });
        if (v.closed) return;
        const found = await collect(v.nick, tracks, data);
        if (found.latest?.carStyle) v.carStyle = found.latest.carStyle;
        if (found.latest?.countryCode) v.countryCode = found.latest.countryCode;
        const weeks = await standings(v.nick, found.names, tracks, data);
        await accountReq;
        if (v.closed) return;
        v.result = { ...found, weeks, tracks, failed: [...data.values()].filter((d) => !d).length };
        v.loadedAt = Date.now();
        render(v);
    }

    function header(v) {
        v.top.innerHTML = "";
        const country = v.countryCode ? (window.__nswsCountries?.() || []).find((c) => c.code === v.countryCode) : null;
        if (v.countryCode) {
            const flag = el("img", "flag");
            flag.src = "images/countries/" + v.countryCode + ".svg";
            flag.draggable = false;
            flag.title = country?.name ?? v.countryCode;
            v.top.appendChild(flag);
        }
        const h1 = el("h1", null, v.nick);
        if (nameKey(v.nick) === nameKey(selfNick())) h1.appendChild(el("small", null, " (You)"));
        v.top.appendChild(h1);
        const a = v.account;
        const chip = a?.found && a.tag ? window.__nswsTags?.chip(a.tag) : null;
        if (chip) v.top.appendChild(chip);
        const sub = [];
        if (a?.found && a.nickname && nameKey(a.nickname) !== nameKey(v.nick)) sub.push("Now called " + a.nickname);
        const others = [...(v.result?.names ?? [])].filter((nm) => nameKey(nm) !== nameKey(v.nick));
        if (others.length) sub.push("Also raced as " + others.slice(0, 3).join(", "));
        if (a?.found && a.joined) sub.push("On NSWS since " + new Date(a.joined).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" }));
        if (sub.length) v.top.appendChild(el("div", "sub", sub.join(" \u00b7 ")));
    }

    function car(v) {
        const wrap = el("div", "car");
        const img = el("img");
        img.src = "images/car_thumbnail_placeholder.png";
        img.alt = "";
        wrap.title = "Double-click to put it back";
        wrap.append(img, el("span", null, "Drag to turn"));
        let rendering = false;
        let shown = null;
        const draw = () => {
            if (rendering || !window.__nswsCarThumb || v.closed) return;
            const want = v.turn;
            const style = v.carStyle;
            const key = want.join(",") + "|" + style;
            if (shown === key) return;
            rendering = true;
            window.__nswsCarThumb(style, want).then((src) => {
                if (src) img.src = src;
                shown = key;
            }).catch(() => {}).finally(() => {
                rendering = false;
                draw();
            });
        };
        // Turns about the view's own axes, so the car rolls over the top as far as it is dragged.
        let drag = null;
        wrap.addEventListener("pointerdown", (e) => {
            drag = { x: e.clientX, y: e.clientY };
            wrap.classList.add("drag");
            try {
                wrap.setPointerCapture(e.pointerId);
            } catch {}
        });
        wrap.addEventListener("pointermove", (e) => {
            if (!drag) return;
            const dx = e.clientX - drag.x;
            const dy = e.clientY - drag.y;
            drag = { x: e.clientX, y: e.clientY };
            const q = qmul(v.turn, qmul(qaxis(0, 1, 0, -dx * TURN_PER_PX), qaxis(1, 0, 0, -dy * TURN_PER_PX)));
            const len = Math.hypot(...q);
            v.turn = q.map((c) => c / len);
            draw();
        });
        wrap.addEventListener("dblclick", () => {
            v.turn = DEFAULT_TURN;
            draw();
        });
        const stop = () => {
            drag = null;
            wrap.classList.remove("drag");
        };
        wrap.addEventListener("pointerup", stop);
        wrap.addEventListener("pointercancel", stop);
        wrap.addEventListener("nsws-draw", draw);
        draw();
        return wrap;
    }

    function tile(value, label, gold) {
        const t = el("div", "tile");
        t.append(el("b", gold ? "gold" : null, value), el("span", null, label));
        return t;
    }

    function tiles(v, d) {
        const wrap = el("div", "tiles");
        if (!d) {
            const msg = el("div", "msg", SCOPE_TEXT[v.scope].loading);
            if (!v.result) {
                const bar = el("div", "progress");
                v.progress = el("i");
                v.progress.style.width = v.pct ?? "0%";
                bar.appendChild(v.progress);
                msg.appendChild(bar);
            }
            wrap.appendChild(msg);
            return wrap;
        }
        const rows = d.rows;
        const positions = rows.map((x) => x.position);
        const shares = rows.map((x) => x.position / x.total);
        const best = rows.length ? rows.reduce((a, b) => (b.position / b.total < a.position / a.total ? b : a)) : null;
        const wins = d.weeks?.filter((w) => w.rank === 1 && !w.live).length ?? 0;
        const timed = rows.filter((x) => x.frames != null);
        const wrs = positions.filter((p) => p === 1).length;
        wrap.append(
            tile(num(rows.length), "Tracks ranked"),
            tile(num(wrs), "World records", wrs > 0),
            tile(num(positions.filter((p) => p <= 3).length), "Podiums"),
            tile(num(positions.filter((p) => p <= 10).length), "Top 10"),
            tile(positions.length ? "#" + Math.min(...positions) : "-", "Best placing"),
            tile(positions.length ? "#" + median(positions) : "-", "Typical placing"),
            tile(best ? percent(best.position, best.total) : "-", "Best standing"),
            tile(shares.length ? "top " + Math.max(1, Math.round(median(shares) * 100)) + "%" : "-", "Typical standing"),
            tile(rows.length + " / " + d.tracks.length, SCOPE_TEXT[v.scope].tracks),
        );
        if (d.weeks) wrap.appendChild(tile(num(wins), wins === 1 ? "Week won" : "Weeks won", wins > 0));
        wrap.appendChild(tile(timed.length ? raceTime(timed.reduce((s, x) => s + x.frames, 0)) : "-", timed.length < rows.length ? "Times add up to (" + (rows.length - timed.length) + " secret)" : "Their times add up to"));
        return wrap;
    }

    function tagSection(v, body) {
        const a = v.account;
        if (a === undefined) return;
        body.appendChild(el("div", "sec", "Tags"));
        if (!a || a.error) {
            body.appendChild(el("p", "note", a?.slow ? "Lots of profiles were looked up in a row. Wait a minute, then try Refresh." : "Tags and account stats can't be read right now."));
            return;
        }
        if (!a.found) {
            body.appendChild(el("p", "note", "No NSWS account goes by this name, so there are no tags or account stats to show."));
            return;
        }
        const wrap = el("div", "tags");
        const worn = String(a.tag ?? "").split(":")[0];
        for (const id of a.owned || []) {
            const chip = window.__nswsTags?.chip(id === "king" ? "king:" + a.wrs : id);
            if (!chip) continue;
            if (id === worn) {
                chip.classList.add("wearing");
                chip.title = (chip.title ? chip.title + " \u00b7 " : "") + "wearing it";
            }
            wrap.appendChild(chip);
        }
        if (!wrap.childNodes.length) wrap.appendChild(el("span", "note", "No tags yet."));
        body.appendChild(wrap);
        body.appendChild(el("div", "sec", "On NSWS"));
        const line = (label, value) => {
            const l = el("div", "line");
            l.append(el("span", null, label), el("b", null, value));
            body.appendChild(l);
        };
        line("Hours played", num(a.hours) + " h");
        if (a.king) line("NSWS King", "holds the most WRs (" + num(a.wrs) + ")");
        line("Bingos", num(a.bingos) + (a.blackouts ? " \u00b7 " + plural(a.blackouts, "blackout") : ""));
        line("Players referred", num(a.referrals));
        if (a.grind) {
            line("Time driven", longTime(a.grind.seconds));
            line("Attempts", num(a.grind.attempts));
            line("Finishes", num(a.grind.finishes));
        }
    }

    function placeSection(d, body) {
        const rows = d.rows;
        if (!rows.length) return;
        body.appendChild(el("div", "sec", "Where they place"));
        const bars = el("div", "bars");
        for (const [label, limit] of BUCKETS) {
            const n = rows.filter((x) => x.position <= limit).length;
            const fill = el("i");
            fill.style.width = (n / rows.length) * 100 + "%";
            const track = el("i");
            track.appendChild(fill);
            bars.append(el("span", null, label), track, el("b", null, num(n)));
        }
        body.appendChild(bars);
    }

    function weekSection(d, body) {
        const weeks = d.weeks;
        if (!weeks?.length) return;
        body.appendChild(el("div", "sec", "Weekly standings"));
        const table = el("table");
        const head = el("tr");
        for (const [text, cls] of [["Week"], ["Place"], ["Players", "wide"], ["Points"]]) head.appendChild(el("th", cls, text));
        table.appendChild(head);
        for (const w of weeks) {
            const tr = el("tr");
            const name = el("td", "name", w.label);
            if (w.live) name.appendChild(el("small", null, "in progress"));
            tr.append(name, el("td", w.rank === 1 && !w.live ? "gold" : null, ordinal(w.rank)), el("td", "wide dim", num(w.of)), el("td", null, num(w.points)));
            table.appendChild(tr);
        }
        body.appendChild(table);
    }

    function trackSection(v, d, body) {
        const rows = [...d.rows];
        const text = SCOPE_TEXT[v.scope];
        body.appendChild(el("div", "sec", rows.length ? text.ranked : text.tracks));
        const unfound = "No NSWS account goes by this name, so their places on official and community boards can't be looked up.";
        const slow = "Lots of profiles were looked up in a row. Wait a minute, then try Refresh.";
        if (!rows.length) {
            body.appendChild(el("div", "msg", d.unfound ? unfound : d.slow ? slow : d.failed ? "Some boards didn't load. Try Refresh." : text.none));
            return;
        }
        const order = { week: (a, b) => (b.track.week ?? 0) - (a.track.week ?? 0) || a.track.order - b.track.order, place: (a, b) => a.position - b.position || a.position / a.total - b.position / b.total, standing: (a, b) => a.position / a.total - b.position / b.total };
        rows.sort(order[v.sort]);
        const table = el("table");
        const head = el("tr");
        for (const [text, key, cls] of [["Track", "week"], ["Placing", "place"], ["Time"], ["Standing", "standing", "wide"]]) {
            const th = el("th", [key ? "sort" : "", v.sort === key ? "on" : "", cls ?? ""].join(" ").trim() || null, text);
            if (key) th.addEventListener("click", () => {
                v.sort = key;
                render(v);
            });
            head.appendChild(th);
        }
        table.appendChild(head);
        for (const x of rows) {
            const tr = el("tr");
            const name = el("td", "name", x.track.name);
            name.appendChild(el("small", null, x.track.group));
            const time = x.secret ? "SECRET" : x.frames != null ? raceTime(x.frames) : "-";
            tr.append(
                name,
                el("td", x.position === 1 ? "gold" : null, "#" + num(x.position)),
                el("td", x.secret ? "dim" : null, time),
                el("td", "wide dim", num(x.position) + " of " + num(x.total) + " \u00b7 " + percent(x.position, x.total)),
            );
            table.appendChild(tr);
        }
        body.appendChild(table);
        if (d.unfound) body.appendChild(el("p", "note", unfound));
        else if (d.slow) body.appendChild(el("p", "note", slow));
        else if (d.failed) body.appendChild(el("p", "note", plural(d.failed, "board") + " didn't load, so this list may be missing tracks."));
        if (rows.some((x) => x.secret)) body.appendChild(el("p", "note", "Times on the week in progress stay secret until it ends."));
    }

    // Refresh waits REFRESH_GAP_MS after the last load, counting down on the button.
    function bottomBar(v) {
        if (v.closed) return;
        clearTimeout(v.tick);
        v.bottom.innerHTML = "";
        const left = v.loadedAt ? Math.ceil((v.loadedAt + REFRESH_GAP_MS - Date.now()) / 1000) : 0;
        const refresh = button(left > 0 ? "Refresh (" + left + ")" : "Refresh", () => load(v, true));
        refresh.disabled = !v.result || left > 0;
        v.bottom.append(button("Back", close), refresh);
        if (left > 0) v.tick = setTimeout(() => bottomBar(v), 1000);
    }

    function render(v) {
        if (v.closed) return;
        header(v);
        scopeBar(v);
        const d = scopeData(v);
        const keepScroll = v.body.scrollTop;
        v.body.innerHTML = "";
        const head = el("div", "head");
        v.carNode ??= car(v);
        head.append(v.carNode, tiles(v, d));
        v.body.appendChild(head);
        if (v.waiting) v.body.appendChild(el("p", "note", "Lots of profiles were opened in a row, so this one waits a few seconds."));
        tagSection(v, v.body);
        if (d) {
            placeSection(d, v.body);
            weekSection(d, v.body);
            trackSection(v, d, v.body);
        }
        v.body.scrollTop = keepScroll;
        v.carNode.dispatchEvent(new Event("nsws-draw"));
        bottomBar(v);
    }

    if (!document.getElementById("nsws-profile-style")) {
        const style = el("style");
        style.id = "nsws-profile-style";
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    // Registered before the game's own windows (this file loads first), so Escape closes the profile and
    // not the standings under it.
    window.addEventListener("keydown", (e) => {
        if (!view || (e.key !== "Escape" && e.code !== "Escape")) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
    }, true);

    window.__nswsProfile = { open, close };
})();
