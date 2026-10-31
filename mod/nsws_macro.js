// Keyboard macro and auto clicker detection: a 5 minute lockout, shown here and enforced on uploads by the Worker
// (proxy/src/macro.js). A page can't see whether input was injected, so this only judges timing. The limits sit far past
// the most machine-like real runs on the boards (PROXY.md, "Macro lockout"); lowering them will lock out real tap-steerers.
(function () {
    const LOCK_MS = 300000;
    const LOCK_KEY = "_nswsMacroLock";
    // Set to "1" to get a real lockout as the owner or on a local copy.
    const TEST_KEY = "_nswsMacroTest";
    const MAX_GAP_MS = 1000, HISTORY = 60;
    const SPEED_TAPS = 20, SPEED_MS = 40;
    const CLICK_SPEED_TAPS = 60, CLICK_SPEED_MS = 10;
    const TINY_HOLD_MS = 5, TINY_HOLDS = 8;
    // A 125 Hz keyboard snaps a steady finger onto an 8 ms grid, so a lower share than this can catch a person.
    const SAME_TAPS = 30, SAME_MS = 1.5, SAME_SHARE = 0.9;
    const STEADY_TAPS = 40, STEADY_SD_MS = 1.5;
    // One input off for this long is a key repeat sent as a release and press, not a tap.
    const NO_RELEASE_MS = 1;
    const LATE_EVENT_MS = 200, STALL_MS = 250;
    const SCRIPT_KEYS = 8;
    const REPLAY_TOGGLES = 30, REPLAY_MEDIAN_MS = 4, REPLAY_P90_MS = 12, REPLAY_KEPT = 6;
    const DRIVE_BINDS = [0, 1, 2, 3], START_RESET_BIND = 5;
    const REASONS = {
        speed: "pressing a key faster than anyone can tap",
        click: "clicking faster than anyone can click",
        hold: "tapping a key too briefly for a finger",
        metronome: "tapping with machine-perfect timing",
        replay: "repeating an earlier attempt's inputs to the millisecond",
        script: "sending key presses from a script"
    };

    const read = key => {
        try {
            return localStorage.getItem(key);
        } catch (e) {
            return null;
        }
    };
    const write = (key, value) => {
        try {
            null == value ? localStorage.removeItem(key) : localStorage.setItem(key, value);
        } catch (e) {}
    };
    const local = /^(localhost|127\.|\[::1\]|$)/.test(location.hostname);

    const mean = w => w.reduce((a, b) => a + b, 0) / w.length;
    function sameShare(w) {
        let best = 0;
        for (const c of w) {
            let n = 0;
            for (const x of w) Math.abs(x - c) <= SAME_MS && n++;
            best = Math.max(best, n);
        }
        return best / w.length;
    }
    // Trimmed, so one hitch can't hide a metronome.
    function steadySd(w) {
        const cut = Math.floor(w.length / 10), t = [...w].sort((a, b) => a - b).slice(cut, w.length - cut), m = mean(t);
        return Math.sqrt(t.reduce((a, b) => a + (b - m) ** 2, 0) / t.length);
    }

    function judge(s, click) {
        const g = s.gaps, n = g.length;
        if (click) {
            if (n >= CLICK_SPEED_TAPS && mean(g.slice(-CLICK_SPEED_TAPS)) < CLICK_SPEED_MS) return "click";
        } else {
            if (n >= SPEED_TAPS && mean(g.slice(-SPEED_TAPS)) < SPEED_MS) return "speed";
            if (s.tiny >= TINY_HOLDS) return "hold";
        }
        if (n >= SAME_TAPS && sameShare(g.slice(-SAME_TAPS)) >= SAME_SHARE) return "metronome";
        if (n >= STEADY_TAPS && steadySd(g.slice(-STEADY_TAPS)) <= STEADY_SD_MS) return "metronome";
        return null;
    }

    const inputs = new Map();
    const inputOf = id => inputs.get(id) ?? inputs.set(id, { down: false, downAt: 0, upAt: -1e9, pressAt: null, gaps: [], tiny: 0 }).get(id);
    const forget = () => inputs.clear();

    function press(id, at, click) {
        const s = inputOf(id);
        // A pointer's release can be lost outside the window.
        if (s.down && !click) return;
        s.down = true;
        // Stays down as far as the streak goes, so its hold keeps growing.
        if (at - s.upAt <= NO_RELEASE_MS) return;
        s.downAt = at;
        if (null != s.pressAt) {
            const gap = at - s.pressAt;
            if (gap > MAX_GAP_MS) s.gaps = [], s.tiny = 0;
            else s.gaps.push(gap), s.gaps.length > HISTORY && s.gaps.shift();
        }
        s.pressAt = at;
        const reason = judge(s, click);
        reason && flag(reason);
    }
    function release(id, at, click) {
        const s = inputOf(id);
        if (!s.down) return;
        s.down = false;
        s.upAt = at;
        s.tiny = at - s.downAt <= TINY_HOLD_MS ? s.tiny + 1 : 0;
        if (!click && s.tiny >= TINY_HOLDS) flag("hold");
    }

    // Attempts on a track, kept until the page closes. Each is a key's toggle times since the attempt's first toggle.
    const attempts = new Map();
    let attempt = null, wasStarted = false;
    function newAttempt() {
        if (attempt && attempt.count >= REPLAY_TOGGLES && null != attempt.track) {
            const kept = attempts.get(attempt.track) ?? attempts.set(attempt.track, []).get(attempt.track);
            kept.push(attempt);
            kept.length > REPLAY_KEPT && kept.shift();
        }
        attempt = null;
    }
    function matches(a, b) {
        const devs = [];
        for (const [code, times] of a.keys) {
            const other = b.keys.get(code);
            if (!other) continue;
            for (let i = 0, n = Math.min(times.length, other.length); i < n; i++) devs.push(times[i] - other[i]);
        }
        if (devs.length < REPLAY_TOGGLES) return false;
        devs.sort((x, y) => x - y);
        const shift = devs[devs.length >> 1], abs = devs.map(d => Math.abs(d - shift)).sort((x, y) => x - y);
        return abs[abs.length >> 1] <= REPLAY_MEDIAN_MS && abs[Math.floor(abs.length * 0.9)] <= REPLAY_P90_MS;
    }
    function noteToggle(code, at) {
        const state = window.__getPlayerState?.();
        const started = !!state?.hasStarted?.();
        wasStarted && !started && newAttempt();
        wasStarted = started;
        if (!attempt) attempt = { track: window.__getCurrentTrack?.()?.getId?.()?.toString?.() ?? null, t0: at, count: 0, keys: new Map() };
        const times = attempt.keys.get(code) ?? attempt.keys.set(code, []).get(code);
        times.push(at - attempt.t0);
        attempt.count++;
        if (attempt.count >= REPLAY_TOGGLES && attempt.count % 10 === 0) {
            for (const old of attempts.get(attempt.track) ?? []) {
                if (matches(attempt, old)) return flag("replay");
            }
        }
    }

    // ---- The lockout ----

    let until = 0, overlay = null, timeEl = null, tick = 0, controls = null, restarting = false, flagging = false;
    const locked = () => until > Date.now();
    const SHADOWED = ["up", "right", "down", "left", "__rocket"];
    function freeze(c) {
        if (c.__macroFrozen) return;
        c.up = c.right = c.down = c.left = false;
        c.__rocket = 0;
        for (const k of SHADOWED) Object.defineProperty(c, k, { configurable: true, get: () => k === "__rocket" ? 0 : false, set() {} });
        c.__macroFrozen = true;
    }
    function thaw(c) {
        if (!c.__macroFrozen) return;
        for (const k of SHADOWED) delete c[k];
        c.__rocket = 0;
        delete c.__macroFrozen;
    }
    function restartRace() {
        const key = window.__nswsKeyBindings?.settings?.()?.getKeyBindings(START_RESET_BIND)?.find(k => k && !k.includes("+"));
        if (!key || !window.__getPlayerState?.()?.hasStarted?.()) return;
        restarting = true;
        for (const type of ["keydown", "keyup"]) window.dispatchEvent(new KeyboardEvent(type, { code: key, bubbles: true, cancelable: true }));
        restarting = false;
    }
    function clock() {
        const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
        timeEl && (timeEl.textContent = Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0"));
        if (!left) return unlock();
        write(LOCK_KEY, JSON.stringify({ until, seen: Date.now(), reason: overlay?.dataset.reason }));
    }
    function show(reason) {
        if (overlay) return;
        overlay = document.createElement("div");
        overlay.dataset.reason = reason ?? "";
        overlay.setAttribute("role", "alertdialog");
        overlay.setAttribute("aria-modal", "true");
        overlay.style.cssText = "position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;background:rgba(15,20,48,.86);color:var(--text-color,#fff);touch-action:none;";
        const panel = document.createElement("div");
        panel.style.cssText = "width:min(560px,100%);max-height:100%;overflow:auto;box-sizing:border-box;padding:24px 32px 28px;background:var(--surface-color,#28346a);border-top:4px solid #7272c2;text-align:center;box-shadow:0 8px 24px rgba(0,0,0,.4);";
        const title = document.createElement("h2");
        title.textContent = "Macro detected";
        title.style.cssText = "margin:0 0 12px;font-size:32px;font-weight:normal;";
        const text = document.createElement("p");
        text.textContent = "This looks like a keyboard macro or auto clicker: " + (REASONS[reason] ?? "the server flagged your inputs") + ". Turn it off before you come back.";
        text.style.cssText = "margin:0 0 20px;font-size:20px;line-height:1.3;";
        const wait = document.createElement("p");
        wait.textContent = "You can play again in";
        wait.style.cssText = "margin:0;font-size:18px;opacity:.75;";
        timeEl = document.createElement("div");
        timeEl.style.cssText = "font-size:56px;line-height:1.2;font-variant-numeric:tabular-nums;";
        panel.append(title, text, wait, timeEl);
        overlay.appendChild(panel);
        for (const type of ["pointerdown", "pointerup", "click", "contextmenu", "wheel", "touchstart", "touchmove"]) {
            overlay.addEventListener(type, e => e.stopPropagation());
        }
        document.body.appendChild(overlay);
    }
    function lockUntil(at, reason) {
        const had = locked();
        until = Math.max(until, at);
        controls && freeze(controls);
        document.activeElement instanceof HTMLElement && document.activeElement.blur();
        show(reason);
        clock();
        tick || (tick = setInterval(clock, 1000));
        had || restartRace();
    }
    function unlock() {
        until = 0;
        clearInterval(tick);
        tick = 0;
        overlay?.remove();
        overlay = timeEl = null;
        controls && thaw(controls);
        forget();
        write(LOCK_KEY, null);
    }
    function report(reason) {
        const token = window.__nswsProfileToken?.();
        if (!/^[0-9a-f]{64}$/.test(token || "") || !window.__nswsApiBase) return;
        fetch(window.__nswsApiBase + "nsws/macro", {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: JSON.stringify({ userToken: token, reason, nickname: window.__getPlayerNickname?.() ?? "" }),
            credentials: "omit",
            keepalive: true
        }).then(r => r.ok && r.json()).then(d => d?.left > until - Date.now() + 2000 && lockUntil(Date.now() + d.left, reason), () => {});
    }
    async function flag(reason) {
        forget();
        if (flagging || locked()) return;
        flagging = true;
        try {
            const test = read(TEST_KEY) === "1";
            if (!test && (local || await window.__nswsOwner?.token?.())) return void console.warn("Macro check: " + reason + " (no lockout here)");
            lockUntil(Date.now() + LOCK_MS, reason);
            report(reason);
        } finally {
            flagging = false;
        }
    }

    function restore() {
        let saved = null;
        try {
            saved = JSON.parse(read(LOCK_KEY));
        } catch (e) {}
        const now = Date.now();
        if (!Number.isFinite(saved?.until) || !Number.isFinite(saved?.seen)) return until && unlock();
        // A clock moved back doesn't shorten the wait.
        const end = saved.until + Math.max(0, saved.seen - now);
        if (end > now && end - now <= LOCK_MS) lockUntil(end, saved.reason);
        else if (until) unlock();
        else write(LOCK_KEY, null);
    }

    // ---- Input ----

    const typing = e => e.target instanceof Element && e.target.matches("input,textarea,select,[contenteditable],[contenteditable] *");
    function isDriveKey(code) {
        const s = window.__nswsKeyBindings?.settings?.();
        return !!s && DRIVE_BINDS.some(b => s.getKeyBindings(b)?.some(k => k && (k === code || k.endsWith("+" + code))));
    }
    let scripted = 0;
    const atoKey = () => read("_nswsAtoKeyOn") === "true" ? (read("_nswsAtoKey") ?? "Backquote").split("+").pop() : null;
    addEventListener("keydown", e => {
        if (restarting) return;
        if (locked()) {
            if (e.code !== atoKey()) e.stopImmediatePropagation(), e.preventDefault();
            return;
        }
        if (!controls || !e.code || typing(e)) return;
        if (!e.isTrusted) {
            e.repeat || !isDriveKey(e.code) || ++scripted < SCRIPT_KEYS || flag("script");
            return;
        }
        if (e.repeat) return;
        if (performance.now() - e.timeStamp > LATE_EVENT_MS) return void forget();
        noteToggle(e.code, e.timeStamp);
        press("key:" + e.code, e.timeStamp, false);
    }, true);
    addEventListener("keyup", e => {
        if (!e.isTrusted || !e.code || locked()) return;
        if (controls && !typing(e)) noteToggle(e.code, e.timeStamp);
        release("key:" + e.code, e.timeStamp, false);
    }, true);
    addEventListener("pointerdown", e => {
        if (!e.isTrusted || locked() || typing(e)) return;
        if (performance.now() - e.timeStamp > LATE_EVENT_MS) return void forget();
        press("ptr:" + e.pointerType + ":" + e.button, e.timeStamp, true);
    }, true);
    addEventListener("pointerup", e => {
        e.isTrusted && !locked() && release("ptr:" + e.pointerType + ":" + e.button, e.timeStamp, true);
    }, true);
    addEventListener("blur", forget);
    addEventListener("pagehide", forget);
    document.addEventListener("visibilitychange", forget);
    // A freeze delivers everything pressed during it at once, which looks like impossible speed.
    let frameAt = 0;
    (function frame(t) {
        frameAt && t - frameAt > STALL_MS && forget();
        frameAt = t;
        requestAnimationFrame(frame);
    })(0);
    addEventListener("storage", e => (e.key === LOCK_KEY || null == e.key) && restore());

    window.__nswsMacro = {
        controls(c) {
            controls = c;
            scripted = 0;
            newAttempt();
            wasStarted = false;
            forget();
            locked() && freeze(c);
        },
        controlsGone(c) {
            c === controls && (controls = null, newAttempt());
            thaw(c);
        },
        locked,
        // The Worker refused an upload (status 423): its clock decides, so another browser or cleared storage can't dodge it.
        refused(text) {
            let data = null;
            try {
                data = JSON.parse(text);
            } catch (e) {}
            if (read(TEST_KEY) !== "1" && local) return;
            lockUntil(Date.now() + Math.min(LOCK_MS, Math.max(0, Number(data?.left) || LOCK_MS)), data?.reason);
        }
    };
    restore();
})();
