// Custom Tracks Editor: Better Editor PT in a full-screen iframe with an NSWS bar on top. Tracks move
// between the two through BE's nsws_bridge.js (postMessage). The BE editor keeps unsaved work only in
// memory, so Back only hides the iframe; it stays loaded until the page is closed or reloaded.
(function () {
    "use strict";
    // The first-launch graphics picker belongs to the main menu; Custom Tracks and the editor can open a
    // track over it, so it waits out of sight until the menu is back.
    const pickerStyle = document.createElement("style");
    pickerStyle.textContent =
        "body:has(.track-info-ui:not(.hidden)) .device-preset-ui,body:has(.track-selection-ui:not(.hidden)) .device-preset-ui,body:has(.game-ui) .device-preset-ui,body:has(#nsws-editor:not(.hidden)) .device-preset-ui{display:none!important;}";
    document.head.appendChild(pickerStyle);
    const DEFAULT_URL = "https://brinleyww.github.io/Better-Editor-PT/?nsws=1";
    const HELLO_EVERY_MS = 1000;
    const HELLO_TRIES = 90;
    const FALLBACK_AFTER_LOAD_MS = 5000;
    const FALLBACK_HARD_MS = 25000;
    const AUTOSAVE_KEY = "nswsEditorAutosave";
    const AUTOSAVE_EVERY_MS = 30000;
    const REQUEST_TIMEOUT_MS = 15000;
    // The bridge's edit waits up to 60 s for the editor's loading screen (the block download) and 20 s for it to open.
    const EDIT_TIMEOUT_MS = 100000;
    const MODES_KEY = "nswsEditorModes";
    const MANUAL = "\u0000pasted";
    const NEW = "\u0000new";
    const LAST_KEY = "nswsEditorLast";
    // Set when github.io didn't load here, so the editor comes through the NSWS Worker for a week.
    const MIRROR_KEY = "nswsEditorMirror";
    const MIRROR_FOR_MS = 7 * 86400000;
    const COPIED_KEY = "nswsEditorCopied";
    const COPY_MAX_CODE = 400000;
    const MODES = [
        { id: "normal", label: "Normal", help: "Normal: stock PolyTrack driving." },
        { id: "rocket", label: "Rocket League", help: "Rocket League: jump, boost and flip, with the Rocket League weeks' physics." },
        {
            id: "royale",
            label: "Royale",
            help: "Royale: give every checkpoint number TWO gates. After you cross one, a reset respawns you at the other gate with that number, so put it where the next section starts.",
        },
    ];
    const STATUS = { new: "Waiting for review", planned: "Planned", rejected: "Not picked" };

    const CSS = `
#nsws-editor{position:fixed;inset:0;z-index:10000;display:flex;flex-direction:column;background:#192042;color:#fff;font-family:ForcedSquare,Arial,sans-serif;}
#nsws-editor.hidden{display:none;}
#nsws-editor *{box-sizing:border-box;}
#nsws-editor .nse-bar{flex-shrink:0;display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:6px 10px 4px;background:#212b58;}
#nsws-editor .nse-bar .gap{flex:1 1 0;min-width:0;}
#nsws-editor .button{margin:0;padding:5px 13px;font-size:17px;white-space:nowrap;}
#nsws-editor .button>img{width:18px;height:18px;margin-right:5px;vertical-align:-3px;pointer-events:none;}
#nsws-editor .button.primary{box-shadow:inset 0 -3px 0 #7272c2;}
#nsws-editor .nse-pick{display:flex;align-items:center;gap:6px;font-size:15px;color:rgba(255,255,255,.65);}
#nsws-editor select,#nsws-editor textarea{background:#192042;color:#fff;border:1px solid rgba(255,255,255,.25);border-radius:0;font-family:inherit;font-size:16px;outline:none;}
#nsws-editor select{max-width:240px;padding:4px 6px;}
#nsws-editor select:focus,#nsws-editor textarea:focus{border-color:#7272c2;box-shadow:0 0 0 1px #7272c2;}
#nsws-editor .nse-seg{display:flex;gap:2px;}
#nsws-editor .nse-seg>button{background:transparent;border:0;border-bottom:2px solid transparent;color:rgba(255,255,255,.6);font-family:inherit;font-size:16px;padding:5px 9px;cursor:pointer;}
#nsws-editor .nse-seg>button:hover{color:#fff;}
#nsws-editor .nse-seg>button.on{color:#fff;border-bottom-color:#7272c2;}
#nsws-editor .nse-info{flex-shrink:0;display:flex;flex-wrap:wrap;gap:2px 16px;padding:0 12px 6px;background:#212b58;border-bottom:1px solid rgba(255,255,255,.15);font-size:14px;line-height:1.35;}
#nsws-editor .nse-help{flex:1 1 360px;color:rgba(255,255,255,.55);font-style:italic;}
#nsws-editor .nse-note{flex:0 1 auto;color:rgba(255,255,255,.8);}
#nsws-editor .good{color:#96ff96;}
#nsws-editor .bad{color:#ff9a9a;}
#nsws-editor .nse-fallback{flex-shrink:0;display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;padding:8px 12px;background:#28346a;border-bottom:1px solid rgba(255,255,255,.15);font-size:15px;}
#nsws-editor .nse-fallback.hidden{display:none;}
#nsws-editor .nse-fallback>span{flex:1 1 300px;color:rgba(255,255,255,.75);}
#nsws-editor .nse-fallback>textarea{flex:1 1 260px;height:34px;min-height:34px;resize:vertical;padding:5px 7px;font-size:13px;}
#nsws-editor .nse-frame{position:relative;flex:1 1 auto;min-height:0;background:#192042;}
#nsws-editor .nse-frame>iframe{position:absolute;inset:0;width:100%;height:100%;border:0;display:block;}
#nsws-editor .nse-load{position:absolute;inset:0;z-index:2;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:#192042;}
#nsws-editor .nse-load.hidden{display:none;}
#nsws-editor .nse-load h2{margin:0;font-size:34px;font-weight:normal;font-style:italic;}
#nsws-editor .nse-lbar{position:relative;width:min(440px,72vw);height:6px;overflow:hidden;background:rgba(255,255,255,.15);}
#nsws-editor .nse-lbar>div{position:absolute;top:0;bottom:0;left:0;width:0;background:#7272c2;transition:width .2s;}
#nsws-editor .nse-load.busy .nse-lbar>div{width:35%;transition:none;animation:nseLoad 1.1s linear infinite;}
@keyframes nseLoad{from{transform:translateX(-100%);}to{transform:translateX(320%);}}
#nsws-editor .nse-load p{margin:0;font-size:16px;font-style:italic;color:rgba(255,255,255,.65);}
#nsws-editor .nse-dim{position:absolute;inset:0;z-index:3;display:flex;align-items:center;justify-content:center;padding:12px;background:rgba(0,0,0,.7);}
#nsws-editor .nse-box{display:flex;flex-direction:column;width:min(640px,100%);max-height:100%;background:#28346a;clip-path:polygon(0 0,100% 0,calc(100% - 14px) 100%,0 100%);outline:none;}
#nsws-editor .nse-box>h1{flex-shrink:0;margin:0;padding:10px 18px;font-size:26px;font-weight:normal;background:#212b58;}
#nsws-editor .nse-body{overflow-y:auto;padding:4px 18px 14px;}
#nsws-editor .nse-body>p{margin:10px 0 0;font-size:15px;line-height:1.4;color:rgba(255,255,255,.75);}
#nsws-editor .nse-sec{margin:16px 0 0;padding-bottom:3px;border-bottom:1px solid rgba(255,255,255,.85);font-size:14px;font-style:italic;color:rgba(255,255,255,.55);}
#nsws-editor .nse-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.08);font-size:17px;}
#nsws-editor .nse-row>.val{text-align:right;color:rgba(255,255,255,.8);overflow-wrap:anywhere;}
#nsws-editor .nse-row.col{flex-direction:column;align-items:stretch;gap:6px;}
#nsws-editor .nse-row textarea{width:100%;height:70px;resize:vertical;padding:6px 8px;font-size:15px;}
#nsws-editor .nse-sub{padding:7px 0;border-bottom:1px solid rgba(255,255,255,.08);font-size:16px;}
#nsws-editor .nse-sub>div{display:flex;justify-content:space-between;gap:12px;}
#nsws-editor .nse-sub .dim,#nsws-editor .nse-dimtext{color:rgba(255,255,255,.55);font-size:14px;}
#nsws-editor .nse-sub .st-planned{color:#96ff96;}
#nsws-editor .nse-sub .st-rejected{color:#ff9a9a;}
#nsws-editor .nse-actions{flex-shrink:0;display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px;padding:10px 18px;background:#212b58;}
@media (max-width:700px){#nsws-editor .button{font-size:15px;padding:4px 9px;}#nsws-editor .nse-seg>button{font-size:14px;padding:4px 6px;}#nsws-editor select{max-width:150px;font-size:14px;}#nsws-editor .nse-help{flex-basis:100%;}}
`;

    let host = null;
    let ui = null;
    let frame = null;
    let frameOrigin = null;
    let ready = false;
    let helloTimer = null;
    let fallbackTimer = null;
    let hideTimer = null;
    let reqSeq = 0;
    const pending = new Map();
    let tracks = [];
    let newestSave = 0;
    let selected = null;
    let manual = null;
    let pendingImport = null;
    let dialogClose = null;

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function button(text, onClick, icon, primary) {
        const b = el("button", "button" + (primary ? " primary" : ""));
        if (icon) {
            const img = el("img");
            img.src = icon;
            img.alt = "";
            b.appendChild(img);
        }
        b.append(text);
        b.addEventListener("click", (e) => {
            window.__nswsUIClick?.();
            onClick(e, b);
        });
        return b;
    }

    function editorUrl() {
        let url = DEFAULT_URL;
        if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
            try {
                const own = localStorage.getItem("nswsEditorUrl");
                if (own && /^https?:\/\//.test(own)) url = own;
            } catch {}
        }
        if (url === DEFAULT_URL && window.__nswsApiBase && (useMirror ?? mirrorOn())) url = window.__nswsApiBase + "be/";
        if (!/[?&]nsws=1/.test(url)) url += (url.includes("?") ? "&" : "?") + "nsws=1";
        return url + prefsHash();
    }

    // The editor is another site with its own storage; BE's nsws_prefs.js copies these in before the game starts.
    function prefsHash() {
        const P = "polytrack_v5_prod_";
        const read = (key) => {
            try {
                return JSON.parse(localStorage.getItem(key));
            } catch {
                return null;
            }
        };
        const slot = read(P + "user_slot") ?? 0;
        const profile = read(P + "user_" + (Number.isSafeInteger(slot) && slot >= 0 ? slot : 0));
        const prefs = { settings: read(P + "settings"), keys: read(P + "key_bindings"), unlocked: read(P + "unlocked_car_styles") };
        if (profile && typeof profile.carStyle === "string") {
            prefs.carStyle = profile.carStyle;
            prefs.nickname = profile.nickname;
            prefs.countryCode = profile.countryCode ?? null;
        }
        return "#nswsPrefs=" + encodeURIComponent(JSON.stringify(prefs));
    }

    // Decided for this page once the other address has been tried, so a full or blocked localStorage can't loop the switch.
    let useMirror = null;
    let switched = false;
    function mirrorOn() {
        try {
            return Date.now() - Number(localStorage.getItem(MIRROR_KEY) || 0) < MIRROR_FOR_MS;
        } catch {
            return false;
        }
    }

    const mb = (n) => (n / 1048576).toFixed(n < 10485760 ? 1 : 0);
    // Covers the frame until the editor is open; the bar follows the block download the bridge reports.
    function loading(text, frac) {
        if (!ui) return;
        ui.loader.classList.remove("hidden");
        ui.loaderText.textContent = text;
        ui.loader.classList.toggle("busy", frac == null);
        ui.loaderFill.style.width = frac == null ? "" : Math.min(100, frac * 100).toFixed(1) + "%";
    }
    const loaded = () => ui?.loader.classList.add("hidden");

    function lib() {
        return window.__nswsTracks || null;
    }

    function readModes() {
        try {
            const m = JSON.parse(localStorage.getItem(MODES_KEY));
            return m && typeof m === "object" ? m : {};
        } catch {
            return {};
        }
    }

    function modeOf(name) {
        const m = readModes()[name];
        return MODES.some((x) => x.id === m) ? m : "normal";
    }

    function setMode(name, mode) {
        if (name == null) return;
        const all = readModes();
        if (mode === "normal") delete all[name];
        else all[name] = mode;
        try {
            localStorage.setItem(MODES_KEY, JSON.stringify(all));
        } catch {}
    }

    function autosaveOn() {
        try {
            return localStorage.getItem(AUTOSAVE_KEY) === "1";
        } catch {
            return false;
        }
    }

    let autosaveTimer = null;
    let unnamedTold = false;
    function setAutosave(on) {
        try {
            on ? localStorage.setItem(AUTOSAVE_KEY, "1") : localStorage.removeItem(AUTOSAVE_KEY);
        } catch {}
        renderAutosave();
        note(on ? "Autosave is on: the open track is saved in the editor every 30 seconds and when you go Back." : "Autosave is off. Use the editor's Save to keep your work.");
        if (on) autosave();
    }

    function renderAutosave() {
        if (!ui) return;
        const on = autosaveOn();
        ui.autoBtn.classList.toggle("on", on);
        ui.autoBtn.textContent = on ? "Autosave: On" : "Autosave: Off";
        clearInterval(autosaveTimer);
        autosaveTimer = on ? setInterval(() => autosave(), AUTOSAVE_EVERY_MS) : null;
    }

    async function autosave() {
        if (!autosaveOn() || !frame || !ready) return;
        let reply;
        try {
            reply = await request("autosave");
        } catch {
            return;
        }
        if (reply?.saved) {
            if (host && !host.classList.contains("hidden")) note("Autosaved \"" + reply.name + "\" at " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + ".");
        } else if (reply?.reason === "unnamed" && !unnamedTold && host && !host.classList.contains("hidden")) {
            unnamedTold = true;
            note("Autosave needs a name: press Save in the editor once, and it saves by itself after that.");
        } else if (reply?.reason === "failed") {
            note("Autosave couldn't save the track. The editor's storage may be full.", "bad");
        }
    }

    function note(text, kind) {
        if (!ui) return;
        ui.note.textContent = text || "";
        ui.note.className = "nse-note" + (kind ? " " + kind : "");
    }

    // The track open in the editor right now, saved or not; refreshed by refreshLive().
    let live = null;
    function current() {
        if (selected === MANUAL) return manual;
        return live;
    }

    async function refreshLive() {
        if (!ready) return current();
        let reply;
        try {
            reply = await request("current");
        } catch {
            return current();
        }
        const t = reply?.track;
        live = t && typeof t.code === "string" ? { name: t.name || "Unnamed Track", named: !!t.name, author: t.author || "", code: t.code } : null;
        // A new track saved or loaded inside the editor is the one to reopen after a reload.
        if (live?.named) {
            try {
                if (localStorage.getItem(LAST_KEY) !== live.name) localStorage.setItem(LAST_KEY, live.name);
            } catch {}
        }
        renderMode();
        syncMode();
        return current();
    }

    // The editor's own Test runs in NSWS when Rocket League or Royale is picked, so it needs to know the mode.
    function syncMode() {
        const t = current();
        post({ type: "mode", mode: t ? modeOf(t.name) : "normal" });
    }

    let testing = false;
    async function startTest(m) {
        if (testing) return;
        const T = lib();
        if (!T || typeof m.code !== "string") {
            note("Custom Tracks didn't load. Reload the page and try again.", "bad");
            return;
        }
        hide();
        testing = true;
        const back = () => {
            if (!testing) return;
            testing = false;
            show();
        };
        const ok = await T.play(m.code, { mode: m.mode, start: true, onExit: back }).catch(() => false);
        if (!ok) {
            testing = false;
            show();
            note("The " + (m.mode === "royale" ? "Royale" : "Rocket League") + " test didn't start.", "bad");
        }
    }

    function stopAll(node) {
        for (const type of ["keydown", "keyup", "keypress"]) node.addEventListener(type, (e) => e.stopPropagation());
        for (const type of ["touchstart", "touchmove", "touchend", "touchcancel", "pointerdown", "pointermove", "pointerup", "mousedown", "mouseup", "wheel", "contextmenu"])
            node.addEventListener(type, (e) => e.stopPropagation(), { passive: true });
    }

    function build() {
        if (host) return;
        const style = el("style");
        style.textContent = CSS;
        document.head.appendChild(style);

        host = el("div", "hidden");
        host.id = "nsws-editor";
        host.tabIndex = -1;
        stopAll(host);
        // Focus can stay on a game button behind the overlay, and its key events would never pass through host.
        for (const type of ["keydown", "keyup", "keypress"])
            window.addEventListener(type, (e) => {
                if (host && !host.classList.contains("hidden") && !host.contains(e.target)) e.stopImmediatePropagation();
            }, true);
        host.addEventListener("keydown", (e) => {
            if (e.key === "Escape" || e.code === "Escape") {
                e.preventDefault();
                dialogClose ? dialogClose() : close();
            }
        });

        const bar = el("div", "nse-bar");
        const back = button("Back", () => close(), "images/back.svg");
        const seg = el("div", "nse-seg");
        for (const m of MODES) {
            const b = el("button", null, m.label);
            b.type = "button";
            b.dataset.mode = m.id;
            b.addEventListener("click", async () => {
                window.__nswsUIClick?.();
                const t = await refreshLive();
                if (!t) {
                    note(ready ? "Open a track in the editor first." : "The editor isn't connected yet.", "bad");
                    return;
                }
                setMode(t.name, m.id);
                renderMode();
                syncMode();
            });
            seg.appendChild(b);
        }
        const save = button("Save to My Tracks", (e, b) => saveToLibrary(b), "images/save.svg", true);
        const send = button("Submit to Weekly Shorts", () => openSubmit(), "images/share.svg");
        const auto = el("div", "nse-seg");
        const autoBtn = el("button", null, "Autosave");
        autoBtn.type = "button";
        autoBtn.title = "Saves the open track in the editor every 30 seconds and when you go Back";
        autoBtn.addEventListener("click", () => {
            window.__nswsUIClick?.();
            setAutosave(!autosaveOn());
        });
        auto.appendChild(autoBtn);
        bar.append(back, seg, auto, el("div", "gap"), save, send);

        const info = el("div", "nse-info");
        const help = el("div", "nse-help");
        const noteEl = el("div", "nse-note");
        info.append(help, noteEl);

        const fallback = el("div", "nse-fallback hidden");
        const fbText = el("span", null, "The editor isn't answering. In the editor, open your track, press Export and paste the code here:");
        const fbBox = el("textarea");
        fbBox.placeholder = "PolyTrack2... or PolyTrackBE1...";
        fbBox.spellcheck = false;
        const fbUse = button("Use code", () => usePasted(), "images/paste.svg");
        const fbCopy = button("Copy track code", () => copyPendingCode(), "images/copy.svg");
        fbCopy.style.display = "none";
        const fbReload = button("Reload editor", () => {
            unloadFrame();
            editorOpen = false;
            createFrame();
        }, "images/refresh.svg");
        fallback.append(fbText, fbBox, fbUse, fbCopy, fbReload);

        const frameBox = el("div", "nse-frame");
        const loader = el("div", "nse-load busy hidden");
        const loaderBar = el("div", "nse-lbar");
        const loaderFill = el("div");
        loaderBar.appendChild(loaderFill);
        const loaderText = el("p");
        loader.append(el("h2", null, "Better Editor"), loaderBar, loaderText);
        frameBox.appendChild(loader);
        host.append(bar, info, fallback, frameBox);
        document.body.appendChild(host);
        ui = { seg, help, note: noteEl, fallback, fbBox, fbCopy, frameBox, autoBtn, loader, loaderText, loaderFill };
        renderPicker();
        renderMode();
        renderAutosave();
    }

    function renderPicker() {
        if (!ui?.select) return;
        const s = ui.select;
        s.textContent = "";
        if (manual) {
            const o = el("option", null, "Pasted: " + manual.name);
            o.value = MANUAL;
            s.appendChild(o);
        }
        if (ready) {
            const o = el("option", null, "+ New track");
            o.value = NEW;
            s.appendChild(o);
        }
        for (const t of tracks) {
            const o = el("option", null, t.name);
            o.value = t.name;
            s.appendChild(o);
        }
        if (!s.options.length) {
            const o = el("option", null, ready ? "No saved tracks yet" : "Waiting for the editor...");
            o.value = "";
            s.appendChild(o);
            s.disabled = true;
            selected = null;
        } else {
            s.disabled = false;
            if (!Array.from(s.options).some((o) => o.value === selected)) selected = s.options[0].value;
            s.value = selected;
        }
    }

    function renderMode() {
        if (!ui) return;
        const t = current();
        const mode = t ? modeOf(t.name) : "normal";
        for (const b of ui.seg.children) b.classList.toggle("on", b.dataset.mode === mode);
        ui.help.textContent = MODES.find((m) => m.id === mode).help + (mode === "normal" ? "" : " The editor's Test button tests in this mode.");
    }

    function post(msg) {
        try {
            frame?.contentWindow?.postMessage(Object.assign({ nsws: "be" }, msg), frameOrigin);
        } catch {}
    }

    function request(type, extra, ms) {
        if (!frame || !ready) return Promise.reject(new Error("The editor isn't connected."));
        const reqId = "e" + ++reqSeq;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(reqId);
                reject(new Error("The editor didn't answer."));
            }, ms || REQUEST_TIMEOUT_MS);
            pending.set(reqId, { resolve, timer });
            post(Object.assign({ type, reqId }, extra));
        });
    }

    window.addEventListener("message", (e) => {
        if (!frame || e.source !== frame.contentWindow || e.origin !== frameOrigin) return;
        const m = e.data;
        if (!m || m.nsws !== "be") return;
        if (m.type === "ready") {
            bridgeVersion = Number(m.version) || 0;
            if (!ready) onReady();
            return;
        }
        if (m.type === "progress" && !m.reqId) {
            const got = Number(m.loaded) || 0;
            const total = Number(m.total) || 0;
            if (!editorOpen && !ui.loader.classList.contains("hidden")) loading(total && got >= total ? "Starting the editor..." : "Downloading blocks: " + mb(got) + (total ? " of " + mb(total) : "") + " MB", total ? got / total : null);
            return;
        }
        if (m.type === "exit" && !m.reqId) {
            close();
            return;
        }
        if (m.type === "test" && !m.reqId) {
            startTest(m);
            return;
        }
        if (m.reqId && pending.has(m.reqId)) {
            const p = pending.get(m.reqId);
            pending.delete(m.reqId);
            clearTimeout(p.timer);
            p.resolve(m);
            return;
        }
        if (m.type === "changed") refreshList(true).then(() => refreshLive());
    });

    function createFrame() {
        build();
        const url = editorUrl();
        frameOrigin = new URL(url).origin;
        ready = false;
        frame = el("iframe");
        frame.title = "Custom Tracks Editor";
        frame.allow = "fullscreen; gamepad; autoplay; clipboard-read; clipboard-write";
        frame.src = url;
        let tries = 0;
        helloTimer = setInterval(() => {
            if (ready || ++tries > HELLO_TRIES) {
                clearInterval(helloTimer);
                helloTimer = null;
                return;
            }
            post({ type: "hello", version: 1 });
        }, HELLO_EVERY_MS);
        frame.addEventListener("load", () => {
            post({ type: "hello", version: 1 });
            if (!ready) {
                clearTimeout(fallbackTimer);
                fallbackTimer = setTimeout(() => showFallback(true), FALLBACK_AFTER_LOAD_MS);
            }
        });
        fallbackTimer = setTimeout(showFallback, FALLBACK_HARD_MS);
        ui.frameBox.appendChild(frame);
        if (!editorOpen) loading("Loading the editor...", null);
        renderPicker();
    }

    function unloadFrame() {
        clearInterval(helloTimer);
        clearTimeout(fallbackTimer);
        helloTimer = fallbackTimer = null;
        for (const p of pending.values()) clearTimeout(p.timer);
        pending.clear();
        frame?.remove();
        frame = null;
        ready = false;
        tracks = [];
        newestSave = 0;
        loaded();
    }

    // blocked: the page loaded but no editor answered, which is what a network that blocks github.io looks like.
    function showFallback(blocked) {
        if (ready || !ui) return;
        if (blocked === true && window.__nswsApiBase && !switched) {
            switched = true;
            // A remembered mirror that stops answering (the Worker over its limits) goes back to github.io.
            useMirror = !frame?.src.startsWith(window.__nswsApiBase);
            try {
                useMirror ? localStorage.setItem(MIRROR_KEY, String(Date.now())) : localStorage.removeItem(MIRROR_KEY);
            } catch {}
            unloadFrame();
            createFrame();
            loading("Trying another way in...", null);
            return;
        }
        loaded();
        ui.fallback.classList.remove("hidden");
        ui.fbCopy.style.display = pendingImport ? "" : "none";
        renderPicker();
    }

    function onReady() {
        ready = true;
        clearInterval(helloTimer);
        clearTimeout(fallbackTimer);
        helloTimer = fallbackTimer = null;
        ui?.fallback.classList.add("hidden");
        refreshList(false).then(() => {
            if (pendingImport) runImport();
            else if (!editorOpen) {
                let last = null;
                try {
                    last = localStorage.getItem(LAST_KEY);
                } catch {}
                const known = tracks.some((t) => t.name === last);
                selected = known ? last : NEW;
                renderPicker();
                renderMode();
                editTrack(known ? last : null, { fresh: !known, quiet: true });
            }
            copyLibrary();
        });
        if (!libWatch && lib()?.onChange) libWatch = lib().onChange(() => copyLibrary());
    }

    let bridgeVersion = 0;
    let libWatch = null;
    let copying = null;
    const mark = (t) => t.hash || String(t.updated || t.code.length);
    // Copies My Tracks into the editor's own Custom tracks (its Load list), each version once, so one deleted there stays deleted.
    function copyLibrary() {
        if (!ready || bridgeVersion < 3 || !lib()) return;
        if (copying) {
            copying.again = true;
            return;
        }
        copying = { again: false };
        (async () => {
            let done = {};
            try {
                done = JSON.parse(localStorage.getItem(COPIED_KEY)) || {};
            } catch {}
            const all = await lib().list();
            const kept = {};
            for (const t of all) if (done[t.id]) kept[t.id] = done[t.id];
            done = kept;
            const todo = all.filter((t) => typeof t.code === "string" && t.code.length <= COPY_MAX_CODE && done[t.id] !== mark(t));
            let added = false;
            for (let i = 0; i < todo.length; i += 20) {
                const batch = todo.slice(i, i + 20);
                const reply = await request("copy", { tracks: batch.map((t) => ({ code: t.code })) });
                if (!reply?.ok) break;
                let full = false;
                batch.forEach((t, j) => {
                    const r = reply.results?.[j];
                    if (!r || r.full) {
                        full = true;
                        return;
                    }
                    done[t.id] = mark(t);
                    if (r.ok && !r.existed) {
                        added = true;
                        if (t.mode && t.mode !== "normal") setMode(r.name, t.mode);
                    }
                });
                try {
                    localStorage.setItem(COPIED_KEY, JSON.stringify(done));
                } catch {}
                if (full) break;
            }
            if (added) await refreshList(false);
        })()
            .catch(() => {})
            .finally(() => {
                const again = copying?.again;
                copying = null;
                if (again) copyLibrary();
            });
    }

    let editorOpen = false;
    // Opens a saved track (or a new one when name is null) straight in the block editor.
    async function editTrack(name, opts = {}, attempt = 0) {
        let reply;
        try {
            reply = await request("edit", { name, force: !!opts.force, fresh: !!opts.fresh }, EDIT_TIMEOUT_MS);
        } catch (err) {
            loaded();
            note(err.message, "bad");
            return false;
        }
        if (!reply.ok && /loading/i.test(reply.error || "") && attempt < 40) {
            await new Promise((r) => setTimeout(r, 1000));
            return editTrack(name, opts, attempt + 1);
        }
        if (reply.dirty) {
            const saveFirst = button("Save it first", async () => {
                let saved;
                try {
                    saved = await request("autosave");
                } catch {}
                closeDialog();
                if (!saved?.saved && saved?.reason !== "clean") {
                    note(saved?.reason === "unnamed" ? "Your track has no name yet: press Save in the editor first, then pick the other track." : "The editor couldn't save your track.", "bad");
                    revert(opts.before);
                    return;
                }
                editTrack(name, { ...opts, force: true });
            }, "images/save.svg", true);
            const discard = button("Throw it away", () => {
                closeDialog();
                editTrack(name, { ...opts, force: true });
            }, "images/erase.svg");
            const cancel = button("Keep editing", () => {
                closeDialog();
                revert(opts.before);
            }, "images/back.svg");
            dialog("Unsaved changes", [el("p", null, "The track open in the editor has changes that aren't saved.")], [cancel, discard, saveFirst]);
            return false;
        }
        if (!reply.ok) {
            loaded();
            note(reply.error || "The editor couldn't open that track.", "bad");
            revert(opts.before);
            return false;
        }
        editorOpen = true;
        loaded();
        try {
            name ? localStorage.setItem(LAST_KEY, name) : localStorage.removeItem(LAST_KEY);
        } catch {}
        refreshLive();
        if (!opts.quiet) note(name ? 'Editing "' + name + '".' : "New track. Press Save in the editor to give it a name.", "good");
        return true;
    }

    function revert(before) {
        selected = before ?? null;
        renderPicker();
        renderMode();
    }

    async function refreshList(pickNewest) {
        let reply;
        try {
            reply = await request("list");
        } catch {
            return;
        }
        tracks = Array.isArray(reply.tracks) ? reply.tracks.filter((t) => t && typeof t.code === "string" && typeof t.name === "string") : [];
        tracks.sort((a, b) => (b.saveTime || 0) - (a.saveTime || 0));
        const top = tracks[0];
        if (top && (top.saveTime || 0) > newestSave) {
            if (pickNewest || selected == null) selected = top.name;
            newestSave = top.saveTime || 0;
        }
        renderPicker();
        renderMode();
    }

    async function runImport(attempt = 0) {
        const job = pendingImport;
        if (!job || !ready) return;
        let reply;
        try {
            reply = await request("import", { code: job.code });
        } catch (err) {
            if (!editorOpen) loaded();
            note(err.message, "bad");
            return;
        }
        if (pendingImport !== job) return;
        if (!reply.ok) {
            if (attempt < 15 && /loading/i.test(reply.error || "")) {
                setTimeout(() => runImport(attempt + 1), 1500);
                return;
            }
            pendingImport = null;
            if (!editorOpen) loaded();
            note(reply.error || "The editor couldn't take that track.", "bad");
            return;
        }
        pendingImport = null;
        if (job.mode && job.mode !== "normal") setMode(reply.name, job.mode);
        await refreshList(false);
        const before = selected;
        selected = reply.name;
        renderPicker();
        renderMode();
        if (await editTrack(reply.name, { before, quiet: true })) note('Editing "' + reply.name + '".', "good");
    }

    async function usePasted() {
        const code = ui.fbBox.value.trim();
        if (!code) return;
        const T = lib();
        const info = T ? await T.parseAsync(code).catch(() => null) : null;
        if (T && !info?.ok) {
            note(info?.error || "That isn't a track code.", "bad");
            return;
        }
        manual = { name: info?.name || "Pasted track", code };
        selected = MANUAL;
        ui.fbBox.value = "";
        renderPicker();
        renderMode();
        note('Using the pasted "' + manual.name + '".', "good");
    }

    async function copyPendingCode() {
        if (!pendingImport) return;
        try {
            await navigator.clipboard.writeText(pendingImport.code);
            note("Code copied. In the editor, use Import in the track list and paste it.", "good");
        } catch {
            note("Your browser wouldn't copy the code.", "bad");
        }
    }

    async function need() {
        const t = await refreshLive();
        if (!t) {
            note(ready ? "Open a track in the editor first." : "The editor isn't connected yet.", "bad");
            return null;
        }
        if (!lib()) {
            note("Custom Tracks didn't load. Reload the page and try again.", "bad");
            return null;
        }
        return t;
    }

    async function busy(b, fn) {
        if (b) b.disabled = true;
        try {
            await fn();
        } catch (err) {
            note(err?.message || "Something went wrong.", "bad");
        } finally {
            if (b) b.disabled = false;
        }
    }

    async function saveToLibrary(b) {
        // Disabled from the first await: two adds of one new track at once both miss each other and make two entries.
        busy(b, async () => {
            const t = await need();
            if (!t) return;
            await lib().add(t.code, { mode: modeOf(t.name), source: "editor" });
            note('Saved "' + t.name + '" to My Tracks.', "good");
        });
    }

    function dialog(title, body, actions) {
        closeDialog();
        const dim = el("div", "nse-dim");
        const box = el("div", "nse-box");
        box.tabIndex = -1;
        const bodyEl = el("div", "nse-body");
        bodyEl.append(...body);
        const act = el("div", "nse-actions");
        act.append(...actions);
        box.append(el("h1", null, title), bodyEl, act);
        dim.appendChild(box);
        dim.addEventListener("pointerdown", (e) => {
            if (e.target === dim) closeDialog();
        });
        host.appendChild(dim);
        box.focus();
        dialogClose = () => {
            dim.remove();
            dialogClose = null;
        };
        return dialogClose;
    }

    function closeDialog() {
        dialogClose?.();
    }

    function row(label, value) {
        const r = el("div", "nse-row");
        r.append(el("label", null, label));
        if (value instanceof Node) r.appendChild(value);
        else r.appendChild(el("div", "val", value));
        return r;
    }

    async function openSubmit() {
        const t = await need();
        if (!t) return;
        const T = lib();
        const info = await T.parseAsync(t.code).catch(() => null);
        if (!info?.ok) {
            note(info?.error || "That track code can't be read.", "bad");
            return;
        }
        let mode = modeOf(t.name);
        const seg = el("div", "nse-seg");
        for (const m of MODES) {
            const b = el("button", m.id === mode ? "on" : null, m.label);
            b.type = "button";
            b.addEventListener("click", () => {
                mode = m.id;
                for (const x of seg.children) x.classList.toggle("on", x === b);
                modeHelp.textContent = m.help;
            });
            seg.appendChild(b);
        }
        const modeHelp = el("div", "nse-dimtext", MODES.find((m) => m.id === mode).help);
        const noteBox = el("textarea");
        noteBox.maxLength = 500;
        noteBox.placeholder = "Anything Race Control should know (optional)";
        const status = el("p");
        const mine = el("div");
        mine.appendChild(el("p", "nse-dimtext", "Loading..."));

        const body = [
            el("p", null, "Suggest this track for a future Not So Weekly Shorts week. Race Control reviews every track, and you can follow it here."),
            el("p", "bad", "Keep this track to yourself after you submit it: don't post or share it anywhere (code, link, video or screenshots). A submitted track that has been posted is disqualified."),
            el("div", "nse-sec", "Track"),
            row("Name", info.name || t.name),
            row("Author", info.author || "-"),
            row("Mode", seg),
            modeHelp,
        ];
        const noteRow = el("div", "nse-row col");
        noteRow.append(el("label", null, "Note"), noteBox);
        body.push(noteRow, status, el("div", "nse-sec", "My submissions"), mine);

        let sent = false;
        const send = button("Submit", (e, b) => {
            if (sent) return;
            const user = T.user?.() || {};
            if (!user.token) {
                status.className = "bad";
                status.textContent = "Your player token isn't ready yet. Open any track's leaderboard once, then try again.";
                return;
            }
            busy(b, async () => {
                status.className = "";
                status.textContent = "Submitting...";
                let answer;
                try {
                    answer = await T.api("nsws/tracks/submit", {
                        token: user.token,
                        nickname: user.nickname || "",
                        code: await T.packCode([{ code: t.code, mode }], info.name || t.name),
                        mode,
                        name: info.name || t.name,
                        author: info.author || "",
                        trackId: info.trackId || null,
                        env: info.env ?? null,
                        note: noteBox.value.trim().slice(0, 500),
                    });
                } catch (err) {
                    status.className = "bad";
                    status.textContent = err?.message || "Couldn't send the track.";
                    return;
                }
                setMode(t.name, mode);
                renderMode();
                T.markSubmitted?.(t.code, { id: answer?.id || "", at: Date.now() }).catch(() => {});
                status.className = "good";
                status.textContent = "Submitted! Race Control will take a look. Remember: don't post this track anywhere, or it gets disqualified.";
                sent = true;
                loadMine(mine, user.token);
            }).then(() => {
                if (sent) b.disabled = true;
            });
        }, "images/share.svg", true);
        dialog("Submit to Weekly Shorts", body, [button("Close", () => closeDialog(), "images/back.svg"), send]);
        const user = T.user?.() || {};
        if (user.token) loadMine(mine, user.token);
        else mine.firstChild.textContent = "Your submissions show here once your player token is ready.";
    }

    async function loadMine(box, token) {
        let list;
        try {
            list = (await lib().api("nsws/tracks/submissions/mine", { token }))?.submissions || [];
        } catch (err) {
            box.textContent = "";
            box.appendChild(el("p", "bad", err?.message || "Couldn't load your submissions."));
            return;
        }
        box.textContent = "";
        if (!list.length) {
            box.appendChild(el("p", "nse-dimtext", "You haven't sent any tracks yet."));
            return;
        }
        for (const s of list) {
            const item = el("div", "nse-sub");
            const top = el("div");
            top.append(el("span", null, s.name || "Untitled"), el("span", "st-" + s.status, s.status === "planned" && s.week ? "Planned for week " + s.week : STATUS[s.status] || s.status || ""));
            const sub = el("div", "dim");
            sub.append(el("span", null, s.created ? new Date(s.created).toLocaleDateString() : ""), el("span", null, s.ownerNote ? "Race Control: " + s.ownerNote : ""));
            item.append(top, sub);
            box.appendChild(item);
        }
    }

    function show() {
        build();
        // A test race that never called onExit must not keep blocking the next test or the live refresh.
        testing = false;
        clearTimeout(hideTimer);
        hideTimer = null;
        if (!frame) createFrame();
        host.classList.remove("hidden");
        try {
            (frame || host).focus();
        } catch {}
        if (ready) {
            refreshLive();
            copyLibrary();
        }
        // Follows tracks opened with the editor's own Load, so the mode shown is that track's.
        liveTimer ??= setInterval(() => {
            if (ready && !testing && host && !host.classList.contains("hidden")) refreshLive();
        }, 3000);
    }
    let liveTimer = null;

    function hide() {
        if (!host || host.classList.contains("hidden")) return;
        closeDialog();
        // A hidden iframe can keep keyboard focus, and the game (or a test race) would get no keys.
        if (host.contains(document.activeElement)) {
            try {
                document.activeElement.blur();
                window.focus();
            } catch {}
        }
        host.classList.add("hidden");
        autosave();
    }

    function open(track) {
        const wasLoaded = !!frame;
        show();
        note(wasLoaded ? "" : "Unsaved work stays in the editor until you close or reload this page" + (autosaveOn() ? "; autosave is on." : ". Turn on Autosave, or use the editor's Save, to keep it."));
        const code = typeof track === "string" ? track : track?.code;
        if (typeof code !== "string" || !code) return;
        pendingImport = { code, mode: typeof track === "object" ? track.mode : null };
        if (ready) runImport();
        else {
            note("Sending the track to the editor...");
            if (ui && !ui.fallback.classList.contains("hidden")) ui.fbCopy.style.display = "";
        }
    }

    function close() {
        hide();
    }

    window.__nswsEditor = { open, close };
})();
