// Changelog window, opened from the main menu's bottom bar. Reads changelog.json (newest first).
(function () {
    const SEEN_KEY = "_nswsChangelogSeen";
    const TIMES_KEY = "_nswsChangelogTimes:";
    // Each copy of the site has its own deploys; the fork deploys in batches when someone syncs it.
    const SITES = [
        { host: "brinleyww.github.io", repo: "brinleyww/notsoweeklyshorts" },
        { host: "notweeklyshorts.github.io", repo: "notweeklyshorts/notweeklyshorts.github.io" },
    ];
    const REPO = (SITES.find(s => s.host === location.hostname) || SITES[0]).repo;
    const RUNS_API = "https://api.github.com/repos/" + REPO + "/actions/runs?branch=main&status=success&per_page=100&page=";
    const MAX_PAGES = 5;
    const STAMP = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
    const CSS = `
#nsws-changelog{position:fixed;inset:0;z-index:9998;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.7);}
#nsws-changelog *{box-sizing:border-box;}
#nsws-changelog>.box{display:flex;flex-direction:column;width:min(640px,96vw);max-height:90vh;background:var(--surface-color);color:var(--text-color);clip-path:polygon(0 0,100% 0,calc(100% - 14px) 100%,0 100%);}
#nsws-changelog .checker{height:8px;flex-shrink:0;background:repeating-conic-gradient(#fff 0 25%,#112052 0 50%) 0 0/8px 8px;opacity:.85;}
#nsws-changelog .top{display:flex;align-items:center;gap:12px;padding:12px 20px;background:var(--surface-secondary-color);}
#nsws-changelog .top>h1{margin:0 auto 0 0;font-size:32px;font-weight:normal;color:#b3c1ff;text-shadow:0 2px 0 #112052;}
#nsws-changelog .top>.button{margin:0;font-size:20px;padding:6px 14px;}
#nsws-changelog .body{overflow-y:auto;padding:12px 20px 18px;}
#nsws-changelog .ver{margin:14px 0 4px;font-size:24px;color:#ffc94a;}
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
    const buttons = new Set();

    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    function seen() {
        try {
            return localStorage.getItem(SEEN_KEY);
        } catch (e) {
            return null;
        }
    }

    function markSeen() {
        if (!latest) return;
        try {
            localStorage.setItem(SEEN_KEY, latest);
        } catch (e) {}
        paint();
    }

    function paint() {
        for (const b of buttons) b.classList.toggle("fresh", !!latest && seen() !== latest);
    }

    async function load() {
        const res = await fetch(new URL("changelog.json", location.href), { cache: "no-store" });
        if (!res.ok) throw new Error("changelog " + res.status);
        const log = (await res.json()).filter(e => e && typeof e.version === "string" && Array.isArray(e.changes));
        latest = log[0]?.version || null;
        paint();
        return log;
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

    function cachedTimes() {
        try {
            return JSON.parse(localStorage.getItem(TIMES_KEY + REPO)) || {};
        } catch (e) {
            return {};
        }
    }

    // A version went live with the first deploy of it or anything newer (one fork sync can carry several versions).
    // A time is only final once an older deploy has been seen, so only final times are kept.
    async function releaseTimes(log) {
        const times = cachedTimes();
        const want = log.map(e => ({ v: e.version, key: versionKey(e.version) })).filter(w => w.key && !(w.v in times));
        if (!want.length) return times;
        const oldest = want.reduce((a, w) => (compare(w.key, a) < 0 ? w.key : a), want[0].key);
        const found = {};
        const final = new Set();
        let done = false;
        for (let page = 1; page <= MAX_PAGES && !done; page++) {
            const res = await fetch(RUNS_API + page);
            if (!res.ok) break;
            const runs = (await res.json()).workflow_runs || [];
            for (const run of runs) {
                const key = versionKey(run.head_commit?.message || run.display_title);
                const at = Date.parse(run.updated_at);
                if (!key || !(at > 0)) continue;
                for (const w of want) {
                    if (compare(key, w.key) >= 0) found[w.v] = at;
                    else if (w.v in found) final.add(w.v);
                }
                if (compare(key, oldest) < 0) done = true;
            }
            if (runs.length < 100) break;
        }
        for (const v of final) times[v] = found[v];
        try {
            localStorage.setItem(TIMES_KEY + REPO, JSON.stringify(times));
        } catch (e) {}
        return Object.assign({}, found, times);
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
        load().then(log => {
            if (overlay !== view) return;
            body.textContent = "";
            if (!log.length) body.appendChild(el("div", "msg", "Nothing here yet."));
            const stamps = new Map();
            for (const entry of log) {
                const ver = el("div", "ver", entry.version);
                const stamp = el("span");
                ver.appendChild(stamp);
                stamps.set(entry.version, stamp);
                const list = el("ul");
                for (const line of entry.changes) list.appendChild(el("li", null, String(line)));
                body.append(ver, list);
            }
            markSeen();
            releaseTimes(log).then(times => {
                for (const [v, span] of stamps) if (times[v]) span.textContent = STAMP.format(new Date(times[v]));
            }).catch(() => {});
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
