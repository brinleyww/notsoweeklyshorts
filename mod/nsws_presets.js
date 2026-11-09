// Settings presets: 3 named slots per account for the player's own settings, and 3 for presets
// others shared by link (?preset=CODE). Settings > Presets; main.bundle.js hands mount() the screen's
// pending settings, so a loaded preset still needs Apply, like Reset.
(function () {
    const SLOTS = 3;
    const NAME_MAX = 24;
    const CODE = /^[A-Za-z0-9]{8}$/;
    const KEY_TEXT = /^[A-Za-z0-9+]{1,60}$/;
    const BOOLEANS = ["_autoClipOnPersonalBest", "_autoClipOnEveryRun", "_cupAutoSpectate", "_nswsAtoKeyOn", "_nswsAtoLeave"];
    const KEYS = ["_clipKeyBind", "_ghostsKeyBind", "_cupChatKeyBind", "_cupScoreboardKeyBind", "_cupSpectatePrevKeyBind",
        "_cupSpectateNextKeyBind", "_visualFxKeyBind", "_polyfxPanelKeyBind", "_polyfxPhotoKeyBind", "_polyfxScreenshotKeyBind", "_nswsAtoKey"];
    const VISUAL_FX = { dof: 100, motionBlur: 100, chromaticAberration: 100, filmGrain: 100, vignette: 100, saturation: 200 };
    const STORED = [...BOOLEANS, ...KEYS, "_visualFxSettings", "_nswsPadBinds"];
    const POLYFX = ["0", "5", "1", "2", "3", "4"];

    let linkCode = null, linkBad = false;
    try {
        const url = new URL(location.href);
        if (url.searchParams.has("preset")) {
            const code = (url.searchParams.get("preset") || "").trim();
            url.searchParams.delete("preset");
            history.replaceState(history.state, "", url.pathname + url.search + url.hash);
            if (CODE.test(code)) linkCode = code;
            else linkBad = true;
        }
    } catch {}

    const read = (key) => {
        try {
            return localStorage.getItem(key);
        } catch {
            return null;
        }
    };
    const write = (key, value) => {
        try {
            null == value ? localStorage.removeItem(key) : localStorage.setItem(key, value);
        } catch {}
    };
    const token = () => window.__nswsAccounts?.profileToken?.() ?? null;

    async function call(path, body) {
        const accounts = window.__nswsAccounts;
        if (!accounts) throw Object.assign(new Error("Accounts not loaded"), { status: 0 });
        return accounts.call(path, body);
    }

    // { token, data: {own, shared} } of the profile that loaded it.
    let cache = null;
    let loading = null;
    function load(force) {
        const t = token();
        if (!t) return Promise.reject(Object.assign(new Error("No profile"), { status: 0 }));
        if (!force && cache?.token === t) return Promise.resolve(cache.data);
        if (loading?.token === t) return loading.promise;
        const promise = call("presets/list", { userToken: t }).then((data) => {
            cache = { token: t, data };
            return data;
        }).finally(() => {
            if (loading?.promise === promise) loading = null;
        });
        loading = { token: t, promise };
        return promise;
    }
    async function change(path, body) {
        const t = token();
        if (!t) throw Object.assign(new Error("No profile"), { status: 0 });
        const answer = await call(path, { userToken: t, ...body });
        if (answer && Array.isArray(answer.own)) cache = { token: t, data: answer };
        return answer;
    }

    function errorText(err) {
        if (err?.status === 429) return "You've shared a lot of presets in the last hour. Try again later.";
        if (err?.status === 404) return "That preset doesn't exist any more.";
        if (err?.status === 403) return "Presets aren't available right now.";
        return "Couldn't reach the server. Check your connection and try again.";
    }

    // Everything on the Settings screen that the game itself doesn't keep.
    function extrasSnapshot(api) {
        const x = {};
        for (const key of STORED) x[key] = read(key) ?? "";
        const chat = window.__nswsChat;
        x._nswsChatEnabled = String(chat ? chat.isEnabled() : read("_nswsChatEnabled") === "true");
        x._nswsChatFont = chat?.getFont?.() ?? read("_nswsChatFont") ?? "";
        x._nswsChatMedia = chat?.media?.get?.() ?? read("_nswsChatMedia") ?? "";
        const [preset, colorCorrect] = api.polyFx.get();
        x._polyfxGraphicsPreset = preset ?? "";
        x._polyfxColorCorrect = colorCorrect ?? "";
        return x;
    }

    function cleanVisualFx(text) {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== "object") return null;
        const out = {};
        for (const [key, max] of Object.entries(VISUAL_FX)) {
            const v = parsed[key];
            if (typeof v === "number" && Number.isFinite(v)) out[key] = Math.min(max, Math.max(0, v));
        }
        return JSON.stringify(out);
    }
    function cleanPadBinds(text) {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        const out = {};
        for (const [id, pair] of Object.entries(parsed)) {
            if (!/^[A-Za-z]{1,20}$/.test(id) || !Array.isArray(pair) || pair.length !== 2) continue;
            out[id] = pair.map((k) => typeof k === "string" && /^(b\d{1,2}|a[0-3][+-])$/.test(k) ? k : null);
        }
        return JSON.stringify(out);
    }

    // Raw values from before the first preset loaded in this visit to Settings; Cancel puts them back.
    let undo = null;
    function liveRefresh() {
        window.__nswsVisualFxReload?.();
        window.__nswsGamepad?.reload?.();
    }
    function applyExtras(x, api) {
        if (!x || typeof x !== "object") return;
        const chat = window.__nswsChat;
        if (!undo) {
            undo = { stored: {} };
            for (const key of STORED) undo.stored[key] = read(key);
            if (chat) undo.chat = { enabled: chat.isEnabled(), font: chat.getFont?.(), media: chat.media?.get?.() };
        }
        const has = (key) => typeof x[key] === "string";
        for (const key of BOOLEANS)
            if (has(key) && (x[key] === "" || x[key] === "true" || x[key] === "false")) write(key, x[key] || null);
        for (const key of KEYS)
            if (has(key) && (x[key] === "" || KEY_TEXT.test(x[key]))) write(key, x[key] || null);
        for (const [key, clean] of [["_visualFxSettings", cleanVisualFx], ["_nswsPadBinds", cleanPadBinds]]) {
            if (!has(key)) continue;
            try {
                const value = x[key] === "" ? null : clean(x[key]);
                if (value !== undefined) write(key, value);
            } catch {}
        }
        if (chat) {
            if (x._nswsChatEnabled === "true" || x._nswsChatEnabled === "false") {
                const on = x._nswsChatEnabled === "true";
                if (chat.isEnabled() !== on) chat.setEnabled(on);
            }
            if (chat.fonts?.some((f) => f.id === x._nswsChatFont)) chat.setFont(x._nswsChatFont);
            if (chat.media && (x._nswsChatMedia === "show" || x._nswsChatMedia === "click")) chat.media.set(x._nswsChatMedia);
        }
        const preset = x._polyfxGraphicsPreset;
        if (POLYFX.includes(preset) && !(api.polyFx.blocked() && ["2", "3", "4"].includes(preset))) {
            const cc = x._polyfxColorCorrect;
            api.polyFx.set(preset, cc === "true" || cc === "false" ? cc : null);
        }
        liveRefresh();
    }

    function revert() {
        if (!undo) return;
        for (const [key, value] of Object.entries(undo.stored)) write(key, value);
        const chat = window.__nswsChat;
        if (chat && undo.chat) {
            if (chat.isEnabled() !== undo.chat.enabled) chat.setEnabled(undo.chat.enabled);
            if (undo.chat.font) chat.setFont(undo.chat.font);
            if (undo.chat.media) chat.media?.set(undo.chat.media);
        }
        undo = null;
        liveRefresh();
    }

    const CSS = `
.settings-menu-ui > .container > .setting.nsws-preset > p { flex-shrink: 1; }
.settings-menu-ui > .container > .setting.nsws-preset > p.empty { opacity: .55; font-style: italic; }
.settings-menu-ui > .container > .setting.nsws-preset > p > .by { font-size: 20px; opacity: .65; }
.settings-menu-ui > .container > .setting.nsws-preset > .button-wrapper > button { font-size: 21px; padding: 0 14px; }
.settings-menu-ui > .container > .nsws-preset-note { margin: 4px 20px 10px; font-size: 19px; line-height: 1.35; opacity: .7; color: var(--text-color); }
.settings-menu-ui > .container > .nsws-preset-note:empty { display: none; }
.settings-menu-ui > .container > .nsws-preset-status { margin: 0 20px 6px; min-height: 0; font-size: 20px; color: var(--text-color); }
.settings-menu-ui > .container > .nsws-preset-status:empty { display: none; }
.nsws-preset-bg { position: fixed; inset: 0; z-index: 10000; display: flex; align-items: center; justify-content: center; background-color: rgba(20, 20, 30, .5); pointer-events: auto; }
.nsws-preset-box { width: 520px; max-width: 92vw; max-height: 90vh; overflow-y: auto; box-sizing: border-box; display: flex; flex-direction: column; background-color: var(--surface-color); color: var(--text-color); }
.nsws-preset-box > h2 { margin: 0; padding: 12px 20px 4px; font-weight: normal; font-size: 30px; }
.nsws-preset-box > p { margin: 6px 20px; font-size: 19px; line-height: 1.4; white-space: pre-line; }
.nsws-preset-box > input { margin: 8px 20px; padding: 10px 12px; box-sizing: border-box; width: calc(100% - 40px); border: none; outline: none; font-family: inherit; font-size: 22px; background-color: var(--surface-secondary-color); color: var(--text-color); }
.nsws-preset-box > .slots { display: flex; flex-direction: column; gap: 8px; margin: 8px 20px; }
.nsws-preset-box > .slots > .button { margin: 0; width: 100%; text-align: left; font-size: 21px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nsws-preset-box > .buttons { display: flex; justify-content: space-between; gap: 10px; padding: 10px 20px 14px; }
.nsws-preset-box > .buttons > .button { margin: 0; }
`;
    let styled = false;
    function style() {
        if (styled) return;
        styled = true;
        const el = document.createElement("style");
        el.textContent = CSS;
        document.head.appendChild(el);
    }

    function el(tag, className, textContent) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (textContent != null) node.textContent = textContent;
        return node;
    }
    function button(label, onClick, disabled) {
        const b = el("button", "button", label);
        b.disabled = !!disabled;
        b.addEventListener("click", onClick);
        return b;
    }

    // Escape is taken in the capture phase, before the Settings screen's own Escape (which would close Settings).
    let dialog = null;
    function openDialog(build) {
        closeDialog();
        style();
        const bg = el("div", "nsws-preset-bg");
        const box = el("div", "nsws-preset-box");
        bg.appendChild(box);
        const state = { bg, onEscape: null };
        // Keys inside the box reach its own controls, then stop at bg; the game gets none while it's open.
        const onKey = (e) => {
            if (e.type === "keydown" && e.key === "Escape") {
                e.stopPropagation();
                e.preventDefault();
                (state.onEscape || closeDialog)();
            } else if (!bg.contains(e.target)) e.stopPropagation();
        };
        for (const type of ["keydown", "keyup"]) bg.addEventListener(type, (e) => e.stopPropagation());
        state.onKey = onKey;
        window.addEventListener("keydown", onKey, true);
        window.addEventListener("keyup", onKey, true);
        dialog = state;
        build(box, state);
        document.body.appendChild(bg);
        return state;
    }
    function closeDialog() {
        if (!dialog) return;
        window.removeEventListener("keydown", dialog.onKey, true);
        window.removeEventListener("keyup", dialog.onKey, true);
        dialog.bg.remove();
        dialog = null;
    }
    function message(title, text, okLabel, onOk) {
        openDialog((box, state) => {
            if (title) box.appendChild(el("h2", null, title));
            box.appendChild(el("p", null, text));
            const row = el("div", "buttons");
            row.appendChild(el("span"));
            const ok = button(okLabel || "Ok", () => {
                closeDialog();
                onOk?.();
            });
            row.appendChild(ok);
            box.appendChild(row);
            setTimeout(() => ok.focus(), 0);
        });
    }
    function confirmBox(title, text, confirmLabel, onConfirm) {
        openDialog((box) => {
            box.appendChild(el("h2", null, title));
            if (text) box.appendChild(el("p", null, text));
            const row = el("div", "buttons");
            row.appendChild(button("Cancel", closeDialog));
            row.appendChild(button(confirmLabel, () => {
                closeDialog();
                onConfirm();
            }));
            box.appendChild(row);
        });
    }
    function nameBox(title, text, initial, confirmLabel, onName) {
        openDialog((box) => {
            box.appendChild(el("h2", null, title));
            if (text) box.appendChild(el("p", null, text));
            const input = el("input");
            input.maxLength = NAME_MAX;
            input.value = initial;
            input.spellcheck = false;
            box.appendChild(input);
            const row = el("div", "buttons");
            const ok = button(confirmLabel, () => {
                const name = input.value.replace(/\s+/g, " ").trim();
                if (!name) return input.focus();
                closeDialog();
                onName(name);
            });
            input.addEventListener("keydown", (e) => {
                if (e.key === "Enter") ok.click();
            });
            row.appendChild(button("Cancel", closeDialog));
            row.appendChild(ok);
            box.appendChild(row);
            setTimeout(() => {
                input.focus();
                input.select();
            }, 0);
        });
    }
    function copyText(text) {
        if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(() => true, () => false);
        return Promise.resolve(false);
    }
    function linkBox(name, link) {
        openDialog((box) => {
            box.appendChild(el("h2", null, "Share preset"));
            box.appendChild(el("p", null, "Anyone who opens this link can save \u201c" + name + "\u201d into one of their shared presets."));
            const input = el("input");
            input.readOnly = true;
            input.value = link;
            input.addEventListener("focus", () => input.select());
            box.appendChild(input);
            const row = el("div", "buttons");
            row.appendChild(button("Done", closeDialog));
            const copy = button("Copy link", () => {
                copyText(link).then((ok) => {
                    if (!ok) {
                        input.focus();
                        input.select();
                        try {
                            document.execCommand("copy");
                        } catch {}
                    }
                    copy.textContent = "Copied!";
                    setTimeout(() => copy.isConnected && (copy.textContent = "Copy link"), 1500);
                });
            });
            row.appendChild(copy);
            box.appendChild(row);
            setTimeout(() => copy.click(), 0);
        });
    }

    function shareLink(code) {
        return (window.__nswsShareBase || location.origin + location.pathname) + "?preset=" + code;
    }

    // The Settings screen being shown: its container, the rows this mod put in it, and the screen's api.
    let screen = null;
    let lastContainer = null;

    function mount(container, api) {
        style();
        const status = screen?.container === container ? screen.statusText : "";
        screen = { container, api, rows: [], statusText: status };
        const h2 = el("h2", null, "Presets");
        container.appendChild(h2);
        screen.note = el("p", "nsws-preset-note", "Save your settings to your account and load them on any device. Share one as a link; presets shared with you go in the slots below yours.");
        container.appendChild(screen.note);
        screen.status = el("p", "nsws-preset-status", status);
        container.appendChild(screen.status);
        container.appendChild(el("h3", null, "My presets"));
        for (let slot = 0; slot < SLOTS; slot++) screen.rows.push(rowPlaceholder(container));
        container.appendChild(el("h3", null, "Shared with me"));
        for (let slot = 0; slot < SLOTS; slot++) screen.rows.push(rowPlaceholder(container));
        const mine = screen;
        render();
        // A rebuild of the same screen (Reset, a loaded preset) keeps the list; a new visit re-reads it.
        const fresh = container !== lastContainer;
        lastContainer = container;
        load(fresh).then(() => mine === screen && render(), (err) => {
            if (mine !== screen) return;
            setStatus(errorText(err));
            render(true);
        });
    }
    function rowPlaceholder(container) {
        const row = el("div", "setting nsws-preset");
        container.appendChild(row);
        return row;
    }
    function setStatus(text) {
        if (!screen) return;
        screen.statusText = text || "";
        screen.status.textContent = screen.statusText;
    }

    function render(failed) {
        if (!screen) return;
        const data = cache?.token === token() ? cache.data : null;
        screen.rows = screen.rows.map((old, i) => {
            const kind = i < SLOTS ? 0 : 1, slot = i % SLOTS;
            const preset = data ? (kind === 0 ? data.own : data.shared)?.[slot] ?? null : undefined;
            const row = buildRow(kind, slot, preset, failed);
            old.replaceWith(row);
            return row;
        });
    }

    function buildRow(kind, slot, preset, failed) {
        const row = el("div", "setting nsws-preset");
        const label = el("p");
        const wrap = el("div", "button-wrapper");
        row.append(label, wrap);
        if (preset === undefined) {
            label.className = "empty";
            label.textContent = failed ? "Not available" : "Loading\u2026";
        } else if (!preset) {
            label.className = "empty";
            label.textContent = kind === 0 ? "Empty slot " + (slot + 1) : "Empty";
        } else {
            label.textContent = preset.name;
            label.title = preset.name;
            if (kind === 1 && preset.author) {
                label.appendChild(document.createTextNode(" "));
                label.appendChild(el("span", "by", "by " + preset.author));
                label.title = preset.name + " by " + preset.author;
            }
        }
        const off = !preset;
        wrap.appendChild(button("Load", () => loadPreset(kind, slot), off));
        if (kind === 0) wrap.appendChild(button("Save", () => savePreset(slot), preset === undefined));
        wrap.appendChild(button("Rename", () => renamePreset(kind, slot), off));
        wrap.appendChild(button("Share", () => sharePreset(kind, slot), off));
        wrap.appendChild(button("Delete", () => deletePreset(kind, slot), off));
        return row;
    }

    function presetAt(kind, slot) {
        const data = cache?.token === token() ? cache.data : null;
        return data ? (kind === 0 ? data.own : data.shared)?.[slot] ?? null : null;
    }

    function busy(text, work) {
        const mine = screen;
        setStatus(text);
        return work().then((answer) => {
            if (mine === screen) render();
            return answer;
        }, (err) => {
            if (mine === screen) setStatus(errorText(err));
            else message(null, errorText(err));
            return null;
        });
    }

    function loadPreset(kind, slot) {
        const preset = presetAt(kind, slot);
        if (!screen || !preset) return;
        screen.api.click();
        applyExtras(preset.data?.x, screen.api);
        const skipped = screen.api.apply(preset.data).length;
        setStatus("Loaded \u201c" + preset.name + "\u201d. Press Apply to keep it." + (skipped === 1 ? " One setting isn't available on this device, so it was left as it is."
            : skipped ? " " + skipped + " settings aren't available on this device, so they were left as they are." : ""));
    }

    function savePreset(slot) {
        if (!screen) return;
        screen.api.click();
        const existing = presetAt(0, slot);
        const data = { ...screen.api.snapshot(), x: extrasSnapshot(screen.api) };
        nameBox("Save preset", existing ? "This replaces \u201c" + existing.name + "\u201d with the settings you have now." : "Saves the settings you have now, including key bindings, to slot " + (slot + 1) + ".",
            existing ? existing.name : "Preset " + (slot + 1), "Save", (name) => {
                busy("Saving\u2026", () => change("presets/save", { slot, name, data })).then((answer) => answer && setStatus("Saved \u201c" + (answer.own?.[slot]?.name ?? name) + "\u201d."));
            });
    }

    function renamePreset(kind, slot) {
        const preset = presetAt(kind, slot);
        if (!screen || !preset) return;
        screen.api.click();
        nameBox("Rename preset", null, preset.name, "Rename", (name) => {
            busy("Saving\u2026", () => change("presets/rename", { kind, slot, name })).then((answer) => answer && setStatus(""));
        });
    }

    function deletePreset(kind, slot) {
        const preset = presetAt(kind, slot);
        if (!screen || !preset) return;
        screen.api.click();
        confirmBox("Delete preset", "Delete \u201c" + preset.name + "\u201d? Links you already shared keep working.", "Delete", () => {
            busy("Deleting\u2026", () => change("presets/delete", { kind, slot })).then((answer) => answer && setStatus("Deleted \u201c" + preset.name + "\u201d."));
        });
    }

    function sharePreset(kind, slot) {
        const preset = presetAt(kind, slot);
        if (!screen || !preset) return;
        screen.api.click();
        busy("Making a link\u2026", () => change("presets/share", { kind, slot })).then((answer) => {
            if (!answer?.code) return;
            setStatus("");
            linkBox(preset.name, shareLink(answer.code));
        });
    }

    // A ?preset= link: show what it is and let the player pick a shared slot for it.
    async function receive(code) {
        let shared, list;
        try {
            [shared, list] = await Promise.all([call("presets/get", { code }), load(true)]);
        } catch (err) {
            message("Settings preset", err?.status === 404 ? "That preset link doesn't work any more. Ask for a new one." : errorText(err));
            return;
        }
        const pick = (slot) => {
            const box = dialog;
            box?.bg.querySelectorAll("button").forEach((b) => (b.disabled = true));
            change("presets/accept", { code, slot }).then(() => {
                message("Preset saved", "\u201c" + shared.name + "\u201d is in shared preset " + (slot + 1) + ".\nLoad it from Settings \u2192 Presets, then press Apply.");
            }, (err) => {
                message("Settings preset", errorText(err));
            });
        };
        openDialog((box) => {
            box.appendChild(el("h2", null, "Settings preset"));
            box.appendChild(el("p", null, shared.author + " shared the preset \u201c" + shared.name + "\u201d with you. Pick a shared preset slot to keep it in:"));
            const slots = el("div", "slots");
            for (let slot = 0; slot < SLOTS; slot++) {
                const current = list.shared?.[slot];
                slots.appendChild(button((slot + 1) + ": " + (current ? current.name + " (replace)" : "Empty"), () => pick(slot)));
            }
            box.appendChild(slots);
            const row = el("div", "buttons");
            row.appendChild(button("Cancel", closeDialog));
            box.appendChild(row);
        });
    }

    window.__nswsPresets = {
        mount,
        revert,
        commit() {
            undo = null;
        },
        closed() {
            screen = null;
            closeDialog();
        },
        dialogOpen: () => !!dialog,
    };

    // Called when the menu first appears; true when it showed something.
    window.__nswsPresetsOnLoad = () => {
        if (linkBad) {
            linkBad = false;
            setTimeout(() => message("Settings preset", "That preset link isn't valid. Ask for a new one."), 300);
            return true;
        }
        if (!linkCode) return false;
        const code = linkCode;
        linkCode = null;
        setTimeout(() => receive(code), 300);
        return true;
    };
})();
