// The owner's announcements: a chat-style "Name: message" at the top middle of everyone's screen
// that fades away. A poll gets its own card, which stays (across reloads too) until the player
// closes it. They arrive with the traffic beat (nsws_traffic.js) or, for players with the chat
// open, over the chat socket. The font follows each player's chat font setting.
(function () {
    if (window.__nswsAnnounce) return;

    const SEEN_KEY = "nsws_ann_seen";
    const SEEN_KEPT = 30;
    const POLL_KEY = "nsws_poll_open";
    const LIKED_KEY = "nsws_ann_liked";
    // Matches POLL_OPEN_MS in proxy/src/traffic.js.
    const POLL_OPEN_MS = 7 * 86_400_000;
    const FADE_IN_MS = 450;
    const FADE_OUT_MS = 2800;
    const DEFAULT_COLOR = "#b3c1ff";
    const HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.5l-1.4-1.3C5.4 14.5 2 11.4 2 7.6 2 4.5 4.4 2.1 7.5 2.1c1.7 0 3.4.8 4.5 2.1 1.1-1.3 2.8-2.1 4.5-2.1 3.1 0 5.5 2.4 5.5 5.5 0 3.8-3.4 6.9-8.6 11.6L12 20.5z"/></svg>';

    const CSS = `
#nsws-ann{position:fixed;left:0;right:0;top:calc(var(--safe-area-top-unscaled,0px) + 12px);z-index:10010;display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none;}
#nsws-ann>.m{position:relative;box-sizing:border-box;max-width:min(820px,calc(100vw - 32px));padding:10px 22px 12px 32px;background:rgba(33,43,88,.93);color:var(--text-color,#fff);font-family:'NSWS Flags',var(--nsws-chat-text,ForcedSquare,Arial),var(--nsws-chat-emoji,sans-serif),sans-serif;font-style:var(--nsws-chat-font-style,italic);font-size:clamp(18px,2.4vw,26px);line-height:1.35;overflow-wrap:anywhere;box-shadow:0 8px 28px rgba(0,0,0,.45);}
#nsws-ann>.m::before{content:"";position:absolute;left:15px;top:11px;bottom:11px;width:4px;border-radius:2px;background:var(--c);opacity:.8;}
#nsws-ann .nick{color:var(--c);font-weight:var(--nsws-chat-name-weight,bold);}
#nsws-ann a{pointer-events:auto;color:#8cc4ff;text-decoration:underline;text-underline-offset:.15em;cursor:pointer;}
#nsws-ann a:hover{color:#c4e0ff;}
#nsws-ann .note{margin-left:.5em;font-size:.6em;opacity:.5;}
#nsws-ann>.m.poll{order:1;padding-right:46px;max-height:calc(100vh - 40px);overflow-y:auto;pointer-events:auto;}
body:has(#nrc-overlay) #nsws-ann>.m.poll{display:none;}
#nsws-ann .x{pointer-events:auto;position:absolute;right:6px;top:4px;padding:2px 10px;background:none;border:none;color:inherit;font:inherit;font-style:normal;font-size:24px;line-height:1.2;opacity:.5;cursor:pointer;}
#nsws-ann .x:hover{opacity:1;}
#nsws-ann .opts{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;}
#nsws-ann .opts .button{margin:0;padding:6px 18px;font-family:inherit;font-style:inherit;font-size:.8em;}
#nsws-ann .res{display:flex;flex-direction:column;gap:6px;margin-top:10px;font-size:.75em;min-width:min(460px,calc(100vw - 110px));}
#nsws-ann .res .r{position:relative;display:flex;gap:12px;justify-content:space-between;padding:4px 12px;background:rgba(255,255,255,.06);border:none;color:inherit;font:inherit;text-align:left;}
#nsws-ann .res button.r{cursor:pointer;}
#nsws-ann .res button.r:hover{background:rgba(255,255,255,.12);}
#nsws-ann .res .r>i{position:absolute;left:0;top:0;bottom:0;background:var(--c);opacity:.22;transition:width .4s ease-out;}
#nsws-ann .res .r.mine>i{opacity:.45;}
#nsws-ann .res .r>span{position:relative;}
#nsws-ann .res .r>span:last-child{font-variant-numeric:tabular-nums;white-space:nowrap;}
#nsws-ann .like{pointer-events:auto;display:inline-flex;align-items:center;gap:.3em;margin-left:.6em;padding:2px 8px;vertical-align:.1em;background:rgba(255,255,255,.08);border:none;color:inherit;font:inherit;font-style:normal;font-size:.7em;line-height:1.3;font-variant-numeric:tabular-nums;cursor:pointer;opacity:.7;}
#nsws-ann .like:hover{opacity:1;background:rgba(255,255,255,.16);}
#nsws-ann .like svg{width:1.05em;height:1.05em;fill:none;stroke:currentColor;stroke-width:2.2;}
#nsws-ann .like.on{opacity:1;color:#ff6b8b;}
#nsws-ann .like.on svg{fill:currentColor;}
#nsws-ann .total,#nsws-ann .msg{font-size:.65em;opacity:.6;margin-top:6px;}
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

    function readLiked() {
        try {
            const list = JSON.parse(localStorage.getItem(LIKED_KEY));
            return Array.isArray(list) ? list : [];
        } catch {
            return [];
        }
    }

    function saveLiked(id, on) {
        const list = readLiked().filter((x) => x !== id);
        if (on) list.push(id);
        try {
            localStorage.setItem(LIKED_KEY, JSON.stringify(list.slice(-SEEN_KEPT)));
        } catch {}
    }

    function valid(a) {
        return !!a && Number.isSafeInteger(a.id) && typeof a.text === "string" && a.text.length > 0;
    }

    function pollOf(a) {
        return Array.isArray(a?.poll) && a.poll.length >= 2 && a.poll.every((o) => typeof o === "string") ? a.poll : null;
    }

    // Keep the game from treating a click on the banner as input.
    function ownClicks(node) {
        for (const type of ["pointerdown", "mousedown", "touchstart", "click"]) node.addEventListener(type, (e) => e.stopPropagation());
    }

    function make(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
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

    // Holds the banner while the pointer is on a link or the like button so it can't fade out from under the click.
    function holdWhileHovered(node) {
        node.addEventListener("pointerenter", () => shown?.el.contains(node) && shown.anim?.playState === "running" && shown.anim.pause());
        node.addEventListener("pointerleave", () => shown?.el.contains(node) && shown.anim?.playState === "paused" && shown.anim.play());
    }

    function appendText(m, text) {
        let last = 0;
        for (const match of text.matchAll(LINK)) {
            let raw = match[0].replace(/[.,!?;:'"\]]+$/, "");
            if (raw.endsWith(")") && !raw.includes("(")) raw = raw.replace(/\)+$/, "");
            const url = href(raw);
            if (!url) continue;
            m.append(text.slice(last, match.index));
            const a = make("a", null, raw);
            a.href = url;
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            ownClicks(a);
            holdWhileHovered(a);
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

    // shown: the message card { a, el, preview, at, anim }. poll: the poll card
    // { a, el, preview, at, choice, votes, open, change, busy, error }. waiting: one that came in
    // while the tab was hidden.
    let shown = null;
    let poll = null;
    let waiting = null;

    function stack() {
        if (!document.getElementById("nsws-ann-style")) {
            const style = make("style");
            style.id = "nsws-ann-style";
            style.textContent = CSS;
            document.head.appendChild(style);
        }
        let box = document.getElementById("nsws-ann");
        if (!box) {
            box = make("div");
            box.id = "nsws-ann";
            box.setAttribute("role", "status");
            document.body.appendChild(box);
        }
        // Players can move the race timer to the top middle; stay below it.
        const timer = document.querySelector(".timer-ui.up:not(.hidden)");
        const bottom = timer ? timer.getBoundingClientRect().bottom : 0;
        box.style.top = bottom > 0 ? bottom + 10 + "px" : "";
        return box;
    }

    function card(entry) {
        const { a, preview } = entry;
        const m = make("div", "m");
        m.style.setProperty("--c", /^#[0-9a-f]{6}$/i.test(a.color) ? a.color : DEFAULT_COLOR);
        m.append(make("span", "nick", a.name || "Owner"), ": ");
        appendText(m, a.text);
        m.appendChild(likeButton(entry));
        if (preview) m.appendChild(make("span", "note", "preview, only you see this"));
        return m;
    }

    function likeButton(entry) {
        if (entry.likes == null) entry.likes = Number.isSafeInteger(entry.a.likes) && entry.a.likes > 0 ? entry.a.likes : 0;
        if (entry.liked == null) entry.liked = !entry.preview && readLiked().includes(entry.a.id);
        const b = make("button", "like");
        b.type = "button";
        ownClicks(b);
        holdWhileHovered(b);
        b.addEventListener("click", () => toggleLike(entry, b));
        paintLike(entry, b);
        return b;
    }

    function paintLike(entry, b) {
        b.classList.toggle("on", entry.liked);
        b.innerHTML = HEART;
        if (entry.likes > 0) b.append(String(entry.likes));
        b.title = entry.liked ? "Unlike" : "Like";
        b.setAttribute("aria-pressed", String(entry.liked));
    }

    async function toggleLike(entry, b) {
        if (entry.likeBusy) return;
        const before = { liked: entry.liked, likes: entry.likes };
        const on = !entry.liked;
        entry.liked = on;
        entry.likes = Math.max(0, entry.likes + (on ? 1 : -1));
        paintLike(entry, b);
        if (entry.preview) return;
        entry.likeBusy = true;
        try {
            const data = await window.__nswsTraffic.like(entry.a.id, on);
            entry.likes = data.likes;
            entry.liked = !!data.liked;
        } catch (err) {
            Object.assign(entry, before);
            if (Number.isSafeInteger(err?.likes)) entry.likes = err.likes;
        }
        entry.likeBusy = false;
        saveLiked(entry.a.id, entry.liked);
        paintLike(entry, b);
        if (poll === entry) savePoll();
    }

    function fadeOut(el, anim) {
        const opacity = getComputedStyle(el).opacity;
        anim?.cancel();
        if (!el.animate) return el.remove();
        el.animate([{ opacity }, { opacity: 0 }], { duration: 600, fill: "forwards" }).onfinish = () => el.remove();
    }

    function hide(now) {
        if (!shown) return;
        const { el, anim } = shown;
        shown = null;
        if (now) {
            anim?.cancel();
            el.remove();
        } else {
            fadeOut(el, anim);
        }
    }

    function show(a, preview) {
        if (pollOf(a)) return showPoll({ a, preview: !!preview, choice: null, votes: null, open: true, change: !!a.change }, true);
        hide(true);
        const entry = { a, el: null, preview: !!preview, at: performance.now(), anim: null };
        const el = (entry.el = card(entry));
        stack().appendChild(el);
        const hold = Math.max(3, Number(a.show) || 10) * 1000;
        const total = FADE_IN_MS + hold + FADE_OUT_MS;
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

    function savePoll() {
        if (!poll || poll.preview) return;
        try {
            const { a, choice, votes, open, change, likes } = poll;
            localStorage.setItem(POLL_KEY, JSON.stringify({ a, choice, votes, open, change, likes }));
        } catch {}
    }

    function storedPoll() {
        try {
            const p = JSON.parse(localStorage.getItem(POLL_KEY));
            if (!valid(p?.a) || !pollOf(p.a) || !(Date.now() < p.a.at + POLL_OPEN_MS + 86_400_000)) return null;
            return {
                a: p.a,
                preview: false,
                choice: Number.isSafeInteger(p.choice) ? p.choice : null,
                votes: Array.isArray(p.votes) ? p.votes : null,
                open: p.open !== false,
                change: !!p.change,
                likes: Number.isSafeInteger(p.likes) && p.likes > 0 ? p.likes : null,
            };
        } catch {
            return null;
        }
    }

    function showPoll(entry, fresh) {
        if (poll) {
            poll.el.remove();
            poll = null;
        }
        entry.el = card(entry);
        entry.el.classList.add("poll");
        entry.at = performance.now();
        ownClicks(entry.el);
        const close = make("button", "x", "\u00d7");
        close.title = "Close";
        ownClicks(close);
        close.addEventListener("click", () => closePoll(entry));
        entry.el.appendChild(close);
        entry.body = make("div");
        entry.el.appendChild(entry.body);
        stack().appendChild(entry.el);
        poll = entry;
        renderPoll();
        if (fresh) {
            entry.el.animate?.([
                { opacity: 0, transform: "translateY(-16px)" },
                { opacity: 1, transform: "none" },
            ], { duration: FADE_IN_MS, easing: "ease-out" });
            chime();
        }
        if (!entry.preview) {
            markSeen(entry.a.id);
            if (fresh) window.__nswsTraffic?.seen?.(entry.a.id);
            savePoll();
        }
    }

    function closePoll(entry) {
        if (poll !== entry) return;
        poll = null;
        fadeOut(entry.el, null);
        if (entry.preview) {
            // A preview only covered the real poll for a moment.
            const real = storedPoll();
            if (real) showPoll(real, false);
            return;
        }
        try {
            localStorage.removeItem(POLL_KEY);
        } catch {}
    }

    function renderPoll() {
        const entry = poll;
        const options = pollOf(entry.a);
        const body = entry.body;
        body.textContent = "";
        const voted = entry.choice != null;
        if (!voted && entry.open) {
            const opts = make("div", "opts");
            options.forEach((text, i) => {
                const b = make("button", "button", text);
                b.disabled = entry.busy;
                ownClicks(b);
                b.addEventListener("click", () => vote(entry, i));
                opts.appendChild(b);
            });
            body.appendChild(opts);
        } else {
            const votes = entry.votes ?? options.map(() => 0);
            const sum = votes.reduce((s, n) => s + (n || 0), 0);
            const canChange = voted && entry.open && entry.change;
            const res = make("div", "res");
            options.forEach((text, i) => {
                const share = sum ? Math.round(((votes[i] || 0) / sum) * 100) : 0;
                const row = make(canChange ? "button" : "div", "r" + (i === entry.choice ? " mine" : ""));
                const bar = make("i");
                bar.style.width = share + "%";
                row.append(bar, make("span", null, text), make("span", null, share + "%"));
                if (canChange) {
                    row.disabled = entry.busy;
                    ownClicks(row);
                    row.addEventListener("click", () => i !== entry.choice && vote(entry, i));
                }
                res.appendChild(row);
            });
            const notes = [sum === 1 ? "1 vote" : sum + " votes"];
            if (!entry.open) notes.push("voting has closed");
            else if (canChange) notes.push("click another answer to change your vote");
            res.appendChild(make("div", "total", notes.join(" \u00b7 ")));
            body.appendChild(res);
        }
        if (entry.error) body.appendChild(make("div", "msg", entry.error));
    }

    async function vote(entry, choice) {
        if (entry.busy) return;
        entry.busy = true;
        entry.error = null;
        renderPoll();
        if (entry.preview) {
            const votes = entry.votes ?? pollOf(entry.a).map(() => 0);
            if (entry.choice != null) votes[entry.choice]--;
            votes[choice]++;
            Object.assign(entry, { votes, choice, change: true });
        } else {
            try {
                const data = await window.__nswsTraffic.vote(entry.a.id, choice);
                entry.votes = data.votes;
                entry.choice = Number.isSafeInteger(data.choice) ? data.choice : choice;
            } catch (err) {
                if (err?.status === 409 && Array.isArray(err.votes)) {
                    entry.open = false;
                    entry.votes = err.votes;
                } else {
                    entry.error = err?.status === 409 ? "This poll has closed." : "Couldn't send your vote. Try again.";
                }
            }
        }
        entry.busy = false;
        if (poll !== entry) return;
        savePoll();
        renderPoll();
    }

    // The beat's reply to a poll the player is looking at.
    function pollUpdate(state) {
        if (!poll || poll.preview || state?.id !== poll.a.id || !Array.isArray(state.votes)) return;
        poll.votes = state.votes;
        poll.open = !!state.open;
        poll.change = !!state.change;
        savePoll();
        if (!poll.busy) renderPoll();
    }

    // The beat's reply carries the live announcement or null; a null (or a newer one) ends the
    // message on screen, which is how the owner's Stop reaches players without the chat. A poll
    // stays until the player closes it. `asked` is when the beat was sent: a reply to a beat from
    // before the banner appeared is out of date.
    function receive(a, asked) {
        if (!valid(a)) {
            if (shown && asked < shown.at) return;
            if (waiting && !pollOf(waiting.a)) waiting = null;
            if (shown && !shown.preview) hide(false);
            return;
        }
        if (pollOf(a)) {
            if (poll?.a.id === a.id && !poll.preview) return;
        } else {
            if (shown && asked < shown.at) return;
            if (shown && !shown.preview && shown.a.id !== a.id) hide(false);
            if (shown?.a.id === a.id && !shown.preview) return;
        }
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

    function restore() {
        const entry = storedPoll();
        if (entry) showPoll(entry, false);
        else
            try {
                localStorage.removeItem(POLL_KEY);
            } catch {}
    }
    if (document.body) restore();
    else document.addEventListener("DOMContentLoaded", restore, { once: true });

    window.__nswsAnnounce = {
        receive,
        stop,
        pollUpdate,
        // The poll whose counts the next beat should ask for.
        watching: () => (poll && !poll.preview ? poll.a.id : poll ? storedPoll()?.a.id ?? null : null),
        preview: (a) => show({ id: 0, ...a }, true),
    };
})();
