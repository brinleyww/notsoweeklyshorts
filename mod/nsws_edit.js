(() => {
    const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
    const ease = (x) => x * x * (3 - 2 * x);
    const smooth01 = (x) => ease(clamp(x, 0, 1));

    function hash(...keys) {
        let h = 2166136261;
        for (const ch of keys.join("|")) {
            h ^= ch.charCodeAt(0);
            h = Math.imul(h, 16777619);
        }
        return h >>> 0;
    }

    function rng(seed) {
        let s = seed >>> 0 || 1;
        return () => {
            s = Math.imul(s ^ s >>> 15, s | 1);
            s ^= s + Math.imul(s ^ s >>> 7, s | 61);
            return ((s ^ s >>> 14) >>> 0) / 4294967296;
        };
    }

    // How loud each part of the song is (1.5 s around it) against its loudest parts, 0..1 by song
    // time, so a quiet intro reads as quiet and the chorus as loud whichever part the video uses.
    const levels = new WeakMap();
    function loudness(buf) {
        let L = levels.get(buf);
        if (L) return L;
        const sr = buf.sampleRate, a = buf.getChannelData(0), b = buf.numberOfChannels > 1 ? buf.getChannelData(1) : a;
        const BLK = 0.05, blk = Math.round(sr * BLK), nb = Math.max(1, Math.floor(a.length / blk));
        const rms = new Float32Array(nb);
        for (let j = 0; j < nb; j++) {
            let e = 0;
            for (let i = j * blk, end = i + blk; i < end; i += 4) e += (a[i] + b[i]) * (a[i] + b[i]) * 0.25;
            rms[j] = Math.sqrt(e / (blk / 4));
        }
        const env = new Float32Array(nb), half = 15;
        let acc = 0;
        for (let j = -half; j < nb + half; j++) {
            if (j + half < nb) acc += rms[j + half];
            if (j - half - 1 >= 0) acc -= rms[j - half - 1];
            if (j >= 0 && j < nb) env[j] = acc / (Math.min(nb - 1, j + half) - Math.max(0, j - half) + 1);
        }
        const loudest = Float32Array.from(env).sort()[Math.floor(nb * 0.9)] || 1e-6;
        const block = (t) => clamp(Math.round(t / BLK), 0, nb - 1);
        L = { BLK, rms, at: (t) => clamp((env[block(t)] / loudest - 0.4) / 0.5, 0, 1), block };
        levels.set(buf, L);
        return L;
    }

    // Where the song should start so its first drop (loud after a quieter stretch) lands `at`
    // seconds into the video; null when it has no clear drop.
    function dropStart(buf, at) {
        const L = loudness(buf), dur = buf.duration;
        for (let t = 4; t < dur - 12; t += 0.25) {
            if (L.at(t) < 0.65) continue;
            let before = 0, n = 0;
            for (let u = t - 4; u < t - 0.75; u += 0.25, n++) before += L.at(u);
            if (before / n > 0.4) continue;
            // The smoothed level rises early; the drop itself is the sharpest jump in loudness nearby.
            let best = t, jump = -Infinity;
            for (let u = t - 1.5; u <= t + 0.75; u += L.BLK) {
                const j = L.block(u), d = L.rms[j] - L.rms[Math.max(0, j - 6)];
                if (d > jump) {
                    jump = d;
                    best = u;
                }
            }
            return Math.max(0, best - at);
        }
        return null;
    }

    // The song's beat grid over the part the video uses (`start` seconds in, `duration` long), in
    // video seconds: tempo from the autocorrelation of an onset curve (kick band + clicks), phase
    // from where the onsets line up best. Each beat carries how hard it hits and how loud the
    // song is around it (0..1), which decides how wild the edit gets there.
    function analyzeSong(buf, start, duration) {
        const sr = buf.sampleRate, a = buf.getChannelData(0), b = buf.numberOfChannels > 1 ? buf.getChannelData(1) : a;
        const HOP = 0.01, hop = Math.round(sr * HOP);
        const i0 = clamp(Math.round(start * sr), 0, a.length), i1 = Math.min(a.length, i0 + Math.round((duration + 1) * sr));
        const m = Math.floor((i1 - i0) / hop);
        if (m < 300) return null;
        const kLow = 1 - Math.exp(-2 * Math.PI * 150 / sr);
        const low = new Float32Array(m), high = new Float32Array(m), loud = new Float32Array(m);
        let lp = 0, prev = 0;
        for (let f = 0; f < m; f++) {
            let el = 0, eh = 0, e = 0;
            for (let i = i0 + f * hop, end = i + hop; i < end; i++) {
                const x = (a[i] + b[i]) * 0.5;
                lp += kLow * (x - lp);
                const d = x - prev;
                prev = x;
                el += lp * lp;
                eh += d * d;
                e += x * x;
            }
            low[f] = el / hop;
            high[f] = eh / hop;
            loud[f] = Math.sqrt(e / hop);
        }
        const mean = (arr) => arr.reduce((s, x) => s + x, 0) / arr.length;
        const cL = mean(low) * 0.05 + 1e-10, cH = mean(high) * 0.05 + 1e-10;
        const raw = new Float32Array(m), kick = new Float32Array(m);
        for (let f = 1; f < m; f++) {
            kick[f] = Math.max(0, Math.log(cL + low[f]) - Math.log(cL + low[f - 1]));
            raw[f] = kick[f] + 0.5 * Math.max(0, Math.log(cH + high[f]) - Math.log(cH + high[f - 1]));
        }
        const on = new Float32Array(m), W = 25;
        let run = 0;
        for (let f = 0; f < m; f++) {
            run += raw[f] - (f >= 2 * W ? raw[f - 2 * W] : 0);
            const c = f - W;
            if (c >= 0) on[c] = Math.max(0, raw[c] - run / Math.min(f + 1, 2 * W));
        }
        const ac = (L) => {
            let s = 0;
            for (let f = 0; f + L < m; f++) s += on[f] * on[f + L];
            return s / (m - L);
        };
        const lagMin = Math.floor(6000 / 185), lagMax = Math.ceil(6000 / 72);
        const r = new Float32Array(2 * lagMax + 2);
        for (let L = lagMin; L <= 2 * lagMax + 1; L++) r[L] = ac(L);
        let best = -1, bestL = lagMin, avg = 0;
        for (let L = lagMin; L <= lagMax; L++) {
            const bpm = 6000 / L;
            const prior = Math.exp(-0.5 * (Math.log2(bpm / 125) / 0.55) ** 2);
            const s = (r[L] + 0.5 * r[2 * L]) * prior;
            avg += r[L];
            if (s > best) {
                best = s;
                bestL = L;
            }
        }
        avg /= lagMax - lagMin + 1;
        const y0 = r[bestL - 1], y1 = r[bestL], y2 = r[bestL + 1];
        let P = bestL + clamp(0.5 * (y0 - y2) / (y0 - 2 * y1 + y2 || 1e-9), -0.5, 0.5);
        const at = (x) => {
            const i = Math.floor(x);
            if (i < 0 || i + 1 >= m) return 0;
            return Math.max(on[i], on[i + 1], i > 0 ? on[i - 1] * 0.7 : 0);
        };
        // Period and phase together, so a slightly wrong tempo doesn't drift off the beat later on.
        let bestFit = -1, phase = 0, period = P;
        for (let dp = -0.3; dp <= 0.3001; dp += 0.03) {
            const p = P + dp;
            for (let ph = 0; ph < p; ph += 0.5) {
                let s = 0;
                for (let x = ph; x < m; x += p) s += at(x);
                if (s > bestFit) {
                    bestFit = s;
                    phase = ph;
                    period = p;
                }
            }
        }
        P = period;
        const sorted = Float32Array.from(on).sort();
        const p90 = sorted[Math.floor(m * 0.9)] || 1e-6;
        const level = loudness(buf);
        const energyAt = (t) => level.at(start + t);
        const beats = [];
        for (let x = phase; x < m - 1; x += P) {
            let s = 0;
            for (let k = Math.round(x) - 3; k <= Math.round(x) + 3; k++) if (k >= 0 && k < m) s = Math.max(s, on[k]);
            beats.push({ t: x * HOP, s: clamp(s / (p90 * 2.2), 0, 1), e: energyAt(x * HOP), down: false });
        }
        const bars = [0, 0, 0, 0];
        beats.forEach((bt, i) => {
            const k = Math.round(bt.t / HOP);
            if (k < m) bars[i % 4] += Math.max(kick[k], kick[Math.min(m - 1, k + 1)]);
        });
        const downAt = bars.indexOf(Math.max(...bars));
        beats.forEach((bt, i) => bt.down = i % 4 === downAt);
        return { bpm: 6000 / P, beats, energyAt, confidence: avg > 0 ? r[bestL] / avg : 0 };
    }

    // Replay time against video time: slow motion through the big moments (the longest jumps,
    // round loops, the finish line) and a little faster than real time on fast straights. The
    // rate is a function of replay time; the video clock is its integral.
    function timeMap({ spd, events, finish, end, dt }) {
        const n = Math.max(2, Math.floor(end / dt) + 1);
        const spdAt = (i) => spd[clamp(i, 0, spd.length - 1)] ?? 0;
        const rate = new Float32Array(n);
        const win = Math.round(0.6 / dt);
        const sum = new Float64Array(n + 2 * win + 1);
        for (let i = 0; i < n + 2 * win; i++) sum[i + 1] = sum[i] + spdAt(i - win);
        for (let i = 0; i < n; i++) rate[i] = 1 + 0.16 * smooth01(((sum[i + 2 * win + 1] - sum[i]) / (2 * win + 1) - 170) / 170);
        const cands = [];
        for (const e of events) {
            if (e.type === "jump" && e.t1 - e.t0 >= 0.45 && e.t0 > 0.8) {
                const mid = (e.t0 + e.t1) / 2;
                const a = Math.max(e.t0 + 0.04, mid - 0.4), b = Math.min(e.t1 - 0.2, mid + 0.35);
                if (b > a) cands.push({ kind: "jump", a, b, rin: 0.12, rout: 0.15, depth: 0.3, score: e.t1 - e.t0, land: e.t1 });
            } else if (e.type === "loop" && e.round && e.t0 > 0.8) {
                const L = e.t1 - e.t0;
                cands.push({ kind: "loop", a: e.t0 + L * 0.3, b: e.t0 + L * 0.6, rin: 0.2, rout: 0.2, depth: 0.45, score: 1 });
            }
        }
        const slows = [];
        if (null != finish && finish < end) slows.push({ kind: "finish", a: finish - 0.32, b: finish + 0.2, rin: 0.14, rout: 0.4, depth: 0.28, score: 99 });
        const max = Math.max(1, Math.round((finish ?? end) / 7));
        cands.sort((x, y) => y.score - x.score);
        for (const c of cands) {
            if (slows.filter((s) => s.kind !== "finish").length >= max) break;
            if (c.b + c.rout > end) continue;
            if (slows.every((s) => c.a > s.b + s.rout + 2.2 || c.b + c.rout < s.a - 2.2)) slows.push(c);
        }
        slows.sort((x, y) => x.a - y.a);
        for (let i = 0; i < n; i++) {
            const t = i * dt;
            for (const s of slows) {
                let k;
                if (t < s.a || t > s.b + s.rout) continue;
                if (t < s.a + s.rin) k = 1 - ease((t - s.a) / s.rin);
                else if (t <= s.b) k = 0;
                else k = ease((t - s.b) / s.rout);
                rate[i] = Math.min(rate[i], s.depth + (rate[i] - s.depth) * k);
            }
        }
        const out = new Float64Array(n);
        for (let i = 1; i < n; i++) out[i] = out[i - 1] + dt * 2 / (rate[i - 1] + rate[i]);
        const duration = out[n - 1];
        const replayAt = (te) => {
            if (te <= 0) return 0;
            if (te >= duration) return (n - 1) * dt;
            let lo = 0, hi = n - 1;
            while (hi - lo > 1) {
                const mid = (lo + hi) >> 1;
                if (out[mid] <= te) lo = mid;
                else hi = mid;
            }
            return (lo + (te - out[lo]) / (out[hi] - out[lo])) * dt;
        };
        const videoAt = (t) => {
            const f = clamp(t / dt, 0, n - 1), i = Math.min(n - 2, Math.floor(f));
            return out[i] + (out[i + 1] - out[i]) * (f - i);
        };
        const rateAt = (t) => {
            const f = clamp(t / dt, 0, n - 1), i = Math.min(n - 2, Math.floor(f));
            return rate[i] + (rate[i + 1] - rate[i]) * (f - i);
        };
        return { duration, end: (n - 1) * dt, slows, replayAt, videoAt, rateAt };
    }

    // Everything that happens on a moment in the video: hits on the beat (punch-ins, flashes,
    // strobes in the loud parts, glitches), and on the run itself (whips into slow motion,
    // impacts on landings and the finish, flashes on hard cuts, checkpoints).
    function plan({ map, song, cuts, checkpoints, landings, finish, seed, accent }) {
        const R = rng(seed);
        const hits = [];
        const D = map.duration;
        const add = (t, kind, s, extra) => {
            if (t > -0.3 && t < D) hits.push({ t, kind, s, seed: Math.floor(R() * 1e6), ...extra });
        };
        const slowAt = (te) => 1 - map.rateAt(map.replayAt(te));
        add(0, "flash", 0.85);
        add(0.02, "punch", 0.8);
        if (song) {
            const minGap = 1 / 3;
            const beats = song.beats;
            let lastStrobe = -1, inDrop = false, quietFor = 0, prevT = 0, dropDone = false, bar = 0, dropAt = -1;
            for (let i = 0; i < beats.length; i++) {
                const bt = beats[i];
                if (bt.t >= D - 0.3) break;
                const slow = smooth01((slowAt(bt.t) - 0.2) / 0.4);
                const e = bt.e;
                quietFor = e < 0.5 ? quietFor + (bt.t - prevT) : 0;
                prevT = bt.t;
                add(bt.t, "punch", (0.3 + 0.7 * e * (0.5 + 0.5 * bt.s)) * (1 - 0.5 * slow));
                if (bt.down) bar++;
                const drop = e > 0.62;
                // The loudness rises a little ahead of the drop; the drop is the hardest hit of the next few beats.
                if (drop && !inDrop && (!dropDone || quietFor > 0) && bt.t > 1.5) {
                    dropAt = i;
                    for (let k = i + 1; k < Math.min(beats.length, i + 3); k++) if (beats[k].s > beats[dropAt].s * 1.15) dropAt = k;
                    dropDone = true;
                }
                if (i === dropAt) {
                    add(bt.t, "invert", 1);
                    add(bt.t, "glitch", 1, { dur: 0.2 });
                    add(bt.t, "impact", 0.8);
                    lastStrobe = bt.t;
                } else if (i < dropAt) {
                    lastStrobe = bt.t;
                } else if (drop && slow < 0.5 && bt.t - lastStrobe >= minGap - 1e-3) {
                    add(bt.t, "strobe", 0.55 + 0.4 * bt.s, { color: bar % 2 ? accent : "#ffffff" });
                    lastStrobe = bt.t;
                } else if (bt.down && e > 0.15 && bt.t - lastStrobe >= minGap - 1e-3) {
                    add(bt.t, "flash", (0.2 + 0.45 * e) * (1 - 0.6 * slow));
                    lastStrobe = bt.t;
                }
                if (drop && bt.down && bar % 4 === 0 && slow < 0.3) add(bt.t, "glitch", 0.7, { dur: 0.14 });
                if (drop) add(bt.t, "shake", 0.35 * (0.5 + bt.s));
                inDrop = drop;
            }
        }
        for (const s of map.slows) {
            const at = map.videoAt(s.a);
            add(at - 0.04, "whip", 1, { dir: R() < 0.5 ? -1 : 1 });
            add(at, "sfx", 1, { sound: "whoosh" });
            if (s.kind === "jump") {
                const land = map.videoAt(s.land);
                add(land, "impact", 1);
                add(land, "sfx", 1, { sound: "boom" });
            }
        }
        const slowLands = new Set(map.slows.filter((s) => s.kind === "jump").map((s) => s.land));
        for (const t of landings) {
            if (slowLands.has(t) || t > map.end) continue;
            add(map.videoAt(t), "impact", 0.45);
        }
        for (const t of cuts) {
            if (t < 0.3 || t > map.end) continue;
            const te = map.videoAt(t);
            if (hits.some((h) => (h.kind === "flash" || h.kind === "strobe" || h.kind === "invert") && Math.abs(h.t - te) < 0.12)) continue;
            add(te, "flash", 0.4, { tau: 0.06 });
            add(te, "whip", 0.45, { dir: R() < 0.5 ? -1 : 1 });
        }
        for (const t of checkpoints) if (t <= map.end) add(map.videoAt(t), "pulse", 0.7);
        if (null != finish && finish <= map.end) {
            const te = map.videoAt(finish);
            add(te, "impact", 1.2);
            add(te, "flash", 0.9);
            add(te, "glitch", 0.8, { dur: 0.16 });
            add(te, "sfx", 1.3, { sound: "boom" });
        }
        hits.sort((x, y) => x.t - y.t);
        return { map, song, hits, duration: D, accent, replayAt: map.replayAt };
    }

    function noise(t, k) {
        return (Math.sin(t * 37.1 + k * 11.3) * 0.5 + Math.sin(t * 23.7 + k * 5.1) * 0.3 + Math.sin(t * 61.3 + k * 2.7) * 0.2);
    }

    // The look of one frame at video time te. `kmh` is the followed car's speed.
    function paramsAt(edit, te, kmh) {
        const map = edit.map, t = map.replayAt(te);
        const speed = clamp((kmh - 80) / 320, 0, 1);
        const slow = clamp((1 - map.rateAt(t)) / 0.7, 0, 1);
        let zoom = 0, chroma = 0, flash = 0, flashColor = "#ffffff", shake = 0, whip = 0, whipDir = 1, glitch = 0, gseed = 0, invert = 0;
        for (const h of edit.hits) {
            const d = te - h.t;
            if (d < -0.25) break;
            if (d > 1.5) continue;
            const env = (a, k) => d < 0 ? 0 : d < a ? d / a : Math.exp(-(d - a) / k);
            switch (h.kind) {
                case "punch":
                    zoom += 0.07 * h.s * env(0.03, 0.15);
                    chroma += 0.004 * h.s * env(0.01, 0.1);
                    break;
                case "flash": {
                    const f = d < 0 ? 0 : h.s * Math.exp(-d / (h.tau ?? 0.1));
                    if (f > flash) {
                        flash = f;
                        flashColor = "#ffffff";
                    }
                    break;
                }
                case "strobe": {
                    const f = d < 0 ? 0 : d < 0.034 ? h.s : h.s * Math.exp(-(d - 0.034) / 0.035);
                    if (f > flash) {
                        flash = f;
                        flashColor = h.color;
                    }
                    break;
                }
                case "impact":
                    shake += h.s * env(0.01, 0.22);
                    zoom += 0.09 * h.s * env(0.02, 0.2);
                    chroma += 0.012 * h.s * env(0.01, 0.16);
                    flash = Math.max(flash, d < 0 ? 0 : 0.35 * h.s * Math.exp(-d / 0.07));
                    break;
                case "shake":
                    shake += h.s * env(0.01, 0.12);
                    break;
                case "whip": {
                    const w = h.s * Math.exp(-Math.abs(d) / 0.07);
                    if (w > whip) {
                        whip = w;
                        whipDir = h.dir;
                    }
                    break;
                }
                case "glitch":
                    if (d >= 0 && d < h.dur) {
                        glitch = Math.max(glitch, h.s * (1 - d / h.dur * 0.5));
                        gseed = h.seed + Math.floor(d * 30);
                    }
                    break;
                case "invert":
                    if (d >= 0 && d < 0.07) invert = h.s;
                    break;
                case "pulse":
                    chroma += 0.008 * h.s * env(0.01, 0.14);
                    zoom += 0.025 * h.s * env(0.02, 0.12);
                    break;
            }
        }
        shake = Math.min(shake, 1.6) + 0.12 * speed * (1 - slow);
        const fadeOut = clamp((te - (edit.duration - 0.55)) / 0.55, 0, 1);
        return {
            zoom: 1.045 + 0.025 * speed * (1 - slow) + Math.min(zoom, 0.16),
            shake: [noise(te, 1) * 0.011 * shake, noise(te, 2) * 0.011 * shake],
            rot: noise(te, 3) * 0.014 * shake,
            blur: 0.055 * speed * (1 - slow) + 0.02 * Math.min(1, zoom * 8),
            whip: whip * 0.09,
            whipDir,
            chroma: 0.0012 + 0.0025 * speed + Math.min(chroma, 0.025),
            lines: smooth01((speed - 0.45) / 0.4) * (1 - slow),
            sat: 1.22 - 0.4 * slow,
            contrast: 1.12 + 0.05 * slow,
            vignette: 0.32 + 0.38 * slow,
            glitch,
            gseed: gseed % 997,
            invert,
            time: te,
            flash: Math.min(flash, 1),
            flashColor,
            fade: fadeOut
        };
    }

    const VERT = `#version 300 es
in vec2 p;
out vec2 v;
void main() { v = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;
    const FRAG = `#version 300 es
precision highp float;
uniform sampler2D T;
uniform vec2 R, SH, WD;
uniform float Z, ROT, BL, CH, GL, GS, LN, TM, SAT, CON, VIG, GR, INV, WH;
in vec2 v;
out vec4 o;
float h(vec2 q) { return fract(sin(dot(q, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
    float asp = R.x / R.y;
    vec2 q = v - 0.5;
    q.x *= asp;
    float c = cos(ROT), s = sin(ROT);
    q = mat2(c, -s, s, c) * q / Z;
    q.x /= asp;
    vec2 uv = q + 0.5 + SH;
    float gl = 0.0;
    if (GL > 0.0) {
        float band = floor(v.y * 16.0 + h(vec2(GS, 3.0)) * 5.0);
        if (h(vec2(band, GS)) < GL * 0.6) {
            uv.x += (h(vec2(band, GS + 7.0)) - 0.5) * 0.16 * GL;
            gl = GL;
        }
    }
    vec2 d = (uv - vec2(0.5, 0.48)) * BL + WD * WH;
    vec2 rd = (uv - 0.5) * (CH + gl * 0.02);
    int n = dot(d, d) * R.x * R.x > 1.0 ? 16 : 1;
    vec3 acc = vec3(0.0);
    float ws = 0.0;
    for (int i = 0; i < 16; i++) {
        if (i >= n) break;
        float k = n > 1 ? float(i) / 15.0 : 0.0;
        float w = 1.0 - 0.7 * k;
        vec2 u = uv - d * k;
        acc += vec3(texture(T, u + rd).r, texture(T, u).g, texture(T, u - rd).b) * w;
        ws += w;
    }
    vec3 col = acc / ws;
    if (LN > 0.0) {
        vec2 r = v - vec2(0.5, 0.48);
        r.x *= asp;
        float a = atan(r.y, r.x) * 38.0 / 3.14159265;
        float cell = floor(a);
        float on = step(0.86, h(vec2(cell, floor(TM * 24.0))));
        float thin = pow(1.0 - abs(fract(a) - 0.5) * 2.0, 6.0);
        col = mix(col, vec3(1.0), on * thin * smoothstep(0.42, 0.95, length(r)) * LN * 0.5);
    }
    float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(vec3(l), col, SAT);
    col = (col - 0.5) * CON + 0.5;
    col += vec3(0.03, 0.005, -0.02) * smoothstep(0.45, 1.0, l) + vec3(-0.02, 0.008, 0.035) * (1.0 - smoothstep(0.0, 0.45, l));
    col = mix(col, 1.0 - col, INV);
    vec2 vq = v - 0.5;
    vq.x *= asp * 0.7;
    col *= 1.0 - VIG * smoothstep(0.3, 0.85, length(vq));
    col += (h(v * R + fract(TM * 7.13) * 91.0) - 0.5) * GR;
    o = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

    // The effects pass on the GPU, reading the game's own canvas. Without WebGL 2 only the
    // camera moves (zoom, shake, tilt) are drawn, on a 2D canvas.
    class FX {
        constructor() {
            try {
                this.canvas = document.createElement("canvas");
                this.gl = this.canvas.getContext("webgl2", { alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
                if (this.gl) this.init(this.gl);
            } catch (e) {
                console.warn(e);
                this.gl = null;
            }
            if (!this.gl) {
                this.canvas = document.createElement("canvas");
                this.g = this.canvas.getContext("2d", { alpha: false });
            }
        }

        init(gl) {
            const sh = (type, src) => {
                const s = gl.createShader(type);
                gl.shaderSource(s, src);
                gl.compileShader(s);
                if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
                return s;
            };
            const prog = this.prog = gl.createProgram();
            gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
            gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
            gl.bindAttribLocation(prog, 0, "p");
            gl.linkProgram(prog);
            if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
            gl.useProgram(prog);
            const buf = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, buf);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
            gl.enableVertexAttribArray(0);
            gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
            this.tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, this.tex);
            for (const [k, val] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, val);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
            this.u = {};
            for (const name of ["T", "R", "SH", "WD", "Z", "ROT", "BL", "CH", "GL", "GS", "LN", "TM", "SAT", "CON", "VIG", "GR", "INV", "WH"]) this.u[name] = gl.getUniformLocation(prog, name);
        }

        render(src, W, H, p) {
            if (this.canvas.width !== W || this.canvas.height !== H) {
                this.canvas.width = W;
                this.canvas.height = H;
            }
            const gl = this.gl;
            if (!gl) {
                const g = this.g;
                g.save();
                g.fillStyle = "#000";
                g.fillRect(0, 0, W, H);
                g.translate(W / 2 - p.shake[0] * W * p.zoom, H / 2 + p.shake[1] * H * p.zoom);
                g.rotate(-p.rot);
                g.scale(p.zoom, p.zoom);
                g.drawImage(src, -W / 2, -H / 2, W, H);
                g.restore();
                return this.canvas;
            }
            const u = this.u;
            gl.viewport(0, 0, W, H);
            gl.bindTexture(gl.TEXTURE_2D, this.tex);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
            gl.uniform1i(u.T, 0);
            gl.uniform2f(u.R, W, H);
            gl.uniform2f(u.SH, p.shake[0], p.shake[1]);
            gl.uniform2f(u.WD, p.whipDir, 0);
            gl.uniform1f(u.Z, p.zoom);
            gl.uniform1f(u.ROT, p.rot);
            gl.uniform1f(u.BL, p.blur);
            gl.uniform1f(u.CH, p.chroma);
            gl.uniform1f(u.GL, p.glitch);
            gl.uniform1f(u.GS, p.gseed);
            gl.uniform1f(u.LN, p.lines);
            gl.uniform1f(u.TM, p.time);
            gl.uniform1f(u.SAT, p.sat);
            gl.uniform1f(u.CON, p.contrast);
            gl.uniform1f(u.VIG, p.vignette);
            gl.uniform1f(u.GR, 0.035);
            gl.uniform1f(u.INV, p.invert);
            gl.uniform1f(u.WH, p.whip);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            return this.canvas;
        }

        dispose() {
            this.gl?.getExtension("WEBGL_lose_context")?.loseContext();
        }
    }

    // Flashes go over the overlays too (not over letterbox bars `bar` high); the fade at the end
    // covers everything.
    function paintTop(g, W, H, p, bar = 0) {
        if (p.flash > 0.004) {
            g.globalAlpha = p.flash;
            g.fillStyle = p.flashColor;
            g.fillRect(0, bar, W, H - 2 * bar);
        }
        if (p.fade > 0) {
            g.globalAlpha = p.fade;
            g.fillStyle = "#000";
            g.fillRect(0, 0, W, H);
        }
        g.globalAlpha = 1;
    }

    // Whooshes into slow motion and booms on the landings and the finish, made here (no samples).
    function sfx(edit, duration, SR) {
        const n = Math.ceil(duration * SR);
        const L = new Float32Array(n), Rr = new Float32Array(n);
        for (const h of edit.hits) {
            if (h.kind !== "sfx") continue;
            const R = rng(h.seed + 1);
            if (h.sound === "whoosh") {
                const len = 0.7, at = Math.round((h.t - 0.45) * SR), m = Math.round(len * SR);
                let lo = 0, bp = 0;
                for (let i = 0; i < m; i++) {
                    const k = at + i;
                    if (k < 0 || k >= n) continue;
                    const x = i / m;
                    const f = 2 * Math.sin(Math.PI * (250 + 3200 * x * x) / SR);
                    const noise = R() * 2 - 1;
                    lo += f * bp;
                    const hp = noise - lo - 0.6 * bp;
                    bp += f * hp;
                    const amp = 0.32 * h.s * Math.pow(Math.sin(Math.PI * Math.min(1, x / 0.85)), 2) * (x < 0.85 ? 1 : Math.max(0, 1 - (x - 0.85) / 0.15));
                    const pan = x * 2 - 1;
                    L[k] += bp * amp * (1 - 0.6 * pan);
                    Rr[k] += bp * amp * (1 + 0.6 * pan);
                }
            } else if (h.sound === "boom") {
                const at = Math.round(h.t * SR), m = Math.round(1.1 * SR);
                let ph = 0, lp = 0;
                for (let i = 0; i < m; i++) {
                    const k = at + i;
                    if (k < 0 || k >= n) continue;
                    const t = i / SR;
                    const freq = 34 + 46 * Math.exp(-t / 0.09);
                    ph += 2 * Math.PI * freq / SR;
                    lp += 0.08 * (R() * 2 - 1 - lp);
                    const body = Math.sin(ph) * Math.exp(-t / 0.38) * Math.min(1, t / 0.004);
                    const thump = lp * 2.4 * Math.exp(-t / 0.05);
                    const v = 0.4 * h.s * (body + thump);
                    L[k] += v;
                    Rr[k] += v;
                }
            }
        }
        return [L, Rr];
    }

    window.__nswsEdit = { analyzeSong, dropStart, timeMap, plan, paramsAt, paintTop, sfx, FX, hash };
})();
