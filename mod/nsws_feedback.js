// Give feedback (main menu): up to 200 words and a few images or videos, sent to the owner through the Worker
// (proxy/src/feedback.js). Race Control's Feedback tab reads them through inbox().
(function () {
    const API = window.__nswsApiBase;
    if (!API || window.__nswsFeedback) return;

    const MAX_WORDS = 200;
    const MAX_FILES = 3;
    const MAX_FILE = 10 * 1024 * 1024 - 1;
    const GAP_MS = 30 * 60_000;
    // Per account (token prefix): when it may send again. The Worker has the real limit; this only shows it.
    const NEXT_KEY = "_nswsFeedbackNext";
    const ACCENT = "#7272c2";

    const CSS = `
#nsws-feedback{position:fixed;inset:0;z-index:9998;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.7);}
#nsws-feedback *{box-sizing:border-box;}
#nsws-feedback>.box{position:relative;display:flex;flex-direction:column;width:min(640px,96vw);max-height:94vh;background:var(--surface-color);color:var(--text-color);clip-path:polygon(0 0,100% 0,calc(100% - 14px) 100%,0 100%);outline:none;}
#nsws-feedback .checker{height:8px;flex-shrink:0;background:repeating-conic-gradient(#fff 0 25%,#112052 0 50%) 0 0/8px 8px;opacity:.85;}
#nsws-feedback .top{display:flex;align-items:center;gap:10px;padding:10px 20px;background:var(--surface-secondary-color);}
#nsws-feedback .top>h1{margin:0 auto 0 0;font-size:32px;font-weight:normal;color:#b3c1ff;text-shadow:0 2px 0 #112052;white-space:nowrap;}
#nsws-feedback .top>.button{margin:0;font-size:20px;padding:6px 14px;}
#nsws-feedback .body{overflow-y:auto;padding:6px 20px 20px;}
#nsws-feedback .intro{margin:12px 0 10px;font-size:16px;line-height:1.35;color:rgba(255,255,255,.75);}
#nsws-feedback textarea{display:block;width:100%;min-height:150px;resize:vertical;padding:10px 12px;border:none;outline:none;background:var(--surface-tertiary-color);color:#fff;font:inherit;font-size:17px;font-style:normal;line-height:1.4;box-shadow:inset 0 -2px 0 rgba(255,255,255,.25);}
#nsws-feedback textarea:focus{box-shadow:inset 0 -2px 0 ${ACCENT};}
#nsws-feedback textarea:disabled{opacity:.5;}
#nsws-feedback .count{margin-top:4px;text-align:right;font-size:14px;color:rgba(255,255,255,.55);font-variant-numeric:tabular-nums;}
#nsws-feedback .count.over{color:#ff6b6b;}
#nsws-feedback .sec{margin:14px 0 4px;padding-bottom:3px;border-bottom:1px solid rgba(255,255,255,.8);font-size:15px;font-style:italic;color:rgba(255,255,255,.65);}
#nsws-feedback .file{display:flex;align-items:center;gap:12px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.1);font-size:16px;}
#nsws-feedback .file>.thumb{flex-shrink:0;width:56px;height:40px;object-fit:cover;background:#000;}
#nsws-feedback .file>.name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
#nsws-feedback .file>.size{flex-shrink:0;color:rgba(255,255,255,.55);font-variant-numeric:tabular-nums;}
#nsws-feedback .file>.button{margin:0;font-size:16px;padding:4px 10px;}
#nsws-feedback .add{display:flex;align-items:center;gap:12px;margin-top:8px;font-size:14px;color:rgba(255,255,255,.55);}
#nsws-feedback .add>.button{margin:0;font-size:17px;padding:6px 14px;}
#nsws-feedback .button:disabled{opacity:.35;pointer-events:none;}
#nsws-feedback .foot{display:flex;align-items:center;gap:10px;padding:12px 20px;border-top:1px solid rgba(255,255,255,.1);}
#nsws-feedback .foot>.note{margin-right:auto;min-width:0;font-size:15px;line-height:1.3;color:rgba(255,255,255,.75);}
#nsws-feedback .foot>.note.bad{color:#ff6b6b;}
#nsws-feedback .foot>.button{margin:0;font-size:20px;padding:7px 18px;}
#nsws-feedback .foot>.button.primary{box-shadow:inset 0 -3px 0 ${ACCENT};}
#nsws-feedback.drag .box{outline:2px dashed ${ACCENT};outline-offset:-6px;}
.nfb-inbox .nfb-item{padding:14px 0;border-bottom:1px solid rgba(255,255,255,.12);}
.nfb-inbox .nfb-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;font-size:15px;color:rgba(255,255,255,.55);}
.nfb-inbox .nfb-head>b{font-weight:normal;font-size:19px;color:#fff;}
.nfb-inbox .nfb-head>.new{font-size:12px;padding:2px 8px;background:${ACCENT};color:#fff;}
.nfb-inbox .nfb-head>.button{margin:0 0 0 auto;font-size:15px;padding:4px 12px;}
.nfb-inbox .nfb-text{margin:8px 0 0;font-size:17px;line-height:1.4;white-space:pre-wrap;overflow-wrap:anywhere;font-style:normal;}
.nfb-inbox .nfb-files{display:flex;flex-wrap:wrap;gap:10px;margin-top:10px;}
.nfb-inbox .nfb-file{display:flex;flex-direction:column;gap:4px;max-width:min(420px,100%);font-size:13px;color:rgba(255,255,255,.55);}
.nfb-inbox .nfb-file img,.nfb-inbox .nfb-file video{display:block;max-width:100%;max-height:300px;background:#000;}
.nfb-inbox .nfb-file img{cursor:zoom-in;}
.nfb-inbox .nfb-file .button{margin:0;font-size:15px;padding:6px 12px;}
.nfb-inbox .nfb-file a{color:#b3c1ff;}
.nfb-inbox .nfb-more{margin-top:14px;font-size:17px;}
`;

    function el(tag, className, text) {
        const e = document.createElement(tag);
        if (className) e.className = className;
        if (text != null) e.textContent = text;
        return e;
    }

    function ensureStyle() {
        if (document.getElementById("nsws-feedback-style")) return;
        const style = el("style");
        style.id = "nsws-feedback-style";
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    const words = (text) => (text.trim().match(/\S+/g) ?? []).length;
    const mb = (n) => (n / 1048576 >= 0.1 ? (n / 1048576).toFixed(1) + " MB" : (n ? Math.max(1, Math.round(n / 1024)) : 0) + " KB");
    const isMedia = (file) => /^(image|video)\//.test(file.type) || /\.(png|jpe?g|gif|webp|avif|heic|mp4|m4v|mov|webm|mkv)$/i.test(file.name);

    function profile() {
        let token = null;
        let nickname = null;
        try {
            token = window.__nswsProfileToken?.() || null;
        } catch {}
        try {
            nickname = window.__getPlayerNickname?.() || null;
        } catch {}
        return { token: /^[0-9a-f]{64}$/.test(token ?? "") ? token : null, nickname };
    }

    function visitor() {
        try {
            return localStorage.getItem("nsws_visitor") || "";
        } catch {
            return "";
        }
    }

    function nextAt(token) {
        try {
            return JSON.parse(localStorage.getItem(NEXT_KEY))?.[token.slice(0, 12)] ?? 0;
        } catch {
            return 0;
        }
    }

    function setNext(token, at) {
        try {
            const all = JSON.parse(localStorage.getItem(NEXT_KEY)) || {};
            for (const [k, v] of Object.entries(all)) if (v <= Date.now()) delete all[k];
            all[token.slice(0, 12)] = at;
            localStorage.setItem(NEXT_KEY, JSON.stringify(all));
        } catch {}
    }

    function waitText(ms) {
        const mins = Math.max(1, Math.ceil(ms / 60_000));
        return `You can send feedback once every 30 minutes. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`;
    }

    let view = null;

    function onKey(e) {
        if (e.key !== "Escape" && e.code !== "Escape") return;
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
    }

    function close() {
        if (!view) return;
        view.xhr?.abort();
        for (const f of view.files) URL.revokeObjectURL(f.url);
        clearInterval(view.timer);
        view.overlay.remove();
        window.removeEventListener("keydown", onKey, true);
        document.removeEventListener("paste", onPaste, true);
        view = null;
    }

    // Why this player can't send right now, or "".
    function blocked() {
        const { token } = profile();
        if (!token) return "Make a profile in the garage first, then send your feedback.";
        if (window.__nswsAccountBan?.of(token)) return "You can't send feedback while you're banned from the chat.";
        const wait = nextAt(token) - Date.now();
        return wait > 0 ? waitText(wait) : "";
    }

    function addFiles(list) {
        if (!view || view.sending || view.done) return;
        for (const file of list) {
            if (view.files.length >= MAX_FILES) {
                view.note = `You can attach up to ${MAX_FILES} files.`;
                break;
            }
            if (!isMedia(file)) {
                view.note = `${file.name || "That file"} isn't an image or a video.`;
                continue;
            }
            if (file.size > MAX_FILE) {
                view.note = `${file.name || "That file"} is ${mb(file.size)}. Each file has to be under 10 MB.`;
                continue;
            }
            if (!file.size) continue;
            view.files.push({ file, url: URL.createObjectURL(file) });
            view.note = "";
        }
        render();
    }

    function onPaste(e) {
        if (!view) return;
        const files = [...(e.clipboardData?.files ?? [])];
        if (!files.length) return;
        e.preventDefault();
        addFiles(files);
    }

    function render() {
        if (!view) return;
        const why = view.done ? "" : blocked();
        const text = view.input.value;
        const count = words(text);
        view.input.disabled = !!why || view.sending || view.done;
        view.count.textContent = count + " / " + MAX_WORDS + " words";
        view.count.classList.toggle("over", count > MAX_WORDS);

        view.list.textContent = "";
        view.files.forEach((f, i) => {
            const row = el("div", "file");
            const thumb = el(f.file.type.startsWith("video/") ? "video" : "img", "thumb");
            thumb.src = f.url;
            if (thumb.tagName === "VIDEO") {
                thumb.muted = true;
                thumb.preload = "metadata";
            }
            const remove = el("button", "button", "Remove");
            remove.disabled = view.sending || view.done;
            remove.addEventListener("click", () => {
                URL.revokeObjectURL(f.url);
                view.files.splice(i, 1);
                render();
            });
            row.append(thumb, el("span", "name", f.file.name || "file"), el("span", "size", mb(f.file.size)), remove);
            view.list.appendChild(row);
        });
        view.addBtn.disabled = !!why || view.sending || view.done || view.files.length >= MAX_FILES;

        const note = view.done ? "Thanks! Your feedback was sent." : view.note || why || (view.sending ? "" : "Only the site owner reads this.");
        view.noteEl.textContent = view.sending ? "Sending\u2026 " + view.progress + "%" : note;
        view.noteEl.classList.toggle("bad", !view.done && !view.sending && !!(view.bad || why || count > MAX_WORDS));
        view.sendBtn.hidden = view.done;
        view.sendBtn.disabled = !!why || view.sending || count > MAX_WORDS || (!text.trim() && !view.files.length);
        view.cancelBtn.textContent = view.done ? "Close" : "Cancel";
    }

    function send() {
        if (!view || view.sending || view.done || blocked()) return;
        const { token, nickname } = profile();
        const text = view.input.value.trim();
        if (words(text) > MAX_WORDS || (!text && !view.files.length)) return;
        const head = new TextEncoder().encode(JSON.stringify({
            token,
            nickname: nickname || "",
            visitor: visitor(),
            text,
            files: view.files.map((f) => ({ name: f.file.name || "file", size: f.file.size })),
        }));
        const length = new Uint8Array(4);
        new DataView(length.buffer).setUint32(0, head.length);
        const payload = new Blob([length, head, ...view.files.map((f) => f.file)], { type: "text/plain" });

        const xhr = new XMLHttpRequest();
        view.xhr = xhr;
        view.sending = true;
        view.progress = 0;
        view.note = "";
        view.bad = false;
        xhr.open("POST", API + "nsws/feedback/send");
        xhr.upload.onprogress = (e) => {
            if (!view || !e.lengthComputable) return;
            view.progress = Math.min(99, Math.floor((e.loaded / e.total) * 100));
            render();
        };
        const finish = (note, bad) => {
            if (!view || view.xhr !== xhr) return;
            view.xhr = null;
            view.sending = false;
            view.note = note;
            view.bad = bad;
            render();
        };
        xhr.onerror = () => finish("Couldn't reach the server. Check your connection and try again.", true);
        xhr.onload = () => {
            let reply = null;
            try {
                reply = JSON.parse(xhr.responseText);
            } catch {}
            if (xhr.status === 200 && reply?.ok) {
                setNext(token, reply.next || Date.now() + GAP_MS);
                if (!view || view.xhr !== xhr) return;
                view.done = true;
                finish("", false);
                return;
            }
            if (xhr.status === 429 && reply?.wait) setNext(token, Date.now() + reply.wait);
            if (reply?.banned && !reply.until) window.__nswsAccountBan?.receive(token, { chat: true, until: null });
            if (reply?.error === "busy") return finish("The server is busy right now. Try again later.", true);
            finish(reply?.error || "Couldn't send that. Try again in a moment.", true);
        };
        xhr.send(payload);
        render();
    }

    function open() {
        if (view) return;
        ensureStyle();
        const overlay = el("div");
        overlay.id = "nsws-feedback";
        const box = el("div", "box");
        box.tabIndex = -1;
        const top = el("div", "top");
        top.appendChild(el("h1", null, "Give feedback"));
        const x = el("button", "button", "\u2715");
        x.setAttribute("aria-label", "Close");
        x.addEventListener("click", close);
        top.appendChild(x);

        const body = el("div", "body");
        body.appendChild(el("p", "intro", "Found a bug, have an idea, or want something changed? Tell the owner here. Up to " + MAX_WORDS + " words, plus up to " + MAX_FILES + " images or videos."));
        const input = el("textarea");
        input.placeholder = "Write your feedback\u2026";
        input.maxLength = 2400;
        input.addEventListener("input", render);
        const count = el("div", "count");
        body.append(input, count, el("div", "sec", "Images and videos"));
        const list = el("div");
        const add = el("div", "add");
        const addBtn = el("button", "button", "Add image or video");
        const picker = el("input");
        picker.type = "file";
        picker.accept = "image/*,video/*";
        picker.multiple = true;
        picker.hidden = true;
        picker.addEventListener("change", () => {
            addFiles([...picker.files]);
            picker.value = "";
        });
        addBtn.addEventListener("click", () => picker.click());
        add.append(addBtn, el("span", null, "Up to " + MAX_FILES + ", each under 10 MB. You can also paste or drop them here."), picker);
        body.append(list, add);

        const foot = el("div", "foot");
        const noteEl = el("div", "note");
        const cancelBtn = el("button", "button", "Cancel");
        cancelBtn.addEventListener("click", close);
        const sendBtn = el("button", "button primary", "Send");
        sendBtn.addEventListener("click", send);
        foot.append(noteEl, cancelBtn, sendBtn);

        box.append(el("div", "checker"), top, body, foot);
        overlay.appendChild(box);
        overlay.addEventListener("pointerdown", (e) => {
            if (e.target === overlay && !view?.sending) close();
        });
        for (const type of ["keydown", "keyup", "keypress"]) overlay.addEventListener(type, (e) => e.stopPropagation());
        overlay.addEventListener("dragover", (e) => {
            if (![...(e.dataTransfer?.types ?? [])].includes("Files")) return;
            e.preventDefault();
            overlay.classList.add("drag");
        });
        overlay.addEventListener("dragleave", (e) => {
            if (e.target === overlay) overlay.classList.remove("drag");
        });
        overlay.addEventListener("drop", (e) => {
            overlay.classList.remove("drag");
            if (!e.dataTransfer?.files?.length) return;
            e.preventDefault();
            addFiles([...e.dataTransfer.files]);
        });
        document.body.appendChild(overlay);
        window.addEventListener("keydown", onKey, true);
        document.addEventListener("paste", onPaste, true);
        view = { overlay, body, foot, input, count, list, addBtn, noteEl, cancelBtn, sendBtn, files: [], note: "", bad: false, sending: false, done: false, progress: 0, xhr: null };
        // The countdown in the note moves on by itself.
        view.timer = setInterval(() => {
            if (view && !view.sending && !view.note) render();
        }, 20_000);
        render();
        if (!input.disabled) input.focus();
        else box.focus();
    }

    // Race Control's Feedback tab. owner = { api, token() } (window.__nswsOwner); onCount(n) gets the unseen count.
    const inboxState = { items: null, more: false, error: null, loading: false, stored: 0, urls: new Map(), armed: null };

    async function ownerPost(owner, path, extra) {
        const token = await owner.token();
        if (!token) throw Object.assign(new Error("not owner"), { status: 403 });
        const response = await fetch(owner.api + "nsws/feedback/" + path, {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: JSON.stringify({ token, ...extra }),
            credentials: "omit",
            cache: "no-store",
        });
        if (!response.ok) {
            let reason = "";
            try {
                reason = String((await response.json())?.error || "");
            } catch {}
            throw Object.assign(new Error("HTTP " + response.status), { status: response.status, reason });
        }
        return response;
    }

    async function unseen(owner) {
        return (await (await ownerPost(owner, "admin/unseen", {})).json()).unseen ?? 0;
    }

    async function load(owner, older) {
        const s = inboxState;
        if (s.loading) return;
        s.loading = true;
        try {
            const before = older && s.items?.length ? s.items[s.items.length - 1].created : undefined;
            const data = await (await ownerPost(owner, "admin/list", { before })).json();
            s.items = older ? [...(s.items ?? []), ...data.items] : data.items;
            s.more = !!data.more;
            s.stored = data.stored ?? 0;
            s.unseen = data.unseen ?? 0;
            s.error = null;
        } catch (err) {
            s.error = err;
        } finally {
            s.loading = false;
        }
    }

    async function fileUrl(owner, f) {
        if (inboxState.urls.has(f.fid)) return inboxState.urls.get(f.fid);
        const blob = await (await ownerPost(owner, "admin/file/" + f.fid, {})).blob();
        const url = URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: f.type }));
        inboxState.urls.set(f.fid, url);
        return url;
    }

    function fileView(owner, f) {
        const wrap = el("div", "nfb-file");
        const label = el("span", null, (f.name || "file") + " \u00b7 " + mb(f.size));
        const show = async (button) => {
            if (button) {
                button.disabled = true;
                button.textContent = "Loading\u2026";
            }
            try {
                const url = await fileUrl(owner, f);
                const media = el(f.type.startsWith("video/") ? "video" : "img");
                media.src = url;
                if (media.tagName === "VIDEO") media.controls = true;
                else media.addEventListener("click", () => window.open(url, "_blank", "noopener"));
                const save = el("a", null, "Save");
                save.href = url;
                save.download = f.name || "feedback";
                wrap.textContent = "";
                const line = el("span");
                line.append(label, document.createTextNode(" \u00b7 "), save);
                wrap.append(media, line);
            } catch (err) {
                if (button) {
                    button.disabled = false;
                    button.textContent = "Couldn't load it. Try again";
                } else {
                    wrap.append(el("span", null, "Couldn't load it."));
                }
            }
        };
        if (f.type.startsWith("video/")) {
            const b = el("button", "button", "Show video");
            b.addEventListener("click", () => show(b));
            wrap.append(b, label);
        } else {
            wrap.append(el("span", null, "Loading\u2026"));
            show(null);
        }
        return wrap;
    }

    function fmtTime(ms) {
        return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    }

    function renderInbox(root, owner, onCount) {
        const s = inboxState;
        root.textContent = "";
        root.classList.add("nfb-inbox");
        ensureStyle();
        if (s.error && !s.items) {
            root.appendChild(el("div", "nrc-empty", s.error.status === 403 ? "This profile isn't the owner, so feedback stays closed." : "Couldn't load feedback. " + (s.error.reason ? s.error.reason + " " : "") + "Press Refresh."));
            return;
        }
        if (!s.items) {
            root.appendChild(el("div", "nrc-empty", "Loading\u2026"));
            return;
        }
        if (!s.items.length) {
            root.appendChild(el("div", "nrc-empty", "No feedback yet. Players send it with Give feedback on the main menu."));
            return;
        }
        const head = el("p", "nrc-sub", "Newest first. Each player can send once every 30 minutes; files take " + mb(s.stored) + " of the 1 GB the box allows. Delete what you're done with.");
        root.appendChild(head);
        for (const item of s.items) {
            const row = el("div", "nfb-item");
            const h = el("div", "nfb-head");
            h.appendChild(el("b", null, item.nickname || "Player"));
            if (!item.seen) h.appendChild(el("span", "new", "NEW"));
            const meta = el("span", null, [fmtTime(item.created), item.client, "account " + item.userId12.slice(0, 8), "address " + item.address].filter(Boolean).join(" \u00b7 "));
            meta.title = "Find the account or address in the Bans tab";
            h.appendChild(meta);
            const del = el("button", "button", s.armed === item.id ? "Really delete?" : "Delete");
            del.addEventListener("click", async () => {
                if (s.armed !== item.id) {
                    s.armed = item.id;
                    renderInbox(root, owner, onCount);
                    return;
                }
                del.disabled = true;
                try {
                    await ownerPost(owner, "admin/delete/" + item.id, {});
                    for (const f of item.files) {
                        const url = s.urls.get(f.fid);
                        if (url) URL.revokeObjectURL(url);
                        s.urls.delete(f.fid);
                    }
                    s.items = s.items.filter((i) => i.id !== item.id);
                    s.stored = Math.max(0, s.stored - item.files.reduce((n, f) => n + f.size, 0));
                } catch (err) {
                    alert(err.reason || "Couldn't delete that. Try again.");
                }
                s.armed = null;
                renderInbox(root, owner, onCount);
            });
            h.appendChild(del);
            row.appendChild(h);
            if (item.text) row.appendChild(el("p", "nfb-text", item.text));
            if (item.files.length) {
                const files = el("div", "nfb-files");
                for (const f of item.files) files.appendChild(fileView(owner, f));
                row.appendChild(files);
            }
            root.appendChild(row);
        }
        if (s.more) {
            const more = el("button", "button nfb-more", s.loading ? "Loading\u2026" : "Load older");
            more.addEventListener("click", async () => {
                more.disabled = true;
                await load(owner, true);
                renderInbox(root, owner, onCount);
            });
            root.appendChild(more);
        }
    }

    window.__nswsFeedback = {
        open,
        close,
        inbox: {
            // Fetches the newest page (which marks it seen) and draws it into root.
            async refresh(root, owner, onCount) {
                for (const url of inboxState.urls.values()) URL.revokeObjectURL(url);
                inboxState.urls.clear();
                inboxState.armed = null;
                await load(owner, false);
                if (!inboxState.error) onCount?.(inboxState.unseen);
                if (root.isConnected) renderInbox(root, owner, onCount);
            },
            render: renderInbox,
            loaded: () => inboxState.items != null,
            unseen,
        },
    };
})();
