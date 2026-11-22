// Custom Tracks Editor: Better Editor PT in a full-screen iframe with an NSWS bar on top. Tracks move
// between the two through BE's nsws_bridge.js (postMessage). The BE editor keeps unsaved work only in
// memory, so Back only hides the iframe; it stays loaded until the page is closed or reloaded.
(function () {
    "use strict";
    // The first-launch graphics picker belongs to the main menu; Custom Tracks and the editor can open a
    // track over it, so it waits out of sight until the menu is back.
    const pickerStyle = document.createElement("style");
    pickerStyle.textContent =
        "body:has(.track-info-ui:not(.hidden)) .device-preset-ui,body:has(.track-selection-ui:not(.hidden)) .device-preset-ui,body:has(.game-ui) .device-preset-ui,body:has(#nsws-editor:not(.hidden)) .device-preset-ui{display:none!important;}" +
        "body:has(#nsws-editor:not(.hidden)) #nsws-cuppa{display:none!important;}";
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
    // Library mode: the My Tracks id of the track last open in the editor.
    const LAST_ID_KEY = "nswsEditorLastId";
    // Library mode: editor stores ("store:account") whose own saved tracks went into My Tracks once.
    const MOVED_KEY = "nswsEditorMoved";
    // Set when github.io didn't load here, so the editor comes through the NSWS Worker for a week.
    const MIRROR_KEY = "nswsEditorMirror";
    const MIRROR_FOR_MS = 7 * 86400000;
    const COPIED_KEY = "nswsEditorCopied";
    const DUPES_KEY = "nswsEditorCopiedDupes";
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
#nsws-editor.cupmode .nse-bar{display:none;}
#nsws-editor.cupmode .nse-help:not(.special){display:none;}
#nsws-editor.cupmode .nse-info{padding-top:5px;}
#nsws-editor.cupmode .nse-info:not(:has(.nse-help.special)):has(.nse-note:empty){display:none;}
#nsws-editor .nse-cup{flex-shrink:0;display:flex;flex-direction:column;background:#212b58;border-bottom:1px solid rgba(255,255,255,.15);}
#nsws-editor .nse-cup.hidden{display:none;}
#nsws-editor .nse-cup .top{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;padding:6px 10px 5px;}
#nsws-editor .nse-cup .gap{flex:1 1 0;min-width:0;}
#nsws-editor .nse-cup .ttl{display:flex;flex-direction:column;min-width:0;flex:0 1 auto;line-height:1.15;}
#nsws-editor .nse-cup .ttl>b{font-weight:normal;font-size:20px;max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#nsws-editor .nse-cup .ttl>span{font-size:13px;color:rgba(255,255,255,.55);white-space:nowrap;}
#nsws-editor .nse-cup .clock{min-width:84px;padding:1px 14px;font-size:26px;text-align:center;font-variant-numeric:tabular-nums;background:#192042;clip-path:polygon(8px 0,100% 0,calc(100% - 8px) 100%,0 100%);}
#nsws-editor .nse-cup .clock.warn{color:#ff9a9a;}
#nsws-editor .nse-cup .row{display:flex;flex-wrap:wrap;align-items:center;gap:4px 14px;padding:4px 10px 5px 12px;background:#28346a;font-size:15px;}
#nsws-editor .nse-cup .row .button{padding:3px 10px;font-size:15px;}
#nsws-editor .nse-cup .st{flex:1 1 240px;color:rgba(255,255,255,.75);}
#nsws-editor .nse-cup .st.good{color:#96ff96;}
#nsws-editor .nse-cup .st.bad{color:#ff9a9a;}
#nsws-editor .nse-cup .who{display:flex;flex-wrap:wrap;gap:2px 10px;color:rgba(255,255,255,.5);}
#nsws-editor .nse-cup .who>span.done{color:#96ff96;}
#nsws-editor .nse-cup .who>span.me{text-decoration:underline;}
#nsws-editor .nse-cup .who>span.can{cursor:pointer;text-decoration:underline dotted rgba(255,255,255,.4);text-underline-offset:3px;}
#nsws-editor .nse-cup .who>span.can:hover{color:#fff;}
#nsws-editor .nse-cup .who>span.watched{color:#ffd26b;text-decoration:underline;}
#nsws-editor .nse-cup .watch{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;padding:4px 10px 5px 12px;background:#3a3f7a;font-size:15px;}
#nsws-editor .nse-cup .watch.hidden{display:none;}
#nsws-editor .nse-cup .watch .button{padding:3px 10px;font-size:15px;}
#nsws-editor .nse-cup .watch>b{font-weight:normal;color:#ffd26b;}
#nsws-editor .nse-cup .watch>.gap{flex:1 1 0;}
@media (pointer:coarse) and (max-height:500px){
#nsws-editor .nse-cup .top{padding:3px 8px;gap:4px 8px;}
#nsws-editor .nse-cup .top .nse-seg>button{font-size:13px;padding:4px 6px;}
#nsws-editor .nse-cup .ttl>span{display:none;}
#nsws-editor .nse-cup .ttl>b{font-size:16px;max-width:110px;}
#nsws-editor .nse-cup .clock{min-width:64px;padding:1px 10px;font-size:20px;}
#nsws-editor .nse-cup .row{padding:2px 8px;gap:2px 8px;font-size:13px;}
#nsws-editor .nse-cup .st{flex-basis:170px;}
#nsws-editor .nse-cup .who>span.can{padding:6px 2px;}
#nsws-editor .nse-cup .watch{padding:2px 8px;gap:2px 6px;font-size:13px;}
#nsws-editor .nse-cup .row .button,#nsws-editor .nse-cup .watch .button{min-height:28px;font-size:13px;}
}
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
    // A Cuppa Build Off's bar: { title, status, sent, left(): ms, onSubmit() }.
    let cupBar = null;
    let cupTimer = null;
    // A warning shown in place of the cup bar's status line (no finish in the last seconds).
    let cupAlert = "";
    let wantFresh = false;

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

    // Library mode: a track's mode is on its My Tracks entry; a new track's waits in newMode until its first save.
    let newMode = "normal";
    const isId = (k) => typeof k === "string" && !!k && !k.startsWith("tmp:");
    const validMode = (m) => (MODES.some((x) => x.id === m) ? m : "normal");
    function modeFor(t) {
        if (!t) return "normal";
        if (!libMode || t === manual) return modeOf(t.name);
        if (!isId(t.key)) return newMode;
        return validMode(libTracks.find((x) => x.id === t.key)?.mode);
    }

    function setModeFor(t, mode) {
        if (!t) return;
        if (!libMode || t === manual) return setMode(t.name, mode);
        if (!isId(t.key)) {
            newMode = mode;
            return;
        }
        // Copies: libTracks holds the library's own objects.
        libTracks = libTracks.map((x) => (x.id === t.key ? { ...x, mode } : x));
        lib()?.update(t.key, { mode }).catch((e) => note(e?.message || "Couldn't save the mode.", "bad"));
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
        live = t && typeof t.code === "string" ? { name: t.name || "Unnamed Track", named: !!t.name, author: t.author || "", code: t.code, key: typeof reply.key === "string" ? reply.key : null } : null;
        // A new track saved or loaded inside the editor is the one to reopen after a reload.
        if (libMode) {
            if (isId(live?.key)) {
                try {
                    if (localStorage.getItem(LAST_ID_KEY) !== live.key) localStorage.setItem(LAST_ID_KEY, live.key);
                } catch {}
            }
        } else if (live?.named) {
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
        post({ type: "mode", mode: modeFor(t) });
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

    function focusFrame() {
        if (!frame || !host || host.classList.contains("hidden") || dialogClose) return;
        try {
            frame.focus();
        } catch {}
    }

    // The mode picked up here goes to the track's My Tracks entry at once, when it has one.
    function pushMode(name, mode) {
        if (libMode) return;
        const T = lib();
        let id = null;
        try {
            id = JSON.parse(localStorage.getItem(LINKS_KEY))?.[bridgeStore]?.[name]?.id || null;
        } catch {}
        if (!T?.update || !id) return;
        T.get(id)
            .then((t) => t && (t.mode || "normal") !== mode && T.update(id, { mode }))
            .catch(() => {});
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
                if (!host || host.classList.contains("hidden") || host.contains(e.target)) return;
                // Typing in the chat (or Cuppa's, inside its shadow root) above the editor: refocusing the frame ate every key.
                if (e.composedPath().some((t) => t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable || t.id === "nsws-chat" || t.id === "nsws-chat-feed")) return;
                e.stopImmediatePropagation();
                // Focus that drifted to the page behind (a popup that closed, say) leaves the editor and its test drive deaf to the keyboard.
                if (type === "keydown" && !document.querySelector("dialog[open], .nt-host:not([hidden])")) focusFrame();
            }, true);
        host.addEventListener("keydown", (e) => {
            if (e.key === "Escape" || e.code === "Escape") {
                e.preventDefault();
                dialogClose ? dialogClose() : cupBar?.onBack ? cupBar.onBack() : close();
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
                setModeFor(t, m.id);
                renderMode();
                syncMode();
                pushMode(t.name, m.id);
            });
            seg.appendChild(b);
        }
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
        bar.append(back, seg, auto, el("div", "gap"), send);
        // A click up here takes the keyboard from the editor below; its shortcuts get it back unless a dialog opened.
        bar.addEventListener("click", () => setTimeout(focusFrame, 0));

        // A Cuppa Build Off replaces the bar above with the cup's own: the mode buttons move in here while it shows.
        const cup = el("div", "nse-cup hidden");
        const cupTop = el("div", "top");
        const cupBack = button("Back", () => (cupBar?.onBack ? cupBar.onBack() : close()), "images/back.svg");
        cupBack.title = "Back to the cup (Esc). The editor keeps your track.";
        const cupTtl = el("div", "ttl");
        const cupTitle = el("b");
        const cupPhase = el("span");
        cupTtl.append(cupTitle, cupPhase);
        const cupClock = el("span", "clock");
        const cupGap = el("div", "gap");
        const cupSend = button("Send to the cup", () => cupBar?.onSubmit(), "images/checkmark.svg", true);
        cupTop.append(cupBack, cupTtl, cupClock, cupGap, cupSend);
        const cupRow = el("div", "row");
        const cupStatus = el("span", "st");
        const cupWho = el("span", "who");
        // Press twice: the first press only arms it for 3 s.
        const twice = (label, run) => {
            let armed = 0;
            const b = button(label, () => {
                if (Date.now() < armed) return run();
                armed = Date.now() + 3000;
                b.lastChild.textContent = "Press again";
                setTimeout(() => (b.lastChild.textContent = b.dataset.label), 3000);
            });
            b.dataset.label = label;
            return b;
        };
        const cupMore = button("+2 min", () => cupBar?.more?.(), "images/timer.svg");
        const cupEnd = twice("End building now", () => cupBar?.endNow?.());
        const cupLeave = twice("Leave cup", () => cupBar?.onLeave?.());
        cupLeave.prepend(Object.assign(el("img"), { src: "images/quit.svg", alt: "" }));
        cupRow.append(cupStatus, cupWho, cupMore, cupEnd, cupLeave);
        // Watching another builder: who, the next and previous builder, their camera, and back to your own track.
        const cupWatch = el("div", "watch hidden");
        const cupWatchName = el("b");
        const cupPrev = button("", () => cupBar?.watching?.onPrev?.(), "images/arrow_left.svg");
        cupPrev.title = "Watch the builder before";
        const cupNext = button("", () => cupBar?.watching?.onNext?.(), "images/arrow_right.svg");
        cupNext.title = "Watch the next builder";
        const cupFollow = button("Follow their camera", () => cupBar?.watching?.onFollow());
        cupFollow.title = "Look around yourself any time; this puts you back on their camera.";
        const cupStop = button("Back to my track", () => cupBar?.watching?.onStop(), "images/back.svg");
        cupWatch.append(el("span", null, "Watching"), cupWatchName, cupPrev, cupNext, el("div", "gap"), cupFollow, cupStop);
        cup.append(cupTop, cupRow, cupWatch);
        cup.addEventListener("click", () => setTimeout(focusFrame, 0));

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
        const loaderTitle = el("h2", null, "Better Editor");
        loader.append(loaderTitle, loaderBar, loaderText);
        frameBox.appendChild(loader);
        host.append(bar, cup, info, fallback, frameBox);
        document.body.appendChild(host);
        ui = { host, bar, auto, seg, help, note: noteEl, fallback, fbBox, fbCopy, frameBox, autoBtn, loader, loaderTitle, loaderText, loaderFill, send, cup, cupTop, cupGap, cupTitle, cupPhase, cupClock, cupStatus, cupWho, cupSend, cupMore, cupEnd, cupLeave, cupWatch, cupWatchName, cupPrev, cupNext, cupFollow, cupStop };
        renderCup();
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
        const mode = modeFor(t);
        for (const b of ui.seg.children) b.classList.toggle("on", b.dataset.mode === mode);
        ui.help.textContent = MODES.find((m) => m.id === mode).help + (mode === "normal" ? "" : " The editor's Test button tests in this mode.");
        ui.help.classList.toggle("special", mode !== "normal");
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
            bridgeStore = typeof m.store === "string" && m.store ? m.store : null;
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
        if (m.type === "run" && !m.reqId) {
            saveRun(m);
            return;
        }
        if (m.type === "assets" && m.reqId && typeof m.op === "string") {
            assetRequest(m);
            return;
        }
        if (m.type === "save" && !m.reqId && libMode) {
            saveChain = saveChain.then(() => saveFromEditor(m)).catch((e) => console.warn("[Editor save]", e));
            return;
        }
        if (m.type === "delete" && !m.reqId && libMode) {
            deleteFromEditor(m);
            return;
        }
        if (m.reqId && pending.has(m.reqId)) {
            const p = pending.get(m.reqId);
            pending.delete(m.reqId);
            clearTimeout(p.timer);
            p.resolve(m);
            return;
        }
        if (m.type === "changed" && libMode) refreshLive();
        else if (m.type === "changed")
            refreshList(true).then(() => {
                refreshLive();
                copyLibrary();
            });
    });

    // The editor's asset library (BE tm_assets.js). Reading is public; liking, publishing and deleting are done with
    // this player's account, so they go through here and the token never reaches the editor's frame.
    const ASSET_OPS = new Set(["me", "publish", "update", "like", "use", "delete"]);
    async function assetRequest(m) {
        const answer = (body) => post(Object.assign({ type: "assets-reply", reqId: m.reqId }, body));
        const T = lib();
        const args = m.args && typeof m.args === "object" ? m.args : {};
        try {
            if (!T?.api) throw new Error("Custom tracks aren't loaded yet.");
            let data;
            if (m.op === "base") data = { base: window.__nswsApiBase || null };
            else if (m.op === "list") data = await T.api("nsws/tracks/assets");
            else if (m.op === "get") {
                if (!/^[0-9A-Za-z]{9}$/.test(args.id || "")) throw new Error("That asset was deleted.");
                data = await T.api("nsws/tracks/asset/" + args.id);
            } else if (ASSET_OPS.has(m.op)) {
                const user = T.user?.() || {};
                if (!user.token) throw new Error("Your player profile isn't ready yet. Open any leaderboard once, then try again.");
                data = await T.api("nsws/tracks/assets/" + m.op, Object.assign({}, args, { token: user.token, nickname: user.nickname || "" }), { timeout: m.op === "publish" || m.op === "update" ? 90000 : 25000 });
            } else throw new Error("Bad request.");
            answer({ ok: true, data });
        } catch (e) {
            answer({ ok: false, error: e?.message || "Something went wrong.", status: e?.status ?? 0, data: e?.data ?? null });
        }
    }

    // A finished Test in the editor is a run on that track, saved and uploaded like a race.
    async function saveRun(m) {
        const save = window.__nswsTrackBoard?.saveRun;
        if (!save || typeof m.trackId !== "string" || !/^[0-9a-f]{64}$/.test(m.trackId) || !Number.isSafeInteger(m.frames) || m.frames <= 0 || typeof m.recording !== "string") return;
        if (m.be) (window.__nswsBEBoardIds ??= new Set()).add(m.trackId);
        const toast = window.__nswsTracks?.ui?.toast;
        try {
            const r = await save(m.trackId, m.frames, m.recording, Number.isSafeInteger(m.physics) && m.physics > 0 ? m.physics : null);
            if (!r?.pb) return;
            toast?.("New best saved");
            await r.upload;
        } catch (e) {
            console.warn(e);
            toast?.(e?.message || "Couldn't upload that run.");
        }
    }

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
            post({ type: "hello", version: 1, assets: 1 });
        }, HELLO_EVERY_MS);
        frame.addEventListener("load", () => {
            post({ type: "hello", version: 1, assets: 1 });
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
        libMode = false;
        libSent.clear();
        tmpIds.clear();
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
        if (!libWatch && lib()?.onChange) libWatch = lib().onChange(() => copyLibrary());
        if (bridgeVersion >= 9 && lib()) {
            startLibrary().then(() => {
                if (!ready) return;
                if (pendingImport) runImport();
                else if (wantFresh) {
                    wantFresh = false;
                    editTrack(null, { fresh: true, quiet: true });
                } else if (!editorOpen) openLast();
            });
            return;
        }
        refreshList(false).then(() => {
            if (pendingImport) runImport();
            else if (wantFresh) {
                wantFresh = false;
                selected = NEW;
                renderPicker();
                renderMode();
                editTrack(null, { fresh: true, quiet: true });
            } else if (!editorOpen) {
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
    }

    let bridgeVersion = 0;
    let bridgeStore = null;
    let libWatch = null;
    let copying = null;

    // Bridge 9+ (library mode): the editor's custom tracks, its Load list, are My Tracks itself, in the order My Tracks
    // shows them. The editor keeps no tracks of its own; its Save and delete come here by My Tracks id.
    let libMode = false;
    // id -> hash of the code this frame has; the code is sent again only when it changed.
    const libSent = new Map();
    let libTracks = [];
    let libTimer = null;
    let libChain = Promise.resolve();
    let saveChain = Promise.resolve();
    // "tmp:n" (the editor's name for a new track until it has an id) -> My Tracks id.
    const tmpIds = new Map();

    async function startLibrary() {
        libMode = true;
        await pushLibrary().catch((e) => console.warn("[Editor library]", e));
        // In the background: it may wait on the server, and what it adds reaches the editor with the next push.
        moveEditorTracks().catch((e) => console.warn("[Editor library]", e));
    }

    function schedulePush(ms = 80) {
        if (!libMode) return;
        clearTimeout(libTimer);
        libTimer = setTimeout(() => pushLibrary().catch((e) => console.warn("[Editor library]", e)), ms);
    }

    function pushLibrary() {
        const p = libChain.then(pushOnce);
        libChain = p.catch(() => {});
        return p;
    }

    async function pushOnce(attempt = 0) {
        const T = lib();
        if (!libMode || !ready || !T) return;
        const all = await (T.listShown ? T.listShown() : T.list());
        const items = [];
        for (const t of all) {
            if (typeof t.code !== "string" || !t.code) continue;
            const item = { key: t.id, hash: t.hash || String(t.updated || 0), saveTime: t.updated || 0 };
            if (libSent.get(t.id) !== item.hash) item.code = t.code;
            items.push(item);
        }
        const r = await request("library", { tracks: items }, 60000);
        if (!r?.ok) throw new Error("The editor didn't take My Tracks.");
        libTracks = all;
        const need = new Set(Array.isArray(r.need) ? r.need : []);
        libSent.clear();
        for (const it of items) if (!need.has(it.key)) libSent.set(it.key, it.hash);
        renderMode();
        if (need.size && attempt < 2) return pushOnce(attempt + 1);
    }

    // The editor's Save, autosave or import: {key: My Tracks id or null, tmp: "tmp:n" for a new track, code, name, imported}.
    async function saveFromEditor(m) {
        const T = lib();
        if (!T || typeof m.code !== "string") return;
        const tmp = typeof m.tmp === "string" ? m.tmp : null;
        const key = (typeof m.key === "string" && m.key) || (tmp && tmpIds.get(tmp)) || null;
        let t = null;
        let old = null;
        let error = null;
        try {
            old = key ? await T.get(key) : null;
            // An import that My Tracks already has keeps that entry's mode.
            t = old ? await T.replaceCode(key, m.code) : await T.add(m.code, { mode: m.imported ? undefined : newMode, source: m.imported ? "import" : "editor", fresh: !m.imported });
        } catch (e) {
            error = e?.message || null;
        }
        if (t && tmp) tmpIds.set(tmp, t.id);
        if (t) libSent.set(t.id, t.hash);
        post({ type: "saved", tmp, key: typeof m.key === "string" ? m.key : null, id: t?.id || null, hash: t?.hash || null, ok: !!t });
        if (t && !m.imported) {
            try {
                localStorage.setItem(LAST_ID_KEY, t.id);
            } catch {}
        }
        const name = t?.name || m.name || "Unnamed Track";
        if (!t) tellSaved({ saved: [], failed: [{ name, error }] });
        else if (!old || old.hash !== t.hash) tellSaved({ saved: [name], failed: [] });
        schedulePush();
        refreshLive();
    }

    // The trash button in the editor's Load list.
    async function deleteFromEditor(m) {
        if (!isId(m.key)) return;
        const T = lib();
        const t = await T?.get(m.key).catch(() => null);
        if (!t) return schedulePush();
        try {
            await T.remove(m.key);
            if (host && !host.classList.contains("hidden")) note('Deleted "' + (t.name || "Unnamed Track") + '" from My Tracks.');
        } catch (e) {
            note(e?.message || "Couldn't delete that track from My Tracks.", "bad");
            schedulePush(0);
        }
    }

    // The editor's own saved tracks (from before library mode) go into My Tracks once per editor store and account, when
    // My Tracks doesn't have them already. Tracks the old two-way sync linked are in My Tracks, or were deleted there.
    async function moveEditorTracks() {
        const T = lib();
        const synced = (await T.whenSynced?.()) !== false;
        const token = T.user?.().token || "";
        const acct = token ? (await digest("nsws-editor:" + token)).slice(0, 12) : "";
        let moved = {};
        try {
            moved = JSON.parse(localStorage.getItem(MOVED_KEY)) || {};
        } catch {}
        const tag = (bridgeStore || "?") + ":" + acct;
        if (moved[tag] || !synced) return;
        const reply = await request("list");
        if (!reply?.loaded || !Array.isArray(reply.tracks)) return;
        let links = {};
        try {
            links = JSON.parse(localStorage.getItem(LINKS_KEY))?.[bridgeStore] || {};
        } catch {}
        const all = await T.list();
        const byId = new Map(all.map((t) => [t.id, t]));
        const nameFits = (en, tn) => en === tn || (en.startsWith(tn + " (") && /^ \(\d+\)$/.test(en.slice(tn.length)));
        const failed = [];
        for (const e of reply.tracks) {
            if (!e || typeof e.name !== "string" || typeof e.code !== "string") continue;
            const l = links[e.name];
            if (l && l.a !== acct) continue;
            if (l?.id) {
                const t = byId.get(l.id);
                // Saved in the editor after the last sync and not changed in My Tracks since: that save goes over.
                if (t && l.e && t.hash === l.h && (await digest(e.code)) !== l.e) await T.replaceCode(t.id, e.code).catch((err) => failed.push({ name: e.name, error: err?.message }));
                continue;
            }
            const flat = await digest(e.code.replace(/\s+/g, ""));
            if (all.some((t) => (t.hash || "").startsWith(flat) || (e.id && t.trackId === e.id && nameFits(e.name, t.name)))) continue;
            try {
                await T.add(e.code, { mode: modeOf(e.name), source: "editor" });
            } catch (err) {
                failed.push({ name: e.name, error: err?.message });
            }
        }
        if (failed.length) {
            tellSaved({ saved: [], failed });
            return;
        }
        moved[tag] = Date.now();
        try {
            localStorage.setItem(MOVED_KEY, JSON.stringify(moved));
        } catch {}
    }

    // After a reload: the track last open, or a new one.
    function openLast() {
        let lastId = null;
        let lastName = null;
        try {
            lastId = localStorage.getItem(LAST_ID_KEY);
            lastName = localStorage.getItem(LAST_KEY);
        } catch {}
        const t = libTracks.find((x) => x.id === lastId) || (lastId == null && lastName != null ? libTracks.find((x) => x.name === lastName) : null);
        try {
            localStorage.removeItem(LAST_KEY);
        } catch {}
        editTrack(null, t ? { key: t.id, label: t.name, quiet: true } : { fresh: true, quiet: true });
    }

    const mark = (t) => t.hash || String(t.updated || t.code.length);
    // Keeps My Tracks and the editor's own Custom tracks (its Load list) the same, both ways.
    function copyLibrary() {
        if (libMode) return schedulePush();
        if (!ready || bridgeVersion < 3 || !lib()) return;
        if (copying) {
            copying.again = true;
            return;
        }
        copying = { again: false };
        (bridgeVersion >= 5 && bridgeStore ? syncBoth() : copyOnce())
            .then((report) => report && tellSaved(report))
            .catch((e) => console.warn("[Editor sync]", e))
            .finally(() => {
                const again = copying?.again;
                copying = null;
                if (again) copyLibrary();
            });
    }

    // The editor's Save is the only save: what it put in My Tracks (or couldn't) shows in the bar.
    function tellSaved(report) {
        if (!host || host.classList.contains("hidden")) return;
        const bad = report.failed[0];
        if (bad) note('"' + bad.name + "\" is saved in the editor, but My Tracks couldn't take it" + (bad.error ? ": " + bad.error : "."), "bad");
        else if (report.saved.length) note(report.saved.length === 1 ? 'Saved "' + report.saved[0] + '" to My Tracks.' : "Saved " + report.saved.length + " tracks to My Tracks.", "good");
    }

    // Links: {[editor store id]: {[editor track name]: {a: account, id: My Tracks id, e: editor code digest, h: My Tracks hash, m: the mode
    // both sides last agreed on, f?: digest of a save My Tracks refused, d?: a second name for an entry already linked}}}. A track missing
    // on one side of a link was deleted there, so the other side's goes too.
    const LINKS_KEY = "nswsEditorLinks";
    const digest = async (s) => {
        const b = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
        return Array.from(b.slice(0, 12), (x) => x.toString(16).padStart(2, "0")).join("");
    };
    async function syncBoth() {
        const T = lib();
        const synced = (await T.whenSynced?.()) !== false;
        if (!ready) return;
        const token = T.user?.().token || "";
        const acct = token ? (await digest("nsws-editor:" + token)).slice(0, 12) : "";
        let reply = await request("list");
        if (!reply?.loaded || !Array.isArray(reply.tracks) || reply.store !== bridgeStore) return;
        let all = await T.list();
        const gone = new Set();
        if ((T.user?.().token || "") !== token) return;
        let allLinks = {};
        try {
            allLinks = JSON.parse(localStorage.getItem(LINKS_KEY)) || {};
        } catch {}
        const links = (allLinks[bridgeStore] ??= {});
        const save = () => {
            try {
                localStorage.setItem(LINKS_KEY, JSON.stringify(allLinks));
            } catch {}
        };
        const readEditor = async (r) => {
            const out = new Map();
            for (const e of r.tracks) if (e && typeof e.name === "string" && typeof e.code === "string") out.set(e.name, { ...e, sig: await digest(e.code) });
            return out;
        };
        let editor = await readEditor(reply);
        const byId = new Map(all.map((t) => [t.id, t]));
        const mine = Object.entries(links).filter(([, l]) => l.a === acct);
        // An empty My Tracks that the server couldn't confirm is more likely a wiped browser copy than everything deleted.
        // (A wiped editor comes back with a new store id, so it has no links.)
        const libraryGone = !all.length && mine.length > 2 && !synced;
        let editorWrites = false;
        const report = { saved: [], failed: [] };
        // The mode is set in two places (the bar here, the track's page in My Tracks): whichever moved since they last agreed wins.
        const agreeMode = async (name, l, t) => {
            const here = modeOf(name);
            const there = MODES.some((m) => m.id === t.mode) ? t.mode : "normal";
            let now = here;
            if (here !== there) {
                if (l.m === undefined ? there !== "normal" : here === l.m) {
                    setMode(name, there);
                    now = there;
                } else await T.update(t.id, { mode: here });
            }
            l.m = now;
        };

        for (const [name, l] of mine) {
            const e = editor.get(name);
            const t = l.id ? byId.get(l.id) : null;
            if (!l.id) {
                // A track My Tracks couldn't take: tried again once it is saved differently.
                if (!e || e.sig !== l.e) delete links[name];
                continue;
            }
            if (!e && !t) {
                delete links[name];
            } else if (!e) {
                delete links[name];
                if (!l.d && !Object.values(links).some((o) => o.a === acct && o.id === l.id && !o.d)) {
                    await T.remove(l.id);
                    gone.add(l.id);
                }
            } else if (!t) {
                if (libraryGone) continue;
                delete links[name];
                const r = await request("delete", { name });
                if (r?.ok) {
                    editorWrites = true;
                    editor.delete(name);
                } else links[name] = l;
            } else if (!l.d) {
                const editorNew = e.sig !== l.e;
                const libraryNew = t.hash !== l.h;
                if (editorNew && (!libraryNew || (e.saveTime || 0) >= (t.updated || 0))) {
                    try {
                        const next = await T.replaceCode(t.id, e.code);
                        l.e = e.sig;
                        l.h = next.hash;
                        delete l.f;
                        if (next.hash !== t.hash) report.saved.push(name);
                    } catch (err) {
                        console.warn("[Editor sync]", err);
                        if (l.f !== e.sig) report.failed.push({ name, error: err?.message });
                        l.f = e.sig;
                    }
                } else if (libraryNew) {
                    const r = await request("put", { name, code: t.code });
                    if (r?.ok) {
                        l.h = t.hash;
                        l.e = null;
                        editorWrites = true;
                    } else if (r?.gone) delete links[name];
                }
                if (links[name] === l) await agreeMode(name, l, t).catch((err) => console.warn("[Editor sync]", err));
            }
        }
        save();

        // Pairs up tracks that are on both sides already (copied before this sync existed, or opened with Edit).
        const linkedNames = new Set(Object.keys(links));
        const linkedIds = new Set(Object.values(links).filter((l) => l.a === acct && l.id).map((l) => l.id));
        all = all.filter((t) => !gone.has(t.id));
        const freeLib = all.filter((t) => !linkedIds.has(t.id));
        const nameFits = (en, tn) => en === tn || (en.startsWith(tn + " (") && /^ \(\d+\)$/.test(en.slice(tn.length)));
        // Better Editor entries saved before NSWS had the blocks have no track id; the editor reads it.
        const libIds = new Map(freeLib.filter((t) => t.trackId).map((t) => [t.id, t.trackId]));
        const noId = freeLib.filter((t) => !t.trackId && typeof t.code === "string" && t.code.length <= COPY_MAX_CODE);
        if (noId.length && [...editor.keys()].some((n) => !linkedNames.has(n))) {
            for (let i = 0; i < noId.length; i += 20) {
                const part = noId.slice(i, i + 20);
                const r = await request("ids", { codes: part.map((t) => t.code) }).catch(() => null);
                part.forEach((t, j) => r?.ids?.[j] && libIds.set(t.id, r.ids[j]));
            }
        }
        for (const exact of [true, false]) {
            for (const [name, e] of editor) {
                if (linkedNames.has(name)) continue;
                e.flat ??= await digest(e.code.replace(/\s+/g, ""));
                const t = freeLib.find((t) => !linkedIds.has(t.id) && (exact ? name === t.name : nameFits(name, t.name)) && ((e.id && libIds.get(t.id) === e.id) || (t.hash || "").startsWith(e.flat)));
                if (!t) continue;
                links[name] = { a: acct, id: t.id, e: e.sig, h: t.hash };
                linkedNames.add(name);
                linkedIds.add(t.id);
            }
        }

        // My Tracks entries the editor doesn't have yet.
        const toCopy = all.filter((t) => !linkedIds.has(t.id) && typeof t.code === "string" && t.code.length <= COPY_MAX_CODE);
        for (let i = 0; i < toCopy.length; i += 20) {
            const batch = toCopy.slice(i, i + 20);
            const r = await request("copy", { tracks: batch.map((t) => ({ code: t.code })) });
            if (!r?.ok) break;
            let full = false;
            batch.forEach((t, j) => {
                const res = r.results?.[j];
                if (!res || res.full) {
                    full = true;
                    return;
                }
                if (!res.ok || linkedNames.has(res.name)) return;
                links[res.name] = { a: acct, id: t.id, e: null, h: t.hash };
                linkedNames.add(res.name);
                linkedIds.add(t.id);
                if (!res.existed) {
                    editorWrites = true;
                    if (t.mode && t.mode !== "normal") setMode(res.name, t.mode);
                }
            });
            save();
            if (full) break;
        }

        // Editor tracks My Tracks doesn't have yet (saved in this editor).
        for (const [name, e] of editor) {
            if (linkedNames.has(name)) continue;
            if ((T.user?.().token || "") !== token) break;
            let t = null;
            try {
                t = await T.add(e.code, { mode: modeOf(name), source: "editor" });
                report.saved.push(name);
            } catch (err) {
                console.warn("[Editor sync]", err);
                report.failed.push({ name, error: err?.message });
            }
            links[name] = t ? { a: acct, id: t.id, e: e.sig, h: t.hash, m: modeOf(name), ...(linkedIds.has(t.id) ? { d: 1 } : {}) } : { a: acct, id: null, e: e.sig };
            linkedNames.add(name);
            if (t) linkedIds.add(t.id);
        }

        // What the editor wrote reads back as its own code, which the links compare against next time.
        if (editorWrites || Object.values(links).some((l) => l.a === acct && l.e == null && l.id)) {
            reply = await request("list");
            if (reply?.loaded && Array.isArray(reply.tracks)) {
                editor = await readEditor(reply);
                for (const [name, l] of Object.entries(links)) if (l.a === acct && l.e == null && editor.has(name)) l.e = editor.get(name).sig;
            }
        }
        save();
        if (editorWrites) await refreshList(false);
        return report;
    }

    // Editors before bridge version 5: My Tracks goes in, each version once.
    async function copyOnce() {
        {
            let done = {};
            try {
                done = JSON.parse(localStorage.getItem(COPIED_KEY)) || {};
            } catch {}
            const all = await lib().list();
            const kept = {};
            for (const t of all) if (done[t.id]) kept[t.id] = done[t.id];
            done = kept;
            // Editors before bridge version 4 skipped a track whose name they already had (and it was marked copied), so
            // My Tracks entries sharing a name go over once more; the editor now numbers them.
            let redo = false;
            try {
                redo = bridgeVersion >= 4 && !localStorage.getItem(DUPES_KEY);
            } catch {}
            if (redo) {
                const count = new Map();
                for (const t of all) count.set(t.name, (count.get(t.name) || 0) + 1);
                for (const t of all) if (count.get(t.name) > 1) delete done[t.id];
            }
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
            if (redo)
                try {
                    localStorage.setItem(DUPES_KEY, "1");
                } catch {}
            if (added) await refreshList(false);
        }
    }

    let editorOpen = false;
    // Opens a saved track (or a new one when name is null) straight in the block editor. Library mode: opts.key opens that
    // My Tracks entry, opts.code a track that isn't in My Tracks yet (Save adds it); opts.label names either in the bar.
    async function editTrack(name, opts = {}, attempt = 0) {
        let reply;
        try {
            reply = await request("edit", { name, key: opts.key, code: opts.code, force: !!opts.force, fresh: !!opts.fresh }, EDIT_TIMEOUT_MS);
        } catch (err) {
            loaded();
            note(err.message, "bad");
            return false;
        }
        if (!reply.ok && /loading/i.test(reply.error || "") && attempt < 40) {
            await new Promise((r) => setTimeout(r, 1000));
            return editTrack(name, opts, attempt + 1);
        }
        // Added to My Tracks a moment ago: the editor gets the list first.
        if (!reply.ok && reply.gone && opts.key && attempt < 2) {
            await pushLibrary().catch(() => {});
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
            if (opts.key) localStorage.setItem(LAST_ID_KEY, opts.key);
            else if (libMode) localStorage.removeItem(LAST_ID_KEY);
            else name ? localStorage.setItem(LAST_KEY, name) : localStorage.removeItem(LAST_KEY);
        } catch {}
        if (libMode && !opts.key) newMode = opts.code ? validMode(opts.mode) : "normal";
        refreshLive();
        const label = name ?? opts.label ?? null;
        if (!opts.quiet) note(label ? 'Editing "' + label + '".' : "New track. Press Save in the editor to give it a name.", "good");
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
        if (libMode) return openFromLibrary(job);
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

    // Library mode: a My Tracks entry opens as itself. A code from elsewhere (Race Control) opens its My Tracks entry when
    // there is one, else as a new track that the editor's Save adds.
    async function openFromLibrary(job) {
        const T = lib();
        const all = await T.list().catch(() => []);
        let t = job.key ? all.find((x) => x.id === job.key) : null;
        let info = null;
        if (!t) {
            info = await T.parseAsync(job.code).catch(() => null);
            if (info?.ok) t = all.find((x) => x.code === info.code) || (info.trackId ? all.find((x) => x.trackId === info.trackId && x.name === info.name) : null);
        }
        if (pendingImport !== job) return;
        pendingImport = null;
        const label = t?.name || info?.name || job.name || "Unnamed Track";
        const ok = await editTrack(null, t ? { key: t.id, label, quiet: true } : { code: job.code, mode: job.mode, label, quiet: true });
        if (ok) note('Editing "' + label + '".' + (t ? "" : " Save it to put it in My Tracks."), "good");
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
        let mode = modeFor(t);
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
                setModeFor(t, mode);
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
            top.append(el("span", null, s.name || "Untitled"), el("span", "st-" + s.status, s.status === "planned" && s.week ? "Planned for week " + s.week + (s.slot ? ", map " + s.slot : "") : STATUS[s.status] || s.status || ""));
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
        // The game stops drawing under the editor (RenderManager.update in main.bundle.js).
        window.__nswsEditorCovering = true;
        post({ type: "pause", paused: false });
        let settings = null;
        try {
            settings = JSON.parse(localStorage.getItem("polytrack_v5_prod_settings"));
        } catch {}
        post({ type: "settings", settings });
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
        window.__nswsEditorCovering = false;
        autosave();
        // Hidden on the same site, the editor would keep drawing its whole track behind the game (BE's nsws_bridge.js).
        post({ type: "pause", paused: true });
    }

    function open(track) {
        const wasLoaded = !!frame;
        show();
        note(wasLoaded ? "" : "The editor's Save keeps your track and puts it in My Tracks. Unsaved work is lost when you close or reload this page" + (autosaveOn() ? "; autosave is on." : "; Autosave can save for you."));
        const code = typeof track === "string" ? track : track?.code;
        if (typeof code !== "string" || !code) return;
        const obj = typeof track === "object" ? track : {};
        pendingImport = { code, mode: obj.mode || null, key: typeof obj.id === "string" && obj.id ? obj.id : null, name: obj.name || null };
        if (ready) runImport();
        else {
            note("Sending the track to the editor...");
            if (ui && !ui.fallback.classList.contains("hidden")) ui.fbCopy.style.display = "";
        }
    }

    function close() {
        hide();
    }

    function renderCup() {
        if (!ui) return;
        const c = cupBar;
        ui.cup.classList.toggle("hidden", !c);
        ui.host.classList.toggle("cupmode", !!c);
        ui.send.style.display = c ? "none" : "";
        ui.loaderTitle.textContent = c ? "Build Off" : "Better Editor";
        if (c && ui.seg.parentNode !== ui.cupTop) ui.cupTop.insertBefore(ui.seg, ui.cupGap);
        else if (!c && ui.seg.parentNode !== ui.bar) ui.bar.insertBefore(ui.seg, ui.auto);
        clearInterval(cupTimer);
        cupTimer = null;
        if (!c) return;
        ui.cupTitle.textContent = c.title;
        ui.cupTitle.title = c.title;
        ui.cupPhase.textContent = c.phase || "Build Off";
        renderCupStatus();
        ui.cupSend.lastChild.textContent = c.sent ? "Send again" : "Send to the cup";
        ui.cupSend.disabled = !!c.closed;
        ui.cupSend.style.display = c.canSend === false || c.watching ? "none" : "";
        const builders = c.builders || [];
        ui.cupWho.textContent = "";
        if (builders.length) {
            ui.cupWho.append("Sent " + builders.filter((b) => b.done).length + "/" + builders.length + ":");
            for (const b of builders) {
                const chip = el("span", (b.done ? "done" : "") + (b.me ? " me" : "") + (b.onWatch ? " can" : "") + (b.watched ? " watched" : ""), b.name + (b.watchers ? " (" + b.watchers + " watching)" : ""));
                if (b.onWatch) {
                    chip.title = b.watched ? "Stop watching " + b.name : "Watch " + b.name + " build";
                    chip.addEventListener("click", (e) => {
                        e.stopPropagation();
                        window.__nswsUIClick?.();
                        b.onWatch();
                    });
                }
                ui.cupWho.appendChild(chip);
            }
            ui.cupWho.title = builders.some((b) => b.onWatch) ? "Green: track sent. Click a name to watch them build." : "Green: track sent. The rest are still building.";
        }
        const w = c.watching;
        ui.cupWatch.classList.toggle("hidden", !w);
        if (w) {
            ui.cupWatchName.textContent = w.name;
            ui.cupPrev.style.display = w.onPrev ? "" : "none";
            ui.cupNext.style.display = w.onNext ? "" : "none";
            ui.cupFollow.style.display = w.follow ? "none" : "";
        }
        ui.cupMore.style.display = c.more ? "" : "none";
        ui.cupEnd.style.display = c.endNow ? "" : "none";
        ui.cupLeave.style.display = c.onLeave ? "" : "none";
        ui.cupLeave.dataset.label = c.leaveLabel || "Leave cup";
        if (ui.cupLeave.lastChild.textContent !== "Press again") ui.cupLeave.lastChild.textContent = ui.cupLeave.dataset.label;
        const tick = () => {
            const left = Math.max(0, c.left());
            const s = Math.ceil(left / 1000);
            ui.cupClock.textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
            ui.cupClock.classList.toggle("warn", left < 60000);
        };
        tick();
        cupTimer = setInterval(tick, 250);
    }

    function renderCupStatus() {
        if (!ui || !cupBar) return;
        const eyes = !cupAlert && !cupBar.watching && cupBar.watchers > 0 ? " " + cupBar.watchers + (cupBar.watchers === 1 ? " person is" : " people are") + " watching you build." : "";
        ui.cupStatus.textContent = (cupAlert || cupBar.status) + eyes;
        ui.cupStatus.className = "st" + (cupAlert ? " bad" : cupBar.sent ? " good" : "");
    }

    // Cuppa's Build Off finish guard in the editor (BE nsws_cup.js, bridge 7): status, lock, unlock, fill. null when the
    // editor can't answer, so the cup goes on as before.
    function guard(op, extra, ms) {
        if (!ready || bridgeVersion < 7) return Promise.resolve(null);
        return request("cup", Object.assign({}, extra, { op }), ms || 4000).catch(() => null);
    }

    // Cuppa Build Off: watching another builder (BE nsws_watch.js, bridge 8): show, stop, cam, view, status. null when the
    // editor can't answer.
    function watch(op, extra, ms) {
        if (!ready || bridgeVersion < 8) return Promise.resolve(null);
        return request("watch", Object.assign({}, extra, { op }), ms || 4000).catch(() => null);
    }

    // The editor's open track, saved or not, with its mode.
    async function currentTrack() {
        const t = await refreshLive();
        return t ? { name: t.name, code: t.code, mode: modeFor(t) } : null;
    }

    // A new, empty track in the block editor (once the editor has loaded).
    function fresh() {
        if (!ready) {
            wantFresh = true;
            return;
        }
        selected = NEW;
        renderPicker();
        renderMode();
        editTrack(null, { fresh: true, quiet: true });
    }

    window.__nswsEditor = {
        open,
        close,
        current: currentTrack,
        fresh,
        cup(bar) {
            const was = cupBar;
            cupBar = bar || null;
            // Entering the cup clears the editor's own first-open note; a send that arrived clears "Sending...".
            if (cupBar && (!was || (cupBar.sent && !was.sent))) note("");
            if (!cupBar && was) {
                cupAlert = "";
                if (ready && bridgeVersion >= 7) post({ type: "cup", op: "unlock" });
            }
            renderCup();
        },
        cupAlert(text) {
            if ((text || "") === cupAlert) return;
            cupAlert = text || "";
            renderCupStatus();
        },
        guard,
        watch,
        canWatch: () => (ready ? bridgeVersion >= 8 : null),
        note,
        isOpen: () => !!host && !host.classList.contains("hidden"),
    };
})();
