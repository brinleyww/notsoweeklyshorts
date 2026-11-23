// Tells each browser once, on the main menu, about the newest NSWS YouTube video. It only shows after
// YouTube's oEmbed answers, so a network that blocks YouTube never sees it; that visit doesn't count.
// A new VIDEO_ID shows it again to everyone.
(function () {
    if (window.__nswsVideoPrompt || window.top !== window) return;
    window.__nswsVideoPrompt = true;

    const VIDEO_ID = "SYfrfSJMUX0";
    const SEEN_KEY = "_nswsVideoSeen";
    const URL = "https://www.youtube.com/watch?v=" + VIDEO_ID;
    const OEMBED = "https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent(URL);
    const CHECK_TIMEOUT_MS = 8000;
    const MENU_IDLE_MS = 2500;

    const CSS = `
.nsws-vid{margin:0;padding:0;position:fixed;inset:0;width:100%;height:100%;max-width:none;max-height:none;background-color:rgba(20,20,30,.5);border:none;pointer-events:auto;}
.nsws-vid::backdrop{background-color:transparent;}
.nsws-vid>div{position:absolute;left:50%;top:30%;transform:translateX(-50%);margin:0;padding:10px;width:500px;max-width:calc(100% - 20px);box-sizing:border-box;background-color:var(--surface-color,#28346a);text-align:center;}
.nsws-vid .card{display:flex;align-items:center;gap:14px;margin:0 0 10px 0;padding:12px 14px;background-color:var(--surface-secondary-color,#212b58);text-align:left;color:var(--text-color,#fff);text-decoration:none;}
.nsws-vid .card img{flex-shrink:0;width:160px;height:90px;object-fit:cover;}
.nsws-vid .card img.hidden{display:none;}
.nsws-vid .name{font-size:24px;line-height:1.05;overflow-wrap:break-word;}
.nsws-vid .count{margin-top:6px;font-size:18px;opacity:.75;}
.nsws-vid p{margin:0 0 10px 0;padding:10px;background-color:var(--surface-secondary-color,#212b58);font-size:26px;line-height:1.05;color:var(--text-color,#fff);overflow-wrap:break-word;}
.nsws-vid .row{display:flex;justify-content:space-between;gap:10px;}
.nsws-vid .button{min-width:140px;margin:0;text-decoration:none;}
@media (max-width:420px){.nsws-vid .card img{width:112px;height:63px;}}
`;

    function seen() {
        try {
            return (localStorage.getItem(SEEN_KEY) || "").split(":")[0] === VIDEO_ID;
        } catch {
            return true;
        }
    }

    function markSeen(how) {
        try {
            localStorage.setItem(SEEN_KEY, VIDEO_ID + ":" + how + ":" + Date.now());
        } catch {}
    }

    async function reachYouTube() {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), CHECK_TIMEOUT_MS);
        try {
            const res = await fetch(OEMBED, { cache: "no-store", credentials: "omit", signal: ctl.signal });
            if (!res.ok) return null;
            const data = await res.json();
            return typeof data?.title === "string" && data.title ? data : null;
        } catch {
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    function menuIdle() {
        if (document.visibilityState !== "visible") return false;
        const menu = document.querySelector(".menu-ui > .main-buttons-container");
        if (!menu || menu.classList.contains("hidden") || !menu.offsetParent) return false;
        return !document.querySelector("dialog[open], #nsws-tutorial, #nsws-tour, .device-preset-ui, #nrc-overlay, #nsws-editor:not(.hidden), .nt-host:not([hidden])");
    }

    function waitForMenu() {
        return new Promise((resolve) => {
            let since = 0;
            const tick = () => {
                if (!menuIdle()) since = 0;
                else if (!since) since = Date.now();
                else if (Date.now() - since >= MENU_IDLE_MS) return resolve();
                setTimeout(tick, 500);
            };
            tick();
        });
    }

    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    function link(cls, text) {
        const a = el("a", cls, text);
        a.href = URL;
        a.target = "_blank";
        a.rel = "noopener";
        return a;
    }

    function show(video) {
        if (!document.getElementById("nsws-vid-style")) {
            const style = el("style");
            style.id = "nsws-vid-style";
            style.textContent = CSS;
            document.head.appendChild(style);
        }
        const dialog = el("dialog", "nsws-vid");
        const box = el("div");
        dialog.appendChild(box);

        const card = link("card");
        const thumb = el("img", "hidden");
        thumb.alt = "";
        thumb.addEventListener("load", () => thumb.classList.remove("hidden"));
        thumb.src = "https://i.ytimg.com/vi/" + VIDEO_ID + "/mqdefault.jpg";
        card.appendChild(thumb);
        const info = el("div");
        info.appendChild(el("div", "name", video.title));
        info.appendChild(el("div", "count", video.author_name || "Not So Weekly Shorts"));
        card.appendChild(info);
        box.appendChild(card);

        box.appendChild(el("p", null, "The first official NSWS video is out! Go watch it on YouTube."));

        const row = el("div", "row");
        const later = el("button", "button", "No thanks");
        const watch = link("button", "Watch video");
        row.append(later, watch);
        box.appendChild(row);

        let answer = "closed";
        const close = () => {
            markSeen(answer);
            if (dialog.open) dialog.close();
            dialog.remove();
        };
        later.addEventListener("click", () => {
            window.__nswsUIClick?.();
            answer = "no";
            close();
        });
        for (const a of [card, watch]) {
            a.addEventListener("click", () => {
                window.__nswsUIClick?.();
                answer = "watched";
                setTimeout(close, 0);
            });
        }
        dialog.addEventListener("close", close);
        dialog.addEventListener("click", (e) => {
            if (e.target === dialog) close();
        });

        document.body.appendChild(dialog);
        dialog.showModal();
        watch.focus();
    }

    async function start() {
        if (seen()) return;
        const video = await reachYouTube();
        if (!video || seen()) return;
        await waitForMenu();
        // One menu prompt per visit: if the Discord box already showed, this waits for the next visit.
        if (seen() || window.__nswsMenuPromptShown) return;
        window.__nswsMenuPromptShown = true;
        show(video);
    }

    start();
})();
