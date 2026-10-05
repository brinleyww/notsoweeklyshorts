// Each copy of the site watches only its own deploys: GitHub Pages stamps every file's
// Last-Modified with the deploy time, so the page compares its own stamp with the live one.
(function () {
    const SITES = [
        { host: "brinleyww.github.io", path: /^\/notsoweeklyshorts(\/|$)/i, repo: "brinleyww/notsoweeklyshorts" },
        { host: "notweeklyshorts.github.io", path: /^\//, repo: "notweeklyshorts/notweeklyshorts.github.io" },
    ];
    const site = SITES.find(s => s.host === location.hostname && s.path.test(location.pathname));
    if (!site) return;

    const POLL_MS = 60000;
    const RUNS_API = "https://api.github.com/repos/" + site.repo + "/actions/runs?event=dynamic&branch=main&per_page=5";
    const BUSY = ".game-ui, .editor-ui, .device-preset-ui, dialog[open], .clip-box-bg, #nrc-overlay";

    const CSS = `
#nsws-update-bg{position:absolute;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;background-color:rgba(20,20,30,.5);pointer-events:auto;}
.nsws-update{display:flex;flex-direction:column;width:560px;max-width:calc(100% - 20px);background-color:var(--surface-color);clip-path:polygon(0 0,100% 0,calc(100% - 14px) 100%,0 100%);animation:nsws-update-in .25s ease-out;}
.nsws-update>.checker{height:8px;flex-shrink:0;background:repeating-conic-gradient(#fff 0 25%,#112052 0 50%) 0 0/8px 8px;opacity:.85;}
.nsws-update>h2{margin:0;padding:14px 20px 0 20px;font-size:38px;font-weight:normal;text-align:center;color:var(--text-color);}
.nsws-update>h3{margin:0;padding:6px 20px 14px 20px;font-size:22px;font-weight:normal;text-align:center;color:var(--text-color);opacity:.8;}
.nsws-update>.version{margin:0 10px;padding:18px 20px;background-color:var(--surface-secondary-color);font-size:48px;text-align:center;color:var(--text-color);overflow-wrap:anywhere;}
.nsws-update>.version>span{display:block;margin-bottom:8px;font-size:18px;opacity:.6;}
.nsws-update>.buttons{display:flex;justify-content:space-between;gap:10px;padding:10px 24px 10px 10px;}
.nsws-update>.buttons>.button{min-width:170px;}
@keyframes nsws-update-in{0%{opacity:0;transform:translateY(12px);}100%{opacity:1;transform:none;}}
#nsws-update-toast{position:absolute;top:12px;right:calc(var(--safe-area-horizontal,0px) + 12px);z-index:100;display:flex;flex-direction:column;width:380px;max-width:calc(100% - 24px);background-color:var(--surface-color);clip-path:polygon(14px 0,100% 0,100% 100%,0 100%);pointer-events:auto;animation:nsws-update-toast 14s ease-in forwards;}
#nsws-update-toast:hover{opacity:1!important;animation-play-state:paused;}
#nsws-update-toast>.checker{height:6px;background:repeating-conic-gradient(#fff 0 25%,#112052 0 50%) 0 0/6px 6px;opacity:.85;}
#nsws-update-toast>.row{display:flex;align-items:center;gap:10px;padding:8px 10px 10px 22px;}
#nsws-update-toast>.row>.text{flex:1;min-width:0;color:var(--text-color);}
#nsws-update-toast>.row>.text>div{font-size:22px;white-space:nowrap;}
#nsws-update-toast>.row>.text>span{display:block;font-size:16px;opacity:.65;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
#nsws-update-toast>.row>.button{flex-shrink:0;padding:6px 16px;font-size:22px;}
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

    async function hardRefresh() {
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
        await Promise.race([
            Promise.allSettled(own.map(u => fetch(u, { cache: "reload" }))),
            new Promise(r => setTimeout(r, 10000)),
        ]);
        location.reload();
    }

    let dismissedAt = loadedDeployTime();
    let pending = null;
    let popup = null;
    let toast = null;
    let toastedAt = -Infinity;
    let checking = false;

    function onKey(e) {
        if (e.code !== "Escape" || !popup) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        ignore();
    }

    function close() {
        popup?.remove();
        popup = null;
        window.removeEventListener("keydown", onKey, true);
    }

    function ignore() {
        if (pending) dismissedAt = pending.deployedAt;
        pending = null;
        close();
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
        toastedAt = pending.deployedAt;
        toast = document.createElement("div");
        toast.id = "nsws-update-toast";
        toast.innerHTML = '<div class="checker"></div>';
        const row = document.createElement("div");
        row.className = "row";
        const text = document.createElement("div");
        text.className = "text";
        text.innerHTML = "<div>New update available</div>";
        const version = document.createElement("span");
        version.textContent = pending.name || "New version";
        text.appendChild(version);
        const viewButton = makeButton("arrow_right", "View");
        viewButton.addEventListener("click", () => {
            closeToast();
            if (pending && !popup) show();
        });
        row.append(text, viewButton);
        toast.appendChild(row);
        toast.addEventListener("animationend", closeToast);
        (document.getElementById("ui") || document.body).appendChild(toast);
    }

    function show() {
        closeToast();
        addStyle();
        popup = document.createElement("div");
        popup.id = "nsws-update-bg";
        const box = document.createElement("div");
        box.className = "nsws-update";
        box.innerHTML = '<div class="checker"></div><h2>New update available</h2><h3>You\'re playing an older version of the site.</h3>';
        const version = document.createElement("div");
        version.className = "version";
        version.innerHTML = "<span>Latest version</span>";
        version.append(pending.name || "New version");
        box.appendChild(version);

        const buttons = document.createElement("div");
        buttons.className = "buttons";
        const ignoreButton = makeButton("back", "Ignore");
        ignoreButton.addEventListener("click", ignore);
        const installButton = makeButton("refresh", "Install");
        installButton.addEventListener("click", () => {
            ignoreButton.disabled = installButton.disabled = true;
            installButton.lastChild.textContent = "Installing...";
            hardRefresh();
        });
        buttons.append(ignoreButton, installButton);
        box.appendChild(buttons);

        popup.appendChild(box);
        (document.getElementById("ui") || document.body).appendChild(popup);
        window.addEventListener("keydown", onKey, true);
    }

    function tryShow() {
        if (!pending || popup) return;
        if (!document.querySelector(BUSY)) show();
        else if (!toast && toastedAt < pending.deployedAt && document.visibilityState === "visible") showToast();
    }

    async function check() {
        if (checking || popup || document.visibilityState === "hidden") return;
        checking = true;
        try {
            const live = await liveDeployTime();
            if (live > dismissedAt && !(pending && pending.deployedAt >= live)) {
                pending = { deployedAt: live, name: await versionName(live) };
                tryShow();
            }
        } catch (e) {
        } finally {
            checking = false;
        }
    }

    setInterval(tryShow, 1000);
    setInterval(check, POLL_MS);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") check();
    });
    setTimeout(check, 5000);
})();
