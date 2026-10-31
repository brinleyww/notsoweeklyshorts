(() => {
    const KEY_ON = "_nswsAtoKeyOn", KEY_BIND = "_nswsAtoKey", LINK = "_nswsAtoLink", LEAVE = "_nswsAtoLeave";
    const DEFAULT_KEY = "Backquote";
    const PRELOAD_DELAY_MS = 1500, RELINK_DELAY_MS = 800, TRY_MS = 3000, RECLAIM_MS = 250;
    // Checked by eye inside this frame's sandbox. Most big sites refuse framing, and the page can't tell when one does.
    const SAMPLES = [
        ["https://en.wikipedia.org/wiki/Photosynthesis", "Photosynthesis - Wikipedia"],
        ["https://www.gutenberg.org/", "Project Gutenberg"],
        ["https://www.desmos.com/calculator", "Desmos | Graphing Calculator"]
    ];
    const sample = SAMPLES[Math.floor(Math.random() * SAMPLES.length)];

    const read = (key, fallback) => {
        try {
            return localStorage.getItem(key) ?? fallback;
        } catch (e) {
            return fallback;
        }
    };
    const write = (key, value) => {
        try {
            localStorage.setItem(key, value);
        } catch (e) {}
    };
    const keyOn = () => read(KEY_ON, "false") === "true";
    const getKey = () => read(KEY_BIND, DEFAULT_KEY);
    const leaves = () => read(LEAVE, "false") === "true";

    function parseLink(raw) {
        const text = raw.trim();
        if (!text) return null;
        try {
            const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : "https://" + text);
            if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.origin === location.origin) return null;
            // An https page can't frame an http one.
            if (location.protocol === "https:" && !leaves()) url.protocol = "https:";
            return url.href;
        } catch (e) {
            return null;
        }
    }
    function target() {
        const url = parseLink(read(LINK, ""));
        return url ? { url, title: new URL(url).hostname.replace(/^www\./, "") } : { url: sample[0], title: sample[1] };
    }

    let frame = null, shown = false, tryTimer = 0, relinkTimer = 0, preconnect = null;
    const makeFrame = url => {
        const f = document.createElement("iframe");
        // No allow-top-navigation: a framed site must not be able to navigate the game away.
        f.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox");
        f.referrerPolicy = "no-referrer";
        f.tabIndex = -1;
        // Not display:none, so the page lays out at full size while it waits.
        f.style.cssText = "position:fixed;inset:0;width:100%;height:100%;border:0;margin:0;background:#fff;color-scheme:light;z-index:2147483647;visibility:hidden";
        f.src = url;
        document.body.appendChild(f);
        return f;
    };
    function dropFrame() {
        frame?.remove();
        frame = null;
    }
    function ensureFrame() {
        const { url } = target();
        if (frame?.dataset.url === url) return;
        dropFrame();
        frame = makeFrame(url);
        frame.dataset.url = url;
        const icon = new Image();
        icon.referrerPolicy = "no-referrer";
        icon.src = new URL("/favicon.ico", url).href;
    }
    // The frame exists only while a key can call it: a whole extra site is too much to load for every player.
    function sync() {
        if (shown) return;
        preconnect?.remove();
        preconnect = null;
        if (!keyOn() || leaves()) {
            dropFrame();
            if (keyOn()) {
                preconnect = document.createElement("link");
                preconnect.rel = "preconnect";
                preconnect.href = new URL(target().url).origin;
                document.head.appendChild(preconnect);
            }
            return;
        }
        ensureFrame();
    }

    const contexts = new Set;
    const hook = name => {
        const Real = window[name];
        if (!Real) return;
        window[name] = new Proxy(Real, {
            construct(cls, args, next) {
                const ctx = Reflect.construct(cls, args, next);
                contexts.add(ctx);
                // Page code may resume on any key or click, which would bring the sound back under the cover.
                ctx.resume = () => shown ? Promise.resolve() : Real.prototype.resume.call(ctx);
                if (shown) ctx.suspend();
                return ctx;
            }
        });
    };
    hook("AudioContext");
    window.webkitAudioContext === undefined || hook("webkitAudioContext");

    let silenced = [];
    function silence() {
        silenced = [];
        for (const ctx of contexts) {
            if (ctx.state !== "running") continue;
            silenced.push(() => ctx.resume());
            ctx.suspend();
        }
        for (const media of document.querySelectorAll("audio, video")) {
            if (media.paused) continue;
            silenced.push(() => media.play().catch(() => {}));
            media.pause();
        }
    }

    let realTitle = "", titleWatch = null, iconLink = null, realIcon = "", realIconType = "";
    function disguise(title, url) {
        realTitle = document.title;
        document.title = title;
        // The chat's unread mark rewrites the title and would give the cover away.
        const el = document.querySelector("title");
        if (el) {
            titleWatch = new MutationObserver(() => {
                if (document.title === title) return;
                realTitle = document.title;
                document.title = title;
            });
            titleWatch.observe(el, { childList: true, characterData: true, subtree: true });
        }
        iconLink = document.querySelector('link[rel="icon"]');
        if (iconLink) {
            realIcon = iconLink.href;
            realIconType = iconLink.type;
            iconLink.removeAttribute("type");
            iconLink.href = new URL("/favicon.ico", url).href;
        }
    }
    function undisguise() {
        titleWatch?.disconnect();
        titleWatch = null;
        document.title = realTitle;
        if (iconLink) {
            iconLink.type = realIconType;
            iconLink.href = realIcon;
        }
    }

    function show() {
        const link = target();
        if (leaves()) {
            location.assign(link.url);
            return;
        }
        if (shown) return;
        ensureFrame();
        frame.style.visibility = "visible";
        shown = true;
        document.activeElement?.blur?.();
        silence();
        disguise(link.title, link.url);
    }
    function hide() {
        clearTimeout(tryTimer);
        if (!shown) return;
        frame.style.visibility = "hidden";
        shown = false;
        undisguise();
        for (const restore of silenced) restore();
        silenced = [];
        sync();
    }

    const typing = () => {
        let el = document.activeElement;
        while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
        return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    };
    // Registered before the game's listeners (this script loads first). Keyups pass so no key sticks after coming back.
    addEventListener("keydown", e => {
        const hit = keyOn() && !window.__nswsKeyBindCapturing && window.__nswsKeyBindingMatches?.(e, getKey());
        if (shown) {
            e.stopImmediatePropagation();
            if (hit && !e.repeat) {
                e.preventDefault();
                hide();
            }
            return;
        }
        if (!hit || e.repeat) return;
        if (typing() && !e.ctrlKey && !e.altKey && !e.metaKey) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        show();
    }, true);

    // Some sites focus themselves on load (Desmos does), even under visibility:hidden or inert:
    // every game key would then go to the invisible page.
    const reclaimFocus = () => {
        if (shown || !frame || document.activeElement !== frame) return;
        frame.blur();
        window.focus();
    };
    // activeElement only becomes the frame after this event, hence the timeout.
    addEventListener("blur", () => setTimeout(reclaimFocus));
    setInterval(reclaimFocus, RECLAIM_MS);

    const startPreload = () => setTimeout(sync, PRELOAD_DELAY_MS);
    document.readyState === "complete" ? startPreload() : addEventListener("load", startPreload, { once: true });

    function styleInput() {
        if (document.getElementById("nsws-ato-style")) return;
        const style = document.createElement("style");
        style.id = "nsws-ato-style";
        style.textContent = ".settings-menu-ui > .container > .setting > .button-wrapper > input.nsws-ato-link{box-sizing:border-box;width:420px;max-width:100%;height:48px;margin-bottom:8px;padding:0 12px;border:0;border-bottom:2px solid transparent;border-radius:0;outline:none;background:var(--button-color);color:var(--text-color);font:inherit;font-size:22px;user-select:text}" +
            ".settings-menu-ui > .container > .setting > .button-wrapper > input.nsws-ato-link:focus{border-bottom-color:var(--text-color)}" +
            ".settings-menu-ui > .container > .setting > .button-wrapper > input.nsws-ato-link.bad{border-bottom-color:#e05a5a}";
        document.head.appendChild(style);
    }
    function row(container, label, keyBinding) {
        const el = document.createElement("div");
        el.className = keyBinding ? "setting key-binding" : "setting";
        const p = document.createElement("p");
        p.textContent = label;
        el.appendChild(p);
        const wrap = document.createElement("div");
        wrap.className = "button-wrapper";
        el.appendChild(wrap);
        container.appendChild(el);
        return wrap;
    }
    function choice(wrap, click, options, get, set) {
        const buttons = options.map(([title, value]) => {
            const b = document.createElement("button");
            b.className = "button";
            b.textContent = title;
            b.addEventListener("click", () => {
                click?.();
                set(value);
                refresh();
            });
            wrap.appendChild(b);
            return [b, value];
        });
        const refresh = () => {
            for (const [b, value] of buttons) b.classList.toggle("selected", value === get());
        };
        refresh();
    }
    function buildSettings(container, click) {
        styleInput();
        let keyButton, tryButton;
        const refreshRows = () => {
            keyButton.disabled = !keyOn();
            tryButton.disabled = leaves();
        };
        choice(row(container, "Tab out key"), click, [["Off", false], ["On", true]], keyOn, on => {
            write(KEY_ON, String(on));
            sync();
            refreshRows();
        });
        const keyWrap = row(container, "Key", true);
        keyButton = document.createElement("button");
        keyButton.className = "button";
        window.__nswsKeyBindings.bind(keyButton, getKey, code => write(KEY_BIND, code));
        keyWrap.appendChild(keyButton);

        const linkWrap = row(container, "Tab out link");
        const input = document.createElement("input");
        input.type = "text";
        input.className = "nsws-ato-link";
        input.spellcheck = false;
        input.placeholder = "Random sample site";
        input.value = read(LINK, "");
        const refreshBad = () => input.classList.toggle("bad", !!input.value.trim() && !parseLink(input.value));
        input.addEventListener("input", () => {
            write(LINK, input.value.trim());
            refreshBad();
            clearTimeout(relinkTimer);
            relinkTimer = setTimeout(sync, RELINK_DELAY_MS);
        });
        refreshBad();
        linkWrap.appendChild(input);

        choice(row(container, "Open the link"), click, [["Preloaded", false], ["Leave the game", true]], leaves, leave => {
            write(LEAVE, String(leave));
            sync();
            refreshRows();
        });
        const tryWrap = row(container, "See it for 3 seconds");
        tryButton = document.createElement("button");
        tryButton.className = "button";
        tryButton.textContent = "Try it";
        tryButton.addEventListener("click", () => {
            click?.();
            clearTimeout(relinkTimer);
            show();
            tryTimer = setTimeout(hide, TRY_MS);
        });
        tryWrap.appendChild(tryButton);
        refreshRows();
        // Only the desktop app (desktop/preload.js) can do this; a web page has no way to.
        if (window.electron?.setCaptureHidden) {
            choice(row(container, "Hide from screen capture"), click, [["Off", false], ["On", true]], window.electron.captureHidden, window.electron.setCaptureHidden);
        }
    }

    window.__nswsAto = {
        // For isKeyBindingInUse: null while the key is off, so it blocks nothing.
        key: () => keyOn() ? getKey() : null,
        settings: buildSettings
    };
})();
