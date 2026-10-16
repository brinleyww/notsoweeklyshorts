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
.time-bar-ui > button > svg { margin: 0 0 2px 0; vertical-align: middle; width: 28px; height: 28px; pointer-events: none; }
.time-bar-ui > .button.nsws-watch-inputs.off > svg { opacity: 0.35; }
.time-bar-ui > .button.nsws-watch-save.on { background-color: #8a2a3a; }
body.nsws-hide-inputs .input-visualizer-ui { display: none !important; }
body.nsws-recording .time-bar-ui, body.nsws-recording .preview-toolbar-ui, body.nsws-recording #_nsws-cps { opacity: 0 !important; pointer-events: none !important; }
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

    // The director plans the whole edit ahead from the replays: a run always gets the same edit,
    // and the camera at any moment is a function of the playback time alone.
    const STEP = 10;
    const DT = STEP / 1000;
    const RIDE = new Set(["chase", "orbit", "heli", "side", "front", "pack"]);
    const TYPES = ["chase", "orbit", "tele", "curb", "heli", "side", "front", "pack"];
    const VARIANTS = { chase: 2, orbit: 1, tele: 2, curb: 1, heli: 1, side: 2, front: 1, pack: 1 };
    const LAMBDA = { heli: 1.6, pack: 2 };
    // Camera shake per shot type, in radians at full speed.
    const SHAKE = { chase: 0.006, front: 0.005, side: 0.004, curb: 0.007, tele: 0.003, orbit: 0.002, heli: 0.002, pack: 0.003, finish: 0.002 };
    const HOLD = { type: "chase", t0: 0, t1: Infinity, d: 5.8, h: 1.5, s: 0, high: false };
    const WAIT = {};

    function hashString(s) {
        let h = 2166136261;
        for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
        return h >>> 0;
    }

    // Each decision gets its own stream, so the order things are evaluated in never matters.
    function rng(...keys) {
        let a = 0x9e3779b9;
        for (const k of keys) a = Math.imul(a ^ (k >>> 0), 2654435761) >>> 0;
        return () => {
            a = (a + 0x6d2b79f5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    const smootherstep = (x) => x * x * x * (x * (x * 6 - 15) + 10);
    const durFit = (d) => clamp(1 - Math.abs(d - 4) / 3, 0, 1);

    // A run's replay sampled every 10 ms, with smoothing that depends only on the time asked for.
    class PathCache {
        constructor(run) {
            this.run = run;
            this.n = 0;
            this.p = [];
            this.u = [];
            this.nose = [];
            this.spd = [];
            this.air = [];
            this.tan = [];
            this.finish = null;
            this.events = [];
            this.ai = 12;
            this.corner = null;
            this.airFrom = null;
            this.sa = [0, 0, 0];
            this.sb = [0, 0, 0];
            this.acc = [0, 0, 0];
            this.acc2 = [0, 0, 0];
        }

        sync() {
            const last = this.run.replay.getLastFrame().numberOfFrames;
            while (this.n * STEP <= last) {
                const s = this.run.replay.getFrame(this.n * STEP);
                if (null == s) break;
                const { x: qx, y: qy, z: qz, w: qw } = s.quaternion;
                this.p.push(s.position.x, s.position.y, s.position.z);
                this.u.push(2 * (qx * qy - qw * qz), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz + qw * qx));
                this.nose.push(2 * (qw * qy + qx * qz), 1 - 2 * (qx * qx + qy * qy));
                this.spd.push(Math.abs(s.speedKmh ?? 0));
                this.air.push(Array.isArray(s.wheelContact) && s.wheelContact.every((w) => null == w) ? 1 : 0);
                if (null == this.finish && null != s.finishFrames) this.finish = s.finishFrames / 1000;
                this.n++;
            }
            this.analyze();
        }

        get end() {
            return (this.n - 1) * DT;
        }

        pos(t, out) {
            const f = clamp(t / DT, 0, Math.max(0, this.n - 1));
            const i = Math.floor(f), j = Math.min(i + 1, this.n - 1), fr = f - i, p = this.p;
            return out.set(p[3 * i] + (p[3 * j] - p[3 * i]) * fr, p[3 * i + 1] + (p[3 * j + 1] - p[3 * i + 1]) * fr, p[3 * i + 2] + (p[3 * j + 2] - p[3 * i + 2]) * fr);
        }

        // Horizontal travel direction from the path, or the car's nose while it barely moves.
        computeTangent(i) {
            const a = Math.max(0, i - 6), b = Math.min(this.n - 1, i + 6), p = this.p;
            let x = p[3 * b] - p[3 * a], z = p[3 * b + 2] - p[3 * a + 2];
            let l = Math.hypot(x, z);
            if (l < 0.2) {
                x = this.nose[2 * i];
                z = this.nose[2 * i + 1];
                l = Math.hypot(x, z);
                if (l < 1e-6) {
                    x = 0;
                    z = 1;
                    l = 1;
                }
            }
            this.tx = x / l;
            this.tz = z / l;
        }

        tangent(i) {
            i = clamp(i, 0, this.n - 1);
            if (i < this.tan.length >> 1) {
                this.tx = this.tan[2 * i];
                this.tz = this.tan[2 * i + 1];
            } else this.computeTangent(i);
        }

        // Signed turn rate in rad/s, from directions 0.05 s either side.
        yawRaw(i) {
            this.tangent(i - 5);
            const ax = this.tx, az = this.tz;
            this.tangent(i + 5);
            return Math.atan2(ax * this.tz - az * this.tx, ax * this.tx + az * this.tz) / (10 * DT);
        }

        value(kind, i, out) {
            if (kind === 0) {
                this.tangent(i);
                out[0] = this.tx;
                out[1] = 0;
                out[2] = this.tz;
            } else if (kind === 1) {
                out[0] = this.u[3 * i];
                out[1] = this.u[3 * i + 1];
                out[2] = this.u[3 * i + 2];
            } else {
                out[0] = this.spd[i];
                out[1] = out[2] = 0;
            }
        }

        // Exponential average over the time before t (time constant 1/lam). Each sample interval
        // is weighted by its exact share, so the result changes continuously with t.
        smooth(t, lam, kind, out) {
            const n = this.n;
            out[0] = out[1] = out[2] = 0;
            if (n === 0) return out;
            const f = clamp(t / DT, 0, n - 1);
            let i = Math.floor(f);
            const fr = f - i;
            const A = this.sa, B = this.sb;
            this.value(kind, i, A);
            this.value(kind, Math.min(i + 1, n - 1), B);
            const ax = A[0] + (B[0] - A[0]) * fr, ay = A[1] + (B[1] - A[1]) * fr, az = A[2] + (B[2] - A[2]) * fr;
            const w = 1 - Math.exp(-lam * fr * DT);
            let sx = w * (ax + A[0]) / 2, sy = w * (ay + A[1]) / 2, sz = w * (az + A[2]) / 2, ws = w;
            let decay = 1 - w;
            const keep = Math.exp(-lam * DT);
            const K = Math.ceil(5 / (lam * DT));
            for (let k = 0; k < K && i > 0; k++, i--) {
                this.value(kind, i - 1, B);
                const iw = decay * (1 - keep);
                sx += iw * (A[0] + B[0]) / 2;
                sy += iw * (A[1] + B[1]) / 2;
                sz += iw * (A[2] + B[2]) / 2;
                ws += iw;
                decay *= keep;
                A[0] = B[0];
                A[1] = B[1];
                A[2] = B[2];
            }
            sx += decay * A[0];
            sy += decay * A[1];
            sz += decay * A[2];
            ws += decay;
            out[0] = sx / ws;
            out[1] = sy / ws;
            out[2] = sz / ws;
            return out;
        }

        heading(t, lam, out) {
            const a = this.smooth(t, lam, 0, this.acc);
            out.set(a[0], 0, a[2]);
            if (out.lengthSq() < 1e-10) out.set(0, 0, 1);
            return out.normalize();
        }

        // The car's up, smoothed, halfway to world up so wall rides tilt the shot without flipping it.
        up(t, out) {
            const a = this.smooth(t, 6, 1, this.acc);
            const l = Math.hypot(a[0], a[1], a[2]) || 1;
            return out.set(a[0] / l * 0.5, a[1] / l * 0.5 + 0.5, a[2] / l * 0.5).normalize();
        }

        speed(t) {
            return this.smooth(t, 3, 2, this.acc)[0];
        }

        yawRate(t) {
            const a = this.smooth(t, 3, 0, this.acc), b = this.smooth(t - 0.1, 3, 0, this.acc2);
            return Math.atan2(b[0] * a[2] - b[2] * a[0], b[0] * a[0] + b[2] * a[2]) / 0.1;
        }

        // Corners and jumps, found once each part of the path is final.
        analyze() {
            while ((this.tan.length >> 1) < this.n - 6) {
                this.computeTangent(this.tan.length >> 1);
                this.tan.push(this.tx, this.tz);
            }
            const last = (this.tan.length >> 1) - 6;
            for (; this.ai <= last; this.ai += 5) {
                const i = this.ai, t = i * DT;
                const yaw = this.yawRaw(i);
                const turning = Math.abs(yaw) > 0.55 && this.spd[i] > 30;
                let c = this.corner;
                if (c && (!turning || Math.sign(yaw) !== c.dir)) {
                    if (t - c.t0 >= 0.25) {
                        c.t1 = t;
                        this.events.push(c);
                    }
                    c = this.corner = null;
                }
                if (turning) {
                    if (!c) this.corner = { type: "corner", t0: t, apex: t, peak: Math.abs(yaw), dir: Math.sign(yaw) };
                    else if (Math.abs(yaw) > c.peak) {
                        c.peak = Math.abs(yaw);
                        c.apex = t;
                    }
                }
                if (this.air[i]) {
                    if (null == this.airFrom) this.airFrom = t;
                } else if (null != this.airFrom) {
                    if (t - this.airFrom >= 0.3) this.events.push({ type: "jump", t0: this.airFrom, t1: t });
                    this.airFrom = null;
                }
            }
        }
    }

    // Builds the shot list for one followed run, a little at a time (a generator), always from
    // the start of the run and only once the replays reach far enough ahead, so the result never
    // depends on load speed or frame rate.
    class Planner {
        constructor(cine, runs, focus, seed) {
            const T = cine.T;
            this.c = cine;
            this.runs = runs;
            this.focus = focus;
            this.run = runs[focus];
            this.path = cine.pathOf(this.run);
            this.seed = seed;
            this.shots = [];
            this.done = false;
            this.total = Math.max(...runs.map((r) => r.settings.time?.numberOfFrames ?? 0)) / 1000 + 10;
            this.encl = new Map();
            this.bat = new Map();
            this.grp = new Map();
            this.w = [0, 1, 2, 3, 4, 5].map(() => new T.Vector3());
            this.view = { pos: new T.Vector3(), look: new T.Vector3(), up: new T.Vector3(0, 1, 0), fov: 60, roll: 0, lens: 0.45, moving: true };
            this.view2 = { pos: new T.Vector3(), look: new T.Vector3(), up: new T.Vector3(0, 1, 0), fov: 60, roll: 0, lens: 0.45, moving: true };
            this.gen = this.plan();
        }

        get plannedTo() {
            const s = this.shots[this.shots.length - 1];
            return s ? s.t1 : 0;
        }

        ready(T) {
            const need = Math.min(T, this.total - 0.05);
            return this.runs.every((r) => this.c.pathOf(r).end >= need);
        }

        step(ms) {
            if (this.done) return;
            const end = performance.now() + ms;
            while (performance.now() < end) {
                const r = this.gen.next();
                if (r.done) {
                    this.done = true;
                    return;
                }
                if (r.value === WAIT) return;
            }
        }

        shotAt(t) {
            const s = this.shots;
            let lo = 0, hi = s.length - 1, found = -1;
            while (lo <= hi) {
                const m = (lo + hi) >> 1;
                if (s[m].t0 <= t) {
                    found = m;
                    lo = m + 1;
                } else hi = m - 1;
            }
            return found >= 0 && t < s[found].t1 ? found : -1;
        }

        *plan() {
            while (!this.ready(3.8)) yield WAIT;
            this.push(this.intro());
            yield;
            for (;;) {
                const t0 = this.plannedTo;
                while (!this.ready(t0 + 9)) yield WAIT;
                const finish = this.path.finish;
                if (null != finish && finish - t0 < 0.6) {
                    const last = this.shots[this.shots.length - 1];
                    if (finish > last.t1) {
                        last.t1 = finish;
                        this.curves(last);
                    }
                    this.push(this.finishShot(finish));
                    return;
                }
                if (t0 >= this.total - 0.5) return;
                const hardEnd = finish ?? this.total;
                const idx = this.shots.length;
                const cands = [];
                const lastType = this.shots[idx - 1].type;
                for (let ti = 0; ti < TYPES.length; ti++)
                    for (let v = 0; TYPES[ti] !== lastType && v < VARIANTS[TYPES[ti]]; v++) {
                        const c = this.candidate(TYPES[ti], v, rng(this.seed, idx, ti, v), t0, hardEnd);
                        if (c) {
                            c.order = ti * 4 + v;
                            cands.push(c);
                        }
                    }
                yield;
                cands.sort((a, b) => b.base - a.base || a.order - b.order);
                let best = null;
                for (const strict of [true, false]) {
                    for (const c of cands) {
                        if (best && c.base + 0.3 + 0.225 + 0.35 <= best.score) break;
                        yield;
                        if (this.check(c, strict) && (!best || c.score > best.score || c.score === best.score && c.order < best.order)) best = c;
                    }
                    if (best) break;
                }
                if (!best) {
                    const R = rng(this.seed, idx, 99);
                    best = { type: "chase", t0, ...this.rideParams("chase", 0, R), ...this.chooseEnd(t0, hardEnd, R) };
                }
                this.push(best);
                yield;
            }
        }

        push(shot) {
            this.linkBlend(shot);
            this.curves(shot);
            this.shots.push(shot);
        }

        // A camera riding with the car swoops in from the one before it if that rode along too.
        linkBlend(shot) {
            const prev = this.shots[this.shots.length - 1];
            shot.blend = shot.prev = null;
            if (prev && RIDE.has(prev.type) && RIDE.has(shot.type) && !shot.end && isFinite(shot.t1)) {
                const R = rng(this.seed, this.shots.length, 77);
                shot.blend = Math.min(0.9 + R() * 0.7, 0.45 * (shot.t1 - shot.t0));
                shot.prev = prev;
            }
        }

        intro() {
            const R = rng(this.seed, 0, 1);
            const side = R() < 0.5 ? -1 : 1;
            const shot = { type: "orbit", t0: 0, t1: 3.2, dist: 8, h: 3, h1: 1.6, theta: side * Math.PI * 0.8, omega: -side * 0.5, fov: 55 };
            return this.check(shot, false) ? shot : { type: "chase", t0: 0, t1: 3.2, d: 6, h: 1.5, s: 0, high: false };
        }

        finishShot(finish) {
            const P = this.path, w = this.w, up = this.c.up;
            const Q = P.pos(finish, w[0]).clone();
            const Tq = P.heading(finish, 6, w[1]).clone();
            const N = w[2].crossVectors(Tq, up).normalize().clone();
            const side = rng(this.seed, 1e5)() < 0.5 ? -1 : 1;
            for (const sd of [side, -side]) {
                const C = Q.clone().addScaledVector(N, sd * 7).addScaledVector(up, 2.4).addScaledVector(Tq, 16);
                let bad = 0;
                for (const dt of [0, 0.8, 1.6]) {
                    if (finish + dt > P.end) continue;
                    if (this.c.hides(C, P.pos(finish + dt, w[3]).addScaledVector(up, 0.6))) bad++;
                }
                if (bad === 0) return { type: "finish", t0: finish, t1: Infinity, cam: C };
            }
            return { type: "orbit", end: true, t0: finish, t1: Infinity, dist: 7.5, h: 1.8, theta: 0.6, omega: 0.22, fov: 50 };
        }

        // A shot's shape, plus a phase for its camera shake and, for some, a slow Dutch tilt.
        rideParams(type, v, R) {
            const p = this.rideShape(type, v, R);
            p.ph = R() * 1000;
            if (type !== "chase" && type !== "pack" && R() < 0.6) p.dutch = (R() < 0.5 ? -1 : 1) * (0.03 + R() * 0.05);
            return p;
        }

        rideShape(type, v, R) {
            const side = R() < 0.5 ? -1 : 1;
            switch (type) {
            case "chase":
                return { d: 5.2 + R() * 1.6, h: 1.25 + R() * 0.6, s: (R() - 0.5) * 1.6, high: v === 1 };
            case "orbit":
                return { dist: 6.2 + R() * 2, h: 1.2 + R() * 1.2, theta: side * (0.5 + R() * 1.4), omega: -side * (0.25 + R() * 0.2), fov: 52 + R() * 8 };
            case "heli":
                return { back: 10 + R() * 5, up: 5 + R() * 3, s: side * R() * 5 };
            case "side":
                return { side: v === 0 ? -1 : 1, dist: 6.5 + R() * 2.5, h: 0.9 + R() * 1.1, lead0: -3 + R() * 2, lead1: 1 + R() * 3 };
            case "front":
                return { dist: 7 + R() * 3, h: 0.8 + R() * 0.9, s: side * (0.6 + R() * 1.6) };
            case "pack":
                return { back: 7 + R() * 3, up: 2.5 + R() * 2.5, s: side * R() * 4 };
            }
            return {};
        }

        // Good places to cut: just before a corner or a jump, just after a landing or a checkpoint.
        cuts(lo, hi) {
            const out = [];
            const add = (t) => {
                if (t > lo && t < hi) out.push(t);
            };
            for (const e of this.path.events) {
                if (e.type === "corner") {
                    add(e.t0 - 0.35);
                    add(e.t1 + 0.15);
                } else {
                    add(e.t0 - 0.5);
                    add(e.t1 + 0.35);
                }
            }
            for (const c of this.run.checkpointTimes) add(c.numberOfFrames / 1000 + 0.05);
            return out.sort((a, b) => a - b);
        }

        chooseEnd(t0, hardEnd, R) {
            if (hardEnd - t0 < 3.7) return { t1: hardEnd, aligned: 1 };
            const lo = t0 + 2.2, hi = Math.min(t0 + 6.5, hardEnd - 1.5);
            if (hi <= lo) return { t1: hardEnd, aligned: 1 };
            let best = { t1: Math.min(t0 + 3.6 + R() * 1.4, hi), aligned: 0 };
            let bestS = durFit(best.t1 - t0);
            for (const c of this.cuts(lo, hi)) {
                const s = durFit(c - t0) + 0.3;
                if (s > bestS) {
                    bestS = s;
                    best = { t1: c, aligned: 1 };
                }
            }
            return best;
        }

        enclosed(t) {
            const key = Math.round(t * 4);
            let v = this.encl.get(key);
            if (null == v) {
                const from = this.path.pos(key / 4, this.w[4]).addScaledVector(this.c.up, 1);
                v = this.c.blocked(from, this.w[5].copy(from).addScaledVector(this.c.up, 15), 0) ? 1 : 0;
                this.encl.set(key, v);
            }
            return v;
        }

        battle(t) {
            const key = Math.round(t * 10);
            let v = this.bat.get(key);
            if (null == v) {
                v = 0;
                const P = this.path.pos(key / 10, this.w[4]);
                for (const r of this.runs)
                    if (r !== this.run && this.c.pathOf(r).pos(key / 10, this.w[5]).distanceTo(P) < 12) {
                        v = 1;
                        break;
                    }
                this.bat.set(key, v);
            }
            return v;
        }

        // Other cars near the followed one at time t, counted with soft weights (0 at 45 u, 1 at 25 u).
        group(t) {
            const key = Math.round(t * 10);
            let v = this.grp.get(key);
            if (null == v) {
                v = 0;
                const P = this.path.pos(key / 10, this.w[4]);
                for (const r of this.runs)
                    if (r !== this.run) v += clamp((45 - this.c.pathOf(r).pos(key / 10, this.w[5]).distanceTo(P)) / 20, 0, 1);
                this.grp.set(key, v);
            }
            return v;
        }

        // Whether most of the group around the followed car is behind it over a stretch.
        packFront(a, b) {
            let ahead = 0, behind = 0;
            const H = this.w[3], P = this.w[4], q = this.w[5];
            for (let t = a; t <= b; t += 0.25) {
                this.path.heading(t, 4.5, H);
                this.path.pos(t, P);
                for (const r of this.runs) {
                    if (r === this.run) continue;
                    this.c.pathOf(r).pos(t, q);
                    if (q.distanceTo(P) > 40) continue;
                    const along = q.sub(P).dot(H);
                    if (along > 3) ahead++;
                    else if (along < -3) behind++;
                }
            }
            return behind >= 2 && behind > ahead * 1.3;
        }

        features(a, b) {
            let n = 0, spd = 0, yaw = 0, air = 0, bat = 0, enc = 0, grp = 0;
            const P = this.path;
            for (let t = a; t <= b; t += 0.1, n++) {
                const i = Math.round(t / DT);
                spd += P.spd[Math.min(i, P.n - 1)];
                yaw += Math.abs(P.yawRaw(i));
                air += P.air[Math.min(i, P.n - 1)];
                bat += this.runs.length > 1 ? this.battle(t) : 0;
                grp += this.runs.length > 1 ? this.group(t) : 0;
                enc += this.enclosed(t);
            }
            n = Math.max(1, n);
            return { spd: spd / n, yaw: yaw / n, air: air / n, bat: bat / n, grp: grp / n, enc: enc / n };
        }

        suitability(type, f, anchored) {
            const yawN = clamp(f.yaw / 1.2, 0, 1);
            switch (type) {
            case "chase": return 0.5 + 0.4 * f.enc + 0.15 * yawN;
            case "orbit": return 0.42 + (f.spd < 170 ? 0.25 : 0) - 0.35 * f.enc;
            case "heli": return 0.38 + 0.2 * yawN - 0.8 * f.enc;
            case "side": return 0.42 + 0.55 * f.air + (f.spd > 200 && f.yaw < 0.4 ? 0.2 : 0) - 0.4 * f.enc;
            case "front": return 0.38 + (f.yaw < 0.35 ? 0.15 : 0) - 0.3 * yawN - 0.4 * f.enc;
            case "pack": return f.grp < 0.6 ? -9 : 0.3 + 0.12 * Math.min(f.grp, 5) - 0.3 * f.enc;
            case "tele": return 0.6 + 0.25 * anchored - 0.8 * f.enc;
            case "curb": return 0.48 + 0.3 * anchored - 0.8 * f.enc;
            }
            return 0;
        }

        // Everything but visibility, which costs rays and is checked only for the best few.
        candidate(type, v, R, t0, hardEnd) {
            if (hardEnd - t0 < 0.6) return null;
            let shot;
            if (RIDE.has(type)) {
                shot = { type, t0, ...this.rideParams(type, v, R), ...this.chooseEnd(t0, hardEnd, R) };
                if (type === "pack") shot.front = this.packFront(t0, shot.t1);
            }
            else {
                shot = this.fixedShot(type, v, R, t0, hardEnd);
                if (!shot) return null;
            }
            const f = this.features(t0, shot.t1);
            const recent = this.shots.slice(-4).map((s) => s.type);
            let base = this.suitability(type, f, shot.anchored ? 1 : 0) + 0.25 * this.fit(shot) + 0.2 * (shot.aligned ?? 0);
            // Spread the edit over every kind of shot.
            base -= 0.3 * this.shots.filter((s) => s.type === type).length / Math.max(1, this.shots.length);
            if (recent[recent.length - 2] === type) base -= 0.2;
            if (recent[recent.length - 3] === type) base -= 0.1;
            const rideRun = recent.slice(-2).every((t) => RIDE.has(t));
            if (!RIDE.has(type) && rideRun) base += 0.2;
            if (RIDE.has(type) && recent.length && !RIDE.has(recent[recent.length - 1])) base += 0.1;
            base += R() * 0.18;
            shot.base = base;
            return base > -1 ? shot : null;
        }

        // Fixed cameras hold for about 3 s, cameras riding along for about 4 s.
        fit(shot) {
            const d = shot.t1 - shot.t0;
            return RIDE.has(shot.type) ? durFit(d) : clamp(1 - Math.abs(d - 3) / 2.5, 0, 1);
        }

        // A camera fixed beside the track, aimed so the car comes towards it and past.
        fixedShot(type, v, R, t0, hardEnd) {
            const P = this.path, w = this.w, up = this.c.up;
            const [minArc, maxArc] = type === "tele" ? [70, 140] : [26, 48];
            let arc = 0, tMin = null, tMax = null;
            P.pos(t0, w[0]);
            for (let t = t0 + 0.05; t <= Math.min(t0 + 3.2, hardEnd - 0.6); t += 0.05) {
                P.pos(t, w[1]);
                arc += w[1].distanceTo(w[0]);
                w[0].copy(w[1]);
                if (t < t0 + 0.8) continue;
                if (arc >= minArc && null == tMin) tMin = t;
                if (arc <= maxArc) tMax = t;
            }
            if (null == tMin || null == tMax || tMax < tMin) return null;
            let ta = (tMin + tMax) / 2, ev = null;
            for (const e of P.events) {
                const at = e.type === "corner" ? e.apex : e.t0;
                if (at >= tMin && at <= tMax && (type === "curb" || e.type === "corner")) {
                    ev = e;
                    ta = at;
                    break;
                }
            }
            const Q = P.pos(ta, w[2]).clone();
            const Tq = P.heading(ta, 8, w[3]).clone();
            const N = new this.c.T.Vector3().crossVectors(Tq, up).normalize();
            // N x yaw-sign points to the inside of a turn.
            const inside = ev?.type === "corner" ? ev.dir : (R() < 0.5 ? -1 : 1);
            const sd = type === "tele" ? (v === 0 ? -inside : inside) : (v === 0 ? inside : -inside);
            const C = Q.clone();
            if (type === "tele")
                C.addScaledVector(N, sd * (7 + R() * 5)).addScaledVector(up, 1.8 + R() * 3).addScaledVector(Tq, 2 + R() * 6);
            else
                C.addScaledVector(N, sd * (4 + R() * 1.6)).addScaledVector(up, 0.5 + R() * 0.5).addScaledVector(Tq, R() * 4 - 1);
            let dmin = Infinity, t1 = null;
            for (let t = t0; t <= hardEnd; t += 0.05) {
                const d = C.distanceTo(P.pos(t, w[4]));
                dmin = Math.min(dmin, d);
                if (t >= ta && (d > dmin + (type === "tele" ? 45 : 24) || t >= ta + (type === "tele" ? 3 : 2))) {
                    t1 = t;
                    break;
                }
            }
            if (null == t1) t1 = hardEnd;
            if (hardEnd - t1 < 1) t1 = hardEnd;
            if (dmin < 3) return null;
            return { type, t0, t1, cam: C, ta, anchored: !!ev, aligned: ev ? 1 : 0, fov: type === "tele" ? null : 74, ph: R() * 1000 };
        }

        // Visibility: fixed cameras need a clear line to the car nearly all the time; cameras
        // riding with the car must not need pulling in towards it (that reads as a sudden zoom),
        // so a shot that would run into a wall ends early and hands over to the next one.
        check(shot, strict) {
            const P = this.path, w = this.w, up = this.c.up;
            const step = 0.15;
            if (RIDE.has(shot.type)) this.linkBlend(shot);
            if (!RIDE.has(shot.type)) {
                let ok = 0, n = 0;
                for (let t = shot.t0; t <= shot.t1 + 1e-6; t += step, n++)
                    if (!this.c.hides(shot.cam, P.pos(t, w[0]).addScaledVector(up, 0.6))) ok++;
                const anchorOk = !this.c.hides(shot.cam, P.pos(shot.ta, w[0]).addScaledVector(up, 0.6));
                shot.vis = ok / Math.max(1, n);
                if (!anchorOk || shot.vis < (strict ? 0.9 : 0.75)) return false;
            } else {
                const limit = strict ? 0.75 : 0.4;
                let sum = 0, n = 0;
                for (let t = shot.t0; t <= shot.t1 + 1e-6; t += step) {
                    const want = this.want(shot, t);
                    // Something crossing the view for a moment (a gate, a pillar) doesn't count.
                    if (want < limit && t + 2 * step <= shot.t1 && (this.want(shot, t + step) >= limit || this.want(shot, t + 2 * step) >= limit)) {
                        sum += 1;
                        n++;
                        continue;
                    }
                    if (want < limit) {
                        if (t - shot.t0 >= 2.2) {
                            shot.t1 = t - step;
                            shot.aligned = 0;
                            this.linkBlend(shot);
                            shot.base += 0.25 * (this.fit(shot) - 1) - 0.2;
                            break;
                        }
                        return false;
                    }
                    sum += want;
                    n++;
                }
                shot.vis = sum / Math.max(1, n);
            }
            shot.comp = this.composition(shot);
            if (strict && shot.comp < 0.12) return false;
            const cover = this.coverage(shot);
            shot.cover = cover ? cover.frac : null;
            shot.score = shot.base + 0.3 * shot.vis + 0.45 * (shot.comp - 0.5) + (cover ? 0.35 * cover.frac * Math.min(1, cover.near / 2) : 0);
            return true;
        }

        // Share of the cars near the followed one that the shot keeps in frame, nearer ones
        // counting more, and how many cars that is about. Null with nobody near.
        coverage(shot) {
            if (this.runs.length < 2) return null;
            const c = this.c, up = c.up, T = c.T;
            const fwd = this.vf ??= new T.Vector3(), right = this.vr ??= new T.Vector3(), cu = this.vu ??= new T.Vector3();
            const q = this.vq ??= new T.Vector3(), from = this.vp ??= new T.Vector3();
            const span = (isFinite(shot.t1) ? shot.t1 : shot.t0 + 3) - shot.t0;
            let seen = 0, near = 0, samples = 0;
            for (const k of [0.3, 0.75]) {
                const t = shot.t0 + span * k;
                const P = this.path.pos(t, this.w[1]);
                const view = c.viewOf(shot, t, P, this.path, this.view, this.view2, false);
                from.copy(view.pos);
                fwd.subVectors(view.look, from).normalize();
                right.crossVectors(fwd, up);
                if (right.lengthSq() < 1e-6) continue;
                right.normalize();
                cu.crossVectors(right, fwd);
                const tv = Math.tan(view.fov * Math.PI / 360), th = tv * 16 / 9;
                samples++;
                for (const r of this.runs) {
                    if (r === this.run) continue;
                    c.pathOf(r).pos(t, q);
                    const d = q.distanceTo(P);
                    if (d > 60) continue;
                    const wt = 1 - d / 60;
                    near += wt;
                    q.sub(from);
                    const z = q.dot(fwd);
                    if (z > 1 && Math.abs(q.dot(right) / (z * th)) < 0.92 && Math.abs(q.dot(cu) / (z * tv)) < 0.92) seen += wt;
                }
            }
            return near > 0 && samples ? { frac: seen / near, near: near / samples } : null;
        }

        // How much of the upper frame shows walls, scenery or sky rather than flat road or ground
        // (0..1). A camera looking down at an empty surface has no sense of place or speed.
        composition(shot) {
            const c = this.c, up = c.up, w = this.w, T = c.T;
            const fwd = this.cf ??= new T.Vector3(), right = this.cr ??= new T.Vector3(), cu = this.cu ??= new T.Vector3();
            const dir = this.cd ??= new T.Vector3(), to = this.ct ??= new T.Vector3(), from = this.cfrom ??= new T.Vector3();
            const span = (isFinite(shot.t1) ? shot.t1 : shot.t0 + 3) - shot.t0;
            let sum = 0, n = 0;
            for (const k of [0.3, 0.8]) {
                const t = shot.t0 + span * k;
                const P = this.path.pos(t, w[1]);
                const view = c.viewOf(shot, t, P, this.path, this.view, this.view2, false);
                from.copy(view.pos);
                fwd.subVectors(view.look, from).normalize();
                right.crossVectors(fwd, up);
                if (right.lengthSq() < 1e-6) continue;
                right.normalize();
                cu.crossVectors(right, fwd);
                const tv = Math.tan(view.fov * Math.PI / 360), th = tv * 16 / 9;
                for (const v of [0.35, 0.85])
                    for (const u of [-0.7, 0, 0.7]) {
                        dir.copy(fwd).addScaledVector(right, u * th).addScaledVector(cu, v * tv).normalize();
                        const hit = c.hitDistance(from, to.copy(from).addScaledVector(dir, 300), 0);
                        if (null == hit) sum += v > 0.5 ? 0.7 : 0.45;
                        else if (!(c.hitNormal.y > 0.85 && Math.abs(from.y + dir.y * hit - P.y) < 2.5)) sum += 1;
                        n++;
                    }
            }
            return n ? sum / n : 0.5;
        }

        // How far the camera can stay from the car before something is in the way (1 = all of it).
        want(shot, t) {
            const P = this.path.pos(t, this.w[1]);
            const view = this.c.viewOf(shot, t, P, this.path, this.view, this.view2, false);
            const from = this.w[2].copy(P).addScaledVector(this.c.up, 0.8);
            const hit = this.c.occluder(from, view.pos, 0.3);
            return null == hit ? 1 : clamp((hit - 0.4) / from.distanceTo(view.pos), 0.15, 1);
        }

        // Per-shot curves the camera reads at playback: how far to pull in (a look-ahead minimum,
        // smoothed, so any pull starts early and is gradual) and the telephoto zoom.
        curves(shot) {
            if (!isFinite(shot.t1)) return;
            const up = this.c.up, P = this.path;
            if (RIDE.has(shot.type)) {
                const dt = 0.1, n = Math.max(2, Math.ceil((shot.t1 - shot.t0) / dt) + 1);
                const want = new Float32Array(n);
                for (let i = 0; i < n; i++) {
                    const t = shot.t0 + i * dt;
                    const Pt = P.pos(t, this.w[1]);
                    const view = this.c.viewOf(shot, t, Pt, P, this.view, this.view2, false);
                    const from = this.w[2].copy(Pt).addScaledVector(up, 0.8);
                    const hit = this.c.occluder(from, view.pos, 0.3);
                    want[i] = null == hit ? 1 : clamp((hit - 0.4) / from.distanceTo(view.pos), 0.15, 1);
                }
                // Anything in the way for under 0.6 s is passing the lens, not a wall: no pull for it.
                for (let i = 0; i < n;) {
                    if (want[i] >= 0.98) {
                        i++;
                        continue;
                    }
                    let j = i;
                    while (j < n && want[j] < 0.98) j++;
                    if (j - i < 6) want.fill(1, i, j);
                    i = j;
                }
                const v = new Float32Array(n);
                for (let i = 0; i < n; i++) {
                    let m = 1;
                    for (let j = Math.max(0, i - 1); j <= Math.min(n - 1, i + 6); j++) m = Math.min(m, want[j]);
                    v[i] = m;
                }
                for (let pass = 0; pass < 2; pass++) {
                    const c = v.slice();
                    for (let i = 0; i < n; i++) {
                        let s = 0, k = 0;
                        for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++, k++) s += c[j];
                        v[i] = Math.min(c[i], s / k);
                    }
                }
                shot.pull = v.some((x) => x < 0.999) ? { t0: shot.t0, dt, v } : null;
            } else if (shot.type === "tele") {
                const dt = 0.05, n = Math.ceil((shot.t1 - shot.t0) / dt) + 1;
                const ld = new Float32Array(n);
                for (let i = 0; i < n; i++) ld[i] = Math.log(Math.max(0.5, shot.cam.distanceTo(P.pos(shot.t0 + i * dt, this.w[1]))));
                const v = new Float32Array(n);
                for (let i = 0; i < n; i++) {
                    let s = 0, ws = 0;
                    for (let j = Math.max(0, i - 10); j <= Math.min(n - 1, i + 10); j++) {
                        const g = Math.exp(-(((j - i) * dt) ** 2) / (2 * 0.2 * 0.2));
                        s += g * ld[j];
                        ws += g;
                    }
                    v[i] = clamp(2 * Math.atan(2.4 / Math.exp(s / ws)) * 180 / Math.PI, 14, 50);
                }
                shot.fovC = { t0: shot.t0, dt, v };
            }
        }
    }

    function curveAt(c, t) {
        const f = clamp((t - c.t0) / c.dt, 0, c.v.length - 1);
        const i = Math.floor(f), j = Math.min(i + 1, c.v.length - 1);
        return c.v[i] + (c.v[j] - c.v[i]) * (f - i);
    }

    const MIN_VIEW_DISTANCE = 3.5;

    // Scroll to zoom, drag to look around, for the normal and the cinematic camera. In cinematic
    // mode the offset eases back to the director's framing a few seconds after you let go.
    class Viewer {
        constructor(cine) {
            const T = cine.T;
            this.c = cine;
            this.yaw = this.pitch = this.zoom = 0;
            this.tYaw = this.tPitch = this.tZoom = 0;
            this.lastInput = -1e9;
            this.drag = null;
            this.qa = new T.Quaternion();
            this.qb = new T.Quaternion();
            this.axis = new T.Vector3();
            this.rel = new T.Vector3();
            this.basePos = new T.Vector3();
            this.baseQuat = new T.Quaternion();
            this.baseFov = 60;
            this.wPos = new T.Vector3();
            this.wQuat = new T.Quaternion();
            this.wFov = 0;
            this.wCam = null;
            const canvas = this.canvas = cine.o.render.canvas;
            this.onWheel = (e) => {
                if (!this.active()) return;
                e.preventDefault();
                const steps = clamp(Math.abs(e.deltaY) / 100, 0.25, 3) * Math.sign(e.deltaY);
                this.tZoom = clamp(this.tZoom + steps * 0.2, -1.6, 2.2);
                this.lastInput = performance.now();
            };
            this.onDown = (e) => {
                if (e.button !== 0 || !this.active()) return;
                this.drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
                this.lastInput = performance.now();
            };
            this.onMove = (e) => {
                if (!this.drag || e.pointerId !== this.drag.id) return;
                const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
                this.drag.x = e.clientX;
                this.drag.y = e.clientY;
                this.tYaw -= dx * 0.006;
                this.tPitch = clamp(this.tPitch + dy * 0.005, -1.2, 1.3);
                this.lastInput = performance.now();
            };
            this.onUp = (e) => {
                if (this.drag && e.pointerId === this.drag.id) this.drag = null;
            };
            this.onDbl = () => {
                if (this.active()) this.tYaw = this.tPitch = this.tZoom = 0;
            };
            canvas?.addEventListener("wheel", this.onWheel, { passive: false });
            canvas?.addEventListener("pointerdown", this.onDown);
            canvas?.addEventListener("dblclick", this.onDbl);
            window.addEventListener("pointermove", this.onMove);
            window.addEventListener("pointerup", this.onUp);
        }

        active() {
            return !this.c.o.isSpectator() && !window.__PolyFX?.photo?.active;
        }

        reset() {
            this.yaw = this.pitch = this.zoom = this.tYaw = this.tPitch = this.tZoom = 0;
        }

        tick(dt) {
            if (this.c.enabled && !this.drag && performance.now() - this.lastInput > 2500) {
                const k = damp(1.2, dt);
                this.tYaw -= this.tYaw * k;
                this.tPitch -= this.tPitch * k;
                this.tZoom -= this.tZoom * k;
            }
            const k = damp(12, dt);
            this.yaw += (this.tYaw - this.yaw) * k;
            this.pitch += (this.tPitch - this.pitch) * k;
            this.zoom += (this.tZoom - this.zoom) * k;
        }

        // Applies the offset on top of whatever the game or the director set this frame. If
        // nothing set the camera since last frame (e.g. after the finish), the stored base is reused.
        apply(cam, pivot, inPlace) {
            if (cam !== this.wCam || !cam.position.equals(this.wPos) || !cam.quaternion.equals(this.wQuat) || cam.fov !== this.wFov) {
                this.basePos.copy(cam.position);
                this.baseQuat.copy(cam.quaternion);
                this.baseFov = cam.fov;
            }
            const up = this.c.up;
            if (inPlace) {
                this.qa.setFromAxisAngle(up, this.yaw);
                this.qb.setFromAxisAngle(this.axis.set(1, 0, 0), -this.pitch * 0.6);
                cam.position.copy(this.basePos);
                cam.quaternion.copy(this.qa).multiply(this.baseQuat).multiply(this.qb);
                cam.fov = clamp(this.baseFov * Math.pow(2, this.zoom * 0.5), 15, 110);
            } else {
                const rel = this.rel.subVectors(this.basePos, pivot).applyAxisAngle(up, this.yaw);
                this.qa.setFromAxisAngle(up, this.yaw);
                const len = rel.length();
                this.axis.crossVectors(rel, up);
                if (len > 1e-3 && this.axis.lengthSq() > 1e-6) {
                    this.axis.normalize();
                    const elev = Math.asin(clamp(rel.y / len, -1, 1));
                    const target = this.pitch > 0 ? Math.min(elev + this.pitch, Math.max(elev, 1.45)) : Math.max(elev + this.pitch, Math.min(elev, -0.05));
                    const ang = target - elev;
                    rel.applyAxisAngle(this.axis, ang);
                    this.qb.setFromAxisAngle(this.axis, ang);
                } else this.qb.identity();
                // Zooming in stops about a car length from the car (or where the camera already is,
                // if that is closer), and the scroll target stops there too so zooming out answers at once.
                const minZoom = Math.min(0, Math.log2(MIN_VIEW_DISTANCE / Math.max(len, 1e-3)));
                this.tZoom = Math.max(this.tZoom, minZoom);
                this.zoom = Math.max(this.zoom, minZoom);
                cam.position.copy(pivot).addScaledVector(rel, Math.pow(2, this.zoom));
                cam.quaternion.copy(this.qb).multiply(this.qa).multiply(this.baseQuat);
                cam.fov = this.baseFov;
            }
            cam.updateProjectionMatrix();
            cam.updateMatrixWorld();
            this.wCam = cam;
            this.wPos.copy(cam.position);
            this.wQuat.copy(cam.quaternion);
            this.wFov = cam.fov;
        }

        dispose() {
            this.canvas?.removeEventListener("wheel", this.onWheel);
            this.canvas?.removeEventListener("pointerdown", this.onDown);
            this.canvas?.removeEventListener("dblclick", this.onDbl);
            window.removeEventListener("pointermove", this.onMove);
            window.removeEventListener("pointerup", this.onUp);
        }
    }

    // With many ghosts each car costs ~20 draw calls, twice over with its shadow, and most of that
    // adds nothing: ghosts stacked in one spot, a few pixels tall, or too small to show their rims
    // and suspension. So: stacked and tiny ghosts are hidden; small ones drop the exhaust and
    // suspension and draw each wheel (then the body) in one material; only the followed car and
    // the nearest few ghosts cast shadows or make sound, and only the first 16 runs leave skid marks
    // (they all drive the same line). `cars` are the cars the caller is
    // showing this frame; this only ever hides or simplifies some of them.
    const LOD_SHADOWS = 6;
    const LOD_AUDIBLE = 8;
    const LOD_SKID_RUNS = 16;
    const lodState = new WeakMap();
    const lodParts = new WeakMap();
    let lodScratch = null;

    function partsOf(car) {
        let parts = lodParts.get(car);
        if (!parts) {
            parts = { meshes: [], casters: [], extras: [], multi: [] };
            car.object3D?.traverse((m) => {
                if (!m.isMesh) return;
                parts.meshes.push(m);
                if (m.castShadow) parts.casters.push(m);
                if (/^(Exhaust|Suspension)/.test(m.name)) parts.extras.push(m);
                else if (Array.isArray(m.material) && m.material.length > 1) parts.multi.push({ mesh: m, materials: m.material, wheel: /^Wheel/.test(m.name) });
            });
            lodParts.set(car, parts);
        }
        return parts;
    }

    function setCastShadow(car, on) {
        for (const m of partsOf(car).casters) m.castShadow = on;
    }

    // The game draws every car mesh even when it is off screen. Ghosts are culled like the rest
    // of the scene, with a margin on the bounds so nothing pops at the edge of the screen.
    function setCulling(car, on) {
        for (const m of partsOf(car).meshes) {
            if (on) {
                const g = m.geometry;
                if (null == g.boundingSphere) g.computeBoundingSphere();
                if (!g.userData.nswsPadded) {
                    g.boundingSphere.radius += 1;
                    g.userData.nswsPadded = true;
                }
            }
            m.frustumCulled = on;
        }
    }

    // Detail 0 = full, 1 = no exhaust or suspension and one material per wheel, 2 = one material
    // for the body too. A mesh given a single material is drawn in one call, whatever its groups.
    function setDetail(car, level) {
        const parts = partsOf(car);
        for (const m of parts.extras) m.visible = level === 0;
        for (const p of parts.multi) {
            const single = p.wheel ? level >= 1 : level >= 2;
            if (single && p.mesh.material === p.materials) p.mesh.material = p.materials[0];
            else if (!single && p.mesh.material !== p.materials) {
                // Fading may have changed the one material in use; carry it over.
                for (const mat of p.materials) {
                    mat.opacity = p.materials[0].opacity;
                    if (mat.transparent !== p.materials[0].transparent) {
                        mat.transparent = p.materials[0].transparent;
                        mat.needsUpdate = true;
                    }
                }
                p.mesh.material = p.materials;
            }
        }
    }

    function ghostLod(cars, focusCar, cam, stackRadius = 1) {
        if (!cam || !cars.length) return;
        const camPos = lodScratch ??= cam.position.clone();
        cam.getWorldPosition(camPos);
        const pxPerUnit = window.innerHeight / (2 * Math.tan(cam.fov * Math.PI / 360) / (cam.zoom || 1));
        const list = [];
        cars.forEach((car, index) => {
            if (car === focusCar) return;
            const p = car.getPosition();
            list.push({ car, p, d: p.distanceTo(camPos), index });
        });
        list.sort((a, b) => a.d - b.d);
        const kept = [];
        let fp = null;
        if (focusCar) {
            fp = focusCar.getPosition();
            const st = lodState.get(focusCar);
            if (st) {
                if (!st.cast) setCastShadow(focusCar, true);
                if (st.detail) setDetail(focusCar, 0);
                if (st.mute) focusCar.audioCulled = false;
                if (st.culled) setCulling(focusCar, false);
                if (st.noSkid) focusCar.skidmarksSuppressed = false;
            }
            lodState.set(focusCar, { vis: true, cast: true, detail: 0, mute: false, culled: false, noSkid: false });
        }
        let shadows = 0, audible = 0;
        for (const g of list) {
            const st = lodState.get(g.car) ?? { vis: true, cast: true, detail: 0, mute: false, culled: false, noSkid: false };
            // Every test has hysteresis, so a ghost near a threshold doesn't flicker.
            const px = 4.5 * pxPerUnit / Math.max(g.d, 0.1);
            let vis = px >= (st.vis ? 5 : 7);
            if (vis && fp && g.p.distanceTo(fp) < stackRadius * (st.vis ? 1 : 1.3)) vis = false;
            if (vis)
                for (const k of kept)
                    if (k.distanceTo(g.p) < (st.vis ? 1 : 1.4)) {
                        vis = false;
                        break;
                    }
            if (vis) kept.push(g.p);
            const cast = vis && shadows < LOD_SHADOWS;
            if (cast) shadows++;
            const mute = !(vis && audible < LOD_AUDIBLE);
            if (!mute) audible++;
            const detail = px >= (st.detail === 0 ? 50 : 60) ? 0 : px >= (st.detail === 2 ? 26 : 22) ? 1 : 2;
            if (g.car.object3D && g.car.object3D.visible !== vis) g.car.setVisible(vis);
            if (cast !== st.cast) setCastShadow(g.car, cast);
            if (vis && detail !== st.detail) setDetail(g.car, detail);
            if (mute !== st.mute) g.car.audioCulled = mute;
            if (!st.culled) setCulling(g.car, true);
            // A ghost keeps the place it had when first seen, so finished ghosts dropping out of
            // the list never change which marks are drawn.
            const order = st.order ?? g.index;
            const noSkid = Math.max(cars.length, st.total ?? 0) > LOD_SKID_RUNS && order >= LOD_SKID_RUNS;
            if (noSkid !== st.noSkid) g.car.skidmarksSuppressed = noSkid;
            lodState.set(g.car, { vis, cast, detail: vis ? detail : st.detail, mute, culled: true, noSkid, order, total: Math.max(cars.length, st.total ?? 0) });
        }
    }

    function resetGhostLod(cars) {
        for (const car of cars) {
            const st = lodState.get(car);
            if (!st) continue;
            if (!st.vis) car.setVisible(true);
            if (!st.cast) setCastShadow(car, true);
            if (st.detail) setDetail(car, 0);
            if (st.mute) car.audioCulled = false;
            if (st.culled) setCulling(car, false);
            if (st.noSkid) car.skidmarksSuppressed = false;
            lodState.delete(car);
        }
    }

    window.__nswsGhostLod = ghostLod;

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
            this.pivot = new T.Vector3();
            this.rayDir = new T.Vector3();
            this.hitNormal = new T.Vector3(0, 1, 0);
            this.oDir = new T.Vector3();
            this.oRight = new T.Vector3();
            this.oUp = new T.Vector3();
            this.oA = new T.Vector3();
            this.oB = new T.Vector3();
            this.e = [0, 1, 2, 3, 4, 5].map(() => new T.Vector3());
            this.paths = new Map();
            this.planners = new Map();
            this.viewer = new Viewer(this);
            const view = () => ({ pos: new T.Vector3(), look: new T.Vector3(), up: new T.Vector3(0, 1, 0), fov: 60, roll: 0, lens: 0.45, moving: true });
            this.viewA = view();
            this.viewB = view();
            this.shot = null;
            this.lastT = null;
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

            // Input display on or off while watching, remembered on this device.
            this.inputsBtn = document.createElement("button");
            this.inputsBtn.className = "button nsws-watch-inputs";
            this.inputsBtn.title = "Input display";
            this.inputsBtn.innerHTML = '<svg viewBox="0 0 24 24"><g fill="#fff"><rect x="9" y="3" width="6" height="6" rx="1"/><rect x="2" y="11" width="6" height="6" rx="1"/><rect x="9" y="11" width="6" height="6" rx="1"/><rect x="16" y="11" width="6" height="6" rx="1"/></g></svg>';
            let showInputs = true;
            try {
                showInputs = localStorage.getItem("nsws_watch_inputs") !== "0";
            } catch (e) {}
            const applyInputs = () => {
                this.inputsBtn.classList.toggle("off", !showInputs);
                document.body.classList.toggle("nsws-hide-inputs", !showInputs);
            };
            applyInputs();
            this.inputsBtn.addEventListener("click", () => {
                o.playClick?.();
                showInputs = !showInputs;
                try {
                    localStorage.setItem("nsws_watch_inputs", showInputs ? "1" : "0");
                } catch (e) {}
                applyInputs();
            });

            this.saveBtn = document.createElement("button");
            this.saveBtn.className = "button nsws-watch-save";
            this.saveBtn.title = "Save video";
            this.saveBtn.innerHTML = '<img src="images/save.svg">';
            this.saveBtn.addEventListener("click", () => {
                o.playClick?.();
                this.rec ? this.stopRecording() : this.startRecording();
            });
            this.onRecKey = (e) => {
                if (this.rec && e.code === "Escape") {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    this.stopRecording();
                }
            };
            window.addEventListener("keydown", this.onRecKey, true);

            const bar = o.uiElement.querySelector(".time-bar-ui");
            const seek = bar?.querySelector(":scope > .bar");
            for (const b of [this.button, this.inputsBtn, this.saveBtn, this.bright]) {
                if (seek) bar.insertBefore(b, seek);
                else bar?.appendChild(b);
            }
        }

        setEnabled(on) {
            on = !!on;
            if (on === this.enabled) return;
            this.enabled = on;
            this.button.classList.toggle("on", on);
            window.__nswsCinematic.current = on ? this : null;
            document.body.classList.toggle("nsws-cine-on", on);
            this.viewer.reset();
            if (on) {
                this.buildLayer();
                this.lastPassed = -1;
                this.meshesAt = -1e9;
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
            this.inputsBtn.remove();
            this.saveBtn.remove();
            document.body.classList.remove("nsws-hide-inputs");
            window.removeEventListener("keydown", this.onRecKey, true);
            if (this.rec) this.stopRecording();
            this.viewer.dispose();
            resetGhostLod(this.o.getRuns().map((r) => r.car));
            this.resetOpacity();
            document.body.classList.remove("nsws-cine-on");
            if (window.__nswsCinematic.current === this) window.__nswsCinematic.current = null;
            window.__PolyFX?.setCinematic?.(null);
            this.enabled = false;
        }

        collectMeshes(runs, now) {
            if (now - this.meshesAt < 3) return;
            this.meshesAt = now;
            const T = this.T;
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
                // Cars and other small moving things never block a shot.
                if (sphere.radius < 4) return;
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
            const dir = this.rayDir.subVectors(to, from);
            const dist = dir.length();
            if (dist <= slack) return null;
            const ray = this.ray;
            ray.set(from, dir.divideScalar(dist));
            ray.near = 0;
            ray.far = dist - slack;
            let best = null;
            const take = () => {
                for (const h of this.hits)
                    if (h.distance <= ray.far && (null == best || h.distance < best)) {
                        best = h.distance;
                        if (h.face) this.hitNormal.copy(h.face.normal).transformDirection(this.probe.matrixWorld);
                    }
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

        // Like hitDistance, but thin things (a checkpoint pole, the top of a gate, a sign's edge)
        // don't count: four more rays offset around the first must mostly be blocked too.
        occluder(from, to, slack) {
            const hit = this.castRay(from, to, slack, false);
            if (null == hit) return null;
            const dir = this.oDir.subVectors(to, from).normalize();
            const right = this.oRight.crossVectors(dir, this.up);
            if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
            right.normalize();
            const up = this.oUp.crossVectors(right, dir).normalize();
            let blocked = 1;
            for (const [a, b] of [[1, 0], [-1, 0], [0, 0.6], [0, -0.6]]) {
                const f = this.oA.copy(from).addScaledVector(right, a).addScaledVector(up, b);
                const g = this.oB.copy(to).addScaledVector(right, a).addScaledVector(up, b);
                if (null != this.castRay(f, g, slack, true)) blocked++;
            }
            return blocked >= 3 ? hit : null;
        }

        // Whether a fixed camera loses sight of the car.
        hides(cam, target) {
            return null != this.occluder(cam, target, 1.5);
        }

        // Records the replay from the start to just after the followed run finishes, then saves it.
        // Capturing this tab keeps everything on screen (nametags, panels, input display) with the
        // bottom bar hidden; where tab capture isn't available it records the 3D view alone.
        async startRecording() {
            if (this.rec || this.recStarting) return;
            this.recStarting = true;
            let stream = null;
            try {
                stream = await navigator.mediaDevices?.getDisplayMedia?.({
                    video: { frameRate: 60, width: { ideal: Math.round(innerWidth * devicePixelRatio) }, height: { ideal: Math.round(innerHeight * devicePixelRatio) } },
                    audio: true,
                    preferCurrentTab: true,
                    selfBrowserSurface: "include",
                    surfaceSwitching: "exclude",
                    monitorTypeSurfaces: "exclude"
                }) ?? null;
            } catch (e) {
                stream = null;
            }
            if (!stream) {
                try {
                    stream = this.o.render.canvas.captureStream(60);
                } catch (e) {
                    this.recStarting = false;
                    return;
                }
            }
            const audio = stream.getAudioTracks().length > 0;
            const types = audio
                ? ["video/mp4;codecs=avc1.640028,mp4a.40.2", "video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4;codecs=avc1,opus", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm"]
                : ["video/mp4;codecs=avc1.640028", "video/mp4;codecs=avc1.42E01E", "video/mp4", "video/webm;codecs=vp9", "video/webm"];
            const mimeType = types.find((t) => window.MediaRecorder?.isTypeSupported?.(t));
            if (!mimeType) {
                for (const tr of stream.getTracks()) tr.stop();
                this.recStarting = false;
                return;
            }
            const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 10e6 });
            const chunks = [];
            const runs = this.o.getRuns();
            const run = runs[this.o.getFocus()];
            const finish = (run.settings.time?.numberOfFrames ?? 0) / 1000;
            const rec = this.rec = { recorder, stream, chunks, mimeType, end: Math.min(finish + 4, this.o.totalTime?.() ?? Infinity), name: run.settings.nickname ?? "run" };
            recorder.ondataavailable = (e) => {
                if (e.data.size) chunks.push(e.data);
            };
            recorder.onstop = () => this.saveRecording(rec);
            for (const tr of stream.getVideoTracks()) tr.addEventListener("ended", () => this.stopRecording());
            document.body.classList.add("nsws-recording");
            this.saveBtn.classList.add("on");
            this.o.restart?.();
            // Let the restart reach the screen before the first recorded frame.
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
            this.recStarting = false;
            if (this.rec === rec) recorder.start(1000);
        }

        stopRecording() {
            const rec = this.rec;
            if (!rec) return;
            this.rec = null;
            document.body.classList.remove("nsws-recording");
            this.saveBtn.classList.remove("on");
            if (rec.recorder.state !== "inactive") rec.recorder.stop();
            else this.saveRecording(rec);
            for (const tr of rec.stream.getTracks()) tr.stop();
        }

        saveRecording(rec) {
            if (rec.saved || !rec.chunks.length) return;
            rec.saved = true;
            const ext = rec.mimeType.startsWith("video/mp4") ? "mp4" : "webm";
            const blob = new Blob(rec.chunks, { type: rec.mimeType.split(";")[0] });
            const clean = (x) => String(x).replace(/[\\/:*?"<>|]+/g, "").trim();
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = clean((this.o.trackName ? this.o.trackName + " - " : "") + rec.name) + "." + ext;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        }

        pathOf(run) {
            let p = this.paths.get(run);
            if (!p) this.paths.set(run, p = new PathCache(run));
            return p;
        }

        // One plan per followed run. The seed comes from the track and the runs being watched, so
        // the same runs always get the same edit and different runs get a different one.
        plannerFor(runs, focus) {
            const run = runs[focus];
            let p = this.planners.get(run);
            if (!p) {
                const id = (r) => (r.settings.nickname ?? "") + ":" + (r.settings.time?.numberOfFrames ?? 0);
                const seed = hashString((this.o.trackId ?? this.o.trackName ?? "") + "|" + runs.map(id).join(",") + "|" + id(run));
                this.planners.set(run, p = new Planner(this, runs, focus, seed));
            }
            return p;
        }

        // Where a shot puts the camera at time t, from the path alone.
        evalShot(shot, t, P, path, out) {
            const up = this.up, e = this.e;
            const Hs = path.heading(t, LAMBDA[shot.type] ?? 4.5, e[0]);
            const right = e[1].crossVectors(Hs, up).normalize();
            const carUp = path.up(t, e[2]);
            const speed = path.speed(t);
            const span = isFinite(shot.t1) ? shot.t1 - shot.t0 : 3.2;
            const k = clamp((t - shot.t0) / Math.max(0.1, span), 0, 1);
            const pos = out.pos, look = out.look;
            out.fov = 60;
            out.roll = 0;
            out.lens = 0.45;
            out.moving = true;
            out.up.copy(up);
            switch (shot.type) {
            case "chase": {
                // The camera falls back as the car accelerates and closes in under braking.
                const acc = (speed - path.speed(t - 0.3)) / 0.3;
                const d = (shot.high ? shot.d + 3 : shot.d) + Math.min(speed, 600) * 0.006 + clamp(acc * 0.012, -1.2, 1.8);
                const h = shot.high ? shot.h + 2.2 : shot.h;
                pos.copy(P).addScaledVector(Hs, -d).addScaledVector(carUp, h).addScaledVector(right, shot.s);
                look.copy(P).addScaledVector(Hs, 3.5).addScaledVector(carUp, 0.55);
                out.fov = 62 + Math.min(speed, 500) * 0.03;
                out.roll = clamp(path.yawRate(t) * 0.05, -0.12, 0.12);
                out.lens = 0.4;
                out.up.copy(carUp);
                break;
            }
            case "orbit": {
                const back = e[3].copy(Hs).multiplyScalar(-1).applyAxisAngle(up, shot.theta + shot.omega * (t - shot.t0));
                const h = (null != shot.h1 ? shot.h + (shot.h1 - shot.h) * k * k * (3 - 2 * k) : shot.h) + 0.5 * Math.sin(Math.PI * k);
                pos.copy(P).addScaledVector(back, shot.dist).addScaledVector(up, h);
                look.copy(P).addScaledVector(up, 0.5);
                out.fov = shot.fov ?? 50;
                out.lens = shot.end ? 0.75 : 0.55;
                break;
            }
            case "heli":
                // High, but looking far enough ahead that the horizon and scenery stay in the frame.
                pos.copy(P).addScaledVector(Hs, -shot.back * (1 - 0.2 * k)).addScaledVector(up, shot.up * (1 - 0.15 * k)).addScaledVector(right, shot.s);
                look.copy(P).addScaledVector(Hs, 10).addScaledVector(up, 1.5);
                out.fov = 50;
                out.lens = 0.2;
                break;
            case "side":
                pos.copy(P).addScaledVector(right, shot.side * shot.dist).addScaledVector(up, shot.h).addScaledVector(Hs, shot.lead0 + (shot.lead1 - shot.lead0) * k);
                look.copy(P).addScaledVector(Hs, 1.2).addScaledVector(up, 0.4);
                out.fov = 50;
                out.lens = 0.65;
                break;
            case "front":
                pos.copy(P).addScaledVector(Hs, shot.dist).addScaledVector(up, shot.h).addScaledVector(right, shot.s);
                look.copy(P).addScaledVector(up, 0.5);
                out.fov = 56;
                out.lens = 0.5;
                break;
            case "pack": {
                // Frames the whole group around the followed car, pulling back and rising as it
                // spreads out. Cars are weighted in and out smoothly so the shot never jumps; with
                // most of the group behind, the camera sits ahead and looks back at them.
                const c = e[3].copy(P).multiplyScalar(2);
                let wsum = 2;
                const near = this.packNear ??= [];
                near.length = 0;
                for (const r of this.o.getRuns()) {
                    if (r === path.run) continue;
                    const q = this.pathOf(r).pos(t, e[4]);
                    const wt = clamp((45 - q.distanceTo(P)) / 20, 0, 1);
                    if (wt <= 0) continue;
                    near.push(q.x, q.y, q.z, wt);
                    c.addScaledVector(q, wt);
                    wsum += wt;
                }
                c.divideScalar(wsum);
                let radius = 3 + P.distanceTo(c);
                for (let i = 0; i < near.length; i += 4)
                    radius = Math.max(radius, 3 + Math.hypot(near[i] - c.x, near[i + 1] - c.y, near[i + 2] - c.z) * near[i + 3]);
                // Past this, the followed car would be too small; stragglers fall out of frame instead.
                radius = Math.min(radius, 14);
                const fit = Math.min(24, Math.max(shot.back, radius / Math.tan(55 * Math.PI / 360 * 0.8)));
                const dir = shot.front ? 1 : -1;
                pos.copy(c).addScaledVector(Hs, dir * fit).addScaledVector(up, shot.up + radius * 0.35).addScaledVector(right, shot.s);
                look.copy(c).addScaledVector(Hs, shot.front ? -2 : 7).addScaledVector(up, 0.8);
                out.fov = 55;
                out.lens = 0.25;
                break;
            }
            case "finish":
            case "tele":
            case "curb":
                out.moving = false;
                pos.copy(shot.cam);
                // The operator trails the car a little as it whips past.
                look.copy(P).lerp(path.pos(t - 0.07, e[3]), 0.6).addScaledVector(up, 0.45);
                if (shot.type === "curb") {
                    out.fov = shot.fov;
                    out.lens = 0.5;
                } else {
                    out.fov = shot.fovC ? curveAt(shot.fovC, t) : clamp(2 * Math.atan((shot.type === "finish" ? 3.2 : 2.4) / Math.max(pos.distanceTo(P), 0.1)) * 180 / Math.PI, shot.type === "finish" ? 18 : 14, shot.type === "finish" ? 55 : 50);
                    out.lens = shot.type === "finish" ? 0.8 : 0.95;
                }
                break;
            }

            // Shake that grows with speed, a jolt after landing a jump, and the shot's slow tilt.
            const amp = (SHAKE[shot.type] ?? 0) * (Math.min(speed / 320, 1.3) ** 2 + 2.5 * this.landing(path, t));
            if (amp > 0) {
                const ph = shot.ph ?? shot.t0 * 7.13;
                const dist = pos.distanceTo(look);
                const nx = Math.sin(t * 13.1 + ph) * 0.6 + Math.sin(t * 29.7 + ph * 1.7) * 0.4;
                const ny = Math.sin(t * 11.3 + ph * 2.3) * 0.6 + Math.sin(t * 31.9 + ph * 0.7) * 0.4;
                look.addScaledVector(right, nx * amp * dist).addScaledVector(up, ny * amp * dist);
                out.roll += Math.sin(t * 9.7 + ph * 3.1) * amp * 0.6;
            }
            if (shot.dutch) out.roll += shot.dutch * smootherstep(k);
            return out;
        }

        // 0..1, how hard the car landed a jump in the last moment (fades over ~0.6 s).
        landing(path, t) {
            let j = 0;
            for (const ev of path.events)
                if (ev.type === "jump" && t >= ev.t1 && t - ev.t1 < 0.8)
                    j = Math.max(j, Math.exp(-(t - ev.t1) * 5) * Math.min(1, (ev.t1 - ev.t0) / 0.8));
            return j;
        }

        // The shot, mixed with the previous one while a swoop is under way, then pulled in if the
        // plan found something in the way.
        viewOf(shot, t, P, path, A, B, withPull) {
            this.evalShot(shot, t, P, path, A);
            if (shot.blend && t < shot.t0 + shot.blend) {
                this.evalShot(shot.prev, t, P, path, B);
                this.mixViews(B, A, smootherstep(clamp((t - shot.t0) / shot.blend, 0, 1)), P);
            }
            if (withPull && shot.pull) {
                const k = curveAt(shot.pull, t);
                if (k < 0.999) {
                    const from = this.e[5].copy(P).addScaledVector(this.up, 0.8);
                    A.pos.sub(from).multiplyScalar(k).add(from);
                }
            }
            return A;
        }

        update(dt) {
            const o = this.o;
            const runs = o.getRuns();
            const focus = o.getFocus();
            const run = runs[focus];
            if (!run) return;
            const car = run.car;
            this.viewer.tick(dt);
            if (this.rec && car.getTime().numberOfFrames / 1000 >= this.rec.end) this.stopRecording();
            const P = car.getPosition();
            const pivot = this.pivot.copy(P).addScaledVector(this.up, 0.6);
            if (!this.enabled) {
                if (!o.isSpectator()) this.viewer.apply(o.render.camera, pivot, o.render.camera === car.cameraCockpit);
                ghostLod(runs.map((r) => r.car), car, o.render.camera, 1);
                return;
            }
            const frame = car.getTime().numberOfFrames;
            const t = this.lastT = frame / 1000;
            this.collectMeshes(runs, performance.now() / 1000);
            for (const r of runs) this.pathOf(r).sync();
            const planner = this.plannerFor(runs, focus);
            planner.step(planner.plannedTo < t + 2 ? 12 : 4);
            const i = planner.shotAt(t);
            const shot = this.shot = i >= 0 ? planner.shots[i] : HOLD;
            const view = this.viewOf(shot, t, P, planner.path, this.viewA, this.viewB, true);
            const speed = Math.abs(car.getSpeedKmh());

            const cam = this.camera;
            if (!o.isSpectator()) {
                if (o.render.camera !== cam) o.render.setCamera(cam);
                cam.position.copy(view.pos);
                cam.up.copy(view.up);
                cam.lookAt(view.look);
                if (Math.abs(view.roll) > 1e-4) cam.rotateZ(view.roll);
                cam.fov = view.fov;
                cam.updateProjectionMatrix();
                cam.updateMatrixWorld();
                this.viewer.apply(cam, pivot, false);
            }

            const viewCam = o.render.camera;
            const focusUv = this.project(viewCam, this.e[5].copy(P).addScaledVector(this.up, 0.4));
            window.__PolyFX?.setCinematic?.({
                focus: focusUv ? [focusUv.u, focusUv.v] : [0.5, 0.5],
                strength: o.isSpectator() ? 0.25 : view.lens,
                speed: clamp(speed / 450, 0, 1),
                exposure: this.exposure,
                correct: this.correct
            });

            // Cinematic shots sit close to the car, so ghosts overlapping it are hidden more widely.
            ghostLod(runs.map((r) => r.car), car, viewCam, 2.6);
            this.fadeCars(runs, focus, viewCam, P);
            this.updateTags(runs, focus, viewCam);
            this.updatePanels(runs, focus, run, frame, speed);
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
            for (let i = 0; i < runs.length; i++) {
                const car = runs[i].car;
                if (car.object3D && !car.object3D.visible) continue;
                let op = 1;
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
