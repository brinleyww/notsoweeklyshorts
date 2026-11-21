// Changelog window, opened from the main menu's bottom bar. Reads changelog.json (newest first).
(function () {
    const SEEN_KEY = "_nswsChangelogSeen";
    const CSS = `
#nsws-changelog{position:fixed;inset:0;z-index:9998;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.7);}
#nsws-changelog *{box-sizing:border-box;}
#nsws-changelog>.box{display:flex;flex-direction:column;width:min(640px,96vw);max-height:90vh;background:var(--surface-color);color:var(--text-color);clip-path:polygon(0 0,100% 0,calc(100% - 14px) 100%,0 100%);}
#nsws-changelog .checker{height:8px;flex-shrink:0;background:repeating-conic-gradient(#fff 0 25%,#112052 0 50%) 0 0/8px 8px;opacity:.85;}
#nsws-changelog .top{display:flex;align-items:center;gap:12px;padding:12px 20px;background:var(--surface-secondary-color);}
#nsws-changelog .top>h1{margin:0 auto 0 0;font-size:32px;font-weight:normal;color:#b3c1ff;text-shadow:0 2px 0 #112052;}
#nsws-changelog .top>.button{margin:0;font-size:20px;padding:6px 14px;}
#nsws-changelog .body{overflow-y:auto;padding:12px 20px 18px;}
#nsws-changelog .ver{margin:14px 0 4px;font-size:24px;color:#ffc94a;}
#nsws-changelog .ver:first-child{margin-top:0;}
#nsws-changelog .ver>span{margin-left:10px;font-size:15px;color:var(--text-color);opacity:.55;}
#nsws-changelog ul{margin:0;padding-left:24px;font-size:19px;}
#nsws-changelog li{margin:3px 0;overflow-wrap:anywhere;}
#nsws-changelog .msg{font-size:19px;opacity:.7;}
.nsws-changelog-btn>.dot{display:none;position:absolute;top:5px;right:8px;width:8px;height:8px;border-radius:50%;background:#ffc94a;pointer-events:none;}
.nsws-changelog-btn.fresh>.dot{display:block;}
`;
    let overlay = null;
    let latest = null;
    const buttons = new Set();

    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    function seen() {
        try {
            return localStorage.getItem(SEEN_KEY);
        } catch (e) {
            return null;
        }
    }

    function markSeen() {
        if (!latest) return;
        try {
            localStorage.setItem(SEEN_KEY, latest);
        } catch (e) {}
        paint();
    }

    function paint() {
        for (const b of buttons) b.classList.toggle("fresh", !!latest && seen() !== latest);
    }

    async function load() {
        const res = await fetch(new URL("changelog.json", location.href), { cache: "no-store" });
        if (!res.ok) throw new Error("changelog " + res.status);
        const log = (await res.json()).filter(e => e && typeof e.version === "string" && Array.isArray(e.changes));
        latest = log[0]?.version || null;
        paint();
        return log;
    }

    function addStyle() {
        if (document.getElementById("nsws-changelog-style")) return;
        const style = el("style");
        style.id = "nsws-changelog-style";
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    function onKey(e) {
        if (e.key !== "Escape" && e.code !== "Escape") return;
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
    }

    function close() {
        if (!overlay) return;
        overlay.remove();
        overlay = null;
        window.removeEventListener("keydown", onKey, true);
    }

    function open() {
        if (overlay) return;
        addStyle();
        overlay = el("div");
        overlay.id = "nsws-changelog";
        const box = el("div", "box");
        box.appendChild(el("div", "checker"));
        const top = el("div", "top");
        const x = el("button", "button", "✕");
        x.addEventListener("click", close);
        top.append(el("h1", null, "Changelog"), x);
        const body = el("div", "body");
        body.appendChild(el("div", "msg", "Loading..."));
        box.append(top, body);
        overlay.appendChild(box);
        overlay.addEventListener("pointerdown", e => {
            if (e.target === overlay) close();
        });
        for (const type of ["keydown", "keyup", "keypress"]) overlay.addEventListener(type, e => e.stopPropagation());
        document.body.appendChild(overlay);
        window.addEventListener("keydown", onKey, true);

        const view = overlay;
        load().then(log => {
            if (overlay !== view) return;
            body.textContent = "";
            if (!log.length) body.appendChild(el("div", "msg", "Nothing here yet."));
            for (const entry of log) {
                const ver = el("div", "ver", entry.version);
                if (typeof entry.date === "string") ver.appendChild(el("span", null, entry.date));
                const list = el("ul");
                for (const line of entry.changes) list.appendChild(el("li", null, String(line)));
                body.append(ver, list);
            }
            markSeen();
        }).catch(() => {
            if (overlay !== view) return;
            body.textContent = "";
            body.appendChild(el("div", "msg", "Couldn't load the changelog."));
        });
    }

    function mountButton(b) {
        addStyle();
        b.classList.add("nsws-changelog-btn");
        b.innerHTML = '<img src="images/list.svg"> ';
        const dot = el("span", "dot");
        b.append("Changelog", dot);
        b.title = "What changed in each update";
        buttons.add(b);
        paint();
    }

    window.__nswsChangelog = { open, mountButton };
    load().catch(() => {});
})();
