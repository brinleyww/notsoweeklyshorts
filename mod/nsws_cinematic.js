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
.nsws-save-menu { position: fixed; z-index: 10000; display: flex; align-items: stretch; padding: 6px; background: var(--surface-color); color: #fff; pointer-events: auto; }
.nsws-save-menu > .col { display: flex; flex-direction: column; width: 300px; }
.nsws-save-menu > .col + .col { width: 230px; margin-left: 8px; }
.nsws-save-menu > .col > .fname { display: flex; align-items: center; margin: 2px 0 8px 0; padding: 0 16px 0 14px; height: 40px; background-color: var(--button-color); clip-path: polygon(8px 0, 100% 0, calc(100% - 8px) 100%, 0 100%); cursor: text; }
.nsws-save-menu > .col > .fname > input { flex: 1; min-width: 0; padding: 0; border: none; outline: none; background: none; color: #fff; font: inherit; font-size: 17px; }
.nsws-save-menu > .col > .fname > span { margin-left: 2px; font-size: 15px; opacity: 0.55; }
.nsws-save-menu > .col > .button.go { display: flex; align-items: center; justify-content: center; margin: auto 0 0 0; padding: 16px 18px; font-size: 28px; text-align: center; }
.nsws-save-menu > .col > .button.go > img { width: 30px; height: 30px; margin-right: 12px; }
.nsws-save-menu::-webkit-scrollbar { width: 6px; }
.nsws-save-menu::-webkit-scrollbar-thumb { background-color: rgba(255, 255, 255, 0.4); }
.nsws-save-menu > .col > p { margin: 4px 10px 8px 10px; font-size: 16px; opacity: 0.7; }
.nsws-save-menu > .col > .button { margin: 2px 0; padding: 9px 18px; font-size: 19px; text-align: left; white-space: nowrap; }
.nsws-save-menu > .col > .button.selected { background-color: var(--button-hover-color); }
.nsws-save-menu > .col > .opt { display: flex; align-items: center; margin: 2px 0; }
.nsws-save-menu > .col > .opt > .button { margin: 0; padding: 8px 14px; font-size: 18px; }
.nsws-save-menu > .col > .opt > .button.off { opacity: 0.55; }
.nsws-save-menu > .col > .opt > .button.wide { flex: 1; text-align: left; }
.nsws-save-menu > .col > .vol { display: flex; align-items: center; margin: 2px 0; padding: 0 18px 0 16px; height: 36px; background-color: var(--button-color); clip-path: polygon(8px 0, 100% 0, calc(100% - 8px) 100%, 0 100%); }
.nsws-save-menu > .col > .vol > span { margin-right: 10px; font-size: 16px; opacity: 0.8; white-space: nowrap; }
.nsws-save-menu > .col > .vol > input { flex: 1; min-width: 0; }
.nsws-save-menu > .col > .vol > input::-webkit-slider-runnable-track { height: 6px; background-color: rgba(255, 255, 255, 0.25); }
.nsws-save-menu > .col > .vol > input::-webkit-slider-thumb { width: 14px; height: 22px; margin: -8px 0 0 0; border: 3px solid var(--button-color); }
.nsws-save-menu > .col > .vol > b { min-width: 4ch; text-align: right; margin-left: 10px; font-weight: normal; font-size: 15px; font-variant-numeric: tabular-nums; }
.nsws-save-menu > .col > .vol > .button { margin: 0 -10px 0 8px; padding: 4px 10px; font-size: 15px; }
.nsws-save-menu > .col > p.note { margin-top: 6px; font-size: 14px; line-height: 1.3; opacity: 0.6; }
.nsws-save-menu > .col > .songs { position: relative; flex-shrink: 0; margin: 2px 0; overflow: hidden; background-color: rgba(0, 0, 0, 0.2); clip-path: polygon(8px 0, 100% 0, calc(100% - 8px) 100%, 0 100%); touch-action: none; }
.nsws-save-menu > .col > .songs > div { will-change: transform; }
.nsws-save-menu .col .song { display: flex; align-items: center; height: 34px; padding: 0 26px 0 16px; font-size: 17px; cursor: pointer; }
.nsws-save-menu .col .song:hover { background-color: rgba(255, 255, 255, 0.08); }
.nsws-save-menu .col .song.selected { background-color: var(--button-color); }
.nsws-save-menu .col .song > .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nsws-save-menu .col .song > .len { margin-left: 8px; font-size: 14px; opacity: 0.6; font-variant-numeric: tabular-nums; }
.nsws-save-menu .col .song > .del { margin: 0 -8px 0 6px; padding: 4px 8px; border: none; background: none; color: #fff; font: inherit; font-size: 15px; opacity: 0.55; cursor: pointer; }
.nsws-save-menu .col .song > .del:hover, .nsws-save-menu .col .song > .del.sure { opacity: 1; }
.nsws-save-menu .col .song > .del.sure { color: #ff8a80; }
.nsws-save-menu > .col > .wave { position: relative; flex-shrink: 0; height: 52px; margin: 2px 0; background-color: var(--button-color); clip-path: polygon(8px 0, 100% 0, calc(100% - 8px) 100%, 0 100%); cursor: pointer; touch-action: none; }
.nsws-save-menu > .col > .wave > canvas { position: absolute; left: 14px; top: 4px; width: calc(100% - 28px); height: 44px; }
.nsws-save-menu > .col > .ctrl > .button { margin: 0 4px 0 0; padding: 7px 11px; font-size: 16px; white-space: nowrap; }
.nsws-save-menu > .col > .ctrl > .button.dim { opacity: 0.45; }
.nsws-save-menu > .col > .ctrl > b { flex: 1; margin-right: 4px; font-weight: normal; font-size: 15px; text-align: center; white-space: nowrap; font-variant-numeric: tabular-nums; }
.nsws-save-menu > .col > .songs > i { position: absolute; right: 12px; width: 5px; background-color: rgba(255, 255, 255, 0.5); cursor: grab; }
.nsws-export { position: fixed; inset: 0; z-index: 10000; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.5); color: #fff; pointer-events: auto; }
.nsws-export.done { align-items: flex-start; padding-top: 12vh; background: none; pointer-events: none; }
.nsws-export > div { pointer-events: auto; display: flex; flex-direction: column; min-width: 340px; max-width: 80vw; padding: 18px 24px; background: var(--surface-color); clip-path: polygon(10px 0, 100% 0, calc(100% - 10px) 100%, 0 100%); }
.nsws-export p { margin: 0 0 10px 0; font-size: 22px; }
.nsws-export p.note { font-size: 16px; opacity: 0.75; }
.nsws-export .track { height: 8px; margin-bottom: 16px; background: rgba(255, 255, 255, 0.2); }
.nsws-export .track > i { display: block; width: 0; height: 100%; background: #fff; }
.nsws-export .button { align-self: center; padding: 8px 30px; font-size: 20px; }
.nsws-loading { position: fixed; left: 50%; top: 50%; z-index: 20; width: 44px; height: 44px; margin: -28px 0 0 -28px; border: 6px solid rgba(255, 255, 255, 0.25); border-top-color: #fff; border-radius: 50%; opacity: 0; pointer-events: none; transition: opacity 0.2s; animation: nsws-spin 0.9s linear infinite; }
.nsws-loading.shown { opacity: 1; }
@keyframes nsws-spin { to { transform: rotate(360deg); } }
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

    const yieldTask = () => new Promise((r) => {
        const ch = new MessageChannel();
        ch.port1.onmessage = () => r();
        ch.port2.postMessage(0);
    });

    // Bitrate of the default "High quality" save, at 1080p60; the smaller sizes are shares of it.
    const BASE_RATE = 9e6;
    // Below this many bits per pixel H.264 turns to mush, so a smaller file gets fewer pixels
    // (then 30 fps) instead.
    const MIN_BPP = 0.045;
    const SAVE_SIZES = [
        { id: "auto", label: "High quality", rate: 1 },
        { id: "75", label: "75% size", rate: 0.75 },
        { id: "50", label: "50% size", rate: 0.5 },
        { id: "25", label: "25% size", rate: 0.25 },
        { id: "10mb", label: "Under 10 MB (Discord)", cap: 9.6e6 }
    ];
    const LADDER = [[1920, 1080, 60], [1600, 900, 60], [1280, 720, 60], [1280, 720, 30], [960, 540, 30], [854, 480, 30], [640, 360, 30], [426, 240, 30]];

    // The sharpest size and frame rate the bitrate can carry that this device can encode.
    async function encoderConfig(rate, strict) {
        const fit = LADDER.findIndex(([w, h, f]) => rate / (w * h * f) >= MIN_BPP);
        for (let i = fit < 0 ? LADDER.length - 1 : fit; i < LADDER.length; i++) {
            const [width, height, framerate] = LADDER[i];
            for (const codec of ["avc1.64002a", "avc1.4d002a", "avc1.42002a", "vp09.00.41.08"])
                for (const mode of [strict ? "constant" : "variable", null]) {
                    const cfg = { codec, width, height, framerate, bitrate: Math.round(rate), latencyMode: "quality" };
                    if (mode) cfg.bitrateMode = mode;
                    if (codec.startsWith("avc")) cfg.avc = { format: "avc" };
                    try {
                        if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg;
                    } catch (e) {}
                }
        }
        return null;
    }

    // A plain MP4 around the encoded frames: one video track, index first so it plays while loading.
    function muxMp4({ vp9, desc, width, height, fps, chunks, audio }) {
        const cat = (parts) => {
            let n = 0;
            for (const p of parts) n += p.length;
            const out = new Uint8Array(n);
            let at = 0;
            for (const p of parts) {
                out.set(p, at);
                at += p.length;
            }
            return out;
        };
        const u32 = (...v) => {
            const b = new Uint8Array(4 * v.length), d = new DataView(b.buffer);
            v.forEach((x, i) => d.setUint32(4 * i, x >>> 0));
            return b;
        };
        const u16 = (...v) => {
            const b = new Uint8Array(2 * v.length), d = new DataView(b.buffer);
            v.forEach((x, i) => d.setUint16(2 * i, x & 0xffff));
            return b;
        };
        const str = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
        const box = (type, ...parts) => {
            const body = cat(parts);
            return cat([u32(body.length + 8), str(type), body]);
        };
        const full = (type, version, flags, ...parts) => box(type, new Uint8Array([version, flags >> 16 & 255, flags >> 8 & 255, flags & 255]), ...parts);
        const matrix = u32(0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000);
        const n = chunks.length, ms = Math.round(n * 1000 / fps);
        const sizes = new Uint8Array(4 * n), sd = new DataView(sizes.buffer);
        chunks.forEach((c, i) => sd.setUint32(4 * i, c.data.length));
        const keys = [];
        chunks.forEach((c, i) => c.key && keys.push(i + 1));
        const config = vp9 ? full("vpcC", 1, 0, new Uint8Array([0, 41, 8 << 4 | 1 << 1, 1, 1, 1]), u16(0)) : box("avcC", desc);
        const sample = box(vp9 ? "vp09" : "avc1", new Uint8Array(6), u16(1, 0, 0), u32(0, 0, 0), u16(width, height), u32(0x480000, 0x480000, 0), u16(1), new Uint8Array(32), u16(0x18, 0xffff), config);
        const ftyp = box("ftyp", str("isom"), u32(0x200), str("isom"), str("iso2"), str(vp9 ? "vp09" : "avc1"), str("mp41"));
        // Sound: AAC (with its esds descriptor) or Opus (dOps), samples after the video's.
        const an = audio?.chunks.length ?? 0;
        const aTotal = audio ? audio.chunks.reduce((t, c) => t + c.dur, 0) : 0;
        const ams = audio ? Math.round(aTotal * 1000 / audio.sampleRate) : 0;
        const descr = (tag, body) => cat([new Uint8Array([tag, 0x80, 0x80, 0x80, body.length]), body]);
        const aTrak = (base) => {
            const a = audio;
            const sz = new Uint8Array(4 * an), szd = new DataView(sz.buffer), offs = new Uint8Array(4 * an), od = new DataView(offs.buffer);
            let at = base;
            a.chunks.forEach((c, i) => {
                szd.setUint32(4 * i, c.data.length);
                od.setUint32(4 * i, at);
                at += c.data.length;
            });
            const runs = [];
            for (const c of a.chunks) {
                if (runs.length && runs[runs.length - 1] === c.dur) runs[runs.length - 2]++;
                else runs.push(1, c.dur);
            }
            const head = [new Uint8Array(6), u16(1), u32(0, 0), u16(a.channels, 16, 0, 0), u32(a.sampleRate * 65536)];
            const entry = a.codec === "aac"
                ? box("mp4a", ...head, full("esds", 0, 0, descr(3, cat([u16(2), new Uint8Array([0]), descr(4, cat([new Uint8Array([0x40, 0x15, 0, 0, 0]), u32(a.bitrate, a.bitrate), descr(5, a.desc ?? new Uint8Array([0x11, 0x90]))])), descr(6, new Uint8Array([2]))]))))
                : box("Opus", ...head, box("dOps", new Uint8Array([0, a.channels]), u16(a.preSkip), u32(a.sampleRate), u16(0), new Uint8Array([0])));
            return box("trak",
                full("tkhd", 0, 3, u32(0, 0, 2, 0, ams, 0, 0), u16(0, 1, 0x100, 0), matrix, u32(0, 0)),
                box("mdia",
                    full("mdhd", 0, 0, u32(0, 0, a.sampleRate, aTotal), u16(0x55c4, 0)),
                    full("hdlr", 0, 0, u32(0), str("soun"), u32(0, 0, 0), str("SoundHandler\0")),
                    box("minf",
                        full("smhd", 0, 0, u16(0, 0)),
                        box("dinf", full("dref", 0, 0, u32(1), full("url ", 0, 1))),
                        box("stbl",
                            full("stsd", 0, 0, u32(1), entry),
                            full("stts", 0, 0, u32(runs.length / 2), u32(...runs)),
                            full("stsc", 0, 0, u32(1, 1, 1, 1)),
                            full("stsz", 0, 0, u32(0, an), sz),
                            full("stco", 0, 0, u32(an), offs)))));
        };
        const moov = (base) => {
            const offs = new Uint8Array(4 * n), od = new DataView(offs.buffer);
            let at = base;
            chunks.forEach((c, i) => {
                od.setUint32(4 * i, at);
                at += c.data.length;
            });
            return box("moov",
                full("mvhd", 0, 0, u32(0, 0, 1000, Math.max(ms, ams), 0x10000), u16(0x100, 0), u32(0, 0), matrix, u32(0, 0, 0, 0, 0, 0, an ? 3 : 2)),
                box("trak",
                    full("tkhd", 0, 3, u32(0, 0, 1, 0, ms, 0, 0), u16(0, 0, 0, 0), matrix, u32(width * 65536, height * 65536)),
                    box("mdia",
                        full("mdhd", 0, 0, u32(0, 0, fps * 1000, n * 1000), u16(0x55c4, 0)),
                        full("hdlr", 0, 0, u32(0), str("vide"), u32(0, 0, 0), str("VideoHandler\0")),
                        box("minf",
                            full("vmhd", 0, 1, u16(0, 0, 0, 0)),
                            box("dinf", full("dref", 0, 0, u32(1), full("url ", 0, 1))),
                            box("stbl",
                                full("stsd", 0, 0, u32(1), sample),
                                full("stts", 0, 0, u32(1, n, 1000)),
                                full("stss", 0, 0, u32(keys.length), u32(...keys)),
                                full("stsc", 0, 0, u32(1, 1, 1, 1)),
                                full("stsz", 0, 0, u32(0, n), sizes),
                                full("stco", 0, 0, u32(n), offs))))),
                ...(an ? [aTrak(at)] : []));
        };
        const head = moov(0).length;
        let bytes = 8;
        for (const c of chunks) bytes += c.data.length;
        for (let i = 0; i < an; i++) bytes += audio.chunks[i].data.length;
        return new Blob([ftyp, moov(ftyp.length + head + 8), u32(bytes), str("mdat"), ...chunks.map((c) => c.data), ...(an ? audio.chunks.map((c) => c.data) : [])], { type: "video/mp4" });
    }

    // Draws parts side by side (a slanted strip like the game's buttons): each part has text,
    // size, and optionally bg, chip colour, alpha, left/right padding l/r, min text width, right.
    function rowWidth(g, parts, u, pal) {
        let w = 0;
        for (const p of parts) {
            g.font = pal.style + " " + (p.size * u).toFixed(1) + "px " + pal.font;
            p.tw = g.measureText(p.text).width;
            p.w = (p.l + p.r + (p.chip ? 13 : 0)) * u + Math.max(p.tw, (p.min ?? 0) * u);
            w += p.w;
        }
        return w;
    }

    function drawRow(g, parts, x, y, h, skew, u, pal, bg) {
        const w = parts.reduce((a, p) => a + p.w, 0);
        g.save();
        g.beginPath();
        g.moveTo(x + skew, y);
        g.lineTo(x + w, y);
        g.lineTo(x + w - skew, y + h);
        g.lineTo(x, y + h);
        g.closePath();
        g.clip();
        g.fillStyle = bg;
        g.fillRect(x, y, w, h);
        const base = g.globalAlpha;
        for (const p of parts) {
            if (p.bg) {
                g.fillStyle = p.bg;
                g.fillRect(x, y, p.w, h);
            }
            let tx = x + p.l * u;
            if (p.chip) {
                g.fillStyle = p.chip;
                g.fillRect(tx, y + (h - 20 * u) / 2, 5 * u, 20 * u);
                tx += 13 * u;
            }
            if (p.right) tx = x + p.w - p.r * u - p.tw;
            g.font = pal.style + " " + (p.size * u).toFixed(1) + "px " + pal.font;
            g.globalAlpha = base * (p.alpha ?? 1);
            g.fillStyle = "#fff";
            g.fillText(p.text, tx, y + h / 2 + u);
            g.globalAlpha = base;
            x += p.w;
        }
        g.restore();
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
    // Camera shake, in radians: trackside cameras rumble as the car passes close by, and cameras
    // riding with the car only jolt when it lands a jump.
    const PASS_SHAKE = { curb: 0.02, tele: 0.005, finish: 0.006 };
    const LAND_SHAKE = { chase: 0.012, front: 0.01, side: 0.008, orbit: 0.004, heli: 0.004, pack: 0.005 };
    const HOLD = { type: "chase", t0: 0, t1: Infinity, d: 5.8, h: 1.5, s: 0, high: false };
    // Loop shots start this long before the car starts up the loop.
    const LOOP_LEAD = 0.35;
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
            this.core = null;
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

        // The car's up, smoothed, halfway to world up so wall rides tilt the shot without flipping
        // it, and all the way to the car's up as it goes upside down, so the camera stays on the
        // car's side of the road.
        up(t, out) {
            const a = this.smooth(t, 6, 1, this.acc);
            const l = Math.hypot(a[0], a[1], a[2]) || 1;
            const k = 0.5 + 0.5 * clamp(0.5 - a[1] / l, 0, 1);
            return out.set(a[0] / l * k, a[1] / l * k + 1 - k, a[2] / l * k).normalize();
        }

        speed(t) {
            return this.smooth(t, 3, 2, this.acc)[0];
        }

        // Direction of travel in 3D (round loops and up walls), or null while barely moving.
        tangent3(t, out, tmp) {
            this.pos(t + 0.08, out).sub(this.pos(t - 0.08, tmp));
            return out.lengthSq() > 1e-6 ? out.normalize() : null;
        }

        // The car's own up, lightly smoothed and not leaned towards world up.
        carUp(t, out) {
            const a = this.smooth(t, 8, 1, this.acc);
            out.set(a[0], a[1], a[2]);
            if (out.lengthSq() < 1e-8) out.set(0, 1, 0);
            return out.normalize();
        }

        yawRate(t) {
            const a = this.smooth(t, 3, 0, this.acc), b = this.smooth(t - 0.1, 3, 0, this.acc2);
            return Math.atan2(b[0] * a[2] - b[2] * a[0], b[0] * a[0] + b[2] * a[2]) / 0.1;
        }

        // Whether being upside down between samples a and b was a round loop: climbing well above
        // the way in and travelling back the way it came at the top (a corkscrew or a pipe turns
        // or rolls instead).
        isLoop(a, b) {
            const p = this.p;
            let top = a;
            for (let i = a; i <= b; i++)
                if (this.u[3 * i + 1] < this.u[3 * top + 1]) top = i;
            let rise = 0;
            for (let i = a; i <= b; i++) rise = Math.max(rise, p[3 * i + 1] - p[3 * a + 1]);
            const i0 = Math.max(0, top - 3), i1 = Math.min(this.n - 1, top + 3);
            const vx = p[3 * i1] - p[3 * i0], vz = p[3 * i1 + 2] - p[3 * i0 + 2];
            this.tangent(a);
            const back = (vx * this.tx + vz * this.tz) / (Math.hypot(vx, vz) || 1);
            return rise > 5 && back < -0.3;
        }

        // The upside-down stretch found so far, ending at t1, as an event (null if it was in the air).
        loopEvent(t1) {
            const c = this.core;
            if (!c || c.road < 2) return null;
            let i = Math.round(c.a / DT);
            const stop = Math.max(0, Math.round((c.a - 2.5) / DT));
            while (i > stop && this.u[3 * (i - 1) + 1] < 0.8) i--;
            const j = Math.min(this.n - 1, Math.round(t1 / DT));
            return { type: "loop", t0: i * DT, t1: j * DT, round: this.isLoop(i, j) };
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
                // Driving upside down: a loop, a corkscrew or a pipe (a flip in the air doesn't count).
                // The stretch runs from where the car starts tipping over to where it is upright
                // again, at most 2.5 s either side of the upside-down part, slopes, jumps or the
                // finish line around it notwithstanding.
                const uy = this.u[3 * i + 1];
                if (uy < -0.2) {
                    this.core ??= { a: t, b: t, road: 0 };
                    this.core.b = t;
                    if (!this.air[i]) this.core.road++;
                } else if (this.core && (uy > 0.8 || t - this.core.b > 2.5)) {
                    const ev = this.loopEvent(t);
                    if (ev) this.events.push(ev);
                    this.core = null;
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
            // A run that starts in (or right before) a loop starts on the loop shot instead.
            const first = this.nextLoop(0);
            const introEnd = first ? Math.min(3.2, first.t0 - LOOP_LEAD) : 3.2;
            this.push(introEnd < 1.5 ? this.loopShot(first, 0, 0, this.path.finish) : this.intro(introEnd));
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
                const loop = this.nextLoop(t0);
                if (loop && loop.t0 - LOOP_LEAD - t0 < 1.4) {
                    this.push(this.loopShot(loop, t0, this.shots.length, finish));
                    yield;
                    continue;
                }
                const hardEnd = Math.min(finish ?? this.total, loop ? loop.t0 - LOOP_LEAD : Infinity);
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

        // An orbit round the car on the start line, or, if that can't see it, the first of a few
        // other framings that can (any may end early and hand over).
        intro(t1) {
            const R = rng(this.seed, 0, 1);
            const side = R() < 0.5 ? -1 : 1;
            const orbit = (sd) => ({ type: "orbit", t0: 0, t1, minLen: 1.2, dist: 8, h: 3, h1: 1.6, theta: sd * Math.PI * 0.8, omega: -sd * 0.5, fov: 55 });
            for (const shot of [orbit(side), orbit(-side), { type: "chase", t0: 0, t1, minLen: 1.2, d: 6, h: 1.5, s: 0, high: false },
                { type: "chase", t0: 0, t1, minLen: 1.2, d: 6, h: 1.5, s: 0, high: true }, { type: "heli", t0: 0, t1, minLen: 1.2, back: 11, up: 6, s: side * 2 }])
                if (this.check(shot, false)) return shot;
            return { type: "chase", t0: 0, t1, d: 6, h: 1.5, s: 0, high: false };
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
                    if (this.lost(C, finish + dt)) bad++;
                }
                if (bad === 0) return { type: "finish", t0: finish, t1: Infinity, cam: C };
            }
            return { type: "orbit", end: true, t0: finish, t1: Infinity, dist: 7.5, h: 1.8, theta: 0.6, omega: 0.22, fov: 50 };
        }

        // The next upside-down stretch not over by t, including one still under way where the
        // replay ends (a run that finishes in a loop).
        nextLoop(t) {
            let best = null;
            const open = this.path.loopEvent(this.path.end);
            for (const e of open ? [...this.path.events, open] : this.path.events)
                if (e.type === "loop" && e.t1 > t + 0.2 && (!best || e.t0 < best.t0)) best = e;
            return best;
        }

        // Loops get their own shot: from beside a round loop if the whole of it is in sight from
        // there, otherwise from behind the car turning with it, which keeps the road under the
        // camera (a normal chase camera ends up outside the loop, looking at the back of the road).
        loopShot(ev, t0, idx, finish) {
            const P = this.path, w = this.w, c = this.c, up = c.up, T = c.T;
            const R = rng(this.seed, idx, 55);
            const t1 = Math.max(t0 + 0.4, Math.min(ev.t1 + 0.5, finish ?? Infinity, P.end));
            const top = new T.Vector3();
            let topY = -Infinity;
            for (let t = ev.t0; t <= ev.t1; t += 0.05) {
                P.pos(t, w[0]);
                if (w[0].y > topY) {
                    topY = w[0].y;
                    top.copy(w[0]);
                }
            }
            const lowY = Math.min(P.pos(ev.t0, w[0]).y, P.pos(ev.t1, w[1]).y);
            const rl = clamp((topY - lowY) / 2, 3, 40);
            const center = new T.Vector3(top.x, lowY + rl, top.z);
            const dir = P.heading(ev.t0, 8, new T.Vector3());
            const N = new T.Vector3().crossVectors(dir, up).normalize();
            const first = R() < 0.5 ? -1 : 1;
            const shape = { d: 5.4 + R() * 1.2, h: 1.5 + R() * 0.5, ph: R() * 1000 };
            for (const k of ev.round ? [2.4, 3.1, 1.9] : [])
                for (const sd of [first, -first]) {
                    const cam = center.clone().addScaledVector(N, sd * rl * k).addScaledVector(up, rl * 0.15).addScaledVector(dir, -rl * 0.3);
                    let ok = 0, n = 0, okIn = 0, nIn = 0;
                    for (let t = t0; t <= t1; t += 0.1) {
                        const seen = !this.lost(cam, t);
                        n++;
                        if (seen) ok++;
                        if (t >= ev.t0 && t <= ev.t1) {
                            nIn++;
                            if (seen) okIn++;
                        }
                    }
                    if (okIn >= 0.85 * nIn && ok >= 0.75 * n) return { type: "loop", t0, t1, side: true, cam, center, dir, rl, ...shape };
                }
            return { type: "loop", t0, t1, side: false, ...shape };
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
                return { side: v === 0 ? -1 : 1, dist: 6.5 + R() * 2.5, h: 1.5 + R() * 1, lead0: -3 + R() * 2, lead1: 1 + R() * 3 };
            case "front":
                return { dist: 7 + R() * 3, h: 1.3 + R() * 0.8, s: side * (0.6 + R() * 1.6) };
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
            base -= 0.5 * this.shots.filter((s) => s.type === type).length / Math.max(1, this.shots.length);
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
                if (at >= tMin && at <= tMax && e.type !== "loop" && (type === "curb" || e.type === "corner")) {
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
                C.addScaledVector(N, sd * (4 + R() * 1.6)).addScaledVector(up, 1.1 + R() * 0.6).addScaledVector(Tq, R() * 4 - 1);
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

        // Whether a camera sits on the underside of the road while the car is up a wall or upside
        // down (a loop the plan didn't catch): the road itself is then between them.
        underRoad(cam, t, P) {
            const path = this.path;
            if (path.air[clamp(Math.round(t / DT), 0, path.n - 1)]) return false;
            const U = path.carUp(t, this.uu ??= new this.c.T.Vector3());
            return U.y < 0.5 && (cam.x - P.x) * U.x + (cam.y - P.y) * U.y + (cam.z - P.z) * U.z < -0.3;
        }

        // A fixed camera loses sight of the car at t.
        lost(cam, t) {
            const P = this.path.pos(t, this.w[0]);
            return this.underRoad(cam, t, P) || this.c.hides(cam, P.addScaledVector(this.path.carUp(t, this.w[1]), 0.6));
        }

        // Visibility: fixed cameras need a clear line to the car nearly all the time; cameras
        // riding with the car must not need pulling in towards it (that reads as a sudden zoom),
        // so a shot that would run into a wall ends early and hands over to the next one.
        // Low cameras beside the road can lose the bottom half of the car behind the barrier.
        // Raise the shot until the lower body is in sight.
        liftOverRailing(shot) {
            if (!["side", "front", "curb", "tele"].includes(shot.type)) return;
            const c = this.c, up = c.up, w = this.w;
            for (let tries = 0; tries < 3; tries++) {
                let hidden = 0;
                for (const k of [0.25, 0.5, 0.75]) {
                    const t = shot.t0 + (shot.t1 - shot.t0) * k;
                    const P = this.path.pos(t, w[1]);
                    const view = c.viewOf(shot, t, P, this.path, this.view, this.view2, false);
                    const low = w[2].copy(P).addScaledVector(up, 0.3), high = w[0].copy(P).addScaledVector(up, 1.1);
                    if (c.blocked(view.pos, low, 1.2) && !c.blocked(view.pos, high, 1.2)) hidden++;
                }
                if (!hidden) return;
                if (shot.cam) shot.cam.addScaledVector(up, 0.7);
                else shot.h += 0.7;
                shot.lifted = (shot.lifted ?? 0) + 1;
            }
        }

        check(shot, strict) {
            const P = this.path, w = this.w, up = this.c.up;
            const step = 0.15;
            if (RIDE.has(shot.type)) this.linkBlend(shot);
            this.liftOverRailing(shot);
            if (!RIDE.has(shot.type)) {
                let ok = 0, n = 0;
                for (let t = shot.t0; t <= shot.t1 + 1e-6; t += step, n++)
                    if (!this.lost(shot.cam, t)) ok++;
                const anchorOk = !this.lost(shot.cam, shot.ta);
                shot.vis = ok / Math.max(1, n);
                if (!anchorOk || shot.vis < (strict ? 0.9 : 0.75)) return false;
            } else {
                const limit = strict ? 0.75 : 0.4;
                let sum = 0, n = 0;
                for (let t = shot.t0; t <= shot.t1 + 1e-6; t += step) {
                    const want = this.want(shot, t);
                    // Something crossing the view for a moment (a gate, a pillar) doesn't count.
                    if (want < limit && want > 0 && t + step <= shot.t1 && this.want(shot, t + step) >= limit) {
                        sum += 1;
                        n++;
                        continue;
                    }
                    if (want < limit) {
                        if (t - shot.t0 >= (shot.minLen ?? 2.2)) {
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

        // How far the camera can stay from the car before something is in the way (1 = all of it,
        // 0 = the road itself is in the way).
        want(shot, t) {
            const P = this.path.pos(t, this.w[1]);
            const view = this.c.viewOf(shot, t, P, this.path, this.view, this.view2, false);
            if (this.underRoad(view.pos, t, P)) return 0;
            const from = this.w[2].copy(P).addScaledVector(this.path.carUp(t, this.w[3]), 0.8);
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
                    const from = this.w[2].copy(Pt).addScaledVector(P.carUp(t, this.w[3]), 0.8);
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

    // A ghost seen before only reappears (or drops out for being tiny) once that has been due
    // for this long, so one hovering at a threshold doesn't blink.
    const LOD_HOLD = 0.4;

    function ghostLod(cars, focusCar, cam, stackRadius = 1, now = performance.now() / 1000) {
        if (!cam || !cars.length) return;
        const camPos = lodScratch ??= cam.position.clone();
        cam.getWorldPosition(camPos);
        const pxPerUnit = window.innerHeight / (2 * Math.tan(cam.fov * Math.PI / 360) / (cam.zoom || 1));
        const list = [];
        cars.forEach((car, index) => {
            if (!car || car === focusCar) return;
            const p = car.getPosition();
            list.push({ car, p, d: p.distanceTo(camPos), index });
        });
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
        // Stacked ghosts are settled in run order, not by distance to the camera, so which of
        // two stacked ghosts shows never swaps as the camera moves.
        const kept = [];
        for (const g of list) {
            const was = lodState.get(g.car)?.vis ?? true;
            g.stacked = !!fp && g.p.distanceTo(fp) < stackRadius * (was ? 1 : 1.3);
            if (!g.stacked)
                for (const k of kept)
                    if (k.distanceTo(g.p) < (was ? 1 : 1.4)) {
                        g.stacked = true;
                        break;
                    }
            if (!g.stacked) kept.push(g.p);
        }
        list.sort((a, b) => a.d - b.d);
        let shadows = 0, audible = 0;
        for (const g of list) {
            const known = lodState.get(g.car);
            const st = known ?? { vis: true, cast: true, detail: 0, mute: false, culled: false, noSkid: false };
            // Every test has hysteresis, so a ghost near a threshold doesn't flicker.
            const px = 4.5 * pxPerUnit / Math.max(g.d, 0.1);
            let vis = !g.stacked && px >= (st.vis ? 5 : 7);
            let pending = null;
            // Ghosts piling onto one spot hide at once; it is coming back that waits.
            if (known && vis !== st.vis && !(st.vis && g.stacked)) {
                pending = null != st.pending && st.pending <= now ? st.pending : now;
                if (now - pending < LOD_HOLD) vis = st.vis;
                else pending = null;
            }
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
            lodState.set(g.car, { vis, cast, detail: vis ? detail : st.detail, mute, culled: true, noSkid, order, total: Math.max(cars.length, st.total ?? 0), pending });
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
                if (this.exp) this.exp.cancel = true;
                else if (this.rec) this.stopRecording();
                else this.toggleSaveMenu();
            });
            this.onRecKey = (e) => {
                if (this.exp) {
                    // The export drives playback; keys would pause or seek it.
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    if (e.code === "Escape") this.exp.cancel = true;
                } else if (this.menu && e.code === "Escape") {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    this.toggleSaveMenu();
                } else if (this.rec && e.code === "Escape") {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    this.stopRecording();
                }
            };
            window.addEventListener("keydown", this.onRecKey, true);

            this.spinner = el("div", "nsws-loading", document.body);

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
            this.holding = false;
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
            this.disposed = true;
            if (this.exp) this.exp.cancel = true;
            this.menuCleanup?.();
            this.menu?.remove();
            this.menu = null;
            this.notice?.remove();
            window.__nswsVideoAudio?.stopPreview();
            this.spinner.remove();
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
            this.download(new Blob(rec.chunks, { type: rec.mimeType.split(";")[0] }), rec.mimeType.startsWith("video/mp4") ? "mp4" : "webm", this.defaultFileName());
        }

        defaultFileName() {
            const run = this.o.getRuns()[this.o.getFocus()];
            return (this.o.trackName ? this.o.trackName + " - " : "") + (run?.settings.nickname ?? "run");
        }

        // `name` is the whole file name without the extension (the player can change it).
        download(blob, ext, name) {
            const clean = (x) => String(x).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "").replace(new RegExp("\\." + ext + "$", "i"), "").trim().slice(0, 150);
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = (clean(name) || "video") + "." + ext;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 60000);
        }

        soundOptions() {
            if (!this.sound) {
                const get = (k, d) => {
                    try {
                        return localStorage.getItem(k) ?? d;
                    } catch (e) {
                        return d;
                    }
                };
                const vol = parseFloat(get("nsws_save_music_vol", "0.7"));
                const carVol = parseFloat(get("nsws_save_car_vol", "1"));
                this.sound = { cars: get("nsws_save_cars", "1") !== "0", carVolume: carVol >= 0 && carVol <= 2 ? carVol : 1, song: get("nsws_save_song", "") || null, volume: vol >= 0 && vol <= 1 ? vol : 0.7 };
            }
            return this.sound;
        }

        saveSound() {
            try {
                localStorage.setItem("nsws_save_cars", this.sound.cars ? "1" : "0");
                localStorage.setItem("nsws_save_car_vol", String(this.sound.carVolume));
                localStorage.setItem("nsws_save_song", this.sound.song ?? "");
                localStorage.setItem("nsws_save_music_vol", String(this.sound.volume));
            } catch (e) {}
        }

        // Car sounds on or off, and music from the songs the player imported (kept on this device
        // only): an A-Z list that scrolls by itself once it is long, where the song starts, and
        // how loud it is.
        soundMenu(menu) {
            const VA = window.__nswsVideoAudio;
            if (!VA || !window.AudioEncoder || !window.indexedDB) return;
            const opt = this.soundOptions();
            const clock = (t) => Math.floor(t / 60) + ":" + String(Math.floor(t % 60)).padStart(2, "0");
            const carsRow = el("div", "opt", menu);
            const cars = el("button", "button wide", carsRow);
            const showCars = () => {
                cars.textContent = "Car sounds: " + (opt.cars ? "On" : "Off");
                cars.classList.toggle("off", !opt.cars);
            };
            showCars();
            // How loud the cars are in the video, from silent to twice the normal level.
            const carVolRow = el("label", "vol", menu);
            el("span", "", carVolRow).textContent = "Car volume";
            const carVol = el("input", "", carVolRow);
            carVol.type = "range";
            carVol.min = "0";
            carVol.max = "2";
            carVol.step = "0.05";
            carVol.value = String(opt.carVolume);
            const carVolText = el("b", "", carVolRow);
            const showCarVol = () => {
                carVolText.textContent = Math.round(opt.carVolume * 100) + "%";
                carVolRow.style.opacity = opt.cars ? "" : "0.5";
                carVol.disabled = !opt.cars;
            };
            showCarVol();
            carVol.addEventListener("input", () => {
                opt.carVolume = parseFloat(carVol.value);
                showCarVol();
                this.saveSound();
            });
            carVolRow.addEventListener("dblclick", () => {
                opt.carVolume = 1;
                carVol.value = "1";
                showCarVol();
                this.saveSound();
            });
            cars.addEventListener("click", () => {
                this.o.playClick?.();
                opt.cars = !opt.cars;
                showCars();
                showCarVol();
                this.saveSound();
            });

            el("p", "", menu).textContent = "Music";
            const box = el("div", "songs", menu);
            const inner = el("div", "", box);
            const thumb = el("i", "", box);
            const importRow = el("div", "opt", menu);
            const importBtn = el("button", "button wide", importRow);
            importBtn.textContent = "Import song\u2026";
            // The chosen song's waveform: click or drag to set where it starts. Play listens from
            // there; "Start here" moves the start to whatever is playing right now.
            const wave = el("div", "wave", menu);
            wave.title = "Click or drag to choose where the song starts";
            const canvas = el("canvas", "", wave);
            const ctrl = el("div", "opt ctrl", menu);
            const play = el("button", "button", ctrl);
            const back = el("button", "button", ctrl);
            back.textContent = "\u22121s";
            const startText = el("b", "", ctrl);
            const fwd = el("button", "button", ctrl);
            fwd.textContent = "+1s";
            const here = el("button", "button", ctrl);
            here.textContent = "Start here";
            here.title = "Start the song at the moment playing now";
            const volRow = el("label", "vol", menu);
            el("span", "", volRow).textContent = "Music volume";
            const vol = el("input", "", volRow);
            vol.type = "range";
            vol.min = "0";
            vol.max = "1";
            vol.step = "0.05";
            vol.value = String(opt.volume);
            const volText = el("b", "", volRow);
            const showVol = () => volText.textContent = Math.round(opt.volume * 100) + "%";
            showVol();
            vol.addEventListener("input", () => {
                opt.volume = parseFloat(vol.value);
                showVol();
                playing?.setVolume(opt.volume);
                this.saveSound();
            });
            const note = el("p", "note", menu);
            const LOCAL = "Imported songs are saved on this device only. They are never uploaded.";
            note.textContent = LOCAL;
            const picker = el("input", "", menu);
            picker.type = "file";
            picker.accept = "audio/*";
            picker.multiple = true;
            picker.style.display = "none";

            const ROW = 34, ROWS = 5;
            let songs = [], sure = null, y = 0;
            const layout = () => {
                const H = box.clientHeight, full = inner.scrollHeight;
                y = clamp(y, 0, Math.max(0, full - H));
                inner.style.transform = "translateY(" + -Math.round(y) + "px)";
                const scrolls = full > H + 1;
                thumb.style.display = scrolls ? "" : "none";
                if (scrolls) {
                    const th = Math.max(22, H * H / full);
                    thumb.style.height = th + "px";
                    thumb.style.top = (y / (full - H) * (H - th)) + "px";
                }
            };
            const selected = () => songs.find((x) => x.id === opt.song) ?? null;
            const fine = (t) => clock(t) + "." + Math.floor(t * 10 % 10);
            let audio = null, playing = null, raf = 0;
            const draw = () => {
                const sg = selected();
                const W = canvas.clientWidth, H = canvas.clientHeight, dpr = window.devicePixelRatio || 1;
                if (!W || !sg) return;
                if (canvas.width !== Math.round(W * dpr)) {
                    canvas.width = Math.round(W * dpr);
                    canvas.height = Math.round(H * dpr);
                }
                const g = canvas.getContext("2d");
                g.setTransform(dpr, 0, 0, dpr, 0, 0);
                g.clearRect(0, 0, W, H);
                if (!audio || audio.id !== sg.id) {
                    g.fillStyle = "rgba(255, 255, 255, 0.5)";
                    g.font = "13px " + (getComputedStyle(menu).fontFamily || "sans-serif");
                    g.fillText("Loading\u2026", 4, H / 2 + 4);
                    return;
                }
                const n = Math.max(1, Math.floor(W / 2)), p = VA.peaks(audio.buffer, n);
                let top = 0;
                for (const v of p) top = Math.max(top, v);
                const startX = (sg.start ?? 0) / sg.duration * W;
                for (let i = 0; i < n; i++) {
                    const x = i * 2, h = Math.max(1, p[i] / (top || 1) * (H - 4));
                    g.fillStyle = x + 1 < startX ? "rgba(255, 255, 255, 0.25)" : "rgba(255, 255, 255, 0.8)";
                    g.fillRect(x, (H - h) / 2, 1.4, h);
                }
                g.fillStyle = "#7fe08a";
                g.fillRect(Math.round(startX) - 1, 0, 2, H);
                if (playing) {
                    g.fillStyle = "#ffd76a";
                    g.fillRect(Math.round(playing.pos() / sg.duration * W), 0, 1.5, H);
                }
            };
            const showTime = () => {
                const sg = selected();
                if (!sg) return;
                startText.textContent = fine(playing ? playing.pos() : sg.start ?? 0);
                startText.style.color = playing ? "#ffd76a" : "#7fe08a";
                startText.title = playing ? "Playing" : "The song starts here";
                play.textContent = playing ? "\u25a0" : "\u25b6";
                here.classList.toggle("dim", !playing);
            };
            const stopPlaying = () => {
                cancelAnimationFrame(raf);
                VA.stopPreview();
                playing = null;
                showTime();
                draw();
            };
            const tick = () => {
                if (!playing || !menu.isConnected) return;
                showTime();
                draw();
                raf = requestAnimationFrame(tick);
            };
            const playFrom = async (t) => {
                const sg = selected();
                if (!sg || !audio || audio.id !== sg.id) return;
                cancelAnimationFrame(raf);
                const h = playing = await VA.play(audio.buffer, t, opt.volume);
                h.done.then(() => {
                    if (playing === h) stopPlaying();
                });
                tick();
            };
            const showStart = () => {
                const sg = selected();
                wave.style.display = ctrl.style.display = sg ? "" : "none";
                stopPlaying();
                if (!sg) return;
                if (audio?.id !== sg.id) {
                    audio = null;
                    VA.library.load(sg.id).then((song) => {
                        if (song && selected()?.id === sg.id) {
                            audio = { id: sg.id, buffer: song.buffer };
                            draw();
                        }
                    }).catch(() => {});
                }
                showTime();
                draw();
            };
            const render = () => {
                inner.innerHTML = "";
                const rows = [{ id: null, name: "No music" }, ...songs];
                box.style.height = Math.min(rows.length, ROWS) * ROW + "px";
                for (const sg of rows) {
                    const row = el("div", "song" + (sg.id === opt.song ? " selected" : ""), inner);
                    el("span", "name", row).textContent = sg.name;
                    if (sg.id) {
                        el("span", "len", row).textContent = clock(sg.duration);
                        const del = el("button", "del" + (sure === sg.id ? " sure" : ""), row);
                        del.textContent = sure === sg.id ? "Remove?" : "\u00d7";
                        del.title = "Remove from this device";
                        del.addEventListener("click", async (e) => {
                            e.stopPropagation();
                            this.o.playClick?.();
                            if (sure !== sg.id) {
                                sure = sg.id;
                                render();
                                return;
                            }
                            sure = null;
                            await VA.library.remove(sg.id).catch(() => {});
                            if (opt.song === sg.id) {
                                opt.song = null;
                                this.saveSound();
                            }
                            await refresh();
                        });
                    }
                    row.addEventListener("click", () => {
                        if (moved) return;
                        this.o.playClick?.();
                        sure = null;
                        opt.song = sg.id;
                        this.saveSound();
                        render();
                        showStart();
                    });
                }
                layout();
            };
            const reveal = () => {
                const i = opt.song ? songs.findIndex((x) => x.id === opt.song) + 1 : 0;
                if (i * ROW < y || (i + 1) * ROW > y + box.clientHeight) y = i * ROW - ROW * 2;
                layout();
            };
            const refresh = async () => {
                try {
                    songs = await VA.library.list();
                } catch (e) {
                    songs = [];
                }
                if (opt.song && !songs.some((x) => x.id === opt.song)) {
                    opt.song = null;
                    this.saveSound();
                }
                render();
                showStart();
                reveal();
            };

            // Scrolling the list: the wheel, dragging the bar, or dragging the list on a touch screen.
            box.addEventListener("wheel", (e) => {
                if (inner.scrollHeight <= box.clientHeight + 1) return;
                e.preventDefault();
                y += e.deltaY * (e.deltaMode === 1 ? ROW : e.deltaMode === 2 ? box.clientHeight : 1);
                layout();
            }, { passive: false });
            let drag = null, moved = false;
            thumb.addEventListener("pointerdown", (e) => {
                e.preventDefault();
                drag = { id: e.pointerId, y: e.clientY, bar: true };
                thumb.setPointerCapture(e.pointerId);
            });
            box.addEventListener("pointerdown", (e) => {
                if (e.pointerType === "mouse" || drag) return;
                drag = { id: e.pointerId, y: e.clientY, bar: false, from: e.clientY };
                moved = false;
            });
            const onMove = (e) => {
                if (!drag || e.pointerId !== drag.id) return;
                const dy = e.clientY - drag.y;
                drag.y = e.clientY;
                const H = box.clientHeight, full = inner.scrollHeight, th = thumb.offsetHeight;
                if (drag.bar) y += dy * (full - H) / Math.max(1, H - th);
                else {
                    y -= dy;
                    if (Math.abs(e.clientY - drag.from) > 6) moved = true;
                }
                layout();
            };
            const onUp = (e) => {
                if (drag && e.pointerId === drag.id) drag = null;
                setTimeout(() => moved = false, 0);
            };
            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", onUp);
            this.menuCleanup = () => {
                window.removeEventListener("pointermove", onMove);
                window.removeEventListener("pointerup", onUp);
            };

            let saveTimer = 0;
            const setStart = (t) => {
                const sg = selected();
                if (!sg) return;
                sg.start = Math.round(clamp(t, 0, Math.max(0, sg.duration - 0.5)) * 10) / 10;
                clearTimeout(saveTimer);
                saveTimer = setTimeout(() => VA.library.setStart(sg.id, sg.start).catch(() => {}), 300);
                showTime();
                draw();
            };
            let scrub = null;
            const timeAt = (e) => {
                const r = canvas.getBoundingClientRect(), sg = selected();
                return sg ? clamp((e.clientX - r.left) / r.width, 0, 1) * sg.duration : 0;
            };
            wave.addEventListener("pointerdown", (e) => {
                if (!selected()) return;
                e.preventDefault();
                scrub = e.pointerId;
                wave.setPointerCapture(e.pointerId);
                setStart(timeAt(e));
            });
            wave.addEventListener("pointermove", (e) => {
                if (scrub === e.pointerId) setStart(timeAt(e));
            });
            const endScrub = (e) => {
                if (scrub !== e.pointerId) return;
                scrub = null;
                if (playing) playFrom(selected()?.start ?? 0);
            };
            wave.addEventListener("pointerup", endScrub);
            wave.addEventListener("pointercancel", endScrub);
            play.addEventListener("click", () => {
                this.o.playClick?.();
                if (playing) stopPlaying();
                else playFrom(selected()?.start ?? 0);
            });
            for (const [b, d] of [[back, -1], [fwd, 1]])
                b.addEventListener("click", () => {
                    this.o.playClick?.();
                    setStart((selected()?.start ?? 0) + d);
                    if (playing) playFrom(selected()?.start ?? 0);
                });
            here.addEventListener("click", () => {
                if (!playing) return;
                this.o.playClick?.();
                setStart(playing.pos());
            });
            importBtn.addEventListener("click", () => {
                this.o.playClick?.();
                picker.click();
            });
            picker.addEventListener("change", async () => {
                const files = [...(picker.files ?? [])];
                picker.value = "";
                if (!files.length) return;
                const failed = [];
                let last = null;
                importBtn.textContent = "Importing\u2026";
                for (const f of files) {
                    try {
                        last = await VA.library.add(f);
                    } catch (e) {
                        failed.push(f.name);
                    }
                }
                importBtn.textContent = "Import song\u2026";
                if (last) {
                    opt.song = last.id;
                    this.saveSound();
                }
                note.textContent = failed.length ? "Couldn't read " + failed.join(", ") + ". " + LOCAL : LOCAL;
                await refresh();
            });
            refresh();
        }

        toggleSaveMenu() {
            window.__nswsVideoAudio?.stopPreview();
            if (this.menu) {
                this.menuCleanup?.();
                this.menuCleanup = null;
                this.menu.remove();
                this.menu = null;
                window.removeEventListener("pointerdown", this.onMenuAway, true);
                return;
            }
            let chosen = "auto";
            try {
                chosen = localStorage.getItem("nsws_save_size") ?? "auto";
            } catch (e) {}
            const menu = this.menu = el("div", "nsws-save-menu", document.body);
            const left = el("div", "col", menu), right = el("div", "col", menu);
            el("p", "", left).textContent = "Save video";
            this.soundMenu(left);
            el("p", "", right).textContent = "Size";
            // Picking a size only selects it; the big button at the bottom saves.
            if (!SAVE_SIZES.some((sz) => sz.id === chosen)) chosen = SAVE_SIZES[0].id;
            const sizeBtns = SAVE_SIZES.map((size) => {
                const b = el("button", "button" + (size.id === chosen ? " selected" : ""), right);
                b.textContent = size.label;
                b.addEventListener("click", () => {
                    this.o.playClick?.();
                    chosen = size.id;
                    try {
                        localStorage.setItem("nsws_save_size", size.id);
                    } catch (e) {}
                    sizeBtns.forEach((x, i) => x.classList.toggle("selected", SAVE_SIZES[i].id === chosen));
                });
                return b;
            });
            el("p", "", right).textContent = "File name";
            const nameRow = el("label", "fname", right);
            const nameInput = el("input", "", nameRow);
            nameInput.type = "text";
            nameInput.maxLength = 150;
            nameInput.spellcheck = false;
            // An edited name is kept while the menu is reopened, until the followed run changes.
            const base = this.defaultFileName();
            nameInput.value = this.fileName?.base === base ? this.fileName.value : base;
            el("span", "", nameRow).textContent = ".mp4";
            nameInput.addEventListener("input", () => this.fileName = { base, value: nameInput.value });
            // Typing here mustn't reach the replay's shortcuts (Space pauses, and so on).
            for (const type of ["keydown", "keyup", "keypress"])
                nameInput.addEventListener(type, (e) => {
                    e.stopPropagation();
                    if (type === "keydown" && e.key === "Enter") go.click();
                });
            const go = el("button", "button go", right);
            go.innerHTML = '<img src="images/save.svg">';
            go.appendChild(document.createTextNode("Save video"));
            go.addEventListener("click", () => {
                this.o.playClick?.();
                const size = SAVE_SIZES.find((sz) => sz.id === chosen) ?? SAVE_SIZES[0];
                const name = nameInput.value.trim() || this.defaultFileName();
                this.toggleSaveMenu();
                this.exportVideo(size, name);
            });
            const r = this.saveBtn.getBoundingClientRect();
            menu.style.maxHeight = Math.round(r.top - 14) + "px";
            menu.style.overflowY = "auto";
            menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)) + "px";
            menu.style.bottom = Math.round(window.innerHeight - r.top + 6) + "px";
            this.onMenuAway = (e) => {
                if (!menu.contains(e.target) && !this.saveBtn.contains(e.target)) this.toggleSaveMenu();
            };
            window.addEventListener("pointerdown", this.onMenuAway, true);
        }

        exportUI(exp) {
            this.notice?.remove();
            const box = this.notice = el("div", "nsws-export", document.body);
            const inner = el("div", "", box);
            const title = el("p", "", inner);
            title.textContent = "Saving video";
            const label = el("p", "note", inner);
            const track = el("div", "track", inner);
            const fill = el("i", "", track);
            const button = el("button", "button", inner);
            button.textContent = "Cancel";
            button.addEventListener("click", () => {
                this.o.playClick?.();
                exp.cancel = true;
            });
            let last = "";
            return {
                set: (text, frac) => {
                    const t = text + (null != frac ? " " + Math.floor(clamp(frac, 0, 1) * 100) + "%" : "");
                    if (t !== last) label.textContent = last = t;
                    fill.style.width = (clamp(frac ?? 0, 0, 1) * 100).toFixed(1) + "%";
                },
                done: (head, note) => {
                    box.classList.add("done");
                    title.textContent = head;
                    label.textContent = note ?? "";
                    track.remove();
                    button.textContent = "OK";
                    const close = () => box.remove();
                    button.onclick = () => {
                        this.o.playClick?.();
                        close();
                    };
                    setTimeout(close, 9000);
                },
                remove: () => box.remove()
            };
        }

        // Saving draws the replay again frame by frame, as fast as the device allows, and encodes
        // it straight to MP4: no screen capture, no waiting for it to play, and the same video
        // whatever size the window is. Overlays are drawn onto the frames. Browsers without
        // WebCodecs fall back to recording the tab.
        async exportVideo(size, fileName) {
            if (this.exp || this.rec) return;
            if (!window.VideoEncoder || !window.VideoFrame) return this.startRecording();
            const o = this.o;
            const exp = this.exp = { cancel: false };
            this.saveBtn.classList.add("on");
            const ui = this.exportUI(exp);
            const prevTime = o.getTime(), prevPaused = o.isPaused();
            const sfx = o.audio?.destinationSfx ?? null, prevGain = sfx?.gain.value;
            let result = null, error = null;
            try {
                result = await this.runExport(exp, ui, size, () => {
                    // Everything below the replay's own clock is ours now; silence the fast-forward.
                    this.exporting = true;
                    if (sfx) {
                        sfx.gain.cancelScheduledValues(0);
                        sfx.gain.value = 0;
                    }
                });
            } catch (e) {
                error = e;
                console.error(e);
            } finally {
                this.exporting = false;
                o.render.sizeOverride = null;
                if (sfx) sfx.gain.value = prevGain;
                if (!this.disposed) {
                    o.setTime(prevTime);
                    o.setPaused(prevPaused);
                }
                this.exp = null;
                this.saveBtn.classList.remove("on");
                this.lastPassed = -1;
            }
            if (this.disposed || exp.cancel) return ui.remove();
            if (result === "fallback") {
                ui.remove();
                return this.startRecording();
            }
            if (!result) return ui.done("Couldn't save the video", error ? String(error.message ?? error) : "");
            const run = o.getRuns()[o.getFocus()];
            this.download(result.blob, "mp4", fileName || this.defaultFileName());
            const mb = (result.blob.size / 1048576).toFixed(1);
            let note = result.width + "\u00d7" + result.height + ", " + result.fps + " fps, " + mb + " MB";
            if (result.sound === "failed") note += ", no sound (this browser can't encode audio)";
            else if (result.sound) note += ", " + [result.sound.cars ? "car sounds" : null, result.sound.music].filter(Boolean).join(" + ");
            if (result.height < 720) note += ". The resolution had to drop to " + result.height + "p to reach this size; pick a bigger size for a sharper video.";
            ui.done("Video saved", note);
        }

        async runExport(exp, ui, size, begin) {
            const o = this.o, runs = o.getRuns(), focus = o.getFocus(), run = runs[focus];
            const total = o.totalTime?.() ?? 0;
            const finish = (run.settings.time?.numberOfFrames ?? 0) / 1000;
            o.setPaused(true);
            const loaded = () => Math.min(...runs.map((r) => r.replay.getLastFrame().numberOfFrames));
            const need = Math.round(total * 1000) - 1;
            let seen = -1, since = performance.now();
            while (!exp.cancel && loaded() < need) {
                const l = loaded();
                if (l !== seen) {
                    seen = l;
                    since = performance.now();
                } else if (performance.now() - since > 4000) break;
                ui.set("Loading runs", l / need);
                await new Promise((r) => setTimeout(r, 100));
            }
            const end = Math.min(finish + 4, loaded() / 1000);
            if (this.enabled) {
                for (const r of runs) this.pathOf(r).sync();
                const planner = this.plannerFor(runs, focus);
                let mark = planner.plannedTo;
                since = performance.now();
                while (!exp.cancel && !planner.done) {
                    planner.step(30);
                    if (planner.plannedTo !== mark) {
                        mark = planner.plannedTo;
                        since = performance.now();
                    } else if (performance.now() - since > 3000) break;
                    ui.set("Planning shots", planner.plannedTo / end);
                    await yieldTask();
                }
            }
            if (exp.cancel) return null;
            const D = end + 0.1;
            const cap = size.cap ?? null;
            const VA = window.__nswsVideoAudio;
            const sound = VA && window.AudioEncoder ? this.soundOptions() : null;
            let song = null;
            if (sound?.song) {
                ui.set("Loading the song", null);
                try {
                    song = await VA.library.load(sound.song);
                } catch (e) {}
            }
            if (exp.cancel) return null;
            const wantAudio = !!sound && (sound.cars || !!song);
            const audioRate = !wantAudio ? 0 : cap || (size.rate ?? 1) <= 0.25 ? 96000 : (size.rate ?? 1) >= 1 ? 160000 : 128000;
            let rate = cap ? Math.max(2e5, cap * 8 * 0.96 / D - audioRate) : BASE_RATE * (size.rate ?? 1);
            begin();
            let audio = null, capture = null;
            for (let pass = 0; pass < 3; pass++) {
                const cfg = await encoderConfig(rate, !!cap);
                if (!cfg) return pass ? null : "fallback";
                if (pass === 0 && sound?.cars) capture = { fps: cfg.framerate, frames: [], events: [] };
                const video = await this.renderPass(exp, ui, cfg, end, pass, pass === 0 ? capture : null);
                if (!video) return null;
                if (pass === 0 && wantAudio) {
                    ui.set("Mixing sound", null);
                    const dur = video.chunks.length / video.fps;
                    const cars = capture?.frames.length ? await VA.renderCars(capture, (name) => this.o.audio?.getBuffer?.(name) ?? null, dur) : null;
                    if (exp.cancel) return null;
                    audio = await VA.encode(VA.mix(dur, cars, sound.carVolume ?? 1, song?.buffer ?? null, sound.volume, song?.start ?? 0), audioRate);
                }
                const out = { blob: muxMp4({ ...video, audio }), width: video.width, height: video.height, fps: video.fps, sound: wantAudio ? audio ? { cars: sound.cars, music: song?.name ?? null } : "failed" : null };
                // The encoder only aims at the bitrate; when it overshoots the cap, go again smaller.
                if (cap && out.blob.size > cap && pass < 2) {
                    rate *= cap / out.blob.size * 0.9;
                    continue;
                }
                return out;
            }
            return null;
        }

        async renderPass(exp, ui, cfg, end, pass, capture) {
            const o = this.o, W = cfg.width, H = cfg.height, fps = cfg.framerate;
            o.render.sizeOverride = { width: W, height: H };
            const canvas = document.createElement("canvas");
            canvas.width = W;
            canvas.height = H;
            const g = canvas.getContext("2d", { alpha: false });
            const chunks = [];
            let desc = null, failed = null;
            const enc = new VideoEncoder({
                output: (chunk, meta) => {
                    const data = new Uint8Array(chunk.byteLength);
                    chunk.copyTo(data);
                    chunks.push({ data, key: chunk.type === "key" });
                    const d = meta?.decoderConfig?.description;
                    if (d && !desc) desc = new Uint8Array(ArrayBuffer.isView(d) ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d.slice(0));
                },
                error: (e) => failed = e
            });
            enc.configure(cfg);
            if (this.enabled) this.viewer.reset();
            const n = Math.floor(end * fps) + 1;
            // What the cars' sound code asks for each frame, for the soundtrack (see nsws_video_audio.js).
            const runs = o.getRuns();
            const ids = new Map(runs.map((r, i) => [r.car, i]));
            let cur = null;
            if (capture)
                window.__nswsAudioTap = (car, kind, w, rate, gain) => {
                    const id = ids.get(car);
                    if (null == id || !cur) return;
                    if (kind >= 3) {
                        capture.events.push({ t: cur.t, car: id, kind, rate, gain });
                        return;
                    }
                    let c = cur.cars.get(id);
                    if (!c) cur.cars.set(id, c = { p: null, eng: [0.7, 0], tire: [], skid: [0, 0, 0, 0] });
                    if (kind === 0) c.eng = [rate, gain];
                    else if (kind === 1) c.tire[w] = [rate, gain];
                    else c.skid[w] = gain;
                };
            const T = this.T, cp = new T.Vector3(), cf = new T.Vector3(), cq = new T.Quaternion(), cu = new T.Vector3();
            try {
                for (let k = 0; k < n; k++) {
                    if (exp.cancel || this.disposed) return null;
                    if (failed) throw failed;
                    this.expT = k / fps;
                    o.setPaused(false);
                    o.setTime(k ? (k - 1) / fps : 0);
                    if (capture) cur = { t: this.expT, cars: new Map(), cam: null };
                    o.step(k ? 1 / fps : 0);
                    if (capture) {
                        const cam = o.render.camera;
                        cam.getWorldPosition(cp);
                        cam.getWorldDirection(cf);
                        cu.set(0, 1, 0).applyQuaternion(cam.getWorldQuaternion(cq));
                        cur.cam = [cp.x, cp.y, cp.z, cf.x, cf.y, cf.z, cu.x, cu.y, cu.z];
                        for (const [id, c] of cur.cars) {
                            const p = runs[id].car.getPosition();
                            c.p = [p.x, p.y, p.z];
                        }
                        capture.frames.push(cur);
                    }
                    g.fillStyle = "#000";
                    g.fillRect(0, 0, W, H);
                    g.drawImage(o.render.canvas, 0, 0, W, H);
                    this.paintOverlay(g, W, H, this.expT);
                    const frame = new VideoFrame(canvas, { timestamp: Math.round(k * 1e6 / fps), duration: Math.round(1e6 / fps) });
                    enc.encode(frame, { keyFrame: k % (fps * 4) === 0 });
                    frame.close();
                    ui.set(pass ? "Fitting it under the size" : "Rendering", (k + 1) / n);
                    while (enc.encodeQueueSize > 3 && !failed) await new Promise((r) => setTimeout(r, 1));
                    await yieldTask();
                }
                await enc.flush();
                if (failed) throw failed;
            } finally {
                if (enc.state !== "closed") enc.close();
                if (capture) window.__nswsAudioTap = null;
            }
            const vp9 = cfg.codec.startsWith("vp09");
            if (!chunks.length || !vp9 && !desc) throw new Error("The encoder produced no video");
            return { vp9, desc, width: W, height: H, fps, chunks };
        }

        readPalette() {
            const root = getComputedStyle(document.documentElement), body = getComputedStyle(this.o.uiElement ?? document.body);
            const v = (name, d) => root.getPropertyValue(name).trim() || d;
            return {
                surface: v("--surface-color", "#28346a"),
                surface2: v("--surface-secondary-color", "#212b5a"),
                surface3: v("--surface-tertiary-color", "#192042"),
                font: body.fontFamily || "sans-serif",
                style: body.fontStyle === "italic" ? "italic" : "normal"
            };
        }

        // The overlays, drawn onto an exported frame: the same layout as on screen, sized to the video.
        paintOverlay(g, W, H, t) {
            const o = this.o, runs = o.getRuns(), focus = o.getFocus(), run = runs[focus], car = run.car;
            const u = H / 720;
            const pal = this.palette ??= this.readPalette();
            const font = (px) => pal.style + " " + (px * u).toFixed(1) + "px " + pal.font;
            const frame = car.getTime().numberOfFrames;
            const fin = car.getFinishTime?.();
            const finAt = null != fin ? fin.numberOfFrames / 1000 : null;
            const multi = runs.length > 1;
            const rows = multi ? this.standings(runs) : null;
            const bar = this.enabled ? Math.round(H * 0.065) : 0;
            g.save();
            g.textBaseline = "middle";
            if (this.enabled) {
                const tags = this.layoutTags(runs, focus, o.render.camera, W, H, u).filter((x) => x.show).sort((a, b) => b.d - a.d);
                for (const tag of tags) {
                    const s = tag.s * u, name = tag.run.settings.nickname ?? "";
                    g.font = pal.style + " " + (15 * s).toFixed(1) + "px " + pal.font;
                    const bw = 16 * s + g.measureText(name).width + 9 * s, bh = 23 * s;
                    const x0 = tag.x - bw / 2, y0 = tag.y - bh;
                    g.fillStyle = tag.focus ? "rgba(40, 52, 106, 0.9)" : "rgba(25, 32, 66, 0.62)";
                    g.fillRect(x0, y0, bw, bh);
                    g.fillStyle = colorOf(tag.run);
                    g.fillRect(x0 + 5 * s, y0 + 4 * s, 5 * s, 15 * s);
                    g.fillStyle = "#fff";
                    g.fillText(name, x0 + 16 * s, y0 + bh / 2 + s);
                }
                g.fillStyle = "#000";
                g.fillRect(0, 0, W, bar);
                g.fillRect(0, H - bar, W, bar);
                if (rows) this.paintTower(g, rows, focus, W - 12 * u, bar + 10 * u, u, pal);
            }

            // The live panel, fading out at the finish.
            const panelAlpha = null == finAt ? 1 : 1 - clamp((t - finAt) / 0.3, 0, 1);
            if (panelAlpha > 0) {
                g.globalAlpha = panelAlpha;
                const me = rows ? rows.findIndex((r) => r.i === focus) : 0;
                g.font = font(22);
                const parts = [];
                if (multi) parts.push({ text: (me + 1) + "/" + runs.length, size: 22, bg: "#334b77", l: 18, r: 14 });
                parts.push({ text: run.settings.nickname ?? "", size: 22, l: 14, r: 14, chip: colorOf(run) });
                parts.push({ text: formatTime(null != fin ? fin.numberOfFrames : frame), size: 22, bg: pal.surface3, l: 14, r: 14, min: g.measureText("0").width / u * 7.2, right: true });
                parts.push({ text: Math.round(Math.abs(car.getSpeedKmh())) + " km/h", size: 16, bg: pal.surface3, l: 14, r: 18, alpha: 0.7 });
                const rh = 36 * u;
                let y = H - bar - (this.enabled ? 10 : 18) * u - rh;
                const rw = rowWidth(g, parts, u, pal);
                drawRow(g, parts, (W - rw) / 2, y, rh, 8 * u, u, pal, pal.surface);
                const boxAbove = (text, size, bg, color, alpha, padY) => {
                    g.font = font(size);
                    const bw = g.measureText(text).width + 24 * u, bh = (size + 2 * padY) * u;
                    y -= 4 * u + bh;
                    g.fillStyle = bg;
                    g.fillRect((W - bw) / 2, y, bw, bh);
                    g.globalAlpha = panelAlpha * alpha;
                    g.fillStyle = color;
                    g.fillText(text, (W - bw) / 2 + 12 * u, y + bh / 2 + u);
                    g.globalAlpha = panelAlpha;
                };
                if (o.trackName) boxAbove(o.trackName, 14, "rgba(25, 32, 66, 0.75)", "#fff", 0.85, 3);
                // Split against the best other run at the checkpoint just passed, for 2.6 s.
                let passed = 0;
                for (const c of run.checkpointTimes)
                    if (c.numberOfFrames <= frame) passed++;
                const cp = passed > 0 ? run.checkpointTimes[passed - 1].numberOfFrames : null;
                if (multi && null != cp && frame - cp < 2600) {
                    let best = null;
                    for (let i = 0; i < runs.length; i++) {
                        const c = i === focus ? null : runs[i].checkpointTimes[passed - 1];
                        if (c && (null == best || c.numberOfFrames < best)) best = c.numberOfFrames;
                    }
                    if (null != best) {
                        const diff = cp - best;
                        boxAbove((diff <= 0 ? "-" : "+") + (Math.abs(diff) / 1000).toFixed(3), 20, "rgba(25, 32, 66, 0.85)", diff <= 0 ? "#7fe08a" : "#ff8a80", 1, 4);
                    }
                }
                g.globalAlpha = 1;
            }

            if (null != finAt && t >= finAt) this.paintCard(g, runs, focus, run, fin.numberOfFrames, t - finAt, W, H, bar, u, pal);
            if (!document.body.classList.contains("nsws-hide-inputs")) this.paintInputs(g, H - bar - 18 * u, u);
            if (this.enabled && t < 0.7) {
                g.globalAlpha = 1 - t / 0.7;
                g.fillStyle = "#000";
                g.fillRect(0, 0, W, H);
            }
            g.restore();
        }

        paintTower(g, rows, focus, right, top, u, pal) {
            const MAX = 10;
            let list = rows.slice(0, MAX);
            const meAt = rows.findIndex((r) => r.i === focus);
            if (meAt >= MAX) list = rows.slice(0, MAX - 1).concat([rows[meAt]]);
            const lead = rows[0];
            g.font = pal.style + " " + (15 * u).toFixed(1) + "px " + pal.font;
            const items = list.map((r) => {
                let gap = "";
                if (null != r.finished) gap = r === lead ? formatTime(r.finished) : "+" + ((r.finished - lead.finished) / 1000).toFixed(3);
                else if (r !== lead && r.passed > 0) {
                    const c = lead.run.checkpointTimes[r.passed - 1];
                    if (c) gap = "+" + ((r.lastCp - c.numberOfFrames) / 1000).toFixed(3);
                }
                let name = r.run.settings.nickname ?? "";
                while (name.length > 1 && g.measureText(name).width > 150 * u) name = name.slice(0, -2) + "\u2026";
                return { r, name, gap, nw: g.measureText(name).width, gw: gap ? g.measureText(gap).width : 0 };
            });
            const posW = g.measureText("00").width + 14 * u;
            const width = posW + 4 * u + Math.max(...items.map((x) => x.nw)) + 14 * u + Math.max(0, ...items.map((x) => x.gw ? x.gw + 19 * u : 0));
            const rh = 23 * u, x0 = right - width;
            items.forEach((it, n) => {
                const y = top + n * (rh + 2 * u), place = rows.indexOf(it.r) + 1;
                g.fillStyle = it.r.i === focus ? "rgba(51, 75, 119, 0.92)" : "rgba(25, 32, 66, 0.72)";
                g.fillRect(x0, y, width, rh);
                g.fillStyle = "rgba(0, 0, 0, 0.25)";
                g.fillRect(x0, y, posW, rh);
                g.fillStyle = colorOf(it.r.run);
                g.fillRect(x0 + posW, y, 4 * u, rh);
                g.fillStyle = "#fff";
                g.textAlign = "center";
                g.fillText(String(place), x0 + posW / 2, y + rh / 2 + u);
                g.textAlign = "left";
                g.fillText(it.name, x0 + posW + 11 * u, y + rh / 2 + u);
                if (it.gap) {
                    g.globalAlpha = 0.75;
                    g.textAlign = "right";
                    g.fillText(it.gap, right - 7 * u, y + rh / 2 + u);
                    g.textAlign = "left";
                    g.globalAlpha = 1;
                }
            });
        }

        paintCard(g, runs, focus, run, finishFrames, since, W, H, bar, u, pal) {
            const a = clamp(since / 0.3, 0, 1), m = 1 - Math.pow(1 - clamp(since / 0.45, 0, 1), 3);
            const font = (px) => pal.style + " " + (px * u).toFixed(1) + "px " + pal.font;
            const name = run.settings.nickname ?? "", time = formatTime(finishFrames);
            let place = null;
            if (runs.length > 1) {
                const times = runs.map((r, i) => ({ i, f: r.settings.time?.numberOfFrames ?? 1e12 })).sort((x, y) => x.f - y.f);
                place = times.findIndex((x) => x.i === focus) + 1;
            }
            g.font = font(40);
            const pw = place ? g.measureText(String(place)).width + (g.font = font(20), g.measureText(ordinal(place)).width) + 44 * u : 0;
            g.font = font(28);
            const nw = g.measureText(name).width + 16 * u;
            g.font = font(16);
            const tw = this.o.trackName ? g.measureText(this.o.trackName).width : 0;
            g.font = font(32);
            const rw = g.measureText(time).width + 48 * u;
            const ww = Math.max(nw, tw) + 40 * u;
            const h = 80 * u, w = pw + ww + rw;
            const x = (W - w) / 2, y = H - bar - 0.09 * H - h - 3 * u + 40 * u * (1 - m);
            g.save();
            g.globalAlpha = a;
            g.beginPath();
            const sk = 10 * u;
            g.moveTo(x + sk, y);
            g.lineTo(x + w, y);
            g.lineTo(x + w - sk, y + h + 3 * u);
            g.lineTo(x, y + h + 3 * u);
            g.closePath();
            g.clip();
            g.fillStyle = "#7272c2";
            g.fillRect(x, y, w, h + 3 * u);
            g.fillStyle = "#334b77";
            g.fillRect(x, y, pw, h);
            g.fillStyle = pal.surface2;
            g.fillRect(x + pw, y, ww, h);
            g.fillStyle = pal.surface3;
            g.fillRect(x + pw + ww, y, rw, h);
            g.fillStyle = "#fff";
            if (place) {
                g.font = font(40);
                const p = String(place);
                g.fillText(p, x + 24 * u, y + h / 2 + 2 * u);
                const px = x + 24 * u + g.measureText(p).width + 2 * u;
                g.font = font(20);
                g.fillText(ordinal(place), px, y + h / 2 + 8 * u);
            }
            const wx = x + pw + 20 * u;
            g.fillStyle = colorOf(run);
            g.fillRect(wx, y + 14 * u + 1 * u, 6 * u, 26 * u);
            g.fillStyle = "#fff";
            g.font = font(28);
            g.fillText(name, wx + 16 * u, y + (this.o.trackName ? 29 : 40) * u);
            if (this.o.trackName) {
                g.globalAlpha = a * 0.6;
                g.font = font(16);
                g.fillText(this.o.trackName, wx, y + 58 * u);
                g.globalAlpha = a;
            }
            g.textAlign = "right";
            const rx = x + w - 26 * u;
            g.globalAlpha = a * 0.6;
            g.font = font(14);
            g.fillText("Time", rx, y + 25 * u);
            g.globalAlpha = a;
            g.font = font(32);
            g.fillText(time, rx, y + 52 * u);
            g.restore();
        }

        paintInputs(g, bottom, u) {
            const c = this.o.getControls?.();
            if (!c) return;
            const k = 34 * u, gap = 4 * u, x = 24 * u;
            const key = (kx, ky, on, rot) => {
                g.fillStyle = on ? "rgba(255, 255, 255, 0.92)" : "rgba(25, 32, 66, 0.6)";
                g.fillRect(kx, ky, k, k);
                g.save();
                g.translate(kx + k / 2, ky + k / 2);
                g.rotate(rot);
                g.fillStyle = on ? "#192042" : "#fff";
                g.beginPath();
                g.moveTo(0, -k * 0.24);
                g.lineTo(k * 0.22, k * 0.14);
                g.lineTo(-k * 0.22, k * 0.14);
                g.closePath();
                g.fill();
                g.restore();
            };
            const y1 = bottom - k, y0 = y1 - gap - k;
            key(x + k + gap, y0, c.up, 0);
            key(x, y1, c.left, -Math.PI / 2);
            key(x + k + gap, y1, c.down, Math.PI);
            key(x + 2 * (k + gap), y1, c.right, Math.PI / 2);
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
                // Down a steep ramp or up a wall, behind the car along the ground would be inside
                // the road: follow its real direction of travel instead.
                const steep = clamp((0.94 - path.carUp(t, e[4]).y) / 0.5, 0, 1);
                const D = steep > 0 && path.tangent3(t, e[3], e[4]) ? e[3].multiplyScalar(steep).addScaledVector(Hs, 1 - steep).normalize() : Hs;
                pos.copy(P).addScaledVector(D, -d).addScaledVector(carUp, h).addScaledVector(right, shot.s);
                look.copy(P).addScaledVector(D, 3.5).addScaledVector(carUp, 0.55);
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
            case "loop":
                if (shot.side) {
                    // Drifting along beside the loop, the frame leaning towards the car.
                    pos.copy(shot.cam).addScaledVector(shot.dir, (k - 0.5) * shot.rl * 0.4);
                    look.copy(shot.center).lerp(P, 0.5);
                    const reach = Math.max(shot.rl * 1.3, look.distanceTo(P) + 2.5);
                    out.fov = clamp(2 * Math.atan(reach / Math.max(pos.distanceTo(look), 1)) * 180 / Math.PI, 30, 80);
                    out.lens = 0.6;
                } else {
                    const T3 = path.tangent3(t, e[3], e[4]) ?? e[3].copy(Hs);
                    const U = path.carUp(t, e[4]);
                    pos.copy(P).addScaledVector(T3, -shot.d).addScaledVector(U, shot.h);
                    look.copy(P).addScaledVector(T3, 3).addScaledVector(U, 0.5);
                    out.up.copy(U);
                    out.fov = 64 + Math.min(speed, 500) * 0.03;
                    out.lens = 0.4;
                }
                break;
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

            // Shake as the car passes close to a trackside camera or lands a jump, and the shot's slow tilt.
            const near = shot.cam ? clamp((18 - pos.distanceTo(P)) / 14, 0, 1) : 0;
            const amp = (PASS_SHAKE[shot.type] ?? 0) * near * near * Math.min(speed / 250, 1.3) + (LAND_SHAKE[shot.type] ?? 0) * this.landing(path, t);
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
                    const from = this.e[5].copy(P).addScaledVector(path.carUp(t, this.e[4]), 0.8);
                    // Never into the car: at most down to about a car length away.
                    const d = A.pos.distanceTo(from);
                    A.pos.sub(from).multiplyScalar(Math.max(k, Math.min(1, MIN_VIEW_DISTANCE / Math.max(d, 1e-3)))).add(from);
                }
            }
            this.frameCar(A, P);
            return A;
        }

        // Keeps the followed car near the middle of the frame. Wherever a shot would put it close
        // to an edge, the camera turns towards it, easing in so it never snaps: the car stays
        // within about the middle 40% across and a third above or below the centre (16:9).
        frameCar(view, P) {
            const fr = this.fr ??= [0, 1, 2, 3].map(() => new this.T.Vector3());
            const F = fr[0].subVectors(view.look, view.pos);
            const dist = F.length();
            if (dist < 1e-3) return;
            F.divideScalar(dist);
            const R = fr[1].crossVectors(F, view.up);
            if (R.lengthSq() < 1e-8) return;
            R.normalize();
            const U = fr[2].crossVectors(R, F);
            const v = fr[3].copy(P).addScaledVector(this.up, 0.4).sub(view.pos);
            const z = v.dot(F);
            if (z < 0.5) return;
            const tv = Math.tan(view.fov * Math.PI / 360), th = tv * 16 / 9;
            const x = v.dot(R) / z / th, y = v.dot(U) / z / tv;
            const soft = (a, lo, hi) => {
                const lo0 = lo * 0.6, hi0 = hi * 0.6;
                if (a > hi0) return hi0 + (hi - hi0) * Math.tanh((a - hi0) / (hi - hi0));
                if (a < lo0) return lo0 + (lo - lo0) * Math.tanh((a - lo0) / (lo - lo0));
                return a;
            };
            const x2 = soft(x, -0.42, 0.42), y2 = soft(y, -0.36, 0.32);
            if (x2 === x && y2 === y) return;
            const yaw = Math.atan(x * th) - Math.atan(x2 * th), pitch = Math.atan(y * tv) - Math.atan(y2 * tv);
            F.multiplyScalar(Math.cos(yaw)).addScaledVector(R, Math.sin(yaw));
            F.multiplyScalar(Math.cos(pitch)).addScaledVector(U, Math.sin(pitch)).normalize();
            view.look.copy(view.pos).addScaledVector(F, dist);
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
            const time = o.getTime?.() ?? 0;
            const stalled = !o.isPaused?.() && !o.isDragging?.() && time === this.prevTime && time < (o.totalTime?.() ?? 0) - 1e-3;
            this.prevTime = time;
            const P = car.getPosition();
            const pivot = this.pivot.copy(P).addScaledVector(this.up, 0.6);
            if (!this.enabled) {
                this.holding = false;
                this.showWaiting(stalled);
                if (!o.isSpectator()) this.viewer.apply(o.render.camera, pivot, o.render.camera === car.cameraCockpit);
                ghostLod(runs.map((r) => r.car), car, o.render.camera, 1, this.clock());
                return;
            }
            const frame = car.getTime().numberOfFrames;
            const t = this.lastT = frame / 1000;
            this.collectMeshes(runs, performance.now() / 1000);
            for (const r of runs) this.pathOf(r).sync();
            const planner = this.plannerFor(runs, focus);
            planner.step(planner.plannedTo < t + 2 ? 12 : 4);
            this.holding = !this.exporting && !planner.done && planner.plannedTo < t + 0.3;
            this.showWaiting(stalled || this.holding);
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

            ghostLod(runs.map((r) => r.car), car, viewCam, 1, this.clock());
            this.fadeCars(runs, focus, viewCam, P);
            if (this.exporting) return;
            this.updateTags(runs, focus, viewCam);
            this.updatePanels(runs, focus, run, frame, speed);
        }

        clock() {
            return this.exporting ? this.expT : performance.now() / 1000;
        }

        // Shows the spinner while playback waits, for the replays to load that far or for the
        // director to plan the moment shown (playback holds for that, see `holding`).
        showWaiting(waiting) {
            const now = performance.now();
            if (!waiting) this.waitSince = null;
            else this.waitSince ??= now;
            const show = null != this.waitSince && now - this.waitSince > 150 && !this.exporting;
            if (show !== this.spinnerShown) {
                this.spinnerShown = show;
                this.spinner.classList.toggle("shown", show);
            }
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
                    // A ghost running into the followed car fades out rather than vanishing.
                    op = Math.min(op, clamp((Q.distanceTo(P) - 1) / 1.6, 0, 1));
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

        // Where each nametag goes on a W x H view (sizes times px), the followed car's first and
        // then nearest first, dropping any that would mostly cover one already placed.
        layoutTags(runs, focus, cam, W, H, px) {
            const camPos = cam.getWorldPosition(this.v[5]);
            const carUp = this.v[6];
            const want = [];
            for (let i = 0; i < runs.length; i++) {
                const run = runs[i];
                const P = run.car.getPosition();
                carUp.set(0, 1, 0).applyQuaternion(run.car.getQuaternion());
                P.addScaledVector(carUp, 1.55);
                const d = P.distanceTo(camPos);
                const uv = d > 2.2 && d < 170 ? this.project(cam, P) : null;
                const show = !!uv && uv.u > -0.1 && uv.u < 1.1 && uv.v > -0.1 && uv.v < 1.1;
                want.push({ i, run, uv, d, show, focus: i === focus, x: 0, y: 0, s: 1 });
            }
            want.sort((a, b) => (b.i === focus) - (a.i === focus) || a.d - b.d);
            const placed = [];
            for (const t of want) {
                if (!t.show) continue;
                t.s = clamp(9 / t.d, 0.62, 1.1);
                t.x = t.uv.u * W;
                t.y = (1 - t.uv.v) * H;
                const w = ((t.run.settings.nickname ?? "").length * 9.5 + 24) * t.s * px, h = 23 * t.s * px;
                const box = [t.x - w / 2, t.y - h, t.x + w / 2, t.y];
                for (const b of placed) {
                    const ox = Math.min(box[2], b[2]) - Math.max(box[0], b[0]);
                    const oy = Math.min(box[3], b[3]) - Math.max(box[1], b[1]);
                    if (ox > 0 && oy > h * 0.35 && ox > Math.min(w, b[2] - b[0]) * 0.3) {
                        t.show = false;
                        break;
                    }
                }
                if (t.show) placed.push(box);
            }
            return want;
        }

        updateTags(runs, focus, cam) {
            if (!this.layer) return;
            const seen = new Set();
            for (const { run, show, focus: isFocus, x: tx, y: ty, s: ts, d } of this.layoutTags(runs, focus, cam, window.innerWidth, window.innerHeight, 1)) {
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
                if (show !== tag.shown) {
                    tag.e.style.display = show ? "" : "none";
                    tag.shown = show;
                }
                if (isFocus !== tag.focus) {
                    tag.e.classList.toggle("focus", isFocus);
                    tag.focus = isFocus;
                }
                if (!show) continue;
                const x = Math.round(tx), y = Math.round(ty);
                const s = Math.round(ts * 100) / 100;
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
