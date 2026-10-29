// Controller support (Gamepad API, standard layout, Xbox names). Driving goes straight into the race's controls;
// respawn, restart, pause and the camera press a key they are bound to; Rocket League moves join that mod's inputs.
// Every action takes two controller inputs, rebound in Settings > Controller.
(function () {
    if (!navigator.getGamepads) return;
    const TRIGGER = 0.25, PICK = 0.6;
    const BINDS_KEY = "_nswsPadBinds";
    // An input is "b<button>" or "a<axis><+|->"; across = sideways axes (0, 2), which steer from a lighter push.
    const BUTTONS = ["A", "B", "X", "Y", "LB", "RB", "LT", "RT", "View", "Menu", "Left stick press", "Right stick press", "D-pad up", "D-pad down", "D-pad left", "D-pad right", "Home"];
    const AXES = { "a0-": "Left stick left", "a0+": "Left stick right", "a1-": "Left stick up", "a1+": "Left stick down", "a2-": "Right stick left", "a2+": "Right stick right", "a3-": "Right stick up", "a3+": "Right stick down" };
    const across = i => i % 2 === 0;
    // [id, label, defaults]. kind: drive (the race's controls), key (a KeyBind's key), rocket (Rocket League move).
    const ACTIONS = [
        ["up", "Accelerate", ["b7", null], "drive"],
        ["down", "Brake", ["b6", null], "drive"],
        ["left", "Turn left", ["a0-", "b14"], "drive"],
        ["right", "Turn right", ["a0+", "b15"], "drive"],
        ["reset", "Checkpoint reset", ["b3", null], "key", 4],
        ["restart", "Start reset", ["b8", null], "key", 5],
        ["camera", "Cockpit camera", ["b11", null], "key", 6],
        ["pause", "Pause", ["b9", null], "key", 8],
        ["jump", "Jump", ["b0", null], "rocket"],
        ["boost", "Boost", ["b1", null], "rocket"],
        ["roll", "Air roll", ["b2", null], "rocket"],
        ["rollLeft", "Air roll left", ["b4", null], "rocket"],
        ["rollRight", "Air roll right", ["b5", null], "rocket"],
        ["pitchDown", "Tilt nose down", ["a1-", null], "rocket"],
        ["pitchUp", "Tilt nose up", ["a1+", null], "rocket"]
    ];

    const read = (key, fallback) => {
        try {
            return localStorage.getItem(key) ?? fallback;
        } catch (e) {
            return fallback;
        }
    };
    const valid = v => "string" == typeof v && (/^b\d+$/.test(v) || v in AXES);
    function loadBinds() {
        let saved = {};
        try {
            saved = JSON.parse(read(BINDS_KEY, "{}")) || {};
        } catch (e) {}
        const out = {};
        for (const [id, , def] of ACTIONS) {
            const v = saved[id];
            out[id] = Array.isArray(v) && 2 === v.length ? v.map(k => valid(k) ? k : null) : def.slice();
        }
        return out;
    }
    let binds = loadBinds();
    function saveBinds() {
        try {
            localStorage.setItem(BINDS_KEY, JSON.stringify(binds));
        } catch (e) {}
    }
    const inputName = k => !k ? "" : k[0] === "b" ? BUTTONS[+k.slice(1)] ?? "Button " + k.slice(1) : AXES[k];

    let controls = null;
    let wrote = {};
    let down = new Set();
    let keyCodes = new Map();
    let padAt = 0, otherAt = 0;
    let running = false;
    // Rebinding: the next input pressed goes to capture; inputs held when it started (or just bound) wait for release.
    let capture = null;
    let ignored = new Set();

    const firstPad = () => [...navigator.getGamepads()].find(p => p && p.connected) ?? null;
    function held(pad, k) {
        if (k[0] === "b") {
            const b = pad.buttons[+k.slice(1)];
            return !!b && (b.pressed || b.value > TRIGGER);
        }
        const i = +k[1], v = (pad.axes[i] ?? 0) * (k[2] === "-" ? -1 : 1);
        return v > (across(i) ? 0.35 : 0.5);
    }
    function allHeld(pad, at) {
        const out = [];
        pad.buttons.forEach((b, i) => (b.pressed || b.value > at) && out.push("b" + i));
        pad.axes.forEach((v, i) => Math.abs(v) > at && out.push("a" + i + (v < 0 ? "-" : "+")));
        return out;
    }

    // A key bound to the action that no Rocket League move uses, so pressing it does only that.
    function keyFor(bind) {
        const s = window.__nswsKeyBindings?.settings();
        const rocket = new Set(window.__nswsRocket?.allKeys?.() ?? []);
        const list = (s?.getKeyBindings(bind) ?? []).filter(k => k && !k.includes("+") && !rocket.has(k));
        return list[0] ?? null;
    }
    function key(type, code) {
        window.dispatchEvent(new KeyboardEvent(type, { code, key: code.replace(/^Key/, "").toLowerCase(), bubbles: true, cancelable: true }));
    }

    function drive(state) {
        for (const k of ["up", "right", "down", "left"]) {
            if (wrote[k] === state[k]) continue;
            wrote[k] = state[k];
            controls && (controls[k] = state[k]);
        }
    }

    function poll() {
        const pad = firstPad();
        if (!pad) {
            running = false;
            release();
            return;
        }
        const now = allHeld(pad, 0.5);
        now.length && (padAt = performance.now());
        for (const k of ignored) now.includes(k) || allHeld(pad, 0.3).includes(k) || ignored.delete(k);
        if (capture) {
            const pick = allHeld(pad, PICK).find(k => !ignored.has(k));
            pick ? (ignored.add(pick), capture(pick)) : release();
            return void requestAnimationFrame(poll);
        }
        const on = id => binds[id].some(k => k && !ignored.has(k) && held(pad, k));
        drive({ up: on("up"), right: on("right"), down: on("down"), left: on("left") });
        for (const [id, , , kind, bind] of ACTIONS) {
            if (kind !== "key" || on(id) === down.has(id)) continue;
            if (on(id)) {
                const code = keyFor(bind);
                down.add(id);
                code && (keyCodes.set(id, code), key("keydown", code));
            } else {
                down.delete(id);
                keyCodes.has(id) && (key("keyup", keyCodes.get(id)), keyCodes.delete(id));
            }
        }
        window.__nswsRocket?.pad?.(new Set(ACTIONS.filter(([id, , , kind]) => kind === "rocket" && on(id)).map(a => a[0])));
        requestAnimationFrame(poll);
    }
    function release() {
        drive({ up: false, right: false, down: false, left: false });
        for (const [, code] of keyCodes) key("keyup", code);
        keyCodes.clear();
        down.clear();
        window.__nswsRocket?.pad?.(new Set());
    }
    function start() {
        running || !firstPad() || (running = true, requestAnimationFrame(poll));
    }

    addEventListener("gamepadconnected", start);
    for (const type of ["keydown", "mousedown", "touchstart"]) addEventListener(type, e => e.isTrusted && (otherAt = performance.now()), true);
    start();

    // ---- Settings > Controller -------------------------------------------------------------------------

    let recording = null;
    function recordSlot(button, labelEl, label, id, slot) {
        recording?.cancel();
        const pad = firstPad();
        for (const k of pad ? allHeld(pad, 0.3) : []) ignored.add(k);
        button.textContent = "Press a controller button";
        labelEl.textContent = pad ? "Esc cancels, Backspace clears" : "Connect a controller and press a button (Esc cancels)";
        const end = input => {
            removeEventListener("keydown", onKey, true);
            capture = null;
            recording = null;
            undefined !== input && (binds[id][slot] = input, saveBinds());
            button.textContent = inputName(binds[id][slot]);
            labelEl.textContent = label;
        };
        const onKey = e => {
            if ("Escape" === e.code) e.preventDefault(), e.stopImmediatePropagation(), end(undefined);
            else if ("Backspace" === e.code) e.preventDefault(), e.stopImmediatePropagation(), end(null);
        };
        addEventListener("keydown", onKey, true);
        capture = end;
        recording = { cancel: () => end(undefined) };
        start();
    }
    function buildSettings(container, click) {
        const h3 = document.createElement("h3");
        h3.textContent = "Controller";
        container.appendChild(h3);
        const rows = [];
        for (const [id, label, , kind] of ACTIONS) {
            const row = document.createElement("div");
            row.className = "setting key-binding";
            const p = document.createElement("p");
            p.textContent = kind === "rocket" ? label + " (week 11)" : label;
            row.appendChild(p);
            const wrap = document.createElement("div");
            wrap.className = "button-wrapper";
            for (let slot = 0; slot < 2; slot++) {
                const b = document.createElement("button");
                b.className = "button";
                b.textContent = inputName(binds[id][slot]);
                b.addEventListener("click", () => {
                    click?.();
                    recordSlot(b, p, p.textContent, id, slot);
                });
                wrap.appendChild(b);
                rows.push(() => b.textContent = inputName(binds[id][slot]));
            }
            row.appendChild(wrap);
            container.appendChild(row);
        }
        const row = document.createElement("div");
        row.className = "setting";
        const p = document.createElement("p");
        p.textContent = "Controller buttons";
        row.appendChild(p);
        const wrap = document.createElement("div");
        wrap.className = "button-wrapper";
        const b = document.createElement("button");
        b.className = "button";
        b.textContent = "Reset to default";
        b.addEventListener("click", () => {
            click?.();
            recording?.cancel();
            binds = Object.fromEntries(ACTIONS.map(([id, , def]) => [id, def.slice()]));
            saveBinds();
            for (const r of rows) r();
        });
        wrap.appendChild(b);
        row.appendChild(wrap);
        container.appendChild(row);
    }

    const nameOf = id => inputName(binds[id].find(Boolean)) || "(not bound)";
    window.__nswsGamepad = {
        // A race's controls (main.bundle.js); what the controller holds is written into the new one.
        controls(c) {
            controls = c;
            wrote = {};
            start();
        },
        controlsGone(c) {
            c === controls && (controls = null);
        },
        // The controller was used more recently than the keyboard, mouse or touch: hints name its inputs.
        recent: () => padAt > otherAt,
        get names() {
            return Object.fromEntries(ACTIONS.filter(a => a[3] === "rocket").map(([id]) => [id, nameOf(id)]));
        },
        get driveNames() {
            return ["up", "right", "down", "left"].map(nameOf);
        },
        settings: buildSettings
    };
})();
