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

    function rgb(hex) {
        const n = parseInt(String(hex).replace("#", ""), 16);
        return Number.isFinite(n) ? [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255] : [1, 1, 1];
    }

    // The same colour turned round the colour wheel by `deg`, at full saturation and brightness.
    function turn(c, deg) {
        const max = Math.max(...c), min = Math.min(...c);
        let h = 0;
        if (max > min) {
            if (max === c[0]) h = ((c[1] - c[2]) / (max - min) + 6) % 6;
            else if (max === c[1]) h = (c[2] - c[0]) / (max - min) + 2;
            else h = (c[0] - c[1]) / (max - min) + 4;
        }
        h = ((h * 60 + deg) % 360 + 360) % 360 / 60;
        const x = 1 - Math.abs(h % 2 - 1);
        const k = [[1, x, 0], [x, 1, 0], [0, 1, x], [0, x, 1], [x, 0, 1], [1, 0, x]][Math.floor(h) % 6];
        return k.map((v) => 0.15 + 0.85 * v);
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
    // from where the onsets line up best, each beat then pulled onto its own onset (within 20 ms).
    // Each beat carries how hard it hits (s), its kick (k) and snare/clap (n), the off-beat after
    // it (off) and how loud the song is around it (e, 0..1), which decide what happens there.
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
        const raw = new Float32Array(m), kick = new Float32Array(m), snap = new Float32Array(m);
        for (let f = 1; f < m; f++) {
            kick[f] = Math.max(0, Math.log(cL + low[f]) - Math.log(cL + low[f - 1]));
            snap[f] = Math.max(0, Math.log(cH + high[f]) - Math.log(cH + high[f - 1]));
            raw[f] = kick[f] + 0.5 * snap[f];
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
        const p90 = (arr) => Float32Array.from(arr).sort()[Math.floor(m * 0.9)] || 1e-6;
        const pOn = p90(on), pKick = p90(kick), pSnap = p90(snap);
        const peak = (arr, x, w) => {
            let s = 0;
            for (let k = Math.round(x) - w; k <= Math.round(x) + w; k++) if (k >= 0 && k < m) s = Math.max(s, arr[k]);
            return s;
        };
        const level = loudness(buf);
        const energyAt = (t) => level.at(start + t);
        const beats = [];
        for (let x = phase; x < m - 1; x += P) {
            let t = x * HOP;
            const g = Math.round(x);
            let kmax = g;
            for (let k = g - 2; k <= g + 2; k++) if (k >= 0 && k < m && on[k] > on[kmax]) kmax = k;
            if (on[kmax] > 0.5 * pOn && on[kmax] > 1.25 * (on[g] ?? 0)) t = kmax * HOP;
            beats.push({
                t,
                s: clamp(peak(on, x, 3) / (pOn * 2.2), 0, 1),
                k: clamp(peak(kick, x, 3) / (pKick * 2), 0, 1),
                n: clamp(peak(snap, x, 3) / (pSnap * 2), 0, 1),
                off: clamp(peak(on, x + P / 2, 2) / (pOn * 2.2), 0, 1),
                e: energyAt(t),
                down: false
            });
        }
        const bars = [0, 0, 0, 0];
        beats.forEach((bt, i) => {
            const k = Math.round(bt.t / HOP);
            if (k < m) bars[i % 4] += Math.max(kick[k], kick[Math.min(m - 1, k + 1)]);
        });
        const downAt = bars.indexOf(Math.max(...bars));
        beats.forEach((bt, i) => bt.down = i % 4 === downAt);
        // Short-term level (50 ms) against the loud part, for the silent gap some songs leave before a drop.
        const loudSorted = p90(loud);
        const levelAt = (t) => {
            const f = Math.round(t / HOP);
            let s = 0, n = 0;
            for (let k = f - 2; k <= f + 2; k++) if (k >= 0 && k < m) {
                s += loud[k];
                n++;
            }
            return n ? s / n / loudSorted : 0;
        };
        return { bpm: 6000 / P, period: P * HOP, beats, energyAt, levelAt, confidence: avg > 0 ? r[bestL] / avg : 0 };
    }

    // Where the music stops and rings out: on the last downbeat (else beat) in [from, to].
    function endingFor(song, from, to) {
        if (!song || to <= from) return { at: Math.max(0, to), period: song?.period ?? 0.5 };
        const inside = song.beats.filter((b) => b.t >= from && b.t <= to);
        const pick = inside.filter((b) => b.down).pop() ?? inside.pop();
        return { at: pick ? pick.t : to, period: song.period };
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

    // Velocity ramps: inside a warped beat the replay runs slow just after the beat and fast into
    // the next one, so every hit lands on a near-freeze. The beats themselves stay where they were.
    function warper(warps) {
        const find = (x) => {
            let lo = 0, hi = warps.length - 1;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1, w = warps[mid];
                if (x < w.a) hi = mid - 1;
                else if (x >= w.b) lo = mid + 1;
                else return w;
            }
            return null;
        };
        return {
            fwd: (te) => {
                const w = find(te);
                if (!w) return te;
                const x = (te - w.a) / (w.b - w.a);
                return w.a + (w.b - w.a) * (w.lo * x + (1 - w.lo) * x * x);
            },
            back: (u) => {
                const w = find(u);
                if (!w) return u;
                const y = (u - w.a) / (w.b - w.a), q = 1 - w.lo;
                return w.a + (w.b - w.a) * (-w.lo + Math.sqrt(w.lo * w.lo + 4 * q * y)) / (2 * q);
            },
            slope: (te) => {
                const w = find(te);
                if (!w) return 1;
                return w.lo + 2 * (1 - w.lo) * (te - w.a) / (w.b - w.a);
            }
        };
    }

    // Looks that last a whole bar (or its last two beats). LOOKS keep the run in plain view;
    // BURSTS are the loud-part show-offs and only ever take half a bar. "trail" streaks the car
    // along its own motion; "echo" throws copies of its outline outward on each beat.
    const LOOKS = ["velocity", "trail", "zoom", "velocity", "trail", "zoom", "pop", "hue"];
    const BURSTS = ["echo", "split", "echo", "cutout"];

    // The run's own moments, in replay seconds: drifts (the nose well off the direction of
    // travel), jumps, the top speed and hard surges of speed. `drive` holds the followed run
    // sampled every `dt`: speed (km/h), signed slip angle (rad), in the air (1/0), path events.
    function moments(drive, until) {
        const { dt, spd, slip, air } = drive, n = Math.min(spd.length, Math.floor(until / dt));
        const drifts = [];
        let cur = null;
        for (let i = 0; i < n; i++) {
            const a = Math.abs(slip[i]);
            if (a < 0.3 || spd[i] < 60 || air[i]) continue;
            if (!cur || i * dt - cur.t1 > 0.15) drifts.push(cur = { t0: i * dt, t1: i * dt, peak: 0 });
            cur.t1 = i * dt;
            cur.peak = Math.max(cur.peak, a);
        }
        let top = 0;
        for (let i = 0; i < n; i++) if (spd[i] > spd[top]) top = i;
        const surges = [], w = Math.round(0.5 / dt);
        for (let i = 0; i + w < n; i++) {
            if (spd[i] > 30 && spd[i + w] - spd[i] > 45 && (!surges.length || i * dt - surges[surges.length - 1] > 3)) {
                surges.push(i * dt);
                i += w;
            }
        }
        return {
            drifts: drifts.filter((d) => d.t1 - d.t0 >= 0.3),
            jumps: drive.events.filter((e) => e.type === "jump" && e.t1 - e.t0 >= 0.45 && e.t1 <= until),
            top: spd[top] > 150 ? { t: top * dt, kmh: spd[top] } : null,
            surges
        };
    }

    // Everything that happens in the edit: per-bar looks and bursts chosen from the song's
    // sections, hits on the beat (kicks punch in, snares twist and flash, off-beats tick), the
    // drop (a tense pull-in through its silent gap, then invert and glitch), the driving (drift
    // lean and trail, landing shockwaves, speed surges, call-outs for the best moments), the run's
    // slow motion and cuts, checkpoints flashing green or red against the other runs, the ending.
    function plan({ map, song, cuts, checkpoints, landings, finish, seed, accent, mask, drive = null }) {
        const R = rng(seed);
        const D = map.duration;
        // A grey, black or white car gets a hot pink to work with instead.
        const car = rgb(accent), base = Math.max(...car) - Math.min(...car) < 0.25 ? [1, 0.18, 0.45] : turn(car, 0);
        const pal = [base, turn(base, 150), turn(base, -110), turn(base, 40), [1, 0.62, 0.25], [0.45, 0.85, 1]];
        const leaks = [[1, 0.55, 0.2], [1, 0.3, 0.45], [0.95, 0.75, 0.35], turn(base, 20)];
        const pick = (arr) => arr[Math.floor(R() * arr.length)];
        const slowAt = (te) => 1 - map.rateAt(map.replayAt(te));
        const finishV = null != finish && finish <= map.end ? map.videoAt(finish) : null;
        const end = endingFor(song, (finishV ?? D - 2.4) + 0.2, D - 1.4);
        const bars = [], warps = [], hits = [];
        let drops = [];

        if (song) {
            const beats = song.beats.filter((b) => b.t < end.at + 1e-3);
            let inDrop = false, quietFor = 0, prevT = 0, dropAt = -1;
            for (let i = 0; i < beats.length; i++) {
                const bt = beats[i], quietBefore = quietFor;
                quietFor = bt.e < 0.5 ? quietFor + (bt.t - prevT) : 0;
                prevT = bt.t;
                const drop = bt.e > 0.62;
                // A later drop needs a quiet stretch before it. The smoothed loudness crosses a beat
                // or two early or late; the drop is the nearby beat where the level jumps most.
                if (drop && !inDrop && (!drops.length || quietBefore > 1.5) && bt.t > 1.5 && i > dropAt + 8) {
                    let jump = -Infinity;
                    for (let k = Math.max(0, i - 2); k < Math.min(beats.length, i + 3); k++) {
                        const t = beats[k].t, d = song.levelAt(t + 0.06) / (0.05 + Math.max(song.levelAt(t - 0.1), song.levelAt(t - 0.2)));
                        if (d > jump) {
                            jump = d;
                            dropAt = k;
                        }
                    }
                    drops.push(dropAt);
                }
                inDrop = drop;
            }
            drops = [...new Set(drops)];
            // Bars from downbeat to downbeat (the first one may be short).
            let cur = null;
            beats.forEach((bt, i) => {
                if (!cur || bt.down) bars.push(cur = { i0: i, i1: i + 1, t0: bt.t });
                else cur.i1 = i + 1;
            });
            for (const b of bars) {
                const bs = beats.slice(b.i0, b.i1);
                const next = beats[b.i1];
                b.t1 = next ? next.t : bs[bs.length - 1].t + song.period;
                b.e = bs.reduce((s, x) => s + x.e, 0) / bs.length;
                b.slow = bs.filter((x) => slowAt(x.t) > 0.25).length / bs.length >= 0.75;
                b.finish = null != finishV && finishV > b.t0 - 0.3 && finishV < b.t1 + 0.3;
                b.kind = b.e > 0.62 ? "drop" : b.e > 0.35 ? "mid" : "quiet";
            }
            // The two bars before each drop build up to it.
            for (const d of drops) {
                const bi = bars.findIndex((b) => d >= b.i0 && d < b.i1);
                for (let k = Math.max(0, bi - 2); k < bi; k++) if (bars[k].kind !== "drop") bars[k].build = beats[d].t;
            }
            let look = null, lastBurst = -9, lastKind = null, lastCut = -99;
            bars.forEach((b, bi) => {
                const startsDrop = drops.some((d) => d >= b.i0 && d < b.i1);
                if (b.build != null) {
                    b.look = "build";
                    return;
                }
                if (b.slow) {
                    b.look = mask ? "pop" : null;
                    return;
                }
                if (b.kind === "quiet") return;
                const options = LOOKS.filter((l) => l !== look && (mask || l !== "pop"));
                b.look = look = startsDrop ? "velocity" : b.kind === "mid" && R() < 0.3 ? null : pick(options);
                // A loud-enough bar ends in a burst when its last two beats run at normal speed;
                // at most every third bar, never on the drop itself or by the finish, and a
                // flashback at most every eight bars.
                const half = Math.max(b.i0 + 1, b.i1 - 2);
                const calm = beats.slice(half, b.i1).every((x) => slowAt(x.t) < 0.1) && slowAt(b.t1 - 0.05) < 0.1;
                if (!startsDrop && bi - lastBurst >= 3 && !b.finish && b.i1 - b.i0 >= 3 && calm && b.e > 0.45) {
                    const kind = pick(BURSTS.filter((k) => k !== lastKind && (k !== "cutout" || mask && bi - lastCut >= 8)));
                    if (kind === "cutout") lastCut = bi;
                    b.burst = { kind, t0: beats[half].t, t1: b.t1, beats: beats.slice(half, b.i1).map((x) => x.t) };
                    lastBurst = bi;
                    lastKind = kind;
                }
            });
            // Velocity ramps on the beats of velocity bars that stay at normal speed.
            for (const b of bars) {
                if (b.look !== "velocity" || b.slow) continue;
                for (let i = b.i0; i < b.i1; i++) {
                    const a = beats[i].t, z = beats[i + 1]?.t;
                    if (null == z || z > end.at) continue;
                    let ok = true;
                    for (let k = 0; k <= 6; k++) if (map.rateAt(map.replayAt(a + (z - a) * k / 6)) < 0.97) ok = false;
                    if (ok && (null == finishV || z < finishV - 0.3)) warps.push({ a, b: z, lo: 0.32 });
                }
            }
        }
        const W = warper(warps);
        const replayAt = (te) => map.replayAt(W.fwd(te));
        const videoAt = (t) => W.back(map.videoAt(t));
        const speedAt = (te) => map.rateAt(replayAt(te)) * W.slope(te);

        const add = (t, kind, s, extra) => {
            if (!(t > -0.3 && t < D)) return null;
            const h = { t, kind, s, seed: Math.floor(R() * 1e6), ...extra };
            hits.push(h);
            return h;
        };
        // Anything that lights up the frame keeps 0.35 s from every other one (under 3 a second);
        // a strong one (the drop, the finish, the ending) pushes weaker ones nearby out.
        const lit = [];
        const flash = (t, style, s, extra, strong = false) => {
            if (style === "rim") return !!add(t, "flash", s, { style, color: pick(pal), ...extra });
            const near = lit.filter((x) => Math.abs(x.t - t) < 0.35);
            if (near.some((x) => x.strong || !strong)) return false;
            for (const x of near) {
                hits.splice(hits.indexOf(x.h), 1);
                lit.splice(lit.indexOf(x), 1);
            }
            const h = add(t, "flash", s, { style, color: pick(pal), ...extra });
            if (h) lit.push({ t, h, strong });
            return !!h;
        };
        add(0, "punch", 0.8);
        flash(0, "expo", 0.8);

        // Call-outs next to the car for the best few moments, never two within 1.8 s.
        const calls = [];
        if (drive) {
            const M = moments(drive, finish ?? map.end);
            for (const j of M.jumps) {
                const land = videoAt(j.t1), air = j.t1 - j.t0;
                add(land, "wave", clamp(air / 1.2, 0.5, 1));
                if (air >= 0.6) calls.push({ t: land + 0.04, text: "AIR " + air.toFixed(2) + "s", score: air });
            }
            for (const d of M.drifts) if (d.t1 - d.t0 >= 0.7) calls.push({ t: videoAt(d.t0 + 0.25), text: "DRIFT " + Math.round(d.peak * 180 / Math.PI) + "\u00b0", score: (d.t1 - d.t0) * d.peak * 1.5 });
            if (M.top) {
                const tv = videoAt(M.top.t);
                add(tv, "surge", 1);
                calls.push({ t: tv, text: Math.round(M.top.kmh) + " KM/H", score: 1.2 });
            }
            for (const t of M.surges) {
                const tv = videoAt(t);
                add(tv, "surge", 0.8);
                add(tv - 0.08, "sfx", 0.45, { sound: "swish" });
            }
        }
        const shown = [];
        for (const c of calls.sort((a, b) => b.score - a.score)) {
            if (c.t < 0.8 || c.t > (finishV ?? D) - 0.8 || shown.some((x) => Math.abs(x - c.t) < 1.8)) continue;
            shown.push(c.t);
            add(c.t, "callout", 1, { text: c.text, dur: 1.3 });
            if (shown.length >= 4) break;
        }

        if (song) {
            const beats = song.beats.filter((b) => b.t < end.at - 1e-3);
            const barOf = (t) => bars.find((b) => t >= b.t0 - 1e-3 && t < b.t1 - 1e-3);
            let twist = 1, n = 0;
            for (const d of drops) {
                const bt = song.beats[d];
                // Some songs go silent just before the drop: pull in, drained of colour, through the gap.
                let ref = 0, gap = 0;
                for (let u = song.period; u < 2 * song.period; u += 0.02) ref = Math.max(ref, song.levelAt(bt.t - u));
                for (let g = 0.03; g <= Math.min(0.8, song.period * 1.5); g += 0.02) {
                    if (song.levelAt(bt.t - g) >= Math.min(0.18, 0.3 * ref)) break;
                    gap = g + 0.01;
                }
                if (gap >= 0.15 && bt.t - gap > 0.5) add(bt.t - gap, "tension", 1, { dur: gap });
                const build = bars.filter((b) => b.build === bt.t).map((b) => b.t0);
                const from = Math.max(build.length ? Math.min(...build) : bt.t - 2, bt.t - 4, 0.2);
                if (bt.t - from > 0.8) add(from, "sfx", 0.8, { sound: "riser", dur: bt.t - from });
                add(bt.t, "sfx", 1, { sound: "subdrop" });
            }
            for (const b of bars) if (b.burst) add(b.burst.t0 - 0.12, "sfx", 0.55, { sound: "swish" });
            for (let i = 0; i < beats.length; i++) {
                const bt = beats[i], bar = barOf(bt.t);
                if (!bar) continue;
                const slow = smooth01((slowAt(bt.t) - 0.2) / 0.4);
                const e = bt.e, pos = i - bar.i0;
                const isDrop = drops.includes(i);
                const inBurst = bar.burst && bt.t >= bar.burst.t0 - 1e-3;
                add(bt.t, "punch", (0.25 + 0.75 * e * (0.4 + 0.6 * Math.max(bt.k, bt.s))) * (1 - 0.5 * slow));
                if (isDrop) {
                    add(bt.t, "invert", 1);
                    add(bt.t, "glitch", 1, { dur: 0.2 });
                    add(bt.t, "impact", 0.85);
                    flash(bt.t, "expo", 1, { color: [1, 1, 1] }, true);
                    continue;
                }
                if (bar.look === "build") {
                    const u = clamp(1 - (bar.build - bt.t) / (song.period * 8), 0, 1);
                    add(bt.t + song.period / 2, "tick", 0.3 + 0.5 * u);
                    if (bt.down || u > 0.6) flash(bt.t, u > 0.6 ? "edge" : "expo", 0.25 + 0.4 * u);
                    continue;
                }
                if ((bar.kind === "drop" || inBurst) && slow < 0.5) {
                    if (inBurst) {
                        flash(bt.t, "rim", 1);
                        add(bt.t, "shake", 0.3);
                    } else {
                        const style = bt.down ? pick(["expo", "sweep", "expo", "wash"]) : bt.n > 0.4 || pos % 2 === 1 ? pick(["chroma", "edge", mask ? "rim" : "chroma"]) : pick(["expo", "chroma"]);
                        flash(bt.t, style, 0.55 + 0.35 * bt.s);
                        add(bt.t, "shake", 0.35 * (0.5 + bt.s));
                    }
                    if (bt.n > 0.35 || pos % 2 === 1) add(bt.t, "twist", 0.5 + 0.5 * bt.n, { dir: twist = -twist });
                    if (bt.off > 0.45) add(bt.t + song.period / 2, "tick", 0.35 + 0.4 * bt.off);
                    if (bt.down && n++ % 4 === 0 && slow < 0.3) add(bt.t, "glitch", 0.6, { dur: 0.12 });
                } else if (bar.kind === "mid") {
                    if (bt.down) flash(bt.t, pick(["expo", "leak", "expo"]), (0.25 + 0.4 * e) * (1 - 0.6 * slow));
                    else if (bt.n > 0.5 && slow < 0.3) add(bt.t, "twist", 0.35 * bt.n, { dir: twist = -twist });
                } else if (bt.down && e > 0.12) {
                    flash(bt.t, "leak", (0.2 + 0.4 * e) * (1 - 0.6 * slow), { tau: 0.5 });
                }
            }
        }
        for (const s of map.slows) {
            const at = videoAt(s.a);
            add(at - 0.04, "whip", 1, { dir: R() < 0.5 ? -1 : 1 });
            add(at, "sfx", 1, { sound: "whoosh" });
            if (s.kind === "jump") {
                const land = videoAt(s.land);
                add(land, "impact", 1);
                add(land, "sfx", 1, { sound: "boom" });
            }
        }
        const slowLands = new Set(map.slows.filter((s) => s.kind === "jump").map((s) => s.land));
        for (const t of landings) {
            if (slowLands.has(t) || t > map.end) continue;
            add(videoAt(t), "impact", 0.45);
        }
        const grabs = [];
        for (const t of cuts) {
            if (t < 0.3 || t > map.end) continue;
            const te = videoAt(t);
            grabs.push(te + 0.3);
            add(te, "whip", 0.45, { dir: R() < 0.5 ? -1 : 1 });
            add(te - 0.1, "sfx", 0.3, { sound: "swish" });
            flash(te, pick(["chroma", "expo"]), 0.4, { tau: 0.06 });
        }
        for (const c of checkpoints) if (c.t <= map.end) {
            const te = videoAt(c.t);
            add(te, "pulse", 0.7);
            flash(te, "edge", null == c.diff ? 0.35 : 0.5, { color: null == c.diff ? base : c.diff <= 0 ? [0.25, 1, 0.45] : [1, 0.25, 0.25] });
        }
        if (null != finishV) {
            add(finishV, "impact", 1.2);
            flash(finishV, "expo", 1, { color: [1, 1, 1] }, true);
            add(finishV + 0.02, "flash", 0.8, { style: "leak", color: pick(leaks), tau: 0.5 });
            add(finishV, "glitch", 0.8, { dur: 0.16 });
            add(finishV, "sfx", 1.3, { sound: "boom" });
        }
        if (song && end.at < D - 0.3 && (null == finishV || end.at > finishV + 0.25)) {
            add(end.at, "punch", 1);
            flash(end.at, "wash", 0.7, null, true);
            add(end.at, "sfx", 0.9, { sound: "boom" });
        }
        for (const h of hits.filter((x) => x.kind === "glitch")) add(h.t, "sfx", 0.6 * h.s, { sound: "glitch", dur: h.dur });
        // Earlier views kept for the cutout's background (one shortly after each cut, else every 1.5 s).
        for (let t = 0.4; t < D; t += 1.5) if (grabs.every((g) => Math.abs(g - t) > 0.5)) grabs.push(t);
        grabs.sort((x, y) => x - y);
        const BANK = FX.BANK;
        for (const b of bars) {
            if (!b.burst) continue;
            let last = -1;
            b.burst.picks = b.burst.beats.map((t) => {
                const have = grabs.filter((g) => g < t - 0.05).length;
                const ok = [];
                for (let k = Math.max(0, have - BANK); k < have; k++) if (grabs[k] < t - 0.8 && k !== last) ok.push(k);
                const grab = ok.length ? ok[Math.floor(R() * ok.length)] : -1;
                last = grab;
                return { t, grab, tint: pick(pal), solid: grab < 0 };
            });
        }
        hits.sort((x, y) => x.t - y.t);
        return { map, song, hits, bars, grabs, warps, duration: D, accent, palette: pal, mask: !!mask, drive, end, finishV, replayAt, videoAt, speedAt };
    }

    function noise(t, k) {
        return (Math.sin(t * 37.1 + k * 11.3) * 0.5 + Math.sin(t * 23.7 + k * 5.1) * 0.3 + Math.sin(t * 61.3 + k * 2.7) * 0.2);
    }

    function barAt(bars, te) {
        let lo = 0, hi = bars.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1, b = bars[mid];
            if (te < b.t0) hi = mid - 1;
            else if (te >= b.t1) lo = mid + 1;
            else return b;
        }
        return null;
    }

    // The look of one frame at video time te. `kmh` is the followed car's speed; `car` is where
    // it is on screen ({x, y} 0..1 from the bottom left, r its rough radius, on = in front of the
    // camera, tx/ty where it was a moment ago, for the direction it moves across the frame).
    function paramsAt(edit, te, kmh, car) {
        const map = edit.map, t = edit.replayAt(te);
        const speed = clamp((kmh - 80) / 320, 0, 1);
        const slow = clamp((1 - map.rateAt(t)) / 0.7, 0, 1);
        const seen = !!car?.on && car.r > 0.012;
        let zoom = 0, chroma = 0, shake = 0, whip = 0, whipDir = 1, glitch = 0, gseed = 0, invert = 0, rot = 0, blur = 0, lines = 0;
        let expo = 0, wash = [0, 0, 0, 0], edge = [0, 0, 0, 0], leak = [0, 0, 0, 0], leakPos = [0.85, 0.85], sweep = -9, rim = 0, rimColor = [1, 1, 1];
        let tension = 0, wave = [0, 0, 0], waveAmp = 0, callout = null;
        const strongest = (cur, c, a) => a > cur[3] ? [c[0], c[1], c[2], a] : cur;
        for (const h of edit.hits) {
            const d = te - h.t;
            if (d < -0.25) break;
            if (d > 1.6) continue;
            const env = (a, k) => d < 0 ? 0 : d < a ? d / a : Math.exp(-(d - a) / k);
            switch (h.kind) {
                case "punch":
                    zoom += 0.07 * h.s * env(0.03, 0.15);
                    chroma += 0.004 * h.s * env(0.01, 0.1);
                    break;
                case "twist":
                    rot += h.dir * 0.035 * h.s * env(0.02, 0.12);
                    zoom += 0.02 * h.s * env(0.02, 0.1);
                    break;
                case "tick":
                    chroma += 0.006 * h.s * env(0.005, 0.06);
                    zoom += 0.015 * h.s * env(0.01, 0.06);
                    break;
                case "flash": {
                    if (d < 0) break;
                    const f = h.s * (d < 0.02 ? 1 : Math.exp(-(d - 0.02) / (h.tau ?? 0.11)));
                    switch (h.style) {
                        case "expo":
                            expo = Math.max(expo, f);
                            break;
                        case "wash":
                            wash = strongest(wash, h.color, f * 0.75);
                            expo = Math.max(expo, f * 0.35);
                            break;
                        case "edge":
                            edge = strongest(edge, h.color, f);
                            break;
                        case "leak":
                            if (f > leak[3]) {
                                leak = strongest(leak, h.color, f);
                                const side = h.seed % 4;
                                leakPos = [side & 1 ? 1.05 - d * 0.5 : -0.05 + d * 0.5, side & 2 ? 1 : 0.1];
                            }
                            break;
                        case "sweep":
                            if (d < 0.3) sweep = -0.25 + d / 0.3 * 1.5;
                            expo = Math.max(expo, f * 0.3);
                            break;
                        case "chroma":
                            chroma += 0.03 * f;
                            expo = Math.max(expo, f * 0.25);
                            zoom += 0.03 * f;
                            break;
                        case "rim":
                            if (f > rim) {
                                rim = f;
                                rimColor = h.color;
                            }
                            break;
                    }
                    break;
                }
                case "impact":
                    shake += h.s * env(0.01, 0.22);
                    zoom += 0.09 * h.s * env(0.02, 0.2);
                    chroma += 0.012 * h.s * env(0.01, 0.16);
                    expo = Math.max(expo, d < 0 ? 0 : 0.4 * h.s * Math.exp(-d / 0.08));
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
                case "tension":
                    if (d >= 0 && d < h.dur) tension = d / h.dur;
                    break;
                case "wave":
                    // A ring of distortion running out from the car as it lands.
                    if (d >= 0 && d < 0.7 && seen) {
                        wave = [car.x, car.y, 0.03 + d * 1.1];
                        waveAmp = Math.max(waveAmp, 0.022 * h.s * Math.pow(1 - d / 0.7, 1.5));
                    }
                    break;
                case "surge":
                    // Speed: the frame pulls back while streaks and speed lines rush past.
                    zoom -= 0.06 * h.s * env(0.04, 0.35);
                    blur += 0.12 * h.s * env(0.03, 0.3);
                    chroma += 0.012 * h.s * env(0.02, 0.25);
                    lines = Math.max(lines, h.s * env(0.05, 0.5));
                    break;
                case "callout":
                    if (d >= 0 && d < h.dur) callout = { text: h.text, d, dur: h.dur };
                    break;
            }
        }
        // The car's own state: sliding leans the frame into the slide and streaks the car,
        // flying streaks it too.
        let drift = 0, lean = 0, airK = 0;
        const dr = edit.drive;
        if (dr) {
            const i0 = Math.round(t / dr.dt), n = dr.spd.length;
            let sl = 0, ai = 0, k = 0;
            for (let i = Math.max(0, i0 - 6); i <= Math.min(n - 1, i0 + 6); i++, k++) {
                sl += dr.spd[i] > 60 && !dr.air[i] ? dr.slip[i] : 0;
                ai += dr.air[i];
            }
            if (k) {
                sl /= k;
                drift = smooth01((Math.abs(sl) - 0.18) / 0.3);
                lean = Math.sign(sl) * drift;
                airK = smooth01((ai / k - 0.5) / 0.4) * (kmh > 60 ? 1 : 0);
            }
        }
        const bar = edit.bars.length ? barAt(edit.bars, te) : null;
        const loud = bar?.kind === "drop";
        let pop = 0, hue = 0, bg = 0, bgColor = [0, 0, 0, 1], bgGrab = -1, outline = [1, 1, 1, 0], split = 0, extraZoom = 0, sat = 0;
        let trail = Math.max(0.85 * drift, 0.75 * airK), echo = 0, echoPhase = 0, echoColor = edit.palette[0];
        let pivotCar = 0.35;
        if (bar) {
            const into = te - bar.t0, inK = smooth01(into / 0.06);
            switch (bar.look) {
                case "pop":
                    pop = 0.88 * inK;
                    break;
                case "hue":
                    hue = (bar.i0 % 2 ? 1 : -1) * 0.4 * inK;
                    sat += 0.25;
                    break;
                case "trail":
                    trail = Math.max(trail, (0.35 + 0.6 * speed) * inK);
                    pivotCar = 0.6;
                    break;
                case "velocity":
                    pivotCar = 0.7;
                    break;
                case "zoom":
                    pivotCar = 0.8;
                    extraZoom = 0.05 * (1 - smooth01(((te - bar.t0) % (edit.song?.period || 0.5)) / 0.25));
                    break;
                case "build": {
                    const u = clamp(1 - (bar.build - te) / ((edit.song?.period || 0.5) * 8), 0, 1);
                    extraZoom = 0.12 * u * u;
                    shake += 0.5 * u * u;
                    sat -= 0.6 * u;
                    chroma += 0.01 * u;
                    break;
                }
            }
            const b = bar.burst;
            if (b && te >= b.t0 && te < b.t1) {
                const p = b.picks?.filter((x) => x.t <= te + 1e-4).pop();
                if (b.kind === "cutout" && (seen || p && !p.solid)) {
                    // A flashback: an earlier view with its own car in it, outlined and kept in
                    // colour; with no earlier view yet, the car now over a solid colour.
                    bg = 1;
                    outline = [1, 1, 1, 1];
                    sat += 0.3;
                    trail = 0;
                    pivotCar = p && !p.solid ? 0 : 0.9;
                    if (p) {
                        bgGrab = p.solid ? -1 : p.grab;
                        bgColor = [...p.tint, p.solid ? 1 : 0.3];
                    }
                } else if (b.kind === "echo" && seen) {
                    echo = 1;
                    echoPhase = p ? clamp((te - p.t) / (edit.song?.period || 0.5), 0, 1) : 0;
                    echoColor = p?.tint ?? echoColor;
                    pivotCar = 0.85;
                    outline = [...echoColor, 0.8];
                    sat -= 0.25;
                } else {
                    split = 3;
                    bgColor = [...(p?.tint ?? edit.palette[0]), 1];
                }
            }
        }
        if (edit.mask && slow > 0.35) pop = Math.max(pop, 0.5 * smooth01((slow - 0.35) / 0.3));
        if (tension > 0) {
            sat -= 1;
            extraZoom += 0.08 * tension;
            shake += 0.3 * tension;
        }
        if (rim > 0 && edit.mask && seen) outline = rim > outline[3] ? [...rimColor, rim] : outline;
        else if (rim > 0) edge = strongest(edge, rimColor, rim * 0.8);
        if (!edit.mask) {
            if (pop > 0) sat -= 0.7 * pop;
            pop = 0;
        }
        if (!seen) trail = 0;
        // The streak runs back from the car along the way it moves across the frame, longer the faster it goes.
        let trailDir = [0, 0];
        if (trail > 0) {
            let dx = car.x - (car.tx ?? car.x), dy = car.y - (car.ty ?? car.y);
            // Heading straight into the frame: the streak comes back out towards the viewer.
            if (Math.hypot(dx, dy) < 0.003) {
                dx = 0.5 - car.x;
                dy = 0.5 - car.y + 0.02;
            }
            const l = Math.hypot(dx, dy) || 1, len = 0.05 + 0.18 * speed;
            trailDir = [dx / l * len, dy / l * len];
        }
        rot += 0.045 * lean;
        shake = Math.min(shake, 1.6) + 0.12 * speed * (1 - slow);
        const fadeFrom = edit.song && edit.end.at < edit.duration - 0.3 ? edit.end.at : edit.duration - 0.55;
        const fadeOut = Math.pow(clamp((te - fadeFrom) / (edit.duration - fadeFrom), 0, 1), 1.4);
        const k = seen ? pivotCar : 0;
        const center = [0.5 + (clamp(car?.x ?? 0.5, 0.15, 0.85) - 0.5) * k, 0.5 + (clamp(car?.y ?? 0.5, 0.15, 0.85) - 0.5) * k];
        return {
            zoom: 1.045 + 0.025 * speed * (1 - slow) + Math.min(zoom, 0.16) + extraZoom,
            center,
            shake: [noise(te, 1) * 0.011 * shake, noise(te, 2) * 0.011 * shake],
            rot: noise(te, 3) * 0.014 * shake + clamp(rot, -0.09, 0.09),
            blur: 0.055 * speed * (1 - slow) + 0.02 * Math.min(1, Math.max(0, zoom) * 8) + 0.035 * Math.max(0, edit.speedAt(te) - 1.1) + blur,
            whip: whip * 0.09,
            whipDir,
            chroma: 0.0012 + 0.0025 * speed + Math.min(chroma, 0.03),
            lines: Math.max(lines, smooth01((speed - 0.45) / 0.4)) * (1 - slow),
            sat: Math.max(0, (loud ? 1.38 : 1.22) - 0.4 * slow + sat),
            contrast: (loud ? 1.1 : 1.06) + 0.04 * slow,
            sharpen: loud ? 0.55 : 0.22,
            vignette: 0.22 + 0.3 * slow + 0.3 * tension,
            glitch,
            gseed: gseed % 997,
            invert,
            time: te,
            expo: 1 + 3.2 * Math.min(expo, 1),
            wash,
            edge,
            leak,
            leakPos,
            sweep,
            pop,
            hue,
            bg,
            bgColor,
            bgGrab,
            outline,
            split,
            trail,
            trailDir,
            echo,
            echoPhase,
            echoColor,
            carAt: seen ? [car.x, car.y] : [0.5, 0.5],
            wave,
            waveAmp,
            mask: edit.mask && seen && (pop > 0 || bg > 0 || outline[3] > 0 || trail > 0.01 || echo > 0),
            callout: callout && seen ? { ...callout, x: car.x, y: car.y, r: car.r } : callout,
            fade: fadeOut
        };
    }

    const VERT = `#version 300 es
in vec2 p;
out vec2 v;
void main() { v = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;
    const FRAG = `#version 300 es
precision highp float;
uniform sampler2D T, M, B, BM;
uniform vec2 R, SH, WD, ZC, LP, CC, TRD;
uniform vec3 WV;
uniform float Z, ROT, BL, CH, GL, GS, LN, TM, SAT, CON, VIG, GR, INV, WH;
uniform float EX, POP, HUE, SHP, BGK, BGH, BMH, SPL, MK, SWP, TRK, ECH, ECP, WVA;
uniform vec4 WA, ED, LK, BGC, OL, ECC;
in vec2 v;
out vec4 o;
float h(vec2 q) { return fract(sin(dot(q, vec2(12.9898, 78.233))) * 43758.5453); }
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 hue(vec3 c, float a) {
    const vec3 k = vec3(0.57735);
    float ca = cos(a);
    return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
}
vec3 screen(vec3 c, vec3 add) { return 1.0 - (1.0 - c) * (1.0 - clamp(add, 0.0, 1.0)); }
void main() {
    float asp = R.x / R.y;
    vec2 w = v;
    float panel = 1.0;
    if (SPL > 0.5) {
        panel = floor(w.x * SPL);
        w.x = 0.5 + (fract(w.x * SPL) - 0.5) / SPL;
    }
    vec2 q = w - ZC;
    q.x *= asp;
    float c = cos(ROT), s = sin(ROT);
    q = mat2(c, -s, s, c) * q / Z;
    q.x /= asp;
    vec2 uv = q + ZC + SH;
    float ring = 0.0;
    if (WVA > 0.0) {
        vec2 wq = uv - WV.xy;
        wq.x *= asp;
        float r = length(wq);
        ring = exp(-pow((r - WV.z) / 0.04, 2.0));
        vec2 dir = wq / max(r, 1e-4);
        dir.x /= asp;
        uv -= dir * ring * WVA;
    }
    float gl = 0.0;
    if (GL > 0.0) {
        float band = floor(v.y * 16.0 + h(vec2(GS, 3.0)) * 5.0);
        if (h(vec2(band, GS)) < GL * 0.6) {
            uv.x += (h(vec2(band, GS + 7.0)) - 0.5) * 0.16 * GL;
            gl = GL;
        }
    }
    vec2 d = (uv - ZC) * BL + WD * WH;
    vec2 rd = (uv - 0.5) * (CH + gl * 0.02);
    int n = dot(d, d) * R.x * R.x > 1.0 ? 16 : 1;
    vec3 acc = vec3(0.0);
    float ws = 0.0;
    for (int i = 0; i < 16; i++) {
        if (i >= n) break;
        float k = n > 1 ? float(i) / 15.0 : 0.0;
        float wt = 1.0 - 0.7 * k;
        vec2 u = uv - d * k;
        acc += vec3(texture(T, u + rd).r, texture(T, u).g, texture(T, u - rd).b) * wt;
        ws += wt;
    }
    vec3 col = acc / ws;
    if (SHP > 0.0) {
        vec2 px = 1.25 / R;
        vec3 nb = texture(T, uv + vec2(px.x, 0.0)).rgb + texture(T, uv - vec2(px.x, 0.0)).rgb + texture(T, uv + vec2(0.0, px.y)).rgb + texture(T, uv - vec2(0.0, px.y)).rgb;
        col += (col - nb * 0.25) * SHP;
    }
    float m = 0.0, edge = 0.0;
    if (MK > 0.5) {
        m = smoothstep(0.25, 0.75, texture(M, uv).r);
        float dm = m;
        vec2 px = vec2(0.006 / asp, 0.006);
        for (int i = 0; i < 12; i++) {
            float a = float(i) * 0.5236;
            dm = max(dm, texture(M, uv + vec2(cos(a), sin(a)) * px).r);
        }
        edge = clamp(smoothstep(0.15, 0.55, dm) - m, 0.0, 1.0);
    }
    float world = 1.0 - m;
    if (TRK > 0.0 && MK > 0.5) {
        float tr = 0.0, j = h(v * R + TM) / 16.0;
        vec3 tc = vec3(0.0);
        for (int i = 1; i <= 16; i++) {
            float k = float(i) / 16.0 - j;
            vec2 su = uv + TRD * k;
            float mm = smoothstep(0.3, 0.8, texture(M, su).r) * (1.0 - k * 0.9);
            if (mm > tr) {
                tr = mm;
                tc = texture(T, su).rgb;
            }
        }
        col = mix(col, tc * 1.15 + 0.05, tr * TRK * world * 0.8);
    }
    if (ECH > 0.0 && MK > 0.5) {
        col = mix(col, col * 0.6, ECH * world);
        for (int i = 3; i >= 1; i--) {
            float sc = 1.0 + (0.08 + 0.22 * ECP) * float(i);
            float mm = smoothstep(0.2, 0.8, texture(M, CC + (uv - CC) / sc).r) * (1.0 - 0.22 * float(i)) * (1.0 - ECP * 0.5);
            vec3 ec = i == 2 ? vec3(1.0) : i == 3 ? hue(ECC.rgb, 2.1) : ECC.rgb;
            col = mix(col, ec, mm * ECH * world);
        }
    }
    if (LN > 0.0) {
        vec2 r = v - vec2(0.5, 0.48);
        r.x *= asp;
        float a = atan(r.y, r.x) * 38.0 / 3.14159265;
        float cell = floor(a);
        float on = step(0.86, h(vec2(cell, floor(TM * 24.0))));
        float thin = pow(1.0 - abs(fract(a) - 0.5) * 2.0, 6.0);
        col = mix(col, vec3(1.0), on * thin * smoothstep(0.42, 0.95, length(r)) * LN * 0.5 * world);
    }
    if (BGK > 0.0 && BGH > 0.5) {
        vec3 b = texture(B, uv).rgb;
        float bm = 0.0, be = 0.0;
        if (BMH > 0.5) {
            bm = smoothstep(0.25, 0.75, texture(BM, uv).r);
            float dm = bm;
            vec2 px = vec2(0.006 / asp, 0.006);
            for (int i = 0; i < 12; i++) {
                float a = float(i) * 0.5236;
                dm = max(dm, texture(BM, uv + vec2(cos(a), sin(a)) * px).r);
            }
            be = clamp(smoothstep(0.15, 0.55, dm) - bm, 0.0, 1.0);
        }
        vec3 fb = mix(mix(b, BGC.rgb * (0.2 + 1.2 * lum(b)), BGC.a), b * 1.05, bm);
        col = mix(col, mix(fb, OL.rgb, be * OL.a), BGK);
        m = 0.0;
        edge = 0.0;
        world = 1.0;
    } else if (BGK > 0.0) {
        vec2 g = v - 0.5;
        g.x *= asp;
        col = mix(col, BGC.rgb * (1.15 - 0.6 * length(g)), BGK * world);
    }
    if (POP > 0.0) {
        float l = lum(col);
        col = mix(col, vec3(clamp(0.06 + 1.15 * l, 0.0, 1.0)), POP * world);
    }
    if (OL.a > 0.0) col = mix(col, OL.rgb, OL.a * edge);
    if (HUE != 0.0) col = hue(col, HUE);
    col = screen(col, vec3(0.9) * ring * WVA * 18.0);
    float l = lum(col);
    col = mix(vec3(l), col, SAT);
    col = (col - 0.5) * CON + 0.5;
    col += vec3(0.03, 0.005, -0.02) * smoothstep(0.45, 1.0, l) + vec3(-0.02, 0.008, 0.035) * (1.0 - smoothstep(0.0, 0.45, l));
    if (SPL > 0.5) {
        if (panel < 0.5) col = BGC.rgb * (0.15 + 1.1 * lum(col));
        else if (panel > 1.5) col = hue(col, 2.2);
        float f = fract(v.x * SPL);
        if (f < 0.006 * SPL / asp || f > 1.0 - 0.006 * SPL / asp) col = vec3(0.0);
    }
    if (EX > 1.0) col = 1.0 - pow(1.0 - clamp(col, 0.0, 1.0), vec3(EX));
    col = screen(col, WA.rgb * WA.a);
    vec2 lq = v - LP;
    lq.x *= asp;
    col = screen(col, LK.rgb * LK.a * exp(-dot(lq, lq) * 2.2));
    vec2 eq = v - 0.5;
    eq.x *= asp * 0.7;
    col = screen(col, ED.rgb * ED.a * smoothstep(0.22, 0.72, length(eq)));
    if (SWP > -2.0) {
        float dd = (v.x * asp * 0.4 + v.y) / (asp * 0.4 + 1.0) - SWP;
        col = screen(col, vec3(0.85) * exp(-dd * dd / 0.0018));
    }
    col = mix(col, 1.0 - col, INV);
    vec2 vq = v - 0.5;
    vq.x *= asp * 0.7;
    col *= 1.0 - VIG * smoothstep(0.3, 0.85, length(vq));
    col += (h(v * R + fract(TM * 7.13) * 91.0) - 0.5) * GR;
    o = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

    // The effects pass on the GPU, reading the game's own canvas (and, for cutouts, a mask of
    // the followed car). It keeps a few earlier views, each with its car's mask, for flashbacks.
    // Without WebGL 2 only the camera moves (zoom, shake, tilt) are drawn, on a 2D canvas.
    class FX {
        static BANK = 8;

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
            this.reset();
        }

        static supported() {
            try {
                return !!document.createElement("canvas").getContext("webgl2");
            } catch (e) {
                return false;
            }
        }

        reset() {
            this.lastTe = null;
            this.maskOk = false;
            this.grabbed = 0;
            this.nextGrab = 0;
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
            const tex = () => {
                const t = gl.createTexture();
                gl.bindTexture(gl.TEXTURE_2D, t);
                for (const [k, val] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, val);
                return t;
            };
            this.tex = tex();
            this.maskTex = tex();
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
            this.bank = [];
            for (let i = 0; i < FX.BANK; i++) this.bank.push({ tex: tex(), fb: gl.createFramebuffer(), w: 0, h: 0, mask: tex(), maskFb: gl.createFramebuffer(), mw: 0, mh: 0, hasMask: false });
            this.readFb = gl.createFramebuffer();
            this.maskW = this.maskH = 1;
            this.u = {};
            for (const name of ["T", "M", "B", "BM", "R", "SH", "WD", "ZC", "LP", "Z", "ROT", "BL", "CH", "GL", "GS", "LN", "TM", "SAT", "CON", "VIG", "GR", "INV", "WH", "EX", "POP", "HUE", "SHP", "BGK", "BGH", "BMH", "SPL", "MK", "SWP", "WA", "ED", "LK", "BGC", "OL", "CC", "TRD", "WV", "TRK", "ECH", "ECP", "WVA", "ECC"]) this.u[name] = gl.getUniformLocation(prog, name);
        }

        // Copies the current frame into the next bank slot, with the car's mask from
        // the same frame when there is one.
        grab(W, H) {
            const gl = this.gl, slot = this.bank[this.grabbed % FX.BANK];
            const w = W, h = H;
            if (slot.w !== w || slot.h !== h) {
                gl.bindTexture(gl.TEXTURE_2D, slot.tex);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
                gl.bindFramebuffer(gl.FRAMEBUFFER, slot.fb);
                gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, slot.tex, 0);
                slot.w = w;
                slot.h = h;
            }
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.readFb);
            gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
            gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, slot.fb);
            gl.blitFramebuffer(0, 0, W, H, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.LINEAR);
            slot.hasMask = this.maskOk;
            if (this.maskOk) {
                const mw = this.maskW, mh = this.maskH;
                if (slot.mw !== mw || slot.mh !== mh) {
                    gl.bindTexture(gl.TEXTURE_2D, slot.mask);
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, mw, mh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
                    gl.bindFramebuffer(gl.FRAMEBUFFER, slot.maskFb);
                    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, slot.mask, 0);
                    slot.mw = mw;
                    slot.mh = mh;
                }
                gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.readFb);
                gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.maskTex, 0);
                gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, slot.maskFb);
                gl.blitFramebuffer(0, 0, mw, mh, 0, 0, mw, mh, gl.COLOR_BUFFER_BIT, gl.NEAREST);
            }
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
            gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
            this.grabbed++;
        }

        // `getMask()` gives the followed car's mask ({data, w, h}, RGBA rows from the bottom) or null.
        render(src, W, H, p, grabs = [], getMask = null) {
            if (this.canvas.width !== W || this.canvas.height !== H) {
                this.canvas.width = W;
                this.canvas.height = H;
                this.reset();
            }
            if (null != this.lastTe && p.time < this.lastTe - 1e-6) this.reset();
            this.lastTe = p.time;
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
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.tex);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
            this.maskOk = false;
            const due = this.nextGrab < grabs.length && grabs[this.nextGrab] <= p.time;
            const m = (p.mask || due) && getMask ? getMask() : null;
            if (m) {
                this.maskW = m.w;
                this.maskH = m.h;
                gl.activeTexture(gl.TEXTURE1);
                gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
                gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, m.w, m.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, m.data);
                this.maskOk = true;
            }
            while (this.nextGrab < grabs.length && grabs[this.nextGrab] <= p.time) {
                this.grab(W, H);
                this.nextGrab++;
            }
            let bankSlot = null;
            if (p.bg > 0 && p.bgGrab >= 0 && this.grabbed > 0) {
                const k = clamp(p.bgGrab, Math.max(0, this.grabbed - FX.BANK), this.grabbed - 1);
                bankSlot = this.bank[k % FX.BANK];
            }
            gl.useProgram(this.prog);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.tex);
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
            gl.activeTexture(gl.TEXTURE2);
            gl.bindTexture(gl.TEXTURE_2D, bankSlot ? bankSlot.tex : this.tex);
            gl.activeTexture(gl.TEXTURE3);
            gl.bindTexture(gl.TEXTURE_2D, bankSlot?.hasMask ? bankSlot.mask : this.maskTex);
            gl.activeTexture(gl.TEXTURE0);
            gl.uniform1i(u.T, 0);
            gl.uniform1i(u.M, 1);
            gl.uniform1i(u.B, 2);
            gl.uniform1i(u.BM, 3);
            const useMask = this.maskOk && p.mask;
            gl.uniform2f(u.R, W, H);
            gl.uniform2f(u.SH, p.shake[0], p.shake[1]);
            gl.uniform2f(u.WD, p.whipDir, 0);
            gl.uniform2f(u.ZC, p.center[0], p.center[1]);
            gl.uniform2f(u.LP, p.leakPos[0], p.leakPos[1]);
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
            gl.uniform1f(u.EX, p.expo);
            gl.uniform1f(u.POP, useMask ? p.pop : 0);
            gl.uniform1f(u.HUE, p.hue);
            gl.uniform1f(u.SHP, p.sharpen);
            gl.uniform1f(u.BGK, bankSlot || useMask ? p.bg : 0);
            gl.uniform1f(u.BGH, bankSlot ? 1 : 0);
            gl.uniform1f(u.BMH, bankSlot?.hasMask ? 1 : 0);
            gl.uniform1f(u.SPL, p.split);
            gl.uniform1f(u.MK, useMask ? 1 : 0);
            gl.uniform1f(u.SWP, p.sweep);
            gl.uniform4fv(u.WA, p.wash);
            gl.uniform4fv(u.ED, p.edge);
            gl.uniform4fv(u.LK, p.leak);
            gl.uniform4fv(u.BGC, p.bgColor);
            gl.uniform4fv(u.OL, useMask || bankSlot ? p.outline : [0, 0, 0, 0]);
            gl.uniform2f(u.CC, p.carAt[0], p.carAt[1]);
            gl.uniform2f(u.TRD, p.trailDir[0], p.trailDir[1]);
            gl.uniform3f(u.WV, p.wave[0], p.wave[1], p.wave[2]);
            gl.uniform1f(u.WVA, p.waveAmp);
            gl.uniform1f(u.TRK, useMask ? p.trail : 0);
            gl.uniform1f(u.ECH, useMask ? p.echo : 0);
            gl.uniform1f(u.ECP, p.echoPhase);
            gl.uniform4f(u.ECC, p.echoColor[0], p.echoColor[1], p.echoColor[2], 1);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            return this.canvas;
        }

        dispose() {
            this.gl?.getExtension("WEBGL_lose_context")?.loseContext();
        }
    }

    // On top of the overlays: call-outs beside the car (big air, drifts, top speed), and the fade
    // at the end, which covers everything. `font` is the game's font family; `bar` the letterbox height.
    function paintTop(g, W, H, p, bar = 0, font = "sans-serif") {
        const c = p.callout;
        if (c) {
            const a = clamp(c.d / 0.06, 0, 1) * clamp((c.dur - c.d) / 0.2, 0, 1);
            const s = 1 + 0.25 * Math.exp(-c.d / 0.06);
            const size = H * 0.036;
            g.save();
            g.font = "bold " + size.toFixed(1) + "px " + font;
            const tw = g.measureText(c.text).width, bw = tw + size * 1.4, bh = size * 1.55;
            const cx = null != c.x ? clamp(c.x * W, bw / 2 + 12, W - bw / 2 - 12) : W / 2;
            const above = null != c.y ? (1 - c.y) * H - (c.r * H + bh * 0.9) : H * 0.3;
            const cy = clamp(above, bar + bh, H * 0.68) - 10 * (1 - a);
            g.globalAlpha = a;
            g.translate(cx, cy);
            g.scale(s, s);
            const sk = bh * 0.25;
            g.beginPath();
            g.moveTo(-bw / 2 + sk, -bh / 2);
            g.lineTo(bw / 2, -bh / 2);
            g.lineTo(bw / 2 - sk, bh / 2);
            g.lineTo(-bw / 2, bh / 2);
            g.closePath();
            g.fillStyle = "rgba(25, 32, 66, 0.88)";
            g.fill();
            g.fillStyle = "#7272c2";
            g.fillRect(-bw / 2 + sk * 0.2, bh / 2 - bh * 0.1, bw - sk * 1.2, bh * 0.1);
            g.fillStyle = "#fff";
            g.textAlign = "center";
            g.textBaseline = "middle";
            g.fillText(c.text, 0, size * 0.05);
            g.restore();
        }
        if (p.fade > 0) {
            g.globalAlpha = p.fade;
            g.fillStyle = "#000";
            g.fillRect(0, 0, W, H);
        }
        g.globalAlpha = 1;
    }

    // The edit's sound effects, made here (no samples): whooshes into slow motion, booms on landings
    // and the finish, a riser into each drop and a sub drop on it, swishes, glitch blips.
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
            } else if (h.sound === "riser") {
                // Noise through a band-pass that sweeps up, getting louder, cut dead on the drop.
                const at = Math.round(h.t * SR), m = Math.round(h.dur * SR);
                let lo = 0, bp = 0, ph = 0;
                for (let i = 0; i < m; i++) {
                    const k = at + i;
                    if (k < 0 || k >= n) continue;
                    const x = i / m;
                    const f = 2 * Math.sin(Math.PI * Math.min(0.45 * SR, 350 * Math.pow(22, x)) / SR);
                    lo += f * bp;
                    bp += f * (R() * 2 - 1 - lo - 0.25 * bp);
                    ph += 2 * Math.PI * (180 * Math.pow(4, x)) / SR;
                    const amp = 0.16 * h.s * x * x * Math.min(1, (m - i) / (0.004 * SR));
                    const v = bp * amp + Math.sin(ph) * amp * 0.25;
                    L[k] += v * (1 - 0.3 * Math.sin(x * 40));
                    Rr[k] += v * (1 + 0.3 * Math.sin(x * 40));
                }
            } else if (h.sound === "subdrop") {
                const at = Math.round(h.t * SR), m = Math.round(1.6 * SR);
                let ph = 0;
                for (let i = 0; i < m; i++) {
                    const k = at + i;
                    if (k < 0 || k >= n) continue;
                    const t = i / SR;
                    ph += 2 * Math.PI * (32 + 60 * Math.exp(-t / 0.25)) / SR;
                    const v = Math.tanh(1.6 * Math.sin(ph)) * 0.38 * h.s * Math.exp(-t / 0.6) * Math.min(1, t / 0.003);
                    L[k] += v;
                    Rr[k] += v;
                }
            } else if (h.sound === "swish") {
                const at = Math.round(h.t * SR), m = Math.round(0.24 * SR);
                let lo = 0, bp = 0;
                for (let i = 0; i < m; i++) {
                    const k = at + i;
                    if (k < 0 || k >= n) continue;
                    const x = i / m, bell = Math.sin(Math.PI * x);
                    const f = 2 * Math.sin(Math.PI * (1200 + 4200 * bell) / SR);
                    lo += f * bp;
                    bp += f * (R() * 2 - 1 - lo - 0.5 * bp);
                    const v = bp * 0.3 * h.s * bell * bell;
                    L[k] += v * (1.3 - x);
                    Rr[k] += v * (0.3 + x);
                }
            } else if (h.sound === "glitch") {
                // Short square-wave blips at random pitches, some gaps: a digital stutter.
                const at = Math.round(h.t * SR), m = Math.round(Math.max(0.12, h.dur) * SR), seg = Math.round(0.025 * SR);
                let freq = 0, on = false;
                for (let i = 0; i < m; i++) {
                    const k = at + i;
                    if (i % seg === 0) {
                        freq = 180 * Math.pow(12, R());
                        on = R() < 0.7;
                    }
                    if (k < 0 || k >= n || !on) continue;
                    const v = (Math.sin(2 * Math.PI * freq * i / SR) > 0 ? 1 : -1) * 0.07 * h.s * (1 - i / m);
                    L[k] += v;
                    Rr[k] += v * (i % (2 * seg) < seg ? 0.4 : 1);
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

    window.__nswsEdit = { analyzeSong, dropStart, endingFor, timeMap, plan, paramsAt, paintTop, sfx, FX, hash };
})();
