// Tells each browser once, on the main menu, about the newest upload (video or short) on the NSWS YouTube
// channel. It only shows after YouTube's oEmbed answers, so a network that blocks YouTube never sees it;
// that visit doesn't count.
(function () {
    if (window.__nswsVideoPrompt || window.top !== window) return;
    window.__nswsVideoPrompt = true;

    const API = window.__nswsApiBase;
    const SEEN_KEY = "_nswsVideoSeen";
    const LATEST_KEY = "_nswsVideoLatest";
    const LATEST_RECHECK_MS = 30 * 60 * 1000;
    const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
    const CHECK_TIMEOUT_MS = 8000;
    const MENU_IDLE_MS = 2500;

    const CSS = `
.nsws-vid{margin:0;padding:0;position:fixed;inset:0;width:100%;height:100%;max-width:none;max-height:none;background-color:rgba(20,20,30,.5);border:none;pointer-events:auto;}
.nsws-vid::backdrop{background-color:transparent;}
.nsws-vid>div{position:absolute;left:50%;top:30%;transform:translateX(-50%);margin:0;padding:10px;width:500px;max-width:calc(100% - 20px);box-sizing:border-box;background-color:var(--surface-color,#28346a);text-align:center;}
.nsws-vid .card{display:flex;align-items:center;gap:14px;margin:0 0 10px 0;padding:12px 14px;background-color:var(--surface-secondary-color,#212b58);text-align:left;color:var(--text-color,#fff);text-decoration:none;}
.nsws-vid .card img{flex-shrink:0;width:160px;height:90px;object-fit:cover;}
.nsws-vid .card img.hidden{display:none;}
.nsws-vid .name{font-size:24px;line-height:1.05;overflow-wrap:anywhere;}
.nsws-vid .count{margin-top:6px;font-size:18px;opacity:.75;}
.nsws-vid p{margin:0 0 10px 0;padding:10px;background-color:var(--surface-secondary-color,#212b58);font-size:26px;line-height:1.05;color:var(--text-color,#fff);overflow-wrap:break-word;}
.nsws-vid .row{display:flex;justify-content:space-between;gap:10px;}
.nsws-vid .button{min-width:140px;margin:0;text-decoration:none;}
.nsws-vid.short .row a.button{flex:1;}
.nsws-vid.short>div{top:50%;transform:translate(-50%,-50%);width:520px;max-height:calc(100% - 20px);overflow-y:auto;}
.nsws-vid .poster{display:block;margin:0 auto 10px auto;height:min(62vh,560px);aspect-ratio:9/16;max-width:100%;background:#000;}
.nsws-vid .poster img{display:block;width:100%;height:100%;object-fit:cover;}
@media (max-width:420px){.nsws-vid .card img{width:112px;height:63px;}}
`;

    function seen(id) {
        try {
            return (localStorage.getItem(SEEN_KEY) || "").split(":")[0] === id;
        } catch {
            return true;
        }
    }

    function markSeen(id, how) {
        try {
            localStorage.setItem(SEEN_KEY, id + ":" + how + ":" + Date.now());
        } catch {}
    }

    async function getJson(url) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), CHECK_TIMEOUT_MS);
        try {
            const res = await fetch(url, { cache: "no-store", credentials: "omit", signal: ctl.signal });
            return res.ok ? await res.json() : null;
        } catch {
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    async function latestUpload() {
        try {
            const saved = JSON.parse(localStorage.getItem(LATEST_KEY) || "null");
            if (saved && Date.now() - saved.at < LATEST_RECHECK_MS) return saved.latest;
        } catch {}
        if (!API) return null;
        const data = await getJson(API + "nsws/youtube/latest");
        if (!data) return null;
        try {
            localStorage.setItem(LATEST_KEY, JSON.stringify({ at: Date.now(), latest: data.latest }));
        } catch {}
        return data.latest;
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

    function show(upload, info, url) {
        if (!document.getElementById("nsws-vid-style")) {
            const style = el("style");
            style.id = "nsws-vid-style";
            style.textContent = CSS;
            document.head.appendChild(style);
        }
        const kind = upload.short ? "short" : "video";
        const link = (cls, text) => {
            const a = el("a", cls, text);
            a.href = url;
            a.target = "_blank";
            a.rel = "noopener";
            return a;
        };
        const dialog = el("dialog", "nsws-vid");
        const box = el("div");
        dialog.appendChild(box);
        let answer = "closed";
        const close = () => {
            markSeen(upload.id, answer);
            if (dialog.open) dialog.close();
            dialog.remove();
        };
        dialog.addEventListener("close", close);
        dialog.addEventListener("click", (e) => {
            if (e.target === dialog) close();
        });

        if (upload.short) {
            dialog.classList.add("short");
            box.appendChild(el("p", null, "There's a new NSWS short! Go watch it on YouTube."));
            const poster = link("poster");
            poster.title = info.title;
            const img = el("img");
            img.alt = info.title;
            // oardefault is the full vertical frame; older uploads may only have the 4:3 one.
            img.addEventListener("error", () => {
                if (!img.src.endsWith("/hqdefault.jpg")) img.src = "https://i.ytimg.com/vi/" + upload.id + "/hqdefault.jpg";
            });
            img.src = "https://i.ytimg.com/vi/" + upload.id + "/oardefault.jpg";
            poster.appendChild(img);
            poster.addEventListener("click", () => {
                window.__nswsUIClick?.();
                answer = "watched";
                setTimeout(close, 0);
            });
            box.appendChild(poster);
            const row = el("div", "row");
            const done = el("button", "button", "Close");
            done.addEventListener("click", () => {
                window.__nswsUIClick?.();
                close();
            });
            const open = link("button", "Watch on YouTube");
            open.addEventListener("click", () => {
                window.__nswsUIClick?.();
                answer = "watched";
                setTimeout(close, 0);
            });
            row.append(done, open);
            box.appendChild(row);
            document.body.appendChild(dialog);
            dialog.showModal();
            done.focus();
            return;
        }

        const card = link("card");
        const thumb = el("img", "hidden");
        thumb.alt = "";
        thumb.addEventListener("load", () => thumb.classList.remove("hidden"));
        thumb.src = "https://i.ytimg.com/vi/" + upload.id + "/mqdefault.jpg";
        card.appendChild(thumb);
        const text = el("div");
        text.appendChild(el("div", "name", info.title));
        text.appendChild(el("div", "count", info.author_name || "Not So Weekly Shorts"));
        card.appendChild(text);
        box.appendChild(card);

        box.appendChild(el("p", null, "There's a new NSWS " + kind + "! Go watch it on YouTube."));

        const row = el("div", "row");
        const later = el("button", "button", "No thanks");
        const watch = link("button", "Watch " + kind);
        row.append(later, watch);
        box.appendChild(row);

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

        document.body.appendChild(dialog);
        dialog.showModal();
        watch.focus();
    }

    async function start() {
        const upload = await latestUpload();
        if (!upload || !/^[\w-]{11}$/.test(upload.id) || Date.now() - upload.published > MAX_AGE_MS) return;
        if (seen(upload.id)) return;
        const url = upload.short ? "https://www.youtube.com/shorts/" + upload.id : "https://www.youtube.com/watch?v=" + upload.id;
        const info = await getJson("https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent(url));
        if (!info || typeof info.title !== "string" || !info.title || seen(upload.id)) return;
        await waitForMenu();
        // One menu prompt per visit: if the Discord box already showed, this waits for the next visit.
        if (seen(upload.id) || window.__nswsMenuPromptShown) return;
        window.__nswsMenuPromptShown = true;
        show(upload, info, url);
    }

    start();
})();
