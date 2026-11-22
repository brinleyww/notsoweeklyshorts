// Changelog window, opened from the main menu's bottom bar. Reads changelog.json (newest first) and Better Editor's
// own changelog.json, which goes live with Better Editor's site, not with ours.
(function () {
    const SEEN_KEY = "_nswsChangelogSeen";
    const BE_SEEN_KEY = "_nswsChangelogBESeen";
    const TIMES_KEY = "_nswsChangelogTimes:";
    // Each copy of the site has its own deploys; the fork deploys in batches when someone syncs it.
    const SITES = [
        { host: "brinleyww.github.io", repo: "brinleyww/notsoweeklyshorts" },
        { host: "notweeklyshorts.github.io", repo: "notweeklyshorts/notweeklyshorts.github.io" },
    ];
    const REPO = (SITES.find(s => s.host === location.hostname) || SITES[0]).repo;
    const BE_REPO = "brinleyww/Better-Editor-PT";
    const BE_SITE = "https://brinleyww.github.io/Better-Editor-PT/";
    const BE_MIRROR = "https://pt-leaderboard-proxy.bringleyw.workers.dev/be/";
    // Better Editor deploys from before its changelog started.
    const BE_LOG_START = Date.parse("2026-11-21T20:00:00Z");
    const MAX_PAGES = 5;
    const WAIT_FOR_TIMES_MS = 2500;
    const STAMP = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
    const CSS = `
#nsws-changelog{position:fixed;inset:0;z-index:9998;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.7);}
#nsws-changelog *{box-sizing:border-box;}
#nsws-changelog>.box{display:flex;flex-direction:column;width:min(640px,96vw);max-height:90vh;background:var(--surface-color);color:var(--text-color);}
#nsws-changelog .checker{height:8px;flex-shrink:0;background:repeating-conic-gradient(#fff 0 25%,#112052 0 50%) 0 0/8px 8px;opacity:.85;}
#nsws-changelog .top{display:flex;align-items:center;gap:12px;padding:12px 20px;background:var(--surface-secondary-color);}
#nsws-changelog .top>h1{margin:0 auto 0 0;font-size:32px;font-weight:normal;color:#b3c1ff;text-shadow:0 2px 0 #112052;}
#nsws-changelog .top>.button{margin:0;font-size:20px;padding:6px 14px;}
#nsws-changelog .body{overflow-y:auto;padding:12px 20px 18px;}
#nsws-changelog .ver{margin:14px 0 4px;font-size:24px;color:#ffc94a;}
#nsws-changelog .ver.be{color:#8fd8ff;}
#nsws-changelog .ver:first-child{margin-top:0;}
#nsws-changelog .ver>span{margin-left:10px;font-size:15px;color:var(--text-color);opacity:.55;white-space:nowrap;}
#nsws-changelog ul{margin:0;padding-left:24px;font-size:19px;}
#nsws-changelog li{margin:3px 0;overflow-wrap:anywhere;}
#nsws-changelog .msg{font-size:19px;opacity:.7;}
.nsws-changelog-btn>.dot{display:none;position:absolute;top:5px;right:8px;width:8px;height:8px;border-radius:50%;background:#ffc94a;pointer-events:none;}
.nsws-changelog-btn.fresh>.dot{display:block;}
`;
    let overlay = null;
    let latest = null;
    let beLatest = 0;
    const buttons = new Set();

    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    function getItem(key) {
        try {
            return localStorage.getItem(key);
        } catch (e) {
            return null;
        }
    }

    function setItem(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch (e) {}
    }

    function markSeen() {
        if (latest) setItem(SEEN_KEY, latest);
        if (beLatest) setItem(BE_SEEN_KEY, String(beLatest));
        paint();
    }

    function paint() {
        const fresh = (!!latest && getItem(SEEN_KEY) !== latest) || beLatest > (Number(getItem(BE_SEEN_KEY)) || 0);
        for (const b of buttons) b.classList.toggle("fresh", fresh);
    }

    async function fetchJson(url) {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(url + " " + res.status);
        return res.json();
    }

    function beSites() {
        // Same local override as the page's Better Editor files, for testing a local copy.
        if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
            const own = getItem("nswsBEBase");
            if (own && /^https?:\/\/\S+$/.test(own)) return [own.replace(/\/?$/, "/")];
        }
        return [BE_SITE, BE_MIRROR];
    }

    async function loadBE() {
        // The mirror only when github.io can't be reached at all, not when it answers.
        for (const site of beSites()) {
            let res;
            try {
                res = await fetch(site + "changelog.json", { cache: "no-store" });
            } catch (e) {
                continue;
            }
            const log = res.ok ? await res.json().catch(() => null) : null;
            return Array.isArray(log) ? log.filter(e => e && Number.isSafeInteger(e.id) && e.id > 0 && Array.isArray(e.changes)) : [];
        }
        return [];
    }

    async function load() {
        const [log, be] = await Promise.all([
            fetchJson(new URL("changelog.json", location.href)).then(j => j.filter(e => e && typeof e.version === "string" && Array.isArray(e.changes))),
            loadBE(),
        ]);
        latest = log[0]?.version || null;
        beLatest = be.reduce((m, e) => Math.max(m, e.id), 0);
        paint();
        return { log, be };
    }

    function versionKey(v) {
        const m = /^v?(\d+(?:\.\d+)*)/.exec(String(v || "").trim());
        return m ? m[1].split(".").map(Number) : null;
    }

    function compare(a, b) {
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
            const d = (a[i] || 0) - (b[i] || 0);
            if (d) return d;
        }
        return 0;
    }

    function cachedTimes(repo) {
        try {
            return JSON.parse(localStorage.getItem(TIMES_KEY + repo)) || {};
        } catch (e) {
            return {};
        }
    }

    // Successful Pages deploys of main, newest first, a page of 100 at a time. onPage returns true to stop.
    // Resolves true when it saw every deploy it needed.
    async function deploys(repo, onPage) {
        const api = "https://api.github.com/repos/" + repo + "/actions/runs?branch=main&status=success&per_page=100&page=";
        for (let page = 1; page <= MAX_PAGES; page++) {
            const res = await fetch(api + page);
            if (!res.ok) return false;
            const runs = (await res.json()).workflow_runs || [];
            const list = runs.map(r => ({ sha: r.head_sha || "", msg: r.head_commit?.message || r.display_title, at: Date.parse(r.updated_at) })).filter(r => r.at > 0);
            if (onPage(list) || runs.length < 100) return true;
        }
        return false;
    }

    // A version went live with the first deploy of it or anything newer (one fork sync can carry several versions).
    // A time is only final once an older deploy has been seen, so only final times are kept.
    async function releaseTimes(log) {
        const times = cachedTimes(REPO);
        const want = log.map(e => ({ v: e.version, key: versionKey(e.version) })).filter(w => w.key && !(w.v in times));
        if (!want.length) return times;
        const oldest = want.reduce((a, w) => (compare(w.key, a) < 0 ? w.key : a), want[0].key);
        const found = {};
        const final = new Set();
        await deploys(REPO, runs => {
            let done = false;
            for (const run of runs) {
                const key = versionKey(run.msg);
                if (!key) continue;
                for (const w of want) {
                    if (compare(key, w.key) >= 0) found[w.v] = run.at;
                    else if (w.v in found) final.add(w.v);
                }
                if (compare(key, oldest) < 0) done = true;
            }
            return done;
        });
        for (const v of final) times[v] = found[v];
        setItem(TIMES_KEY + REPO, JSON.stringify(times));
        return Object.assign({}, found, times);
    }

    // A Better Editor entry went live with the first deploy whose changelog.json has its id (ids only go up).
    // Entries written after the fact name the commit whose deploy carried them instead.
    async function beReleaseTimes(be) {
        const times = cachedTimes(BE_REPO);
        const want = be.filter(e => !(e.id in times));
        if (!want.length) return times;
        const runs = [];
        const complete = await deploys(BE_REPO, list => {
            runs.push(...list);
            return !list.length || list[list.length - 1].at < BE_LOG_START;
        });
        const maxIds = new Map();
        const maxId = i => {
            const sha = runs[i].sha;
            if (!maxIds.has(sha))
                maxIds.set(sha, fetch("https://raw.githubusercontent.com/" + BE_REPO + "/" + sha + "/changelog.json").then(async res => {
                    if (res.status === 404) return 0;
                    if (!res.ok) throw new Error("changelog at " + sha + " " + res.status);
                    const log = await res.json();
                    return Array.isArray(log) ? log.reduce((m, e) => Math.max(m, Number.isSafeInteger(e?.id) ? e.id : 0), 0) : 0;
                }));
            return maxIds.get(sha);
        };
        const found = {};
        for (const e of want) {
            if (typeof e.commit === "string" && /^[0-9a-f]{7,40}$/.test(e.commit)) {
                const run = runs.find(r => r.sha.startsWith(e.commit));
                if (run) times[e.id] = run.at;
                continue;
            }
            if (!runs.length || (await maxId(0)) < e.id) continue;
            // Runs are newest first, so the oldest deploy that has the id is the last index that has it.
            let lo = 0;
            let hi = runs.length - 1;
            while (lo < hi) {
                const mid = (lo + hi + 1) >> 1;
                if ((await maxId(mid)) >= e.id) lo = mid;
                else hi = mid - 1;
            }
            if (lo < runs.length - 1 || complete) times[e.id] = runs[lo].at;
            else found[e.id] = runs[lo].at;
        }
        setItem(TIMES_KEY + BE_REPO, JSON.stringify(times));
        return Object.assign(found, times);
    }

    // Both lists are newest first; an entry without a time keeps its place in its own list.
    function merge(log, be, times, beTimes) {
        const out = [];
        let i = 0;
        let j = 0;
        while (i < log.length || j < be.length) {
            const a = log[i];
            const b = be[j];
            const ta = a && times[a.version];
            const tb = b && beTimes[b.id];
            if (!b || (a && (!ta || !tb || ta >= tb))) {
                out.push({ title: a.version, changes: a.changes, at: ta, key: "v" + a.version });
                i++;
            } else {
                out.push({ title: "Better Editor", be: true, changes: b.changes, at: tb, key: "b" + b.id });
                j++;
            }
        }
        return out;
    }

    function addStyle() {
        if (document.getElementById("nsws-changelog-style")) return;
        const style = el("style");
        style.id = "nsws-changelog-style";
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    function onKey(e) {
        if (e.key !== "Escape" && e.code !== "Escape") return;
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
    }

    function close() {
        if (!overlay) return;
        overlay.remove();
        overlay = null;
        window.removeEventListener("keydown", onKey, true);
    }

    function open() {
        if (overlay) return;
        addStyle();
        overlay = el("div");
        overlay.id = "nsws-changelog";
        const box = el("div", "box");
        box.appendChild(el("div", "checker"));
        const top = el("div", "top");
        const x = el("button", "button", "✕");
        x.addEventListener("click", close);
        top.append(el("h1", null, "Changelog"), x);
        const body = el("div", "body");
        body.appendChild(el("div", "msg", "Loading..."));
        box.append(top, body);
        overlay.appendChild(box);
        overlay.addEventListener("pointerdown", e => {
            if (e.target === overlay) close();
        });
        for (const type of ["keydown", "keyup", "keypress"]) overlay.addEventListener(type, e => e.stopPropagation());
        document.body.appendChild(overlay);
        window.addEventListener("keydown", onKey, true);

        const view = overlay;
        load().then(async ({ log, be }) => {
            // The order between the two lists needs the times, so wait for them a little (they're cached once final).
            const timed = Promise.all([releaseTimes(log).catch(() => ({})), beReleaseTimes(be).catch(() => ({}))]);
            const first = await Promise.race([timed, new Promise(ok => setTimeout(ok, WAIT_FOR_TIMES_MS, null))]);
            if (overlay !== view) return;
            const [times, beTimes] = first || [{}, {}];
            body.textContent = "";
            const entries = merge(log, be, times, beTimes);
            if (!entries.length) body.appendChild(el("div", "msg", "Nothing here yet."));
            const stamps = new Map();
            for (const entry of entries) {
                const ver = el("div", entry.be ? "ver be" : "ver", entry.title);
                const stamp = el("span", null, entry.at ? STAMP.format(new Date(entry.at)) : "");
                ver.appendChild(stamp);
                stamps.set(entry.key, stamp);
                const list = el("ul");
                for (const line of entry.changes) list.appendChild(el("li", null, String(line)));
                body.append(ver, list);
            }
            markSeen();
            if (first) return;
            // Times that come too late only fill in the stamps; the list doesn't move under the reader.
            timed.then(([late, beLate]) => {
                const fill = (key, at) => {
                    const span = stamps.get(key);
                    if (span && at && !span.textContent) span.textContent = STAMP.format(new Date(at));
                };
                for (const e of log) fill("v" + e.version, late[e.version]);
                for (const e of be) fill("b" + e.id, beLate[e.id]);
            });
        }).catch(() => {
            if (overlay !== view) return;
            body.textContent = "";
            body.appendChild(el("div", "msg", "Couldn't load the changelog."));
        });
    }

    function mountButton(b) {
        addStyle();
        b.classList.add("nsws-changelog-btn");
        b.innerHTML = '<img src="images/list.svg"> ';
        const dot = el("span", "dot");
        b.append("Changelog", dot);
        b.title = "What changed in each update";
        buttons.add(b);
        paint();
    }

    window.__nswsChangelog = { open, mountButton };
    load().catch(() => {});
})();
