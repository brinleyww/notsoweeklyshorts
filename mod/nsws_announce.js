// The owner's announcements: a chat-style "Name: message" at the top middle of everyone's screen
// that fades away. They arrive with the traffic beat (nsws_traffic.js) or, for players with the
// chat open, over the chat socket. The font follows each player's chat font setting.
(function () {
    if (window.__nswsAnnounce) return;

    const SEEN_KEY = "nsws_ann_seen";
    const SEEN_KEPT = 30;
    const FADE_IN_MS = 450;
    const FADE_OUT_MS = 2800;
    const DEFAULT_COLOR = "#b3c1ff";

    const CSS = `
#nsws-ann{position:fixed;left:0;right:0;top:calc(var(--safe-area-top-unscaled,0px) + 12px);z-index:10010;display:flex;justify-content:center;pointer-events:none;}
#nsws-ann>.m{position:relative;max-width:min(820px,calc(100vw - 32px));padding:10px 22px 12px 32px;background:rgba(33,43,88,.93);color:var(--text-color,#fff);font-family:'NSWS Flags',var(--nsws-chat-text,ForcedSquare,Arial),var(--nsws-chat-emoji,sans-serif),sans-serif;font-style:var(--nsws-chat-font-style,italic);font-size:clamp(18px,2.4vw,26px);line-height:1.35;overflow-wrap:anywhere;box-shadow:0 8px 28px rgba(0,0,0,.45);}
#nsws-ann>.m::before{content:"";position:absolute;left:15px;top:11px;bottom:11px;width:4px;border-radius:2px;background:var(--c);opacity:.8;}
#nsws-ann .nick{color:var(--c);font-weight:var(--nsws-chat-name-weight,bold);}
#nsws-ann .note{margin-left:.5em;font-size:.6em;opacity:.5;}
`;

    function readSeen() {
        try {
            const list = JSON.parse(localStorage.getItem(SEEN_KEY));
            return Array.isArray(list) ? list : [];
        } catch {
            return [];
        }
    }

    function markSeen(id) {
        const list = readSeen().filter((x) => x !== id);
        list.push(id);
        try {
            localStorage.setItem(SEEN_KEY, JSON.stringify(list.slice(-SEEN_KEPT)));
        } catch {}
    }

    function valid(a) {
        return !!a && Number.isSafeInteger(a.id) && typeof a.text === "string" && a.text.length > 0;
    }

    let audio = null;
    function chime() {
        try {
            audio = audio || new AudioContext();
            if (audio.state === "suspended") audio.resume();
            const t = audio.currentTime;
            const gain = audio.createGain();
            gain.connect(audio.destination);
            gain.gain.setValueAtTime(0.0001, t);
            gain.gain.exponentialRampToValueAtTime(0.07, t + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
            for (const [freq, delay] of [[660, 0], [880, 0.1], [1320, 0.2]]) {
                const osc = audio.createOscillator();
                osc.type = "triangle";
                osc.frequency.value = freq;
                osc.connect(gain);
                osc.start(t + delay);
                osc.stop(t + 0.72);
            }
        } catch {}
    }

    // shown: { a, el, preview, at, anim }. waiting: one that came in while the tab was hidden.
    let shown = null;
    let waiting = null;

    function addStyle() {
        if (document.getElementById("nsws-ann-style")) return;
        const style = document.createElement("style");
        style.id = "nsws-ann-style";
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    function hide(now) {
        if (!shown) return;
        const { el, anim } = shown;
        shown = null;
        const opacity = getComputedStyle(el).opacity;
        anim?.cancel();
        if (now || !el.animate) {
            el.remove();
            return;
        }
        el.animate([{ opacity }, { opacity: 0 }], { duration: 600, fill: "forwards" }).onfinish = () => el.remove();
    }

    function show(a, preview) {
        hide(true);
        addStyle();
        const el = document.createElement("div");
        el.id = "nsws-ann";
        el.setAttribute("role", "status");
        const m = document.createElement("div");
        m.className = "m";
        m.style.setProperty("--c", /^#[0-9a-f]{6}$/i.test(a.color) ? a.color : DEFAULT_COLOR);
        const nick = document.createElement("span");
        nick.className = "nick";
        nick.textContent = a.name || "Owner";
        m.append(nick, ": " + a.text);
        if (preview) {
            const note = document.createElement("span");
            note.className = "note";
            note.textContent = "preview, only you see this";
            m.appendChild(note);
        }
        el.appendChild(m);
        document.body.appendChild(el);
        // Players can move the race timer to the top middle; stay below it.
        const timer = document.querySelector(".timer-ui.up:not(.hidden)");
        const bottom = timer ? timer.getBoundingClientRect().bottom : 0;
        if (bottom > 0) el.style.top = bottom + 10 + "px";

        const hold = Math.max(3, Number(a.show) || 10) * 1000;
        const total = FADE_IN_MS + hold + FADE_OUT_MS;
        const entry = { a, el, preview: !!preview, at: performance.now(), anim: null };
        if (el.animate) {
            entry.anim = el.animate([
                { opacity: 0, transform: "translateY(-16px)", easing: "ease-out" },
                { opacity: 1, transform: "none", offset: FADE_IN_MS / total, easing: "linear" },
                { opacity: 1, transform: "none", offset: (FADE_IN_MS + hold) / total, easing: "ease-in-out" },
                { opacity: 0, transform: "none" },
            ], { duration: total, fill: "forwards" });
            entry.anim.onfinish = () => {
                if (shown === entry) {
                    shown = null;
                    el.remove();
                }
            };
        } else {
            setTimeout(() => shown === entry && hide(false), FADE_IN_MS + hold);
        }
        shown = entry;
        chime();
        if (!preview) {
            markSeen(a.id);
            window.__nswsTraffic?.seen?.(a.id);
        }
    }

    // The beat's reply carries the live announcement or null; a null (or a newer one) ends the
    // one on screen, which is how the owner's Stop reaches players without the chat. `asked` is
    // when the beat was sent: a reply to a beat from before the banner appeared is out of date.
    function receive(a, asked) {
        if (shown && asked < shown.at) return;
        if (!valid(a)) {
            waiting = null;
            if (shown && !shown.preview) hide(false);
            return;
        }
        if (shown && !shown.preview && shown.a.id !== a.id) hide(false);
        if (shown?.a.id === a.id && !shown.preview) return;
        if (readSeen().includes(a.id)) return;
        if (document.visibilityState === "hidden") {
            waiting = { a, until: performance.now() + Math.max(0, a.until - a.at) };
            return;
        }
        show(a, false);
    }

    function stop(id) {
        if (waiting?.a.id === id) waiting = null;
        if (shown?.a.id === id && !shown.preview) hide(false);
    }

    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible" || !waiting) return;
        const { a, until } = waiting;
        waiting = null;
        if (performance.now() < until && !readSeen().includes(a.id)) show(a, false);
    });

    window.__nswsAnnounce = {
        receive,
        stop,
        preview: (a) => show({ id: 0, ...a }, true),
    };
})();
