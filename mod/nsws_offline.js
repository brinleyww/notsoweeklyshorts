// Bad days. The proxy runs on Cloudflare's free plan; when its daily Durable Object limits run out,
// it answers chat, uploads and accounts with {error:"busy", retry, until} (proxy/src/worker.js busy())
// until about 00:15 UTC. If the Worker itself is out of requests, nothing answers at all.
// window.__nswsBusy remembers when things come back and tells the player once.
// window.__nswsUploadQueue sends PBs that couldn't be uploaded once the server is back.
// window.__nswsBoardCache shows a saved copy of a leaderboard the server can't send.
(function () {
    const BUSY_KEY = "_nswsBusyUntil";
    const BUSY_SEEN_KEY = "_nswsBusyToldUntil";
    const QUEUE_KEY = "_nswsUploadQueue";
    const QUEUE_LOCK_KEY = "_nswsUploadQueueLock";
    const QUEUE_MAX_AGE_MS = 7 * 86_400_000;
    const QUEUE_LOCK_MS = 90_000;
    const QUEUE_TICK_MS = 30_000;
    const QUEUE_RETRY_MS = 2 * 60_000;
    const QUEUE_RETRY_MAX_MS = 20 * 60_000;
    // While busy, one queued upload still goes every so often in case the limit lifted early.
    const QUEUE_BUSY_PROBE_MS = 10 * 60_000;
    // Saved boards live in Cache Storage, not localStorage, which holds the game's own records.
    const BOARD_CACHE = "nsws-boards";
    const BOARD_MAX = 60;
    const BOARD_MAX_CHARS = 300_000;
    const TOAST_GAP_MS = 60_000;

    function get(key) {
        try {
            return localStorage.getItem(key);
        } catch {
            return null;
        }
    }

    function set(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch {}
    }

    let toastEl = null;
    let toastTimer = null;
    const toastAt = new Map();

    // Same look as the anti-cheat notice in nsws_traffic.js. A kind shows at most once a minute.
    function toast(text, kind, ms = 9000) {
        if (kind) {
            if (Date.now() - (toastAt.get(kind) ?? 0) < TOAST_GAP_MS) return;
            toastAt.set(kind, Date.now());
        }
        if (!document.body) return;
        toastEl?.remove();
        clearTimeout(toastTimer);
        const note = document.createElement("div");
        note.textContent = text;
        note.style.cssText = "position:fixed;left:50%;bottom:72px;transform:translateX(-50%);z-index:10003;" +
            "background:var(--surface-color,#28346a);color:#fff;padding:12px 22px;font-size:18px;max-width:min(720px,90vw);" +
            "text-align:center;clip-path:polygon(8px 0,100% 0,calc(100% - 8px) 100%,0 100%);" +
            "box-shadow:0 8px 24px rgba(0,0,0,.4);pointer-events:none;";
        document.body.appendChild(note);
        toastEl = note;
        toastTimer = setTimeout(() => note.remove(), ms);
    }

    function busyUntil() {
        const until = Number(get(BUSY_KEY));
        return until > Date.now() ? until : 0;
    }

    function wait(ms) {
        const minutes = Math.max(1, Math.round(ms / 60_000));
        if (minutes < 60) return minutes + " min";
        const h = Math.floor(minutes / 60);
        const m = minutes % 60;
        return m ? h + " h " + m + " min" : h + " h";
    }

    // "about 2:15 AM (in 3 h 10 min)"
    function label(until = busyUntil()) {
        if (!until) return "soon";
        const at = new Date(until).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        return "about " + at + " (in " + wait(until - Date.now()) + ")";
    }

    function note(until, retry) {
        let at = Number(until);
        if (!(at > Date.now())) at = Date.now() + (Number(retry) > 0 ? Number(retry) * 1000 : 600_000);
        // The reset is the same moment for everyone; keep the latest estimate.
        const changed = at > Number(get(BUSY_KEY) || 0) || !busyUntil();
        if (changed) set(BUSY_KEY, String(at));
        window.dispatchEvent(new CustomEvent("nsws-busy", { detail: { until: busyUntil() } }));
        if (Number(get(BUSY_SEEN_KEY)) === busyUntil()) return;
        set(BUSY_SEEN_KEY, String(busyUntil()));
        toast("The NSWS server has hit its free daily limit. Chat and uploads are paused until " + label() +
            ". Leaderboards still work, and your runs are saved and upload by themselves.", "busy", 14000);
    }

    function readBusy(text) {
        try {
            const data = JSON.parse(text);
            return data?.error === "busy" ? data : null;
        } catch {
            return null;
        }
    }

    // Any normal reply from the server means the limit has lifted, whatever the estimate said.
    function clear() {
        if (!busyUntil()) return;
        set(BUSY_KEY, "0");
        window.dispatchEvent(new CustomEvent("nsws-busy", { detail: { until: 0 } }));
    }

    window.__nswsBusy = {
        active: () => busyUntil() > 0,
        until: busyUntil,
        label,
        note,
        clear,
        toast,
        // A failed XHR or fetch: notes a busy reply and returns it (null for any other failure).
        fromXhr(xhr) {
            const data = xhr?.status === 503 ? readBusy(xhr.responseText) : null;
            if (data) note(data.until, data.retry);
            return data;
        },
        async fromResponse(response) {
            if (response?.status !== 503) return null;
            const data = readBusy(await response.clone().text().catch(() => ""));
            if (data) note(data.until, data.retry);
            return data;
        },
        fromData(data) {
            if (data?.error === "busy" || data?.busy) note(data.until, data.retry);
        },
    };

    // The game saves a PB on this device before uploading it (setRecord in main.bundle.js). One that
    // failed to upload waits here, by profile slot and track, and goes through the game's own
    // syncRecord once the server is back.

    function readQueue() {
        try {
            const list = JSON.parse(get(QUEUE_KEY));
            return Array.isArray(list) ? list.filter((q) => q && typeof q.t === "string" && Number.isSafeInteger(q.s)) : [];
        } catch {
            return [];
        }
    }

    function writeQueue(list) {
        set(QUEUE_KEY, JSON.stringify(list));
    }

    let fails = 0;
    let nextTry = 0;
    let lastProbe = 0;
    let flushing = false;

    function lock() {
        const held = Number(get(QUEUE_LOCK_KEY));
        if (held > Date.now()) return false;
        set(QUEUE_LOCK_KEY, String(Date.now() + QUEUE_LOCK_MS));
        return true;
    }

    async function flush() {
        const records = window.__nswsRecords;
        if (flushing || !records || document.visibilityState === "hidden") return;
        if (Date.now() < nextTry || !readQueue().length) return;
        const probe = busyUntil() > 0;
        if (probe && Date.now() - lastProbe < QUEUE_BUSY_PROBE_MS) return;
        if (!lock()) return;
        if (probe) lastProbe = Date.now();
        flushing = true;
        let failed = false;
        try {
            for (const item of readQueue()) {
                const drop = () => writeQueue(readQueue().filter((q) => !(q.s === item.s && q.t === item.t)));
                const record = records.getRecord(item.s, item.t);
                if (!record || record.uploadId != null || Date.now() - item.at > QUEUE_MAX_AGE_MS) {
                    drop();
                    continue;
                }
                try {
                    // "Upload" once the run reached the server; null while the game isn't ready to send.
                    if ((await records.syncRecord(item.s, item.t, null)) === "Upload") {
                        drop();
                        clear();
                    }
                } catch (err) {
                    if (!err?.nswsRetry) {
                        drop();
                        continue;
                    }
                    failed = !busyUntil();
                    break;
                }
            }
        } finally {
            flushing = false;
            set(QUEUE_LOCK_KEY, "0");
        }
        fails = failed ? fails + 1 : 0;
        nextTry = failed ? Date.now() + Math.min(QUEUE_RETRY_MS * 2 ** (fails - 1), QUEUE_RETRY_MAX_MS) : 0;
    }

    window.__nswsUploadQueue = {
        add(slot, trackId) {
            if (!Number.isSafeInteger(slot) || typeof trackId !== "string") return;
            const list = readQueue().filter((q) => !(q.s === slot && q.t === trackId));
            list.push({ s: slot, t: trackId, at: Date.now() });
            writeQueue(list.slice(-50));
            nextTry = Math.max(nextTry, Date.now() + QUEUE_RETRY_MS);
            if (busyUntil()) {
                toast("Uploads are paused until " + label() + ". This run is saved and will upload by itself.", "queued");
            } else {
                toast("Couldn't reach the server, so this run is saved and will upload by itself once it can.", "queued");
            }
        },
        pending: () => readQueue().length,
        flush,
    };

    setInterval(flush, QUEUE_TICK_MS);
    window.addEventListener("nsws-busy", (e) => {
        if (e.detail?.until) return;
        fails = 0;
        nextTry = 0;
        setTimeout(flush, 5000);
    });
    document.addEventListener("visibilitychange", () => setTimeout(flush, 3000));
    setTimeout(flush, 15_000);

    // Every board the game loads is kept, keyed by its URL without the player's token hash. When the
    // server can't send one, the saved copy shows instead.

    function boardKey(url) {
        try {
            const u = new URL(url, location.href);
            u.searchParams.delete("userTokenHash");
            u.searchParams.delete("userToken");
            u.searchParams.sort();
            return "https://boards.nsws/" + u.pathname.replace(/^\/+/, "") + "?" + u.searchParams.toString();
        } catch {
            return null;
        }
    }

    function openBoards() {
        return window.caches ? caches.open(BOARD_CACHE).catch(() => null) : Promise.resolve(null);
    }

    let trimming = false;

    async function trim(cache) {
        if (trimming) return;
        trimming = true;
        try {
            const keys = await cache.keys();
            if (keys.length <= BOARD_MAX) return;
            const dated = await Promise.all(keys.map(async (k) => [k, Number((await cache.match(k))?.headers.get("x-at")) || 0]));
            dated.sort((a, b) => a[1] - b[1]);
            for (const [k] of dated.slice(0, keys.length - BOARD_MAX)) await cache.delete(k);
        } catch {
        } finally {
            trimming = false;
        }
    }

    function put(url, text) {
        const key = boardKey(url);
        if (!key || typeof text !== "string" || text.length > BOARD_MAX_CHARS) return;
        openBoards().then(async (cache) => {
            if (!cache) return;
            await cache.put(key, new Response(text, { headers: { "Content-Type": "application/json", "x-at": String(Date.now()) } }));
            trim(cache);
        }).catch(() => {});
    }

    async function saved(url) {
        const key = boardKey(url);
        const cache = key && (await openBoards());
        const hit = cache && (await cache.match(key).catch(() => null));
        if (!hit) return null;
        return { text: await hit.text(), at: Number(hit.headers.get("x-at")) || 0 };
    }

    function tellSaved(at) {
        if (busyUntil()) return;
        const when = at ? new Date(at).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : "earlier";
        toast("Couldn't reach the leaderboard server. Showing a saved copy from " + when + ".", "saved-board");
    }

    window.__nswsBoardCache = {
        put,
        // For the game's XHRs: notes a busy reply, then returns the saved text, or null.
        async fallback(url, xhr) {
            window.__nswsBusy.fromXhr(xhr);
            const hit = await saved(url).catch(() => null);
            if (hit) tellSaved(hit.at);
            return hit?.text ?? null;
        },
        // fetch(url).json(), keeping a copy (passed through shrink first) for when it fails.
        async fetchJson(url, shrink) {
            try {
                const response = await fetch(url);
                if (!response.ok) {
                    await window.__nswsBusy.fromResponse(response);
                    throw new Error("HTTP " + response.status);
                }
                const data = await response.json();
                put(url, JSON.stringify(shrink ? shrink(data) : data));
                return data;
            } catch (err) {
                const hit = await saved(url).catch(() => null);
                if (!hit) throw err;
                tellSaved(hit.at);
                return JSON.parse(hit.text);
            }
        },
    };
})();
