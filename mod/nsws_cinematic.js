(() => {
    const STYLE = `
.time-bar-ui > .button.nsws-cine-button.on { background-color: var(--button-hover-color); }
.time-bar-ui > .button.nsws-cine-button.on::after { width: 100%; }
.time-bar-ui > .nsws-cine-bright { display: none; align-items: center; margin: 6px 0; padding: 0 16px 0 14px; height: 40px; box-sizing: border-box; background-color: var(--button-color); clip-path: polygon(8px 0, 100% 0, calc(100% - 8px) 100%, 0 100%); pointer-events: auto; }
body.nsws-cine-on .time-bar-ui > .nsws-cine-bright { display: flex; }
.nsws-cine-bright > svg { flex-shrink: 0; margin-right: 10px; width: 22px; height: 22px; }
.nsws-cine-bright > input { width: 110px; }
.nsws-cine-bright > input::-webkit-slider-runnable-track { height: 6px; background-color: rgba(255, 255, 255, 0.25); }
.nsws-cine-bright > input::-moz-range-track { height: 6px; background-color: rgba(255, 255, 255, 0.25); }
.nsws-cine-bright > input::-webkit-slider-thumb { width: 14px; height: 22px; margin: -8px 0 0 0; border: 3px solid var(--button-color); }
.nsws-cine-bright > input::-moz-range-thumb { width: 8px; height: 16px; border: 3px solid var(--button-color); }
body.nsws-cine-on .timer-ui, body.nsws-cine-on .speedometer-ui, body.nsws-cine-on .checkpoint-ui { display: none !important; }
.nsws-cine-layer { position: absolute; left: 0; top: 0; width: 100%; height: 100%; overflow: hidden; pointer-events: none; }
.nsws-cine-layer * { line-height: 1; }
.nsws-cine-bar { position: absolute; left: 0; width: 100%; height: 0; background: #000; transition: height 0.6s ease-out; }
.nsws-cine-bar.top { top: 0; }
.nsws-cine-bar.bottom { bottom: 0; }
.nsws-cine-layer.shown .nsws-cine-bar { height: 6.5vh; }
.nsws-cine-fade { position: absolute; inset: 0; background: #000; opacity: 1; transition: opacity 0.7s ease-out; }
.nsws-cine-layer.shown .nsws-cine-fade { opacity: 0; }
.nsws-cine-tags { position: absolute; inset: 0; }
.nsws-cine-tag { position: absolute; left: 0; top: 0; display: flex; align-items: center; padding: 4px 9px 4px 5px; background: rgba(25, 32, 66, 0.62); color: #fff; font-size: 15px; white-space: nowrap; transform-origin: 50% 100%; will-change: transform; }
.nsws-cine-tag > i { flex-shrink: 0; margin-right: 6px; width: 5px; height: 15px; }
.nsws-cine-tag.focus { background: rgba(40, 52, 106, 0.9); }
.nsws-cine-panel { position: absolute; left: 50%; bottom: calc(var(--cine-bottom, 52px) + 8px); transform: translateX(-50%) scale(var(--cine-scale, 1)); transform-origin: 50% 100%; display: flex; flex-direction: column; align-items: center; color: #fff; transition: opacity 0.3s; }
.nsws-cine-layer.finished .nsws-cine-panel { opacity: 0; }
.nsws-cine-panel > .row { display: flex; align-items: stretch; background: var(--surface-color); clip-path: polygon(8px 0, 100% 0, calc(100% - 8px) 100%, 0 100%); }
.nsws-cine-panel > .row > span { display: flex; align-items: center; padding: 7px 14px; font-size: 22px; white-space: nowrap; }
.nsws-cine-panel > .row > .pos { padding-left: 18px; background: #334b77; }
.nsws-cine-panel > .row > .name > i { margin-right: 8px; width: 5px; height: 20px; }
.nsws-cine-panel > .row > .time { min-width: 7.2ch; justify-content: flex-end; background: var(--surface-tertiary-color); font-variant-numeric: tabular-nums; }
.nsws-cine-panel > .row > .speed { padding-right: 18px; font-size: 16px; opacity: 0.7; background: var(--surface-tertiary-color); }
.nsws-cine-panel > .track { margin-bottom: 4px; padding: 3px 12px; background: rgba(25, 32, 66, 0.75); font-size: 14px; opacity: 0.85; }
.nsws-cine-panel > .delta { margin-bottom: 4px; padding: 4px 12px; font-size: 20px; background: rgba(25, 32, 66, 0.85); opacity: 0; transition: opacity 0.25s; }
.nsws-cine-panel > .delta.shown { opacity: 1; }
.nsws-cine-panel > .delta.faster { color: #7fe08a; }
.nsws-cine-panel > .delta.slower { color: #ff8a80; }
.nsws-cine-tower { position: absolute; right: calc(12px + var(--safe-area-right, 0px)); top: calc(var(--cine-top, 50px) + 10px); transform: scale(var(--cine-scale, 1)); transform-origin: 100% 0; display: flex; flex-direction: column; color: #fff; font-size: 15px; }
.nsws-cine-tower > div { display: flex; align-items: stretch; margin-bottom: 2px; background: rgba(25, 32, 66, 0.72); }
.nsws-cine-tower > div.focus { background: rgba(51, 75, 119, 0.92); }
.nsws-cine-tower > div > span { display: flex; align-items: center; padding: 4px 7px; white-space: nowrap; }
.nsws-cine-tower > div > .pos { justify-content: center; width: 2ch; background: rgba(0, 0, 0, 0.25); }
.nsws-cine-tower > div > .name { max-width: 150px; overflow: hidden; text-overflow: ellipsis; display: block; padding-top: 6px; }
.nsws-cine-tower > div > i { flex-shrink: 0; width: 4px; }
.nsws-cine-tower > div > .gap { margin-left: auto; padding-left: 12px; opacity: 0.75; font-variant-numeric: tabular-nums; }
.nsws-cine-card { position: absolute; left: 50%; bottom: calc(var(--cine-bottom, 52px) + 9vh); display: flex; align-items: stretch; color: #fff; background: var(--surface-color); border-bottom: 3px solid #7272c2; clip-path: polygon(10px 0, 100% 0, calc(100% - 10px) 100%, 0 100%); opacity: 0; transform: translate(-50%, 40px) scale(var(--cine-scale, 1)); transform-origin: 50% 100%; transition: transform 0.45s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.3s; }
.nsws-cine-card.shown { opacity: 1; transform: translate(-50%, 0) scale(var(--cine-scale, 1)); }
.nsws-cine-card > .place { display: flex; align-items: center; padding: 0 18px 0 24px; font-size: 40px; background: #334b77; }
.nsws-cine-card > .place > small { font-size: 20px; margin-left: 2px; align-self: flex-end; margin-bottom: 18px; }
.nsws-cine-card > .who { display: flex; flex-direction: column; justify-content: center; padding: 14px 20px; background: var(--surface-secondary-color); }
.nsws-cine-card > .who > .name { display: flex; align-items: center; font-size: 28px; }
.nsws-cine-card > .who > .name > i { margin-right: 10px; width: 6px; height: 26px; }
.nsws-cine-card > .who > .track { margin-top: 8px; font-size: 16px; opacity: 0.6; }
.nsws-cine-card > .result { display: flex; flex-direction: column; justify-content: center; align-items: flex-end; padding: 14px 26px 14px 22px; background: var(--surface-tertiary-color); }
.nsws-cine-card > .result > small { font-size: 14px; opacity: 0.6; }
.nsws-cine-card > .result > b { margin-top: 6px; font-weight: normal; font-size: 32px; font-variant-numeric: tabular-nums; }
`;

    const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
    const damp = (k, dt) => 1 - Math.exp(-k * dt);

    function ensureStyle() {
        if (document.getElementById("nsws-cine-style")) return;
        const style = document.createElement("style");
        style.id = "nsws-cine-style";
        style.textContent = STYLE;
        document.head.appendChild(style);
    }

    function formatTime(frames) {
        const ms = Math.max(0, Math.round(frames));
        const m = Math.floor(ms / 60000);
        const s = Math.floor(ms / 1000) % 60;
        return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0") + "." + String(ms % 1000).padStart(3, "0");
    }

    function ordinal(n) {
        const t = n % 100;
        if (t >= 11 && t <= 13) return "th";
        return ["th", "st", "nd", "rd"][n % 10] ?? "th";
    }

    function colorOf(run) {
        const hex = run.settings.carStyle?.primaryHex;
        return Number.isSafeInteger(hex) ? "#" + hex.toString(16).padStart(6, "0") : "#7272c2";
    }

    function el(tag, className, parent) {
        const e = document.createElement(tag);
        if (className) e.className = className;
        if (parent) parent.appendChild(e);
        return e;
    }

    // Shot weights for the director. Fixed cameras ("tele", "curb") need the car's path ahead
    // of playback, which the simulation has usually computed already.
    const SHOTS = { chase: 3, orbit: 2, tele: 3, curb: 2, heli: 1.4, side: 1.6, front: 1.4, pack: 2.5 };
    const RIDE = new Set(["chase", "orbit", "heli", "side", "front", "pack"]);

    class Cinematic {
        constructor(o) {
            ensureStyle();
            this.o = o;
            const T = this.T = o.THREE;
            this.enabled = false;
            this.camera = new T.PerspectiveCamera(60, 1, 0.5, o.viewDistance ?? 1e4);
            this.ray = new T.Raycaster();
            // Rays test both faces: a wall seen from behind blocks the view just the same.
            this.probe = new T.Mesh(undefined, new T.MeshBasicMaterial({ side: T.DoubleSide }));
            this.hits = [];
            this.meshesAt = -1e9;
            this.v = [0, 1, 2, 3, 4, 5, 6, 7].map(() => new T.Vector3());
            this.up = new T.Vector3(0, 1, 0);
            this.heading = new T.Vector3(0, 0, 1);
            this.carUp = new T.Vector3(0, 1, 0);
            const view = () => ({ pos: new T.Vector3(), look: new T.Vector3(), up: new T.Vector3(0, 1, 0), fov: 60, roll: 0, lens: 0.45, moving: true });
            this.viewA = view();
            this.viewB = view();
            this.blend = null;
            this.shot = null;
            this.lastType = null;
            this.lastT = null;
            this.lastFocus = -1;
            this.roll = 0;
            this.yawRate = 0;
            this.pull = 1;
            this.seed = 1;
            this.shotCount = 0;
            this.uiAt = -1;
            this.deltaUntil = 0;
            this.lastPassed = -1;
            this.cache = {};

            this.button = document.createElement("button");
            this.button.className = "button nsws-cine-button";
            this.button.title = "Cinematic";
            this.button.innerHTML = '<img src="images/video.svg">';
            this.button.addEventListener("click", () => {
                o.playClick?.();
                this.setEnabled(!this.enabled);
            });

            // Brightness for the cinematic look, remembered on this device.
            this.exposure = 1;
            try {
                const e = parseFloat(localStorage.getItem("nsws_cine_exposure"));
                if (e >= 0.4 && e <= 1.6) this.exposure = e;
            } catch (e) {}
            this.correct = true;
            this.bright = document.createElement("label");
            this.bright.className = "nsws-cine-bright";
            this.bright.title = "Brightness (double-click to reset)";
            this.bright.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="5" fill="#fff"/><g stroke="#fff" stroke-width="2" stroke-linecap="round"><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M4.6 19.4l2.1-2.1M17.3 6.7l2.1-2.1"/></g></svg><input type="range" min="0.4" max="1.6" step="0.02">';
            const range = this.bright.querySelector("input");
            range.value = String(this.exposure);
            const setExposure = (v) => {
                this.exposure = clamp(Math.round(v * 50) / 50, 0.4, 1.6);
                range.value = String(this.exposure);
                try {
                    localStorage.setItem("nsws_cine_exposure", String(this.exposure));
                } catch (e) {}
            };
            range.addEventListener("input", () => setExposure(parseFloat(range.value)));
            // Give the keyboard back to the replay (Space, arrows) once the slider is let go.
            range.addEventListener("change", () => range.blur());
            this.bright.addEventListener("dblclick", () => setExposure(1));
            this.bright.addEventListener("wheel", (e) => {
                e.preventDefault();
                setExposure(this.exposure - Math.sign(e.deltaY) * 0.05);
            }, { passive: false });

            const bar = o.uiElement.querySelector(".time-bar-ui");
            const seek = bar?.querySelector(":scope > .bar");
            if (seek) {
                bar.insertBefore(this.button, seek);
                bar.insertBefore(this.bright, seek);
            } else {
                bar?.appendChild(this.button);
                bar?.appendChild(this.bright);
            }
        }

        rand() {
            this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
            return this.seed / 4294967296;
        }

        setEnabled(on) {
            on = !!on;
            if (on === this.enabled) return;
            this.enabled = on;
            this.button.classList.toggle("on", on);
            window.__nswsCinematic.current = on ? this : null;
            document.body.classList.toggle("nsws-cine-on", on);
            if (on) {
                this.buildLayer();
                this.shot = null;
                this.lastT = null;
                this.lastFocus = -1;
                this.lastPassed = -1;
                this.meshesAt = -1e9;
                this.blend = null;
                requestAnimationFrame(() => requestAnimationFrame(() => this.layer?.classList.add("shown")));
            } else {
                this.layer?.remove();
                this.layer = null;
                window.__PolyFX?.setCinematic?.(null);
                this.resetOpacity();
                this.o.restoreCamera();
            }
        }

        buildLayer() {
            const layer = this.layer = el("div", "nsws-cine-layer");
            this.tags = el("div", "nsws-cine-tags", layer);
            el("div", "nsws-cine-bar top", layer);
            el("div", "nsws-cine-bar bottom", layer);
            this.tower = el("div", "nsws-cine-tower", layer);
            const panel = el("div", "nsws-cine-panel", layer);
            this.pDelta = el("div", "delta", panel);
            this.pTrack = el("div", "track", panel);
            this.pTrack.textContent = this.o.trackName ?? "";
            if (!this.o.trackName) this.pTrack.style.display = "none";
            const row = el("div", "row", panel);
            this.pPos = el("span", "pos", row);
            this.pName = el("span", "name", row);
            this.pTime = el("span", "time", row);
            this.pSpeed = el("span", "speed", row);
            this.card = el("div", "nsws-cine-card", layer);
            el("div", "nsws-cine-fade", layer);
            this.tagEls = new Map();
            this.cache = {};
            const ui = document.getElementById("ui");
            if (ui?.parentNode) ui.parentNode.insertBefore(layer, ui);
            else document.body.appendChild(layer);
        }

        dispose() {
            this.layer?.remove();
            this.layer = null;
            this.button.remove();
            this.bright.remove();
            this.resetOpacity();
            document.body.classList.remove("nsws-cine-on");
            if (window.__nswsCinematic.current === this) window.__nswsCinematic.current = null;
            window.__PolyFX?.setCinematic?.(null);
            this.enabled = false;
        }

        // The car's displayed position at a replay frame, if the simulation has reached it.
        pathAt(run, frame, out) {
            const s = run.replay.getFrame(Math.round(frame));
            if (null == s) return false;
            out.set(s.position.x, s.position.y, s.position.z);
            return true;
        }

        loadedFrames(run) {
            return run.replay.getLastFrame().numberOfFrames;
        }

        // Horizontal travel direction around a frame, from the path rather than the car's nose,
        // so drifts and slides keep the camera pointed where the car is going.
        tangentAt(run, frame, fallback, out) {
            const a = this.v[6], b = this.v[7];
            const last = this.loadedFrames(run);
            const f0 = clamp(frame - 60, 0, last), f1 = clamp(frame + 60, 0, last);
            if (f1 > f0 && this.pathAt(run, f0, a) && this.pathAt(run, f1, b)) {
                out.subVectors(b, a);
                out.y = 0;
                if (out.lengthSq() > 0.04) return out.normalize();
            }
            out.copy(fallback);
            out.y = 0;
            if (out.lengthSq() < 1e-6) out.set(0, 0, 1);
            return out.normalize();
        }

        collectMeshes(runs, now) {
            if (now - this.meshesAt < 3) return;
            this.meshesAt = now;
            const T = this.T;
            const cars = runs.map((r) => r.car.getPosition());
            const sphere = new T.Sphere();
            const direct = [], instanced = [];
            this.o.render.scene.traverse((obj) => {
                if (!obj.isMesh || obj.isSkinnedMesh) return;
                const m = obj.material;
                if (!m || Array.isArray(m) || m.visible === false || m.depthWrite === false) return;
                const g = obj.geometry;
                if (!g?.attributes?.position) return;
                if (obj.isInstancedMesh) {
                    instanced.push(obj);
                    return;
                }
                if (null == g.boundingSphere) g.computeBoundingSphere();
                sphere.copy(g.boundingSphere).applyMatrix4(obj.matrixWorld);
                if (sphere.radius < 4 && cars.some((c) => c.distanceTo(sphere.center) < 5)) return;
                direct.push(obj);
            });
            this.direct = direct;
            if (instanced.length !== this.instanced?.length || instanced.some((m, i) => m !== this.instanced[i] || m.count !== this.instancedCounts[i]))
                this.buildGrid(instanced);
        }

        // Track parts are instanced meshes with tens of thousands of instances on big tracks, and
        // three tests every instance of every mesh per ray (25 ms a ray on Winterfell). Parts never
        // move, so their bounding spheres go into a grid once and a ray only tests the parts it passes.
        buildGrid(instanced) {
            const T = this.T;
            const CELL = 24;
            const m4 = new T.Matrix4(), sphere = new T.Sphere();
            const cells = new Map();
            const items = [];
            for (const obj of instanced) {
                const g = obj.geometry;
                if (null == g.boundingSphere) g.computeBoundingSphere();
                obj.updateMatrixWorld();
                for (let i = 0; i < obj.count; i++) {
                    obj.getMatrixAt(i, m4);
                    m4.premultiply(obj.matrixWorld);
                    sphere.copy(g.boundingSphere).applyMatrix4(m4);
                    const { x, y, z } = sphere.center, r = sphere.radius;
                    const id = items.length;
                    items.push({ obj, i, x, y, z, r, mark: 0 });
                    const x0 = Math.floor((x - r) / CELL), x1 = Math.floor((x + r) / CELL);
                    const y0 = Math.floor((y - r) / CELL), y1 = Math.floor((y + r) / CELL);
                    const z0 = Math.floor((z - r) / CELL), z1 = Math.floor((z + r) / CELL);
                    for (let a = x0; a <= x1; a++)
                        for (let b = y0; b <= y1; b++)
                            for (let c = z0; c <= z1; c++) {
                                const key = a + "," + b + "," + c;
                                const list = cells.get(key);
                                list ? list.push(id) : cells.set(key, [id]);
                            }
                }
            }
            this.instanced = instanced;
            this.instancedCounts = instanced.map((m) => m.count);
            this.grid = { CELL, cells, items, stamp: 0 };
            this.probeMatrix ??= new T.Matrix4();
        }

        // Nearest hit along from -> to, ignoring the last `slack` units (the car itself), or null.
        // With `any`, returns at the first hit found.
        castRay(from, to, slack, any) {
            const dir = this.v[5].subVectors(to, from);
            const dist = dir.length();
            if (dist <= slack) return null;
            const ray = this.ray;
            ray.set(from, dir.divideScalar(dist));
            ray.near = 0;
            ray.far = dist - slack;
            let best = null;
            const take = () => {
                for (const h of this.hits)
                    if (h.distance <= ray.far && (null == best || h.distance < best)) best = h.distance;
                this.hits.length = 0;
            };
            for (const obj of this.direct ?? []) {
                this.probe.geometry = obj.geometry;
                this.probe.matrixWorld.copy(obj.matrixWorld);
                this.probe.raycast(ray, this.hits);
                take();
                if (any && null != best) return best;
            }
            const grid = this.grid;
            if (!grid) return best;
            const stamp = ++grid.stamp;
            const o = ray.ray.origin, d = ray.ray.direction, len = ray.far;
            const step = grid.CELL / 3;
            const seen = new Set();
            for (let s = 0; s <= len + step; s += step) {
                const t = Math.min(s, len);
                const key = Math.floor((o.x + d.x * t) / grid.CELL) + "," + Math.floor((o.y + d.y * t) / grid.CELL) + "," + Math.floor((o.z + d.z * t) / grid.CELL);
                if (seen.has(key)) continue;
                seen.add(key);
                const list = grid.cells.get(key);
                if (!list) continue;
                for (const id of list) {
                    const it = grid.items[id];
                    if (it.mark === stamp) continue;
                    it.mark = stamp;
                    // Closest point of the segment to the part's bounding sphere.
                    const px = it.x - o.x, py = it.y - o.y, pz = it.z - o.z;
                    const tc = Math.max(0, Math.min(len, px * d.x + py * d.y + pz * d.z));
                    const qx = px - d.x * tc, qy = py - d.y * tc, qz = pz - d.z * tc;
                    if (qx * qx + qy * qy + qz * qz > it.r * it.r) continue;
                    const probe = this.probe;
                    probe.geometry = it.obj.geometry;
                    it.obj.getMatrixAt(it.i, this.probeMatrix);
                    probe.matrixWorld.multiplyMatrices(it.obj.matrixWorld, this.probeMatrix);
                    probe.raycast(ray, this.hits);
                    take();
                    if (any && null != best) return best;
                }
            }
            return best;
        }

        // True when track or scenery sits between the two points.
        blocked(from, to, slack = 1.5) {
            return null != this.castRay(from, to, slack, true);
        }

        hitDistance(from, to, slack = 1.5) {
            return this.castRay(from, to, slack, false);
        }

        nearbyCars(runs, focus, P, radius) {
            const out = [];
            for (let i = 0; i < runs.length; i++) {
                if (i === focus) continue;
                const p = runs[i].car.getPosition();
                if (p.distanceTo(P) < radius) out.push(p);
            }
            return out;
        }

        pickShot(runs, focus, run, frame, t, P) {
            const finished = run.car.hasFinished();
            this.seed = (frame * 2654435761 + focus * 97 + this.shotCount * 7919) >>> 0;
            this.shotCount++;
            if (finished)
                return this.buildShot("finish", runs, focus, run, frame, t, P) ?? { type: "orbit", t0: t, dur: 1e9, dist: 7.5, h: 1.8, theta: 0.6, omega: 0.22, fov: 50, end: true };
            if (t < 0.35)
                return { type: "orbit", t0: t, dur: 3.2, dist: 8, h: 3, h1: 1.6, theta: Math.PI * 0.8, omega: -0.5, fov: 55 };
            const weights = { ...SHOTS };
            if (this.nearbyCars(runs, focus, P, 22).length === 0) delete weights.pack;
            if (this.lastType) delete weights[this.lastType];
            const order = [];
            while (Object.keys(weights).length) {
                let sum = 0;
                for (const k in weights) sum += weights[k];
                let r = this.rand() * sum;
                for (const k in weights) {
                    r -= weights[k];
                    if (r <= 0) {
                        order.push(k);
                        delete weights[k];
                        break;
                    }
                }
            }
            for (const type of order) {
                const shot = this.buildShot(type, runs, focus, run, frame, t, P);
                if (shot) return shot;
            }
            return this.buildShot("chase", runs, focus, run, frame, t, P);
        }

        buildShot(type, runs, focus, run, frame, t, P) {
            const R = () => this.rand();
            const side = R() < 0.5 ? -1 : 1;
            switch (type) {
            case "chase":
                return { type, t0: t, dur: 3.5 + R() * 2.5, d: 5.2 + R() * 1.6, h: 1.25 + R() * 0.6, s: (R() - 0.5) * 1.6, high: R() < 0.2 };
            case "orbit": {
                const shot = { type, t0: t, dur: 4 + R() * 2, dist: 6.2 + R() * 2, h: 1.2 + R() * 1.2, theta: side * (0.5 + R() * 1.4), omega: -side * (0.25 + R() * 0.2), fov: 52 + R() * 8 };
                const H = this.tangentAt(run, frame, this.heading, this.v[0]);
                const target = this.v[2].copy(P).addScaledVector(this.up, 0.6);
                for (const k of [0, 0.5, 1]) {
                    const back = this.v[1].copy(H).multiplyScalar(-1).applyAxisAngle(this.up, shot.theta + shot.omega * shot.dur * k);
                    const C = this.v[3].copy(P).addScaledVector(back, shot.dist).addScaledVector(this.up, shot.h);
                    if (this.blocked(C, target)) return null;
                }
                return shot;
            }
            case "heli":
            case "side":
            case "front": {
                const shot = type === "heli" ? { type, t0: t, dur: 3.5 + R() * 1.5, back: 9 + R() * 5, up: 8 + R() * 5, s: side * R() * 5 }
                    : type === "side" ? { type, t0: t, dur: 3 + R() * 1.5, side, dist: 6.5 + R() * 2.5, h: 0.9 + R() * 1.1, lead0: -3 + R() * 2, lead1: 1 + R() * 3 }
                        : { type, t0: t, dur: 3 + R() * 1.5, dist: 7 + R() * 3, h: 0.8 + R() * 0.9, s: side * (0.6 + R() * 1.6) };
                const H = this.tangentAt(run, frame, this.heading, this.v[0]);
                this.offsetFor(shot, P, H, 0, this.v[1]);
                return this.blocked(this.v[1], this.v[2].copy(P).addScaledVector(this.up, 0.6)) ? null : shot;
            }
            case "pack":
                return { type, t0: t, dur: 4 + R() * 1.5, back: 7 + R() * 3, up: 2.5 + R() * 2.5, s: side * R() * 4 };
            case "finish": {
                // A camera just past the line, watching the car come through and roll to a stop.
                const ff = run.car.getFinishTime?.()?.numberOfFrames;
                if (null == ff || !this.pathAt(run, ff, this.v[0])) return null;
                const Tq = this.tangentAt(run, ff, this.heading, this.v[1]);
                const N = this.v[2].crossVectors(Tq, this.up).normalize();
                for (const sd of [side, -side]) {
                    const C = new this.T.Vector3().copy(this.v[0]).addScaledVector(N, sd * 7).addScaledVector(this.up, 2.4).addScaledVector(Tq, 16);
                    if (!this.blocked(C, this.v[3].copy(this.v[0]).addScaledVector(this.up, 0.6)))
                        return { type, t0: t, dur: 1e9, cam: C };
                }
                return null;
            }
            case "tele":
            case "curb": {
                const last = this.loadedFrames(run);
                // Far enough ahead to watch the car arrive, whatever its speed.
                const v = Math.max(10, Math.abs(run.car.getSpeedKmh()) / 3.6);
                const tau = type === "tele" ? clamp((55 + R() * 35) / v, 0.9, 2.8) : clamp((30 + R() * 15) / v, 0.6, 1.9);
                const fq = frame + Math.round(tau * 1000);
                if (fq + 500 > last || null != run.replay.getFrame(fq)?.finishFrames) return null;
                const Q = this.pathAt(run, fq, this.v[0]) ? this.v[0] : null;
                if (!Q) return null;
                const Tq = this.tangentAt(run, fq, this.heading, this.v[1]);
                const N = this.v[2].crossVectors(Tq, this.up).normalize();
                for (let attempt = 0; attempt < 4; attempt++) {
                    const sd = (attempt % 2 === 0 ? side : -side);
                    const C = new this.T.Vector3().copy(Q);
                    if (type === "tele")
                        C.addScaledVector(N, sd * (6 + R() * 6)).addScaledVector(this.up, 1.6 + R() * 3.5).addScaledVector(Tq, 4 + R() * 10);
                    else
                        C.addScaledVector(N, sd * (4 + R() * 1.8)).addScaledVector(this.up, 0.45 + R() * 0.55).addScaledVector(Tq, R() * 5 - 1);
                    let bad = 0;
                    for (const df of type === "tele" ? [-1100, -600, 0, 500] : [-800, -400, 0, 300]) {
                        if (!this.pathAt(run, fq + df, this.v[3])) continue;
                        this.v[3].addScaledVector(this.up, 0.6);
                        if (this.blocked(C, this.v[3])) bad++;
                    }
                    if (bad === 0) return { type, t0: t, dur: tau + (type === "tele" ? 2.2 : 1.6), cam: C, minD: 1e9, fov: type === "tele" ? 40 : 74 };
                }
                return null;
            }
            }
            return null;
        }

        // Camera position for the shots that ride along with the car.
        offsetFor(shot, P, H, k, out) {
            const up = this.up;
            const right = this.v[4].crossVectors(H, up).normalize();
            switch (shot.type) {
            case "heli":
                return out.copy(P).addScaledVector(H, -shot.back).addScaledVector(up, shot.up).addScaledVector(right, shot.s);
            case "side": {
                const lead = shot.lead0 + (shot.lead1 - shot.lead0) * k;
                return out.copy(P).addScaledVector(right, shot.side * shot.dist).addScaledVector(up, shot.h).addScaledVector(H, lead);
            }
            case "front":
                return out.copy(P).addScaledVector(H, shot.dist).addScaledVector(up, shot.h).addScaledVector(right, shot.s);
            }
            return out.copy(P);
        }

        update(dt) {
            if (!this.enabled) return;
            const o = this.o;
            const runs = o.getRuns();
            const focus = o.getFocus();
            const run = runs[focus];
            if (!run) return;
            const T = this.T;
            const car = run.car;
            const frame = car.getTime().numberOfFrames;
            const t = frame / 1000;
            const now = performance.now() / 1000;
            this.collectMeshes(runs, now);

            const dPlay = null == this.lastT ? 0 : t - this.lastT;
            const jumped = null != this.lastT && (dPlay < -0.001 || dPlay > dt + 0.25);
            this.lastT = t;
            const step = jumped ? 0 : clamp(dPlay, 0, 0.1);

            const P = car.getPosition();
            const carQ = car.getQuaternion();
            const speed = Math.abs(car.getSpeedKmh());
            const carFwd = this.v[3].set(0, 0, 1).applyQuaternion(carQ);
            const H = this.tangentAt(run, frame, carFwd, this.v[0]).clone();
            this.carUp.set(0, 1, 0).applyQuaternion(carQ).lerp(this.up, 0.5).normalize();

            let cut = !this.shot || focus !== this.lastFocus;
            if (this.shot && !cut) {
                if ((this.shot.type === "finish" || this.shot.end) ? !car.hasFinished() : car.hasFinished()) cut = true;
                else if (t >= this.shot.t0 + this.shot.dur || this.shot.done) cut = true;
            }
            if (jumped && !cut) {
                if (this.shot.type === "tele" || this.shot.type === "curb") cut = true;
                else this.shot.t0 = t;
            }
            let hardCut = false;
            if (cut) {
                const prev = this.shot;
                const sameCar = focus === this.lastFocus;
                this.shot = jumped && !car.hasFinished() && t >= 0.35
                    ? this.buildShot("chase", runs, focus, run, frame, t, P)
                    : this.pickShot(runs, focus, run, frame, t, P);
                this.lastType = this.shot.type;
                this.lastFocus = focus;
                // Like a broadcast: cameras that ride with the car swoop from one framing to the
                // next; trackside cameras, jumps and a new car are straight cuts.
                if (prev && sameCar && !jumped && RIDE.has(prev.type) && RIDE.has(this.shot.type) && !this.shot.end) {
                    this.blend = { from: prev, t0: t, dur: 1.1 + this.rand() * 0.6 };
                } else {
                    hardCut = true;
                    this.blend = null;
                    this.heading.copy(H);
                    this.roll = 0;
                    this.yawRate = 0;
                    this.pull = 1;
                    this.fovNow = null;
                }
            }

            const prevHeading = this.v[1].copy(this.heading);
            const shot = this.shot;
            const lam = shot.type === "heli" ? 1.6 : shot.type === "pack" ? 2 : 4.5;
            if (step > 0) {
                this.heading.lerp(H, damp(lam, step)).normalize();
                const yaw = Math.atan2(prevHeading.x * this.heading.z - prevHeading.z * this.heading.x, prevHeading.dot(this.heading));
                this.yawRate += (yaw / step - this.yawRate) * damp(3, step);
            }
            const ctx = { P, Hs: this.heading, right: this.v[2].crossVectors(this.heading, this.up).normalize(), speed, t, runs, focus };
            const view = this.frameShot(shot, ctx, this.viewA);
            if (this.blend) {
                const b = this.blend;
                const x = clamp((t - b.t0) / b.dur, 0, 1);
                if (x >= 1) this.blend = null;
                else this.mixViews(this.frameShot(b.from, ctx, this.viewB), view, x * x * x * (x * (x * 6 - 15) + 10), P);
            }
            const pos = view.pos, look = view.look;
            const { fov, roll, lens, moving } = view;
            const tagUp = this.v[4];

            // Keep ride-along cameras out of walls: pull in towards the car when something is
            // in the way, or cut away if the shot can't be saved.
            if (moving && !shot.end) {
                const from = this.v[6].copy(P).addScaledVector(this.up, 0.8);
                const hit = this.hitDistance(from, pos, 0.3);
                const want = null == hit ? 1 : clamp((hit - 0.4) / from.distanceTo(pos), 0.15, 1);
                shot.blockedFor = want < 0.35 ? (shot.blockedFor ?? 0) + step : 0;
                if (shot.blockedFor > 0.4 && t - shot.t0 > 1.2) shot.done = true;
                this.pull = want < this.pull ? want : this.pull + (want - this.pull) * damp(2, step);
                if (this.pull < 0.999) pos.sub(from).multiplyScalar(this.pull).add(from);
            }

            const cam = this.camera;
            if (!o.isSpectator()) {
                if (o.render.camera !== cam) o.render.setCamera(cam);
                if (null == this.fovNow || hardCut) this.fovNow = fov;
                else this.fovNow += (fov - this.fovNow) * damp(5, step);
                this.roll += (roll - this.roll) * damp(4, step);
                cam.position.copy(pos);
                cam.up.copy(view.up);
                cam.lookAt(look);
                if (Math.abs(this.roll) > 1e-4) cam.rotateZ(this.roll);
                if (Math.abs(cam.fov - this.fovNow) > 1e-3) {
                    cam.fov = this.fovNow;
                    cam.updateProjectionMatrix();
                }
                cam.updateMatrixWorld();
            }

            const viewCam = o.render.camera;
            const focusUv = this.project(viewCam, tagUp.copy(P).addScaledVector(this.carUp, 0.4));
            window.__PolyFX?.setCinematic?.({
                focus: focusUv ? [focusUv.u, focusUv.v] : [0.5, 0.5],
                strength: o.isSpectator() ? 0.25 : lens,
                speed: clamp(speed / 450, 0, 1),
                exposure: this.exposure,
                correct: this.correct
            });

            this.fadeCars(runs, focus, viewCam, P);
            this.updateTags(runs, focus, viewCam);
            this.updatePanels(runs, focus, run, frame, speed);
        }

        // Where a shot puts the camera this frame.
        frameShot(shot, ctx, out) {
            const { P, Hs, right, speed, t, runs, focus } = ctx;
            const k = clamp((t - shot.t0) / Math.max(0.1, shot.dur), 0, 1);
            const pos = out.pos, look = out.look;
            out.fov = 60;
            out.roll = 0;
            out.lens = 0.45;
            out.moving = true;
            out.up.copy(this.up);
            switch (shot.type) {
            case "chase": {
                const d = (shot.high ? shot.d + 3 : shot.d) + Math.min(speed, 600) * 0.006;
                const h = shot.high ? shot.h + 2.2 : shot.h;
                pos.copy(P).addScaledVector(Hs, -d).addScaledVector(this.carUp, h).addScaledVector(right, shot.s);
                look.copy(P).addScaledVector(Hs, 3.5).addScaledVector(this.carUp, 0.55);
                out.fov = 62 + Math.min(speed, 500) * 0.03;
                out.roll = clamp(this.yawRate * 0.05, -0.12, 0.12);
                out.lens = 0.4;
                out.up.copy(this.carUp);
                break;
            }
            case "orbit": {
                const ang = shot.theta + shot.omega * (t - shot.t0);
                const back = this.v[5].copy(Hs).multiplyScalar(-1).applyAxisAngle(this.up, ang);
                const h = null != shot.h1 ? shot.h + (shot.h1 - shot.h) * k * k * (3 - 2 * k) : shot.h;
                pos.copy(P).addScaledVector(back, shot.dist).addScaledVector(this.up, h);
                look.copy(P).addScaledVector(this.up, 0.5);
                out.fov = shot.fov ?? 50;
                out.lens = shot.end ? 0.75 : 0.55;
                break;
            }
            case "finish":
                out.moving = false;
                pos.copy(shot.cam);
                look.copy(P).addScaledVector(this.up, 0.45);
                out.fov = clamp(2 * Math.atan(3.2 / Math.max(pos.distanceTo(P), 0.1)) * 180 / Math.PI, 18, 55);
                out.lens = 0.8;
                break;
            case "heli":
                this.offsetFor(shot, P, Hs, k, pos);
                look.copy(P).addScaledVector(Hs, 3);
                out.fov = 50;
                out.lens = 0.2;
                break;
            case "side":
                this.offsetFor(shot, P, Hs, k, pos);
                look.copy(P).addScaledVector(Hs, 1.2).addScaledVector(this.up, 0.4);
                out.fov = 50;
                out.lens = 0.65;
                break;
            case "front":
                this.offsetFor(shot, P, Hs, k, pos);
                look.copy(P).addScaledVector(this.up, 0.5);
                out.fov = 56;
                out.lens = 0.5;
                break;
            case "pack": {
                const others = this.nearbyCars(runs, focus, P, 22);
                const c = this.v[5].copy(P).multiplyScalar(2);
                for (const p of others) c.add(p);
                c.divideScalar(others.length + 2);
                let spread = 0;
                for (const p of others) spread = Math.max(spread, p.distanceTo(c));
                spread = Math.min(spread, 15);
                pos.copy(c).addScaledVector(Hs, -(shot.back + spread * 0.6)).addScaledVector(this.up, shot.up + spread * 0.3).addScaledVector(right, shot.s);
                look.copy(c).addScaledVector(Hs, 2);
                out.fov = 55;
                out.lens = 0.25;
                break;
            }
            case "tele":
            case "curb": {
                out.moving = false;
                pos.copy(shot.cam);
                look.copy(P).addScaledVector(this.up, 0.45);
                const d = pos.distanceTo(P);
                shot.minD = Math.min(shot.minD, d);
                if (d > shot.minD + 24 && t - shot.t0 > 0.8) shot.done = true;
                if (shot.type === "tele") {
                    out.fov = clamp(2 * Math.atan(2.4 / Math.max(d, 0.1)) * 180 / Math.PI, 14, 50);
                    out.lens = 0.95;
                } else {
                    out.fov = shot.fov;
                    out.lens = 0.5;
                }
                break;
            }
            }
            return out;
        }

        // Blends view `a` into `b` (which receives the result) by x. The camera swings round the
        // car rather than cutting straight across, so a move from behind to the front goes over
        // the side instead of through the car.
        mixViews(a, b, x, P) {
            const ra = this.v[6].subVectors(a.pos, P), rb = this.v[7].subVectors(b.pos, P);
            const angA = Math.atan2(ra.x, ra.z), angB = Math.atan2(rb.x, rb.z);
            let dAng = angB - angA;
            while (dAng > Math.PI) dAng -= 2 * Math.PI;
            while (dAng < -Math.PI) dAng += 2 * Math.PI;
            const ang = angA + dAng * x;
            const r = Math.hypot(ra.x, ra.z) * (1 - x) + Math.hypot(rb.x, rb.z) * x;
            const y = ra.y * (1 - x) + rb.y * x;
            b.pos.set(P.x + Math.sin(ang) * r, P.y + y, P.z + Math.cos(ang) * r);
            b.look.lerpVectors(a.look, b.look, x);
            b.up.lerpVectors(a.up, b.up, x).normalize();
            b.fov = a.fov + (b.fov - a.fov) * x;
            b.roll = a.roll + (b.roll - a.roll) * x;
            b.lens = a.lens + (b.lens - a.lens) * x;
        }

        // Other runs drive the same line, so they often sit right in front of the lens or between
        // it and the followed car. Fade those out.
        fadeCars(runs, focus, cam, P) {
            const C = cam.getWorldPosition(this.v[5]);
            const seg = this.v[6].subVectors(P, C);
            const len2 = Math.max(1e-6, seg.lengthSq());
            this.opacity ??= new Map();
            this.hidden ??= new Set();
            for (let i = 0; i < runs.length; i++) {
                const car = runs[i].car;
                let op = 1;
                // Runs stacked inside the followed car (the start, identical lines) are hidden outright.
                const inside = i !== focus && car.getPosition().distanceTo(P) < 2.6;
                if (inside !== this.hidden.has(car)) {
                    inside ? this.hidden.add(car) : this.hidden.delete(car);
                    car.setVisible(!inside);
                }
                if (i !== focus) {
                    const Q = car.getPosition();
                    op = clamp((Q.distanceTo(C) - 2) / 5, 0, 1);
                    const k = clamp(this.v[7].subVectors(Q, C).dot(seg) / len2, 0, 1);
                    if (k > 0 && k < 0.92) {
                        const off = this.v[7].copy(C).addScaledVector(seg, k).distanceTo(Q);
                        op = Math.min(op, clamp((off - 1.2) / 2.2, 0.18, 1));
                    }
                    op = Math.round(op * 10) / 10;
                }
                if (this.opacity.get(car) !== op) {
                    this.opacity.set(car, op);
                    car.setOpacity(op);
                }
            }
        }

        resetOpacity() {
            for (const car of this.hidden ?? []) car.setVisible(true);
            this.hidden?.clear();
            if (!this.opacity) return;
            for (const [car, op] of this.opacity)
                if (op !== 1) car.setOpacity(1);
            this.opacity.clear();
        }

        project(cam, p) {
            const v = this.v[7].copy(p).project(cam);
            if (v.z > 1 || v.z < -1) return null;
            return { u: v.x * 0.5 + 0.5, v: v.y * 0.5 + 0.5 };
        }

        updateTags(runs, focus, cam) {
            if (!this.layer) return;
            const W = window.innerWidth, Hh = window.innerHeight;
            const camPos = cam.getWorldPosition(this.v[5]);
            const seen = new Set();
            const carUp = this.v[6];
            const placed = [];
            const want = [];
            for (let i = 0; i < runs.length; i++) {
                const run = runs[i];
                let tag = this.tagEls.get(run);
                if (!tag) {
                    const e = el("div", "nsws-cine-tag", this.tags);
                    const chip = el("i", "", e);
                    chip.style.background = colorOf(run);
                    e.appendChild(document.createTextNode(run.settings.nickname ?? ""));
                    tag = { e, shown: true, focus: false, x: 0, y: 0, s: 0 };
                    this.tagEls.set(run, tag);
                }
                seen.add(run);
                const P = run.car.getPosition();
                carUp.set(0, 1, 0).applyQuaternion(run.car.getQuaternion());
                P.addScaledVector(carUp, 1.55);
                const d = P.distanceTo(camPos);
                const uv = d > 2.2 && d < 170 ? this.project(cam, P) : null;
                const show = !!uv && uv.u > -0.1 && uv.u < 1.1 && uv.v > -0.1 && uv.v < 1.1;
                want.push({ i, run, tag, uv, d, show });
            }
            want.sort((a, b) => (b.i === focus) - (a.i === focus) || a.d - b.d);
            for (const { i, run, tag, uv, d } of want) {
                let show = want.find((w) => w.tag === tag).show;
                let box = null;
                if (show) {
                    const sc = clamp(9 / d, 0.62, 1.1);
                    const w = ((run.settings.nickname ?? "").length * 9.5 + 24) * sc, h = 23 * sc;
                    const x = uv.u * W, y = (1 - uv.v) * Hh;
                    box = [x - w / 2, y - h, x + w / 2, y];
                    for (const b of placed) {
                        const ox = Math.min(box[2], b[2]) - Math.max(box[0], b[0]);
                        const oy = Math.min(box[3], b[3]) - Math.max(box[1], b[1]);
                        if (ox > 0 && oy > h * 0.35 && ox > Math.min(w, b[2] - b[0]) * 0.3) {
                            show = false;
                            break;
                        }
                    }
                }
                if (show !== tag.shown) {
                    tag.e.style.display = show ? "" : "none";
                    tag.shown = show;
                }
                const isFocus = i === focus;
                if (isFocus !== tag.focus) {
                    tag.e.classList.toggle("focus", isFocus);
                    tag.focus = isFocus;
                }
                if (!show) continue;
                placed.push(box);
                const x = Math.round(uv.u * W), y = Math.round((1 - uv.v) * Hh);
                const s = Math.round(clamp(9 / d, 0.62, 1.1) * 100) / 100;
                if (x !== tag.x || y !== tag.y || s !== tag.s) {
                    tag.e.style.transform = "translate(" + x + "px," + y + "px) translate(-50%,-100%) scale(" + s + ")";
                    tag.x = x;
                    tag.y = y;
                    tag.s = s;
                }
                const z = String(1000 - Math.min(999, Math.round(d)));
                if (tag.e.style.zIndex !== z) tag.e.style.zIndex = z;
            }
            for (const [run, tag] of this.tagEls)
                if (!seen.has(run)) {
                    tag.e.remove();
                    this.tagEls.delete(run);
                }
        }

        set(key, node, prop, value) {
            if (this.cache[key] === value) return;
            this.cache[key] = value;
            node[prop] = value;
        }

        // Race order at the displayed moment: finished runs by time, then by checkpoints passed,
        // then by who reached their last checkpoint first.
        standings(runs) {
            const rows = runs.map((run, i) => {
                const f = run.car.getTime().numberOfFrames;
                const fin = run.car.getFinishTime?.();
                let passed = 0;
                for (const c of run.checkpointTimes)
                    if (c.numberOfFrames <= f) passed++;
                return {
                    i, run, passed,
                    finished: null != fin ? fin.numberOfFrames : null,
                    lastCp: passed > 0 ? run.checkpointTimes[passed - 1].numberOfFrames : 0,
                    total: run.settings.time?.numberOfFrames ?? 1e12
                };
            });
            rows.sort((a, b) => {
                if ((null != a.finished) !== (null != b.finished)) return null != a.finished ? -1 : 1;
                if (null != a.finished) return a.finished - b.finished;
                if (a.passed !== b.passed) return b.passed - a.passed;
                if (a.lastCp !== b.lastCp) return a.lastCp - b.lastCp;
                return a.total - b.total;
            });
            return rows;
        }

        updatePanels(runs, focus, run, frame, speed) {
            if (!this.layer) return;
            const multi = runs.length > 1;
            const now = performance.now();
            const rows = multi ? this.standings(runs) : null;
            const me = rows ? rows.findIndex((r) => r.i === focus) : 0;

            this.set("pos", this.pPos.style, "display", multi ? "" : "none");
            if (multi) this.set("posT", this.pPos, "textContent", (me + 1) + "/" + runs.length);
            const name = run.settings.nickname ?? "";
            if (this.cache.name !== name) {
                this.cache.name = name;
                this.pName.innerHTML = "";
                el("i", "", this.pName).style.background = colorOf(run);
                this.pName.appendChild(document.createTextNode(name));
            }
            const fin = run.car.getFinishTime?.();
            this.set("time", this.pTime, "textContent", formatTime(null != fin ? fin.numberOfFrames : frame));
            this.set("speed", this.pSpeed, "textContent", Math.round(speed) + " km/h");

            // Split against the best other run at the checkpoint just passed.
            let passed = 0;
            for (const c of run.checkpointTimes)
                if (c.numberOfFrames <= frame) passed++;
            if (this.lastPassed >= 0 && passed > this.lastPassed && multi) {
                const k = passed - 1;
                let best = null;
                for (let i = 0; i < runs.length; i++) {
                    if (i === focus) continue;
                    const c = runs[i].checkpointTimes[k];
                    if (c && (null == best || c.numberOfFrames < best)) best = c.numberOfFrames;
                }
                if (null != best) {
                    const diff = run.checkpointTimes[k].numberOfFrames - best;
                    this.pDelta.textContent = (diff <= 0 ? "-" : "+") + (Math.abs(diff) / 1000).toFixed(3);
                    this.pDelta.className = "delta shown " + (diff <= 0 ? "faster" : "slower");
                    this.deltaUntil = now + 2600;
                }
            }
            this.lastPassed = passed;
            if (this.deltaUntil && now > this.deltaUntil) {
                this.deltaUntil = 0;
                this.pDelta.classList.remove("shown");
            }

            if (now - this.uiAt > 120) {
                this.uiAt = now;
                this.renderTower(rows, focus);
                const bar = this.o.uiElement.querySelector(".time-bar-ui")?.getBoundingClientRect();
                const tools = this.o.uiElement.querySelector(".preview-toolbar-ui")?.getBoundingClientRect();
                const scale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale-factor")) || 1;
                this.set("bottom", this.layer.style, "cssText", "--cine-bottom:" + Math.round(bar ? window.innerHeight - bar.top : 52) + "px;--cine-top:" + Math.round(tools ? tools.bottom : 50) + "px;--cine-scale:" + clamp(scale, 0.75, 1.6).toFixed(3));
            }

            const finished = null != fin;
            if (finished !== !!this.cache.card) {
                this.cache.card = finished;
                if (finished) this.fillCard(runs, focus, run, fin.numberOfFrames);
                this.card.classList.toggle("shown", finished);
                this.layer.classList.toggle("finished", finished);
            }
        }

        renderTower(rows, focus) {
            if (!rows) {
                this.set("tower", this.tower.style, "display", "none");
                return;
            }
            this.set("tower", this.tower.style, "display", "");
            const MAX = 10;
            let list = rows.slice(0, MAX);
            const meAt = rows.findIndex((r) => r.i === focus);
            if (meAt >= MAX) list = rows.slice(0, MAX - 1).concat([rows[meAt]]);
            const lead = rows[0];
            const key = list.map((r) => r.i).join(",");
            if (this.cache.towerKey !== key) {
                this.cache.towerKey = key;
                this.tower.innerHTML = "";
                this.towerRows = list.map(() => {
                    const d = el("div", "", this.tower);
                    const pos = el("span", "pos", d);
                    const chip = el("i", "", d);
                    const name = el("span", "name", d);
                    const gap = el("span", "gap", d);
                    return { d, pos, chip, name, gap };
                });
            }
            list.forEach((r, n) => {
                const row = this.towerRows[n];
                const place = rows.indexOf(r) + 1;
                row.pos.textContent = String(place);
                row.chip.style.background = colorOf(r.run);
                row.name.textContent = r.run.settings.nickname ?? "";
                row.d.classList.toggle("focus", r.i === focus);
                let gap = "";
                if (null != r.finished) gap = r === lead ? formatTime(r.finished) : "+" + ((r.finished - lead.finished) / 1000).toFixed(3);
                else if (r !== lead && r.passed > 0) {
                    const c = lead.run.checkpointTimes[r.passed - 1];
                    if (c) gap = "+" + ((r.lastCp - c.numberOfFrames) / 1000).toFixed(3);
                }
                row.gap.textContent = gap;
            });
        }

        fillCard(runs, focus, run, finishFrames) {
            this.card.innerHTML = "";
            if (runs.length > 1) {
                const times = runs.map((r, i) => ({ i, f: r.settings.time?.numberOfFrames ?? 1e12 })).sort((a, b) => a.f - b.f);
                const place = times.findIndex((x) => x.i === focus) + 1;
                const p = el("div", "place", this.card);
                p.textContent = String(place);
                el("small", "", p).textContent = ordinal(place);
            }
            const who = el("div", "who", this.card);
            const name = el("div", "name", who);
            el("i", "", name).style.background = colorOf(run);
            name.appendChild(document.createTextNode(run.settings.nickname ?? ""));
            if (this.o.trackName) el("div", "track", who).textContent = this.o.trackName;
            const res = el("div", "result", this.card);
            el("small", "", res).textContent = "Time";
            el("b", "", res).textContent = formatTime(finishFrames);
        }
    }

    window.__nswsCinematic = {
        attach: (o) => new Cinematic(o)
    };
})();
