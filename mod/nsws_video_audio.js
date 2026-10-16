(() => {
    // Sound for saved videos: the cars as a trackside microphone would hear them, and
    // background music (generated here, or a song from the player's own device).
    const SR = 48000;
    const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
    const SOUND_SPEED = 343;

    function hashString(s) {
        let h = 2166136261;
        for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
        return h >>> 0;
    }

    function rng(seed) {
        let a = seed >>> 0;
        return () => {
            a = (a + 0x6d2b79f5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    // ---------- cars ----------

    // `cap` is what the export recorded each frame: the camera (listener) and, per car, its
    // position and the engine/tyre/skid targets the game set, plus one-off sounds. The game's
    // own smoothing is replayed, then Doppler from the car's and the camera's real movement,
    // distance and air absorption are applied on top.
    async function renderCars(cap, getBuffer, duration) {
        const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(duration * SR)), SR);
        const engineBuf = getBuffer("engine"), tireBuf = getBuffer("tires"), skidBuf = getBuffer("skidding");
        const frames = cap.frames;
        if (!frames.length) return ctx.startRendering();
        const L = ctx.listener;
        const lp = [L.positionX, L.positionY, L.positionZ, L.forwardX, L.forwardY, L.forwardZ, L.upX, L.upY, L.upZ];
        frames.forEach((f, n) => {
            for (let k = 0; k < 9; k++) n === 0 ? lp[k].setValueAtTime(f.cam[k], 0) : lp[k].linearRampToValueAtTime(f.cam[k], f.t);
        });
        const master = ctx.createGain();
        master.connect(ctx.destination);

        const ids = new Set();
        for (const f of frames) for (const id of f.cars.keys()) ids.add(id);
        for (const id of ids) {
            const panner = ctx.createPanner();
            panner.panningModel = "equalpower";
            panner.distanceModel = "inverse";
            panner.refDistance = 3;
            panner.rolloffFactor = 1;
            const air = ctx.createBiquadFilter();
            air.type = "lowpass";
            air.Q.value = 0.5;
            air.connect(panner);
            panner.connect(master);
            const loops = [];
            const loop = (buf, offset) => {
                if (!buf) return null;
                const src = ctx.createBufferSource();
                src.buffer = buf;
                src.loop = true;
                const g = ctx.createGain();
                g.gain.value = 0;
                src.connect(g);
                g.connect(air);
                src.start(0, offset % buf.duration);
                const l = { src, g, rate: 0, gain: 0, tr: 0.7, tg: 0 };
                loops.push(l);
                return l;
            };
            const engine = loop(engineBuf, 0.37 * id);
            const tires = [0, 1, 2, 3].map((w) => loop(tireBuf, w / 4 * 3.5 + 0.11 * id));
            const skids = [0, 1, 2, 3].map((w) => loop(skidBuf, w / 4 * 3.5 + 0.17 * id));
            const tc = (l) => l === engine ? 0.05 : skids.includes(l) ? 0.1 : 0.15;

            let prevP = null, vs = [0, 0, 0], prevCam = null, vl = [0, 0, 0];
            let lastT = 0;
            for (let n = 0; n < frames.length; n++) {
                const f = frames[n], c = f.cars.get(id);
                const dt = n ? f.t - frames[n - 1].t : 1 / 60;
                for (const l of loops) if (l) l.tg = 0;
                if (c) {
                    if (engine) {
                        engine.tr = c.eng[0];
                        engine.tg = c.eng[1];
                    }
                    for (let w = 0; w < 4; w++) {
                        if (tires[w] && c.tire[w]) {
                            tires[w].tr = c.tire[w][0];
                            tires[w].tg = c.tire[w][1];
                        }
                        if (skids[w]) {
                            skids[w].tr = 0.5;
                            skids[w].tg = c.skid[w] ?? 0;
                        }
                    }
                }
                // Doppler: velocities from frame to frame; a camera cut is a jump, not a movement.
                let ratio = 1, dist = 10;
                const P = c ? c.p : prevP;
                if (P) {
                    if (prevP && c) for (let k = 0; k < 3; k++) vs[k] = vs[k] * 0.5 + (P[k] - prevP[k]) / dt * 0.5;
                    const cam = f.cam;
                    if (prevCam) {
                        const jump = Math.hypot(cam[0] - prevCam[0], cam[1] - prevCam[1], cam[2] - prevCam[2]);
                        for (let k = 0; k < 3; k++) vl[k] = jump > Math.max(4, 0.15 * dt * 1000) ? 0 : vl[k] * 0.5 + (cam[k] - prevCam[k]) / dt * 0.5;
                    }
                    const ux = P[0] - cam[0], uy = P[1] - cam[1], uz = P[2] - cam[2];
                    dist = Math.max(0.5, Math.hypot(ux, uy, uz));
                    const u = [ux / dist, uy / dist, uz / dist];
                    const vlu = vl[0] * u[0] + vl[1] * u[1] + vl[2] * u[2];
                    const vsu = vs[0] * u[0] + vs[1] * u[1] + vs[2] * u[2];
                    ratio = clamp((SOUND_SPEED + vlu) / (SOUND_SPEED + vsu), 0.5, 2);
                    if (n === 0) {
                        panner.positionX.setValueAtTime(P[0], 0);
                        panner.positionY.setValueAtTime(P[1], 0);
                        panner.positionZ.setValueAtTime(P[2], 0);
                    } else {
                        panner.positionX.linearRampToValueAtTime(P[0], f.t);
                        panner.positionY.linearRampToValueAtTime(P[1], f.t);
                        panner.positionZ.linearRampToValueAtTime(P[2], f.t);
                    }
                    prevCam = cam;
                }
                if (c) prevP = c.p;
                const cutoff = clamp(20000 * Math.exp(-dist / 110), 1500, 20000);
                n === 0 ? air.frequency.setValueAtTime(cutoff, 0) : air.frequency.linearRampToValueAtTime(cutoff, f.t);
                for (const l of loops) {
                    if (!l) continue;
                    const k = 1 - Math.exp(-dt / tc(l));
                    l.rate += (l.tr - l.rate) * k;
                    l.gain += (l.tg - l.gain) * k;
                    const r = Math.max(0.05, l.rate * ratio);
                    if (n === 0) {
                        l.src.playbackRate.setValueAtTime(r, 0);
                        l.g.gain.setValueAtTime(l.gain, 0);
                    } else {
                        l.src.playbackRate.linearRampToValueAtTime(r, f.t);
                        l.g.gain.linearRampToValueAtTime(l.gain, f.t);
                    }
                }
                f.ratio ??= new Map();
                f.ratio.set(id, ratio);
                lastT = f.t;
            }
            for (const l of loops) if (l) l.src.stop(lastT + 0.2);

            for (const ev of cap.events) {
                if (ev.car !== id || ev.kind === 5) continue;
                const buf = getBuffer(ev.kind === 3 ? "suspension" : "collision");
                if (!buf) continue;
                const fi = clamp(Math.round(ev.t * cap.fps), 0, frames.length - 1);
                const src = ctx.createBufferSource();
                src.buffer = buf;
                src.playbackRate.value = ev.rate * (frames[fi].ratio?.get(id) ?? 1);
                const g = ctx.createGain();
                g.gain.value = ev.gain;
                src.connect(g);
                g.connect(air);
                src.start(ev.t);
            }
        }
        // Checkpoints are a notification, not a sound in the world.
        const cpBuf = getBuffer("checkpoint");
        for (const ev of cap.events) {
            if (ev.kind !== 5 || !cpBuf) continue;
            const src = ctx.createBufferSource();
            src.buffer = cpBuf;
            src.playbackRate.value = ev.rate;
            const g = ctx.createGain();
            g.gain.value = ev.gain * 3;
            src.connect(g);
            g.connect(master);
            src.start(ev.t);
        }
        return ctx.startRendering();
    }

    // ---------- music ----------

    const STYLES = [
        { id: "phonk", label: "Drift phonk", bpm: 145 },
        { id: "funk", label: "Brazilian funk", bpm: 130 },
        { id: "trap", label: "Trap", bpm: 142 },
        { id: "hardstyle", label: "Hardstyle", bpm: 152 },
        { id: "dnb", label: "Drum and bass", bpm: 174 }
    ];
    const MINOR = [0, 2, 3, 5, 7, 8, 10];
    const PHRYGIAN = [0, 1, 3, 5, 7, 8, 10];
    const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

    function kitFor(ctx, bus, drums) {
        const noise = ctx.createBuffer(1, SR, SR);
        const nd = noise.getChannelData(0);
        const r = rng(1234);
        for (let i = 0; i < nd.length; i++) nd[i] = r() * 2 - 1;
        const curve = (drive) => {
            const c = new Float32Array(1024);
            for (let i = 0; i < 1024; i++) {
                const x = i / 511.5 - 1;
                c[i] = Math.tanh(x * drive) / Math.tanh(drive);
            }
            return c;
        };
        const env = (g, t, peak, attack, decay) => {
            g.gain.setValueAtTime(0.0001, t);
            g.gain.exponentialRampToValueAtTime(peak, t + attack);
            g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
        };
        const spread = (to, amount) => {
            const p = ctx.createStereoPanner();
            p.pan.value = (r() * 2 - 1) * amount;
            p.connect(to);
            return p;
        };
        const noiseHit = (t, type, freq, q, peak, decay, to = drums) => {
            if (type === "highpass" && freq > 5000) to = spread(to, 0.45);
            const s = ctx.createBufferSource();
            s.buffer = noise;
            const f = ctx.createBiquadFilter();
            f.type = type;
            f.frequency.value = freq;
            f.Q.value = q;
            const g = ctx.createGain();
            env(g, t, peak, 0.001, decay);
            s.connect(f);
            f.connect(g);
            g.connect(to);
            s.start(t, r() * 0.5);
            s.stop(t + decay + 0.05);
        };
        const tone = (t, type, f0, f1, glide, peak, attack, decay, to, shaper) => {
            const o = ctx.createOscillator();
            o.type = type;
            o.frequency.setValueAtTime(f0, t);
            if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + glide);
            const g = ctx.createGain();
            env(g, t, peak, attack, decay);
            o.connect(g);
            let out = g;
            if (shaper) {
                const ws = ctx.createWaveShaper();
                ws.curve = curve(shaper);
                ws.oversample = "2x";
                g.connect(ws);
                out = ws;
            }
            out.connect(to);
            o.start(t);
            o.stop(t + attack + decay + 0.05);
            return o;
        };
        return {
            kick(t, v = 1, drive = 0) {
                tone(t, "sine", 165, 42, 0.11, 0.95 * v, 0.002, drive ? 0.55 : 0.42, drums, drive || 1.6);
                noiseHit(t, "highpass", 3000, 0.7, 0.25 * v, 0.012);
            },
            snare(t, v = 1) {
                noiseHit(t, "bandpass", 1900, 0.8, 0.55 * v, 0.17);
                tone(t, "triangle", 210, 160, 0.05, 0.35 * v, 0.001, 0.09, drums);
            },
            clap(t, v = 1) {
                for (const [d, a] of [[0, 0.45], [0.011, 0.4], [0.023, 0.5]]) noiseHit(t + d, "bandpass", 1300, 1.1, a * v, d === 0.023 ? 0.2 : 0.02);
            },
            hat(t, v = 1, open = false) {
                noiseHit(t, "highpass", 7500, 0.7, 0.22 * v, open ? 0.22 : 0.035);
            },
            rim(t, v = 1) {
                tone(t, "square", 1700, 1700, 0, 0.12 * v, 0.001, 0.03, drums);
            },
            // The 808 cowbell is two square waves through a band-pass; pitched, it plays the melody.
            cowbell(t, f, len, v = 1, to = bus) {
                to = spread(to, 0.3);
                const bp = ctx.createBiquadFilter();
                bp.type = "bandpass";
                bp.frequency.value = f * 2.4;
                bp.Q.value = 0.9;
                const g = ctx.createGain();
                env(g, t, 0.32 * v, 0.002, Math.max(0.12, len * 1.6));
                bp.connect(g);
                g.connect(to);
                for (const m of [1, 1.4815]) {
                    const o = ctx.createOscillator();
                    o.type = "square";
                    o.frequency.value = f * m;
                    o.connect(bp);
                    o.start(t);
                    o.stop(t + len * 1.6 + 0.2);
                }
            },
            bass(t, f, len, v = 1, from = null, drive = 3, to = bus) {
                const o = ctx.createOscillator();
                o.type = "sine";
                o.frequency.setValueAtTime(from ?? f, t);
                if (from) o.frequency.exponentialRampToValueAtTime(f, t + Math.min(0.12, len * 0.5));
                const g = ctx.createGain();
                g.gain.setValueAtTime(0.0001, t);
                g.gain.exponentialRampToValueAtTime(0.75 * v, t + 0.006);
                g.gain.setValueAtTime(0.75 * v, t + Math.max(0.01, len - 0.06));
                g.gain.exponentialRampToValueAtTime(0.0001, t + len + 0.05);
                const ws = ctx.createWaveShaper();
                ws.curve = curve(drive);
                ws.oversample = "2x";
                const lp = ctx.createBiquadFilter();
                lp.type = "lowpass";
                lp.frequency.value = 1100;
                o.connect(g);
                g.connect(ws);
                ws.connect(lp);
                lp.connect(to);
                o.start(t);
                o.stop(t + len + 0.1);
            },
            reese(t, f, len, v = 1, to = bus) {
                const lp = ctx.createBiquadFilter();
                lp.type = "lowpass";
                lp.frequency.setValueAtTime(300, t);
                lp.frequency.linearRampToValueAtTime(900, t + len * 0.5);
                lp.frequency.linearRampToValueAtTime(300, t + len);
                const g = ctx.createGain();
                g.gain.setValueAtTime(0.0001, t);
                g.gain.exponentialRampToValueAtTime(0.28 * v, t + 0.01);
                g.gain.setValueAtTime(0.28 * v, t + len - 0.03);
                g.gain.exponentialRampToValueAtTime(0.0001, t + len);
                lp.connect(g);
                g.connect(to);
                for (const d of [-9, 9]) {
                    const o = ctx.createOscillator();
                    o.type = "sawtooth";
                    o.frequency.value = f;
                    o.detune.value = d;
                    o.connect(lp);
                    o.start(t);
                    o.stop(t + len + 0.02);
                }
            },
            lead(t, f, len, v = 1, type = "sawtooth", to = bus, cutoff = 3200) {
                to = spread(to, 0.25);
                const lp = ctx.createBiquadFilter();
                lp.type = "lowpass";
                lp.frequency.value = cutoff;
                const g = ctx.createGain();
                g.gain.setValueAtTime(0.0001, t);
                g.gain.exponentialRampToValueAtTime(0.11 * v, t + 0.008);
                g.gain.exponentialRampToValueAtTime(0.0001, t + len);
                lp.connect(g);
                g.connect(to);
                for (const d of [-14, -5, 5, 14]) {
                    const o = ctx.createOscillator();
                    o.type = type;
                    o.frequency.value = f;
                    o.detune.value = d;
                    o.connect(lp);
                    o.start(t);
                    o.stop(t + len + 0.02);
                }
            },
            bell(t, f, len, v = 1, to = bus) {
                to = spread(to, 0.35);
                for (const [m, a] of [[1, 0.5], [2.01, 0.25], [3.98, 0.12]]) tone(t, "sine", f * m, f * m, 0, 0.22 * a * v, 0.003, len, to);
            },
            riser(t, len, to = bus) {
                const s = ctx.createBufferSource();
                s.buffer = noise;
                s.loop = true;
                const f = ctx.createBiquadFilter();
                f.type = "bandpass";
                f.Q.value = 2;
                f.frequency.setValueAtTime(400, t);
                f.frequency.exponentialRampToValueAtTime(9000, t + len);
                const g = ctx.createGain();
                g.gain.setValueAtTime(0.0001, t);
                g.gain.exponentialRampToValueAtTime(0.18, t + len);
                g.gain.linearRampToValueAtTime(0, t + len + 0.02);
                s.connect(f);
                f.connect(g);
                g.connect(to);
                s.start(t);
                s.stop(t + len + 0.05);
            }
        };
    }

    // One bar of a style at time t. `bar` counts from the drop; `R` is the seeded generator;
    // `song` holds the key, chords and motifs chosen once per song.
    function playBar(k, style, t, bar, song, R) {
        const spb = 60 / style.bpm, s16 = spb / 4;
        const step = (i) => t + i * s16;
        const root = song.key;
        const chord = song.prog[bar % song.prog.length];
        const deg = (d, oct = 0) => {
            const sc = song.scale;
            const i = ((d % 7) + 7) % 7;
            return root + sc[i] + 12 * (Math.floor(d / 7) + oct);
        };
        const fill = bar % 8 === 7;
        switch (style.id) {
        case "phonk": {
            for (const i of [0, 7, 10]) k.kick(step(i), 1, 2.5);
            for (const i of [4, 12]) k.clap(step(i));
            if (fill) for (let i = 13; i < 16; i++) k.snare(step(i), 0.5 + 0.15 * (i - 12));
            for (let i = 0; i < 16; i += 2) k.hat(step(i), i % 4 === 2 ? 0.9 : 0.6);
            if (bar % 2 === 1) for (let i = 0; i < 4; i++) k.hat(step(14) + i * s16 / 2, 0.5);
            for (const [i, d, len] of song.motif) k.cowbell(step(i), mtof(deg(chord + d, 1)), len * s16);
            k.bass(step(0), mtof(deg(chord, -2)), 7 * s16, 1, null, 4);
            k.bass(step(8), mtof(deg(chord, -2)), 6 * s16, 1, mtof(deg(chord + 4, -2)), 4);
            break;
        }
        case "funk": {
            // Tamborzão-style kick and a hard clap, distorted 808 stabs and a cowbell hook.
            for (const i of [0, 3, 6, 10, 13]) k.kick(step(i), i % 3 === 0 ? 1 : 0.8, 3);
            for (const i of [4, 12]) k.clap(step(i), 1);
            for (const i of [2, 7, 9, 15]) k.rim(step(i), 0.8);
            for (let i = 0; i < 16; i++) k.hat(step(i), i % 2 ? 0.35 : 0.6);
            for (const i of [0, 3, 6, 10]) k.bass(step(i), mtof(deg(chord, -2)), 2.2 * s16, 1, null, 6);
            for (const [i, d, len] of song.motif) if (i % 2 === 0 || bar % 2) k.cowbell(step(i), mtof(deg(chord + d, 1)), len * s16, 0.9);
            break;
        }
        case "trap": {
            // Half time: snare on 3, hats in 16ths with rolls, long gliding 808s, a sparse bell line.
            for (const i of song.trapKick) k.kick(step(i), 1, 1.2);
            k.snare(step(8), 1);
            k.clap(step(8), 0.6);
            for (let i = 0; i < 16; i++) {
                if (song.rolls[bar % 4] === i) {
                    for (let j = 0; j < 4; j++) k.hat(step(i) + j * s16 / 4, 0.4 + 0.1 * j);
                    continue;
                }
                k.hat(step(i), i % 4 === 0 ? 0.7 : 0.45);
            }
            k.bass(step(0), mtof(deg(chord, -2)), 9 * s16, 1.1, null, 2.5);
            k.bass(step(10), mtof(deg(chord + 2, -2)), 5 * s16, 1.1, mtof(deg(chord, -2)), 2.5);
            for (const [i, d] of song.bells) k.bell(step(i), mtof(deg(chord + d, 1)), 0.9);
            break;
        }
        case "hardstyle": {
            // Four to the floor; the distorted kick carries the bass, an off-beat supersaw on top.
            for (let b = 0; b < 4; b++) {
                k.kick(step(4 * b), 1.1, 6);
                k.bass(step(4 * b + 1), mtof(deg(chord, -1)), 2.6 * s16, 0.55, null, 8);
                k.hat(step(4 * b + 2), 0.7, true);
            }
            k.clap(step(4));
            k.clap(step(12));
            for (const [i, d, len] of song.motif) k.lead(step(i), mtof(deg(chord + d, 0)), len * s16 * 1.2, 1.1);
            if (fill) k.riser(step(8), 8 * s16);
            break;
        }
        case "dnb": {
            // Two-step break, a rolling reese bass and quick hats.
            k.kick(step(0), 1, 1.3);
            k.kick(step(10), 0.9, 1.3);
            k.snare(step(4), 1);
            k.snare(step(12), 1);
            if (bar % 2) k.snare(step(14), 0.35);
            for (let i = 0; i < 16; i += 2) k.hat(step(i), i % 4 ? 0.4 : 0.55);
            k.reese(step(0), mtof(deg(chord, -2)), 6 * s16);
            k.reese(step(8), mtof(deg(chord + (bar % 2 ? 2 : 0), -2)), 6 * s16);
            for (const [i, d] of song.bells) k.lead(step(i), mtof(deg(chord + d, 1)), 2 * s16, 0.8, "square", undefined, 2400);
            break;
        }
        }
    }

    async function renderMusic(styleId, duration, seed) {
        const style = STYLES.find((s) => s.id === styleId) ?? STYLES[0];
        const R = rng(seed ^ hashString(style.id));
        const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(duration * SR)), SR);
        const out = ctx.createDynamicsCompressor();
        out.threshold.value = -10;
        out.ratio.value = 4;
        out.attack.value = 0.003;
        out.release.value = 0.12;
        out.connect(ctx.destination);
        // Everything but the drums ducks under the kick, which gives the pumping feel.
        const duck = ctx.createGain();
        const intro = ctx.createBiquadFilter();
        intro.type = "lowpass";
        intro.Q.value = 0.7;
        duck.connect(intro);
        const drums = ctx.createGain();
        drums.connect(intro);
        intro.connect(out);
        const room = ctx.createConvolver();
        const ir = ctx.createBuffer(2, Math.round(SR * 1.4), SR);
        const rr = rng(seed ^ 77);
        for (let c = 0; c < 2; c++) {
            const d = ir.getChannelData(c);
            for (let i = 0; i < d.length; i++) d[i] = (rr() * 2 - 1) * Math.pow(1 - i / d.length, 3);
        }
        room.buffer = ir;
        const send = ctx.createGain();
        send.gain.value = 0.22;
        duck.connect(send);
        send.connect(room);
        room.connect(intro);
        const k = kitFor(ctx, duck, drums);
        const spb = 60 / style.bpm, barLen = spb * 4;
        const motifSteps = [[0, 1], [3, 1], [6, 1], [8, 1], [10, 1], [12, 2], [14, 1]];
        const song = {
            key: 50 + Math.floor(R() * 8),
            scale: style.id === "phonk" || style.id === "funk" ? PHRYGIAN : MINOR,
            prog: [[0, 5, 6, 4], [0, 3, 5, 4], [0, 6, 5, 3], [0, 4, 5, 6]][Math.floor(R() * 4)],
            motif: motifSteps.filter(() => R() < 0.85).map(([i, len]) => [i, [0, 2, 4, 3, 1, 4, 2, -1][Math.floor(R() * 8)], len]),
            bells: [[0, 4], [6, 2], [10, 1], [14, 3]].filter(() => R() < 0.8).map(([i, d]) => [i, d + Math.floor(R() * 3) - 1]),
            trapKick: [[0, 7, 10], [0, 3, 10, 11], [0, 6, 9]][Math.floor(R() * 3)],
            rolls: [0, 1, 2, 3].map(() => [6, 11, 14, 15][Math.floor(R() * 4)])
        };
        // One bar of build-up with the low end filtered, then the drop.
        const introBars = 1;
        intro.frequency.setValueAtTime(700, 0);
        intro.frequency.exponentialRampToValueAtTime(18000, introBars * barLen);
        k.riser(0, introBars * barLen);
        for (let b = 0; b * barLen < duration + barLen; b++) {
            const t = b * barLen;
            const bar = b - introBars;
            if (bar < 0) {
                for (let i = 0; i < 4; i++) k.hat(t + i * spb, 0.5);
                continue;
            }
            playBar(k, style, t, bar, song, R);
            for (let i = 0; i < 4; i++) {
                if (style.id === "trap" && i % 2) continue;
                const at = t + i * spb;
                duck.gain.setValueAtTime(0.35, at);
                duck.gain.linearRampToValueAtTime(1, at + spb * 0.6);
            }
        }
        const fade = ctx.createGain();
        out.disconnect();
        out.connect(fade);
        fade.connect(ctx.destination);
        fade.gain.setValueAtTime(1, Math.max(0, duration - 1.6));
        fade.gain.linearRampToValueAtTime(0, duration);
        return ctx.startRendering();
    }

    async function decodeSong(file) {
        const data = await file.arrayBuffer();
        const ctx = new OfflineAudioContext(2, 1, SR);
        return ctx.decodeAudioData(data);
    }

    function rms(buf) {
        let s = 0, n = 0;
        for (let c = 0; c < buf.numberOfChannels; c++) {
            const d = buf.getChannelData(c);
            for (let i = 0; i < d.length; i += 4) {
                s += d[i] * d[i];
                n++;
            }
        }
        return Math.sqrt(s / Math.max(1, n));
    }

    // Cars and music levelled against each other, then a soft limiter so nothing clips.
    function mix(duration, cars, carLevel, music, musicLevel) {
        const n = Math.ceil(duration * SR);
        const L = new Float32Array(n), Rr = new Float32Array(n);
        const add = (buf, gain, fadeOut) => {
            if (!buf || gain <= 0) return;
            const a = buf.getChannelData(0), b = buf.numberOfChannels > 1 ? buf.getChannelData(1) : a;
            const m = Math.min(n, a.length), fadeFrom = n - Math.round(1.2 * SR);
            for (let i = 0; i < m; i++) {
                const f = fadeOut && i > fadeFrom ? (n - i) / (n - fadeFrom) : 1;
                L[i] += a[i] * gain * f;
                Rr[i] += b[i] * gain * f;
            }
        };
        if (cars) add(cars, carLevel * 0.15 / Math.max(rms(cars), 1e-4), false);
        if (music) add(music, musicLevel * 0.26 / Math.max(rms(music), 1e-4), true);
        for (const ch of [L, Rr])
            for (let i = 0; i < n; i++) {
                const x = ch[i], ax = Math.abs(x);
                if (ax > 0.72) ch[i] = Math.sign(x) * (0.72 + 0.17 * Math.tanh((ax - 0.72) / 0.17));
            }
        return [L, Rr];
    }

    // AAC (Opus where AAC can't be encoded) for the MP4.
    async function encode(channels, bitrate) {
        let cfg = null;
        for (const codec of ["mp4a.40.2", "opus"]) {
            const c = { codec, sampleRate: SR, numberOfChannels: 2, bitrate };
            try {
                if ((await AudioEncoder.isConfigSupported(c)).supported) {
                    cfg = c;
                    break;
                }
            } catch (e) {}
        }
        if (!cfg) return null;
        const chunks = [];
        let desc = null, failed = null;
        const enc = new AudioEncoder({
            output: (chunk, meta) => {
                const data = new Uint8Array(chunk.byteLength);
                chunk.copyTo(data);
                chunks.push({ data, dur: Math.round((chunk.duration ?? 0) * SR / 1e6) });
                const d = meta?.decoderConfig?.description;
                if (d && !desc) desc = new Uint8Array(ArrayBuffer.isView(d) ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d.slice(0));
            },
            error: (e) => failed = e
        });
        enc.configure(cfg);
        const [L, R] = channels, n = L.length, block = 4800;
        for (let i = 0; i < n; i += block) {
            const m = Math.min(block, n - i);
            const plane = new Float32Array(2 * m);
            plane.set(L.subarray(i, i + m), 0);
            plane.set(R.subarray(i, i + m), m);
            const ad = new AudioData({ format: "f32-planar", sampleRate: SR, numberOfFrames: m, numberOfChannels: 2, timestamp: Math.round(i * 1e6 / SR), data: plane });
            enc.encode(ad);
            ad.close();
            if (enc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 0));
        }
        await enc.flush();
        enc.close();
        if (failed || !chunks.length) return null;
        const opus = cfg.codec === "opus";
        const frame = opus ? 960 : 1024;
        for (const c of chunks) if (!c.dur) c.dur = frame;
        // Opus needs its pre-skip (from the OpusHead the encoder hands over, little-endian).
        const preSkip = opus && desc && desc.length >= 12 ? desc[10] | desc[11] << 8 : 312;
        return { codec: opus ? "opus" : "aac", desc, sampleRate: SR, channels: 2, bitrate, chunks, preSkip };
    }

    let previewCtx = null, previewSrc = null;
    async function preview(styleId, seed, song, volume) {
        stopPreview();
        const buf = song ?? await renderMusic(styleId, 12, seed);
        previewCtx ??= new AudioContext();
        await previewCtx.resume();
        const src = previewSrc = previewCtx.createBufferSource();
        src.buffer = buf;
        const g = previewCtx.createGain();
        g.gain.value = clamp(volume, 0, 1) * 0.26 / Math.max(rms(buf), 1e-4) * 0.8;
        src.connect(g);
        g.connect(previewCtx.destination);
        src.start(0, 0, Math.min(12, buf.duration));
        return new Promise((r) => src.onended = r);
    }

    function stopPreview() {
        try {
            previewSrc?.stop();
        } catch (e) {}
        previewSrc = null;
    }

    window.__nswsVideoAudio = { SR, STYLES, renderCars, renderMusic, decodeSong, mix, encode, preview, stopPreview, hashString };
})();
