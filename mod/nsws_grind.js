// Grinding stats, after the Openplanet plugin for Trackmania: time, attempts, finishes, resets and
// respawns per track, for this sitting and in total, in a panel during the race and in a Stats window.
//
// Time is the car's own clock, so pauses, menus and a frozen tab add nothing, and it stops counting
// after IDLE_FRAMES without steering or throttle. An attempt starts when the car does, so restarting on
// the start line counts for nothing. Only solo runs count.
//
// Totals live on the account as one row (Accounts.syncGrind). Counts wait in localStorage until they
// are sent, as a batch with an id the Worker remembers, so sending one twice counts it once. Several
// tabs can run at once, so storage is read again before every write.
(function () {
    const API = window.__nswsApiBase;
    const KEY = "_nswsGrind:";
    const SESSION_KEY = "_nswsGrindSession";
    const TOKEN = /^[0-9a-f]{64}$/;
    const IDLE_FRAMES = 30000;
    const SESSION_GAP_MS = 30 * 60000;
    const TICK_MS = 500;
    const SAVE_MS = 5000;
    const SYNC_MS = 5 * 60000;
    const SYNC_MAX_MS = 30 * 60000;
    const SYNC_PER_ONLINE_MS = 7500;
    const SYNC_RETRY_MS = 10 * 60000;
    const BAD_BATCH_TRIES = 3;
    const CHART_DAYS = 14;
    const SUMS = ["t", "a", "f", "r", "s", "fs", "p"];
    const COLUMNS = [
        { id: "name", text: "Track" },
        { id: "t", text: "Time", value: (e) => e.t, show: (e) => longTime(e.t) },
        { id: "a", text: "Attempts", value: (e) => e.a },
        { id: "f", text: "Finishes", value: (e) => e.f },
        { id: "r", text: "Resets", value: (e) => e.r, wide: true },
        { id: "s", text: "Respawns", value: (e) => e.s, wide: true },
        { id: "b", text: "PB", value: (e) => e.b ?? Infinity, show: (e) => (e.b ? runTime(e.b) : "-"), low: true },
    ];

    const CSS = `
#nsws-grind-hud{position:fixed;left:14px;top:19vh;z-index:5;display:none;grid-template-columns:auto auto auto;column-gap:16px;padding:8px 24px 8px 14px;background:rgba(33,43,88,.82);color:#fff;font-family:ForcedSquare,Arial,sans-serif;font-size:18px;font-style:italic;line-height:1.35;pointer-events:none;clip-path:polygon(0 0,100% 0,calc(100% - 10px) 100%,0 100%);font-variant-numeric:tabular-nums;}
#nsws-grind-hud.show{display:grid;}
#nsws-grind-hud>span{text-align:right;white-space:nowrap;}
#nsws-grind-hud>.k{text-align:left;color:#b3c1ff;}
#nsws-grind-hud>.h{font-size:14px;color:rgba(255,255,255,.7);}
#nsws-grind-hud>.since{grid-column:1/-1;margin-top:3px;padding-top:3px;border-top:1px solid rgba(255,255,255,.3);font-size:15px;color:rgba(255,255,255,.85);text-align:left;}
@media (max-width:700px),(max-height:480px){#nsws-grind-hud{font-size:12px;column-gap:8px;padding:5px 16px 5px 8px;}#nsws-grind-hud>.h{font-size:11px;}#nsws-grind-hud>.since{font-size:11px;}}
#nsws-grind{position:fixed;inset:0;z-index:9998;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.7);}
#nsws-grind *{box-sizing:border-box;}
#nsws-grind>.box{position:relative;display:flex;flex-direction:column;width:min(900px,96vw);max-height:94vh;background:var(--surface-color);color:var(--text-color);clip-path:polygon(0 0,100% 0,calc(100% - 14px) 100%,0 100%);outline:none;}
#nsws-grind .checker{height:8px;flex-shrink:0;background:repeating-conic-gradient(#fff 0 25%,#112052 0 50%) 0 0/8px 8px;opacity:.85;}
#nsws-grind .top{display:flex;align-items:center;gap:10px;padding:10px 20px;background:var(--surface-secondary-color);}
#nsws-grind .top>h1{margin:0 auto 0 0;min-width:0;font-size:32px;font-weight:normal;color:#b3c1ff;text-shadow:0 2px 0 #112052;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#nsws-grind .top>h1>small{font-size:20px;color:rgba(255,255,255,.6);text-shadow:none;}
#nsws-grind .top>.button{margin:0;font-size:20px;padding:6px 14px;}
#nsws-grind .top>.button:disabled{opacity:.35;}
#nsws-grind .body{overflow-y:auto;padding:6px 20px 20px;}
#nsws-grind .sec{margin:16px 0 4px;padding-bottom:3px;border-bottom:1px solid rgba(255,255,255,.8);font-size:15px;font-style:italic;color:rgba(255,255,255,.65);}
#nsws-grind .line{display:flex;justify-content:space-between;gap:16px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.1);font-size:18px;}
#nsws-grind .line>b{font-weight:normal;color:#b3c1ff;text-align:right;}
#nsws-grind .caption{min-height:20px;margin:8px 0 4px;font-size:15px;color:rgba(255,255,255,.75);}
#nsws-grind .days{display:flex;align-items:stretch;gap:2px;height:96px;border-bottom:1px solid rgba(255,255,255,.35);}
#nsws-grind .day{flex:1 1 0;display:flex;align-items:flex-end;min-width:0;cursor:default;}
#nsws-grind .day>i{display:block;width:100%;max-width:30px;margin:0 auto;min-height:0;background:#8f8ff0;border-radius:4px 4px 0 0;}
#nsws-grind .day:hover>i{background:#b3c1ff;}
#nsws-grind .axis{display:flex;justify-content:space-between;margin-top:3px;font-size:13px;color:rgba(255,255,255,.55);}
#nsws-grind table{width:100%;border-collapse:collapse;font-size:17px;font-variant-numeric:tabular-nums;}
#nsws-grind th{position:sticky;top:-6px;padding:6px 8px;background:var(--surface-color);font-weight:normal;font-size:14px;font-style:italic;text-align:right;white-space:nowrap;color:rgba(255,255,255,.65);border-bottom:1px solid rgba(255,255,255,.8);}
#nsws-grind th.sort{cursor:pointer;}
#nsws-grind th.sort:hover{color:#fff;}
#nsws-grind th.on{color:#fff;box-shadow:inset 0 -3px 0 #7272c2;}
#nsws-grind td{padding:6px 8px;text-align:right;white-space:nowrap;border-bottom:1px solid rgba(255,255,255,.1);}
#nsws-grind th:first-child,#nsws-grind td:first-child{padding-left:0;text-align:left;}
#nsws-grind th:last-child,#nsws-grind td:last-child{padding-right:0;}
#nsws-grind td.name{max-width:280px;overflow:hidden;text-overflow:ellipsis;}
#nsws-grind tr.go{cursor:pointer;}
#nsws-grind tr.go:hover>td{background:var(--button-hover-color);}
#nsws-grind .chart{display:block;width:100%;height:150px;overflow:visible;touch-action:pan-y;}
#nsws-grind .chart>path{fill:none;stroke:#8f8ff0;stroke-width:2;vector-effect:non-scaling-stroke;}
#nsws-grind .chart>.grid{stroke:rgba(255,255,255,.14);stroke-width:1;vector-effect:non-scaling-stroke;}
#nsws-grind .dots{position:relative;height:0;}
#nsws-grind .dot{position:absolute;width:12px;height:12px;margin:-156px 0 0 -6px;border-radius:50%;background:#8f8ff0;border:2px solid var(--surface-color);pointer-events:none;}
#nsws-grind .dot.on{background:#fff;}
#nsws-grind .note{margin:12px 0 0;font-size:14px;line-height:1.4;color:rgba(255,255,255,.6);}
#nsws-grind .note.good{color:#96ff96;}
#nsws-grind .row{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;}
#nsws-grind .row>.button{margin:0;font-size:20px;padding:7px 16px;}
#nsws-grind .msg{padding:40px 10px;text-align:center;font-size:17px;line-height:1.5;color:rgba(255,255,255,.65);}
@media (max-width:640px){#nsws-grind .wide{display:none;}#nsws-grind table{font-size:14px;}#nsws-grind td.name{max-width:120px;}#nsws-grind th,#nsws-grind td{padding:5px 4px;}#nsws-grind .top>h1{font-size:24px;}}
`;

    const cache = new Map();
    const loaded = new Set();
    let mem = { t: {}, d: {} };
    let run = null;
    let session = null;
    let hud = null;
    let view = null;
    let lastPb = null;
    let lastSave = 0;
    let lastSync = 0;
    let notBefore = 0;
    let syncing = false;

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

    function token() {
        const t = window.__nswsProfileToken?.();
        return TOKEN.test(t || "") ? t : null;
    }

    function prefix(t = token()) {
        return KEY + (t ? t.slice(0, 16) : "guest") + ":";
    }

    function read(key) {
        if (cache.has(key)) return cache.get(key);
        let value = null;
        try {
            value = JSON.parse(localStorage.getItem(key));
        } catch {}
        cache.set(key, value);
        return value;
    }

    function write(key, value) {
        cache.set(key, value);
        try {
            if (value == null) localStorage.removeItem(key);
            else localStorage.setItem(key, JSON.stringify(value));
        } catch {}
    }

    function randomId() {
        return Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
    }

    function dayKey(date = new Date()) {
        return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
    }

    function round(value) {
        return Math.round(value * 10) / 10;
    }

    function mergeEntry(into, e) {
        for (const key of SUMS) if (e[key]) into[key] = round((into[key] ?? 0) + e[key]);
        if (e.b != null) into.b = Math.min(into.b ?? Infinity, e.b);
        if (e.l != null) into.l = Math.max(into.l ?? 0, e.l);
        if (e.o) into.o = true;
        if (e.n) into.n = e.n;
        if (e.h?.length) into.h = [...(into.h ?? []), ...e.h];
        return into;
    }

    function mergeAdd(into, add) {
        for (const [id, e] of Object.entries(add?.t ?? {})) mergeEntry(into.t[id] ?? (into.t[id] = {}), e);
        for (const [day, seconds] of Object.entries(add?.d ?? {})) into.d[day] = round((into.d[day] ?? 0) + seconds);
        return into;
    }

    // Everything known so far: the account's totals plus what hasn't reached them yet.
    function layers() {
        const p = prefix();
        return [read(p + "b"), read(p + "o")?.add, read(p + "p"), mem];
    }

    function allStats() {
        const stats = { since: read(prefix() + "b")?.since ?? null, t: {}, d: {} };
        for (const layer of layers()) mergeAdd(stats, layer);
        return stats;
    }

    function totals(track) {
        const entry = {};
        for (const layer of layers()) {
            const e = layer?.t?.[track];
            if (e) mergeEntry(entry, e);
        }
        return entry;
    }

    // Moves the counts in memory into storage, on top of what other tabs have saved there.
    function save() {
        lastSave = performance.now();
        if (!Object.keys(mem.t).length && !Object.keys(mem.d).length) return;
        const key = prefix() + "p";
        cache.delete(key);
        write(key, mergeAdd(read(key) ?? { t: {}, d: {} }, mem));
        mem = { t: {}, d: {} };
    }

    function memEntry(track) {
        return mem.t[track] ?? (mem.t[track] = {});
    }

    function bump(field, amount = 1) {
        const entry = memEntry(run.track);
        entry[field] = (entry[field] ?? 0) + amount;
        entry.l = Date.now();
        if (run.name) entry.n = run.name;
        if (session && field in session) session[field] += amount;
    }

    function loadSession(track) {
        let saved = null;
        try {
            saved = JSON.parse(sessionStorage.getItem(SESSION_KEY));
        } catch {}
        session = saved?.track === track && Date.now() - saved.at < SESSION_GAP_MS ? saved : { track, at: Date.now(), t: 0, a: 0, f: 0, r: 0, s: 0 };
    }

    function saveSession() {
        if (!session) return;
        session.at = Date.now();
        try {
            sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
        } catch {}
    }

    function inCup() {
        return !!window.__nswsCupApp?.inCup?.();
    }

    function creditTime() {
        if (!run) return;
        const car = run.car;
        if (!car.hasStarted()) return;
        if (!run.attempted) {
            run.attempted = true;
            bump("a");
        }
        const finish = car.getFinishTime()?.numberOfFrames;
        const frames = finish ?? car.getTime().numberOfFrames;
        // A respawn may wind the clock back.
        if (frames < run.frames) run.frames = run.active = frames;
        const controls = car.getControls();
        if (controls?.up || controls?.down || controls?.left || controls?.right) run.active = frames;
        const counted = Math.min(frames, run.active + IDLE_FRAMES);
        if (counted > run.frames) {
            const seconds = (counted - run.frames) / 1000;
            run.frames = counted;
            bump("t", seconds);
            const day = dayKey();
            mem.d[day] = (mem.d[day] ?? 0) + seconds;
        }
    }

    function endRun(replaced) {
        if (!run) return;
        creditTime();
        if (replaced && run.attempted && !run.finished) bump("r");
        run = null;
    }

    function newCar(car, track, name, solo) {
        endRun(true);
        if (!solo || inCup()) {
            save();
            paintHud();
            return;
        }
        if (session?.track !== track || Date.now() - session.at >= SESSION_GAP_MS) loadSession(track);
        run = { car, track, name: typeof name === "string" ? name : null, frames: 0, active: 0, attempted: false, finished: false };
        save();
        saveSession();
        markOlder();
        if (!loaded.has(prefix())) sync();
        paintHud();
    }

    // Runs from before these stats existed can't be counted, so a PB already on the track marks its numbers as a floor.
    function markOlder() {
        if (!run || run.olderChecked || (token() && !loaded.has(prefix()))) return;
        run.olderChecked = true;
        if (window.__nswsPersonalBest?.(run.track) != null && !Object.keys(totals(run.track)).length) memEntry(run.track).o = true;
    }

    function respawn(car) {
        if (run?.car !== car || !car.hasStarted() || !car.getControls()?.reset) return;
        bump("s");
    }

    // Every send is a Worker and a Durable Object request (100k a day each on the free plan), so a busy site sends less.
    function syncGap() {
        return Math.min(SYNC_MAX_MS, Math.max(SYNC_MS, (window.__nswsPlayersOnline || 0) * SYNC_PER_ONLINE_MS));
    }

    function leave() {
        endRun(false);
        save();
        saveSession();
        paintHud();
        if (Date.now() - lastSync >= syncGap() / 5) sync();
    }

    function onFinish(e) {
        if (!run || e.detail?.track !== run.track || run.finished) return;
        creditTime();
        run.finished = true;
        bump("f");
        bump("fs", e.detail.seconds);
        save();
        saveSession();
        paintHud();
    }

    function onNewPb(e) {
        if (!run || e.detail?.track !== run.track) return;
        const frames = Math.round(e.detail.seconds * 1000);
        const before = totals(run.track);
        const previous = before.h?.[before.h.length - 1];
        const entry = memEntry(run.track);
        entry.b = frames;
        entry.p = (entry.p ?? 0) + 1;
        (entry.h ?? (entry.h = [])).push([Math.floor(Date.now() / 1000), frames, before.a ?? 0, round(before.t ?? 0)]);
        lastPb = {
            track: run.track,
            frames,
            time: before.t ?? 0,
            attempts: before.a ?? 0,
            finishes: before.f ?? 0,
            older: !!before.o,
            sinceTime: previous ? (before.t ?? 0) - previous[3] : null,
            sinceAttempts: previous ? (before.a ?? 0) - previous[2] : null,
        };
        save();
    }

    async function sync(leaving = false) {
        const t = token();
        if (!API || !t || (!leaving && (syncing || Date.now() < notBefore))) return;
        const p = prefix(t);
        save();
        cache.delete(p + "o");
        cache.delete(p + "p");
        let batch = read(p + "o");
        if (!batch) {
            const add = read(p + "p");
            if (add && (Object.keys(add.t).length || Object.keys(add.d).length)) {
                batch = { id: randomId(), add };
                write(p + "o", batch);
                write(p + "p", null);
            }
        }
        if (!batch && (leaving || loaded.has(p))) return;
        lastSync = Date.now();
        if (!leaving) syncing = true;
        try {
            const response = await fetch(API + "nsws/grind/sync", {
                method: "POST",
                headers: { "Content-Type": "text/plain" },
                body: JSON.stringify({ userToken: t, id: batch?.id, add: batch?.add }),
                cache: "no-store",
                credentials: "omit",
                keepalive: leaving,
            });
            if (leaving) return;
            const data = await response.json().catch(() => null);
            if (response.status === 200 && data?.grind) {
                loaded.add(p);
                write(p + "b", data.grind);
                cache.delete(p + "o");
                if (batch && read(p + "o")?.id === batch.id) write(p + "o", null);
                markOlder();
            } else if (batch && (response.status === 400 || response.status === 413) && (batch.tries ?? 0) >= BAD_BATCH_TRIES) {
                // It will never be accepted, and it would block every later batch.
                write(p + "o", null);
            } else {
                if (batch && (response.status === 400 || response.status === 413)) write(p + "o", { ...batch, tries: (batch.tries ?? 0) + 1 });
                if (response.status === 503) window.__nswsBusy?.fromData(data);
                notBefore = Date.now() + SYNC_RETRY_MS;
            }
        } catch {
            notBefore = Date.now() + SYNC_RETRY_MS;
        } finally {
            if (!leaving) syncing = false;
            paintWindow();
        }
    }

    function hasUnsent() {
        const p = prefix();
        cache.delete(p + "o");
        cache.delete(p + "p");
        return !!(read(p + "o") || read(p + "p") || Object.keys(mem.t).length);
    }

    function clock(seconds) {
        const s = Math.floor(seconds);
        const h = Math.floor(s / 3600);
        const m = Math.floor(s / 60) % 60;
        return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s % 60).padStart(2, "0");
    }

    function longTime(seconds) {
        const s = Math.floor(seconds ?? 0);
        const h = Math.floor(s / 3600);
        const m = Math.floor(s / 60) % 60;
        if (h) return h + " h " + m + " m";
        if (m) return m + " m " + (s % 60) + " s";
        return (s % 60) + " s";
    }

    function runTime(frames) {
        const m = Math.floor(frames / 60000);
        const seconds = (frames % 60000) / 1000;
        return (m ? m + ":" + seconds.toFixed(3).padStart(6, "0") : seconds.toFixed(3));
    }

    function count(n) {
        return (n ?? 0).toLocaleString("en-US");
    }

    function plural(n, word, ending = "s") {
        return count(n) + " " + word + (n === 1 ? "" : ending);
    }

    function dateText(ms) {
        return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
    }

    function hudVisible() {
        return !!run && window.__nswsSettingBoolean?.("GrindStats") !== false && !inCup()
            && !!document.querySelector(".game-ui:not(.hidden)") && !document.querySelector(".preview-toolbar-ui");
    }

    function paintHud() {
        if (!hud) {
            if (!run) return;
            hud = el("div");
            hud.id = "nsws-grind-hud";
            const add = (className, text) => {
                const cell = el("span", className, text);
                hud.appendChild(cell);
                return cell;
            };
            add("h k", "");
            add("h", "Session");
            add("h", "Total");
            hud.cells = {};
            for (const [field, label] of [["t", "Time"], ["a", "Attempts"], ["f", "Finishes"], ["r", "Resets"], ["s", "Respawns"]]) {
                add("k", label);
                hud.cells[field] = [add(), add()];
            }
            hud.since = add("since");
            document.body.appendChild(hud);
        }
        const show = hudVisible();
        hud.classList.toggle("show", show);
        if (!show) return;
        const total = totals(run.track);
        const set = (cell, text) => {
            if (cell.textContent !== text) cell.textContent = text;
        };
        for (const [field, [now, all]] of Object.entries(hud.cells)) {
            set(now, field === "t" ? clock(session?.t ?? 0) : count(session?.[field]));
            set(all, field === "t" ? clock(total.t ?? 0) : count(total[field]));
        }
        const pb = total.h?.[total.h.length - 1];
        set(hud.since, pb ? "Since PB: " + clock((total.t ?? 0) - pb[3]) + ", " + plural((total.a ?? 0) - pb[2], "attempt") : "");
        hud.since.style.display = pb ? "" : "none";
    }

    function tick() {
        if (!run) return;
        if (inCup()) {
            run = null;
            paintHud();
            return;
        }
        creditTime();
        if (performance.now() - lastSave >= SAVE_MS) {
            save();
            saveSession();
        }
        paintHud();
    }

    function checkSync() {
        if (document.visibilityState === "hidden" || Date.now() - lastSync < syncGap() || !hasUnsent()) return;
        sync();
    }

    function weekOf(id) {
        return window.__nswsTrackWeek?.(id) ?? null;
    }

    function weekName(week) {
        return (window.__nswsWeeks || []).find((w) => w.week === week)?.label || "Week " + week;
    }

    function trackName(id, entry) {
        return entry.n || "Track " + id.slice(0, 6);
    }

    // The tracks in a scope: "all", a week number, or "other" for tracks outside the NSWS weeks.
    function tracksIn(stats, scope) {
        return Object.entries(stats.t).filter(([id]) => {
            if (scope === "all") return true;
            const week = weekOf(id);
            return scope === "other" ? week == null : week === scope;
        });
    }

    function scopes(stats) {
        const weeks = new Set();
        let other = false;
        for (const id of Object.keys(stats.t)) {
            const week = weekOf(id);
            if (week == null) other = true;
            else weeks.add(week);
        }
        return ["all", ...[...weeks].sort((a, b) => b - a), ...(other ? ["other"] : [])];
    }

    function scopeName(scope) {
        return scope === "all" ? "All tracks" : scope === "other" ? "Other tracks" : weekName(scope);
    }

    function sum(tracks) {
        const total = { t: 0, a: 0, f: 0, r: 0, s: 0, p: 0 };
        for (const [, e] of tracks) for (const key of Object.keys(total)) total[key] += e[key] ?? 0;
        return total;
    }

    function finishRate(e) {
        return e.a ? Math.round(Math.min(1, (e.f ?? 0) / e.a) * 100) + "%" : "-";
    }

    function line(label, value) {
        const row = el("div", "line");
        row.append(el("span", null, label), el("b", null, value));
        return row;
    }

    function dayChart(stats) {
        const wrap = el("div");
        const caption = el("div", "caption");
        const days = [];
        for (let i = CHART_DAYS - 1; i >= 0; i--) {
            const date = new Date();
            date.setDate(date.getDate() - i);
            days.push({ date, seconds: stats.d[dayKey(date)] ?? 0 });
        }
        const most = Math.max(...days.map((d) => d.seconds), 1);
        const total = days.reduce((all, d) => all + d.seconds, 0);
        const label = (d) => d.date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
        const summary = longTime(total) + " in the last " + CHART_DAYS + " days";
        caption.textContent = summary;
        const bars = el("div", "days");
        for (const d of days) {
            const day = el("div", "day");
            const bar = el("i");
            bar.style.height = (d.seconds ? Math.max(3, (d.seconds / most) * 100) : 0) + "%";
            day.appendChild(bar);
            day.setAttribute("aria-label", label(d) + ": " + longTime(d.seconds));
            day.addEventListener("pointerenter", () => {
                caption.textContent = label(d) + ": " + longTime(d.seconds);
            });
            day.addEventListener("pointerleave", () => {
                caption.textContent = summary;
            });
            bars.appendChild(day);
        }
        const axis = el("div", "axis");
        axis.append(el("span", null, label(days[0])), el("span", null, "Today"));
        wrap.append(caption, bars, axis);
        return wrap;
    }

    // Each PB by the attempt that set it: down is faster, and a flat stretch is a drought.
    function pbChart(entry) {
        const pbs = [...entry.h].sort((a, b) => a[2] - b[2]);
        const wrap = el("div");
        const caption = el("div", "caption");
        const summary = pbs.length + " PBs, from " + runTime(pbs[0][1]) + " to " + runTime(pbs[pbs.length - 1][1]);
        caption.textContent = summary;
        const W = 600;
        const H = 150;
        const firstAttempt = pbs[0][2];
        const lastAttempt = Math.max(entry.a ?? 0, pbs[pbs.length - 1][2], firstAttempt + 1);
        const slow = pbs[0][1];
        const fast = Math.min(...pbs.map((pb) => pb[1]));
        const x = (attempts) => ((attempts - firstAttempt) / (lastAttempt - firstAttempt)) * W;
        const y = (frames) => H - 6 - (slow === fast ? 0.5 : (frames - fast) / (slow - fast)) * (H - 12);
        const NS = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(NS, "svg");
        svg.setAttribute("class", "chart");
        svg.setAttribute("viewBox", "0 0 " + W + " " + H);
        svg.setAttribute("preserveAspectRatio", "none");
        for (const frames of [slow, fast]) {
            const rule = document.createElementNS(NS, "line");
            rule.setAttribute("class", "grid");
            rule.setAttribute("x1", 0);
            rule.setAttribute("x2", W);
            rule.setAttribute("y1", y(frames));
            rule.setAttribute("y2", y(frames));
            svg.appendChild(rule);
        }
        let d = "M" + x(pbs[0][2]) + " " + y(pbs[0][1]);
        for (const pb of pbs.slice(1)) d += "H" + x(pb[2]) + "V" + y(pb[1]);
        d += "H" + W;
        const path = document.createElementNS(NS, "path");
        path.setAttribute("d", d);
        svg.appendChild(path);
        const dots = el("div", "dots");
        const marks = pbs.map((pb) => {
            const dot = el("div", "dot");
            dot.style.left = (x(pb[2]) / W) * 100 + "%";
            dot.style.top = y(pb[1]) + "px";
            dots.appendChild(dot);
            return dot;
        });
        const show = (pb, i) => {
            marks.forEach((m, j) => m.classList.toggle("on", j === i));
            caption.textContent = runTime(pb[1]) + " on attempt " + count(pb[2]) + ", " + dateText(pb[0] * 1000);
        };
        svg.addEventListener("pointermove", (e) => {
            const r = svg.getBoundingClientRect();
            const at = ((e.clientX - r.left) / r.width) * W;
            let best = 0;
            pbs.forEach((pb, i) => {
                if (Math.abs(x(pb[2]) - at) < Math.abs(x(pbs[best][2]) - at)) best = i;
            });
            show(pbs[best], best);
        });
        svg.addEventListener("pointerleave", () => {
            marks.forEach((m) => m.classList.remove("on"));
            caption.textContent = summary;
        });
        const axis = el("div", "axis");
        axis.append(el("span", null, "Attempt " + count(firstAttempt)), el("span", null, "Attempt " + count(lastAttempt)));
        wrap.append(caption, svg, dots, axis);
        return wrap;
    }

    function renderList(body, stats) {
        const tracks = tracksIn(stats, view.scope);
        if (!tracks.length) {
            body.appendChild(el("div", "msg", "No runs counted yet. Drive any track and your grind shows up here."));
            return;
        }
        const total = sum(tracks);
        body.append(
            el("div", "sec", scopeName(view.scope)),
            line("Time driven", longTime(total.t)),
            line("Attempts", count(total.a)),
            line("Finishes", count(total.f) + " (" + finishRate(total) + ")"),
            line("Resets", count(total.r)),
            line("Respawns", count(total.s)),
            line("New PBs", count(total.p)),
        );
        if (view.scope === "all") {
            body.append(el("div", "sec", "Time per day"), dayChart(stats));
        }
        body.appendChild(el("div", "sec", tracks.length === 1 ? "1 track" : tracks.length + " tracks"));
        const column = COLUMNS.find((c) => c.id === view.sort) ?? COLUMNS[1];
        const sorted = [...tracks].sort((a, b) => {
            if (column.id === "name") return trackName(a[0], a[1]).localeCompare(trackName(b[0], b[1]));
            const delta = (column.value(b[1]) ?? 0) - (column.value(a[1]) ?? 0);
            return column.low ? -delta : delta;
        });
        const table = el("table");
        const head = el("tr");
        for (const c of COLUMNS) {
            const th = el("th", "sort" + (c.id === column.id ? " on" : "") + (c.wide ? " wide" : ""), c.text);
            th.addEventListener("click", () => {
                window.__nswsUIClick?.();
                view.sort = c.id;
                render();
            });
            head.appendChild(th);
        }
        table.appendChild(head);
        for (const [id, e] of sorted) {
            const row = el("tr", "go");
            row.title = "Open this track's stats";
            for (const c of COLUMNS) {
                const cell = el("td", (c.id === "name" ? "name" : "") + (c.wide ? " wide" : ""), c.id === "name" ? trackName(id, e) : c.show ? c.show(e) : count(c.value(e)));
                row.appendChild(cell);
            }
            row.addEventListener("click", () => {
                window.__nswsUIClick?.();
                view.track = id;
                render();
                view.body.scrollTop = 0;
            });
            table.appendChild(row);
        }
        body.appendChild(table);
        const since = stats.since ?? Math.min(...Object.values(stats.t).map((e) => e.h?.[0]?.[0] * 1000 || e.l || Date.now()));
        body.appendChild(el("p", "note", "Counting since " + dateText(since) + ". Solo runs only, so cups and editor test drives add nothing. Time stops when you pause, or after 30 seconds without input."));
        const row = el("div", "row");
        row.appendChild(button("Copy stats", () => {
            const text = "NSWS grind · " + scopeName(view.scope) + ": " + longTime(total.t) + " · " + count(total.a) + " attempts · "
                + count(total.f) + " finishes · " + count(total.p) + " PBs\n" + (window.__nswsTags?.refLink?.() || location.origin + location.pathname);
            navigator.clipboard?.writeText(text).then(() => {
                view.note = "Copied! Paste it in Discord or a chat.";
                render();
            }, () => {});
        }));
        body.appendChild(row);
        if (view.note) body.appendChild(el("p", "note good", view.note));
    }

    function renderTrack(body, stats) {
        const entry = stats.t[view.track];
        if (!entry) {
            view.track = null;
            renderList(body, stats);
            return;
        }
        const pb = entry.h?.[entry.h.length - 1];
        const best = window.__nswsPersonalBest?.(view.track);
        const shownBest = Math.min(entry.b ?? Infinity, best ?? Infinity);
        body.append(
            el("div", "sec", "Grind"),
            line("Time driven", longTime(entry.t)),
            line("Attempts", count(entry.a)),
            line("Finishes", count(entry.f) + " (" + finishRate(entry) + ")"),
            line("Resets", count(entry.r)),
            line("Respawns", count(entry.s)),
            line("Average finish", entry.f ? runTime(Math.round((entry.fs / entry.f) * 1000)) : "-"),
            line("Personal best", Number.isFinite(shownBest) ? runTime(shownBest) : "-"),
        );
        if (pb) {
            body.append(
                line("Since your last PB", longTime((entry.t ?? 0) - pb[3]) + ", " + plural((entry.a ?? 0) - pb[2], "attempt")),
                line("Last PB", dateText(pb[0] * 1000)),
            );
        }
        if (entry.l) body.appendChild(line("Last played", dateText(entry.l)));
        if (entry.h?.length > 1) body.append(el("div", "sec", "PB climb"), pbChart(entry));
        if (entry.h?.length) {
            body.appendChild(el("div", "sec", "PBs"));
            const table = el("table");
            const head = el("tr");
            for (const text of ["Date", "Time", "Improved", "Attempts", "Driven"]) head.appendChild(el("th", null, text));
            table.appendChild(head);
            const pbs = [...entry.h].sort((a, b) => b[2] - a[2]);
            pbs.forEach((item, i) => {
                const older = pbs[i + 1];
                const row = el("tr");
                row.append(el("td", null, dateText(item[0] * 1000)), el("td", null, runTime(item[1])), el("td", null, older ? "-" + runTime(older[1] - item[1]) : "-"),
                    el("td", null, count(item[2])), el("td", null, longTime(item[3])));
                table.appendChild(row);
            });
            body.appendChild(table);
        }
        if (entry.o) body.appendChild(el("p", "note", "You had a PB here before these stats started, so your real grind on this track is longer."));
        const open = window.__nswsOpenTrack;
        if (open && weekOf(view.track) != null) {
            const row = el("div", "row");
            const id = view.track;
            row.appendChild(button("Go to track", () => {
                close();
                open(id);
            }));
            body.appendChild(row);
        }
    }

    function render() {
        if (!view) return;
        const { top, body } = view;
        const stats = allStats();
        const list = scopes(stats);
        if (!list.includes(view.scope)) view.scope = "all";
        const scrolled = body.scrollTop;
        top.textContent = "";
        if (view.track && stats.t[view.track]) {
            const week = weekOf(view.track);
            const h1 = el("h1", null, trackName(view.track, stats.t[view.track]));
            if (week != null) h1.append(" ", el("small", null, "· " + weekName(week)));
            top.append(h1, button("Back", () => {
                view.track = null;
                render();
            }), button("✕", close));
        } else {
            const at = list.indexOf(view.scope);
            const h1 = el("h1", null, "Grinding stats");
            h1.append(" ", el("small", null, "· " + scopeName(view.scope)));
            const go = (delta) => {
                view.scope = list[at + delta];
                view.note = "";
                render();
            };
            const prev = button("◀", () => go(-1));
            const next = button("▶", () => go(1));
            prev.disabled = at <= 0;
            next.disabled = at >= list.length - 1;
            prev.title = "Previous group";
            next.title = "Next group";
            top.append(h1, prev, next, button("✕", close));
        }
        body.textContent = "";
        if (view.track && stats.t[view.track]) renderTrack(body, stats);
        else {
            view.track = null;
            renderList(body, stats);
        }
        body.scrollTop = scrolled;
    }

    function paintWindow() {
        if (view) render();
    }

    function onKey(e) {
        if (e.key !== "Escape" && e.code !== "Escape") return;
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
    }

    function close() {
        if (!view) return;
        view.overlay.remove();
        window.removeEventListener("keydown", onKey, true);
        view = null;
    }

    function open(track = null) {
        if (view) return;
        const overlay = el("div");
        overlay.id = "nsws-grind";
        const box = el("div", "box");
        box.tabIndex = -1;
        box.appendChild(el("div", "checker"));
        const top = el("div", "top");
        const body = el("div", "body");
        box.append(top, body);
        overlay.appendChild(box);
        overlay.addEventListener("pointerdown", (e) => {
            if (e.target === overlay) close();
        });
        for (const type of ["keydown", "keyup", "keypress"]) overlay.addEventListener(type, (e) => e.stopPropagation());
        document.body.appendChild(overlay);
        window.addEventListener("keydown", onKey, true);
        box.focus();
        view = { overlay, top, body, scope: "all", sort: "t", track, note: "" };
        render();
        if (!loaded.has(prefix()) || (hasUnsent() && Date.now() - lastSync >= syncGap() / 5)) sync();
    }

    // What the Share PB image says about the grind behind a PB.
    function pbSummary(track) {
        return lastPb?.track === track ? lastPb : null;
    }

    function pbLine(track) {
        const pb = pbSummary(track);
        if (!pb || !pb.attempts) return null;
        const more = pb.older ? "+" : "";
        const parts = ["Grinded " + longTime(pb.time) + more + " for this PB", plural(pb.attempts, "attempt") + more, plural(pb.finishes, "finish", "es") + more];
        return { main: parts.join(" · "), since: pb.sinceTime != null ? longTime(pb.sinceTime) + " and " + plural(pb.sinceAttempts, "attempt") + " since the last PB" : null };
    }

    if (!document.getElementById("nsws-grind-style")) {
        const style = el("style");
        style.id = "nsws-grind-style";
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    window.addEventListener("nsws-finish", onFinish);
    window.addEventListener("nsws-new-pb", onNewPb);
    window.addEventListener("storage", (e) => {
        if (e.key?.startsWith(KEY)) cache.delete(e.key);
    });
    setInterval(tick, TICK_MS);
    setInterval(checkSync, 15000);
    // Hidden tabs send nothing later, so what's waiting goes now. Going away never waits for the reply:
    // the batch stays in storage and the next visit sends it again, which the Worker counts once.
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "hidden") return;
        creditTime();
        saveSession();
        if (Date.now() - lastSync >= syncGap() / 5 && hasUnsent()) sync(true);
    });
    window.addEventListener("pagehide", () => {
        creditTime();
        saveSession();
        if (hasUnsent()) sync(true);
    });
    setTimeout(() => {
        if (hasUnsent()) sync();
    }, 10000);

    window.__nswsGrind = { newCar, respawn, leave, open, close, pbSummary, pbLine, stats: allStats, flush: sync };
})();
