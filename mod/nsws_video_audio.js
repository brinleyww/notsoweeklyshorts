(() => {
    // Sound for saved videos: the cars as a trackside microphone would hear them, and a song the
    // player imported from their own device.
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

    // ---------- the player's songs ----------

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
            // { name, start, buffer } or null.
            async load(id) {
                const row = await tx("readonly", (st) => st.get(id));
                if (!row) return null;
                let buffer = decoded.get(id);
                if (!buffer) {
                    buffer = await decodeSong(row.data);
                    decoded.clear();
                    decoded.set(id, buffer);
                }
                return { name: row.name, start: row.start ?? 0, buffer };
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
    // The song plays from `musicStart` seconds in, fading in briefly and out at the end.
    function mix(duration, cars, carLevel, music, musicLevel, musicStart = 0) {
        const n = Math.ceil(duration * SR);
        const L = new Float32Array(n), Rr = new Float32Array(n);
        const add = (buf, gain, offset, fade) => {
            if (!buf || gain <= 0) return;
            const a = buf.getChannelData(0), b = buf.numberOfChannels > 1 ? buf.getChannelData(1) : a;
            const m = Math.min(n, a.length - offset), fadeFrom = n - Math.round(1.2 * SR), fadeIn = Math.round(0.03 * SR);
            for (let i = 0; i < m; i++) {
                let f = 1;
                if (fade && i > fadeFrom) f = (n - i) / (n - fadeFrom);
                if (fade && offset > 0 && i < fadeIn) f *= i / fadeIn;
                L[i] += a[i + offset] * gain * f;
                Rr[i] += b[i + offset] * gain * f;
            }
        };
        if (cars) add(cars, carLevel * 0.15 / Math.max(rms(cars), 1e-4), 0, false);
        if (music) {
            const offset = clamp(Math.round(musicStart * SR), 0, Math.max(0, music.length - 1));
            add(music, musicLevel * 0.26 / Math.max(rms(music), 1e-4), offset, true);
        }
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

    // Plays 10 s of the song from its start point, at the level it will have in the video.
    let previewCtx = null, previewSrc = null;
    async function preview(buf, start, volume) {
        stopPreview();
        previewCtx ??= new AudioContext();
        await previewCtx.resume();
        const src = previewSrc = previewCtx.createBufferSource();
        src.buffer = buf;
        const g = previewCtx.createGain();
        g.gain.value = clamp(volume, 0, 1) * 0.26 / Math.max(rms(buf), 1e-4) * 0.8;
        src.connect(g);
        g.connect(previewCtx.destination);
        src.start(0, clamp(start, 0, buf.duration), 10);
        return new Promise((r) => src.onended = r);
    }

    function stopPreview() {
        try {
            previewSrc?.stop();
        } catch (e) {}
        previewSrc = null;
    }

    window.__nswsVideoAudio = { SR, renderCars, library, mix, encode, preview, stopPreview };
})();
