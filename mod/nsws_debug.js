// Debug info panel: frame timing graph, renderer counts, memory, car, network and system info.
// The key is in Settings -> Controls ("Toggle debug info", F3 by default). Nothing is measured while it is closed.
(function () {
    const KEY_STORAGE = "_nswsDebugKeyBind";
    const DEFAULT_KEY = "F3";
    const BARS = 140;
    const SPARK = 40;
    const TEXT_MS = 250;
    const SCENE_MS = 1000;
    const PLACE_MS = 500;
    const MARGIN = 10;
    const VIOLET = "#8f8ff0";
    const SLOW = "#ff8080";
    const GPU_COLOR = "#80ffaa";
    const CPU_COLOR = "rgba(255,255,255,.85)";
    const POLYFX_PRESETS = { 0: "Off", 1: "Balanced", 2: "Enhanced", 3: "Semi-Real", 4: "Photoreal", 5: "Very Low" };

    function key() {
        try {
            return localStorage.getItem(KEY_STORAGE) || DEFAULT_KEY;
        } catch (e) {
            return DEFAULT_KEY;
        }
    }
    function setKey(code) {
        try {
            localStorage.setItem(KEY_STORAGE, code);
        } catch (e) {}
    }

    // Counted from the start so the totals cover the whole visit. String sizes are in UTF-16 units, close enough for a rate.
    const net = { down: 0, up: 0, sockets: new Set(), requests: 0, bytes: 0 };
    const byteSize = d => "string" == typeof d ? d.length : d?.byteLength ?? d?.size ?? 0;
    try {
        const Native = window.WebSocket;
        if (Native) {
            window.WebSocket = class WebSocket extends Native {
                constructor(...args) {
                    super(...args);
                    net.sockets.add(this);
                    this.addEventListener("message", e => {
                        net.down += byteSize(e.data);
                    });
                    this.addEventListener("close", () => net.sockets.delete(this));
                }
                send(data) {
                    net.up += byteSize(data);
                    return super.send(data);
                }
            };
        }
    } catch (e) {}
    try {
        new PerformanceObserver(list => {
            for (const entry of list.getEntries()) {
                net.requests++;
                net.bytes += entry.transferSize || 0;
            }
        }).observe({ type: "resource", buffered: true });
    } catch (e) {}

    class Ring {
        constructor(size) {
            this.buf = new Float64Array(size);
            this.size = size;
            this.n = 0;
            this.i = 0;
        }
        push(v) {
            this.buf[this.i] = v;
            this.i = (this.i + 1) % this.size;
            this.n = Math.min(this.n + 1, this.size);
        }
        // k = 0 is the newest.
        back(k) {
            return this.buf[(this.i - 1 - k + this.size * 2) % this.size];
        }
        clear() {
            this.n = 0;
            this.i = 0;
        }
    }

    const CSS = `
.nsws-debug{position:fixed;left:0;top:0;z-index:9000;width:340px;box-sizing:border-box;padding:7px 10px 8px;background:rgba(4,24,44,.8);color:#fff;font-size:12px;pointer-events:none;transform-origin:0 0;white-space:nowrap;}
.nsws-debug *{line-height:1.25;}
.nsws-debug .top{display:flex;align-items:baseline;justify-content:space-between;opacity:.55;font-size:11px;}
.nsws-debug .fps{display:flex;align-items:baseline;gap:10px;margin:2px 0 4px;}
.nsws-debug .fps b{font-weight:normal;font-size:24px;}
.nsws-debug .fps span{opacity:.75;}
.nsws-debug canvas{display:block;}
.nsws-debug h4{margin:5px 0 2px;padding-bottom:1px;border-bottom:1px solid rgba(255,255,255,.3);font-weight:normal;font-size:11px;opacity:.55;}
.nsws-debug .g{display:grid;grid-template-columns:1fr 1fr;column-gap:14px;}
.nsws-debug .r{display:flex;align-items:center;height:16px;min-width:0;}
.nsws-debug .r>.l{flex:1;opacity:.7;overflow:hidden;text-overflow:ellipsis;}
.nsws-debug .r>.v{text-align:right;padding-left:6px;overflow:hidden;text-overflow:ellipsis;}
.nsws-debug .r>canvas{margin-left:6px;flex:none;}
.nsws-debug .off{opacity:.3;}
.nsws-debug .warn{color:${SLOW};}
.nsws-debug .hidden{display:none;}
`;

    let panel = null, renderManager = null, gl = null, timerExt = null, gpuName = "", version = "";
    let open = false, car = null, settleUntil = 0;
    const frames = { t: new Ring(2048), dt: new Ring(2048), cpu: new Ring(2048) };
    const gpu = new Ring(256);
    const sparks = {};
    let lastTs = null, cpuStart = 0, query = null, recorded = !1;
    const pendingQueries = [];
    let lastText = 0, lastScene = 0, lastPlace = 0, lastGraph = 0;
    let netPrev = null, simPrev = null;
    let scene = { objects: 0, meshes: 0, visible: 0, instances: 0, lights: 0 };
    let place = null;
    const ui = {};

    function el(tag, className, parent, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        parent?.appendChild(node);
        return node;
    }

    function set(node, text) {
        if (node.textContent !== text) node.textContent = text;
    }

    function row(parent, id, label, spark) {
        const r = el("div", "r", parent);
        el("span", "l", r, label);
        ui[id] = el("span", "v", r, "-");
        if (spark) {
            const c = el("canvas", null, r);
            c.width = SPARK;
            c.height = 12;
            c.style.width = SPARK + "px";
            c.style.height = "12px";
            sparks[id] = { canvas: c, ring: new Ring(SPARK), color: spark };
        }
        ui[id + "Row"] = r;
        return r;
    }

    function build() {
        if (!document.getElementById("nsws-debug-style")) {
            const style = el("style", null, document.head, CSS);
            style.id = "nsws-debug-style";
        }
        panel = el("div", "nsws-debug");
        const top = el("div", "top", panel);
        ui.title = el("span", null, top, "Debug info");
        ui.hint = el("span", null, top);
        const fps = el("div", "fps", panel);
        ui.fps = el("b", null, fps, "-");
        ui.fpsLine = el("span", null, fps, "");
        ui.graph = el("canvas", null, panel);
        ui.graph.width = 320;
        ui.graph.height = 52;
        ui.graph.style.width = "320px";
        ui.graph.style.height = "52px";

        el("h4", null, panel, "Performance");
        const perf = el("div", "g", panel);
        row(perf, "cpu", "CPU", CPU_COLOR);
        row(perf, "gpu", "GPU", GPU_COLOR);
        row(perf, "calls", "Draw calls", VIOLET);
        row(perf, "tris", "Triangles", VIOLET);
        row(perf, "heap", "JS heap", VIOLET);
        row(perf, "worst", "Slowest (1 s)");

        el("h4", null, panel, "Scene");
        row(panel, "objects", "Meshes drawn / objects");
        row(panel, "memory", "Geometries / textures / shaders");
        row(panel, "res", "Resolution");
        row(panel, "polyfx", "PolyFX / shadows");

        ui.carHead = el("h4", null, panel, "Car");
        const carGrid = el("div", "g", panel);
        row(carGrid, "speed", "Speed", VIOLET);
        row(carGrid, "sim", "Sim");
        row(panel, "pos", "Position");
        row(panel, "wheels", "Wheels down / steering");
        row(panel, "inputs", "Inputs");
        ui.inputs.textContent = "";
        ui.keys = ["Gas", "Brake", "Left", "Right"].map(name => el("span", "off", ui.inputs, " " + name));
        ui.carRows = [ui.carHead, carGrid, ui.posRow, ui.wheelsRow, ui.inputsRow];

        el("h4", null, panel, "Network");
        const netGrid = el("div", "g", panel);
        row(netGrid, "ws", "WebSocket", VIOLET);
        row(netGrid, "http", "Requests");

        el("h4", null, panel, "System");
        row(panel, "gpuName", "GPU");
        row(panel, "device", "Window / CPU threads / RAM");
    }

    function readGpu() {
        if (!renderManager || gl) return;
        try {
            gl = renderManager.renderer.getContext();
            timerExt = gl.getExtension("EXT_disjoint_timer_query_webgl2");
            const info = gl.getExtension("WEBGL_debug_renderer_info");
            gpuName = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || "");
            gpuName = gpuName.replace(/^ANGLE \((.*)\)$/, "$1").replace(/ Direct3D.*$/, "").replace(/\s*\(0x[0-9a-f]+\)/gi, "").replace(/^([^,]+), (.*\1.*)$/i, "$2").replace(/, (D3D|OpenGL|Vulkan|Metal).*$/i, "");
        } catch (e) {}
    }

    function show() {
        if (open) return;
        panel || build();
        readGpu();
        open = true;
        frames.t.clear();
        frames.dt.clear();
        frames.cpu.clear();
        gpu.clear();
        for (const s of Object.values(sparks)) s.ring.clear();
        lastTs = null;
        netPrev = simPrev = null;
        place = null;
        lastText = lastScene = lastPlace = 0;
        try {
            renderManager && (renderManager.renderer.info.autoReset = !1);
        } catch (e) {}
        document.body.appendChild(panel);
        set(ui.hint, (window.__nswsKeyBindings?.format?.(key()) ?? key()) + " to close");
        Promise.resolve(window.__nswsLoadedVersion).then(v => {
            version = v || "";
        }, () => {});
        text(performance.now());
        placePanel(true);
    }

    function hide() {
        if (!open) return;
        open = false;
        panel.remove();
        endQuery();
        try {
            renderManager && (renderManager.renderer.info.autoReset = !0);
        } catch (e) {}
    }

    function toggle() {
        open ? hide() : show();
    }

    function endQuery() {
        if (!query) return;
        try {
            gl.endQuery(timerExt.TIME_ELAPSED_EXT);
            pendingQueries.push(query);
        } catch (e) {}
        query = null;
    }

    function pollQueries() {
        while (pendingQueries.length) {
            const q = pendingQueries[0];
            try {
                if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
                const disjoint = gl.getParameter(timerExt.GPU_DISJOINT_EXT);
                disjoint || gpu.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6);
            } catch (e) {}
            pendingQueries.shift();
            try {
                gl.deleteQuery(q);
            } catch (e) {}
        }
    }

    function frameStart(ts) {
        if (!open) return;
        recorded = null != lastTs;
        if (recorded) {
            frames.t.push(ts);
            frames.dt.push(Math.max(ts - lastTs, 0));
        }
        lastTs = ts;
        try {
            renderManager?.renderer.info.reset();
        } catch (e) {}
        if (timerExt && !query && pendingQueries.length < 8) {
            try {
                query = gl.createQuery();
                gl.beginQuery(timerExt.TIME_ELAPSED_EXT, query);
            } catch (e) {
                query = null;
            }
        }
        cpuStart = performance.now();
    }

    function frameEnd() {
        if (!open) return;
        const now = performance.now();
        recorded && frames.cpu.push(now - cpuStart);
        endQuery();
        timerExt && pollQueries();
        if (now - lastGraph >= 33) {
            lastGraph = now;
            drawGraph();
        }
        if (now - lastText >= TEXT_MS) {
            lastText = now;
            text(now);
        }
        if (now - lastPlace >= PLACE_MS) {
            lastPlace = now;
            placePanel(false);
        }
    }

    function niceScale(ms) {
        for (const s of [20, 40, 60, 100, 200]) if (ms <= s) return s;
        return 200;
    }

    function drawGraph() {
        const c = ui.graph, g = c.getContext("2d"), W = c.width, H = c.height;
        g.clearRect(0, 0, W, H);
        g.fillStyle = "rgba(0,0,0,.25)";
        g.fillRect(0, 0, W, H);
        const n = Math.min(frames.dt.n, BARS);
        let max = 0;
        for (let k = 0; k < n; k++) max = Math.max(max, frames.dt.back(k));
        // The top 12 px are kept for the legend.
        const scale = niceScale(max * 1.1), bw = W / BARS, y = ms => H - Math.min(ms / scale, 1) * (H - 12);
        for (let k = 0; k < n; k++) {
            const ms = frames.dt.back(k), x = W - (k + 1) * bw;
            g.fillStyle = ms > 34 ? SLOW : VIOLET;
            const top = y(ms);
            g.fillRect(x, top, Math.max(bw - .5, 1), H - top);
        }
        const line = (ring, color) => {
            const m = Math.min(ring.n, BARS);
            if (m < 2) return;
            g.strokeStyle = color;
            g.lineWidth = 1.25;
            g.beginPath();
            for (let k = 0; k < m; k++) {
                const x = W - (k + .5) * bw, yy = y(ring.back(k));
                k ? g.lineTo(x, yy) : g.moveTo(x, yy);
            }
            g.stroke();
        };
        line(frames.cpu, CPU_COLOR);
        line(gpu, GPU_COLOR);
        g.font = "10px Arial";
        g.textBaseline = "bottom";
        for (const [ms, label] of [[1000 / 60, "60"], [1000 / 30, "30"]]) {
            if (ms >= scale) continue;
            const yy = Math.round(y(ms)) + .5;
            g.strokeStyle = "rgba(255,255,255,.35)";
            g.lineWidth = 1;
            g.setLineDash([3, 3]);
            g.beginPath();
            g.moveTo(0, yy);
            g.lineTo(W, yy);
            g.stroke();
            g.setLineDash([]);
            g.fillStyle = "rgba(255,255,255,.6)";
            g.fillText(label + " fps", 2, yy - 1);
        }
        g.textBaseline = "top";
        g.textAlign = "right";
        let x = W - 3;
        for (const [label, color] of [[scale + " ms", "rgba(255,255,255,.6)"], timerExt ? ["GPU", GPU_COLOR] : null, ["CPU", CPU_COLOR], ["Frame", VIOLET]]) {
            if (!label) continue;
            g.fillStyle = color;
            g.fillText(label, x, 2);
            x -= g.measureText(label).width + 8;
        }
        g.textAlign = "left";
    }

    function drawSpark(id) {
        const s = sparks[id], g = s.canvas.getContext("2d"), W = s.canvas.width, H = s.canvas.height;
        g.clearRect(0, 0, W, H);
        g.fillStyle = "rgba(0,0,0,.25)";
        g.fillRect(0, 0, W, H);
        const n = s.ring.n;
        if (n < 2) return;
        let max = 0;
        for (let k = 0; k < n; k++) max = Math.max(max, s.ring.back(k));
        max = max > 0 ? max * 1.15 : 1;
        g.strokeStyle = s.color;
        g.lineWidth = 1;
        g.beginPath();
        for (let k = 0; k < n; k++) {
            const x = W - .5 - k * (W - 1) / (SPARK - 1), yy = H - .5 - s.ring.back(k) / max * (H - 1);
            k ? g.lineTo(x, yy) : g.moveTo(x, yy);
        }
        g.stroke();
    }

    function sample(id, value) {
        if (!sparks[id]) return;
        sparks[id].ring.push(Number.isFinite(value) ? value : 0);
        drawSpark(id);
    }

    const fmtInt = n => Math.round(n).toLocaleString("en-US");
    const fmtBig = n => n >= 1e6 ? (n / 1e6).toFixed(2) + " M" : n >= 1e4 ? (n / 1e3).toFixed(1) + " k" : fmtInt(n);
    const fmtBytes = n => n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : (n / 1024).toFixed(1) + " KB";

    function countScene(now) {
        if (now - lastScene < SCENE_MS) return;
        lastScene = now;
        const root = renderManager?.scene;
        if (!root) return;
        const s = { objects: 0, meshes: 0, visible: 0, instances: 0, lights: 0 };
        try {
            root.traverse(o => {
                s.objects++;
                o.isLight && s.lights++;
                if (o.isMesh) {
                    s.meshes++;
                    o.isInstancedMesh && (s.instances += o.count);
                }
            });
            root.traverseVisible(o => {
                o.isMesh && s.visible++;
            });
        } catch (e) {}
        scene = s;
    }

    function text(now) {
        const n = frames.t.n, newest = n ? frames.t.back(0) : 0;
        let count = 0, sum = 0, worst = 0, cpuSum = 0, cpuCount = 0;
        for (let k = 0; k < n; k++) {
            if (newest - frames.t.back(k) > 1000) break;
            const dt = frames.dt.back(k);
            count++;
            sum += dt;
            worst = Math.max(worst, dt);
            if (k < frames.cpu.n) {
                cpuSum += frames.cpu.back(k);
                cpuCount++;
            }
        }
        const recent = [];
        for (let k = 0; k < n && newest - frames.t.back(k) <= 5000; k++) recent.push(frames.dt.back(k));
        recent.sort((a, b) => b - a);
        const low = recent.length >= 20 ? 1000 / recent[Math.floor(recent.length / 100)] : NaN;
        const avg = count ? sum / count : NaN;
        set(ui.fps, count ? count + " FPS" : "- FPS");
        set(ui.fpsLine, count ? avg.toFixed(1) + " ms avg" + (Number.isFinite(low) ? "   1% low " + Math.round(low) + " FPS" : "") : "");
        const cpu = cpuCount ? cpuSum / cpuCount : NaN;
        set(ui.cpu, Number.isFinite(cpu) ? cpu.toFixed(2) + " ms" : "-");
        sample("cpu", cpu);
        let gpuMs = NaN;
        if (gpu.n) {
            let gs = 0, gn = Math.min(gpu.n, 30);
            for (let k = 0; k < gn; k++) gs += gpu.back(k);
            gpuMs = gs / gn;
        }
        set(ui.gpu, timerExt ? Number.isFinite(gpuMs) ? gpuMs.toFixed(2) + " ms" : "-" : "n/a");
        sparks.gpu.canvas.classList.toggle("hidden", !timerExt);
        timerExt && sample("gpu", gpuMs);
        set(ui.worst, count ? worst.toFixed(1) + " ms" : "-");
        ui.worst.classList.toggle("warn", worst > 50);

        const r = renderManager?.renderer;
        if (r) {
            const info = r.info;
            set(ui.calls, fmtInt(info.render.calls));
            sample("calls", info.render.calls);
            set(ui.tris, fmtBig(info.render.triangles));
            sample("tris", info.render.triangles);
            set(ui.memory, info.memory.geometries + " / " + info.memory.textures + " / " + (info.programs?.length ?? 0));
            countScene(now);
            set(ui.objects, fmtInt(scene.visible) + " of " + fmtInt(scene.meshes) + " / " + fmtInt(scene.objects));
            const canvas = r.domElement, ratio = r.getPixelRatio?.() ?? 1;
            set(ui.res, canvas.width + " x " + canvas.height + " (" + ratio.toFixed(2) + "x)");
            const fx = window.__PolyFX, preset = fx ? POLYFX_PRESETS[fx.preset] : null;
            const step = fx?.perfGuard?.level ? " (" + fx.perfGuard.stepName + ")" : "";
            set(ui.polyfx, (preset ?? "Off") + step + " / " + (window.__nswsSetting?.("ShadowQuality") ?? "-"));
        }

        const mem = performance.memory;
        if (mem) {
            set(ui.heap, Math.round(mem.usedJSHeapSize / 1048576) + " MB");
            sample("heap", mem.usedJSHeapSize);
        } else set(ui.heap, "n/a");

        carText(now);

        const secs = netPrev ? (now - netPrev.now) / 1000 : 0;
        const down = secs > 0 ? (net.down - netPrev.down) / secs : 0, up = secs > 0 ? (net.up - netPrev.up) / secs : 0;
        netPrev = { now, down: net.down, up: net.up };
        set(ui.ws, net.sockets.size ? fmtBytes(down + up) + "/s" : "none");
        sample("ws", down + up);
        set(ui.http, navigator.onLine ? fmtInt(net.requests) + " (" + fmtBytes(net.bytes) + ")" : "Offline");
        ui.http.classList.toggle("warn", !navigator.onLine);

        set(ui.title, "Debug info" + (version ? "  " + version : ""));
        const webgl = gl && "undefined" != typeof WebGL2RenderingContext && gl instanceof WebGL2RenderingContext ? "WebGL 2" : gl ? "WebGL 1" : "";
        set(ui.gpuName, (window.__nswsSoftwareGL ? "Software: " : "") + (gpuName || "-") + (webgl ? " (" + webgl + ")" : ""));
        ui.gpuName.classList.toggle("warn", !!window.__nswsSoftwareGL);
        set(ui.device, innerWidth + " x " + innerHeight + " @" + (devicePixelRatio || 1).toFixed(2) + " / " + (navigator.hardwareConcurrency || "-") + " / " + (navigator.deviceMemory ? navigator.deviceMemory + " GB" : "-"));
    }

    function carText(now) {
        const state = car?.getCarState?.();
        for (const node of ui.carRows) node.classList.toggle("hidden", !state);
        if (!state) return;
        const imperial = window.__nswsSettingBoolean?.("ImperialUnitsEnabled") === !0;
        const speed = Math.abs(state.speedKmh) / (imperial ? 1.609344 : 1);
        set(ui.speed, speed.toFixed(1) + (imperial ? " mph" : " km/h"));
        sample("speed", speed);
        const sim = state.frames;
        let rate = "";
        if (simPrev && now > simPrev.now && state.hasStarted && null == state.finishFrames && !car.isPaused && sim > simPrev.sim)
            rate = " " + ((sim - simPrev.sim) / (now - simPrev.now)).toFixed(2) + "x";
        simPrev = { now, sim };
        set(ui.sim, (sim / 1000).toFixed(3) + " s" + rate);
        const p = state.position;
        set(ui.pos, p.x.toFixed(1) + ", " + p.y.toFixed(1) + ", " + p.z.toFixed(1));
        const down = state.wheelContact.filter(w => null != w).length;
        set(ui.wheels, down + "/4 / " + (state.steering ?? 0).toFixed(2));
        const k = state.controls ?? {};
        [k.up, k.down, k.left, k.right].forEach((on, i) => ui.keys[i].classList.toggle("off", !on));
    }

    // Moves the panel to the edge spot that covers the least of the visible UI: tall blocks are walked into, small
    // ones count as a whole. It only moves when another spot is clearly better, so it doesn't jump around.
    function obstacles() {
        const out = [], vw = innerWidth, vh = innerHeight, big = vw * vh * .35;
        let budget = 2000;
        const walk = (node, depth) => {
            for (let c = node.firstElementChild; c && budget > 0; c = c.nextElementSibling) {
                budget--;
                if (c === panel || "SCRIPT" === c.tagName || "STYLE" === c.tagName || "LINK" === c.tagName || "screen" === c.id) continue;
                const r = c.getBoundingClientRect(), area = r.width * r.height;
                if (0 === area) {
                    depth < 12 && "none" !== getComputedStyle(c).display && walk(c, depth + 1);
                    continue;
                }
                if (r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) continue;
                const cs = getComputedStyle(c);
                if ("hidden" === cs.visibility || "0" === cs.opacity) continue;
                // A big panel with a background of its own (Settings) counts whole; full-screen layers are walked into.
                if (area > big && (area > vw * vh * .9 || ("rgba(0, 0, 0, 0)" === cs.backgroundColor || "transparent" === cs.backgroundColor) && "none" === cs.backgroundImage)) {
                    depth < 12 && walk(c, depth + 1);
                    continue;
                }
                out.push(r);
            }
        };
        walk(document.body, 0);
        return out;
    }

    function placePanel(force) {
        if (!panel?.isConnected) return;
        const vw = innerWidth, vh = innerHeight, w0 = panel.offsetWidth, h0 = panel.offsetHeight;
        const same = place && place.vw === vw && place.vh === vh && place.h === h0 && place.w === w0;
        // While driving it stays put once the race HUD has settled; only a size change moves it.
        if (!force && same && car && performance.now() > settleUntil) return;
        const fit = Math.min(1, (vh - 2 * MARGIN) / h0, (vw - 2 * MARGIN) / w0);
        const blocks = obstacles();
        // Covering UI costs its area in pixels; shrinking the panel is charged too, so it only shrinks to get clear of something.
        const cost = (x, y, s) => {
            const w = w0 * s, h = h0 * s;
            let sum = (1 - s / fit) * 60000;
            for (const b of blocks) {
                const ox = Math.min(x + w, b.right) - Math.max(x, b.left), oy = Math.min(y + h, b.bottom) - Math.max(y, b.top);
                ox > 0 && oy > 0 && (sum += ox * oy);
            }
            return sum;
        };
        let best = null;
        const consider = (x, y, s) => {
            const c = cost(x, y, s);
            (!best || c < best.c) && (best = { x, y, s, c });
        };
        const slide = (from, to, step, at) => {
            for (let v = from; ; v = Math.min(v + step, to)) {
                at(v);
                if (v >= to) break;
            }
        };
        for (const s of [fit, fit * .85, fit * .75]) {
            const w = w0 * s, h = h0 * s, maxX = Math.max(MARGIN, vw - w - MARGIN), maxY = Math.max(MARGIN, vh - h - MARGIN);
            for (const x of [maxX, MARGIN]) slide(MARGIN, maxY, 16, y => consider(x, y, s));
            for (const y of [MARGIN, maxY]) slide(MARGIN, maxX, 24, x => consider(x, y, s));
        }
        if (!force && same) {
            const now = cost(place.x, place.y, place.s);
            if (now - best.c < Math.max(1500, now * .25)) return;
        }
        place = { x: best.x, y: best.y, s: best.s, vw, vh, w: w0, h: h0 };
        panel.style.transform = "translate(" + Math.round(best.x) + "px," + Math.round(best.y) + "px)" + (best.s < 1 ? " scale(" + best.s.toFixed(3) + ")" : "");
    }

    function newCar(c) {
        car = c;
        settleUntil = performance.now() + 1500;
        const dispose = c.dispose;
        c.dispose = function () {
            car === c && (car = null);
            return dispose.apply(this, arguments);
        };
    }

    function attach(rm) {
        renderManager = rm;
        gl = null;
        if (open) {
            readGpu();
            try {
                rm.renderer.info.autoReset = !1;
            } catch (e) {}
        }
    }

    window.addEventListener("keydown", e => {
        if (e.repeat || window.__nswsKeyBindCapturing) return;
        const t = e.target;
        if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
        if (!window.__nswsKeyBindingMatches?.(e, key())) return;
        e.preventDefault();
        toggle();
    });
    window.addEventListener("resize", () => open && placePanel(true));

    window.__nswsDebug = { attach, frameStart, frameEnd, newCar, key, setKey, toggle, isOpen: () => open };
})();
