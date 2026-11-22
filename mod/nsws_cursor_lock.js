(() => {
    const TAP_MS = 500;
    const MODIFIER = /^(Control|Alt|Shift|Meta)(Left|Right)$/;

    // "pending": hidden, but the browser hasn't granted the lock yet. It only does after a click or a key that isn't
    // Ctrl, Shift, Alt or Meta, unless the page itself did the last unlock.
    let state = "off", tap = null, swallowClick = false, hint = null;
    const canvas = () => document.getElementById("screen");

    const style = document.createElement("style");
    style.textContent = "html.nsws-cursor-lock,html.nsws-cursor-lock *{cursor:none!important}" +
        ".hint-ui.nsws-cursor-lock-hint{position:fixed;z-index:100000}";
    document.head.appendChild(style);

    function showHint(on) {
        if (!on) {
            hint?.remove();
            hint = null;
            return;
        }
        if (hint) return;
        hint = document.createElement("div");
        hint.className = "hint-ui show nsws-cursor-lock-hint";
        const title = document.createElement("div");
        title.className = "title";
        title.textContent = "Click or press any key to lock the cursor";
        hint.appendChild(title);
        document.body.appendChild(hint);
    }
    function setState(next) {
        state = next;
        document.documentElement.classList.toggle("nsws-cursor-lock", next !== "off");
        if (next !== "pending") showHint(false);
    }
    function refused() {
        if (state === "pending") showHint(true);
    }
    function request() {
        // Older browsers return nothing and only fire pointerlockerror.
        canvas().requestPointerLock()?.catch?.(refused);
    }
    function release() {
        setState("off");
        if (document.pointerLockElement === canvas()) document.exitPointerLock();
    }
    function toggle() {
        if (state !== "off") return release();
        if (!canvas()?.requestPointerLock) return;
        setState("pending");
        request();
    }
    function typing() {
        let el = document.activeElement;
        while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
        return !!el && (el.tagName === "INPUT" && !/^(button|checkbox|radio|range)$/.test(el.type) || el.tagName === "TEXTAREA" || el.isContentEditable);
    }

    addEventListener("keydown", e => {
        if (e.repeat) return;
        tap = null;
        swallowClick = false;
        // The Custom Tracks Editor's frame has a lock of its own.
        if (window.__nswsKeyBindCapturing || window.__nswsEditorCovering) return;
        if (e.code === "Escape") {
            if (state !== "off") release();
            return;
        }
        const modifier = MODIFIER.test(e.code), inText = typing();
        if (window.__nswsKeyBindings?.isCursorLock?.(e)) {
            // A modifier counts on release, so Ctrl+Z, Ctrl+click and holding Ctrl don't toggle.
            if (modifier) {
                if (!inText || state !== "off") tap = { code: e.code, at: e.timeStamp };
                return;
            }
            if (inText) return;
            e.preventDefault();
            toggle();
        } else if (state === "pending" && !modifier) request();
    }, true);
    addEventListener("keyup", e => {
        if (tap?.code !== e.code) return;
        const quick = e.timeStamp - tap.at < TAP_MS;
        tap = null;
        if (quick) toggle();
    }, true);

    addEventListener("pointerdown", e => {
        tap = null;
        swallowClick = state === "pending";
        if (!swallowClick) return;
        // The cursor is hidden, so this click only locks and mustn't press what is under it.
        e.preventDefault();
        e.stopImmediatePropagation();
        request();
    }, true);
    for (const type of ["mousedown", "click", "auxclick", "contextmenu"]) {
        addEventListener(type, e => {
            if (!swallowClick) return;
            e.preventDefault();
            e.stopImmediatePropagation();
        }, true);
    }
    addEventListener("wheel", () => {
        tap = null;
    }, { capture: true, passive: true });
    addEventListener("blur", () => {
        tap = null;
        if (state === "pending") release();
    });

    document.addEventListener("pointerlockerror", refused);
    document.addEventListener("pointerlockchange", () => {
        if (document.pointerLockElement === canvas()) {
            // Granted after it was already switched off again.
            if (state === "off") document.exitPointerLock();
            else setState("locked");
        } else if (state === "locked") setState("off");
    });

    window.__nswsCursorLock = {
        locked: () => state === "locked",
        release
    };
})();
