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
#nsws-ann a{pointer-events:auto;color:#8cc4ff;text-decoration:underline;text-underline-offset:.15em;cursor:pointer;}
#nsws-ann a:hover{color:#c4e0ff;}
#nsws-ann .note{margin-left:.5em;font-size:.6em;opacity:.5;}
#nsws-ann .m.poll{padding-right:46px;}
#nsws-ann .x{pointer-events:auto;position:absolute;right:6px;top:4px;padding:2px 10px;background:none;border:none;color:inherit;font:inherit;font-style:normal;font-size:24px;line-height:1.2;opacity:.5;cursor:pointer;}
#nsws-ann .x:hover{opacity:1;}
#nsws-ann .opts{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;}
#nsws-ann .opts .button{margin:0;padding:6px 18px;font-family:inherit;font-style:inherit;font-size:.8em;}
#nsws-ann .res{display:flex;flex-direction:column;gap:6px;margin-top:10px;font-size:.75em;}
#nsws-ann .res .r{position:relative;display:flex;gap:12px;justify-content:space-between;padding:4px 12px;background:rgba(255,255,255,.06);}
#nsws-ann .res .r>i{position:absolute;left:0;top:0;bottom:0;background:var(--c);opacity:.22;}
#nsws-ann .res .r.mine>i{opacity:.45;}
#nsws-ann .res .r>span{position:relative;}
#nsws-ann .res .r>span:last-child{font-variant-numeric:tabular-nums;}
#nsws-ann .res .total,#nsws-ann .msg{font-size:.65em;opacity:.6;margin-top:6px;}
`;
    const RESULTS_MS = 6000;

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

    function pollOf(a) {
        return Array.isArray(a.poll) && a.poll.length >= 2 && a.poll.every((o) => typeof o === "string") ? a.poll : null;
    }

    // Keep the game from treating a click on the banner as input.
    function ownClicks(node) {
        for (const type of ["pointerdown", "mousedown", "touchstart", "click"]) node.addEventListener(type, (e) => e.stopPropagation());
    }

    const LINK = /\b(?:https?:\/\/|www\.)[^\s<>"]+/gi;

    function href(raw) {
        try {
            const url = new URL(/^www\./i.test(raw) ? "https://" + raw : raw);
            return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
        } catch {
            return null;
        }
    }

    function appendText(m, text) {
        let last = 0;
        for (const match of text.matchAll(LINK)) {
            let raw = match[0].replace(/[.,!?;:'"\]]+$/, "");
            if (raw.endsWith(")") && !raw.includes("(")) raw = raw.replace(/\)+$/, "");
            const url = href(raw);
            if (!url) continue;
            m.append(text.slice(last, match.index));
            const a = document.createElement("a");
            a.href = url;
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            a.textContent = raw;
            ownClicks(a);
            // Hold the banner while the pointer is on a link so it can't fade out from under the click.
            a.addEventListener("pointerenter", () => shown?.el.contains(a) && shown.anim?.playState === "running" && shown.anim.pause());
            a.addEventListener("pointerleave", () => shown?.el.contains(a) && shown.anim?.playState === "paused" && shown.anim.play());
            m.append(a);
            last = match.index + raw.length;
        }
        m.append(text.slice(last));
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
        m.append(nick, ": ");
        appendText(m, a.text);
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
        const poll = pollOf(a);
        if (poll) {
            // A poll stays until the player answers or closes it.
            addPoll(entry, m, poll);
            entry.anim = el.animate?.([
                { opacity: 0, transform: "translateY(-16px)" },
                { opacity: 1, transform: "none" },
            ], { duration: FADE_IN_MS, easing: "ease-out", fill: "forwards" }) ?? null;
        } else if (el.animate) {
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

    function addPoll(entry, m, poll) {
        m.classList.add("poll");
        const close = document.createElement("button");
        close.className = "x";
        close.title = "Close";
        close.textContent = "\u00d7";
        ownClicks(close);
        close.addEventListener("click", () => shown === entry && hide(false));
        const opts = document.createElement("div");
        opts.className = "opts";
        const msg = document.createElement("div");
        msg.className = "msg";
        const buttons = poll.map((text, choice) => {
            const b = document.createElement("button");
            b.className = "button";
            b.textContent = text;
            ownClicks(b);
            b.addEventListener("click", () => vote(entry, m, poll, choice, buttons, msg));
            return b;
        });
        opts.append(...buttons);
        m.append(close, opts);
    }

    async function vote(entry, m, poll, choice, buttons, msg) {
        for (const b of buttons) b.disabled = true;
        msg.remove();
        let votes;
        if (entry.preview) {
            votes = poll.map((_, i) => (i === choice ? 1 : 0));
        } else {
            try {
                votes = await window.__nswsTraffic.vote(entry.a.id, choice);
            } catch (err) {
                if (shown !== entry) return;
                for (const b of buttons) b.disabled = false;
                msg.textContent = err?.status === 409 ? "This poll has closed." : "Couldn't send your vote. Try again.";
                m.appendChild(msg);
                return;
            }
        }
        if (shown !== entry) return;
        m.querySelector(".opts")?.remove();
        const res = document.createElement("div");
        res.className = "res";
        const sum = votes.reduce((s, n) => s + n, 0);
        poll.forEach((text, i) => {
            const share = sum ? Math.round((votes[i] / sum) * 100) : 0;
            const row = document.createElement("div");
            row.className = "r" + (i === choice ? " mine" : "");
            const bar = document.createElement("i");
            bar.style.width = share + "%";
            const label = document.createElement("span");
            label.textContent = text;
            const pct = document.createElement("span");
            pct.textContent = share + "%";
            row.append(bar, label, pct);
            res.appendChild(row);
        });
        const total = document.createElement("div");
        total.className = "total";
        total.textContent = sum === 1 ? "1 vote" : sum + " votes";
        res.appendChild(total);
        m.appendChild(res);
        setTimeout(() => shown === entry && hide(false), RESULTS_MS);
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
