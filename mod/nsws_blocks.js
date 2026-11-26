// Chat block / ignore, like Discord. The list lives on the account (blocks/list, blocks/set, refer/me);
// the copy in localStorage lets the chat hide messages before the server answers.
(function () {
    const STORE_KEY = "_nswsChatBlocks";
    const TOKEN = /^[0-9a-f]{64}$/;
    const TOKEN_CHECK_MS = 3000;
    const IGNORED_IN_NAMES = /[\p{Cc}\p{Cf}\p{Z}\s]/gu;
    const WORDS = {
        block: { verb: "Block", undo: "Unblock", done: "Blocked", list: "Blocked" },
        ignore: { verb: "Ignore", undo: "Unignore", done: "Ignored", list: "Ignored" },
    };
    const ERRORS = {
        self: "You can't block or ignore yourself.",
        missing: "There's no account with that name.",
        blocks: "That's as many people as you can block or ignore. Unblock someone first.",
    };

    const nameKey = (name) => String(name ?? "").normalize("NFKC").toLowerCase().replace(IGNORED_IN_NAMES, "");
    const listeners = new Set();
    let list = [];
    let who = null;
    let byUid = new Map();
    let byName = new Map();
    let checkedAt = 0;
    let dialog = null;
    let manager = null;

    function profileToken() {
        const token = window.__nswsProfileToken?.();
        return TOKEN.test(token || "") ? token : null;
    }

    function index() {
        byUid = new Map();
        byName = new Map();
        // Blocks go in last so they win over an ignore found the other way.
        for (const kind of ["ignore", "block"]) {
            for (const e of list) {
                if (e.kind !== kind) continue;
                for (const uid of e.uids) byUid.set(uid, kind);
                if (e.nick) byName.set(nameKey(e.nick), kind);
            }
        }
    }

    function clean(raw) {
        return (Array.isArray(raw) ? raw : []).filter((e) => e && (e.kind === "block" || e.kind === "ignore") && typeof e.ref === "string").map((e) => ({
            ref: e.ref,
            kind: e.kind,
            nick: typeof e.nick === "string" ? e.nick : "",
            uids: Array.isArray(e.uids) ? e.uids.filter((u) => typeof u === "string") : [],
            at: Number(e.at) || 0,
        }));
    }

    function use(token, raw, save) {
        list = clean(raw);
        who = token ? token.slice(0, 12) : null;
        index();
        if (save && token) {
            try {
                localStorage.setItem(STORE_KEY, JSON.stringify({ who, list }));
            } catch {}
        }
        for (const fn of listeners) {
            try {
                fn();
            } catch (err) {
                console.error(err);
            }
        }
    }

    // The saved list of whichever profile is in use now.
    function current() {
        if (Date.now() - checkedAt < TOKEN_CHECK_MS) return;
        checkedAt = Date.now();
        const token = profileToken();
        const id = token ? token.slice(0, 12) : null;
        if (id === who) return;
        let saved = null;
        try {
            saved = JSON.parse(localStorage.getItem(STORE_KEY));
        } catch {}
        use(token, saved?.who === id ? saved.list : [], false);
    }

    function relation(uid, nick) {
        current();
        if (!list.length) return null;
        return byUid.get(uid) ?? (nick ? byName.get(nameKey(nick)) : null) ?? null;
    }

    function heard(token, raw) {
        if (!token || token !== profileToken() || !Array.isArray(raw)) return;
        checkedAt = Date.now();
        use(token, raw, true);
    }

    // Rejects with err.status (0 when the proxy couldn't be reached) and err.code for a refusal.
    async function call(path, body) {
        const token = profileToken();
        const api = window.__nswsApiBase;
        if (!token || !api) throw Object.assign(new Error("No profile"), { status: 0 });
        let response;
        try {
            response = await fetch(api + "nsws/" + path, {
                method: "POST",
                headers: { "Content-Type": "text/plain" },
                body: JSON.stringify({ userToken: token, ...body }),
                cache: "no-store",
            });
        } catch {
            throw Object.assign(new Error("Server unreachable"), { status: 0 });
        }
        if (!response.ok) {
            const data = response.status === 409 ? await response.json().catch(() => null) : null;
            if (!data) await window.__nswsBusy?.fromResponse(response);
            throw Object.assign(new Error("Server answered " + response.status), { status: response.status, code: data?.error });
        }
        const answer = await response.json();
        if (Array.isArray(answer?.blocks) && profileToken() === token) {
            checkedAt = Date.now();
            use(token, answer.blocks, true);
        }
        return answer;
    }

    function refresh() {
        return call("blocks/list", {});
    }

    function errorText(err) {
        if (ERRORS[err?.code]) return ERRORS[err.code];
        if (err?.status === 0) return "Couldn't reach the server. Try again in a moment.";
        return "Couldn't save that. Try again in a moment.";
    }

    // kind null undoes whatever is set. target: { uid?, nick?, ref? }.
    function set(target, kind) {
        return call("blocks/set", { ref: target.ref, uid: target.uid, nick: target.nick, kind: kind ?? null });
    }

    function entryFor(uid, nick) {
        current();
        return list.find((e) => e.uids.includes(uid)) ?? list.find((e) => nick && nameKey(e.nick) === nameKey(nick)) ?? null;
    }

    const CSS = `
#nsws-block-ask{position:fixed;inset:0;z-index:10070;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6);font-family:'NSWS Flags',var(--nsws-chat-text,inherit),sans-serif;font-style:normal;color:#fff;}
#nsws-block-ask>.box{width:min(420px,calc(100vw - 24px));overflow:hidden;border-radius:8px;background:var(--surface-color,#28346a);box-shadow:0 8px 28px rgba(0,0,0,.5);}
#nsws-block-ask h3{margin:0;padding:16px 16px 8px;font-size:20px;font-weight:600;overflow-wrap:anywhere;}
#nsws-block-ask p{margin:0;padding:0 16px 14px;font-size:15px;line-height:1.4;opacity:.85;}
#nsws-block-ask .error{color:#ff8a8d;opacity:1;}
#nsws-block-ask .buttons{display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;background:var(--surface-tertiary-color,#192042);}
#nsws-block-ask .buttons>button{padding:8px 16px;border:0;border-radius:4px;background:transparent;color:inherit;font:inherit;font-size:15px;cursor:pointer;}
#nsws-block-ask .buttons>button:hover{text-decoration:underline;}
#nsws-block-ask .buttons>button.go{background:#da373c;}
#nsws-block-ask .buttons>button.go:hover{background:#a12828;text-decoration:none;}
#nsws-block-ask .buttons>button:disabled{opacity:.5;cursor:default;}
#nsws-blocks{position:fixed;inset:0;z-index:10060;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.7);}
#nsws-blocks *{box-sizing:border-box;}
#nsws-blocks>.box{display:flex;flex-direction:column;width:min(560px,96vw);max-height:90vh;background:var(--surface-color);color:var(--text-color);clip-path:polygon(0 0,100% 0,calc(100% - 14px) 100%,0 100%);outline:none;}
#nsws-blocks .top{padding:12px 20px;background:var(--surface-secondary-color);}
#nsws-blocks .top>h1{margin:0;font-size:30px;font-weight:normal;color:#b3c1ff;text-shadow:0 2px 0 #112052;}
#nsws-blocks .body{overflow-y:auto;padding:6px 20px 18px;}
#nsws-blocks .sec{margin:14px 0 2px;padding-bottom:3px;border-bottom:1px solid rgba(255,255,255,.8);font-size:15px;font-style:italic;color:rgba(255,255,255,.65);}
#nsws-blocks .row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:5px 0;border-bottom:1px solid rgba(255,255,255,.1);font-size:19px;}
#nsws-blocks .row>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
#nsws-blocks .row>.button{margin:0;flex-shrink:0;font-size:17px;padding:5px 14px;}
#nsws-blocks .msg{padding:24px 10px;text-align:center;font-size:17px;line-height:1.5;color:rgba(255,255,255,.65);}
#nsws-blocks .note{margin:10px 0 0;font-size:14px;line-height:1.4;color:rgba(255,255,255,.55);}
#nsws-blocks .bottom{display:flex;justify-content:space-between;padding:10px 20px;background:var(--surface-secondary-color);}
#nsws-blocks .bottom>.button{margin:0;font-size:20px;padding:7px 18px;}
`;

    function ensureStyle() {
        if (document.getElementById("nsws-blocks-style")) return;
        const style = document.createElement("style");
        style.id = "nsws-blocks-style";
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function closeAsk() {
        const open = dialog;
        dialog = null;
        open?.remove();
        open?.nswsDone?.(false);
    }

    // Asks first, like Discord does, then saves. Resolves true once it's saved.
    function ask(target, kind) {
        const words = WORDS[kind];
        if (!words || !target?.nick) return Promise.resolve(false);
        ensureStyle();
        closeAsk();
        return new Promise((resolve) => {
            const overlay = dialog = el("div");
            overlay.id = "nsws-block-ask";
            const box = el("div", "box");
            const title = el("h3", null, words.verb + " " + target.nick + "?");
            const text = el("p", null, kind === "block"
                ? "You won't see their messages unless you click Show, and you won't get pings from them. Their whispers to you won't go through."
                : "Their messages get tucked away and you won't get pings or whisper alerts from them. They won't know you ignored them.");
            const error = el("p", "error");
            error.style.display = "none";
            const buttons = el("div", "buttons");
            const cancel = el("button", null, "Cancel");
            const go = el("button", "go", words.verb);
            cancel.type = go.type = "button";
            const done = (ok) => {
                overlay.nswsDone = null;
                if (dialog === overlay) closeAsk();
                resolve(ok);
            };
            overlay.nswsDone = done;
            cancel.addEventListener("click", () => done(false));
            go.addEventListener("click", async () => {
                go.disabled = cancel.disabled = true;
                error.style.display = "none";
                try {
                    await set(target, kind);
                    done(true);
                } catch (err) {
                    error.textContent = errorText(err);
                    error.style.display = "";
                    go.disabled = cancel.disabled = false;
                }
            });
            buttons.append(cancel, go);
            box.append(title, text, error, buttons);
            overlay.appendChild(box);
            overlay.addEventListener("pointerdown", (e) => {
                if (e.target === overlay && !go.disabled) done(false);
            });
            overlay.addEventListener("keydown", (e) => {
                e.stopPropagation();
                if (e.key === "Escape") {
                    e.preventDefault();
                    if (!go.disabled) done(false);
                } else if (e.key === "Enter") {
                    e.preventDefault();
                    if (!go.disabled) go.click();
                }
            });
            for (const type of ["keyup", "keypress"]) overlay.addEventListener(type, (e) => e.stopPropagation());
            document.body.appendChild(overlay);
            go.focus();
        });
    }

    function button(text, onClick) {
        const b = el("button", "button", text);
        b.addEventListener("click", (e) => {
            window.__nswsUIClick?.();
            onClick(e);
        });
        return b;
    }

    function closeManager() {
        manager?.overlay.remove();
        manager = null;
    }

    function renderManager() {
        if (!manager) return;
        const body = manager.body;
        body.innerHTML = "";
        if (manager.error) body.appendChild(el("p", "note", manager.error));
        if (!list.length) {
            body.appendChild(el("div", "msg", manager.loading ? "Loading..." : "You haven't blocked or ignored anyone. Click a name in the chat to open their profile, then pick Block or Ignore."));
            return;
        }
        for (const kind of ["block", "ignore"]) {
            const rows = list.filter((e) => e.kind === kind);
            if (!rows.length) continue;
            body.appendChild(el("div", "sec", WORDS[kind].list + " (" + rows.length + ")"));
            for (const e of rows) {
                const row = el("div", "row");
                const name = el("span", null, e.nick || "Guest");
                if (e.at) name.title = WORDS[kind].done + " " + new Date(e.at).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
                const undo = button(WORDS[kind].undo, async () => {
                    undo.disabled = true;
                    manager.error = null;
                    try {
                        await set({ ref: e.ref }, null);
                    } catch (err) {
                        if (manager) manager.error = errorText(err);
                    }
                    renderManager();
                });
                row.append(name, undo);
                body.appendChild(row);
            }
        }
        body.appendChild(el("p", "note", "Blocked players can't whisper you. Ignored players aren't told anything."));
    }

    function openManager() {
        ensureStyle();
        closeManager();
        current();
        const overlay = el("div");
        overlay.id = "nsws-blocks";
        const box = el("div", "box");
        box.tabIndex = -1;
        const top = el("div", "top");
        top.appendChild(el("h1", null, "Blocked and ignored"));
        const body = el("div", "body");
        const bottom = el("div", "bottom");
        bottom.appendChild(button("Back", closeManager));
        box.append(top, body, bottom);
        overlay.appendChild(box);
        overlay.addEventListener("pointerdown", (e) => {
            if (e.target === overlay) closeManager();
        });
        for (const type of ["keydown", "keyup", "keypress"]) overlay.addEventListener(type, (e) => e.stopPropagation());
        document.body.appendChild(overlay);
        box.focus();
        manager = { overlay, body, loading: true, error: null };
        renderManager();
        const mine = manager;
        refresh().catch((err) => {
            if (manager === mine) mine.error = errorText(err);
        }).finally(() => {
            if (manager !== mine) return;
            mine.loading = false;
            renderManager();
        });
    }

    listeners.add(renderManager);

    window.addEventListener("keydown", (e) => {
        if (e.key !== "Escape" && e.code !== "Escape") return;
        if (dialog) {
            e.preventDefault();
            e.stopImmediatePropagation();
            if (!dialog.querySelector("button:disabled")) closeAsk();
        } else if (manager) {
            e.preventDefault();
            e.stopImmediatePropagation();
            closeManager();
        }
    }, true);

    window.__nswsBlocks = {
        relation,
        entryFor,
        heard,
        refresh,
        set,
        ask,
        openManager,
        words: WORDS,
        count() {
            current();
            return list.length;
        },
        onChange(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
    };
})();
