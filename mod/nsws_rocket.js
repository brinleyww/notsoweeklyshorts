// Rocket League mode (week 11). The physics is in simulation_worker.bundle.js (__rocketStep), which also
// decides which tracks have it; this is the page side: the keys (keyboard, mouse buttons, touch), the boost
// meter, the effects and sounds, the first-time tutorial and the Settings section.
(function () {
    const BIT = { jump: 1, boost: 2, roll: 4, rollLeft: 8, rollRight: 16, pitchDown: 32, pitchUp: 64 };
    const ACTIONS = [
        ["jump", "Jump", ["Space", "Mouse2"]],
        ["boost", "Boost", ["Mouse0", "KeyF"]],
        ["roll", "Air roll (steer to roll)", ["ShiftLeft", null]],
        ["rollLeft", "Air roll left", ["KeyQ", null]],
        ["rollRight", "Air roll right", ["KeyE", null]],
        ["pitchDown", "Tilt nose down", [null, null]],
        ["pitchUp", "Tilt nose up", ["KeyX", null]],
    ];
    const KEYS_KEY = "_nswsRocketKeys";
    const FX_KEY = "_nswsRocketFx";
    const PITCH_KEY = "_nswsRocketPitch";
    const SOUND_KEY = "_nswsRocketSound";
    const TUTORIAL_KEY = "_nswsRocketTutorial";
    // Status bits the worker reports (U8[n + 230]).
    const ON_GROUND = 1, CAN_FIRST = 2, CAN_SECOND = 4, BOOSTING = 8, FLIPPING = 16, WALL_LIFT = 64;
    // Accelerate, turn right, brake, turn left, checkpoint reset, restart: never swallowed even if also bound here.
    const DRIVING_BINDS = [0, 1, 2, 3, 4, 5];
    const MOUSE_NAMES = ["Left click", "Middle click", "Right click", "Mouse back", "Mouse forward"];
    // The car hull in its own frame (from the physics): centre and half extents, +z is the front.
    const HULL = { y: 0.616, z: -0.153, hx: 0.773, hy: 0.382, hz: 1.843 };
    const EXHAUST = [0, 0.5, HULL.z - HULL.hz - 0.05];
    const WHEELS = [[0.74, 0.08, 1.28], [-0.74, 0.08, 1.28], [0.74, 0.08, -1.36], [-0.74, 0.08, -1.36]];

    const read = (key, fallback) => {
        try {
            return localStorage.getItem(key) ?? fallback;
        } catch (e) {
            return fallback;
        }
    };
    const write = (key, value) => {
        try {
            null == value ? localStorage.removeItem(key) : localStorage.setItem(key, value);
        } catch (e) {}
    };

    function loadKeys() {
        let saved = {};
        try {
            saved = JSON.parse(read(KEYS_KEY, "{}")) || {};
        } catch (e) {}
        const out = {};
        for (const [id, , def] of ACTIONS) {
            const v = saved[id];
            out[id] = Array.isArray(v) && 2 === v.length ? v.map(k => "string" == typeof k && k ? k : null) : def.slice();
        }
        return out;
    }
    let keys = loadKeys();
    const saveKeys = () => write(KEYS_KEY, JSON.stringify(keys));
    const fxSetting = () => read(FX_KEY, "auto");
    // "tm": W pressed again in the air tilts the nose down (held through the takeoff it doesn't, as in normal
    // PolyTrack), S is Trackmania's air brake (the physics stops the spin when Brake is held without the nose-up
    // bit). "rl": W/S both tilt, as on keyboard in Rocket League. "again": both tilt once pressed again in the air.
    const pitchSetting = () => {
        const v = read(PITCH_KEY, "tm");
        return { always: "rl", tilt: "rl", slow: "tm" }[v] ?? v;
    };
    const soundOn = () => "off" !== read(SOUND_KEY, "on");
    // Auto follows Low performance mode, which the Low End device preset turns on.
    function fxQuality() {
        const q = fxSetting();
        if ("auto" !== q) return q;
        return window.__nswsSettingBoolean?.("LowPerformanceMode") ? "low" : "high";
    }

    function keyName(binding) {
        if (!binding) return "";
        if (binding.startsWith("Mouse")) return MOUSE_NAMES[+binding.slice(5)] ?? "Mouse " + binding.slice(5);
        const format = window.__nswsKeyBindings?.format;
        return format ? format(binding) : binding;
    }
    // "Space or Right click", for the tutorial and hints.
    function keysText(id) {
        if (touch.on()) return { jump: "JUMP", boost: "BOOST", roll: "ROLL", pitchUp: "NOSE UP" }[id] ?? "?";
        if (window.__nswsGamepad?.recent()) return window.__nswsGamepad.names[id] ?? "?";
        const names = keys[id].filter(Boolean).map(keyName);
        return names.length ? names.join(" or ") : "(not bound)";
    }
    const cap = t => t.charAt(0).toUpperCase() + t.slice(1);
    function gameKeysText(bind) {
        if (touch.on()) return ["the up arrow", "right", "the down arrow", "left"][bind] ?? "?";
        if (window.__nswsGamepad?.recent()) return window.__nswsGamepad.driveNames[bind] ?? "?";
        const s = window.__nswsKeyBindings?.settings();
        const first = s?.getKeyBindings(bind).find(Boolean);
        return first ? keyName(first) : "?";
    }

    // ---- Input -------------------------------------------------------------------------------------------

    let controls = null;
    let player = null;
    let active = false;
    let trackIsRocket = false;
    let mounted = false;
    let racing = false;
    let lastTickAt = 0;
    let touchCheckAt = 0;
    let lastStateAt = 0;
    let lastStatus = 0;
    let airborne = false;
    const sources = {};
    for (const [id] of ACTIONS) sources[id] = new Set();
    const armed = { up: false, down: false };
    let lastUp = false, lastDown = false;

    // Driving right now: a Rocket League race, not paused, in a menu, spectating or finished.
    const live = () => active && null != controls && racing && performance.now() - lastTickAt < 250;

    function computeBits() {
        let bits = 0;
        for (const [id] of ACTIONS)
            sources[id].size && (bits |= BIT[id]);
        // Brake in the air always slows the spin (the physics does that itself); these bits are the tilt.
        if (controls) {
            const mode = pitchSetting(), again = "again" === mode;
            controls.up && ("rl" === mode || armed.up) && (bits |= BIT.pitchDown);
            controls.down && ("rl" === mode || again && armed.down) && (bits |= BIT.pitchUp);
        }
        return bits;
    }
    function sync() {
        if (!controls) return;
        const bits = active ? computeBits() : 0;
        controls.rocket !== bits && (controls.rocket = bits);
    }
    function press(id, source) {
        sources[id].add(source);
        sync();
    }
    function releaseSource(source) {
        let changed = false;
        for (const [id] of ACTIONS)
            sources[id].delete(source) && (changed = true);
        changed && sync();
    }
    function releaseAll() {
        for (const [id] of ACTIONS) sources[id].clear();
        touch.release();
        sync();
    }
    function onControlsChange(c) {
        if (c !== controls) return;
        c.up && !lastUp && airborne && (armed.up = true);
        c.down && !lastDown && airborne && (armed.down = true);
        c.up || (armed.up = false);
        c.down || (armed.down = false);
        lastUp = c.up, lastDown = c.down;
        sync();
    }

    const isTyping = t => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    // Anything on screen that takes clicks itself: menus, buttons, the tutorial, chat.
    const isUi = t => !!(t && t.closest && t.closest("button, a, input, select, textarea, label, [role=button], .button, .nsws-rocket-tutorial, .nsws-rocket-pad"));
    function drivingKey(e) {
        const s = window.__nswsKeyBindings?.settings();
        return !!s && DRIVING_BINDS.some(b => s.checkKeyBinding(e, b));
    }
    function actionsFor(e) {
        const matches = window.__nswsKeyBindings?.matches;
        if (!matches) return [];
        return ACTIONS.filter(([id]) => keys[id].some(b => b && !b.startsWith("Mouse") && matches(e, b))).map(a => a[0]);
    }
    // Capture phase, so a Rocket League key never also triggers a less important binding on the same key
    // (Space also pauses outside these tracks). Driving keys are left alone even if bound here too.
    addEventListener("keydown", e => {
        if (!live() || window.__nswsKeyBindCapturing || isTyping(e.target)) return;
        const ids = actionsFor(e);
        if (!ids.length) return;
        drivingKey(e) || (e.preventDefault(), e.stopImmediatePropagation());
        if (e.repeat) return;
        for (const id of ids) press(id, "k" + e.code);
    }, true);
    addEventListener("keyup", e => {
        const source = "k" + e.code;
        if (!ACTIONS.some(([id]) => sources[id].has(source))) return;
        releaseSource(source);
        live() && !drivingKey(e) && e.stopImmediatePropagation();
    }, true);
    addEventListener("mousedown", e => {
        if (!live() || isUi(e.target)) return;
        const code = "Mouse" + e.button;
        const ids = ACTIONS.filter(([id]) => keys[id].includes(code)).map(a => a[0]);
        if (!ids.length) return;
        e.preventDefault();
        for (const id of ids) press(id, "m" + e.button);
    }, true);
    addEventListener("mouseup", e => releaseSource("m" + e.button), true);
    addEventListener("contextmenu", e => {
        live() && !isUi(e.target) && e.preventDefault();
    }, true);
    addEventListener("blur", releaseAll);
    document.addEventListener("visibilitychange", () => document.hidden && releaseAll());

    // ---- Touch -------------------------------------------------------------------------------------------

    // Pads inside the game's own touch controls: Jump and Boost above the steering arrows (that thumb slides up
    // onto them), Roll and Nose up beside the pedals (the other thumb, so air roll and steering work together).
    const touch = (() => {
        const pads = {};
        for (const [id, label, side] of [["jump", "JUMP", "steer"], ["boost", "BOOST", "steer"], ["roll", "ROLL", "pedal"], ["pitchUp", "NOSE UP", "pedal"]]) {
            const d = document.createElement("div");
            d.className = "nsws-rocket-pad " + side;
            d.dataset.id = id;
            d.textContent = label;
            pads[id] = d;
        }
        const gap = document.createElement("br");
        let held = new Set();
        const coarse = matchMedia("(pointer: coarse)");
        const wanted = () => document.body?.classList.contains("nsws-touch") || coarse.matches;
        const on = () => wanted() && pads.jump.isConnected;
        // The game's rule for its pads: every finger counts for the pad under it now, so thumbs can slide.
        function onTouches(e) {
            if (!pads.jump.isConnected && !held.size) return;
            const now = new Set();
            for (const t of e.touches) {
                const el = document.elementFromPoint(t.clientX, t.clientY);
                el?.classList.contains("nsws-rocket-pad") && now.add(el.dataset.id);
            }
            for (const id of held) now.has(id) || (pads[id].classList.remove("active"), releaseSource("t" + id));
            for (const id of now) held.has(id) || (pads[id].classList.add("active"), press(id, "t" + id));
            held = now;
        }
        for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"])
            addEventListener(type, onTouches, { passive: true });
        return {
            on,
            show(parent) {
                if (!parent || !wanted()) return this.hide();
                // The game's touch layer switches its class to "hidden" until the first touch; its pad boxes keep theirs.
                const boxes = [...document.querySelectorAll("#ui > div > .steering")];
                const steer = boxes[boxes.length - 1];
                const pedals = steer && [...steer.parentElement.children].find(e => e !== steer && /(left|right)-container/.test(e.className));
                if (!steer || !pedals) return;
                if (pads.jump.parentElement !== steer) {
                    const first = steer.firstChild;
                    steer.insertBefore(pads.jump, first);
                    steer.insertBefore(pads.boost, first);
                    steer.insertBefore(gap, first);
                }
                pads.roll.parentElement !== pedals && (pedals.appendChild(pads.roll), pedals.appendChild(pads.pitchUp));
                const mirror = pedals.classList.contains("right-container");
                pads.roll.classList.toggle("mirror", mirror);
                pads.pitchUp.classList.toggle("mirror", mirror);
            },
            hide() {
                this.release();
                for (const id in pads) pads[id].remove();
                gap.remove();
            },
            release() {
                for (const id of held) pads[id].classList.remove("active"), releaseSource("t" + id);
                held = new Set();
            }
        };
    })();

    const tutorialButton = (() => {
        const b = document.createElement("button");
        b.className = "button nsws-rocket-tutorial-button";
        b.innerHTML = '<img class="button-icon" src="images/help.svg"> Tutorial';
        b.tabIndex = -1;
        b.addEventListener("click", () => {
            b.blur();
            tutorial.restart();
        });
        return {
            show(ui) {
                const bar = ui?.querySelector(".game-toolbar-ui .button-container");
                if (!bar || window.__nswsCupApp?.inCup?.()) return b.remove();
                b.parentElement !== bar && bar.appendChild(b);
            },
            hide: () => b.remove()
        };
    })();

    // ---- Boost meter -------------------------------------------------------------------------------------

    const hud = (() => {
        let root = null, fill = null, num = null, pips = null, shown = -1, status = -1, flashTimer = 0;
        function build() {
            root = document.createElement("div");
            root.className = "nsws-rocket-hud";
            root.innerHTML = '<div class="jumps"><span></span><span></span></div><div class="box"><div class="container"><div class="bar"><div class="fill"></div></div><p class="num">100</p></div></div>';
            fill = root.querySelector(".fill");
            num = root.querySelector(".num");
            pips = root.querySelectorAll(".jumps > span");
        }
        return {
            mount() {
                root || build();
                const ui = gameUi();
                if (!ui) return;
                const speedo = ui.querySelector(".speedometer-ui");
                if (speedo && !speedo.classList.contains("hidden")) {
                    root.classList.remove("alone");
                    root.parentElement !== speedo && speedo.insertBefore(root, speedo.firstChild);
                } else {
                    root.classList.add("alone");
                    root.parentElement !== ui && ui.appendChild(root);
                }
                touch.show(ui);
                tutorialButton.show(ui);
            },
            unmount() {
                root?.remove();
                touch.hide();
                tutorialButton.hide();
                shown = status = -1;
            },
            set(boost, st) {
                if (!root) return;
                const b = Math.round(boost);
                if (b !== shown) {
                    b > shown + 5 && shown >= 0 && this.flash();
                    shown = b;
                    num.textContent = String(b);
                    fill.style.transform = "scaleX(" + b / 100 + ")";
                    root.classList.toggle("empty", 0 === b);
                }
                if (st !== status) {
                    status = st;
                    // First pip: the jump from the ground. Second: the double jump or flip in the air.
                    pips[0].classList.toggle("on", !!(st & CAN_FIRST));
                    pips[1].classList.toggle("on", !!(st & (CAN_FIRST | CAN_SECOND)));
                    root.classList.toggle("boosting", !!(st & BOOSTING));
                }
            },
            flash() {
                root.classList.remove("refill");
                void root.offsetWidth;
                root.classList.add("refill");
                clearTimeout(flashTimer);
                flashTimer = setTimeout(() => root.classList.remove("refill"), 700);
                sound.refill();
            }
        };
    })();
    function gameUi() {
        const all = document.querySelectorAll("#ui > .game-ui");
        return all[all.length - 1] ?? null;
    }

    // ---- Player car --------------------------------------------------------------------------------------

    function onPlayerState(car, s) {
        lastStateAt = performance.now();
        const r = s.rocket;
        if (!r) return;
        player = car;
        active || (active = true, mount());
        const wasAirborne = airborne;
        airborne = !(r.status & ON_GROUND);
        if (wasAirborne && !airborne) {
            armed.up = armed.down = false;
            sync();
        }
        hud.set(r.boost, r.status);
        (r.status ^ lastStatus) & BOOSTING && sound.boost(!!(r.status & BOOSTING));
        lastStatus = r.status;
        tutorial.state(s, r);
    }

    function mount() {
        if (mounted || !gameUi()) return;
        mounted = true;
        hud.mount();
        hud.set(100, CAN_FIRST);
        tutorial.maybeStart();
    }
    // Paused, in a menu or spectating: let go of everything held so nothing boosts on unpause.
    setInterval(() => {
        if (!active || live()) return;
        lastStatus & BOOSTING && sound.boost(false);
        lastStatus = 0;
        for (const [id] of ACTIONS) sources[id].clear();
        sync();
    }, 200);

    window.__nswsRocket = {
        // A race opened; whether its week is marked rocket: true. The car's first state also switches it on.
        track(isRocket) {
            trackIsRocket = isRocket;
        },
        tick(ok) {
            racing = ok;
            const now = performance.now();
            lastTickAt = now;
            active && !mounted && mount();
            // The game shows its touch pad only after the first touch, and either side can hold the steering.
            mounted && now - touchCheckAt > 500 && (touchCheckAt = now, touch.show(gameUi()), tutorialButton.show(gameUi()), tutorial.maybeStart());
        },
        controls(c) {
            controls && controls !== c && this.controlsGone(controls);
            controls = c;
            active = trackIsRocket;
            mounted = false;
            player = null;
            airborne = false;
            lastStatus = 0;
            armed.up = armed.down = false;
            lastUp = lastDown = false;
            c.addChangeCallback(onControlsChange);
        },
        controlsGone(c) {
            if (c !== controls) return;
            for (const [id] of ACTIONS) sources[id].clear();
            controls = null;
            player = null;
            active = false;
            mounted = false;
            trackIsRocket = false;
            hud.unmount();
            tutorial.leave();
            sound.stop();
        },
        // The controller's moves (mod/nsws_gamepad.js), every frame; only held while driving.
        pad(ids) {
            let changed = false;
            for (const [id] of ACTIONS) {
                const want = live() && ids.has(id);
                want !== sources[id].has("pad") && (want ? sources[id].add("pad") : sources[id].delete("pad"), changed = true);
            }
            changed && sync();
        },
        settings: buildSettings,
        allKeys: () => ACTIONS.flatMap(([id]) => keys[id]).filter(k => k && !k.startsWith("Mouse")),
        get active() {
            return live();
        },
        get trackIsRocket() {
            return trackIsRocket;
        }
    };

    // ---- Effects -----------------------------------------------------------------------------------------

    const fx = (() => {
        let T = null;
        const shared = {};
        const three = () => T ??= window.__nswsTHREE ?? null;

        // The game's three.js build has no cone, ring or torus geometry, so these are made here.
        function geometry(positions, normals, index) {
            const g = new T.BufferGeometry();
            g.setAttribute("position", new T.BufferAttribute(new Float32Array(positions), 3));
            normals && g.setAttribute("normal", new T.BufferAttribute(new Float32Array(normals), 3));
            index && g.setIndex(index);
            return g;
        }
        // An open cone from a ring at the origin to its tip at z = -1, so a scale stretches it from the nozzle.
        function cone(radius, segments) {
            const p = [], n = [], index = [];
            for (let i = 0; i <= segments; i++) {
                const a = i / segments * Math.PI * 2, c = Math.cos(a), s = Math.sin(a), l = Math.sqrt(1 + radius * radius);
                p.push(radius * c, radius * s, 0, 0, 0, -1);
                n.push(c / l, s / l, -radius / l, c / l, s / l, -radius / l);
                i < segments && index.push(2 * i, 2 * i + 2, 2 * i + 1, 2 * i + 1, 2 * i + 2, 2 * i + 3);
            }
            return geometry(p, n, index);
        }
        // A flat ring in the xy plane.
        function ringGeometry(inner, segments) {
            const p = [], index = [];
            for (let i = 0; i <= segments; i++) {
                const a = i / segments * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
                p.push(inner * c, inner * s, 0, c, s, 0);
                i < segments && index.push(2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 1, 2 * i + 3, 2 * i + 2);
            }
            return geometry(p, null, index);
        }
        const FLAME_VERT = "uniform float uLen; varying float vT; varying vec3 vN; varying vec3 vV;" +
            "void main(){ vT = clamp(-position.z, 0.0, 1.0); vec4 mv = modelViewMatrix * vec4(position, 1.0);" +
            "vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }";
        const FLAME_FRAG = "uniform vec3 uHot; uniform vec3 uCool; uniform float uPower; uniform float uTime; varying float vT; varying vec3 vN; varying vec3 vV;" +
            "void main(){ float rim = 0.45 + 0.55 * pow(abs(dot(vN, vV)), 1.2); float wave = 0.82 + 0.18 * sin(uTime * 61.0 + vT * 23.0) * sin(uTime * 37.0 - vT * 9.0);" +
            "float a = pow(1.0 - vT, 1.6) * rim * uPower * wave; gl_FragColor = vec4(mix(uHot, uCool, smoothstep(0.0, 0.8, vT)) * a, a); }";
        function flameMaterial(hot, cool) {
            return new T.ShaderMaterial({
                uniforms: { uHot: { value: new T.Color(hot) }, uCool: { value: new T.Color(cool) }, uPower: { value: 0 }, uTime: { value: 0 }, uLen: { value: 1 } },
                vertexShader: FLAME_VERT,
                fragmentShader: FLAME_FRAG,
                transparent: true,
                depthWrite: false,
                blending: T.AdditiveBlending,
                side: T.DoubleSide,
                fog: false
            });
        }
        const POINT_VERT = "attribute float aAge; attribute float aSize; attribute vec3 aColor; uniform float uPx; varying float vAge; varying vec3 vColor;" +
            "void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vAge = mix(1.0, aAge, smoothstep(1.5, 4.0, -mv.z)); vColor = aColor;" +
            "gl_PointSize = aAge >= 1.0 ? 0.0 : aSize * (0.6 + aAge) * uPx / max(0.5, -mv.z); gl_Position = projectionMatrix * mv; }";
        const pointFrag = additive => "varying float vAge; varying vec3 vColor;" +
            "void main(){ float d = length(gl_PointCoord - 0.5) * 2.0; float a = (1.0 - smoothstep(0.0, 1.0, d)) * (1.0 - vAge) * (1.0 - vAge); if (a < 0.01) discard; gl_FragColor = " +
            (additive ? "vec4(vColor * a, a); }" : "vec4(vColor, 0.6 * a); }");

        // Particles in world space: embers behind the boost, dust when jumping, sparks on a double jump.
        function particles(count, additive) {
            const g = new T.BufferGeometry();
            const pos = new Float32Array(count * 3), age = new Float32Array(count).fill(1), size = new Float32Array(count), col = new Float32Array(count * 3);
            g.setAttribute("position", new T.BufferAttribute(pos, 3));
            g.setAttribute("aAge", new T.BufferAttribute(age, 1));
            g.setAttribute("aSize", new T.BufferAttribute(size, 1));
            g.setAttribute("aColor", new T.BufferAttribute(col, 3));
            const m = new T.ShaderMaterial({
                uniforms: { uPx: { value: 600 } },
                vertexShader: POINT_VERT,
                fragmentShader: pointFrag(additive),
                transparent: true,
                depthWrite: false,
                blending: additive ? T.AdditiveBlending : T.NormalBlending,
                fog: false
            });
            const p = new T.Points(g, m);
            p.frustumCulled = false;
            p.renderOrder = 2;
            const vel = new Float32Array(count * 3), life = new Float32Array(count).fill(1);
            let next = 0, alive = 0;
            return {
                object: p,
                emit(x, y, z, vx, vy, vz, seconds, s, r, gg, b) {
                    const i = next;
                    next = (next + 1) % count;
                    pos[3 * i] = x, pos[3 * i + 1] = y, pos[3 * i + 2] = z;
                    vel[3 * i] = vx, vel[3 * i + 1] = vy, vel[3 * i + 2] = vz;
                    age[i] = 0, life[i] = seconds, size[i] = s;
                    col[3 * i] = r, col[3 * i + 1] = gg, col[3 * i + 2] = b;
                    alive = count;
                },
                update(dt, drag, rise) {
                    if (!alive) return void (p.visible = false);
                    m.uniforms.uPx.value = innerHeight * Math.min(2, devicePixelRatio || 1) * 0.72;
                    let any = 0;
                    const k = Math.max(0, 1 - drag * dt);
                    for (let i = 0; i < count; i++) {
                        if (age[i] >= 1) continue;
                        age[i] = Math.min(1, age[i] + dt / life[i]);
                        vel[3 * i] *= k, vel[3 * i + 1] = vel[3 * i + 1] * k + rise * dt, vel[3 * i + 2] *= k;
                        pos[3 * i] += vel[3 * i] * dt, pos[3 * i + 1] += vel[3 * i + 1] * dt, pos[3 * i + 2] += vel[3 * i + 2] * dt;
                        any++;
                    }
                    alive = any;
                    g.attributes.position.needsUpdate = true;
                    g.attributes.aAge.needsUpdate = true;
                    g.attributes.aSize.needsUpdate = true;
                    g.attributes.aColor.needsUpdate = true;
                    p.visible = any > 0;
                },
                dispose() {
                    g.dispose();
                    m.dispose();
                }
            };
        }
        // A ribbon trailing behind a point on the car (wing tips, the nose in a flip), fading along its length
        // and wherever it is about to pass the chase camera.
        function ribbon(points, color, width, strength) {
            const g = new T.BufferGeometry();
            const pos = new Float32Array(points * 2 * 3), alpha = new Float32Array(points * 2);
            g.setAttribute("position", new T.BufferAttribute(pos, 3));
            g.setAttribute("aAlpha", new T.BufferAttribute(alpha, 1));
            const index = [];
            for (let i = 0; i < points - 1; i++) {
                const a = 2 * i, b = 2 * i + 1, c = 2 * i + 2, d = 2 * i + 3;
                index.push(a, b, c, b, d, c);
            }
            g.setIndex(index);
            const m = new T.ShaderMaterial({
                uniforms: { uColor: { value: new T.Color(color) } },
                vertexShader: "attribute float aAlpha; varying float vA; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vA = aAlpha * smoothstep(3.0, 8.0, -mv.z); gl_Position = projectionMatrix * mv; }",
                fragmentShader: "uniform vec3 uColor; varying float vA; void main(){ gl_FragColor = vec4(uColor * vA, vA); }",
                transparent: true,
                depthWrite: false,
                blending: T.AdditiveBlending,
                side: T.DoubleSide,
                fog: false
            });
            const mesh = new T.Mesh(g, m);
            mesh.frustumCulled = false;
            mesh.renderOrder = 2;
            const trail = [];
            return {
                object: mesh,
                push(p, side, on) {
                    if (!on && !mesh.visible)
                        return void (trail.length = 0);
                    trail.unshift({ x: p.x, y: p.y, z: p.z, sx: side.x, sy: side.y, sz: side.z, a: on ? 1 : 0 });
                    trail.length > points && trail.pop();
                    let any = false;
                    for (let i = 0; i < points; i++) {
                        const q = trail[Math.min(i, trail.length - 1)];
                        const w = width * (1 - i / points);
                        const a = q.a * (1 - i / points) * strength;
                        any = any || a > 0.01;
                        pos[6 * i] = q.x + q.sx * w, pos[6 * i + 1] = q.y + q.sy * w, pos[6 * i + 2] = q.z + q.sz * w;
                        pos[6 * i + 3] = q.x - q.sx * w, pos[6 * i + 4] = q.y - q.sy * w, pos[6 * i + 5] = q.z - q.sz * w;
                        alpha[2 * i] = alpha[2 * i + 1] = a;
                    }
                    g.attributes.position.needsUpdate = true;
                    g.attributes.aAlpha.needsUpdate = true;
                    mesh.visible = any;
                },
                dispose() {
                    g.dispose();
                    m.dispose();
                }
            };
        }
        function basic(color, opacity) {
            return new T.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, blending: T.AdditiveBlending, side: T.DoubleSide, fog: false });
        }
        function geometries(quality) {
            const key = "g" + quality;
            if (shared[key]) return shared[key];
            const high = "high" === quality;
            shared[key] = {
                flameOuter: cone(0.3, high ? 24 : 6),
                flameMid: high ? cone(0.2, 20) : null,
                flameCore: cone(0.12, high ? 16 : 5),
                ring: ringGeometry(0.86, high ? 64 : 12)
            };
            return shared[key];
        }

        function create(car) {
            const quality = fxQuality();
            if ("off" === quality) return { off: true, quality };
            const scene = car.object3D?.parent;
            if (!three() || !scene) return null;
            const high = "high" === quality;
            const G = geometries(quality);
            const root = new T.Group();
            root.matrixAutoUpdate = false;
            const nozzle = new T.Group();
            nozzle.position.set(EXHAUST[0], EXHAUST[1], EXHAUST[2]);
            root.add(nozzle);
            const layers = [];
            if (high) {
                const outer = new T.Mesh(G.flameOuter, flameMaterial(0xffb347, 0xff3b1f));
                const mid = new T.Mesh(G.flameMid, flameMaterial(0xffe2a0, 0xff7a1a));
                const core = new T.Mesh(G.flameCore, flameMaterial(0xffffff, 0xffd27a));
                layers.push({ mesh: outer, len: 2.3, wobble: 0.22 }, { mesh: mid, len: 1.5, wobble: 0.16 }, { mesh: core, len: 0.85, wobble: 0.1 });
                const glow = new T.Points(geometry([0, 0, 0], null, null), new T.ShaderMaterial({
                    uniforms: { uAlpha: { value: 0 }, uPx: { value: 600 } },
                    vertexShader: "uniform float uPx; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_PointSize = 1.4 * uPx / max(0.5, -mv.z); gl_Position = projectionMatrix * mv; }",
                    fragmentShader: "uniform float uAlpha; void main(){ float d = length(gl_PointCoord - 0.5) * 2.0; float a = (1.0 - smoothstep(0.0, 1.0, d)) * uAlpha; gl_FragColor = vec4(vec3(1.0, 0.62, 0.25) * a, a); }",
                    transparent: true,
                    depthWrite: false,
                    blending: T.AdditiveBlending,
                    fog: false
                }));
                glow.frustumCulled = false;
                nozzle.add(glow);
                layers.glow = glow;
            } else {
                const outer = new T.Mesh(G.flameOuter, basic(0xff7a24, 0.75));
                const core = new T.Mesh(G.flameCore, basic(0xffe08a, 0.95));
                layers.push({ mesh: outer, len: 1.9, wobble: 0.2, basic: 0.75 }, { mesh: core, len: 0.9, wobble: 0.12, basic: 0.95 });
            }
            for (const l of layers) {
                l.mesh.renderOrder = 3;
                l.mesh.frustumCulled = false;
                nozzle.add(l.mesh);
            }
            car.object3D.add(root);
            const world = new T.Group();
            world.renderOrder = 2;
            scene.add(world);
            const rings = [];
            for (let i = 0; i < (high ? 4 : 2); i++) {
                const m = new T.Mesh(G.ring, basic(0xffffff, 0));
                m.visible = false;
                m.frustumCulled = false;
                world.add(m);
                rings.push({ mesh: m, t: 1, dur: 0.4, grow: 3 });
            }
            const out = {
                quality, high, root, world, nozzle, layers, rings,
                embers: high ? particles(96, true) : null,
                dust: high ? particles(48, false) : null,
                sparks: high ? particles(32, true) : null,
                wings: high ? [ribbon(28, 0xbfe3ff, 0.07, 0.45), ribbon(28, 0xbfe3ff, 0.07, 0.45)] : null,
                swoosh: high ? [ribbon(24, 0xeef6ff, 0.16, 0.5), ribbon(24, 0xeef6ff, 0.16, 0.5)] : null,
                power: 0, boosting: false, flip: null, last: null, s: null, time: Math.random() * 10,
                p: new T.Vector3(), q: new T.Quaternion(), m: new T.Matrix4(), v: new T.Vector3(), up: new T.Vector3(), left: new T.Vector3(), prevP: null,
                warm: 2
            };
            for (const ps of [out.embers, out.dust, out.sparks]) ps && world.add(ps.object);
            for (const w of [...out.wings ?? [], ...out.swoosh ?? []]) world.add(w.object);
            return out;
        }
        function destroy(car) {
            const f = car.__rocketFx;
            if (!f) return;
            car.__rocketFx = null;
            if (f.off) return;
            f.root.parent?.remove(f.root);
            f.world.parent?.remove(f.world);
            const done = new Set();
            const drop = o => o.traverse(x => {
                const mats = x.material ? [].concat(x.material) : [];
                for (const m of mats) done.has(m) || (done.add(m), m.dispose());
            });
            drop(f.root);
            drop(f.world);
            for (const ps of [f.embers, f.dust, f.sparks]) ps?.dispose();
            for (const w of [...f.wings ?? [], ...f.swoosh ?? []]) w.dispose();
        }
        function localToWorld(f, x, y, z, out) {
            return out.set(x, y, z).applyQuaternion(f.q).add(f.p);
        }
        function ring(f, x, y, z, color, grow, dur) {
            const r = f.rings.find(r => r.t >= 1) ?? f.rings[0];
            r.t = 0, r.dur = dur, r.grow = grow;
            r.mesh.material.color.setHex(color);
            localToWorld(f, x, y, z, r.mesh.position);
            // The ring lies in the car's floor plane.
            r.mesh.quaternion.copy(f.q).multiply(new T.Quaternion().setFromAxisAngle(new T.Vector3(1, 0, 0), -Math.PI / 2));
            r.mesh.visible = true;
        }
        function onJump(f, second) {
            if (f.off) return;
            ring(f, 0, 0.05, -0.1, second ? 0x9fd4ff : 0xffffff, second ? 2.2 : 1.6, second ? 0.42 : 0.34);
            if (f.dust && !second) {
                const w = new T.Vector3();
                for (const [x, y, z] of WHEELS)
                    for (let k = 0; k < 4; k++) {
                        localToWorld(f, x, y, z, w);
                        const a = Math.random() * Math.PI * 2, sp = 2 + 3 * Math.random();
                        f.dust.emit(w.x, w.y, w.z, Math.cos(a) * sp + f.v.x * 0.2, 0.5 + Math.random(), Math.sin(a) * sp + f.v.z * 0.2, 0.55 + 0.3 * Math.random(), 0.9, 0.78, 0.76, 0.74);
                    }
            }
            if (f.sparks && second)
                for (let k = 0; k < 18; k++) {
                    const a = Math.random() * Math.PI * 2, sp = 4 + 4 * Math.random(), w = localToWorld(f, 0, 0.1, -0.1, new T.Vector3());
                    f.sparks.emit(w.x, w.y, w.z, Math.cos(a) * sp + f.v.x * 0.6, -1 - Math.random() * 2, Math.sin(a) * sp + f.v.z * 0.6, 0.35 + 0.2 * Math.random(), 0.25, 0.6, 0.85, 1);
                }
        }
        // Boosted into a wall: sparks off both sides and a ring, as the car kicks up.
        function onWall(f) {
            if (f.off) return;
            ring(f, 0, 0.1, -0.1, 0xffd59a, 2.4, 0.35);
            if (f.sparks)
                for (let k = 0; k < 24; k++) {
                    const side = k % 2 ? 1 : -1, w = localToWorld(f, side * (HULL.hx + 0.1), HULL.y, HULL.z + (Math.random() - 0.5) * 2 * HULL.hz, new T.Vector3());
                    const a = Math.random() * Math.PI * 2, sp = 3 + 5 * Math.random();
                    f.sparks.emit(w.x, w.y, w.z, Math.cos(a) * sp + f.v.x * 0.5, 2 + 4 * Math.random(), Math.sin(a) * sp + f.v.z * 0.5, 0.3 + 0.25 * Math.random(), 0.22, 1, 0.75, 0.35);
                }
        }
        function onFlip(f, forward, side) {
            if (f.off) return;
            // Swooshes trail the two points that travel furthest in the flip: nose and tail for a front or back
            // flip, the sides for a side flip.
            f.flip = { t: 0, dur: 0.65, ends: Math.abs(forward) >= Math.abs(side) };
            f.swoosh || ring(f, 0, HULL.y, HULL.z, 0xdff0ff, 1.4, 0.3);
        }
        function state(car, s, prev, reset) {
            car.__userControls && car.__userControls === controls && onPlayerState(car, s);
            let f = car.__rocketFx;
            if (f && f.quality !== fxQuality()) destroy(car), f = null;
            f || (f = car.__rocketFx = create(car));
            if (!f) return;
            const r = s.rocket;
            f.s = s;
            if (r) {
                const l = f.last;
                if (l && !reset) {
                    r.jumps !== l.jumps && onJump(f, false);
                    r.doubleJumps !== l.doubleJumps && onJump(f, true);
                    r.flips !== l.flips && onFlip(f, r.flipForward, r.flipSide);
                    r.status & WALL_LIFT && !(l.status & WALL_LIFT) && onWall(f);
                }
                f.boosting = !!(r.status & BOOSTING);
                f.air = !(r.status & ON_GROUND);
                f.last = { jumps: r.jumps, doubleJumps: r.doubleJumps, flips: r.flips, status: r.status };
                car.__userControls === controls && sound.events(r, l, reset);
            } else
                f.boosting = !!(1 & (s.rocketFx | 0)), f.air = !!(2 & (s.rocketFx | 0));
        }
        function update(car, dt) {
            const f = car.__rocketFx;
            if (!f || f.off) return;
            dt = Math.min(0.1, Math.max(0, dt || 0));
            f.time += dt;
            car.getPosition && f.p.copy(car.getPosition());
            car.getQuaternion && f.q.copy(car.getQuaternion());
            f.prevP && dt > 0 && f.v.copy(f.p).sub(f.prevP).divideScalar(dt);
            f.prevP ? f.prevP.copy(f.p) : f.prevP = f.p.clone();
            f.m.compose(f.p, f.q, f.one ??= new T.Vector3(1, 1, 1));
            f.root.matrix.copy(f.m);
            f.root.matrixWorldNeedsUpdate = true;
            const visible = car.object3D.visible;
            // Shown for a couple of frames at the start so their shaders compile at load, not mid-run.
            const warm = f.warm > 0 && (f.warm--, true);
            const target = f.boosting ? 1 : 0;
            f.power += (target - f.power) * Math.min(1, dt * (target ? 30 : 14));
            const on = (f.power > 0.02 || warm) && visible;
            for (const l of f.layers) {
                l.mesh.visible = on;
                if (!on) continue;
                const flick = 1 + l.wobble * Math.sin(f.time * 47 + l.len * 13) * Math.sin(f.time * 29);
                const len = Math.max(0.01, l.len * f.power * flick * (f.air ? 1.1 : 1));
                l.mesh.scale.set(0.85 + 0.25 * f.power, 0.85 + 0.25 * f.power, len);
                if (l.basic) l.mesh.material.opacity = l.basic * f.power * (0.8 + 0.2 * Math.sin(f.time * 53 + l.len));
                else l.mesh.material.uniforms.uPower.value = 2.4 * f.power, l.mesh.material.uniforms.uTime.value = f.time;
            }
            if (f.layers.glow) {
                f.layers.glow.visible = on;
                f.layers.glow.material.uniforms.uAlpha.value = 0.75 * f.power * (0.85 + 0.15 * Math.sin(f.time * 41));
                f.layers.glow.material.uniforms.uPx.value = innerHeight * Math.min(2, devicePixelRatio || 1) * 0.72;
            }
            if (f.embers) {
                if (f.boosting && visible) {
                    const n = Math.max(1, Math.round(dt * 160));
                    const w = new T.Vector3(), back = new T.Vector3(0, 0, -1).applyQuaternion(f.q);
                    for (let k = 0; k < n; k++) {
                        localToWorld(f, (Math.random() - 0.5) * 0.2, EXHAUST[1] + (Math.random() - 0.5) * 0.2, EXHAUST[2] - 0.3, w);
                        const sp = 6 + 6 * Math.random();
                        const hot = Math.random();
                        f.embers.emit(w.x, w.y, w.z, f.v.x * 0.7 + back.x * sp + (Math.random() - 0.5) * 2, f.v.y * 0.7 + back.y * sp + (Math.random() - 0.5) * 2, f.v.z * 0.7 + back.z * sp + (Math.random() - 0.5) * 2, 0.22 + 0.2 * Math.random(), 0.45 + 0.3 * Math.random(), 1, 0.45 + 0.4 * hot, 0.12 + 0.2 * hot);
                    }
                }
                f.embers.update(dt, 2.5, 0);
            }
            f.dust?.update(dt, 3, 1.2);
            f.sparks?.update(dt, 1.5, -6);
            for (const r of f.rings) {
                if (r.t >= 1) continue;
                r.t = Math.min(1, r.t + dt / r.dur);
                const e = 1 - (1 - r.t) * (1 - r.t);
                r.mesh.scale.setScalar(0.5 + r.grow * e);
                r.mesh.material.opacity = 0.5 * (1 - r.t) * (visible ? 1 : 0);
                r.mesh.visible = r.t < 1;
            }
            const fl = f.flip;
            fl && (fl.t = Math.min(1, fl.t + dt / fl.dur));
            if (f.swoosh) {
                const ends = !fl || fl.ends;
                const width = f.up.set(ends ? 1 : 0, 0, ends ? 0 : 1).applyQuaternion(f.q);
                f.swoosh.forEach((w, i) => {
                    const k = i ? -1 : 1;
                    ends ? localToWorld(f, 0, HULL.y, HULL.z + k * HULL.hz, f.left) : localToWorld(f, k * HULL.hx, HULL.y, HULL.z, f.left);
                    w.push(f.left, width, visible && !!fl && fl.t < 1);
                });
            }
            fl && fl.t >= 1 && (f.flip = null);
            if (f.wings) {
                const side = f.up.set(0, 1, 0).applyQuaternion(f.q);
                const spinning = f.air && (f.flip || controls && f === player?.__rocketFx && (controls.rocket & (BIT.roll | BIT.rollLeft | BIT.rollRight | BIT.pitchDown | BIT.pitchUp)));
                const fast = f.boosting && f.v.lengthSq() > 100 * 100;
                const lit = visible && !!(spinning || fast);
                f.wings.forEach((w, i) => w.push(localToWorld(f, (i ? -1 : 1) * (HULL.hx + 0.05), HULL.y + 0.05, HULL.z - HULL.hz * 0.7, f.left), side, lit));
            }
            const idle = [f.rings[0].t >= 1 && f.rings[0].mesh, f.embers?.object, f.dust?.object, f.sparks?.object, ...[...f.wings ?? [], ...f.swoosh ?? []].map(w => w.object)].filter(Boolean);
            if (warm) {
                for (const o of idle) o.visible = true;
                f.rings[0].t >= 1 && (f.rings[0].mesh.material.opacity = 0);
            } else if (!f.cooled) {
                f.cooled = true;
                f.rings[0].t >= 1 && (f.rings[0].mesh.visible = false);
            }
        }
        return { state, update, destroy };
    })();
    window.__nswsRocketFx = {
        state(car, s, prev, reset) {
            car.__rocketFx === undefined && (car.__rocketFx = null);
            fx.state(car, s, prev, reset);
        },
        update: (car, dt) => fx.update(car, dt),
        dispose: car => fx.destroy(car)
    };

    // ---- Sounds ------------------------------------------------------------------------------------------

    const sound = (() => {
        let ctx = null, out = null, noise = null, boost = null, volume = 1, volumeAt = 0;
        function gameVolume() {
            const now = performance.now();
            if (now - volumeAt < 2000) return volume;
            volumeAt = now;
            try {
                const s = JSON.parse(localStorage.getItem("polytrack_v5_prod_settings") || "null");
                const get = (name, def) => {
                    const v = Array.isArray(s) ? s.find(e => e[0] === name)?.[1] : s?.[name];
                    const n = parseFloat(v);
                    return Number.isFinite(n) ? n : def;
                };
                volume = get("MasterVolume", 1) * get("SoundEffectVolume", 1);
            } catch (e) {
                volume = 1;
            }
            return volume;
        }
        function ready() {
            if (!soundOn()) return null;
            if (!ctx) {
                const AC = window.AudioContext || window.webkitAudioContext;
                if (!AC) return null;
                ctx = new AC();
                out = ctx.createGain();
                out.connect(ctx.destination);
                const len = ctx.sampleRate;
                noise = ctx.createBuffer(1, len, ctx.sampleRate);
                const d = noise.getChannelData(0);
                for (let i = 0; i < len; i++) d[i] = 2 * Math.random() - 1;
            }
            "suspended" === ctx.state && ctx.resume();
            out.gain.value = 0.55 * gameVolume();
            return ctx;
        }
        function noiseSource() {
            const s = ctx.createBufferSource();
            s.buffer = noise;
            s.loop = true;
            return s;
        }
        function thump(f0, f1, length, level, noiseLevel, noiseFreq) {
            if (!ready()) return;
            const t = ctx.currentTime;
            const o = ctx.createOscillator(), g = ctx.createGain();
            o.type = "sine";
            o.frequency.setValueAtTime(f0, t);
            o.frequency.exponentialRampToValueAtTime(f1, t + length);
            g.gain.setValueAtTime(level, t);
            g.gain.exponentialRampToValueAtTime(0.001, t + length);
            o.connect(g).connect(out);
            o.start(t), o.stop(t + length + 0.02);
            const n = noiseSource(), filter = ctx.createBiquadFilter(), ng = ctx.createGain();
            filter.type = "bandpass", filter.frequency.value = noiseFreq, filter.Q.value = 0.8;
            ng.gain.setValueAtTime(noiseLevel, t);
            ng.gain.exponentialRampToValueAtTime(0.001, t + length * 0.8);
            n.connect(filter).connect(ng).connect(out);
            n.start(t, Math.random()), n.stop(t + length);
        }
        function whoosh() {
            if (!ready()) return;
            const t = ctx.currentTime;
            const n = noiseSource(), filter = ctx.createBiquadFilter(), g = ctx.createGain();
            filter.type = "bandpass", filter.Q.value = 2.2;
            filter.frequency.setValueAtTime(350, t);
            filter.frequency.exponentialRampToValueAtTime(2400, t + 0.22);
            filter.frequency.exponentialRampToValueAtTime(700, t + 0.42);
            g.gain.setValueAtTime(0.001, t);
            g.gain.exponentialRampToValueAtTime(0.5, t + 0.08);
            g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
            n.connect(filter).connect(g).connect(out);
            n.start(t, Math.random()), n.stop(t + 0.5);
        }
        function boostLoop(on) {
            if (!on && !boost) return;
            if (!ready()) return;
            if (!boost) {
                const n = noiseSource(), low = ctx.createBiquadFilter(), band = ctx.createBiquadFilter(), g = ctx.createGain();
                low.type = "lowpass", low.frequency.value = 2200;
                band.type = "peaking", band.frequency.value = 420, band.gain.value = 9, band.Q.value = 0.9;
                g.gain.value = 0;
                n.connect(low).connect(band).connect(g).connect(out);
                n.start();
                boost = { n, g, on: false };
            }
            if (boost.on === on) return;
            boost.on = on;
            const t = ctx.currentTime;
            boost.g.gain.cancelScheduledValues(t);
            boost.g.gain.setTargetAtTime(on ? 0.42 : 0, t, on ? 0.03 : 0.08);
            on && thump(90, 55, 0.12, 0.25, 0.25, 900);
        }
        return {
            events(r, l, reset) {
                if (!l || reset) return;
                r.jumps !== l.jumps && thump(150, 60, 0.18, 0.55, 0.35, 700);
                r.doubleJumps !== l.doubleJumps && thump(240, 110, 0.16, 0.45, 0.3, 1500);
                r.flips !== l.flips && whoosh();
                r.status & WALL_LIFT && !(l.status & WALL_LIFT) && (thump(70, 140, 0.2, 0.35, 0.45, 2600), whoosh());
            },
            boost: on => boostLoop(on),
            refill() {
                if (!ready()) return;
                const t = ctx.currentTime;
                [660, 990].forEach((hz, i) => {
                    const o = ctx.createOscillator(), g = ctx.createGain();
                    o.type = "triangle", o.frequency.value = hz;
                    g.gain.setValueAtTime(0.001, t + 0.07 * i);
                    g.gain.exponentialRampToValueAtTime(0.18, t + 0.07 * i + 0.02);
                    g.gain.exponentialRampToValueAtTime(0.001, t + 0.07 * i + 0.3);
                    o.connect(g).connect(out);
                    o.start(t + 0.07 * i), o.stop(t + 0.07 * i + 0.32);
                });
            },
            stop() {
                if (!boost) return;
                try {
                    boost.n.stop();
                } catch (e) {}
                boost.n.disconnect();
                boost = null;
            }
        };
    })();

    // ---- Tutorial ----------------------------------------------------------------------------------------

    const tutorial = (() => {
        let root = null, step = -1, doneAt = 0, base = null, boostMs = 0, airMs = 0, lastAt = 0, finishTimer = 0;
        const STEPS = [
            {
                title: "Rocket League week",
                text: () => "This week your car can jump, double jump, flip, boost and air roll, like in Rocket League. This quick tutorial runs on the real track; restart afterwards for a clean run.",
                anim: "intro",
                manual: "Start"
            },
            {
                title: "Jump",
                text: () => `Drive off, then press <b>${keysText("jump")}</b>. Hold it longer to jump higher, tap it for a small hop.`,
                anim: "jump",
                done: (r, b) => r.jumps !== b.jumps
            },
            {
                title: "Double jump",
                text: () => `Press <b>${keysText("jump")}</b> again while in the air, without steering or holding ${gameKeysText(0)}. Landing gives your jumps back.`,
                anim: "double",
                done: (r, b) => r.doubleJumps !== b.doubleJumps
            },
            {
                title: "Flip",
                text: () => `In the air, press <b>${keysText("jump")}</b> while holding a direction. ${cap(gameKeysText(0))} + jump is a front flip: a burst of speed.`,
                anim: "flip",
                done: (r, b) => r.flips !== b.flips
            },
            {
                title: "Boost",
                text: () => `Hold <b>${keysText("boost")}</b>. The meter above your speed drains while you boost and fills back up when you don't (quickly in the air); checkpoints refill it. Boost into a track wall to climb it and hop over the top.`,
                anim: "boost",
                done: () => boostMs > 400
            },
            {
                title: "Air control",
                text: () => `In the air, press ${gameKeysText(0)} again to tilt the nose down (held through the jump it keeps the car level), <b>${keysText("pitchUp")}</b> tilts it up and steering turns, so you can aim your boost. ${cap(gameKeysText(2))} is the air brake, like in Trackmania: it stops the car spinning without losing speed. Hold <b>${keysText("roll")}</b> and steer to roll${touch.on() ? "" : `, or use <b>${keysText("rollLeft")}</b> / <b>${keysText("rollRight")}</b>`}.`,
                anim: "roll",
                done: () => airMs > 350
            },
            {
                title: "Wave dash",
                text: () => `Pro tip: flip just before you land and the car keeps the flip's speed. A tiny hop straight into a flip (a zap dash) works on flat road too. ${touch.on() ? "Restart the race" : `Press <b>${gameKeysText(5)}</b> to restart`} for a clean run. The Tutorial button next to Exit shows this again.`,
                anim: "wave",
                manual: "Done"
            }
        ];
        const CAR = '<svg viewBox="0 0 120 60" class="car"><g class="shape"><rect x="22" y="20" width="76" height="16" rx="3"/><rect x="40" y="10" width="38" height="12" rx="3"/><circle class="w" cx="38" cy="38" r="7"/><circle class="w" cx="84" cy="38" r="7"/><path class="flame" d="M22 26 L4 28 L22 31 Z"/></g></svg>';

        function build() {
            root = document.createElement("div");
            root.className = "nsws-rocket-tutorial";
            root.innerHTML = '<div class="anim"><div class="ground"></div><div class="mover">' + CAR + '</div></div><div class="text"><p class="count"></p><h2></h2><p class="say"></p><div class="buttons"><button class="button skip">Skip tutorial</button><button class="button next">Next</button></div></div>';
            root.querySelector(".skip").addEventListener("click", e => {
                e.currentTarget.blur();
                finish();
            });
            root.querySelector(".next").addEventListener("click", e => {
                e.currentTarget.blur();
                advance();
            });
            for (const b of root.querySelectorAll("button")) b.tabIndex = -1;
        }
        function render() {
            const s = STEPS[step];
            root.querySelector(".count").textContent = step ? `${step} / ${STEPS.length - 1}` : "Week 11";
            root.querySelector("h2").textContent = s.title;
            root.querySelector(".say").innerHTML = s.text();
            root.querySelector(".anim").dataset.anim = s.anim;
            root.classList.remove("success");
            const next = root.querySelector(".next");
            next.textContent = s.manual ?? "Next";
            next.classList.toggle("primary", !!s.manual);
            root.querySelector(".skip").hidden = step === STEPS.length - 1;
        }
        function advance() {
            if (step < 0) return;
            if (step >= STEPS.length - 1) return finish();
            step++;
            base = null, boostMs = airMs = 0, doneAt = 0;
            render();
        }
        function finish() {
            write(TUTORIAL_KEY, "done");
            hide();
        }
        function hide() {
            clearTimeout(finishTimer);
            root?.remove();
            step = -1;
        }
        return {
            maybeStart() {
                // Waits for the track's disclaimer popup to be closed; tick() tries again.
                if (step >= 0 || window.__nswsMessageBox?.isOpen || "done" === read(TUTORIAL_KEY, "") || window.__nswsCupApp?.inCup?.()) return;
                const ui = gameUi();
                if (!ui) return;
                root || build();
                step = 0;
                base = null;
                render();
                ui.appendChild(root);
            },
            state(s, r) {
                if (step < 0) return;
                const now = performance.now(), dt = lastAt ? Math.min(100, now - lastAt) : 0;
                lastAt = now;
                base ??= { jumps: r.jumps, doubleJumps: r.doubleJumps, flips: r.flips };
                r.status & BOOSTING && (boostMs += dt);
                const turning = s.controls.rocket & (BIT.roll | BIT.rollLeft | BIT.rollRight | BIT.pitchDown | BIT.pitchUp) || s.controls.left || s.controls.right || s.controls.down;
                !(r.status & ON_GROUND) && turning && (airMs += dt);
                const st = STEPS[step];
                if (doneAt || !st.done || !st.done(r, base)) return;
                doneAt = now;
                root.classList.add("success");
                setTimeout(() => step >= 0 && doneAt === now && advance(), 900);
            },
            leave: hide,
            reset() {
                write(TUTORIAL_KEY, null);
            },
            restart() {
                hide();
                write(TUTORIAL_KEY, null);
                this.maybeStart();
            }
        };
    })();

    // ---- Settings ----------------------------------------------------------------------------------------

    function buildSettings(container, click) {
        const h3 = document.createElement("h3");
        h3.textContent = "Rocket League (week 11)";
        container.appendChild(h3);
        for (const [id, label] of ACTIONS) {
            const row = document.createElement("div");
            row.className = "setting key-binding";
            const p = document.createElement("p");
            p.textContent = label;
            row.appendChild(p);
            const wrap = document.createElement("div");
            wrap.className = "button-wrapper";
            for (let slot = 0; slot < 2; slot++) {
                const b = document.createElement("button");
                b.className = "button";
                b.textContent = keyName(keys[id][slot]);
                b.addEventListener("click", () => {
                    click?.();
                    recordSlot(b, p, label, id, slot);
                });
                wrap.appendChild(b);
            }
            row.appendChild(wrap);
            container.appendChild(row);
        }
        const pad = document.createElement("div");
        pad.className = "setting";
        const padText = document.createElement("p");
        padText.textContent = "Controller: A jump, B boost, X air roll, LB / RB roll, left stick up / down tilts in the air (RT / LT drive, Y respawn, View restart, Menu pause on every track)";
        pad.appendChild(padText);
        container.appendChild(pad);
        choiceRow(container, click, "W / S in the air", [["tm", "Trackmania"], ["rl", "RL"], ["again", "Re-press"]], pitchSetting, v => write(PITCH_KEY, v));
        choiceRow(container, click, "Rocket League effects", [["auto", "Auto"], ["high", "High"], ["low", "Low"], ["off", "Off"]], fxSetting, v => write(FX_KEY, v));
        choiceRow(container, click, "Rocket League sounds", [["off", "Off"], ["on", "On"]], () => soundOn() ? "on" : "off", v => write(SOUND_KEY, v));
        const row = document.createElement("div");
        row.className = "setting";
        const p = document.createElement("p");
        p.textContent = "Tutorial";
        row.appendChild(p);
        const wrap = document.createElement("div");
        wrap.className = "button-wrapper";
        const b = document.createElement("button");
        b.className = "button";
        b.textContent = "done" === read(TUTORIAL_KEY, "") ? "Show again next race" : "Shows on your first race";
        b.addEventListener("click", () => {
            click?.();
            tutorial.reset();
            b.textContent = "Shows on your next race";
        });
        wrap.appendChild(b);
        row.appendChild(wrap);
        container.appendChild(row);
    }
    function choiceRow(container, click, label, options, get, set) {
        const row = document.createElement("div");
        row.className = "setting";
        const p = document.createElement("p");
        p.textContent = label;
        row.appendChild(p);
        const wrap = document.createElement("div");
        wrap.className = "button-wrapper";
        const buttons = options.map(([value, title]) => {
            const b = document.createElement("button");
            b.className = value === get() ? "button selected" : "button";
            b.textContent = title;
            b.addEventListener("click", () => {
                click?.();
                set(value);
                for (const x of buttons) x.className = x === b ? "button selected" : "button";
            });
            wrap.appendChild(b);
            return b;
        });
        row.appendChild(wrap);
        container.appendChild(row);
    }
    // Records slot of action id: a key (with modifiers), or a mouse button. Escape cancels, Backspace clears.
    let recording = null;
    function recordSlot(button, labelEl, label, id, slot) {
        recording?.cancel();
        const api = window.__nswsKeyBindings;
        if (!api) return;
        button.textContent = "Press a key or click";
        labelEl.textContent = "Esc cancels, Backspace clears";
        let stopKeys = null;
        const end = binding => {
            removeEventListener("keydown", onKey, true);
            removeEventListener("mousedown", onMouse, true);
            removeEventListener("contextmenu", onContext, true);
            stopKeys?.();
            recording = null;
            undefined !== binding && (keys[id][slot] = binding, saveKeys());
            button.textContent = keyName(keys[id][slot]);
            labelEl.textContent = label;
        };
        const onKey = e => {
            if ("Escape" === e.code) e.preventDefault(), e.stopImmediatePropagation(), end(undefined);
            else if ("Backspace" === e.code) e.preventDefault(), e.stopImmediatePropagation(), end(null);
        };
        const onMouse = e => {
            e.preventDefault(), e.stopImmediatePropagation();
            end("Mouse" + e.button);
        };
        const onContext = e => e.preventDefault();
        addEventListener("keydown", onKey, true);
        stopKeys = api.record(() => false, text => {
            button.textContent = text || "Press a key or click";
        }, binding => end(binding || undefined));
        setTimeout(() => {
            if (recording?.end !== end) return;
            addEventListener("mousedown", onMouse, true);
            addEventListener("contextmenu", onContext, true);
        }, 0);
        recording = { end, cancel: () => end(undefined) };
    }

    // ---- Styles ------------------------------------------------------------------------------------------

    const css = `
.nsws-rocket-hud { display: flex; flex-direction: column; align-items: flex-end; margin: 0 0 6px; pointer-events: none; }
.speedometer-ui.up > .nsws-rocket-hud { margin: 6px 0 0; flex-direction: column-reverse; }
.nsws-rocket-hud.alone { position: absolute; right: var(--safe-area-horizontal); bottom: 0; }
.nsws-rocket-hud > .jumps { display: flex; gap: 6px; margin: 0 6px 6px; }
.speedometer-ui.up > .nsws-rocket-hud > .jumps { margin: 6px 6px 0; }
.nsws-rocket-hud > .jumps > span { width: 22px; height: 8px; background-color: var(--surface-tertiary-color); opacity: 0.85; clip-path: polygon(4px 0, 100% 0, calc(100% - 4px) 100%, 0 100%); transition: background-color 0.08s; }
.nsws-rocket-hud > .jumps > span.on { background-color: #fff; }
.nsws-rocket-hud > .box { padding: 6px 10px; min-width: 140px; box-sizing: border-box; opacity: 0.9; background-color: var(--surface-color); clip-path: polygon(8px 0, 100% 0, 100% 100%, 0 100%); }
.nsws-rocket-hud > .box > .container { display: flex; align-items: center; gap: 8px; padding: 4px 6px 4px 14px; background-color: var(--surface-tertiary-color); clip-path: polygon(6px 0, 100% 0, 100% 100%, 0 100%); }
.nsws-rocket-hud .bar { flex: 1; height: 10px; min-width: 70px; background-color: rgba(255, 255, 255, 0.12); }
.nsws-rocket-hud .fill { height: 100%; background-color: #ff9a2e; transform-origin: left center; transition: transform 0.06s linear; }
.nsws-rocket-hud.boosting .fill { background-color: #ffc25e; }
.nsws-rocket-hud.empty .num { opacity: 0.45; }
.nsws-rocket-hud .num { margin: 0; min-width: 1.9em; text-align: right; font-size: 24px; line-height: 1; color: var(--text-color); }
.nsws-rocket-hud.refill .fill { animation: nsws-rocket-refill 0.7s ease-out; }
.nsws-rocket-hud.refill .num { animation: nsws-rocket-pop 0.5s ease-out; }
@keyframes nsws-rocket-refill { 0% { background-color: #fff; } 100% { background-color: #ff9a2e; } }
@keyframes nsws-rocket-pop { 0% { transform: scale(1.35); } 100% { transform: scale(1); } }
#ui .nsws-rocket-pad { box-sizing: border-box; line-height: 160px; text-align: center; vertical-align: top; font-size: 30px; white-space: nowrap; color: var(--text-color); user-select: none; -webkit-user-select: none; }
#ui .nsws-rocket-pad.pedal { position: absolute; top: 0; left: 100%; }
#ui .nsws-rocket-pad.pedal.mirror { left: auto; right: 100%; }
#ui .nsws-rocket-pad.pedal[data-id=pitchUp] { top: 170px; font-size: 26px; }
.nsws-rocket-tutorial { position: absolute; left: 50%; top: 12px; transform: translateX(-50%); display: flex; gap: 14px; width: min(640px, calc(100vw - 32px)); box-sizing: border-box; padding: 12px 14px; background-color: var(--surface-color); border-top: 4px solid #7272c2; color: var(--text-color); pointer-events: auto; z-index: 5; }
.nsws-rocket-tutorial.success { border-top-color: #5f5; }
.nsws-rocket-tutorial > .text { flex: 1; min-width: 0; }
.nsws-rocket-tutorial .count { margin: 0; font-size: 14px; opacity: 0.6; font-style: italic; }
.nsws-rocket-tutorial h2 { margin: 2px 0 4px; font-size: 26px; font-weight: normal; }
.nsws-rocket-tutorial.success h2::after { content: "  \\2713"; color: #5f5; }
.nsws-rocket-tutorial .say { margin: 0 0 10px; font-size: 17px; line-height: 1.35; }
.nsws-rocket-tutorial .say b { font-weight: normal; padding: 0 4px; background-color: var(--surface-tertiary-color); white-space: nowrap; }
.nsws-rocket-tutorial .buttons { display: flex; justify-content: flex-end; gap: 8px; }
.nsws-rocket-tutorial .buttons .button { margin: 0; padding: 6px 14px; font-size: 18px; }
.nsws-rocket-tutorial .buttons .button.primary { box-shadow: inset 0 -3px 0 #7272c2; }
.nsws-rocket-tutorial > .anim { position: relative; flex: 0 0 132px; height: 96px; overflow: hidden; background-color: var(--surface-tertiary-color); }
.nsws-rocket-tutorial .ground { position: absolute; left: 0; right: 0; bottom: 14px; height: 2px; background-color: rgba(255, 255, 255, 0.35); }
.nsws-rocket-tutorial .mover { position: absolute; left: 6px; bottom: 16px; width: 120px; height: 60px; }
.nsws-rocket-tutorial .car { width: 100%; height: 100%; overflow: visible; }
.nsws-rocket-tutorial .car .shape { transform-box: fill-box; transform-origin: 50% 50%; fill: #c8d2ff; }
.nsws-rocket-tutorial .car .w { fill: #192042; stroke: #c8d2ff; stroke-width: 2; }
.nsws-rocket-tutorial .car .flame { fill: #ff9a2e; opacity: 0; }
.nsws-rocket-tutorial .anim[data-anim="intro"] .mover { animation: nsws-rt-hop 2.4s ease-in-out infinite; }
.nsws-rocket-tutorial .anim[data-anim="jump"] .mover { animation: nsws-rt-jump 1.6s ease-in-out infinite; }
.nsws-rocket-tutorial .anim[data-anim="double"] .mover { animation: nsws-rt-double 2s ease-in-out infinite; }
.nsws-rocket-tutorial .anim[data-anim="flip"] .mover { animation: nsws-rt-jump 1.8s ease-in-out infinite; }
.nsws-rocket-tutorial .anim[data-anim="flip"] .shape { animation: nsws-rt-flip 1.8s ease-in-out infinite; }
.nsws-rocket-tutorial .anim[data-anim="boost"] .mover { animation: nsws-rt-dash 1.4s ease-in infinite; }
.nsws-rocket-tutorial .anim[data-anim="boost"] .flame { animation: nsws-rt-flame 0.12s linear infinite alternate; }
.nsws-rocket-tutorial .anim[data-anim="roll"] .mover { animation: nsws-rt-jump 2s ease-in-out infinite; }
.nsws-rocket-tutorial .anim[data-anim="roll"] .shape { animation: nsws-rt-roll 2s ease-in-out infinite; }
.nsws-rocket-tutorial .anim[data-anim="wave"] .mover { animation: nsws-rt-wave 1.6s ease-in-out infinite; }
.nsws-rocket-tutorial .anim[data-anim="wave"] .shape { animation: nsws-rt-wavetilt 1.6s ease-in-out infinite; }
@keyframes nsws-rt-hop { 0%, 60%, 100% { transform: translateY(0); } 75% { transform: translateY(-14px); } }
@keyframes nsws-rt-jump { 0%, 15%, 85%, 100% { transform: translateY(0); } 50% { transform: translateY(-30px); } }
@keyframes nsws-rt-double { 0%, 10%, 90%, 100% { transform: translateY(0); } 30% { transform: translateY(-22px); } 40% { transform: translateY(-20px); } 60% { transform: translateY(-36px); } }
@keyframes nsws-rt-flip { 0%, 25% { transform: rotate(0); } 70%, 100% { transform: rotate(360deg); } }
@keyframes nsws-rt-roll { 0%, 20% { transform: scaleY(1); } 40% { transform: scaleY(-1); } 60% { transform: scaleY(1); } 100% { transform: scaleY(1); } }
@keyframes nsws-rt-dash { 0% { transform: translateX(-40px); opacity: 0; } 15% { opacity: 1; } 85% { opacity: 1; } 100% { transform: translateX(60px); opacity: 0; } }
@keyframes nsws-rt-flame { from { opacity: 0.6; } to { opacity: 1; } }
@keyframes nsws-rt-wave { 0%, 100% { transform: translate(-30px, 0); } 25% { transform: translate(-20px, -10px); } 45% { transform: translate(-6px, 0); } 100% { transform: translate(40px, 0); } }
@keyframes nsws-rt-wavetilt { 0%, 15% { transform: rotate(0); } 30% { transform: rotate(-12deg); } 45% { transform: rotate(14deg); } 55%, 100% { transform: rotate(0); } }
@media (max-width: 700px), (max-height: 520px) { .nsws-rocket-tutorial > .anim { display: none; } .nsws-rocket-tutorial h2 { font-size: 21px; } .nsws-rocket-tutorial .say { font-size: 15px; } }
`;
    const style = document.createElement("style");
    style.id = "nsws-rocket-css";
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
})();
