// Changelog window, opened from the main menu's bottom bar. Reads changelog.json (newest first) and Better Editor's
// own changelog.json, which goes live with Better Editor's site, not with ours.
// Nothing here may cost more as the files grow: both are read from the top by byte range, and release times are
// looked up a batch at a time, starting at the time of the entry above.
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
    const BE_DEPLOYS_KEY = "_nswsChangelogBEDeploys";
    const BE_SITE = "https://brinleyww.github.io/Better-Editor-PT/";
    const BE_MIRROR = "https://pt-leaderboard-proxy.bringleyw.workers.dev/be/";
    // Better Editor deploys from before its changelog started.
    const BE_LOG_START = Date.parse("2026-11-21T20:00:00Z");
    // Enough bytes for the newest entry, for the dot.
    const TOP_BYTES = 1024;
    const READ_BYTES = 8192;
    const ROWS = 15;
    // Small lookups fill the first screen fast; once scrolling, bigger ones spare GitHub's 60 requests an hour.
    const FIRST_LOOKUP = 10;
    const LOOKUP = 40;
    const NEWEST = 30;
    const LOAD_AHEAD_PX = 600;
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
#nsws-changelog .ver{display:flex;flex-wrap:wrap;align-items:baseline;column-gap:10px;margin:14px 0 4px;font-size:24px;color:#ffc94a;}
#nsws-changelog .ver.be{color:#8fd8ff;}
#nsws-changelog .ver:first-child{margin-top:0;}
#nsws-changelog .ver>span{font-size:15px;color:var(--text-color);opacity:.55;white-space:nowrap;}
#nsws-changelog ul{margin:0;padding-left:24px;font-size:19px;}
#nsws-changelog li{margin:3px 0;overflow-wrap:anywhere;}
#nsws-changelog .msg{margin-top:14px;font-size:19px;opacity:.7;overflow-anchor:none;}
#nsws-changelog .msg:first-child{margin-top:0;}
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

    function cached(key) {
        try {
            return JSON.parse(localStorage.getItem(key)) || {};
        } catch (e) {
            return {};
        }
    }

    function keep(key, values) {
        if (Object.keys(values).length) setItem(key, JSON.stringify(Object.assign(cached(key), values)));
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

    async function get(url, options) {
        const res = await fetch(url, options);
        return { status: res.status, stamp: res.headers.get("Last-Modified"), bytes: res.ok ? new Uint8Array(await res.arrayBuffer()) : null };
    }

    // A browser that preflights Range can't send it to GitHub (no OPTIONS there), so that one gets the whole file.
    async function getPart(url, from, size, cache) {
        try {
            return await get(url, { cache, headers: { Range: "bytes=" + from + "-" + (from + size - 1) } });
        } catch (e) {
            return get(url, { cache });
        }
    }

    // A JSON array of objects, handed over a piece at a time: returns the objects each piece completes.
    function objectReader() {
        const decoder = new TextDecoder();
        let part = "";
        let depth = 0;
        let quoted = false;
        let escaped = false;
        return bytes => {
            const text = part + decoder.decode(bytes, { stream: true });
            const out = [];
            let start = part ? 0 : -1;
            for (let i = part.length; i < text.length; i++) {
                const c = text[i];
                if (quoted) {
                    if (escaped) escaped = false;
                    else if (c === "\\") escaped = true;
                    else if (c === '"') quoted = false;
                } else if (c === '"') quoted = true;
                else if (c === "{") {
                    if (depth++ === 0) start = i;
                } else if (c === "}" && depth > 0 && --depth === 0) {
                    try {
                        out.push(JSON.parse(text.slice(start, i + 1)));
                    } catch (e) {}
                    start = -1;
                }
            }
            part = start >= 0 ? text.slice(start) : "";
            return out;
        };
    }

    // A changelog.json, read from the top only as far as it's asked for.
    class LogFile {
        constructor(kind, size) {
            this.kind = kind;
            this.size = size;
            this.url = null;
            this.stamp = null;
            this.offset = 0;
            this.parse = objectReader();
            this.waiting = [];
            this.top = null;
            this.last = null;
            this.count = 0;
            this.done = false;
        }

        accept(objects) {
            for (const e of objects) {
                if (!this.kind.valid(e)) continue;
                this.waiting.push(e);
                this.top ??= e;
                this.last = e;
                this.count++;
            }
        }

        async read() {
            let part = null;
            // The mirror only when github.io can't be reached at all, not when it answers.
            for (const url of this.url ? [this.url] : this.kind.urls()) {
                try {
                    part = await getPart(url, this.offset, this.size, "no-store");
                    this.url = url;
                    break;
                } catch (e) {}
            }
            if (part?.status === 416 && this.offset) {
                this.done = true;
                return;
            }
            if (!part?.bytes) {
                if (this.kind.optional && !this.offset) {
                    this.done = true;
                    return;
                }
                throw new Error("changelog " + (part ? part.status : "unreachable"));
            }
            const changed = this.offset > 0 && part.stamp !== this.stamp;
            if (part.status === 206 && !changed) {
                this.stamp = part.stamp;
                this.accept(this.parse(part.bytes));
                this.offset += part.bytes.length;
                if (part.bytes.length < this.size) this.done = true;
                return;
            }
            // The whole file: the server ignored Range, or a deploy moved the bytes since the last read.
            if (part.status === 206) part = await get(this.url, { cache: "no-store" });
            if (!part.bytes) throw new Error("changelog " + part.status);
            let all = objectReader()(part.bytes).filter(this.kind.valid);
            if (this.last) {
                const id = this.kind.id(this.last);
                const at = all.findIndex(e => this.kind.id(e) === id);
                all = all.slice(at >= 0 ? at + 1 : this.count);
            }
            this.accept(all);
            this.done = true;
        }

        async take(count) {
            while (!this.done && this.waiting.length < count) await this.read();
            return this.waiting.splice(0, count);
        }
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

    // Pages deploys of main from `before` (or now) back, newest first. A date instead of a deep page number, since the
    // API answers no further than 1,000 filtered runs, and only as many as asked for, since each is about 15 KB.
    // onPage returns true to stop. Resolves true when it saw every deploy it needed.
    async function deploys(repo, query, before, wanted, onPage) {
        const size = Math.min(100, wanted + 10);
        const until = before ? "&created=" + encodeURIComponent("<=" + new Date(before).toISOString().slice(0, 19) + "Z") : "";
        const api = "https://api.github.com/repos/" + repo + "/actions/runs?branch=main" + query + until + "&per_page=" + size + "&page=";
        for (let page = 1; page <= MAX_PAGES; page++) {
            const res = await fetch(api + page);
            if (!res.ok) return false;
            const runs = (await res.json()).workflow_runs || [];
            const list = runs.map(r => ({ sha: r.head_sha || "", ok: r.conclusion === "success", msg: r.head_commit?.message || r.display_title, at: Date.parse(r.updated_at) })).filter(r => r.at > 0);
            if ((await onPage(list)) || runs.length < size) return true;
        }
        return false;
    }

    // A version went live with the first deploy of it or anything newer (one fork sync can carry several versions).
    // A time counts only once an older deploy has been seen, and is then kept for good.
    async function releaseTimes(want, before) {
        const keyed = want.map(e => ({ v: e.version, key: versionKey(e.version) })).filter(w => w.key);
        if (!keyed.length) return {};
        const oldest = keyed.reduce((a, w) => (compare(w.key, a) < 0 ? w.key : a), keyed[0].key);
        const found = {};
        const final = {};
        const complete = await deploys(REPO, "&status=success", before, keyed.length, runs => {
            let done = false;
            for (const run of runs) {
                const key = versionKey(run.msg);
                if (!key) continue;
                for (const w of keyed) {
                    if (compare(key, w.key) >= 0) found[w.v] = run.at;
                    else if (w.v in found) final[w.v] = found[w.v];
                }
                if (compare(key, oldest) < 0) done = true;
            }
            return done;
        });
        const times = complete ? found : final;
        keep(TIMES_KEY + REPO, times);
        return Object.fromEntries(Object.entries(times).map(([v, at]) => [v, { at }]));
    }

    // A commit's files don't change, so each is asked for once. Only the top is read: both numbers looked for are there.
    const numbers = new Map();
    function numberAtTop(sha, file, name) {
        const path = sha + "/" + file;
        if (!numbers.has(path)) {
            const number = getPart("https://raw.githubusercontent.com/" + BE_REPO + "/" + path, 0, 256, "default").then(part => {
                if (part.status === 404) return 0;
                if (!part.bytes) throw new Error(path + " " + part.status);
                return Number(new RegExp('"' + name + '"\\s*:\\s*(\\d+)').exec(new TextDecoder().decode(part.bytes))?.[1]) || 0;
            });
            number.catch(() => numbers.delete(path));
            numbers.set(path, number);
        }
        return numbers.get(path);
    }

    // "34.5": physics 34, the fifth update on it. A string, since 34.10 comes after 34.9.
    function beVersion(e) {
        return typeof e.version === "string" && /^\d+\.\d+$/.test(e.version) ? e.version : null;
    }

    // A Better Editor entry went live with the first deploy whose changelog.json has its id (ids only go up).
    // Entries written after the fact name their commit instead; a deploy cancelled by the next push went live with that one.
    // An entry without a version of its own shows physics.json's as of that deploy.
    async function beReleases(want, before) {
        const maxId = run => numberAtTop(run.sha, "changelog.json", "id");
        const named = want.filter(e => typeof e.commit === "string" && /^[0-9a-f]{7,40}$/.test(e.commit));
        const byId = want.filter(e => !named.includes(e));
        const lowest = Math.min(...byId.map(e => e.id));
        const all = [];
        const complete = await deploys(BE_REPO, "", before, want.length, async list => {
            all.push(...list);
            if (!list.length || list[list.length - 1].at < BE_LOG_START) return true;
            if (!named.every(e => all.some(r => r.sha.startsWith(e.commit)))) return false;
            if (!byId.length) return true;
            const oldest = list.filter(r => r.ok).pop();
            return !!oldest && (await maxId(oldest)) < lowest;
        });
        const runs = all.filter(r => r.ok);
        if (!runs.length) return {};
        const found = {};
        const final = {};
        await Promise.all(want.map(async e => {
            try {
                let run = null;
                const at = named.includes(e) ? all.findIndex(r => r.sha.startsWith(e.commit)) : -1;
                if (at >= 0) {
                    run = all.slice(0, at + 1).reverse().find(r => r.ok);
                    if (!run) return;
                } else {
                    if ((await maxId(runs[0])) < e.id) return;
                    // Runs are newest first, so the oldest deploy that has the id is the last index that has it.
                    let lo = 0;
                    let hi = runs.length - 1;
                    while (lo < hi) {
                        const mid = (lo + hi + 1) >> 1;
                        if ((await maxId(runs[mid])) >= e.id) lo = mid;
                        else hi = mid - 1;
                    }
                    if (lo === runs.length - 1 && !complete) return;
                    run = runs[lo];
                }
                found[e.id] = { at: run.at };
                if (!beVersion(e)) {
                    const version = await numberAtTop(run.sha, "physics.json", "version");
                    if (!version) return;
                    found[e.id].version = version;
                }
                final[e.id] = found[e.id];
            } catch (err) {}
        }));
        keep(BE_DEPLOYS_KEY, final);
        return found;
    }

    const NSWS = {
        urls: () => [new URL("changelog.json", location.href).href],
        valid: e => e && typeof e.version === "string" && Array.isArray(e.changes),
        id: e => e.version,
        known: () => Object.fromEntries(Object.entries(cached(TIMES_KEY + REPO)).map(([v, at]) => [v, { at }])),
        find: releaseTimes,
        title: e => e.version,
        cls: "ver",
    };

    const BE = {
        optional: true,
        urls: () => {
            // Same local override as the page's Better Editor files, for testing a local copy.
            if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
                const own = getItem("nswsBEBase");
                if (own && /^https?:\/\/\S+$/.test(own)) return [own.replace(/\/?$/, "/") + "changelog.json"];
            }
            return [BE_SITE + "changelog.json", BE_MIRROR + "changelog.json"];
        },
        valid: e => e && Number.isSafeInteger(e.id) && e.id > 0 && Array.isArray(e.changes),
        id: e => e.id,
        known: () => cached(BE_DEPLOYS_KEY),
        find: beReleases,
        title: (e, release) => {
            const version = beVersion(e) || release?.version;
            return version ? "Better Editor v" + version : "Better Editor";
        },
        cls: "ver be",
    };

    // One changelog as a queue with release times, refilled a batch at a time.
    class Feed {
        constructor(kind) {
            this.kind = kind;
            this.file = new LogFile(kind, READ_BYTES);
            this.queue = [];
            this.batch = FIRST_LOOKUP;
            this.above = 0;
            // Resolves to the time of the last entry looked up, where the next lookup starts.
            this.bookmark = Promise.resolve(0);
        }

        async fill() {
            if (this.queue.length) return;
            const list = await this.file.take(this.batch);
            if (!list.length) return;
            const { kind } = this;
            const known = kind.known();
            const items = list.map(entry => ({ kind, entry, release: known[kind.id(entry)] }));
            const looked = this.bookmark.then(async before => {
                const first = items.findIndex(item => !item.release);
                if (first >= 0) {
                    for (const item of items.slice(0, first)) before = item.release.at;
                    const want = items.filter(item => !item.release);
                    const found = await kind.find(want.map(item => item.entry), before).catch(() => ({}));
                    for (const item of want) {
                        item.release = found[kind.id(item.entry)];
                        item.draw?.();
                    }
                }
                for (const item of items) if (item.release) before = item.release.at;
                return before;
            });
            this.bookmark = looked;
            // The order between the two lists needs the times, so wait for them a little. Later ones only fill in the
            // stamps; the list doesn't move under the reader.
            if (items.some(item => !item.release)) await Promise.race([looked, new Promise(ok => setTimeout(ok, WAIT_FOR_TIMES_MS))]);
            this.queue.push(...items);
        }

        // An entry without a time keeps its place in its own list: it goes by the next older time, else the one above.
        time() {
            return this.queue.find(item => item.release)?.release.at || this.above;
        }

        shift() {
            const item = this.queue.shift();
            if (item.release) this.above = item.release.at;
            return item;
        }
    }

    function entryNodes(item) {
        const { kind, entry } = item;
        const ver = el("div", kind.cls);
        const title = document.createTextNode("");
        const stamp = el("span");
        ver.append(title, stamp);
        item.draw = () => {
            title.data = kind.title(entry, item.release);
            stamp.textContent = item.release ? STAMP.format(new Date(item.release.at)) : "";
        };
        item.draw();
        const list = el("ul");
        for (const line of entry.changes) list.appendChild(el("li", null, String(line)));
        return [ver, list];
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
        const status = el("div", "msg", "Loading...");
        body.appendChild(status);
        box.append(top, body);
        overlay.appendChild(box);
        overlay.addEventListener("pointerdown", e => {
            if (e.target === overlay) close();
        });
        for (const type of ["keydown", "keyup", "keypress"]) overlay.addEventListener(type, e => e.stopPropagation());
        document.body.appendChild(overlay);
        window.addEventListener("keydown", onKey, true);

        const view = overlay;
        const ours = new Feed(NSWS);
        const be = new Feed(BE);
        let shown = 0;
        let busy = false;
        let finished = false;

        async function addBatch() {
            for (let i = 0; i < ROWS; i++) {
                // Both settled before an error counts, so a retry never overlaps a read.
                const failed = (await Promise.allSettled([ours.fill(), be.fill()])).find(r => r.status === "rejected");
                if (failed) throw failed.reason;
                if (overlay !== view) return;
                const a = ours.queue.length > 0;
                const b = be.queue.length > 0;
                if (!a && !b) {
                    finished = true;
                    return;
                }
                const ta = a && ours.time();
                const tb = b && be.time();
                const feed = !b || (a && (!ta || !tb || ta >= tb)) ? ours : be;
                for (const node of entryNodes(feed.shift())) body.insertBefore(node, status);
                if (shown++) continue;
                latest = ours.file.top?.version || latest;
                beLatest = be.file.top?.id || beLatest;
                markSeen();
            }
        }

        async function more() {
            if (busy || finished) return;
            busy = true;
            status.textContent = "Loading...";
            try {
                while (!finished && overlay === view && body.scrollTop + body.clientHeight > body.scrollHeight - LOAD_AHEAD_PX) await addBatch();
                ours.batch = be.batch = LOOKUP;
                if (!finished) status.textContent = "";
                else if (shown) status.remove();
                else status.textContent = "Nothing here yet.";
            } catch (e) {
                status.textContent = shown ? "Couldn't load older updates. Scroll to try again." : "Couldn't load the changelog.";
            }
            busy = false;
        }

        body.addEventListener("scroll", () => {
            if (body.scrollTop + body.clientHeight > body.scrollHeight - LOAD_AHEAD_PX) more();
        }, { passive: true });
        more();
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

    // The newest entries, for the update popup.
    async function newest() {
        const file = new LogFile(NSWS, READ_BYTES);
        const log = await file.take(NEWEST);
        return { log, complete: file.done && !file.waiting.length };
    }

    async function checkForNew() {
        const ours = new LogFile(NSWS, TOP_BYTES);
        const be = new LogFile(BE, TOP_BYTES);
        await Promise.allSettled([ours.take(1), be.take(1)]);
        latest = ours.top?.version || latest;
        beLatest = be.top?.id || beLatest;
        paint();
    }

    window.__nswsChangelog = { open, mountButton, newest };
    checkForNew();
})();
