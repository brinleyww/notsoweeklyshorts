(() => {
    // Sound for saved videos: the cars as a trackside microphone would hear them, and a song that
    // comes with the game or one the player imported from their own device.
    const SR = 48000;
    const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
    const SOUND_SPEED = 343;

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

    // ---------- songs ----------

    // Songs that come with the game (audio/songs), credited in the list. Where each one starts is
    // kept on this device.
    const PRESETS = [
        { id: "preset:nocturne", name: "Not So Weekly Nocturne", by: "@LBpiano", file: "not-so-weekly-nocturne.mp3", duration: 51.6 },
        { id: "preset:cut-through", name: "Cut Through", by: "The Big GPT", file: "cut-through.mp3", duration: 93.6 },
        { id: "preset:slide", name: "Slide Through The Turn", by: "The Big GPT", file: "slide-through-the-turn.mp3", duration: 61.5 },
        { id: "preset:drift-brutal", name: "Drift Brutal", by: "The Big GPT", file: "drift-brutal.mp3", duration: 150 },
        { id: "preset:final-drop", name: "Final Drop", by: "The Big GPT", file: "final-drop.mp3", duration: 174.8 },
        { id: "preset:triumph", name: "Triumph in Motion", by: "The Big GPT", file: "triumph-in-motion.mp3", duration: 186.4 },
        { id: "preset:soaring", name: "Soaring", by: "@vanyayuyay_11133", file: "soaring.mp3", duration: 78.5 }
    ];
    const presetStarts = () => {
        try {
            return JSON.parse(localStorage.getItem("nsws_song_starts") || "{}") || {};
        } catch (e) {
            return {};
        }
    };

    // Songs a player imports stay in this browser (IndexedDB), never uploaded, listed per profile:
    // the owner key is a hash of the profile's token, so the token itself is never stored here.
    const library = (() => {
        let dbp = null;
        const decoded = new Map();
        const open = () => dbp ??= new Promise((resolve, reject) => {
            const req = indexedDB.open("nsws-songs", 1);
            req.onupgradeneeded = () => {
                const st = req.result.createObjectStore("songs", { keyPath: "id" });
                st.createIndex("owner", "owner");
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        const tx = async (mode, fn) => {
            const db = await open();
            return new Promise((resolve, reject) => {
                const t = db.transaction("songs", mode);
                const out = fn(t.objectStore("songs"));
                t.oncomplete = () => resolve(out?.result ?? out);
                t.onerror = t.onabort = () => reject(t.error);
            });
        };
        let ownerP = null, ownerFor = null;
        return {
            presets() {
                const starts = presetStarts();
                return PRESETS.map(({ id, name, by, duration }) => ({ id, name, by, duration, start: starts[id] ?? 0, preset: true }));
            },
            async owner() {
                const token = window.__nswsAccounts?.profileToken?.() ?? null;
                if (ownerP && ownerFor === token) return ownerP;
                ownerFor = token;
                return ownerP = !token || !crypto.subtle ? Promise.resolve("device") : crypto.subtle.digest("SHA-256", new TextEncoder().encode("nsws-songs:" + token)).then((b) => Array.from(new Uint8Array(b).slice(0, 12), (x) => x.toString(16).padStart(2, "0")).join(""));
            },
            // The player's songs A-Z, without their audio.
            async list() {
                const owner = await this.owner();
                const rows = await tx("readonly", (st) => st.index("owner").getAll(owner));
                return rows.map(({ id, name, duration, start, size }) => ({ id, name, duration, start, size }))
                    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) || a.id.localeCompare(b.id));
            },
            // Checks the file plays before keeping it. Re-importing the same file returns the one kept.
            async add(file) {
                const owner = await this.owner();
                const buffer = await decodeSong(file);
                const name = file.name.replace(/\.[^.]+$/, "").trim() || "Song";
                const same = (await this.list()).find((x) => x.name === name && x.size === file.size);
                if (same) return same;
                navigator.storage?.persist?.().catch(() => {});
                const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
                const row = { id, owner, name, size: file.size, type: file.type, duration: buffer.duration, start: 0, added: Date.now(), data: file };
                await tx("readwrite", (st) => st.put(row));
                decoded.set(id, buffer);
                return { id, name, duration: buffer.duration, start: 0, size: file.size };
            },
            async setStart(id, start) {
                if (PRESETS.some((p) => p.id === id)) {
                    const starts = presetStarts();
                    starts[id] = start;
                    localStorage.setItem("nsws_song_starts", JSON.stringify(starts));
                    return;
                }
                await tx("readwrite", (st) => {
                    const req = st.get(id);
                    req.onsuccess = () => {
                        if (req.result) st.put({ ...req.result, start });
                    };
                });
            },
            async remove(id) {
                decoded.delete(id);
                await tx("readwrite", (st) => st.delete(id));
            },
            // { name, by, start, buffer } or null.
            async load(id) {
                const preset = PRESETS.find((p) => p.id === id);
                const row = preset ? null : await tx("readonly", (st) => st.get(id));
                if (!preset && !row) return null;
                let buffer = decoded.get(id);
                if (!buffer) {
                    let data = row?.data;
                    if (preset) {
                        const res = await fetch("audio/songs/" + preset.file);
                        if (!res.ok) throw new Error("HTTP " + res.status);
                        data = await res.blob();
                    }
                    buffer = await decodeSong(data);
                    decoded.clear();
                    decoded.set(id, buffer);
                }
                return preset ? { name: preset.name, by: preset.by, start: presetStarts()[id] ?? 0, buffer } : { name: row.name, by: null, start: row.start ?? 0, buffer };
            }
        };
    })();

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
    // The song plays from `musicStart` seconds in. With an `ending` ({at, period}, video seconds)
    // it stops on that beat and rings out (see echoOut); without one it fades over the last 1.2 s.
    // `extra` (two channels, already levelled) goes in as it is, e.g. an edit's sound effects.
    function mix(duration, cars, carLevel, music, musicLevel, musicStart = 0, extra = null, ending = null) {
        const n = Math.ceil(duration * SR);
        const L = new Float32Array(n), Rr = new Float32Array(n);
        if (cars && carLevel > 0) {
            const a = cars.getChannelData(0), b = cars.numberOfChannels > 1 ? cars.getChannelData(1) : a;
            const gain = carLevel * 0.15 / Math.max(rms(cars), 1e-4), m = Math.min(n, a.length), out = Math.round(0.6 * SR);
            for (let i = 0; i < m; i++) {
                const f = i > n - out ? (n - i) / out : 1;
                L[i] += a[i] * gain * f;
                Rr[i] += b[i] * gain * f;
            }
        }
        if (music && musicLevel > 0) {
            const a = music.getChannelData(0), b = music.numberOfChannels > 1 ? music.getChannelData(1) : a;
            const gain = musicLevel * 0.26 / Math.max(rms(music), 1e-4);
            const offset = clamp(Math.round(musicStart * SR), 0, Math.max(0, music.length - 1));
            const cut = ending ? clamp(Math.round(ending.at * SR), 0, n) : n;
            const stop = Math.round(0.012 * SR), fadeFrom = n - Math.round(1.2 * SR), fadeIn = Math.round(0.03 * SR);
            const m = Math.min(n, a.length - offset, cut + stop);
            for (let i = 0; i < m; i++) {
                let f = 1;
                if (!ending && i > fadeFrom) f = (n - i) / (n - fadeFrom);
                if (i >= cut) f *= 1 - (i - cut) / stop;
                if (offset > 0 && i < fadeIn) f *= i / fadeIn;
                L[i] += a[i + offset] * gain * f;
                Rr[i] += b[i + offset] * gain * f;
            }
            if (ending && cut < n - SR * 0.3) echoOut(a, b, offset, gain, cut, ending.period || 0.5, L, Rr);
        }
        if (extra)
            for (let c = 0; c < 2; c++) {
                const src = extra[c], dst = c ? Rr : L, m = Math.min(n, src.length);
                for (let i = 0; i < m; i++) dst[i] += src[i];
            }
        for (const ch of [L, Rr])
            for (let i = 0; i < n; i++) {
                const x = ch[i], ax = Math.abs(x);
                if (ax > 0.72) ch[i] = Math.sign(x) * (0.72 + 0.17 * Math.tanh((ax - 0.72) / 0.17));
            }
        return [L, Rr];
    }

    // The song's last beat thrown into a ping-pong echo at half a beat (thinner and darker each
    // repeat, so no kick booms on) and a short reverb, heard from the cut on and dying away to
    // silence exactly at the end of the video.
    function echoOut(a, b, offset, gain, cut, period, L, Rr) {
        const n = L.length;
        const feed = Math.round(clamp(period, 0.25, 0.7) * SR);
        const D = Math.round(clamp(period / 2, 0.12, 0.4) * SR);
        const from = Math.max(0, cut - feed), len = n - from;
        const bufL = new Float32Array(len), bufR = new Float32Array(len);
        const kLp = 1 - Math.exp(-2 * Math.PI * 3200 / SR), kHp = 1 - Math.exp(-2 * Math.PI * 220 / SR);
        const fb = 0.5;
        let lpA = 0, lpB = 0, low = 0;
        const COMBS = [1557, 1617, 1491, 1422], ALL = [556, 225];
        const verb = [0, 1].map((side) => ({
            combs: COMBS.map((d) => ({ buf: new Float32Array(d + 23 * side), at: 0, lp: 0 })),
            alls: ALL.map((d) => ({ buf: new Float32Array(d + 11 * side), at: 0 }))
        }));
        const reverb = (v, x) => {
            let y = 0;
            for (const c of v.combs) {
                const out = c.buf[c.at];
                c.lp += 0.35 * (out - c.lp);
                c.buf[c.at] = x + c.lp * 0.82;
                c.at = (c.at + 1) % c.buf.length;
                y += out;
            }
            y *= 0.25;
            for (const p of v.alls) {
                const z = p.buf[p.at];
                p.buf[p.at] = y + z * 0.5;
                p.at = (p.at + 1) % p.buf.length;
                y = z - y * 0.5;
            }
            return y;
        };
        const tail = n - cut, fadeIn = Math.round(0.006 * SR), last = Math.round(0.35 * SR);
        for (let j = 0; j < len; j++) {
            const i = from + j;
            let x = 0;
            if (i < cut && i + offset < a.length) {
                const w = j / Math.max(1, cut - from);
                x = (a[i + offset] + b[i + offset]) * 0.5 * gain * w * w;
            }
            low += kHp * (x - low);
            x -= low;
            lpA += kLp * ((j >= D ? bufR[j - D] : 0) - lpA);
            lpB += kLp * ((j >= D ? bufL[j - D] : 0) - lpB);
            bufL[j] = x + fb * lpA;
            bufR[j] = fb * lpB;
            const wl = reverb(verb[0], x * 0.6 + lpA * 0.5), wr = reverb(verb[1], x * 0.6 + lpB * 0.5);
            if (i < cut) continue;
            const k = i - cut;
            const env = Math.min(1, k / fadeIn) * Math.exp(-k / (tail * 0.5)) * (k > tail - last ? (tail - k) / last : 1);
            L[i] += (lpA * 0.85 + wl * 0.5) * env;
            Rr[i] += (lpB * 0.85 + wr * 0.5) * env;
        }
    }

    // ---------- chimes ----------

    // A bell made of a few decaying partials. The finish chime: a soft two-note ding for another
    // run (a step higher on the scale for each finish that follows close behind), and for the
    // followed run a bright rising arpeggio that rings into a chord, with a soft low thump.
    const chimes = new Map();
    function chime(big, step) {
        const key = (big ? "b" : "s") + step;
        let c = chimes.get(key);
        if (c) return c;
        const len = Math.round((big ? 1.9 : 0.9) * SR);
        const L = new Float32Array(len), R = new Float32Array(len);
        const bell = (at, midi, amp, decay, pan) => {
            const f0 = 440 * Math.pow(2, (midi - 69) / 12);
            const parts = [[1, 1, 1], [2.01, 0.35, 0.55], [3.0, 0.16, 0.32], [4.18, 0.07, 0.18], [5.43, 0.035, 0.1]];
            const i0 = Math.round(at * SR);
            for (let i = i0; i < len; i++) {
                const t = (i - i0) / SR;
                const atk = Math.min(1, t / 0.0025);
                let v = 0;
                for (const [r, g, d] of parts) v += Math.sin(2 * Math.PI * f0 * r * t) * g * Math.exp(-t / (decay * d));
                v *= amp * atk;
                L[i] += v * (1 - 0.5 * pan);
                R[i] += v * (1 + 0.5 * pan);
            }
        };
        if (big) {
            [76, 80, 83, 88].forEach((m, k) => bell(k * 0.06, m, 0.1, 1.1, (k - 1.5) * 0.35));
            for (const m of [76, 80, 83]) bell(0.24, m, 0.055, 1.6, 0);
            let ph = 0;
            for (let i = 0; i < len; i++) {
                const t = i / SR;
                ph += 2 * Math.PI * (55 + 50 * Math.exp(-t / 0.05)) / SR;
                const v = Math.sin(ph) * 0.13 * Math.exp(-t / 0.16) * Math.min(1, t / 0.004);
                L[i] += v;
                R[i] += v;
            }
            let seed = 7, lp = 0, hp = 0;
            for (let i = Math.round(0.18 * SR); i < len; i++) {
                const t = i / SR - 0.18;
                seed = seed * 16807 % 2147483647;
                const x = seed / 2147483647 - 0.5;
                lp += 0.6 * (x - lp);
                hp += 0.08 * (lp - hp);
                const v = (lp - hp) * 0.05 * Math.exp(-t / 0.35) * Math.min(1, t / 0.05);
                L[i] += v * (1 + Math.sin(t * 9));
                R[i] += v * (1 - Math.sin(t * 9));
            }
        } else {
            const scale = [0, 2, 4, 7, 9, 12, 14, 16];
            const m = 79 + scale[clamp(step, 0, 7)], pan = step % 2 ? 0.3 : -0.3;
            bell(0, m, 0.07, 0.55, pan);
            bell(0.07, m + 5, 0.06, 0.7, -pan);
        }
        chimes.set(key, c = [L, R]);
        return c;
    }

    function addChime(out, t, big, step) {
        const [cl, cr] = chime(big, step), [L, R] = out, i0 = Math.round(t * SR);
        for (let i = 0; i < cl.length; i++) {
            const k = i0 + i;
            if (k < 0) continue;
            if (k >= L.length) break;
            L[k] += cl[i];
            R[k] += cr[i];
        }
    }

    // Plays a chime live through the game's sound-effects volume.
    function playChime(ctx, dest, big, step) {
        if (!ctx || !dest || ctx.state !== "running") return;
        try {
            const [cl, cr] = chime(big, step);
            const buf = ctx.createBuffer(2, cl.length, SR);
            buf.copyToChannel(cl, 0);
            buf.copyToChannel(cr, 1);
            const src = ctx.createBufferSource();
            src.buffer = buf;
            src.connect(dest);
            src.start();
        } catch (e) {}
    }

    async function encodeRaw(cfg, L, R) {
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
        const n = L.length, block = 4800;
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
        return failed || !chunks.length ? null : { chunks, desc };
    }

    // How many samples late AAC plays back (the encoder's priming; the MP4 has no edit list to
    // skip it), measured once by encoding a short tone burst and decoding it again. The sound is
    // moved that much earlier so it lines up with the picture.
    const delays = new Map();
    async function encoderDelay(cfg) {
        if (delays.has(cfg.codec)) return delays.get(cfg.codec);
        let d = 0;
        try {
            const n = SR / 2, at = 12000, w = 480;
            const L = new Float32Array(n);
            for (let i = 0; i < w; i++) L[at + i] = Math.sin(2 * Math.PI * 1500 * i / SR) * Math.sin(Math.PI * i / w) * 0.8;
            const out = await encodeRaw({ ...cfg, bitrate: 128000 }, L, L);
            if (out && window.AudioDecoder) {
                const pcm = [];
                const dec = new AudioDecoder({
                    output: (ad) => {
                        const m = ad.numberOfFrames, buf = new Float32Array(m);
                        ad.copyTo(buf, { planeIndex: 0, format: "f32-planar" });
                        pcm.push(buf);
                        ad.close();
                    },
                    error: () => {}
                });
                dec.configure({ codec: cfg.codec, sampleRate: SR, numberOfChannels: 2, description: out.desc ?? undefined });
                let ts = 0;
                for (const c of out.chunks) {
                    dec.decode(new EncodedAudioChunk({ type: "key", timestamp: Math.round(ts * 1e6 / SR), data: c.data }));
                    ts += c.dur || 1024;
                }
                await dec.flush();
                dec.close();
                const all = new Float32Array(pcm.reduce((k, p) => k + p.length, 0));
                let o = 0;
                for (const p of pcm) {
                    all.set(p, o);
                    o += p.length;
                }
                let best = -1, bestAt = 0;
                for (let s = 0; s + w < all.length && s < at + 5000; s++) {
                    let c = 0;
                    for (let i = 0; i < w; i += 2) c += all[s + i] * L[at + i];
                    if (c > best) {
                        best = c;
                        bestAt = s;
                    }
                }
                if (bestAt >= at && bestAt - at <= 4096) d = bestAt - at;
            }
        } catch (e) {
            console.warn(e);
        }
        delays.set(cfg.codec, d);
        return d;
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
        const opus = cfg.codec === "opus";
        const skip = opus ? 0 : await encoderDelay(cfg);
        const [L, R] = channels;
        const out = await encodeRaw(cfg, L.subarray(Math.min(skip, L.length - 1)), R.subarray(Math.min(skip, R.length - 1)));
        if (!out) return null;
        const { chunks, desc } = out;
        const frame = opus ? 960 : 1024;
        for (const c of chunks) if (!c.dur) c.dur = frame;
        // Opus needs its pre-skip (from the OpusHead the encoder hands over, little-endian).
        const preSkip = opus && desc && desc.length >= 12 ? desc[10] | desc[11] << 8 : 312;
        return { codec: opus ? "opus" : "aac", desc, sampleRate: SR, channels: 2, bitrate, chunks, preSkip, skipped: skip };
    }

    // Plays the song from `start` until stopped, at the level it will have in the video. The
    // returned handle tells where playback is and follows the volume slider.
    let previewCtx = null, preview = null;
    const levels = new WeakMap();
    async function play(buf, start, volume) {
        stopPreview();
        previewCtx ??= new AudioContext();
        await previewCtx.resume();
        const src = previewCtx.createBufferSource();
        src.buffer = buf;
        const g = previewCtx.createGain();
        let norm = levels.get(buf);
        if (null == norm) levels.set(buf, norm = 0.26 / Math.max(rms(buf), 1e-4) * 0.8);
        g.gain.value = clamp(volume, 0, 1) * norm;
        src.connect(g);
        g.connect(previewCtx.destination);
        const from = clamp(start, 0, buf.duration), at = previewCtx.currentTime;
        src.start(0, from);
        const handle = preview = {
            pos: () => Math.min(buf.duration, from + previewCtx.currentTime - at),
            setVolume: (v) => g.gain.value = clamp(v, 0, 1) * norm,
            stop: () => {
                try {
                    src.stop();
                } catch (e) {}
            },
            done: new Promise((r) => src.onended = r)
        };
        handle.done.then(() => {
            if (preview === handle) preview = null;
        });
        return handle;
    }

    function stopPreview() {
        preview?.stop();
        preview = null;
    }

    // A finished mix (from `mix`), played as it is, for the video preview.
    async function playMix(channels) {
        stopPreview();
        previewCtx ??= new AudioContext();
        await previewCtx.resume();
        const buf = previewCtx.createBuffer(2, Math.max(1, channels[0].length), SR);
        buf.copyToChannel(channels[0], 0);
        buf.copyToChannel(channels[1], 1);
        const src = previewCtx.createBufferSource();
        src.buffer = buf;
        src.connect(previewCtx.destination);
        const at = previewCtx.currentTime + 0.05;
        src.start(at);
        const handle = preview = {
            pos: () => {
                const ts = previewCtx.getOutputTimestamp?.();
                const heard = ts?.performanceTime > 0 ? ts.contextTime + (performance.now() - ts.performanceTime) / 1000 : previewCtx.currentTime - (previewCtx.outputLatency || previewCtx.baseLatency || 0);
                return Math.max(0, heard - at + 1 / 60);
            },
            stop: () => {
                try {
                    src.stop();
                } catch (e) {}
            }
        };
        return handle;
    }

    // The loudest sample in each of n slices of the song, for drawing its waveform.
    const peakCache = new WeakMap();
    function peaks(buf, n) {
        let p = peakCache.get(buf);
        if (p?.length === n) return p;
        p = new Float32Array(n);
        const a = buf.getChannelData(0), b = buf.numberOfChannels > 1 ? buf.getChannelData(1) : a;
        const per = a.length / n, stride = Math.max(1, Math.floor(per / 400));
        for (let i = 0; i < n; i++) {
            let m = 0;
            for (let j = Math.floor(i * per), e = Math.min(a.length, Math.floor((i + 1) * per)); j < e; j += stride) m = Math.max(m, Math.abs(a[j]), Math.abs(b[j]));
            p[i] = m;
        }
        peakCache.set(buf, p);
        return p;
    }

    window.__nswsVideoAudio = { SR, renderCars, library, mix, encode, play, playMix, stopPreview, peaks, addChime, playChime };
})();
