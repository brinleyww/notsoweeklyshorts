// The universal chat window. Off until the player turns it on in Settings ("Chat"). The
// Worker censors every message and nickname before anyone sees them, so nothing here is
// trusted to do that.
(function () {
    const API = window.__nswsApiBase;
    if (!API || !window.WebSocket) return;

    const ENABLED_KEY = "_nswsChatEnabled";
    const LAYOUT_KEY = "_nswsChatLayout";
    const VISITOR_KEY = "nsws_visitor";
    const WS_URL = API.replace(/^http/, "ws") + "nsws/chat";
    const MAX_TEXT = 200;
    const MAX_LINES = 200;
    const PING_MS = 30000;
    const SLOW_MS = 1000;
    const MIN_W = 260;
    const MIN_H = 180;
    const MARGIN = 8;

    const CSS = `
#nsws-chat{position:fixed;z-index:90;display:flex;flex-direction:column;min-width:${MIN_W}px;min-height:${MIN_H}px;background:var(--surface-color,#28346a);color:var(--text-color,#fff);font-family:ForcedSquare,Arial,sans-serif;font-size:17px;box-shadow:0 8px 28px rgba(0,0,0,.45);pointer-events:auto;touch-action:none;}
#nsws-chat.min{min-height:0;height:auto!important;width:230px!important;min-width:0;}
#nsws-chat.min>.log,#nsws-chat.min>.status,#nsws-chat.min>form,#nsws-chat.min>.grip{display:none;}
#nsws-chat.full{left:0!important;top:0!important;width:100%!important;height:100%!important;z-index:10002;font-size:20px;}
#nsws-chat.full>.grip{display:none;}
#nsws-chat>.bar{display:flex;align-items:center;gap:6px;height:36px;flex-shrink:0;padding:0 4px 0 10px;background:var(--button-color,#112052);cursor:move;user-select:none;}
#nsws-chat.full>.bar{cursor:default;}
#nsws-chat>.bar>.title{flex-shrink:0;}
#nsws-chat>.bar>.online{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:14px;opacity:.7;}
#nsws-chat>.bar>.unread{display:none;min-width:20px;padding:0 6px;border-radius:10px;background:#e0464b;font-size:14px;line-height:20px;text-align:center;}
#nsws-chat.min>.bar>.unread.on{display:block;}
#nsws-chat>.bar>button{width:30px;height:28px;padding:0;border:0;background:transparent;color:inherit;font:inherit;font-size:18px;line-height:28px;cursor:pointer;}
#nsws-chat>.bar>button:hover{background:var(--button-hover-color,#334b77);}
#nsws-chat>.log{flex:1;min-height:0;overflow-y:auto;padding:6px 10px;background:var(--surface-secondary-color,#212b58);user-select:text;touch-action:pan-y;overflow-wrap:anywhere;}
#nsws-chat>.log>.m{padding:2px 0;line-height:1.3;}
#nsws-chat>.log>.m>.time{margin-right:6px;font-size:.75em;opacity:.45;}
#nsws-chat>.log>.m>.nick{font-weight:bold;}
#nsws-chat>.log>.m>.badge{margin-left:5px;padding:0 5px;background:#e6a23c;color:#1a1a1a;font-size:.7em;vertical-align:middle;}
#nsws-chat>.log>.m.mine>.nick{text-decoration:underline;}
#nsws-chat>.log>.sys{padding:2px 0;font-style:italic;opacity:.6;}
#nsws-chat>.log>.m.mod{cursor:pointer;}
#nsws-chat>.log>.tools{display:flex;flex-wrap:wrap;gap:4px;padding:2px 0 6px;}
#nsws-chat>.log>.tools>button,#nsws-chat>form>button{border:0;background:var(--button-color,#112052);color:inherit;font:inherit;font-size:14px;padding:3px 8px;cursor:pointer;}
#nsws-chat>.log>.tools>button:hover,#nsws-chat>form>button:hover{background:var(--button-hover-color,#334b77);}
#nsws-chat>.status{flex-shrink:0;padding:3px 10px;font-size:14px;background:var(--surface-tertiary-color,#192042);opacity:.8;}
#nsws-chat>.status:empty{display:none;}
#nsws-chat>form{display:flex;flex-shrink:0;gap:6px;padding:6px;}
#nsws-chat>form>input{flex:1;min-width:0;padding:6px 8px;border:0;outline:0;background:var(--surface-tertiary-color,#192042);color:inherit;font:inherit;user-select:text;}
#nsws-chat>form>input:focus{box-shadow:inset 0 0 0 2px var(--button-hover-color,#334b77);}
#nsws-chat>form>button{font-size:16px;padding:0 14px;}
#nsws-chat>.grip{position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;background:linear-gradient(135deg,transparent 50%,rgba(255,255,255,.35) 50%);}
`;

    function storageGet(key) {
        try {
            return localStorage.getItem(key);
        } catch {
            return null;
        }
    }

    function storageSet(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch {}
    }

    function readNickname() {
        try {
            const slot = parseInt(localStorage.getItem("polytrack_v5_prod_user_slot") ?? "0", 10);
            const nick = JSON.parse(localStorage.getItem("polytrack_v5_prod_user_" + (slot >= 0 ? slot : 0)))?.nickname;
            return typeof nick === "string" && nick.trim() ? nick.trim() : "Guest";
        } catch {
            return "Guest";
        }
    }

    function visitorId() {
        let id = storageGet(VISITOR_KEY);
        if (!/^[0-9a-f]{32}$/.test(id || "")) {
            id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
            storageSet(VISITOR_KEY, id);
        }
        return id;
    }

    function nickColor(uid) {
        return "hsl(" + (parseInt(uid.slice(0, 4), 16) % 360) + ",75%,72%)";
    }

    function clock(at) {
        const d = new Date(at);
        return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    }

    let root = null;
    let log = null;
    let input = null;
    let statusLine = null;
    let onlineLabel = null;
    let unreadBadge = null;
    let socket = null;
    let pingTimer = null;
    let retryTimer = null;
    let retryDelay = 2000;
    let me = null;
    let unread = 0;
    // Sending waits until readyAt: one second after each message (slow mode), or the end of a timeout.
    let readyAt = 0;
    let timedOut = false;
    let lastText = "";
    let sendTimer = null;
    let waitTimer = null;
    let layout = loadLayout();
    let shown = null;

    function loadLayout() {
        let saved = null;
        try {
            saved = JSON.parse(storageGet(LAYOUT_KEY));
        } catch {}
        const w = Math.max(MIN_W, Number(saved?.w) || 360);
        const h = Math.max(MIN_H, Number(saved?.h) || 320);
        return {
            w,
            h,
            x: Number.isFinite(saved?.x) ? saved.x : 12,
            y: Number.isFinite(saved?.y) ? saved.y : window.innerHeight - h - 12,
            min: !!saved?.min,
            full: !!saved?.full,
        };
    }

    function saveLayout() {
        storageSet(LAYOUT_KEY, JSON.stringify(layout));
    }

    // Keeps the title bar on screen, so the window can always be dragged back. Only a drag
    // commits the clamped values: a viewport that shrinks for a moment (a phone keyboard,
    // a resized window) mustn't shrink the saved layout.
    function applyLayout(commit) {
        if (!root) return;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const w = Math.min(Math.max(MIN_W, layout.w), vw - 2 * MARGIN);
        const h = Math.min(Math.max(MIN_H, layout.h), vh - 2 * MARGIN);
        const width = layout.min ? root.offsetWidth || 230 : w;
        shown = {
            w,
            h,
            x: Math.min(Math.max(0, layout.x), Math.max(0, vw - width)),
            y: Math.min(Math.max(0, layout.y), Math.max(0, vh - (layout.min ? 36 : h))),
        };
        if (commit === true) Object.assign(layout, shown);
        root.style.left = shown.x + "px";
        root.style.top = shown.y + "px";
        root.style.width = shown.w + "px";
        root.style.height = shown.h + "px";
        root.classList.toggle("min", layout.min);
        root.classList.toggle("full", layout.full && !layout.min);
        minButton.textContent = layout.min ? "\u25a1" : "\u2013";
        minButton.title = layout.min ? "Restore" : "Minimize";
        fullButton.textContent = layout.full ? "\u2750" : "\u26f6";
        fullButton.title = layout.full ? "Exit fullscreen" : "Fullscreen";
    }

    let minButton = null;
    let fullButton = null;

    function setMinimized(min) {
        layout.min = min;
        if (!min) {
            unread = 0;
            updateUnread();
        }
        applyLayout();
        saveLayout();
        if (!min) scrollToEnd(true);
    }

    function setFullscreen(full) {
        layout.full = full;
        if (full) layout.min = false;
        applyLayout();
        saveLayout();
        scrollToEnd(true);
    }

    function updateUnread() {
        if (!unreadBadge) return;
        unreadBadge.textContent = unread > 99 ? "99+" : String(unread);
        unreadBadge.classList.toggle("on", unread > 0);
    }

    function setStatus(text) {
        if (statusLine) statusLine.textContent = text;
    }

    function nearBottom() {
        return log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    }

    function scrollToEnd(force) {
        if (log && (force || nearBottom())) log.scrollTop = log.scrollHeight;
    }

    function trimLog() {
        while (log.childElementCount > MAX_LINES) log.firstElementChild.remove();
    }

    function addSystem(text) {
        if (!log) return;
        const stick = nearBottom();
        const line = document.createElement("div");
        line.className = "sys";
        line.textContent = text;
        log.appendChild(line);
        trimLog();
        scrollToEnd(stick);
    }

    function closeTools() {
        log?.querySelector(".tools")?.remove();
    }

    function ownerTools(line, m) {
        const open = line.nextElementSibling?.classList.contains("tools");
        closeTools();
        if (open) return;
        const tools = document.createElement("div");
        tools.className = "tools";
        const add = (label, data) => {
            const b = document.createElement("button");
            b.textContent = label;
            b.addEventListener("click", () => {
                send(data);
                closeTools();
            });
            tools.appendChild(b);
        };
        add("Delete", { t: "del", id: m.id });
        add("Mute 10m", { t: "mute", uid: m.uid, minutes: 10 });
        add("Mute 1h", { t: "mute", uid: m.uid, minutes: 60 });
        add("Mute 1d", { t: "mute", uid: m.uid, minutes: 1440 });
        add("Delete all theirs", { t: "clear", uid: m.uid });
        line.after(tools);
    }

    function addMessage(m) {
        const stick = nearBottom();
        const line = document.createElement("div");
        line.className = "m";
        line.dataset.id = m.id;
        line.dataset.uid = m.uid;
        if (me && m.uid === me.uid) line.classList.add("mine");
        const time = document.createElement("span");
        time.className = "time";
        time.textContent = clock(m.at);
        const nick = document.createElement("span");
        nick.className = "nick";
        nick.style.color = nickColor(m.uid);
        nick.textContent = m.nick;
        line.append(time, nick);
        if (m.owner) {
            const badge = document.createElement("span");
            badge.className = "badge";
            badge.textContent = "OWNER";
            line.appendChild(badge);
        }
        line.append(": ", m.text);
        if (me?.owner) {
            line.classList.add("mod");
            line.addEventListener("click", () => ownerTools(line, m));
        }
        log.appendChild(line);
        trimLog();
        scrollToEnd(stick);
    }

    function send(data) {
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
    }

    function onServer(event) {
        let data;
        try {
            data = JSON.parse(event.data);
        } catch {
            return;
        }
        if (data.t === "init") {
            me = data.you;
            log.textContent = "";
            for (const m of data.messages) addMessage(m);
            addSystem("Connected. Be nice - slurs are filtered.");
            onlineLabel.textContent = data.online + " online";
            scrollToEnd(true);
        } else if (data.t === "msg") {
            addMessage(data.m);
            if (layout.min && data.m.uid !== me?.uid) {
                unread++;
                updateUnread();
            }
        } else if (data.t === "online") {
            onlineLabel.textContent = data.n + " online";
        } else if (data.t === "del") {
            log.querySelector('.m[data-id="' + Number(data.id) + '"]')?.remove();
        } else if (data.t === "clear") {
            for (const line of log.querySelectorAll(".m")) if (line.dataset.uid === data.uid) line.remove();
        } else if (data.t === "err") {
            addSystem(data.text);
        } else if (data.t === "slow" || data.t === "timeout") {
            // The server refused the last message, so it goes back in the box.
            if (!input.value) input.value = lastText;
            readyAt = Math.max(readyAt, Date.now() + Number(data.ms || SLOW_MS));
            if (data.t === "timeout") {
                timedOut = true;
                addSystem(data.text);
            } else {
                sendTimer = setTimeout(trySend, readyAt - Date.now());
            }
            showWait();
        }
    }

    function waitLabel(ms) {
        const seconds = Math.ceil(ms / 1000);
        return seconds < 60 ? seconds + "s" : Math.floor(seconds / 60) + "m " + (seconds % 60) + "s";
    }

    function showWait() {
        clearInterval(waitTimer);
        const tick = () => {
            const left = readyAt - Date.now();
            if (left <= 0 || !root) {
                clearInterval(waitTimer);
                timedOut = false;
                if (socket?.readyState === WebSocket.OPEN) setStatus("");
                return;
            }
            setStatus(timedOut ? "Timed out for spamming: " + waitLabel(left) : "Slow mode: one message a second");
        };
        tick();
        waitTimer = setInterval(tick, 250);
    }

    async function connect() {
        clearTimeout(retryTimer);
        if (!root || socket) return;
        setStatus("Connecting...");
        let ws;
        try {
            ws = new WebSocket(WS_URL);
        } catch {
            return retry();
        }
        socket = ws;
        ws.addEventListener("open", async () => {
            retryDelay = 2000;
            setStatus("");
            const hello = { t: "hello", v: visitorId() };
            const key = await window.__nswsOwner?.token?.().catch(() => null);
            if (key) hello.key = key;
            if (socket === ws) ws.send(JSON.stringify(hello));
            pingTimer = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) ws.send("ping");
            }, PING_MS);
        });
        ws.addEventListener("message", (e) => {
            if (socket === ws && e.data !== "pong") onServer(e);
        });
        ws.addEventListener("close", () => {
            if (socket !== ws) return;
            socket = null;
            clearInterval(pingTimer);
            onlineLabel.textContent = "";
            retry();
        });
    }

    function retry() {
        if (!root) return;
        setStatus("Chat is offline. Reconnecting...");
        retryTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30000);
    }

    function disconnect() {
        clearTimeout(retryTimer);
        clearTimeout(sendTimer);
        clearInterval(waitTimer);
        clearInterval(pingTimer);
        const ws = socket;
        socket = null;
        me = null;
        try {
            ws?.close();
        } catch {}
    }

    function trySend() {
        clearTimeout(sendTimer);
        if (!input) return;
        const text = input.value.replace(/\s+/g, " ").trim();
        if (!text) return;
        if (socket?.readyState !== WebSocket.OPEN || !me) {
            addSystem("Not connected yet.");
            return;
        }
        const wait = me.owner ? 0 : readyAt - Date.now();
        if (wait > 0) {
            // Slow mode sends it the moment it may; after a timeout the player presses Enter again.
            if (!timedOut) sendTimer = setTimeout(trySend, wait);
            showWait();
            return;
        }
        lastText = text.slice(0, MAX_TEXT);
        send({ t: "msg", text: lastText, nick: readNickname() });
        input.value = "";
        readyAt = Date.now() + SLOW_MS;
        clearInterval(waitTimer);
        setStatus("");
    }

    function submit(e) {
        e.preventDefault();
        trySend();
    }

    // Pointer drags for moving (the title bar) and resizing (the corner grip).
    function drag(handle, onMove, onEnd) {
        handle.addEventListener("pointerdown", (e) => {
            if (e.button !== 0 || e.target.closest("button")) return;
            e.preventDefault();
            const start = { x: e.clientX, y: e.clientY, layout: { ...shown } };
            let moved = false;
            handle.setPointerCapture(e.pointerId);
            const move = (ev) => {
                const dx = ev.clientX - start.x;
                const dy = ev.clientY - start.y;
                if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
                moved = true;
                onMove(start.layout, dx, dy);
                applyLayout(true);
            };
            const up = () => {
                handle.removeEventListener("pointermove", move);
                handle.removeEventListener("pointerup", up);
                handle.removeEventListener("pointercancel", up);
                if (moved) saveLayout();
                onEnd?.(moved);
            };
            handle.addEventListener("pointermove", move);
            handle.addEventListener("pointerup", up);
            handle.addEventListener("pointercancel", up);
        });
    }

    function stop(e) {
        e.stopPropagation();
    }

    function build() {
        if (!document.getElementById("nsws-chat-style")) {
            const style = document.createElement("style");
            style.id = "nsws-chat-style";
            style.textContent = CSS;
            document.head.appendChild(style);
        }
        root = document.createElement("div");
        root.id = "nsws-chat";

        const bar = document.createElement("div");
        bar.className = "bar";
        const title = document.createElement("span");
        title.className = "title";
        title.textContent = "Chat";
        onlineLabel = document.createElement("span");
        onlineLabel.className = "online";
        unreadBadge = document.createElement("span");
        unreadBadge.className = "unread";
        minButton = document.createElement("button");
        minButton.addEventListener("click", () => setMinimized(!layout.min));
        fullButton = document.createElement("button");
        fullButton.addEventListener("click", () => setFullscreen(!layout.full));
        bar.append(title, onlineLabel, unreadBadge, fullButton, minButton);

        log = document.createElement("div");
        log.className = "log";
        statusLine = document.createElement("div");
        statusLine.className = "status";

        const form = document.createElement("form");
        input = document.createElement("input");
        input.type = "text";
        input.maxLength = MAX_TEXT;
        input.placeholder = "Say something...";
        input.autocomplete = "off";
        input.spellcheck = false;
        const sendButton = document.createElement("button");
        sendButton.type = "submit";
        sendButton.textContent = "Send";
        form.append(input, sendButton);
        form.addEventListener("submit", submit);

        const grip = document.createElement("div");
        grip.className = "grip";
        root.append(bar, log, statusLine, form, grip);

        // The game listens for keys and clicks on window; none of the chat's should reach it.
        for (const type of ["keydown", "keyup", "keypress"]) input.addEventListener(type, stop);
        input.addEventListener("keydown", (e) => {
            if (e.key === "Escape") input.blur();
        });
        for (const type of ["pointerdown", "mousedown", "mouseup", "click", "touchstart", "touchend", "wheel", "contextmenu"]) {
            root.addEventListener(type, stop);
        }

        drag(bar, (from, dx, dy) => {
            if (layout.full) return;
            layout.x = from.x + dx;
            layout.y = from.y + dy;
        }, (moved) => {
            if (!moved && layout.min) setMinimized(false);
        });
        drag(grip, (from, dx, dy) => {
            layout.w = from.w + dx;
            layout.h = from.h + dy;
        });

        document.body.appendChild(root);
        applyLayout();
        scrollToEnd(true);
    }

    function onKey(e) {
        if (e.code !== "Escape" || !root || !layout.full || document.activeElement === input) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        setFullscreen(false);
    }

    function enable() {
        if (root) return;
        build();
        window.addEventListener("keydown", onKey, true);
        window.addEventListener("resize", applyLayout);
        connect();
    }

    function disable() {
        disconnect();
        window.removeEventListener("keydown", onKey, true);
        window.removeEventListener("resize", applyLayout);
        root?.remove();
        root = log = input = statusLine = onlineLabel = unreadBadge = null;
    }

    function isEnabled() {
        return storageGet(ENABLED_KEY) === "true";
    }

    window.__nswsChat = {
        isEnabled,
        setEnabled(on) {
            storageSet(ENABLED_KEY, on ? "true" : "false");
            on ? enable() : disable();
        },
    };

    if (isEnabled()) {
        if (document.body) enable();
        else document.addEventListener("DOMContentLoaded", enable);
    }
})();
