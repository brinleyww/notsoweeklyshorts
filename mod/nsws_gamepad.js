// Controller support (Gamepad API, standard layout, Xbox names). Driving goes straight into the race's controls;
// respawn, restart, pause and the camera press a key they are bound to; Rocket League moves join that mod's inputs.
(function () {
    if (!navigator.getGamepads) return;
    const STEER = 0.35, PITCH = 0.5, TRIGGER = 0.25;
    const A = 0, B = 1, X = 2, Y = 3, LB = 4, RB = 5, LT = 6, RT = 7, VIEW = 8, MENU = 9, R3 = 11, DPAD_LEFT = 14, DPAD_RIGHT = 15;
    // [button, KeyBind]: checkpoint reset, start reset, cockpit camera, pause.
    const KEY_ACTIONS = [[Y, 4], [VIEW, 5], [R3, 6], [MENU, 8]];
    const NAMES = { jump: "A", boost: "B", roll: "X", rollLeft: "LB", rollRight: "RB", pitchDown: "left stick up", pitchUp: "left stick down" };
    const DRIVE_NAMES = ["RT", "right on the left stick", "LT", "left on the left stick"];

    let controls = null;
    let wrote = {};
    let down = new Set();
    let keyCodes = new Map();
    let padAt = 0, otherAt = 0;
    let running = false;

    const firstPad = () => [...navigator.getGamepads()].find(p => p && p.connected) ?? null;

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
        const btn = i => !!pad.buttons[i] && (pad.buttons[i].pressed || pad.buttons[i].value > TRIGGER);
        const lx = pad.axes[0] ?? 0, ly = pad.axes[1] ?? 0;
        (pad.buttons.some(b => b.pressed) || Math.abs(lx) > 0.5 || Math.abs(ly) > 0.5) && (padAt = performance.now());
        drive({ up: btn(RT), right: lx > STEER || btn(DPAD_RIGHT), down: btn(LT), left: lx < -STEER || btn(DPAD_LEFT) });
        for (const [b, bind] of KEY_ACTIONS) {
            if (btn(b) === down.has(b)) continue;
            if (btn(b)) {
                const code = keyFor(bind);
                down.add(b);
                code && (keyCodes.set(b, code), key("keydown", code));
            } else {
                down.delete(b);
                keyCodes.has(b) && (key("keyup", keyCodes.get(b)), keyCodes.delete(b));
            }
        }
        const rl = new Set();
        btn(A) && rl.add("jump");
        btn(B) && rl.add("boost");
        btn(X) && rl.add("roll");
        btn(LB) && rl.add("rollLeft");
        btn(RB) && rl.add("rollRight");
        ly < -PITCH && rl.add("pitchDown");
        ly > PITCH && rl.add("pitchUp");
        window.__nswsRocket?.pad?.(rl);
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
        // The controller was used more recently than the keyboard, mouse or touch: hints name its buttons.
        recent: () => padAt > otherAt,
        names: NAMES,
        driveNames: DRIVE_NAMES
    };
})();
