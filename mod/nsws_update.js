// Each copy of the site watches only its own deploys: GitHub Pages stamps every file's
// Last-Modified with the deploy time, so the page compares its own stamp with the live one.
// Better Editor deploys on its own, so its updates are told by the newest id in its changelog.json.
(function () {
    const SITES = [
        { host: "brinleyww.github.io", path: /^\/notsoweeklyshorts(\/|$)/i, repo: "brinleyww/notsoweeklyshorts" },
        { host: "notweeklyshorts.github.io", path: /^\//, repo: "notweeklyshorts/notweeklyshorts.github.io" },
    ];
    const site = SITES.find(s => s.host === location.hostname && s.path.test(location.pathname));
    if (!site) return;

    const POLL_MS = 60000;
    const RUNS_API = "https://api.github.com/repos/" + site.repo + "/actions/runs?event=dynamic&branch=main&per_page=20";
    const BUSY = ".game-ui, #nsws-tutorial, #nsws-tour, .editor-ui, .device-preset-ui, dialog[open], .clip-box-bg, #nrc-overlay";

    // The title screen names the build this page was served from, which can trail the repo's newest commit.
    window.__nswsLoadedVersion = versionName(loadedDeployTime());

    const CSS = `
#nsws-update-bg{position:absolute;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;background-color:rgba(20,20,30,.5);pointer-events:auto;}
.nsws-update{display:flex;flex-direction:column;width:560px;max-width:calc(100% - 20px);background-color:var(--surface-color);clip-path:polygon(0 0,100% 0,calc(100% - 14px) 100%,0 100%);animation:nsws-update-in .25s ease-out;}
.nsws-update>.checker{height:8px;flex-shrink:0;background:repeating-conic-gradient(#fff 0 25%,#112052 0 50%) 0 0/8px 8px;opacity:.85;}
.nsws-update>h2{margin:0;padding:14px 20px 0 20px;font-size:38px;font-weight:normal;text-align:center;color:var(--text-color);}
.nsws-update>h3{margin:0;padding:6px 20px 14px 20px;font-size:22px;font-weight:normal;text-align:center;color:var(--text-color);opacity:.8;}
.nsws-update>.version{margin:0 10px;padding:18px 20px;background-color:var(--surface-secondary-color);font-size:48px;text-align:center;color:var(--text-color);overflow-wrap:anywhere;}
.nsws-update>.version>span{display:block;margin-bottom:8px;font-size:18px;opacity:.6;}
.nsws-update>.version>small{display:block;margin-top:6px;font-size:24px;color:#8fd8ff;}
.nsws-update>.warn{margin:10px 10px 0 10px;padding:12px 20px;background-color:var(--surface-secondary-color);color:#ff9a9a;font-size:20px;}
.nsws-update>.changes{margin:10px 10px 0 10px;padding:12px 20px;max-height:240px;overflow-y:auto;background-color:var(--surface-secondary-color);color:var(--text-color);font-size:20px;}
.nsws-update>.changes>div{margin-top:10px;font-size:18px;opacity:.6;}
.nsws-update>.changes>div:first-child{margin-top:0;}
.nsws-update>.changes>ul{margin:4px 0 0 0;padding-left:22px;}
.nsws-update>.changes>ul>li{margin:3px 0;overflow-wrap:anywhere;}
.nsws-update>.buttons{display:flex;justify-content:space-between;gap:10px;padding:10px 24px 10px 10px;}
.nsws-update>.buttons>.button{min-width:170px;}
@keyframes nsws-update-in{0%{opacity:0;transform:translateY(12px);}100%{opacity:1;transform:none;}}
#nsws-update-toast{position:absolute;top:12px;right:calc(var(--safe-area-horizontal,0px) + 20px);z-index:100;display:flex;flex-direction:column;width:380px;max-width:calc(100% - 24px);background-color:var(--surface-color);clip-path:polygon(14px 0,100% 0,100% 100%,0 100%);pointer-events:auto;animation:nsws-update-toast 14s ease-in forwards;}
#nsws-update-toast:hover{opacity:1!important;animation-play-state:paused;}
#nsws-update-toast>.checker{height:6px;background:repeating-conic-gradient(#fff 0 25%,#112052 0 50%) 0 0/6px 6px;opacity:.85;}
#nsws-update-toast>.row{display:flex;align-items:center;gap:10px;padding:8px 10px 10px 22px;}
#nsws-update-toast>.row>.text{flex:1;min-width:0;color:var(--text-color);}
#nsws-update-toast>.row>.text>div{font-size:22px;white-space:nowrap;}
#nsws-update-toast>.row>.text>span{display:block;font-size:16px;opacity:.65;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
#nsws-update-toast>.row>.button{flex-shrink:0;padding:6px 16px;font-size:22px;}
#nsws-update-bg.over,#nsws-update-toast.over{position:fixed;z-index:10006;}
#nsws-update-toast.over{top:auto;bottom:12px;left:0;right:0;margin:0 auto;}
@keyframes nsws-update-toast{0%{opacity:0;transform:translateX(40px);}3%{opacity:1;transform:none;}45%{opacity:1;}100%{opacity:0;}}
`;

    // document.lastModified is "MM/DD/YYYY hh:mm:ss" in local time, which Date.parse can't be trusted with.
    function loadedDeployTime() {
        const m = /(\d+)\/(\d+)\/(\d+) (\d+):(\d+):(\d+)/.exec(document.lastModified);
        return m ? new Date(+m[3], m[1] - 1, +m[2], +m[4], +m[5], +m[6]).getTime() : NaN;
    }

    async function liveDeployTime() {
        const res = await fetch(location.origin + location.pathname, { method: "HEAD", cache: "no-store" });
        return res.ok ? Date.parse(res.headers.get("Last-Modified")) : NaN;
    }

    // The run for a deploy starts before its files are stamped, and a newer push may already be building.
    async function versionName(deployedAt) {
        try {
            const res = await fetch(RUNS_API);
            if (!res.ok) return null;
            const runs = (await res.json()).workflow_runs || [];
            const run = runs.find(r => Date.parse(r.created_at) <= deployedAt) || runs[0];
            return run ? (run.head_commit?.message || run.display_title || "").split("\n")[0] || null : null;
        } catch (e) {
            return null;
        }
    }

    // Every version from the live one back to (not including) the one this page is running.
    async function changesSince(latest) {
        try {
            if (!window.__nswsChangelog) return [];
            const { log, complete } = await window.__nswsChangelog.newest();
            const from = log.findIndex(e => e.version === latest);
            if (from < 0) return [];
            const loadedName = await window.__nswsLoadedVersion;
            let loaded = log.findIndex(e => e.version === loadedName);
            // Only the top of the file is read, so a much older version isn't in it.
            if (loaded < 0 && loadedName && !complete) loaded = log.length;
            return log.slice(from, loaded > from ? Math.min(loaded, from + 5) : from + 1);
        } catch (e) {
            return [];
        }
    }

    function within(promise, ms, fallback) {
        return Promise.race([
            Promise.resolve(promise).catch(() => fallback),
            new Promise(r => setTimeout(r, ms, fallback)),
        ]);
    }

    async function refetch(url, options) {
        const res = await fetch(url, { cache: "reload", ...options });
        // Starting the request is enough to drop the cached copy, and the blocks file is about 80 MB.
        if (/\.bin(\?|$)/.test(url)) await res.body?.cancel();
        else await res.arrayBuffer();
    }

    // What the game itself loads from Better Editor, at the addresses main.bundle.js uses.
    async function refreshBEGameFiles() {
        let base = window.__nswsTM?.base || BE_SITE;
        const readPhysics = () => fetch(base + "physics.json", { cache: "reload", signal: AbortSignal.timeout?.(5000) }).then(r => r.json());
        const physics = await readPhysics().catch(() => {
            // Like the game, which takes these files from the mirror when github.io can't be reached.
            base = window.__nswsApiBase + "be/";
            return readPhysics();
        });
        const signal = AbortSignal.timeout?.(BE_REFRESH_MS);
        const query = "?p=" + (Number.isSafeInteger(physics.version) && physics.version > 0 ? physics.version : 1);
        await Promise.allSettled([
            // no-cors with cookies, as a script tag asks, so it's the same cache entry.
            ...BE_GAME_FILES.map(file => refetch(base + file + query, { mode: "no-cors", credentials: "include", signal })),
            refetch(base + "models/tm_blocks.bin", { signal }),
        ]);
    }

    // The editor's frame has a cache of its own on the fork and on the mirror, so Better Editor's refresh.html does that part.
    function refreshBEFrame() {
        const url = window.__nswsEditor?.refreshUrl?.();
        if (!url) return Promise.resolve();
        return new Promise(resolve => {
            const frame = document.createElement("iframe");
            let started = false;
            const finish = () => {
                window.removeEventListener("message", onMessage);
                frame.remove();
                resolve();
            };
            const onMessage = e => {
                if (e.source !== frame.contentWindow || e.data?.nsws !== "be-refresh") return;
                started = true;
                if (e.data.done) finish();
            };
            window.addEventListener("message", onMessage);
            frame.addEventListener("load", () => setTimeout(() => {
                if (!started) finish();
            }, 2000));
            setTimeout(finish, BE_REFRESH_MS);
            frame.style.display = "none";
            frame.src = url;
            document.body.appendChild(frame);
        });
    }

    async function hardRefresh() {
        // An update from the last minute is being installed too, and mustn't prompt again after the reload.
        const latestBE = Math.max(liveBE, await within(window.__nswsChangelog?.beNewest(false), 3000, 0));
        const urls = new Set([location.origin + location.pathname]);
        for (const s of document.scripts) if (s.src) urls.add(s.src);
        for (const e of performance.getEntriesByType("resource")) urls.add(e.name);
        const own = [...urls].filter(u => {
            try {
                const p = new URL(u);
                return /^https?:$/.test(p.protocol) && p.origin === location.origin && !/\/audio\//.test(p.pathname);
            } catch (e) {
                return false;
            }
        });
        // A plain reload keeps serving scripts from the 10-minute Pages cache; re-fetching them first replaces those entries.
        await Promise.all([
            within(Promise.allSettled(own.map(u => refetch(u))), 10000),
            within(refreshBEGameFiles(), BE_REFRESH_MS),
            refreshBEFrame(),
        ]);
        if (latestBE) rememberBE(latestBE);
        // They've said to lose the unsaved track, so the editor needn't ask again.
        if (armed) window.__nswsEditor?.discard?.();
        location.reload();
    }

    const BE_SITE = "https://brinleyww.github.io/Better-Editor-PT/";
    const BE_GAME_FILES = ["tm_parts.js", "tm_runtime.js", "tm_water.js", "tm_vehicles.js", "tm_hud.js"];
    const BE_REFRESH_MS = 20000;
    const BE_KEY = "_nswsUpdateBE";
    // GitHub Pages files stay in the browser's cache this long.
    const BE_CACHE_MS = 600000;
    // The mirror is a Worker request each time, so a network that blocks github.io asks it less often.
    const BE_MIRROR_POLL_MS = 300000;
    const EDITOR_OPEN = "#nsws-editor:not(.hidden)";

    function storedBE() {
        try {
            const saved = JSON.parse(localStorage.getItem(BE_KEY));
            return Date.now() - saved.at < BE_CACHE_MS && saved.id > 0 ? saved.id : 0;
        } catch (e) {
            return 0;
        }
    }

    function rememberBE(id) {
        try {
            // Another tab may have installed a newer one into the same cache.
            if (storedBE() <= id) localStorage.setItem(BE_KEY, JSON.stringify({ id, at: Date.now() }));
        } catch (e) {}
    }

    // A reload inside the cache time still runs the files of the update this browser last had.
    let runningBE = storedBE();
    let liveBE = 0;
    let dismissedBE = 0;
    let pendingBE = null;
    let mirrorCheckedAt = -Infinity;
    let checkingBE = false;
    let installing = false;
    let armed = false;
    if (runningBE) window.__nswsBEStamp = runningBE;

    let dismissedAt = loadedDeployTime();
    let pending = null;
    let popup = null;
    let toast = null;
    let toastedFor = "";
    let checking = false;

    function onKey(e) {
        if (e.code !== "Escape" || !popup) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (installing) return;
        if (armed) saveFirst();
        else ignore();
    }

    function close() {
        popup?.remove();
        popup = null;
        armed = false;
        window.removeEventListener("keydown", onKey, true);
    }

    function ignore() {
        if (pending) dismissedAt = pending.deployedAt;
        if (pendingBE) dismissedBE = pendingBE.id;
        pending = pendingBE = null;
        close();
        window.__nswsEditor?.focus?.();
    }

    // The update stays pending, and is offered again when the editor closes.
    function saveFirst() {
        close();
        toastedFor = pendingKey();
        window.__nswsEditor?.open();
    }

    function pendingKey() {
        return (pending?.deployedAt || "") + "|" + (pendingBE?.id || "");
    }

    // The editor covers #ui, so over it both the toast and the popup go on the page itself.
    function mount(node) {
        const over = !!document.querySelector(EDITOR_OPEN);
        node.classList.toggle("over", over);
        ((!over && document.getElementById("ui")) || document.body).appendChild(node);
        return over;
    }

    function makeButton(icon, label) {
        const b = document.createElement("button");
        b.className = "button";
        b.innerHTML = '<img class="button-icon" src="images/' + icon + '.svg"> ';
        b.append(label);
        return b;
    }

    function addStyle() {
        if (document.getElementById("nsws-update-style")) return;
        const style = document.createElement("style");
        style.id = "nsws-update-style";
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    function closeToast() {
        toast?.remove();
        toast = null;
    }

    function showToast() {
        addStyle();
        toastedFor = pendingKey();
        toast = document.createElement("div");
        toast.id = "nsws-update-toast";
        toast.innerHTML = '<div class="checker"></div>';
        const row = document.createElement("div");
        row.className = "row";
        const text = document.createElement("div");
        text.className = "text";
        text.innerHTML = "<div>New update available</div>";
        const version = document.createElement("span");
        version.textContent = [pending && (pending.name || "New version"), pendingBE?.name].filter(Boolean).join(" + ");
        text.appendChild(version);
        const viewButton = makeButton("arrow_right", "View");
        viewButton.addEventListener("click", () => {
            closeToast();
            if ((pending || pendingBE) && !popup) show();
        });
        row.append(text, viewButton);
        toast.appendChild(row);
        toast.addEventListener("animationend", closeToast);
        if (mount(toast)) return;
        const cps = document.getElementById("_nsws-cps");
        if (cps && cps.offsetHeight) toast.style.top = cps.offsetTop + cps.offsetHeight + 8 + "px";
    }

    function show() {
        closeToast();
        addStyle();
        popup = document.createElement("div");
        popup.id = "nsws-update-bg";
        const box = document.createElement("div");
        box.className = "nsws-update";
        box.innerHTML = '<div class="checker"></div><h2>New update available</h2><h3></h3>';
        box.querySelector("h3").textContent = pending ? "You're playing an older version of the site." : "You're using an older version of Better Editor.";
        const version = document.createElement("div");
        version.className = "version";
        version.innerHTML = "<span>Latest version</span>";
        version.append(pending ? pending.name || "New version" : pendingBE.name);
        if (pending && pendingBE) {
            const editor = document.createElement("small");
            editor.textContent = "+ " + pendingBE.name;
            version.appendChild(editor);
        }
        box.appendChild(version);

        const entries = [...(pending?.changes || []), ...(pendingBE?.changes || [])];
        if (entries.length) {
            const changes = document.createElement("div");
            changes.className = "changes";
            for (const entry of entries) {
                const title = document.createElement("div");
                title.textContent = entries.length > 1 ? entry.version : "What's new";
                const list = document.createElement("ul");
                for (const line of entry.changes) {
                    const li = document.createElement("li");
                    li.textContent = String(line);
                    list.appendChild(li);
                }
                changes.append(title, list);
            }
            box.appendChild(changes);
        }

        const buttons = document.createElement("div");
        buttons.className = "buttons";
        const ignoreButton = makeButton("back", "Ignore");
        ignoreButton.addEventListener("click", () => (armed ? saveFirst() : ignore()));
        const installButton = makeButton("refresh", "Install");
        installButton.addEventListener("click", async () => {
            installing = true;
            ignoreButton.disabled = installButton.disabled = true;
            installButton.lastChild.textContent = "Installing...";
            if (!armed && (await within(window.__nswsEditor?.unsaved?.(), 8000, true))) {
                installing = false;
                armed = true;
                const warn = document.createElement("div");
                warn.className = "warn";
                warn.textContent = "Your track in the editor may have unsaved changes. Installing now loses them.";
                box.insertBefore(warn, buttons);
                ignoreButton.disabled = installButton.disabled = false;
                ignoreButton.lastChild.textContent = "Save first";
                installButton.lastChild.textContent = "Install anyway";
                return;
            }
            hardRefresh();
        });
        buttons.append(ignoreButton, installButton);
        box.appendChild(buttons);

        popup.appendChild(box);
        mount(popup);
        window.addEventListener("keydown", onKey, true);
    }

    function tryShow() {
        if ((!pending && !pendingBE) || popup) return;
        if (!document.querySelector(BUSY) && !document.querySelector(EDITOR_OPEN)) show();
        else if (!toast && toastedFor !== pendingKey() && document.visibilityState === "visible") showToast();
    }

    // Both sites often deploy seconds apart, so a second update can land while the first one's popup is up.
    function found() {
        if (!popup) return tryShow();
        if (installing || armed) return;
        close();
        show();
    }

    async function check() {
        if (checking || popup || document.visibilityState === "hidden") return;
        checking = true;
        try {
            const live = await liveDeployTime();
            if (live > dismissedAt && !(pending && pending.deployedAt >= live)) {
                const name = await versionName(live);
                pending = { deployedAt: live, name, changes: name ? await changesSince(name) : [] };
                found();
            }
        } catch (e) {
        } finally {
            checking = false;
        }
    }

    async function checkBE() {
        const log = window.__nswsChangelog;
        // The first one runs in a background tab too: it's what later ones compare against.
        if (!log?.beNewest || checkingBE || popup || (liveBE && document.visibilityState === "hidden")) return;
        checkingBE = true;
        try {
            let live = await within(log.beNewest(false), 15000, 0);
            let mirror = false;
            if (!live && Date.now() - mirrorCheckedAt >= BE_MIRROR_POLL_MS) {
                mirrorCheckedAt = Date.now();
                mirror = true;
                live = await within(log.beNewest(true), 15000, 0);
            }
            if (!live) return;
            liveBE = live;
            runningBE ||= live;
            window.__nswsBEStamp = runningBE;
            rememberBE(runningBE);
            if (live <= Math.max(runningBE, dismissedBE) || pendingBE?.id >= live) return;
            const changes = await within(log.beSince(runningBE, mirror), 15000, []);
            pendingBE = { id: live, name: changes[0]?.version || "Better Editor", changes: changes.slice(0, 5) };
            found();
        } finally {
            checkingBE = false;
        }
    }

    setInterval(tryShow, 1000);
    setInterval(() => {
        if (document.visibilityState !== "visible") return;
        check();
        checkBE();
    }, POLL_MS);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible") return;
        check();
        checkBE();
    });
    // Right away, since it's the version this visit counts as running (the changelog's script comes after this one).
    document.addEventListener("DOMContentLoaded", checkBE);
    setTimeout(check, 5000);
})();
