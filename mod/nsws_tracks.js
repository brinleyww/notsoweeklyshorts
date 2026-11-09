// Custom Tracks: the player's own track library (IndexedDB), importing and exporting (plain codes,
// NSWS pack codes and short links), per-track modes for the physics worker, and the native-styled
// UI helpers that clubs, the editor, Cuppa and Race Control share.
(function () {
    "use strict";

    const DB_NAME = "nsws-tracks";
    const STORE = "tracks";
    const PACK_PREFIX = "NSWSPack1";
    const BE_PREFIX = "PolyTrackBE1";
    const MAX_PACK_TRACKS = 50;
    const IMAGE_MAX = 20000;
    const validImage = (v) => (typeof v === "string" && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(v) && v.length <= IMAGE_MAX ? v : null);
    const TRACK_ID = /^[0-9a-f]{64}$/;
    const MAX_PACK_BYTES = 4 * 1024 * 1024;
    const MAX_IMPORT = 200;
    const CLUB_CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;
    const LINK_ID = /^[0-9A-Za-z]{10}$/;
    const TOKEN = /^[0-9a-f]{64}$/;
    const ENVS = ["Summer", "Winter", "Desert"];
    const MODES = [
        { id: "normal", label: "Normal", help: "Stock PolyTrack physics." },
        { id: "rocket", label: "Rocket League", help: "Rocket League physics: jump, boost and flip." },
        { id: "royale", label: "Royale", help: "Every checkpoint number has two gates. After you cross one, a reset puts you at the other gate of that number, the start of the next section." },
    ];
    const MODE_LABEL = { normal: "Normal", rocket: "Rocket League", royale: "Royale" };

    const normMode = (m) => (m === "rocket" || m === "royale" ? m : "normal");
    const clean = (code) => (typeof code === "string" ? code.replace(/\s+/g, "") : "");

    // Track modes. Built-in week ids live in the worker; these are added on top of them, and only
    // for the track being played or raced.
    const modeRegistry = new Map();
    const clearedModes = new Set();
    const simWorkers = new Set();

    function modesMessage(worker) {
        const rocket = [];
        const royale = [];
        for (const [id, mode] of modeRegistry) (mode === "rocket" ? rocket : royale).push(id);
        const nswsModes = { rocket, royale };
        // Ids set back to Normal; a worker that can't remove ids just ignores this list.
        if (clearedModes.size) nswsModes.normal = [...clearedModes];
        // Where the worker loads Better Editor's blocks from, when a track with them arrives.
        return { nswsModes, nswsTMBase: worker?.nswsTMBase || window.__nswsTM?.base };
    }

    const NativeWorker = window.Worker;
    if (typeof NativeWorker === "function") {
        class NswsWorker extends NativeWorker {
            constructor(url, options) {
                super(url, options);
                if (/simulation_worker/.test(String(url))) {
                    this.nswsTMBase = window.__nswsSimBase || null;
                    simWorkers.add(this);
                    try {
                        const message = modesMessage(this);
                        this.postMessage(message);
                        this.__ntBase = message.nswsTMBase;
                    } catch {}
                }
            }
            terminate() {
                simWorkers.delete(this);
                return super.terminate();
            }
        }
        window.Worker = NswsWorker;
    }

    function weekTrack(id) {
        for (const w of window.__nswsWeeks || []) {
            for (const p of w.parts || [w]) {
                for (const t of p.tracks || []) if (t.id === id || t.contentId === id) return true;
            }
        }
        return false;
    }

    // Week, official and community ids never take a custom mode: the same id races on their leaderboards.
    function isKnown(id) {
        if (weekTrack(id)) return true;
        let cat = null;
        try {
            cat = window.__bw_trackCategory?.(id) ?? null;
        } catch {}
        return cat != null && cat !== "custom";
    }

    function registerModes(list) {
        let changed = false;
        for (const item of Array.isArray(list) ? list : [list]) {
            const id = item?.trackId;
            if (typeof id !== "string" || !id || isKnown(id)) continue;
            const mode = normMode(item.mode);
            if (mode === "normal") {
                if (modeRegistry.delete(id)) {
                    clearedModes.add(id);
                    changed = true;
                }
            } else if (modeRegistry.get(id) !== mode) {
                modeRegistry.set(id, mode);
                clearedModes.delete(id);
                changed = true;
            }
        }
        // The block base moves to the Worker mirror when github.io fails, after the game's workers were made.
        for (const w of simWorkers) {
            const message = modesMessage(w);
            if (!changed && w.__ntBase === message.nswsTMBase) continue;
            try {
                w.postMessage(message);
                w.__ntBase = message.nswsTMBase;
            } catch {}
        }
        if (changed) window.dispatchEvent(new CustomEvent("nsws-track-modes"));
    }

    function modeOf(trackId) {
        return modeRegistry.get(trackId) || "normal";
    }

    // The game's Base62 (bit-packed, not positional). Used only if main.bundle.js has no hook.
    const B62 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const fallbackBase62 = {
        decode(text) {
            let bit = 0;
            const out = [];
            const n = text.length;
            for (let i = 0; i < n; i++) {
                const v = B62.indexOf(text[i]);
                if (v < 0) return null;
                const width = (v & 30) === 30 ? 5 : 6;
                const byte = bit >> 3;
                while (byte >= out.length) out.push(0);
                const shift = bit - 8 * byte;
                out[byte] |= (v << shift) & 255;
                if (shift > 8 - width && i !== n - 1) {
                    if (byte + 1 >= out.length) out.push(0);
                    out[byte + 1] |= v >> (8 - shift);
                }
                bit += width;
            }
            return new Uint8Array(out);
        },
    };
    const base62 = () => window.__nswsTrackHooks?.base62 || fallbackBase62;

    // Shared codes are untrusted, so inflating stops at `limit` bytes: it throws, or with `cut` returns the start.
    async function pipeBytes(bytes, stream, limit = Infinity, cut = false) {
        const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
        const parts = [];
        let total = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            parts.push(value);
            total += value.byteLength;
            if (total > limit) {
                reader.cancel().catch(() => {});
                if (!cut) throw new Error("too big");
                break;
            }
        }
        const out = new Uint8Array(total);
        let at = 0;
        for (const p of parts) {
            out.set(p, at);
            at += p.byteLength;
        }
        return cut && total > limit ? out.subarray(0, limit) : out;
    }
    const inflate = (b, limit, cut) => pipeBytes(b, new DecompressionStream("deflate"), limit, cut);
    const inflateRaw = (b, limit) => pipeBytes(b, new DecompressionStream("deflate-raw"), limit);
    const deflateRaw = (b) => pipeBytes(b, new CompressionStream("deflate-raw"));
    const utf8 = (b) => new TextDecoder().decode(b);

    function toB64url(bytes) {
        let s = "";
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }

    function fromB64url(text) {
        const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
        const out = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
        return out;
    }

    async function sha256(text) {
        const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
        return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
    }

    // Parsing. A stock parse decompresses the whole track, so results are cached by code.
    const infoCache = new Map();
    function remember(code, info) {
        if (infoCache.size > 200) infoCache.delete(infoCache.keys().next().value);
        infoCache.set(code, info);
        return info;
    }

    const failed = (code, error) => ({ ok: false, kind: null, code, name: null, author: null, trackId: null, env: null, error });

    // parse() and add() reuse the last result; play() asks for a fresh one because the game keeps
    // the objects it is handed.
    let lastStock = null;
    function stockParse(code, fresh) {
        if (!fresh && lastStock?.code === code) return lastStock.loaded;
        const hook = window.__nswsTrackHooks?.parse;
        if (!hook) return { error: "The game is still loading. Try again in a moment." };
        let result = null;
        try {
            result = hook(code);
        } catch {}
        const loaded = result?.trackData ? { meta: result.trackMetadata, data: result.trackData } : { error: "That isn't a track code PolyTrack can read." };
        if (!fresh) lastStock = { code, loaded };
        return loaded;
    }

    function parse(code) {
        code = clean(code);
        if (!code) return failed(code, "There's no code there.");
        const be = code.startsWith(BE_PREFIX);
        const cached = infoCache.get(code);
        if (cached && !(be && beReady() && cached.ok && !cached.trackId)) return cached;
        if (be && !beReady()) return { ok: true, kind: "be", code, name: null, author: null, trackId: null, env: null };
        if (code.startsWith(PACK_PREFIX)) return failed(code, "That's an NSWS Track code. Paste it into Import on NSWS.");
        const loaded = stockParse(code);
        if (loaded.error && be && !loaded.error.startsWith("The game")) return remember(code, failed(code, "That Better Editor code is damaged or cut short."));
        if (loaded.error) return loaded.error.startsWith("The game") ? failed(code, loaded.error) : remember(code, failed(code, loaded.error));
        let trackId = null;
        try {
            trackId = loaded.data.getId();
        } catch {}
        const env = ENVS[loaded.data.environment] ?? null;
        const name = String(loaded.meta?.name ?? "").trim() || "Untitled track";
        const author = loaded.meta?.author ? String(loaded.meta.author) : null;
        return remember(code, { ok: true, kind: be ? "be" : "stock", code, name, author, trackId, env });
    }

    const beReady = () => !!window.__nswsTM?.ready();

    // Loads Better Editor's blocks (about 65 MB the first time, then from the browser's cache) with a dialog
    // while it takes. False when the player cancelled; throws when they couldn't load.
    const mb = (n) => (n / 1048576).toFixed(n < 10485760 ? 1 : 0);
    // Counts the bytes of the block file while TM.load() downloads it, for a real loading bar.
    function watchBlocks(onProgress) {
        const real = window.fetch;
        const mine = function (input, init) {
            const url = typeof input === "string" ? input : input?.url || "";
            const p = real.apply(window, arguments);
            if (!/tm_blocks\.bin(\?|$)/.test(url)) return p;
            return p.then((r) => {
                if (!r.ok || !r.body) return r;
                const total = Number(self.TM_DATA?.binBytes) || Number(r.headers.get("content-length")) || 0;
                const reader = r.body.getReader();
                let got = 0;
                onProgress(0, total);
                const stream = new ReadableStream({
                    async pull(c) {
                        const { done, value } = await reader.read();
                        if (done) return c.close();
                        got += value.byteLength;
                        onProgress(got, total);
                        c.enqueue(value);
                    },
                    cancel: (e) => reader.cancel(e),
                });
                return new Response(stream, { status: r.status, statusText: r.statusText, headers: r.headers });
            });
        };
        window.fetch = mine;
        return () => {
            if (window.fetch === mine) window.fetch = real;
        };
    }

    // One download at a time (a second fetch wrapper would outlive the first and stay on window.fetch). Cancel
    // answers false at once; the download goes on in the background.
    let beLoad = null;
    const beProgress = new Set();
    function ensureBE() {
        const tm = window.__nswsTM;
        if (!tm) return Promise.reject(new Error("This copy of the site can't load Better Editor blocks."));
        if (tm.ready()) return Promise.resolve(true);
        if (!beLoad) {
            const unwatch = watchBlocks((got, total) => {
                for (const fn of [...beProgress]) fn(got, total);
            });
            beLoad = Promise.resolve()
                .then(() => tm.ensure())
                .finally(() => {
                    unwatch();
                    beLoad = null;
                });
            beLoad.then(() => setTimeout(() => refreshThumbs().catch(() => {}), 0), () => {});
        }
        const load = beLoad;
        const body = el("div");
        const bar = el("div", "nt-pbar busy");
        const fill = el("div");
        bar.appendChild(fill);
        const sub = el("p", "nt-text dim", "Starting...");
        body.append(el("p", "nt-text", "Loading Better Editor blocks. The first time this downloads about 65 MB."), bar, sub);
        const show = (got, total) => {
            bar.classList.toggle("busy", !total);
            if (total) fill.style.width = Math.min(100, (got / total) * 100).toFixed(1) + "%";
            sub.textContent = total && got >= total ? "Building the blocks..." : mb(got) + (total ? " of " + mb(total) : "") + " MB";
        };
        beProgress.add(show);
        let close = null;
        const cancelled = new Promise((resolve) => {
            close = dialog({
                title: "Better Editor track",
                body,
                actions: [{ label: "Cancel" }],
                onClose: () => {
                    beProgress.delete(show);
                    resolve(false);
                },
            });
        });
        return Promise.race([load.then(() => true), cancelled]).finally(() => close());
    }

    async function preloadPhysics(base, version) {
        const ctrl = new AbortController();
        let cancelled = false;
        let finished = false;
        const body = el("div");
        const bar = el("div", "nt-pbar busy");
        const fill = el("div");
        bar.appendChild(fill);
        const sub = el("p", "nt-text dim", "Starting...");
        body.append(el("p", "nt-text", "Loading Better Editor physics v" + version + ". The first replay on it downloads its blocks (about 70 MB)."), bar, sub);
        const close = dialog({
            title: "Old physics",
            body,
            actions: [{ label: "Cancel" }],
            onClose: () => {
                if (finished) return;
                cancelled = true;
                ctrl.abort();
            },
        });
        try {
            for (const f of ["tm_parts.js", "tm_runtime.js"]) {
                const r = await fetch(base + f, { signal: ctrl.signal });
                if (!r.ok) throw new Error(f + ": " + r.status);
                await r.arrayBuffer();
            }
            const r = await fetch(base + "models/tm_blocks.bin", { signal: ctrl.signal });
            if (!r.ok || !r.body) throw new Error("tm_blocks.bin: " + r.status);
            const total = Number(r.headers.get("content-length")) || 0;
            const reader = r.body.getReader();
            let got = 0;
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                got += value.byteLength;
                bar.classList.toggle("busy", !total);
                if (total) fill.style.width = Math.min(100, (got / total) * 100).toFixed(1) + "%";
                sub.textContent = mb(got) + (total ? " of " + mb(total) : "") + " MB";
            }
        } catch (e) {
            if (cancelled) return false;
            throw e;
        } finally {
            finished = true;
            close();
        }
        return !cancelled;
    }

    async function readBeHeader(code) {
        const b62 = base62();
        const outer = b62.decode(code.slice(BE_PREFIX.length));
        if (!outer) throw new Error("bad base62");
        const inner = b62.decode(utf8(await inflate(outer, 4 * MAX_PACK_BYTES)));
        if (!inner) throw new Error("bad base62");
        // Name, author and environment sit in the first ~520 bytes.
        const d = await inflate(inner, 1024, true);
        let p = 0;
        const nameLen = d[p++];
        const name = utf8(d.subarray(p, p + nameLen));
        p += nameLen;
        const authorLen = d[p++];
        const author = authorLen ? utf8(d.subarray(p, p + authorLen)) : null;
        p += authorLen;
        if (d[p++] === 1) p += 4;
        if (p >= d.length) throw new Error("short");
        return { name, author, env: ENVS[d[p]] ?? null };
    }

    async function parseAsync(code) {
        code = clean(code);
        if (!code.startsWith(BE_PREFIX) || beReady()) return parse(code);
        const cached = infoCache.get(code);
        if (cached) return cached;
        try {
            const h = await readBeHeader(code);
            return remember(code, { ok: true, kind: "be", code, name: h.name.trim() || "Untitled track", author: h.author, trackId: null, env: h.env });
        } catch {
            return remember(code, failed(code, "That Better Editor code is damaged or cut short."));
        }
    }

    const THUMB_V = 2;
    function pixelScale(src, size) {
        const fit = Math.min(size / src.width, size / src.height);
        const scale = fit >= 1 ? Math.floor(fit) : fit;
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(src.width * scale));
        c.height = Math.max(1, Math.round(src.height * scale));
        const g = c.getContext("2d");
        g.imageSmoothingEnabled = scale < 1;
        g.drawImage(src, 0, 0, c.width, c.height);
        return c.toDataURL("image/png");
    }

    function thumbOf(data) {
        try {
            const src = data.createThumbnail();
            if (!src?.width || !src?.height) return null;
            return pixelScale(src, 160);
        } catch {
            return null;
        }
    }

    // Storage. My Tracks belongs to the account (the profile's token) and lives on the server;
    // IndexedDB keeps this browser's copy, one database per account. Falls back to memory where
    // IndexedDB is blocked. Without a profile token tracks stay in this browser only.
    // track.sync: "ok" = same as the server, "meta" = details changed here, "all" = code not uploaded.
    let dbPromise = null;
    let dbKey = null;
    let memoryOnly = false;
    const memory = new Map();

    async function accountKey() {
        const token = user().token;
        return token ? (await sha256("nsws-tracks:" + token)).slice(0, 16) : "";
    }

    function openDb(key) {
        if (dbKey !== key) {
            dbKey = key;
            dbPromise = null;
            memory.clear();
        }
        return (dbPromise ??= new Promise((resolve, reject) => {
            let req;
            try {
                req = indexedDB.open(DB_NAME + (key ? "-" + key : ""), 1);
            } catch (e) {
                reject(e);
                return;
            }
            req.onupgradeneeded = () => {
                if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "id" });
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        }).catch((e) => {
            memoryOnly = true;
            console.warn("[Custom Tracks] IndexedDB unavailable, keeping tracks in memory only", e);
            return null;
        }));
    }

    const reqP = (r) => new Promise((resolve, reject) => {
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
    });

    async function storeOf(mode) {
        const db = await openDb(await accountKey());
        return db ? db.transaction(STORE, mode).objectStore(STORE) : null;
    }

    let cache = null;
    let cacheKey = null;
    async function loadAll() {
        const key = await accountKey();
        if (cache && cacheKey === key) return cache;
        const store = await storeOf("readonly");
        const rows = store ? await reqP(store.getAll()) : [...memory.values()];
        cache = new Map(rows.map((t) => [t.id, t]));
        cacheKey = key;
        setTimeout(() => sync().catch(() => {}), 0);
        setTimeout(() => refreshThumbs().catch(() => {}), 400);
        return cache;
    }

    // Redraws thumbnails made by older versions (blurry 64 px ones); Better Editor ones once its blocks are loaded.
    let thumbsBusy = false;
    let thumbsAgain = false;
    async function refreshThumbs() {
        if (thumbsBusy) {
            thumbsAgain = true;
            return;
        }
        thumbsBusy = true;
        let named = false;
        try {
            const changed = [];
            for (const t of [...(await loadAll()).values()]) {
                const needId = t.kind === "be" && !t.trackId;
                if ((t.thumbV === THUMB_V && !needId) || typeof t.code !== "string" || (t.kind === "be" && !beReady())) continue;
                const loaded = stockParse(t.code, true);
                const now = (await loadAll()).get(t.id);
                if (!now) continue;
                // A Better Editor track saved before its blocks loaded has no track id (no board, stats or favourites).
                let id = null;
                if (!now.trackId && loaded.data) {
                    try {
                        id = loaded.data.getId() || null;
                    } catch {}
                }
                // Older versions marked these redrawn without an id; rewriting one that still gets none would make two tabs echo forever.
                if (now.thumbV === THUMB_V && !id) continue;
                const next = { ...now, thumb: (loaded.data && thumbOf(loaded.data)) || now.thumb || null, thumbV: THUMB_V };
                if (id) {
                    next.trackId = id;
                    if (next.sync === "ok") next.sync = "meta";
                    named = true;
                }
                await putTrack(next);
                changed.push(t.id);
                await new Promise((r) => setTimeout(r, 0));
            }
            if (changed.length) emit({ type: "update", ids: changed });
        } finally {
            thumbsBusy = false;
            if (named) schedulePush();
            if (thumbsAgain) {
                thumbsAgain = false;
                setTimeout(() => refreshThumbs().catch(() => {}), 0);
            }
        }
    }

    async function putTrack(track) {
        const store = await storeOf("readwrite");
        if (store) await reqP(store.put(track));
        else memory.set(track.id, track);
        (await loadAll()).set(track.id, track);
    }

    async function deleteTrack(id, onlyHere = false) {
        const store = await storeOf("readwrite");
        if (store) await reqP(store.delete(id));
        else memory.delete(id);
        (await loadAll()).delete(id);
        if (!onlyHere) {
            const key = await accountKey();
            if (key) setPendingDeletes(key, [...pendingDeletes(key).filter((x) => x !== id), id]);
            schedulePush();
        }
    }

    const DELETES_KEY = "nswsTracksDeleted-";
    function pendingDeletes(key) {
        try {
            const ids = JSON.parse(localStorage.getItem(DELETES_KEY + key) || "[]");
            return Array.isArray(ids) ? ids : [];
        } catch {
            return [];
        }
    }
    function setPendingDeletes(key, ids) {
        try {
            if (ids.length) localStorage.setItem(DELETES_KEY + key, JSON.stringify(ids.slice(-500)));
            else localStorage.removeItem(DELETES_KEY + key);
        } catch {}
    }

    const remoteMeta = (t) => {
        const { code, thumb, thumbV: _v, sync: _s, id, updated, ...meta } = t;
        return meta;
    };

    let syncing = null;
    let lastSync = 0;
    let syncError = null;
    let pushTimer = null;

    function schedulePush() {
        clearTimeout(pushTimer);
        pushTimer = setTimeout(() => flush().catch(() => {}), 800);
    }

    // The server refuses a code over 4 MB (LIB_CODE_MAX in proxy/src/trackhub.js) and with it the whole batch.
    const LIB_CODE_MAX = 4_000_000;
    async function pushTracks(token, list, onServer) {
        const tooBig = list.filter((t) => !(t.sync === "meta" && onServer.has(t.id)) && t.code.length > LIB_CODE_MAX);
        list = list.filter((t) => !tooBig.includes(t));
        let batch = [], size = 0;
        const send = async () => {
            if (!batch.length) return;
            const res = await api("nsws/tracks/library/put", {
                token,
                tracks: batch.map((t) => ({ id: t.id, code: t.sync === "meta" && onServer.has(t.id) ? undefined : t.code, meta: remoteMeta(t), updated: t.updated || Date.now() })),
            });
            const missing = new Set(Array.isArray(res?.missing) ? res.missing : []);
            // After a profile switch the cache and database are the other account's, so this one re-sends later.
            if (user().token === token) {
                for (const t of batch) {
                    const now = cache?.get(t.id);
                    if (now && now.updated === t.updated) await putTrack({ ...now, sync: missing.has(t.id) ? "all" : "ok" });
                }
                if (missing.size) schedulePush();
            }
            batch = [];
            size = 0;
        };
        for (const t of list) {
            // Metas count too: a 4 MB code plus 19 pictures would pass the Worker's 4.4 MB body limit.
            const n = (t.sync === "meta" && onServer.has(t.id) ? 0 : t.code.length) + JSON.stringify(remoteMeta(t)).length;
            if (batch.length && (batch.length >= 20 || size + n > 3_500_000)) await send();
            batch.push(t);
            size += n;
        }
        await send();
        if (tooBig.length) throw new Error((tooBig.length === 1 ? "\"" + (tooBig[0].name || "Untitled track") + "\" is" : tooBig.length + " tracks are") + " over 4 MB, so " + (tooBig.length === 1 ? "it stays" : "they stay") + " in this browser only.");
    }

    async function sendDeletes(token, key) {
        const ids = pendingDeletes(key);
        for (let i = 0; i < ids.length; i += 20) await api("nsws/tracks/library/delete", { token, ids: ids.slice(i, i + 20) });
        if (ids.length) setPendingDeletes(key, pendingDeletes(key).filter((x) => !ids.includes(x)));
    }

    // Uploads what changed here without reading the server's list.
    // Two uploads at once would send the same codes twice (they count against the daily byte limit), so a
    // change made meanwhile waits for the running one.
    let flushing = null;
    function flush() {
        const { token } = user();
        if (!token || !window.__nswsApiBase) return Promise.resolve();
        const busy = syncing || flushing;
        if (busy) {
            busy.then(schedulePush, schedulePush);
            return Promise.resolve();
        }
        return (flushing = (async () => {
            try {
                const key = (await sha256("nsws-tracks:" + token)).slice(0, 16);
                await sendDeletes(token, key);
                const tracks = await loadAll();
                if (cacheKey !== key) return;
                const out = [...tracks.values()].filter((t) => t.sync !== "ok" && t.code);
                await pushTracks(token, out, new Set(out.filter((t) => t.sync === "meta").map((t) => t.id)));
                syncError = null;
            } catch (e) {
                syncError = e.message || "Couldn't reach the NSWS server.";
            }
            emit({ type: "sync" }, false);
        })().finally(() => (flushing = null)));
    }

    // Brings this browser's copy in line with the account: the server wins, except for changes made here.
    function sync(force = false) {
        const { token } = user();
        if (!token || !window.__nswsApiBase) return Promise.resolve(false);
        if (syncing) return syncing;
        if (!force && Date.now() - lastSync < 60_000) return Promise.resolve(true);
        lastSync = Date.now();
        return (syncing = (async () => {
            let changed = false;
            try {
                if (flushing) await flushing;
                const key = (await sha256("nsws-tracks:" + token)).slice(0, 16);
                // Writes after a profile switch would land in the other account's database.
                const moved = () => user().token !== token || cacheKey !== key;
                const tracks = await loadAll();
                if (moved()) return false;
                await sendDeletes(token, key);
                const remote = await api("nsws/tracks/library/list", { token });
                // A 200 that isn't the list (a captive portal, say) would otherwise delete every synced track here.
                if (!Array.isArray(remote?.tracks)) throw new Error("The NSWS server sent an answer this page can't read.");
                if (moved()) return false;
                const deleting = new Set(pendingDeletes(key));
                const onServer = new Set();
                const need = [];
                for (const r of remote.tracks) {
                    if (!r || typeof r.id !== "string") continue;
                    onServer.add(r.id);
                    if (deleting.has(r.id)) continue;
                    const local = tracks.get(r.id);
                    if (local && (local.sync !== "ok" || (local.updated || 0) >= (r.updated || 0))) continue;
                    if (local && local.code && local.hash && local.hash === r.hash) {
                        await putTrack({ ...local, ...r, code: local.code, thumb: local.thumb, trackId: r.trackId || local.trackId || null, image: validImage(r.image), sync: "ok" });
                        changed = true;
                    } else need.push(r);
                }
                for (let i = 0; i < need.length; ) {
                    const part = need.slice(i, i + 20);
                    const { codes } = await api("nsws/tracks/library/codes", { token, ids: part.map((r) => r.id) });
                    if (moved()) return false;
                    // One reply carries about 8 MB of codes (LIB_CODES_REPLY), so the ones after its last code are asked again.
                    let next = part.length;
                    for (let j = part.length - 1; j >= 0; j--) {
                        if (typeof codes?.[part[j].id] === "string") {
                            next = j + 1;
                            break;
                        }
                    }
                    i += next;
                    for (const r of part) {
                        const code = codes?.[r.id];
                        if (typeof code !== "string" || !code || pendingDeletes(key).includes(r.id)) continue;
                        let thumb = null;
                        if (r.kind === "stock") {
                            const loaded = stockParse(code);
                            if (loaded.data) thumb = thumbOf(loaded.data);
                        }
                        await putTrack({ ...r, code, thumb, image: validImage(r.image), sync: "ok" });
                        changed = true;
                    }
                }
                if (moved()) return false;
                for (const t of [...tracks.values()]) {
                    if (!onServer.has(t.id) && t.sync === "ok") {
                        await deleteTrack(t.id, true);
                        changed = true;
                    }
                }
                const out = [...tracks.values()].filter((t) => t.sync !== "ok" && t.code);
                if (out.length) {
                    await pushTracks(token, out, onServer);
                    changed = true;
                }
                syncError = null;
            } catch (e) {
                syncError = e.message || "Couldn't reach the NSWS server.";
                changed = true;
            } finally {
                syncing = null;
            }
            if (changed) emit({ type: "sync" }, !syncError);
            return true;
        })());
    }

    function syncNote() {
        if (!user().token) return "Make a profile to keep these tracks on your account; for now they're saved in this browser only.";
        return syncError ? "Not saved to your account yet: " + syncError : "";
    }

    const listeners = new Set();
    let channel = null;
    try {
        channel = new BroadcastChannel("nsws-tracks");
        channel.onmessage = () => {
            cache = null;
            emit({ type: "external" }, false);
        };
    } catch {}

    function emit(detail, broadcast = true) {
        if (broadcast) {
            try {
                channel?.postMessage(1);
            } catch {}
        }
        for (const fn of [...listeners]) {
            try {
                fn(detail);
            } catch (e) {
                console.error(e);
            }
        }
    }

    function onChange(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
    }

    const newId = () => {
        const b = crypto.getRandomValues(new Uint8Array(9));
        return toB64url(b);
    };

    async function list() {
        return [...(await loadAll()).values()].sort((a, b) => (b.updated || 0) - (a.updated || 0));
    }

    async function get(id) {
        return (await loadAll()).get(id) || null;
    }

    // A library track by its PolyTrack track id (all a clip keeps). Better Editor tracks saved before their blocks
    // loaded have no id yet, so those are read once the blocks are here.
    async function findByTrackId(trackId) {
        if (!trackId) return null;
        const all = await list();
        const hit = all.find((t) => t.trackId === trackId);
        if (hit || !all.some((t) => t.kind === "be" && !t.trackId)) return hit || null;
        if (!beReady() && !(await ensureBE())) return null;
        return all.find((t) => t.kind === "be" && !t.trackId && typeof t.code === "string" && parse(t.code).trackId === trackId) || null;
    }

    function findExisting(tracks, info, hash) {
        for (const t of tracks.values()) {
            if (info.kind === "stock" && info.trackId ? t.trackId === info.trackId : t.hash === hash) return t;
        }
        return null;
    }

    async function addOne(code, opts = {}) {
        const info = await parseAsync(code);
        if (!info.ok) throw new Error(info.error);
        const tracks = await loadAll();
        const hash = await sha256(info.code);
        const existing = findExisting(tracks, info, hash);
        let thumb = null;
        if (info.kind === "stock") {
            const loaded = stockParse(info.code);
            if (loaded.data) thumb = thumbOf(loaded.data);
        }
        const now = Date.now();
        const base = { code: info.code, kind: info.kind, name: info.name, author: info.author, trackId: info.trackId, env: info.env, hash, updated: now };
        const track = existing
            ? { ...existing, ...base, thumb: thumb || existing.thumb || null, mode: opts.mode ? normMode(opts.mode) : existing.mode, image: validImage(opts.image) || existing.image || null, sync: "all" }
            : { id: newId(), ...base, mode: normMode(opts.mode), thumb, image: validImage(opts.image), added: now, source: opts.source || "import", favourite: false, folder: null, sync: "all" };
        await putTrack(track);
        schedulePush();
        return { track, isNew: !existing };
    }

    async function add(code, opts = {}) {
        const { track } = await addOne(code, opts);
        emit({ type: "add", ids: [track.id] });
        return track;
    }

    async function addMany(items, opts = {}) {
        const result = { added: 0, updated: 0, failed: [], tracks: [] };
        for (const item of items || []) {
            const code = typeof item === "string" ? item : item?.code;
            try {
                const { track, isNew } = await addOne(code, { mode: item?.mode, image: item?.image, source: opts.source });
                isNew ? result.added++ : result.updated++;
                result.tracks.push(track);
            } catch (e) {
                result.failed.push({ code: clean(code), error: e.message || "Couldn't add that track." });
            }
        }
        if (result.tracks.length) emit({ type: "add", ids: result.tracks.map((t) => t.id) });
        return result;
    }

    async function update(id, patch = {}) {
        const track = await get(id);
        if (!track) throw new Error("That track isn't in My Tracks any more.");
        const next = { ...track };
        if ("mode" in patch) next.mode = normMode(patch.mode);
        if (typeof patch.name === "string" && patch.name.trim()) next.name = patch.name.trim().slice(0, 80);
        if ("folder" in patch) next.folder = patch.folder ? String(patch.folder).slice(0, 40) : null;
        if ("favourite" in patch) next.favourite = !!patch.favourite;
        if ("image" in patch) next.image = validImage(patch.image);
        if ("submitted" in patch) next.submitted = patch.submitted ? { id: String(patch.submitted.id || "").slice(0, 32), at: Number(patch.submitted.at) || Date.now() } : null;
        next.updated = Date.now();
        if (next.sync === "ok") next.sync = "meta";
        await putTrack(next);
        schedulePush();
        emit({ type: "update", ids: [id] });
        return next;
    }

    async function remove(id) {
        await deleteTrack(id);
        emit({ type: "remove", ids: [id] });
    }

    const setMode = (id, mode) => update(id, { mode });

    // A track sent to Weekly Shorts can't be shared any more, so every copy of it in My Tracks gets marked.
    async function markSubmitted(code, sub) {
        const info = await parseAsync(code).catch(() => null);
        if (!info?.ok) return;
        const hash = await sha256(info.code);
        const ids = [];
        for (const t of (await loadAll()).values()) if (t.hash === hash || (info.trackId && t.trackId === info.trackId)) ids.push(t.id);
        for (const id of ids) await update(id, { submitted: sub });
    }

    async function submitTrack(track, note) {
        const me = user();
        if (!me.token) throw new Error("Your player token isn't ready yet. Open any track's leaderboard once, then try again.");
        const info = await parseAsync(track.code);
        if (!info.ok) throw new Error(info.error);
        const answer = await api("nsws/tracks/submit", {
            token: me.token,
            nickname: me.nickname || "",
            code: await packCode([{ code: info.code, mode: track.mode }], info.name || track.name || ""),
            mode: normMode(track.mode),
            name: info.name || track.name || "",
            author: info.author || "",
            trackId: info.trackId || null,
            env: info.env ?? null,
            note: String(note || "").trim().slice(0, 500),
        });
        const sub = { id: answer?.id || "", at: Date.now() };
        await markSubmitted(info.code, sub);
        return sub;
    }

    // Items for packs and sharing: Tracks, {code, mode} objects or bare codes.
    function normItems(items) {
        const arr = Array.isArray(items) ? items : items ? [items] : [];
        return arr
            .map((t) => (typeof t === "string" ? { code: clean(t), mode: "normal" } : { code: clean(t?.code), mode: normMode(t?.mode), name: t?.name || null, image: validImage(t?.image) }))
            .filter((t) => t.code);
    }

    async function packCode(items, name) {
        const tracks = normItems(items);
        if (!tracks.length) throw new Error("Pick at least one track.");
        if (tracks.length > MAX_PACK_TRACKS) throw new Error("A pack holds " + MAX_PACK_TRACKS + " tracks at most.");
        const json = { v: 1 };
        const packName = typeof name === "string" ? name.trim().slice(0, 64) : "";
        if (packName) json.name = packName;
        json.tracks = tracks.map((t) => ({ code: t.code, ...(t.mode !== "normal" && { mode: t.mode }), ...(t.image && { image: t.image }) }));
        const bytes = new TextEncoder().encode(JSON.stringify(json));
        if (bytes.length > MAX_PACK_BYTES) throw new Error("That's too much track data for one pack (4 MB at most). Share fewer tracks at once.");
        return PACK_PREFIX + toB64url(await deflateRaw(bytes));
    }

    async function readPack(text) {
        const raw = typeof text === "string" ? text.trim() : "";
        let json = null;
        try {
            if (raw.startsWith("{")) json = JSON.parse(raw);
            else {
                const s = clean(raw);
                if (!s.startsWith(PACK_PREFIX)) return null;
                const bytes = await inflateRaw(fromB64url(s.slice(PACK_PREFIX.length)), MAX_PACK_BYTES);
                json = JSON.parse(utf8(bytes));
            }
        } catch {
            return null;
        }
        if (!json || !Array.isArray(json.tracks)) return null;
        const tracks = json.tracks
            .slice(0, MAX_PACK_TRACKS)
            .filter((t) => t && typeof t.code === "string" && t.code.trim())
            .map((t) => ({ code: clean(t.code), mode: normMode(t.mode), image: validImage(t.image) }));
        return { name: typeof json.name === "string" ? json.name.slice(0, 64) : "", tracks };
    }

    const linkCache = new Map();
    async function shareLink(items, name) {
        const tracks = normItems(items);
        const pack = await packCode(tracks, name);
        const known = linkCache.get(pack);
        if (known) return known;
        const names = [];
        for (const t of tracks.slice(0, 5)) names.push(t.name || (await parseAsync(t.code)).name || "Untitled track");
        const me = user();
        const answer = await api("nsws/tracks/pack", { pack, name: typeof name === "string" ? name.trim().slice(0, 64) : "", count: tracks.length, names, token: me.token, nickname: me.nickname });
        if (!answer?.id || !LINK_ID.test(answer.id)) throw new Error("The server didn't send a link back. Try again.");
        const out = { url: (window.__nswsShareBase || location.origin + "/") + "?tracks=" + answer.id, id: answer.id };
        linkCache.set(pack, out);
        return out;
    }

    const packFetches = new Map();
    function fetchPack(id) {
        if (!packFetches.has(id)) {
            const p = api("nsws/tracks/pack/" + id).then(async (answer) => {
                const pack = await readPack(answer?.pack || "");
                if (!pack) throw new Error("That track link's pack is damaged.");
                if (!pack.name && answer?.name) pack.name = String(answer.name).slice(0, 64);
                return pack;
            });
            p.catch(() => packFetches.delete(id));
            packFetches.set(id, p);
        }
        return packFetches.get(id);
    }

    function linkOf(token) {
        if (!/[?&](tracks|club)=|\/t\/[0-9A-Za-z]{10}/.test(token)) return null;
        let u;
        try {
            u = new URL(/^[a-z]+:\/\//i.test(token) ? token : "https://" + token);
        } catch {
            return null;
        }
        const t = u.searchParams.get("tracks");
        if (t && LINK_ID.test(t)) return { type: "link", value: t };
        const c = (u.searchParams.get("club") || "").toUpperCase();
        if (CLUB_CODE.test(c)) return { type: "club", value: c };
        const m = u.pathname.match(/\/t\/([0-9A-Za-z]{10})\/?$/);
        return m ? { type: "link", value: m[1] } : null;
    }

    // Splits pasted text into codes, packs, links and club codes. A code wrapped over several lines
    // is joined back together.
    function tokenize(text) {
        const src = String(text || "");
        const words = [];
        const re = /\S+/g;
        let m;
        let end = 0;
        while ((m = re.exec(src))) {
            words.push({ word: m[0], newline: src.slice(end, m.index).includes("\n") });
            end = m.index + m[0].length;
        }
        const pieces = [];
        for (const { word, newline } of words) {
            const last = pieces[pieces.length - 1];
            if (word.startsWith(PACK_PREFIX)) pieces.push({ type: "pack", value: word });
            else if (word.startsWith("PolyTrack")) pieces.push({ type: "code", value: word });
            else {
                const link = linkOf(word);
                if (link) pieces.push(link);
                else if (words.length === 1 && CLUB_CODE.test(word.toUpperCase())) pieces.push({ type: "club", value: word.toUpperCase() });
                else if (newline && word.length >= 8 && last && (last.type === "code" || last.type === "pack") && /^[A-Za-z0-9_+\/=-]+$/.test(word)) last.value += word;
                else if (/^[A-Za-z0-9_+\/=-]{20,}$/.test(word)) pieces.push({ type: "code", value: word });
                else pieces.push({ type: "junk", value: word });
            }
        }
        return pieces;
    }

    async function importText(text) {
        const out = { tracks: [], failed: [] };
        const raw = String(text || "").trim();
        const sources = [];
        if (raw.startsWith("{")) {
            const pack = await readPack(raw);
            if (pack) {
                out.name = pack.name || undefined;
                out.tracks = pack.tracks;
                return out;
            }
        }
        for (const piece of tokenize(raw)) {
            if (out.tracks.length >= MAX_IMPORT) break;
            if (piece.type === "code") out.tracks.push({ code: piece.value, mode: "normal" });
            else if (piece.type === "club") out.club = piece.value;
            else if (piece.type === "pack" || piece.type === "link") {
                try {
                    const pack = piece.type === "pack" ? await readPack(piece.value) : await fetchPack(piece.value);
                    if (!pack) throw new Error("That NSWS Track code is damaged or cut short.");
                    sources.push(pack.name);
                    for (const t of pack.tracks) out.tracks.push({ ...t, fromLink: piece.type === "link" });
                } catch (e) {
                    out.failed.push({ code: piece.value, error: e.message });
                }
            }
        }
        if (sources.length === 1 && sources[0]) out.name = sources[0];
        out.tracks = out.tracks.slice(0, MAX_IMPORT);
        return out;
    }

    function user() {
        let token = null;
        try {
            token = window.__nswsProfileToken?.() || null;
        } catch {}
        let nickname = null;
        try {
            nickname = window.__getPlayerNickname?.() || null;
        } catch {}
        if (!nickname) {
            try {
                const slot = parseInt(localStorage.getItem("polytrack_v5_prod_user_slot") ?? "0", 10);
                nickname = JSON.parse(localStorage.getItem("polytrack_v5_prod_user_" + (slot >= 0 ? slot : 0)))?.nickname || null;
            } catch {}
        }
        nickname = typeof nickname === "string" ? nickname.trim().slice(0, 24) : "";
        return { token: TOKEN.test(token || "") ? token : null, nickname: nickname || null };
    }

    async function api(path, body, opts = {}) {
        const base = window.__nswsApiBase;
        if (!base) throw Object.assign(new Error("This copy of the site has no NSWS server."), { status: 0 });
        const hasBody = body !== undefined && body !== null;
        const method = opts.method || (hasBody ? "POST" : "GET");
        let response;
        const ctrl = typeof AbortController === "function" ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), opts.timeout || (/library\/put|pack$|submit$/.test(path) ? 90000 : 25000)) : 0;
        let data = null;
        try {
            response = await fetch(base + String(path).replace(/^\/+/, ""), {
                method,
                headers: hasBody ? { "Content-Type": "text/plain" } : undefined,
                body: hasBody ? JSON.stringify(body) : undefined,
                signal: ctrl?.signal,
            });
            try {
                data = JSON.parse(await response.clone().text());
            } catch {}
        } catch {
            const stalled = ctrl?.signal.aborted;
            throw Object.assign(new Error(stalled ? "The NSWS server didn't answer in time. Your network may be blocking or slowing it; try again, or try another network." : "Couldn't reach the NSWS server. Check your connection and try again."), { status: 0 });
        } finally {
            clearTimeout(timer);
        }
        if (!response.ok) {
            try {
                await window.__nswsBusy?.fromResponse(response);
            } catch {}
            let message = typeof data?.error === "string" && data.error !== "busy" ? data.error : null;
            if (!message) {
                if (response.status === 429) message = "Slow down a little, then try again.";
                else if (response.status === 503 || data?.error === "busy") message = "NSWS is very busy right now. Try again in a few minutes.";
                else message = "The NSWS server answered " + response.status + ". Try again later.";
            }
            throw Object.assign(new Error(message), { status: response.status, data });
        }
        return data ?? {};
    }

    // A race's new PB upload still on its way, by track id: Back from a race reads the board at once, before it lands.
    const pendingUploads = new Map();
    addEventListener("nsws-new-pb", (e) => {
        const d = e.detail;
        if (!d?.track || typeof d.upload?.then !== "function") return;
        const job = Promise.resolve(d.upload).catch(() => null);
        pendingUploads.set(d.track, job);
        job.then(() => pendingUploads.get(d.track) === job && pendingUploads.delete(d.track));
    });

    // Your board run as your PB on this device when the device has none (before v11.83 every load deleted them).
    async function restoreBest(trackId, wait) {
        const r = window.__nswsTrackBoard?.restore;
        if (!r || !trackId) return false;
        const job = Promise.resolve().then(() => r(trackId)).catch((e) => (console.warn(e), false));
        return wait ? Promise.race([job, new Promise((res) => setTimeout(() => res(false), wait))]) : job;
    }

    // A second Play while one is starting (a double click) would stack launch cards and start two races.
    let starting = false;
    async function play(trackOrCode, opts = {}) {
        if (starting) return false;
        starting = true;
        try {
            return await playNow(trackOrCode, opts);
        } finally {
            starting = false;
        }
    }

    async function playNow(trackOrCode, opts = {}) {
        let item = typeof trackOrCode === "string" ? { code: trackOrCode } : trackOrCode || {};
        if (typeof item.code === "string" && clean(item.code).startsWith(PACK_PREFIX)) {
            const first = (await readPack(item.code))?.tracks?.[0];
            if (!first) {
                await ui.alert("That NSWS Track code is damaged or cut short.", "Can't play this track");
                return false;
            }
            item = { ...item, code: first.code, mode: opts.mode ?? first.mode };
        }
        const mode = normMode(opts.mode ?? item.mode);
        let info = await parseAsync(item.code);
        if (!info.ok) {
            await ui.alert(info.error, "Can't play this track");
            return false;
        }
        if (info.kind === "be" && !beReady()) {
            let loadedBE = false;
            try {
                loadedBE = await ensureBE();
            } catch (e) {
                console.error(e);
                await ui.alert("Couldn't load the Better Editor blocks this track uses. Check your connection and try again.", "Can't play this track");
                return false;
            }
            if (!loadedBE) return false;
            info = parse(info.code);
            if (!info.ok) {
                await ui.alert(info.error, "Can't play this track");
                return false;
            }
        }
        const hooks = window.__nswsTrackHooks;
        const loaded = stockParse(info.code, true);
        if (!hooks?.openTrack || loaded.error) {
            await ui.alert(loaded.error || "The game is still loading. Try again in a moment.", "Can't play this track");
            return false;
        }
        const restoring = opts.watch || isKnown(info.trackId) ? null : restoreBest(info.trackId, 3000);
        const intro = opts.intro && !isKnown(info.trackId) ? await launchCard(item, info, mode, loaded.data) : null;
        closeAll(true);
        try {
            window.__nswsEditor?.close?.();
        } catch {}
        if (isKnown(info.trackId)) {
            // An official, community or week track opens as itself, so its leaderboard and PBs stay right.
            if (mode !== "normal") toast("This is a listed PolyTrack track, so it plays with its own physics.");
            let opened = false;
            try {
                opened = !!window.__nswsOpenTrack?.(info.trackId);
            } catch (e) {
                console.error(e);
            }
            if (opened) return true;
        }
        registerModes([{ trackId: info.trackId, mode }]);
        await restoring;
        let ok = false;
        if (opts.watch && window.__nswsWatchTrack) {
            try {
                ok = !!window.__nswsWatchTrack(loaded.meta, loaded.data, opts.watch.runs, opts.onExit, opts.watch.tmBase || null);
            } catch (e) {
                console.error(e);
            }
        } else if (opts.start && window.__nswsRaceTrack) {
            try {
                ok = !!window.__nswsRaceTrack(loaded.meta, loaded.data, opts.onExit, opts.ghosts);
            } catch (e) {
                console.error(e);
            }
        } else {
            let thumb = null;
            try {
                thumb = loaded.data.createThumbnail();
            } catch {}
            try {
                ok = !!hooks.openTrack(loaded.meta, loaded.data, info.trackId, thumb);
            } catch (e) {
                console.error(e);
            }
        }
        intro?.finish(ok);
        if (ok && !opts.watch) notePlayed(info.trackId);
        if (!ok) await ui.alert("The game couldn't open that track. Go back to the main menu and try again.", "Can't play this track");
        return ok;
    }

    function notePlayed(trackId) {
        const me = user();
        if (!me.token || !TRACK_ID.test(trackId || "")) return;
        let seen = [];
        try {
            seen = JSON.parse(localStorage.getItem("nswsPlayed") || "[]");
        } catch {}
        const key = me.token.slice(0, 8) + trackId.slice(0, 24);
        if (seen.includes(key)) return;
        api("nsws/tracks/played", { token: me.token, trackId }).then(() => {
            seen.push(key);
            try {
                localStorage.setItem("nswsPlayed", JSON.stringify(seen.slice(-3000)));
            } catch {}
        }, () => {});
    }

    // Favourites live on the account's My Tracks entry; the server also counts them per track.
    async function setFavourite(track, on) {
        const next = await update(track.id, { favourite: on });
        const me = user();
        let stats = null;
        if (me.token && TRACK_ID.test(track.trackId || "")) stats = await api("nsws/tracks/favourite", { token: me.token, trackId: track.trackId, on }).catch(() => null);
        return { track: next, stats };
    }

    function bigThumb(data) {
        try {
            const src = data.createThumbnail();
            if (!src?.width || !src?.height) return null;
            return pixelScale(src, 360);
        } catch {
            return null;
        }
    }

    // Covers the switch from the list to the car: fades in, the race loads behind it, then it fades away.
    function launchCard(item, info, mode, data) {
        ensureCss();
        const host = isolate(el("div", "nt-host nt-launch"));
        const card = el("div", "nt-lcard");
        const pic = el("div", "nt-lthumb");
        const img = el("img");
        img.alt = "";
        const src = item.image || bigThumb(data) || item.thumb;
        if (src) img.src = src;
        if (item.image) img.className = "photo";
        else if (!src) {
            img.className = "env";
            img.src = "images/" + (info.env || "summer").toLowerCase() + ".svg";
        }
        pic.appendChild(img);
        card.append(pic, el("div", "nt-lname", info.name || item.name || "Untitled track"), metaNode({ ...info, mode }), el("div", "nt-lbar"));
        host.appendChild(card);
        document.body.appendChild(host);
        const finish = (ok) => {
            setTimeout(() => {
                host.classList.remove("on");
                setTimeout(() => host.remove(), 450);
            }, ok ? 900 : 0);
        };
        return new Promise((resolve) => {
            setTimeout(() => {
                host.classList.add("on");
                setTimeout(() => resolve({ finish }), 300);
            }, 20);
        });
    }

    function openInEditor(track) {
        const editor = window.__nswsEditor;
        if (!editor?.open) {
            ui.alert("The Track Editor isn't available on this copy of the site.");
            return false;
        }
        closeAll();
        editor.open(track || null);
        return true;
    }

    // UI.
    const CSS = `
.nt-host{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;color:#fff;font-family:ForcedSquare,Arial,sans-serif;font-style:italic;touch-action:none;pointer-events:auto;}
.nt-host *{box-sizing:border-box;font-style:italic;}
.nt-host[hidden],.nt-host [hidden]{display:none!important;}
.nt-screen{z-index:100400;background:rgba(0,0,0,.55);align-items:stretch;outline:none;}
.nt-modal{z-index:100500;background:rgba(0,0,0,.6);padding:12px;}
.nt-host .button{font-size:18px;padding:7px 16px;line-height:1;white-space:nowrap;}
.nt-host .button>img{width:20px;height:20px;margin:-4px 6px -4px 0;vertical-align:middle;pointer-events:none;}
.nt-host .button.nt-icon{padding:7px 12px;}
.nt-host .button.nt-icon>img{margin:-4px 0;}
.nt-host .button.nt-primary{box-shadow:inset 0 -3px 0 #7272c2;}
.nt-host .button:disabled{opacity:.4;cursor:default;pointer-events:none;}
.nt-panel{display:flex;flex-direction:column;width:min(1000px,100%);height:100%;background:#28346a;}
.nt-top{display:flex;align-items:center;gap:10px;padding:10px 14px;flex-wrap:wrap;}
.nt-top>h2{margin:0 auto 0 6px;font-size:30px;font-weight:normal;}
.nt-tabs{display:flex;gap:2px;padding:0 14px;border-bottom:1px solid rgba(255,255,255,.2);overflow-x:auto;flex:none;}
.nt-tab{margin:0;padding:10px 16px 8px;background:none;border:none;border-bottom:3px solid transparent;color:rgba(255,255,255,.6);font-size:20px;cursor:pointer;white-space:nowrap;}
.nt-tab:hover{color:#fff;}
.nt-tab.on{color:#fff;border-bottom-color:#7272c2;}
.nt-scroll{flex:1;min-height:0;overflow-y:auto;background:#212b58;touch-action:pan-y;}
.nt-pane{min-height:100%;}
.nt-toolbar{position:sticky;top:0;z-index:1;display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:10px 14px;background:#212b58;border-bottom:1px solid rgba(255,255,255,.12);}
.nt-toolbar .nt-grow{flex:1 1 160px;min-width:120px;}
.nt-selbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;width:100%;}
.nt-selbar>span{margin-right:auto;font-size:17px;color:rgba(255,255,255,.75);}
input.nt-input,textarea.nt-area,select.nt-select{margin:0;padding:7px 10px;border:none;outline:none;background:#192042;color:#fff;font-family:ForcedSquare,Arial,sans-serif;font-style:italic;font-size:17px;font-weight:normal;text-indent:0;clip-path:polygon(0 0,100% 0,calc(100% - 6px) 100%,0 100%);pointer-events:auto;}
input.nt-input:focus,textarea.nt-area:focus,select.nt-select:focus{box-shadow:inset 0 -2px 0 #7272c2;}
input.nt-input::placeholder,textarea.nt-area::placeholder{color:rgba(255,255,255,.3);opacity:1;}
textarea.nt-area{display:block;width:100%;min-height:120px;resize:vertical;font-family:monospace;font-style:normal;font-size:13px;line-height:1.35;word-break:break-all;user-select:text;}
textarea.nt-area.nt-prose{font-family:inherit;font-size:16px;word-break:normal;overflow-wrap:anywhere;}
textarea.nt-area[readonly]{min-height:70px;max-height:140px;}
select.nt-select{padding-right:10px;cursor:pointer;}
.nt-select option{background:#192042;color:#fff;font-style:normal;}
.nt-check{appearance:none;-webkit-appearance:none;width:20px;height:20px;margin:0;flex:none;cursor:pointer;background:#192042;box-shadow:inset 0 0 0 2px rgba(255,255,255,.35);}
.nt-check:hover{box-shadow:inset 0 0 0 2px rgba(255,255,255,.7);}
.nt-check:checked{background:#7272c2;box-shadow:inset 0 0 0 2px #8f8ff0,inset 0 0 0 5px #192042;}
.nt-check:focus-visible{outline:2px solid #fff;outline-offset:1px;}
.nt-row{display:flex;align-items:center;gap:12px;padding:8px 14px;border-bottom:1px solid rgba(255,255,255,.08);}
.nt-row.sel{background:rgba(114,114,194,.16);}
.nt-row.pick{cursor:pointer;}
.nt-row.pick:hover{background:rgba(255,255,255,.05);}
.nt-thumb{width:64px;height:64px;flex:none;display:flex;align-items:center;justify-content:center;background:#192042;overflow:hidden;}
.nt-thumb>img{width:100%;height:100%;object-fit:contain;image-rendering:pixelated;}
.nt-thumb>img.env{width:60%;height:60%;opacity:.45;image-rendering:auto;}
.nt-thumb>img.photo{object-fit:cover;image-rendering:auto;}
.nt-row.open{cursor:pointer;}
.nt-row.open:hover{background:rgba(255,255,255,.05);}
.nt-row.expanded,.nt-row.expanded:hover{background:#192042;border-bottom-color:transparent;}
.nt-drop{overflow:hidden;background:#192042;border-bottom:1px solid rgba(255,255,255,.08);transition:height .28s ease-out;outline:none;}
.nt-drop>.nt-pbody{height:min(440px,62vh);box-sizing:border-box;padding:6px 14px 14px;}
.nt-drop .nt-hero .nt-lthumb{width:min(100%,150px);}
.nt-pbar{position:relative;height:6px;margin:10px 0 4px;overflow:hidden;background:rgba(255,255,255,.15);}
.nt-pbar>div{position:absolute;top:0;bottom:0;left:0;width:0;background:#7272c2;transition:width .2s;}
.nt-pbar.busy>div{width:35%;transition:none;animation:ntLoad 1.1s linear infinite;}
.nt-bvers{flex-wrap:wrap;gap:6px;margin:0 0 8px;}
.nt-page{z-index:100450;flex-direction:column;align-items:stretch;justify-content:flex-start;background:#192042;outline:none;}
.nt-pwrap{position:relative;display:flex;flex-direction:column;width:min(1120px,100%);height:100%;margin:0 auto;min-height:0;}
.nt-ptop{display:flex;align-items:center;gap:10px;padding:10px 14px;}
.nt-ptop h2{margin:0;font-size:24px;font-weight:normal;color:rgba(255,255,255,.7);}
.nt-pbody{flex:1;min-height:0;display:flex;gap:18px;padding:4px 14px 14px;}
.nt-hero{flex:0 0 min(360px,40%);display:flex;flex-direction:column;gap:8px;min-height:0;overflow:auto;}
.nt-hero .nt-lthumb{width:min(100%,38vh);flex:none;}
.nt-hero .nt-line{margin:0;flex-wrap:wrap;}
.nt-ptitle{font-size:36px;line-height:1.1;overflow-wrap:anywhere;}
.nt-pstats{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:4px 0;font-size:18px;}
.nt-pstats>span:nth-child(odd){color:rgba(255,255,255,.55);}
.nt-host .button.nt-pplay{font-size:26px;padding:12px 26px;}
.nt-host .button.nt-pplay>img{width:28px;height:28px;}
.nt-board{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;background:#212b58;}
.nt-bhead{display:flex;align-items:baseline;gap:12px;padding:10px 14px;font-size:24px;border-bottom:1px solid rgba(255,255,255,.12);}
.nt-bhead>span:last-child{font-size:15px;color:rgba(255,255,255,.55);}
.nt-blist{flex:1;min-height:0;overflow:auto;}
.nt-bmsg{padding:14px;}
.nt-brow{display:grid;grid-template-columns:44px 30px minmax(0,1fr) auto auto;align-items:center;gap:10px;padding:5px 14px;font-size:18px;}
.nt-brow:nth-child(odd){background:rgba(255,255,255,.04);}
.nt-brow.me{background:rgba(114,114,194,.2);box-shadow:inset 3px 0 0 #8f8ff0;}
.nt-brow.pick{cursor:pointer;}
.nt-brow.pick:hover{background:rgba(255,255,255,.08);}
.nt-brow.picked,.nt-brow.picked:hover{background:rgba(143,143,240,.28);}
.nt-brow>.rank{text-align:right;color:rgba(255,255,255,.6);}
.nt-brow>.rank.top{color:#fff;}
.nt-brow .flag{display:block;width:26px;height:19px;}
.nt-brow>.nick{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;}
.nt-brow>.nick:hover{text-decoration:underline;}
.nt-brow>.time{font-variant-numeric:tabular-nums;}
.nt-gbtn{padding:3px 10px;font:inherit;font-size:14px;font-style:italic;color:rgba(255,255,255,.75);background:#192042;border:0;cursor:pointer;clip-path:polygon(4px 0,100% 0,calc(100% - 4px) 100%,0 100%);}
.nt-gbtn:not(:disabled):hover{color:#fff;background:#334b77;}
.nt-gbtn.on{color:#fff;background:#334b77;box-shadow:inset 0 -2px 0 #7272c2;}
.nt-gbtn:disabled{opacity:.3;cursor:default;}
.nt-host .button.nt-bmore{display:block;margin:10px auto;}
@media (max-width:760px){.nt-pbody{flex-direction:column;overflow:auto;}.nt-hero{flex:none;overflow:visible;}.nt-hero .nt-lthumb{width:min(260px,70vw);align-self:center;}.nt-board{flex:none;min-height:360px;}.nt-ptitle{font-size:28px;}}
.nt-info{flex:1;min-width:0;}
.nt-name{font-size:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.nt-meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;margin-top:5px;font-size:14px;color:rgba(255,255,255,.6);}
.nt-chip{padding:2px 8px;font-size:13px;color:#fff;background:#192042;clip-path:polygon(4px 0,100% 0,calc(100% - 4px) 100%,0 100%);white-space:nowrap;}
.nt-chip.mode{box-shadow:inset 0 -2px 0 #8f8ff0;}
.nt-chip.be{color:#cfd3ff;}
.nt-launch{z-index:100700;flex-direction:column;background:#192042;opacity:0;transition:opacity .3s;pointer-events:none;}
.nt-launch.on{opacity:1;pointer-events:auto;}
.nt-lcard{display:flex;flex-direction:column;align-items:center;gap:12px;padding:16px;transform:translateY(14px) scale(.98);transition:transform .5s ease-out;}
.nt-launch.on .nt-lcard{transform:none;}
.nt-lthumb{width:min(340px,62vw);aspect-ratio:1;display:flex;align-items:center;justify-content:center;background:#212b58;}
.nt-lthumb img{width:100%;height:100%;object-fit:contain;image-rendering:pixelated;}
.nt-lthumb img.photo{object-fit:cover;image-rendering:auto;}
.nt-lthumb img.env{width:40%;height:40%;}
.nt-lname{max-width:90vw;font-size:40px;text-align:center;overflow-wrap:anywhere;}
.nt-launch .nt-meta{justify-content:center;font-size:18px;}
.nt-lbar{position:relative;width:min(340px,62vw);height:4px;margin-top:6px;overflow:hidden;background:rgba(255,255,255,.15);}
.nt-lbar::after{content:"";position:absolute;top:0;bottom:0;left:0;width:40%;background:#7272c2;animation:ntLoad 1s linear infinite;}
@keyframes ntLoad{from{transform:translateX(-100%);}to{transform:translateX(250%);}}
.nt-actions{display:flex;flex-wrap:wrap;gap:6px;align-items:center;justify-content:flex-end;}
.nt-actions .button{font-size:16px;padding:6px 12px;}
.nt-actions .nt-select{font-size:15px;padding:6px 8px;}
.nt-empty{padding:40px 24px;text-align:center;}
.nt-empty>h3{margin:0 0 10px;font-size:26px;font-weight:normal;}
.nt-empty>p{max-width:560px;margin:0 auto 18px;font-size:17px;line-height:1.4;color:rgba(255,255,255,.7);}
.nt-empty>div{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;}
.nt-foot{padding:10px 14px 16px;font-size:14px;color:rgba(255,255,255,.45);}
.nt-section{margin:16px 0 6px;padding-bottom:4px;font-size:15px;color:rgba(255,255,255,.55);border-bottom:1px solid rgba(255,255,255,.55);}
.nt-section:first-child{margin-top:0;}
.nt-text{margin:6px 0;font-size:16px;line-height:1.4;color:rgba(255,255,255,.8);}
.nt-text.dim{font-size:14px;color:rgba(255,255,255,.55);}
.nt-text.bad{color:#ff9a9a;}
.nt-text.good{color:#96ff96;}
.nt-field{display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.08);}
.nt-field>.nt-label{flex:1;min-width:0;}
.nt-field>.nt-label>p{margin:0;font-size:18px;}
.nt-field>.nt-label>small{display:block;margin-top:4px;font-size:13px;line-height:1.3;color:rgba(255,255,255,.55);}
.nt-field>.nt-control{display:flex;gap:8px;align-items:center;justify-content:flex-end;flex:0 1 auto;}
.nt-line{display:flex;gap:8px;align-items:center;margin-top:6px;}
.nt-line>.nt-input{flex:1;min-width:0;}
.nt-dialog{display:flex;flex-direction:column;width:min(640px,100%);max-height:calc(100vh - 24px);background:#28346a;clip-path:polygon(0 0,100% 0,calc(100% - 12px) 100%,0 100%);}
.nt-dialog.wide{width:min(860px,100%);}
.nt-dialog>h3{margin:0;padding:14px 18px 10px;font-size:24px;font-weight:normal;}
.nt-dialog>.nt-dbody{flex:1;min-height:0;overflow-y:auto;padding:12px 18px;background:#212b58;touch-action:pan-y;}
.nt-dialog>.nt-dbody .nt-row{padding:7px 0;}
.nt-dialog>.nt-dactions{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;padding:12px 18px;}
.nt-toast{position:fixed;left:50%;bottom:28px;z-index:100600;transform:translateX(-50%);max-width:calc(100vw - 32px);padding:10px 20px;background:#192042;color:#fff;font-family:ForcedSquare,Arial,sans-serif;font-style:italic;font-size:18px;box-shadow:inset 0 -2px 0 #7272c2;clip-path:polygon(6px 0,100% 0,calc(100% - 6px) 100%,0 100%);pointer-events:none;transition:opacity .25s;}
@media (max-width:720px){
.nt-top>h2{font-size:24px;}
.nt-row{flex-wrap:wrap;}
.nt-row>.nt-actions{width:100%;justify-content:flex-start;}
.nt-thumb{width:44px;height:44px;}
.nt-field{flex-wrap:wrap;}
.nt-field>.nt-control{width:100%;justify-content:flex-start;}
}
`;

    const styled = new Set();
    function css(text, id) {
        const key = id || text;
        if (styled.has(key)) return null;
        styled.add(key);
        const style = document.createElement("style");
        style.textContent = text;
        document.head.appendChild(style);
        return style;
    }
    const ensureCss = () => css(CSS, "nsws-tracks");

    function el(tag, cls, text) {
        const node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text != null) node.textContent = text;
        return node;
    }

    function button(label, onClick, opts = {}) {
        ensureCss();
        const b = el("button", "button" + (opts.primary ? " nt-primary" : "") + (opts.icon && !label ? " nt-icon" : ""));
        if (opts.icon) {
            const img = el("img");
            img.src = opts.icon.includes("/") ? opts.icon : "images/" + opts.icon + ".svg";
            img.alt = "";
            b.appendChild(img);
        }
        if (label) b.append(label);
        if (opts.title) b.title = opts.title;
        if (opts.disabled) b.disabled = true;
        b.addEventListener("click", (e) => {
            e.stopPropagation();
            try {
                window.__nswsUIClick?.();
            } catch {}
            onClick?.(e);
        });
        return b;
    }

    function keepKeys(node) {
        node.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Escape" && modals.length) {
                e.preventDefault();
                modals[modals.length - 1].cancel();
            } else if (e.key === "Escape" && screen && !screen.root.hidden && screen.root.contains(node)) {
                e.preventDefault();
                closeLibrary();
            }
        });
        node.addEventListener("keyup", (e) => e.stopPropagation());
        node.addEventListener("keypress", (e) => e.stopPropagation());
        return node;
    }

    function input(opts = {}) {
        ensureCss();
        const node = el(opts.multiline ? "textarea" : "input", opts.multiline ? "nt-area" : "nt-input");
        if (!opts.multiline) node.type = "text";
        if (opts.value != null) node.value = opts.value;
        if (opts.placeholder) node.placeholder = opts.placeholder;
        if (opts.maxLength) node.maxLength = opts.maxLength;
        if (opts.readOnly) node.readOnly = true;
        node.spellcheck = false;
        node.autocomplete = "off";
        if (opts.onInput) node.addEventListener("input", () => opts.onInput(node.value));
        return keepKeys(node);
    }

    function select(options, value, onChange) {
        const node = el("select", "nt-select");
        for (const o of options) {
            const opt = el("option", null, o.label);
            opt.value = o.id;
            node.appendChild(opt);
        }
        node.value = value;
        node.addEventListener("click", (e) => e.stopPropagation());
        node.addEventListener("change", () => onChange?.(node.value));
        return keepKeys(node);
    }

    const modeSelect = (value, onChange) => {
        const node = select(MODES, normMode(value), onChange);
        node.title = "Track mode";
        return node;
    };

    function check(checked, onChange) {
        const node = el("input", "nt-check");
        node.type = "checkbox";
        node.checked = !!checked;
        node.addEventListener("click", (e) => e.stopPropagation());
        node.addEventListener("change", () => onChange?.(node.checked));
        return node;
    }

    function field(label, control, help) {
        const row = el("div", "nt-field");
        const left = el("div", "nt-label");
        left.appendChild(el("p", null, label));
        if (help) left.appendChild(el("small", null, help));
        const right = el("div", "nt-control");
        for (const c of Array.isArray(control) ? control : [control]) if (c) right.appendChild(c);
        row.append(left, right);
        return row;
    }

    function section(text) {
        return el("div", "nt-section", text);
    }

    // Stops the game's touch steering and keybinds from seeing input meant for an overlay.
    function isolate(host) {
        for (const type of ["pointerdown", "pointerup", "pointermove", "mousedown", "mouseup", "mousemove", "touchstart", "touchmove", "touchend", "touchcancel", "wheel", "contextmenu", "click", "keyup", "keypress"]) {
            host.addEventListener(type, (e) => e.stopPropagation(), { passive: true });
        }
        host.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                e.preventDefault();
                if (modals.length) modals[modals.length - 1].cancel();
                else if (screen && !screen.root.hidden) closeLibrary();
            }
            e.stopPropagation();
        });
        host.tabIndex = -1;
        return host;
    }

    const modals = [];
    function dialog({ title, body, actions, wide, onClose } = {}) {
        ensureCss();
        const host = isolate(el("div", "nt-host nt-modal"));
        const box = el("div", "nt-dialog" + (wide ? " wide" : ""));
        if (title) box.appendChild(el("h3", null, title));
        const bodyEl = el("div", "nt-dbody");
        if (typeof body === "string") {
            const p = el("p", "nt-text", body);
            p.style.whiteSpace = "pre-line";
            bodyEl.appendChild(p);
        }
        else if (body) bodyEl.appendChild(body);
        const bar = el("div", "nt-dactions");
        box.append(bodyEl, bar);
        host.appendChild(box);
        let closed = false;
        const close = (value) => {
            if (closed) return;
            closed = true;
            host.remove();
            const i = modals.indexOf(entry);
            if (i >= 0) modals.splice(i, 1);
            const top = modals[modals.length - 1];
            (top ? top.host : screen && !screen.root.hidden ? screen.root : null)?.focus();
            try {
                onClose?.(value);
            } catch (e) {
                console.error(e);
            }
        };
        const entry = { host, cancel: () => close(undefined) };
        const setActions = (list) => {
            bar.replaceChildren();
            for (const a of list || [{ label: "Close" }]) {
                const b = button(a.label, async () => {
                    if (!a.onClick) return close(a.value);
                    b.disabled = true;
                    let result;
                    try {
                        result = await a.onClick(close);
                    } catch (e) {
                        console.error(e);
                        toast(e.message || "Something went wrong.");
                        result = false;
                    }
                    b.disabled = false;
                    if (result !== false) close(a.value ?? result);
                }, { primary: a.primary, icon: a.icon, disabled: a.disabled });
                a.button = b;
                bar.appendChild(b);
            }
        };
        setActions(actions);
        close.body = bodyEl;
        close.box = box;
        close.host = host;
        close.setActions = setActions;
        close.setTitle = (t) => {
            const h = box.querySelector("h3");
            if (h) h.textContent = t;
        };
        modals.push(entry);
        document.body.appendChild(host);
        host.focus();
        return close;
    }

    function alertBox(text, title) {
        return new Promise((resolve) => {
            dialog({ title: title || "Custom Tracks", body: text, actions: [{ label: "Ok", primary: true }], onClose: () => resolve() });
        });
    }

    function confirmBox(text, opts = {}) {
        return new Promise((resolve) => {
            dialog({
                title: opts.title || "Are you sure?",
                body: text,
                actions: [
                    { label: opts.cancel || "Cancel", value: false },
                    { label: opts.ok || "Ok", primary: true, value: true },
                ],
                onClose: (v) => resolve(v === true),
            });
        });
    }

    let toastTimer = 0;
    let toastEl = null;
    function toast(text) {
        ensureCss();
        if (!toastEl) {
            toastEl = el("div", "nt-toast");
            document.body.appendChild(toastEl);
        }
        toastEl.textContent = text;
        toastEl.style.opacity = "1";
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => (toastEl.style.opacity = "0"), 2600);
    }

    function copyText(text) {
        const fallback = () => {
            // The hidden textarea takes focus; without giving it back, Escape and keys would reach the game.
            const had = document.activeElement;
            const area = el("textarea");
            area.value = text;
            area.style.cssText = "position:fixed;left:-9999px;top:0;";
            document.body.appendChild(area);
            area.select();
            let ok = false;
            try {
                ok = document.execCommand("copy");
            } finally {
                area.remove();
                try {
                    had?.focus?.({ preventScroll: true });
                } catch {}
            }
            if (!ok) throw new Error("copy failed");
        };
        const done = () => toast("Copied");
        const fail = () => toast("Couldn't copy. Select the text and copy it yourself.");
        if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(done, () => { try { fallback(); done(); } catch { fail(); } });
        try {
            fallback();
            done();
        } catch {
            fail();
        }
        return Promise.resolve();
    }

    function kb(n) {
        return n < 1024 ? n + " B" : n < 1024 * 1024 ? Math.round(n / 1024) + " KB" : (n / 1024 / 1024).toFixed(1) + " MB";
    }

    function when(ms) {
        if (!ms) return "";
        const days = Math.floor((Date.now() - ms) / 86400000);
        if (days <= 0) return "today";
        if (days === 1) return "yesterday";
        if (days < 30) return days + " days ago";
        return new Date(ms).toLocaleDateString();
    }

    function thumbNode(track) {
        const box = el("div", "nt-thumb");
        const img = el("img");
        img.alt = "";
        if (track.image) {
            img.src = track.image;
            img.className = "photo";
        } else if (track.thumb) img.src = track.thumb;
        else {
            img.className = "env";
            img.src = "images/" + (track.env || "summer").toLowerCase() + ".svg";
        }
        box.appendChild(img);
        return box;
    }

    function metaNode(info, extra, allModes) {
        const meta = el("div", "nt-meta");
        meta.appendChild(el("span", null, info.author ? "by " + info.author : "no author"));
        if (info.env) meta.appendChild(el("span", null, info.env));
        if (info.kind === "be") meta.appendChild(el("span", "nt-chip be", "Better Editor"));
        if (allModes || normMode(info.mode) !== "normal") meta.appendChild(el("span", "nt-chip mode", MODE_LABEL[normMode(info.mode)]));
        if (extra) meta.appendChild(el("span", null, extra));
        return meta;
    }

    // The track page: the track big, your best, its leaderboard (pick runs to race as ghosts), and Play.
    const BOARD_PAGE = 25;
    const GHOSTS_MAX = 5;
    const fmtTime = (frames) => {
        const ms = Math.max(0, Math.round(frames));
        return Math.floor(ms / 60000) + ":" + String(Math.floor(ms / 1000) % 60).padStart(2, "0") + "." + String(ms % 1000).padStart(3, "0");
    };

    function pickImageFile() {
        return new Promise((resolve) => {
            const inp = document.createElement("input");
            inp.type = "file";
            inp.accept = "image/*";
            inp.addEventListener("change", () => resolve(inp.files?.[0] || null));
            inp.click();
        });
    }

    // Square-crops a picture and shrinks it until it fits in the track details that sync with the account.
    async function imageThumb(file) {
        if (!/^image\//.test(file?.type || "")) throw new Error("Pick an image file.");
        if (file.size > 25e6) throw new Error("That image is too big (25 MB at most).");
        let bmp;
        try {
            bmp = await createImageBitmap(file);
        } catch {
            throw new Error("That image couldn't be read.");
        }
        try {
            for (const size of [256, 192, 128]) {
                const c = document.createElement("canvas");
                c.width = c.height = size;
                const g = c.getContext("2d");
                const s = Math.max(size / bmp.width, size / bmp.height);
                g.imageSmoothingQuality = "high";
                g.drawImage(bmp, (size - bmp.width * s) / 2, (size - bmp.height * s) / 2, bmp.width * s, bmp.height * s);
                for (const q of [0.85, 0.72, 0.6, 0.48]) {
                    const url = c.toDataURL("image/jpeg", q);
                    if (url.length <= IMAGE_MAX) return url;
                }
            }
        } finally {
            bmp.close?.();
        }
        throw new Error("That image couldn't be made small enough.");
    }

    let openPage = null;
    // opts.anchor: a My Tracks row, which the page drops down under instead of covering the screen.
    function openTrackPage(track, opts = {}) {
        ensureCss();
        if (!opts.anchor && !opts.overlay && track?.id && screen && !screen.root.hidden && screen.current === "tracks" && screen.panes.get("tracks")?.__ntOpen?.(track, opts)) return () => openPage?.();
        const inline = !!opts.anchor;
        // A double click on a row would stack two pages, and Escape would only close the top one.
        openPage?.();
        let t = track;
        // Better Editor physics version being shown; null is the current one.
        let physicsView = Number.isSafeInteger(opts.physics) ? opts.physics : null;
        let older = [];
        const board = window.__nswsTrackBoard;
        let online = false;
        let stats = null;
        let resent = false;
        // A Better Editor track gets its id once the blocks have loaded, so this can run again later.
        const goOnline = () => {
            if (online || !board || !t.trackId) return false;
            online = true;
            if (t.kind === "be") (window.__nswsBEBoardIds ??= new Set()).add(t.trackId);
            const me0 = user();
            if (me0.token && TRACK_ID.test(t.trackId || ""))
                api("nsws/tracks/stats", { token: me0.token, trackId: t.trackId }).then((s) => {
                    stats = s;
                    if (!closed) drawHero();
                }, () => {});
            return true;
        };
        goOnline();
        const isCreator = () => {
            const nick = (user().nickname || "").trim().toLowerCase();
            return t.source === "editor" || (!!nick && (t.author || "").trim().toLowerCase() === nick);
        };
        const host = inline ? el("div", "nt-drop") : isolate(el("div", "nt-host nt-page"));
        host.tabIndex = -1;
        const wrap = el("div", "nt-pwrap");
        const top = el("div", "nt-ptop");
        const body = el("div", "nt-pbody");
        const hero = el("div", "nt-hero");
        const boardEl = el("div", "nt-board");
        body.append(hero, boardEl);
        if (inline) host.append(body);
        else {
            wrap.append(top, body);
            host.append(wrap);
        }
        let closed = false;
        const unsub = onChange(() => {
            if (!t.id) return;
            get(t.id).then((x) => {
                if (x && !closed) {
                    t = x;
                    if (goOnline()) loadBoard(false);
                    drawHero();
                }
            }, () => {});
        });
        // instant: no folding away (the row it hangs under is gone).
        const close = (instant) => {
            if (closed) return;
            closed = true;
            if (openPage === close) openPage = null;
            unsub();
            const i = modals.indexOf(entry);
            if (i >= 0) modals.splice(i, 1);
            if (!inline) {
                host.remove();
                (screen && !screen.root.hidden ? screen.root : null)?.focus();
                return;
            }
            opts.onClose?.();
            if (instant === true || !host.isConnected) return void host.remove();
            host.style.height = host.offsetHeight + "px";
            void host.offsetHeight;
            host.style.height = "0px";
            const done = () => host.remove();
            host.addEventListener("transitionend", done, { once: true });
            setTimeout(done, 400);
        };
        const entry = { host, cancel: () => close() };
        if (!inline) top.append(button("Back", () => close(), { icon: "back" }), el("h2", null, "Track"));

        let mapSrc;
        const mapImage = () => {
            if (mapSrc === undefined) {
                const loaded = t.kind === "be" && !beReady() ? null : stockParse(t.code);
                mapSrc = (loaded?.data && bigThumb(loaded.data)) || t.thumb || null;
            }
            return mapSrc;
        };

        // Runs picked on the leaderboard, as PolyTrack's own play menu does: Play races them, Watch replays them (with
        // none picked, both use your best).
        const ghosts = new Map();
        const playBtn = button("Play", () => start(), { icon: "play", primary: true });
        playBtn.classList.add("nt-pplay");
        const watchBtn = button("Watch", () => watch(), { icon: "preview", title: "Replay the picked runs, or your best" });
        const playLabel = () => {
            const n = ghosts.size;
            playBtn.lastChild.textContent = n ? "Play vs " + n + (n === 1 ? " ghost" : " ghosts") : "Play";
            watchBtn.lastChild.textContent = n ? "Watch " + n + (n === 1 ? " run" : " runs") : "Watch your best";
            watchBtn.disabled = !n && !myRecord()?.recording;
        };
        function toggleGhost(key, ghost, b) {
            if (ghosts.has(key)) ghosts.delete(key);
            else if (ghosts.size >= GHOSTS_MAX) {
                toast("You can pick " + GHOSTS_MAX + " runs at most.");
                return;
            } else ghosts.set(key, ghost);
            b.classList.toggle("on", ghosts.has(key));
            b.closest(".nt-brow")?.classList.toggle("picked", ghosts.has(key));
            playLabel();
        }

        let entries = [];
        let total = 0;
        let userEntry = null;
        let loadingBoard = false;
        let boardError = null;
        const myRecord = () => {
            try {
                return t.trackId && board ? board.record(t.trackId) : null;
            } catch {
                return null;
            }
        };

        function drawHero() {
            const src = t.image || mapImage();
            hero.replaceChildren();
            const pic = el("div", "nt-lthumb");
            const img = el("img");
            img.alt = "";
            if (t.image) {
                img.src = t.image;
                img.className = "photo";
            } else if (src) img.src = src;
            else {
                img.className = "env";
                img.src = "images/" + (t.env || "summer").toLowerCase() + ".svg";
            }
            pic.appendChild(img);
            hero.appendChild(pic);
            if (t.id && isCreator()) {
                // Picture (the creator's choice, shared with the track): the map PolyTrack draws from it, or an uploaded one.
                const picBar = el("div", "nt-line");
                picBar.appendChild(el("span", "nt-text dim", "Picture"));
                picBar.appendChild(button("Map icon", async () => {
                    if (t.kind === "be" && !beReady()) {
                        let ok = false;
                        try {
                            ok = await ensureBE();
                        } catch {}
                        if (!ok || closed) return;
                    }
                    mapSrc = undefined;
                    if (t.image) t = await update(t.id, { image: null });
                    drawHero();
                    if (!mapImage()) toast("PolyTrack couldn't draw a map for this track.");
                }, { icon: "images/" + (t.env || "summer").toLowerCase() + ".svg", primary: !t.image, title: "Use the map PolyTrack draws from the track" }));
                picBar.appendChild(button(t.image ? "Change picture" : "Upload picture", async () => {
                    const file = await pickImageFile();
                    if (!file || closed) return;
                    try {
                        t = await update(t.id, { image: await imageThumb(file) });
                        drawHero();
                        toast("Picture saved");
                    } catch (e) {
                        toast(e.message || "Couldn't use that picture.");
                    }
                }, { icon: "load", primary: !!t.image, title: "Use your own picture for this track; it goes with the track when you share it" }));
                hero.appendChild(picBar);
            }
            // Under its row, the row already names the track.
            if (!inline) hero.append(el("div", "nt-ptitle", t.name || "Untitled track"), metaNode(t));
            const statsEl = el("div", "nt-pstats");
            const rec = myRecord();
            statsEl.append(el("span", null, "Your best"), el("span", null, rec ? fmtTime(rec.time.numberOfFrames) : "No time yet"));
            if (online && userEntry && !physicsView) statsEl.append(el("span", null, "Rank"), el("span", null, "#" + userEntry.position + (total ? " of " + total : "")));
            if (stats) statsEl.append(el("span", null, "Players"), el("span", null, String(stats.players)), el("span", null, "Favourites"), el("span", null, String(stats.favourites)));
            hero.appendChild(statsEl);
            if (rec?.recording) {
                const own = el("div", "nt-line");
                const g = el("button", "nt-gbtn" + (ghosts.has("self") ? " on" : ""), "Pick");
                g.type = "button";
                g.addEventListener("click", () => toggleGhost("self", { self: true }, g));
                own.append(g, el("span", "nt-text dim", "Your best, to race or watch with the others"));
                hero.appendChild(own);
            }
            const acts = el("div", "nt-line");
            acts.append(playBtn, watchBtn);
            if (t.id) acts.append(button("Edit", () => openInEditor(t), { icon: "editor" }), button("Share", () => openShare([t]), { icon: "share" }));
            if (t.id) acts.append(button(t.favourite ? "Favourite" : "Favourite", async () => {
                try {
                    const r = await setFavourite(t, !t.favourite);
                    t = r.track;
                    if (r.stats && !r.stats.error) stats = r.stats;
                    if (!closed) drawHero();
                } catch (e) {
                    toast(e.message || "Couldn't change that.");
                }
            }, { icon: t.favourite ? "nsws_star_on" : "nsws_star", primary: !!t.favourite, title: t.favourite ? "Remove from favourites" : "Add to favourites" }));
            hero.appendChild(acts);
            playLabel();
        }

        function boardRow(e, rank) {
            const r = el("div", "nt-brow" + (e.isSelf ? " me" : ""));
            r.appendChild(el("span", "rank" + (rank <= 3 ? " top" : ""), String(rank)));
            const flag = el("span");
            if (typeof e.countryCode === "string" && /^[a-z]{2}$/i.test(e.countryCode)) {
                const f = el("img", "flag");
                f.src = "images/countries/" + e.countryCode.toLowerCase() + ".svg";
                f.alt = "";
                f.onerror = () => f.remove();
                flag.appendChild(f);
            }
            const nick = el("span", "nick", e.nickname || "?");
            nick.title = "Open profile";
            nick.addEventListener("click", (ev) => {
                ev.stopPropagation();
                window.__nswsProfile?.open(e.nickname, { carStyle: e.carStyle, countryCode: e.countryCode });
                const p = document.getElementById("nsws-profile");
                if (p) p.style.zIndex = "100650";
            });
            r.append(flag, nick, el("span", "time", e.hidden ? "hidden" : fmtTime(e.time.numberOfFrames)));
            if (physicsView) {
                const ref = older.find((o) => o.physics === physicsView)?.ref;
                const w = el("button", "nt-gbtn", "Watch");
                w.type = "button";
                w.disabled = !ref;
                w.title = ref ? "Replay this run on the physics it was driven on" : "That physics version wasn't kept, so its runs can't be replayed";
                w.addEventListener("click", () => watchOld(e, ref, w));
                r.appendChild(w);
                return r;
            }
            const key = "e" + e.id;
            const can = !e.hidden && !e.noReplay && e.id > 0;
            const g = el("button", "nt-gbtn" + (ghosts.has(key) ? " on" : ""), "Pick");
            g.type = "button";
            g.disabled = !can;
            g.title = can ? "Pick this run to race or watch" : "This run has no replay";
            const pick = (ev) => {
                ev.stopPropagation();
                toggleGhost(key, { id: e.id, nickname: e.nickname, isSelf: !!e.isSelf }, g);
            };
            g.addEventListener("click", pick);
            // The whole row picks it, as in PolyTrack's own leaderboard.
            if (can) {
                r.classList.add("pick");
                r.classList.toggle("picked", ghosts.has(key));
                r.addEventListener("click", pick);
            }
            r.appendChild(g);
            return r;
        }

        function drawBoard() {
            boardEl.replaceChildren();
            const head = el("div", "nt-bhead");
            head.append(el("span", null, "Leaderboard"), el("span", null, online && total ? total + (total === 1 ? " driver" : " drivers") : ""));
            const list = el("div", "nt-blist");
            boardEl.append(head, list);
            if (!online) {
                list.appendChild(el("p", "nt-text dim nt-bmsg", board && t.kind === "be" && !beReady() ? "The leaderboard shows once the Better Editor blocks have loaded. Press Play to load them." : "The leaderboard isn't available on this copy of the site."));
                return;
            }
            if (t.kind === "be" && (older.length || physicsView)) {
                const vers = el("div", "nt-line nt-bvers");
                const chip = (label, v) => {
                    const b = el("button", "nt-gbtn" + (physicsView === v ? " on" : ""), label);
                    b.type = "button";
                    b.addEventListener("click", () => {
                        if (physicsView === v || loadingBoard) return;
                        physicsView = v;
                        entries = [];
                        loadBoard(false);
                        drawHero();
                    });
                    return b;
                };
                vers.append(chip("Current physics", null), ...older.map((o) => chip("Old physics v" + o.physics + " (" + o.total + ")", o.physics)));
                list.appendChild(vers);
            }
            if (physicsView) list.appendChild(el("p", "nt-text dim nt-bmsg", "Times set before a Better Editor physics change (physics v" + physicsView + "). They don't count any more. Watch replays a run on the physics it was driven on."));
            else if (t.kind === "be") list.appendChild(el("p", "nt-text dim nt-bmsg", "Better Editor board, kept by NSWS: the anti-cheat can't replay runs on these blocks yet."));
            if (boardError) {
                list.append(el("p", "nt-text bad nt-bmsg", boardError), button("Try again", () => loadBoard(false), { icon: "refresh" }));
                return;
            }
            if (!entries.length) {
                list.appendChild(el("p", "nt-text dim nt-bmsg", loadingBoard ? "Loading..." : "No times yet. Set the first one!"));
                return;
            }
            entries.forEach((e, i) => list.appendChild(boardRow(e, i + 1)));
            if (entries.length < total) {
                const more = button(loadingBoard ? "Loading..." : "Show more", () => loadBoard(true), { disabled: loadingBoard });
                more.classList.add("nt-bmore");
                list.appendChild(more);
            }
        }

        async function loadBoard(more) {
            if (!online || loadingBoard) return;
            loadingBoard = true;
            boardError = null;
            drawBoard();
            let resend = false;
            try {
                const landing = !more && pendingUploads.get(t.trackId);
                if (landing) await Promise.race([landing, new Promise((res) => setTimeout(res, 8000))]);
                const res = t.kind === "be" ? await bePage(more ? entries.length : 0) : await board.page(t.trackId, more ? entries.length : 0, BOARD_PAGE);
                entries = more ? entries.concat(res.entries) : res.entries;
                total = res.total;
                if (!physicsView) userEntry = res.userEntry;
                if (!more && !physicsView && userEntry && !myRecord()) restoreBest(t.trackId).then((ok) => ok && !closed && drawHero());
                else resend = !more && !physicsView && !resent && !!myRecord();
            } catch (e) {
                console.warn(e);
                boardError = "Couldn't load the leaderboard. Check your connection and try again.";
            }
            loadingBoard = false;
            if (closed) return;
            drawBoard();
            drawHero();
            if (resend) resendBest();
        }

        // A PB on this device that never reached the board (its upload failed) is sent again, once per page.
        async function resendBest() {
            if (!board.sync) return;
            resent = true;
            let r = null;
            try {
                r = await board.sync(t.trackId, userEntry);
            } catch (e) {
                console.warn(e);
                if (!closed) toast("Your best time couldn't be sent to the leaderboard: " + (e?.message || "upload failed") + ". It will be tried again next time you open this track.");
                return;
            }
            if (r === "Upload" && !closed) {
                toast("Your best time was sent to the leaderboard.");
                loadBoard(false);
            }
        }

        // NSWS's own board for Better Editor tracks, read directly so it can show older physics versions.
        async function bePage(skip) {
            let hash = null;
            try {
                hash = board.profile()?.tokenHash || null;
            } catch {}
            const q = "nsws/tracks/board?trackId=" + t.trackId + "&skip=" + skip + "&amount=" + BOARD_PAGE + (physicsView ? "&physics=" + physicsView : "") + (hash ? "&userTokenHash=" + encodeURIComponent(hash) : "");
            const d = await api(q);
            if (Number.isSafeInteger(d.current)) window.__nswsBEPhysicsNow = d.current;
            older = Array.isArray(d.older) ? d.older : [];
            if (physicsView && d.physics !== physicsView) physicsView = null;
            const style = (s) => {
                try {
                    return window.__clipCarStyleClass?.deserializeSafe(s) ?? null;
                } catch {
                    return null;
                }
            };
            return {
                total: d.total || 0,
                userEntry: d.userEntry || null,
                entries: (d.entries || []).map((e) => ({ id: e.id, nickname: e.nickname, countryCode: e.countryCode, carStyle: style(e.carStyle), time: { numberOfFrames: e.frames }, isSelf: !!hash && e.userId === hash })),
            };
        }

        async function watchOld(e, ref, btn) {
            const base = window.__nswsApiBase;
            if (!ref || !base) return;
            btn.disabled = true;
            const view = physicsView;
            try {
                const [r] = await board.recordings([e.id]);
                if (!r) throw new Error("This run has no replay.");
                const tmBase = base + "be@" + ref + "/";
                if (!(await preloadPhysics(tmBase, view))) return;
                const id = t.id;
                const back = () => {
                    openLibrary();
                    (id ? get(id) : Promise.resolve(null)).then((x) => openTrackPage(x || t, { physics: view }), () => openTrackPage(t, { physics: view }));
                };
                await play(t, { watch: { runs: [{ recording: r.recording, carStyle: r.carStyle, nickname: e.nickname, time: r.time, isSelf: false }], tmBase }, onExit: back });
            } catch (err) {
                console.warn(err);
                toast(err.message === "This run has no replay." ? err.message : "Couldn't load that run's physics. Check your connection and try again.");
            } finally {
                btn.disabled = false;
            }
        }

        // The picked runs as the game takes them (ghosts to race, or runs to watch).
        async function pickedRuns(btn) {
            btn.disabled = true;
            const list = [];
            try {
                const picked = [...ghosts.values()];
                const remote = picked.filter((g) => g.id);
                if (remote.length) {
                    const runs = await board.recordings(remote.map((g) => g.id));
                    runs.forEach((r, i) => r && list.push({ recording: r.recording, carStyle: r.carStyle, nickname: remote[i].nickname, time: r.time, isSelf: false }));
                }
                const rec = ghosts.has("self") ? myRecord() : null;
                if (rec) {
                    const me = board.profile();
                    list.push({ recording: rec.recording, carStyle: me?.carStyle, nickname: me?.nickname || "You", time: rec.time, isSelf: true });
                }
            } catch (e) {
                console.warn(e);
                list.failed = true;
            }
            btn.disabled = false;
            return list;
        }
        const back = (opts) => {
            const id = t.id;
            openLibrary();
            (id ? get(id) : Promise.resolve(null)).then((x) => openTrackPage(x || t, opts), () => openTrackPage(t, opts));
        };

        async function watch() {
            let runs = await pickedRuns(watchBtn);
            if (!ghosts.size) {
                const rec = myRecord();
                const me = board?.profile();
                runs = rec?.recording ? [{ recording: rec.recording, carStyle: me?.carStyle, nickname: me?.nickname || "You", time: rec.time, isSelf: true }] : [];
            }
            playLabel();
            if (!runs.length) {
                toast(runs.failed ? "Couldn't load those runs. Check your connection and try again." : "Pick runs on the leaderboard to watch them.");
                return;
            }
            if (runs.failed) toast("Some runs didn't load.");
            await play(t, { watch: { runs }, onExit: () => back() });
        }

        async function start() {
            const list = await pickedRuns(playBtn);
            playLabel();
            if (list.failed) toast("Couldn't load the ghosts, so you're racing alone.");
            const id = t.id;
            const back = () => {
                openLibrary();
                (id ? get(id) : Promise.resolve(null)).then((x) => openTrackPage(x || t), () => openTrackPage(t));
            };
            await play(t, { start: true, intro: true, ghosts: list, onExit: back });
        }

        modals.push(entry);
        openPage = close;
        drawHero();
        drawBoard();
        loadBoard(false);
        if (!inline) {
            document.body.appendChild(host);
            host.focus();
            return close;
        }
        // Drops down from the row, then stays its natural height (the board loads after).
        opts.anchor.after(host);
        opts.onMount?.(host);
        host.style.height = "0px";
        void host.offsetHeight;
        host.style.height = body.offsetHeight + "px";
        const opened = (e) => {
            if (e && e.target !== host) return;
            host.removeEventListener("transitionend", opened);
            if (closed) return;
            host.style.height = "";
            host.scrollIntoView({ block: "nearest", behavior: "smooth" });
        };
        host.addEventListener("transitionend", opened);
        setTimeout(opened, 400);
        return close;
    }

    // The Custom Tracks screen.
    const tabs = [];
    let screen = null;
    let pendingTab = null;

    function buildScreen() {
        ensureCss();
        const root = isolate(el("div", "nt-host nt-screen"));
        root.hidden = true;
        const panel = el("div", "nt-panel");
        const top = el("div", "nt-top");
        top.appendChild(button("Back", () => closeLibrary(), { icon: "back" }));
        top.appendChild(el("h2", null, "Custom Tracks"));
        const editorBtn = button("Track Editor", () => openInEditor(null), { icon: "editor" });
        top.appendChild(editorBtn);
        const tabBar = el("div", "nt-tabs");
        const scroll = el("div", "nt-scroll");
        panel.append(top, tabBar, scroll);
        root.appendChild(panel);
        document.body.appendChild(root);
        screen = { root, tabBar, scroll, editorBtn, current: null, panes: new Map(), buttons: new Map() };
        for (const t of tabs) addTabButton(t);
    }

    function addTabButton(tab) {
        const b = el("button", "nt-tab", tab.label);
        b.addEventListener("click", () => {
            try {
                window.__nswsUIClick?.();
            } catch {}
            showTab(tab.id);
        });
        screen.tabBar.appendChild(b);
        screen.buttons.set(tab.id, b);
    }

    function showTab(id) {
        const tab = tabs.find((t) => t.id === id) || tabs[0];
        if (!tab) return;
        screen.current = tab.id;
        for (const [tid, b] of screen.buttons) b.classList.toggle("on", tid === tab.id);
        for (const [tid, pane] of screen.panes) pane.hidden = tid !== tab.id;
        let pane = screen.panes.get(tab.id);
        if (!pane) {
            pane = el("div", "nt-pane");
            screen.panes.set(tab.id, pane);
            screen.scroll.appendChild(pane);
            try {
                tab.render(pane, api_);
            } catch (e) {
                console.error(e);
                pane.appendChild(el("p", "nt-text bad", "This tab couldn't load."));
            }
        }
        screen.scroll.scrollTop = 0;
        try {
            tab.onShow?.(pane, api_);
        } catch (e) {
            console.error(e);
        }
    }

    function openLibrary(tab) {
        if (!screen) buildScreen();
        screen.editorBtn.hidden = !window.__nswsEditor?.open;
        screen.root.hidden = false;
        window.__nswsMainMenu?.hide();
        sync().catch(() => {});
        const wanted = tab || screen.current || "tracks";
        if (tab && !tabs.some((t) => t.id === tab)) pendingTab = tab;
        showTab(tabs.some((t) => t.id === wanted) ? wanted : "tracks");
        screen.root.focus();
        return true;
    }

    // keepMenu: a race is about to replace the main menu, so its buttons stay hidden.
    function closeLibrary(keepMenu) {
        if (!screen || screen.root.hidden) return;
        screen.root.hidden = true;
        if (keepMenu !== true) window.__nswsMainMenu?.show();
    }

    function closeAll(keepMenu) {
        while (modals.length) modals[modals.length - 1].cancel();
        closeLibrary(keepMenu);
    }

    function registerTab(tab) {
        if (!tab?.id || typeof tab.render !== "function") return;
        const i = tabs.findIndex((t) => t.id === tab.id);
        if (i >= 0) tabs[i] = tab;
        else tabs.push(tab);
        if (screen && i < 0) addTabButton(tab);
        if (screen && pendingTab === tab.id && !screen.root.hidden) {
            pendingTab = null;
            showTab(tab.id);
        }
    }

    function renderMyTracks(pane) {
        const state = { q: "", sort: "recent", filter: "all", selecting: false, selected: new Set(), tracks: [], loaded: false };
        const toolbar = el("div", "nt-toolbar");
        const listEl = el("div");
        const foot = el("div", "nt-foot");
        pane.append(toolbar, listEl, foot);

        const search = input({ placeholder: "Search name or author", onInput: (v) => { state.q = v.trim().toLowerCase(); draw(); } });
        search.classList.add("nt-grow");
        const sort = select([{ id: "recent", label: "Recent" }, { id: "name", label: "Name" }, { id: "author", label: "Author" }], "recent", (v) => { state.sort = v; draw(); });
        sort.title = "Sort";
        const filter = select(
            [{ id: "all", label: "All tracks" }, { id: "fav", label: "Favourites" }, { id: "normal", label: "Normal" }, { id: "rocket", label: "Rocket League" }, { id: "royale", label: "Royale" }, { id: "be", label: "Better Editor" }, { id: "stock", label: "Plays in NSWS" }],
            "all",
            (v) => { state.filter = v; draw(); }
        );
        filter.title = "Show";

        function drawToolbar() {
            toolbar.replaceChildren();
            if (state.selecting) {
                const bar = el("div", "nt-selbar");
                const visible = shown();
                bar.appendChild(el("span", null, state.selected.size + " selected"));
                bar.appendChild(button(visible.length && visible.every((t) => state.selected.has(t.id)) ? "Select none" : "Select all", () => {
                    const all = visible.every((t) => state.selected.has(t.id));
                    for (const t of visible) all ? state.selected.delete(t.id) : state.selected.add(t.id);
                    draw();
                }));
                bar.appendChild(button("Share selected", () => openShare(state.tracks.filter((t) => state.selected.has(t.id))), { icon: "share", primary: true, disabled: !state.selected.size }));
                bar.appendChild(button("Delete", async () => {
                    const n = state.selected.size;
                    if (!(await confirmBox("Delete " + n + (n === 1 ? " track" : " tracks") + " from My Tracks? This can't be undone.", { title: "Delete tracks", ok: "Delete" }))) return;
                    for (const id of [...state.selected]) await deleteTrack(id);
                    state.selected.clear();
                    emit({ type: "remove" });
                    toast("Deleted " + n + (n === 1 ? " track" : " tracks"));
                }, { icon: "delete", disabled: !state.selected.size }));
                bar.appendChild(button("Done", () => { state.selecting = false; state.selected.clear(); draw(); }));
                toolbar.appendChild(bar);
                return;
            }
            toolbar.append(
                button("Import", () => openImport(), { icon: "import", primary: true }),
                button("Select", () => { state.selecting = true; draw(); }, { icon: "list", disabled: !state.tracks.length }),
                search,
                sort,
                filter
            );
        }

        function shown() {
            let out = state.tracks.filter((t) => {
                if (state.q && !((t.name || "").toLowerCase().includes(state.q) || (t.author || "").toLowerCase().includes(state.q))) return false;
                if (state.filter === "fav") return !!t.favourite;
                if (state.filter === "be" || state.filter === "stock") return t.kind === state.filter;
                if (state.filter !== "all") return normMode(t.mode) === state.filter;
                return true;
            });
            if (state.sort === "name") out = out.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
            else if (state.sort === "author") out = out.sort((a, b) => (a.author || "").localeCompare(b.author || "") || (a.name || "").localeCompare(b.name || ""));
            return out;
        }

        function row(t) {
            const r = el("div", "nt-row" + (state.selected.has(t.id) ? " sel" : ""));
            if (state.selecting) {
                r.classList.add("pick");
                const toggle = () => {
                    state.selected.has(t.id) ? state.selected.delete(t.id) : state.selected.add(t.id);
                    draw();
                };
                r.appendChild(check(state.selected.has(t.id), toggle));
                r.addEventListener("click", toggle);
            }
            r.appendChild(thumbNode(t));
            const info = el("div", "nt-info");
            const name = el("div", "nt-name", t.name || "Untitled track");
            name.title = t.name || "";
            info.append(name, metaNode(t, "added " + when(t.added)));
            r.appendChild(info);
            r.dataset.ntId = t.id;
            if (!state.selecting) {
                r.classList.add("open");
                r.title = "Show the leaderboard";
                r.addEventListener("click", () => (drop.id === t.id ? drop.close?.() : dropDown(t, r)));
                const actions = el("div", "nt-actions");
                actions.append(
                    button("Play", () => play(t, { start: true, intro: true, onExit: () => openLibrary() }), { icon: "play", title: "Play" }),
                    button("Edit", () => openInEditor(t), { icon: "editor", title: "Open in the Track Editor" }),
                    button("Share", () => openShare([t]), { icon: "share", title: t.submitted ? "Submitted to Weekly Shorts" : "Share, or submit to Weekly Shorts" }),
                    button("", () => setFavourite(t, !t.favourite).catch((e) => toast(e.message)), { icon: t.favourite ? "nsws_star_on" : "nsws_star", title: t.favourite ? "Favourite (click to remove)" : "Add to favourites" }),
                    button("", async () => {
                        if (!(await confirmBox("Delete \"" + (t.name || "Untitled track") + "\" from My Tracks? This can't be undone.", { title: "Delete track", ok: "Delete" }))) return;
                        await remove(t.id);
                        toast("Deleted " + (t.name || "track"));
                    }, { icon: "delete", title: "Delete" })
                );
                r.appendChild(actions);
            }
            return r;
        }

        // The track page that hangs under a row (openTrackPage with an anchor), and one asked for before its row was drawn
        // (coming back from a race).
        const drop = { id: null, node: null, close: null };
        let wanted = null;
        const rowOf = (id) => [...listEl.children].find((r) => r.dataset?.ntId === String(id)) || null;
        function dropDown(t, r, opts = {}) {
            const id = t.id;
            r.classList.add("expanded");
            const close = openTrackPage(t, {
                ...opts,
                anchor: r,
                onMount: (node) => {
                    drop.id = id;
                    drop.node = node;
                },
                onClose: () => {
                    rowOf(id)?.classList.remove("expanded");
                    if (drop.id === id) drop.id = drop.node = drop.close = null;
                },
            });
            if (drop.id === id) drop.close = close;
        }
        function mountWanted() {
            if (!wanted || !state.loaded) return;
            const w = wanted;
            const r = rowOf(w.track.id);
            wanted = null;
            if (r && !state.selecting) dropDown(w.track, r, w.opts);
            else openTrackPage(w.track, { ...w.opts, overlay: true });
        }
        pane.__ntOpen = (track, opts) => {
            wanted = { track, opts };
            mountWanted();
            return true;
        };

        function draw() {
            drawToolbar();
            if (drop.node) drop.node.remove();
            listEl.replaceChildren();
            if (!state.loaded) return;
            if (!state.tracks.length) {
                drop.close?.(true);
                const empty = el("div", "nt-empty");
                empty.appendChild(el("h3", null, "No custom tracks yet"));
                empty.appendChild(el("p", null, "Use Import to paste an NSWS Track code, an NSWS track link, or a code from PolyTrack or the Better Editor. Tracks you save in the Track Editor or from a club campaign land here too."));
                const buttons = el("div");
                buttons.appendChild(button("Import", () => openImport(), { icon: "import", primary: true }));
                if (window.__nswsEditor?.open) buttons.appendChild(button("Open Track Editor", () => openInEditor(null), { icon: "editor" }));
                empty.appendChild(buttons);
                listEl.appendChild(empty);
                foot.textContent = memoryOnly ? "This browser blocks saved site data, so tracks are kept only until you close the page." : syncNote();
                return;
            }
            const visible = shown();
            if (!visible.length) listEl.appendChild(el("div", "nt-empty", "No tracks match."));
            for (const t of visible) listEl.appendChild(row(t));
            // The open track page moves under its redrawn row, or goes with it.
            if (drop.node) {
                const r = rowOf(drop.id);
                if (r && !state.selecting) {
                    r.classList.add("expanded");
                    r.after(drop.node);
                } else drop.close?.(true);
            }
            mountWanted();
            foot.textContent =
                (visible.length === state.tracks.length ? state.tracks.length + (state.tracks.length === 1 ? " track" : " tracks") : visible.length + " of " + state.tracks.length + " tracks") +
                (memoryOnly ? ". This browser blocks saved site data, so tracks are kept only until you close the page." : syncNote() ? ". " + syncNote() : "");
        }

        async function reload() {
            state.token = user().token;
            try {
                state.tracks = await list();
            } catch (e) {
                state.tracks = [];
                console.error(e);
            }
            state.loaded = true;
            for (const id of [...state.selected]) if (!state.tracks.some((t) => t.id === id)) state.selected.delete(id);
            draw();
        }

        onChange(() => {
            if (screen && !screen.root.hidden) reload();
            else stale = true;
        });
        let stale = true;
        pane.__ntShow = () => {
            // Switching profiles in the game changes whose My Tracks this is, without any change event.
            if (stale || state.token !== user().token) {
                stale = false;
                reload();
            }
        };
        draw();
    }

    tabs.push({
        id: "tracks",
        label: "My Tracks",
        render: renderMyTracks,
        onShow: (pane) => pane.__ntShow?.(),
    });

    // Import.
    function openImport(prefill, opts = {}) {
        const body = el("div");
        body.appendChild(el("p", "nt-text dim", "Paste an NSWS Track code, an NSWS track link, a club invite, or codes from PolyTrack or the Better Editor (one per line)."));
        const area = input({ multiline: true, placeholder: "PolyTrack2...  /  NSWSPack1...  /  https://notweeklyshorts.github.io/?tracks=..." });
        body.appendChild(area);
        const line = el("div", "nt-line");
        const status = el("p", "nt-text dim", "");
        status.style.margin = "0 auto 0 0";
        const fileInput = el("input");
        fileInput.type = "file";
        fileInput.accept = ".txt,.json,text/plain,application/json";
        fileInput.hidden = true;
        fileInput.addEventListener("change", async () => {
            const file = fileInput.files?.[0];
            fileInput.value = "";
            if (!file) return;
            if (file.size > 8 * 1024 * 1024) return toast("That file is too big.");
            area.value = await file.text();
            read();
        });
        line.append(status, fileInput, button("Open file", () => fileInput.click(), { icon: "load" }), button("Read", () => read(), { icon: "refresh" }));
        body.appendChild(line);
        const preview = el("div");
        body.appendChild(preview);

        let items = [];
        let packName = "";
        let reading = 0;
        let fromLink = false;
        const close = dialog({ title: "Import tracks", body, wide: true, actions: [] });

        function setActions() {
            const n = items.filter((i) => i.on && i.info.ok).length;
            close.setActions([
                { label: "Cancel" },
                {
                    label: n ? "Add " + n + (n === 1 ? " track" : " tracks") : "Add tracks",
                    primary: true,
                    disabled: !n,
                    onClick: async () => {
                        const chosen = items.filter((i) => i.on && i.info.ok).map((i) => ({ code: i.info.code, mode: i.mode, image: i.image }));
                        const result = await addMany(chosen, { source: fromLink ? "link" : "import" });
                        const parts = [];
                        if (result.added) parts.push("added " + result.added);
                        if (result.updated) parts.push("updated " + result.updated);
                        if (result.failed.length) parts.push(result.failed.length + " failed");
                        toast((parts.join(", ") || "Nothing added").replace(/^./, (c) => c.toUpperCase()));
                        if (result.failed.length) {
                            await alertBox(result.failed.map((f) => f.code.slice(0, 24) + "...: " + f.error).join("\n"), "Some tracks weren't added");
                        }
                        if (!opts.stay && (!screen || screen.root.hidden)) openLibrary("tracks");
                    },
                },
            ]);
        }

        async function read() {
            const token = ++reading;
            const text = area.value;
            if (!text.trim()) {
                items = [];
                preview.replaceChildren();
                status.textContent = "";
                setActions();
                return;
            }
            status.textContent = "Reading...";
            let result;
            try {
                result = await importText(text);
            } catch (e) {
                result = { tracks: [], failed: [{ code: "", error: e.message }] };
            }
            if (token !== reading) return;
            packName = result.name || "";
            fromLink = result.tracks.some((t) => t.fromLink);
            const library = await loadAll().catch(() => new Map());
            const seen = new Set();
            const next = [];
            for (const t of result.tracks) {
                const info = await parseAsync(t.code);
                if (token !== reading) return;
                if (info.ok && seen.has(info.code)) continue;
                seen.add(info.code);
                let existing = null;
                if (info.ok) {
                    if (info.kind === "stock") existing = [...library.values()].find((x) => x.trackId === info.trackId) || null;
                    else existing = [...library.values()].find((x) => x.code === info.code) || null;
                }
                next.push({ info, mode: t.mode, image: validImage(t.image), on: info.ok, existing });
            }
            for (const f of result.failed || []) next.push({ info: failed(f.code, f.error), mode: "normal", on: false });
            items = next;
            status.textContent = "";
            drawPreview(result.club);
            setActions();
        }

        function drawPreview(club) {
            preview.replaceChildren();
            if (club) {
                preview.appendChild(section("Club invite"));
                const r = el("div", "nt-row");
                const info = el("div", "nt-info");
                info.append(el("div", "nt-name", "Club " + club), el("div", "nt-meta", "Open the club to see its campaigns and join it."));
                r.append(info, button("Open club", () => { close(); joinClub(club); }, { primary: !items.length }));
                preview.appendChild(r);
            }
            if (!items.length) {
                if (!club) preview.appendChild(el("p", "nt-text bad", "No track codes found in that text."));
                return;
            }
            const good = items.filter((i) => i.info.ok).length;
            preview.appendChild(section((packName ? packName + ": " : "") + good + (good === 1 ? " track" : " tracks") + " found" + (items.length > good ? ", " + (items.length - good) + " couldn't be read" : "")));
            for (const item of items) {
                const r = el("div", "nt-row");
                const info = el("div", "nt-info");
                if (item.info.ok) {
                    r.appendChild(check(item.on, (v) => { item.on = v; setActions(); }));
                    info.append(el("div", "nt-name", item.info.name), metaNode({ ...item.info, mode: item.mode }, item.existing ? "already in My Tracks, will be updated" : null, true));
                    r.appendChild(info);
                } else {
                    info.append(el("div", "nt-name", item.info.code ? item.info.code.slice(0, 32) + (item.info.code.length > 32 ? "..." : "") : "Couldn't read"), el("div", "nt-text bad", item.info.error));
                    r.appendChild(info);
                }
                preview.appendChild(r);
            }
        }

        let timer = 0;
        area.addEventListener("input", () => {
            clearTimeout(timer);
            timer = setTimeout(read, 500);
        });
        area.addEventListener("paste", () => {
            clearTimeout(timer);
            timer = setTimeout(read, 50);
        });
        setActions();
        if (prefill) {
            area.value = String(prefill);
            read();
        } else setTimeout(() => area.focus(), 0);
        return close;
    }

    function joinClub(code) {
        if (window.__nswsClubs?.openJoin) {
            window.__nswsClubs.openJoin(code);
            return true;
        }
        alertBox("Clubs aren't available on this copy of the site.");
        return false;
    }

    // Share / export.
    function openShare(items, name) {
        const tracks = (Array.isArray(items) ? items : items ? [items] : [])
            .map((t) => (typeof t === "string" ? { code: t } : t || {}))
            .map((t) => ({ id: t.id || null, code: clean(t.code), mode: normMode(t.mode), name: t.name || null, kind: t.kind || null, trackId: t.trackId || null, submitted: t.submitted || null, image: validImage(t.image) }))
            .filter((t) => t.code);
        if (!tracks.length) return alertBox("Pick at least one track to share.");
        const locked = tracks.filter((t) => t.submitted);
        if (locked.length) {
            const names = locked.slice(0, 5).map((t) => "\"" + (t.name || "Untitled track") + "\"").join(", ") + (locked.length > 5 ? " and " + (locked.length - 5) + " more" : "");
            const one = locked.length === 1;
            return alertBox(
                names + (one ? " was" : " were") + " submitted to Weekly Shorts" + (one && locked[0].submitted.at ? " on " + new Date(locked[0].submitted.at).toLocaleDateString() : "") + ", so " + (one ? "it" : "they") + " can't be shared any more. A submitted track that gets posted is disqualified." + (locked.length < tracks.length ? " Pick only the other tracks to share them." : ""),
                "Already submitted"
            );
        }
        if (tracks.length > MAX_PACK_TRACKS) return alertBox("You can share " + MAX_PACK_TRACKS + " tracks at once at most. You picked " + tracks.length + ".");
        const single = tracks.length === 1;
        for (const t of tracks) {
            if (!t.name || !t.kind) {
                const info = parse(t.code);
                t.name = t.name || info.name || "Untitled track";
                t.kind = t.kind || info.kind || (t.code.startsWith(BE_PREFIX) ? "be" : "stock");
            }
        }
        const anyMode = tracks.some((t) => t.mode !== "normal");
        const body = el("div");
        let packName = typeof name === "string" ? name : "";

        if (!single) {
            const nameInput = input({ value: packName, placeholder: "Pack name (optional)", maxLength: 64, onInput: (v) => { packName = v; resetOutputs(); } });
            body.appendChild(field("Pack name", nameInput, "Shown to whoever opens the link."));
            const names = el("p", "nt-text dim", tracks.slice(0, 8).map((t) => t.name + " (" + MODE_LABEL[t.mode] + ")").join(", ") + (tracks.length > 8 ? " and " + (tracks.length - 8) + " more" : ""));
            body.appendChild(names);
        }

        body.appendChild(section("NSWS link"));
        body.appendChild(el("p", "nt-text dim", "A short link that opens these tracks in Import on NSWS" + (anyMode ? ", modes included." : ".") + " A link nobody opens for 6 months is deleted."));
        const linkLine = el("div", "nt-line");
        const linkInput = input({ readOnly: true, placeholder: "Create a link to share" });
        const linkCopy = button("Copy", () => copyText(linkInput.value), { icon: "copy", disabled: true });
        const linkMake = button("Create link", async () => {
            linkMake.disabled = true;
            linkInput.value = "";
            linkInput.placeholder = "Creating...";
            try {
                const link = await shareLink(tracks, packName);
                linkInput.value = link.url;
                linkCopy.disabled = false;
                copyText(link.url);
            } catch (e) {
                linkInput.placeholder = e.message;
            }
            linkMake.disabled = false;
        }, { icon: "share", primary: true });
        linkLine.append(linkInput, linkMake, linkCopy);
        body.appendChild(linkLine);

        body.appendChild(section("NSWS Track code"));
        body.appendChild(el("p", "nt-text dim", (single ? "Text that holds the track, exported in " + MODE_LABEL[tracks[0].mode] + " mode" : "Text that holds every track, each in the mode shown above") + ". Works offline: paste it into Import on NSWS, which shows the mode too."));
        if (single) {
            const modeLine = el("div", "nt-meta");
            modeLine.append(el("span", null, "Mode"), el("span", "nt-chip mode", MODE_LABEL[tracks[0].mode]));
            body.appendChild(modeLine);
        }
        const packBox = el("div");
        body.appendChild(packBox);
        let packText = "";
        const packCopy = button("Copy NSWS Track code", () => copyText(packText), { icon: "copy", disabled: true });
        const packInfo = el("p", "nt-text dim", "Packing...");
        packInfo.style.margin = "0 auto 0 0";
        const packLine = el("div", "nt-line");
        packLine.append(packInfo, packCopy);
        let packArea = null;

        let packToken = 0;
        async function makePack() {
            const token = ++packToken;
            packCopy.disabled = true;
            packInfo.textContent = "Packing...";
            try {
                const code = await packCode(tracks, packName);
                if (token !== packToken) return;
                packText = code;
                packCopy.disabled = false;
                packInfo.textContent = kb(code.length);
                packBox.replaceChildren();
                if (code.length <= 60000) {
                    packArea = input({ multiline: true, readOnly: true, value: code });
                    packBox.appendChild(packArea);
                }
                packBox.appendChild(packLine);
            } catch (e) {
                if (token !== packToken) return;
                packInfo.textContent = e.message;
                packBox.replaceChildren(packLine);
            }
        }

        let resetTimer = 0;
        function resetOutputs() {
            linkInput.value = "";
            linkInput.placeholder = "Create a link to share";
            linkCopy.disabled = true;
            clearTimeout(resetTimer);
            resetTimer = setTimeout(makePack, 400);
        }

        let share = null;
        if (single && tracks[0].id && !isKnown(tracks[0].trackId)) {
            const t = tracks[0];
            body.appendChild(section("Submit to Weekly Shorts"));
            body.appendChild(el("p", "nt-text dim", "Suggest this track for a future Not So Weekly Shorts week" + (t.mode !== "normal" ? ", raced in " + MODE_LABEL[t.mode] : "") + ". Race Control reviews every track; follow yours under Submit to Weekly Shorts in the Track Editor."));
            body.appendChild(el("p", "nt-text bad", "After you submit, you can't share this track any more, and you mustn't post it anywhere (code, link, video or screenshots). A submitted track that has been posted is disqualified."));
            const noteBox = input({ multiline: true, placeholder: "Anything Race Control should know (optional)", maxLength: 500 });
            noteBox.classList.add("nt-prose");
            noteBox.style.minHeight = "60px";
            body.appendChild(noteBox);
            const subLine = el("div", "nt-line");
            const subStatus = el("p", "nt-text dim", "");
            subStatus.style.margin = "0 auto 0 0";
            const subBtn = button("Submit to Weekly Shorts", async () => {
                subBtn.disabled = true;
                if (!(await confirmBox("Submit \"" + t.name + "\" to Weekly Shorts? You won't be able to share it afterwards.", { title: "Submit track", ok: "Submit" }))) {
                    subBtn.disabled = false;
                    return;
                }
                subStatus.className = "nt-text dim";
                subStatus.textContent = "Submitting...";
                try {
                    await submitTrack(t, noteBox.value);
                } catch (e) {
                    subStatus.className = "nt-text bad";
                    subStatus.textContent = e.message || "Couldn't send the track.";
                    subBtn.disabled = false;
                    return;
                }
                share?.();
                alertBox("Race Control will take a look. Remember: don't post this track anywhere, or it gets disqualified.", "Submitted!");
            }, { icon: "share", primary: true });
            subLine.append(subStatus, subBtn);
            body.appendChild(subLine);
        }

        makePack();
        share = dialog({ title: single ? "Share \"" + tracks[0].name + "\"" : "Share " + tracks.length + " tracks", body, wide: true, actions: [{ label: "Done" }] });
        return share;
    }

    // Picker.
    function pick(opts = {}) {
        const multi = !!opts.multi;
        const test =
            typeof opts.filter === "function"
                ? opts.filter
                : opts.filter && typeof opts.filter === "object"
                ? (t) => (!opts.filter.kind || t.kind === opts.filter.kind) && (!opts.filter.mode || normMode(t.mode) === opts.filter.mode)
                : () => true;
        return new Promise((resolve) => {
            const body = el("div");
            const top = el("div", "nt-line");
            top.style.marginTop = "0";
            const listEl = el("div");
            const chosen = new Set();
            let q = "";
            let tracks = [];
            const search = input({ placeholder: "Search name or author", onInput: (v) => { q = v.trim().toLowerCase(); draw(); } });
            top.append(search, button("Import", () => openImport("", { stay: true }), { icon: "import" }));
            body.append(top, listEl);
            let result = null;
            const close = dialog({ title: opts.title || (multi ? "Pick tracks" : "Pick a track"), body, wide: true, actions: [], onClose: () => { unsub(); resolve(result); } });

            function setActions() {
                close.setActions(
                    multi
                        ? [
                              { label: "Cancel" },
                              {
                                  label: chosen.size ? "Add " + chosen.size + (chosen.size === 1 ? " track" : " tracks") : "Add tracks",
                                  primary: true,
                                  disabled: !chosen.size,
                                  onClick: () => {
                                      result = tracks.filter((t) => chosen.has(t.id));
                                  },
                              },
                          ]
                        : [{ label: "Cancel" }]
                );
            }

            function draw() {
                listEl.replaceChildren();
                const visible = tracks.filter((t) => !q || (t.name || "").toLowerCase().includes(q) || (t.author || "").toLowerCase().includes(q));
                if (!tracks.length) {
                    listEl.appendChild(el("p", "nt-text", "No tracks to pick from. Import some first, or save one from the Track Editor."));
                    return;
                }
                if (!visible.length) listEl.appendChild(el("p", "nt-text dim", "No tracks match."));
                for (const t of visible) {
                    const r = el("div", "nt-row pick" + (chosen.has(t.id) ? " sel" : ""));
                    const toggle = () => {
                        if (!multi) {
                            result = [t];
                            close();
                            return;
                        }
                        chosen.has(t.id) ? chosen.delete(t.id) : chosen.add(t.id);
                        draw();
                        setActions();
                    };
                    if (multi) r.appendChild(check(chosen.has(t.id), toggle));
                    r.appendChild(thumbNode(t));
                    const info = el("div", "nt-info");
                    info.append(el("div", "nt-name", t.name || "Untitled track"), metaNode(t));
                    r.appendChild(info);
                    r.addEventListener("click", toggle);
                    listEl.appendChild(r);
                }
            }

            async function reload() {
                try {
                    tracks = (await list()).filter((t) => {
                        try {
                            return test(t);
                        } catch {
                            return false;
                        }
                    });
                } catch {
                    tracks = [];
                }
                for (const id of [...chosen]) if (!tracks.some((t) => t.id === id)) chosen.delete(id);
                draw();
                setActions();
            }
            const unsub = onChange(reload);
            setActions();
            reload();
            setTimeout(() => search.focus(), 0);
        });
    }

    // Startup links captured by main.bundle.js (?tracks= and ?club=).
    window.__nswsTracksOnLoad = (cupJoining) => {
        if (cupJoining === true) return false;
        const link = window.__nswsStartLink;
        if (!link || (!link.tracks && !link.club)) return false;
        window.__nswsStartLink = null;
        if (link.tracks && LINK_ID.test(link.tracks)) {
            setTimeout(() => {
                openLibrary("tracks");
                openImport((window.__nswsShareBase || location.origin + "/") + "?tracks=" + link.tracks);
            }, 250);
            return true;
        }
        if (link.tracks && !link.club) {
            setTimeout(() => alertBox("That track link isn't valid. Ask for a new link."), 250);
            return true;
        }
        if (link.club) {
            const code = String(link.club).toUpperCase();
            setTimeout(() => {
                if (!CLUB_CODE.test(code)) return alertBox("That club link isn't valid. Club codes are 6 letters and numbers.");
                joinClub(code);
            }, 250);
            return true;
        }
        return false;
    };

    const ui = {
        el,
        button,
        dialog,
        toast,
        field,
        section,
        input,
        select,
        check,
        modeSelect,
        thumb: thumbNode,
        meta: metaNode,
        alert: alertBox,
        confirm: confirmBox,
        copy: copyText,
        isolate,
        css,
        CSS,
    };

    const api_ = {
        parse,
        parseAsync,
        list,
        get,
        findByTrackId,
        add,
        addMany,
        update,
        remove,
        setMode,
        markSubmitted,
        openTrackPage,
        onChange,
        play,
        registerModes,
        modeOf,
        isKnown,
        packCode,
        readPack,
        shareLink,
        importText,
        openLibrary,
        closeLibrary,
        openImport,
        openShare,
        pick,
        registerTab,
        ui,
        user,
        api,
        modes: MODES,
        modeLabel: (m) => MODE_LABEL[normMode(m)],
    };
    window.__nswsTracks = api_;
    window.dispatchEvent(new CustomEvent("nsws-tracks-ready"));
})();
