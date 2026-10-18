// Images and GIFs players upload to the chat: what kind of file it really is, and whether it may
// be shown. Every upload is checked by two Workers AI models before it is stored: Clef judges the
// picture, and Moondream reads out any text, which then goes through the chat's own slur filter
// (Clef doesn't flag slurs written in an image). The models only read PNG, JPEG and WebP, so a GIF
// is decoded here and sampled frames are sent as PNG grids.

import { findSlurs } from "./chatfilter.js";

const CHECK_MODEL = "@cf/cloudflare/clef-flash";
const READ_MODEL = "@cf/moondream/moondream3.1-9B-A2B";
// The single GIF frame the text is read from, at most this wide or tall.
const READ_SIDE = 640;
const MAX_PIXELS = 16_000_000;
const MAX_SIDE = 8192;
// Decoding a GIF composites every frame up to the last one sampled; this caps that work.
const GIF_MAX_CANVAS = 2_500_000;
const GIF_MAX_WORK = 200_000_000;
// Up to 16 frames, four to a 2x2 grid, each grid one image for the model (it takes four).
const GIF_SAMPLES = 16;
const CELL = 320;
// Above this the model's answer refuses the upload. Clef answers with a probability per question.
const REFUSE_AT = 0.5;

const QUESTIONS = {
    sexual: {
        type: "noul",
        instructions: "Does it show nudity, sexual acts or gestures, genitals, exposed breasts or buttocks, or anything else sexually explicit or strongly sexually suggestive?",
    },
    hate: {
        type: "noul",
        instructions: "Does it contain a hate symbol such as a swastika, or imagery that attacks people for their race, ethnicity, religion, sexuality, gender or disability?",
    },
    gore: {
        type: "noul",
        instructions: "Does it show graphic gore, a seriously injured or dead body, or self-harm?",
    },
};
const REASONS = { sexual: "sexual content", hate: "hateful content", gore: "graphic violence" };

function u16le(b, i) {
    return b[i] | (b[i + 1] << 8);
}

function u16be(b, i) {
    return (b[i] << 8) | b[i + 1];
}

function u24le(b, i) {
    return b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
}

function u32be(b, i) {
    return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
}

function ascii(b, i, n) {
    return String.fromCharCode(...b.subarray(i, i + n));
}

function pngInfo(b) {
    if (b.length < 33 || ascii(b, 12, 4) !== "IHDR") return null;
    const info = { type: "image/png", w: u32be(b, 16), h: u32be(b, 20), animated: false };
    // An APNG announces itself with acTL before the first IDAT; only its first frame would be checked.
    for (let i = 8; i + 8 <= b.length;) {
        const length = u32be(b, i);
        const kind = ascii(b, i + 4, 4);
        if (kind === "acTL") info.animated = true;
        if (kind === "IDAT" || kind === "IEND") break;
        i += 12 + length;
    }
    return info;
}

function jpegInfo(b) {
    for (let i = 2; i + 9 < b.length;) {
        if (b[i] !== 0xff) return null;
        const marker = b[i + 1];
        if (marker === 0xff) {
            i++;
            continue;
        }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            i += 2;
            continue;
        }
        const length = u16be(b, i + 2);
        // Start-of-frame markers, except DHT (C4), JPG (C8) and DAC (CC).
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return { type: "image/jpeg", w: u16be(b, i + 7), h: u16be(b, i + 5), animated: false };
        }
        i += 2 + length;
    }
    return null;
}

function webpInfo(b) {
    if (b.length < 30) return null;
    const chunk = ascii(b, 12, 4);
    if (chunk === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
        return { type: "image/webp", w: u16le(b, 26) & 0x3fff, h: u16le(b, 28) & 0x3fff, animated: false };
    }
    if (chunk === "VP8L" && b[20] === 0x2f) {
        const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
        return { type: "image/webp", w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1, animated: false };
    }
    if (chunk === "VP8X") {
        return { type: "image/webp", w: u24le(b, 24) + 1, h: u24le(b, 27) + 1, animated: (b[20] & 0x02) !== 0 };
    }
    return null;
}

// The real type and size of an upload from its first bytes, or null if it isn't an image this
// chat takes. The name and type the browser claimed are never trusted.
export function sniffImage(bytes) {
    const b = bytes;
    let info = null;
    if (b.length > 13 && (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a")) {
        info = { type: "image/gif", w: u16le(b, 6), h: u16le(b, 8), animated: true };
    } else if (b.length > 8 && b[0] === 0x89 && ascii(b, 1, 3) === "PNG") {
        info = pngInfo(b);
    } else if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
        info = jpegInfo(b);
    } else if (b.length > 16 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
        info = webpInfo(b);
    }
    if (!info || !(info.w > 0) || !(info.h > 0) || info.w > MAX_SIDE || info.h > MAX_SIDE || info.w * info.h > MAX_PIXELS) return null;
    return info;
}

function skipSubBlocks(b, i) {
    while (i < b.length && b[i] !== 0) i += b[i] + 1;
    return i + 1;
}

// The frames of a GIF, each { x, y, w, h, palette, transparent, disposal, interlaced, data: [start, end] }.
function gifFrames(b) {
    const width = u16le(b, 6);
    const height = u16le(b, 8);
    const packed = b[10];
    let i = 13;
    let global = null;
    if (packed & 0x80) {
        const size = 3 << ((packed & 7) + 1);
        global = b.subarray(i, i + size);
        i += size;
    }
    const frames = [];
    let gce = { transparent: -1, disposal: 0 };
    while (i < b.length) {
        const block = b[i++];
        if (block === 0x3b) break;
        if (block === 0x21) {
            const label = b[i++];
            if (label === 0xf9 && b[i] >= 4) {
                const p = b[i + 1];
                gce = { transparent: p & 1 ? b[i + 4] : -1, disposal: (p >> 2) & 7 };
            }
            i = skipSubBlocks(b, i);
            continue;
        }
        if (block !== 0x2c) break;
        const frame = { x: u16le(b, i), y: u16le(b, i + 2), w: u16le(b, i + 4), h: u16le(b, i + 6), ...gce };
        const p = b[i + 8];
        i += 9;
        frame.interlaced = (p & 0x40) !== 0;
        frame.palette = global;
        if (p & 0x80) {
            const size = 3 << ((p & 7) + 1);
            frame.palette = b.subarray(i, i + size);
            i += size;
        }
        frame.minCode = b[i++];
        const start = i;
        i = skipSubBlocks(b, i);
        frame.data = [start, i];
        frames.push(frame);
        gce = { transparent: -1, disposal: 0 };
    }
    return { width, height, frames };
}

// Colour indices of one frame (LZW), in row order even when the frame is interlaced.
function decodeFrame(b, frame) {
    const pixels = frame.w * frame.h;
    const out = new Uint8Array(pixels);
    const minCode = Math.min(Math.max(frame.minCode, 2), 11);
    const clear = 1 << minCode;
    const end = clear + 1;
    const prefix = new Int16Array(4096);
    const suffix = new Uint8Array(4096);
    const first = new Uint8Array(4096);
    const stack = new Uint8Array(4097);
    for (let c = 0; c < clear; c++) {
        prefix[c] = -1;
        suffix[c] = c;
        first[c] = c;
    }
    let size = minCode + 1;
    let next = end + 1;
    let old = -1;
    let bits = 0;
    let datum = 0;
    let n = 0;
    let [i, stop] = frame.data;
    let left = 0;
    while (n < pixels) {
        while (bits < size) {
            if (left === 0) {
                if (i >= stop || b[i] === 0) return finishInterlace(out, frame);
                left = b[i++];
            }
            datum |= b[i++] << bits;
            bits += 8;
            left--;
        }
        const code = datum & ((1 << size) - 1);
        datum >>>= size;
        bits -= size;
        if (code === clear) {
            size = minCode + 1;
            next = end + 1;
            old = -1;
            continue;
        }
        if (code === end) break;
        let top = 0;
        let c = code;
        if (old === -1) {
            if (code >= next) break;
            out[n++] = suffix[code];
            old = code;
            continue;
        }
        if (code >= next) {
            stack[top++] = first[old];
            c = old;
        }
        while (c >= clear) {
            stack[top++] = suffix[c];
            c = prefix[c];
            if (top > 4096) return finishInterlace(out, frame);
        }
        stack[top++] = suffix[c];
        if (next < 4096) {
            prefix[next] = old;
            suffix[next] = suffix[c];
            first[next] = first[old];
            next++;
            if (next === 1 << size && size < 12) size++;
        }
        while (top > 0 && n < pixels) out[n++] = stack[--top];
        old = code;
    }
    return finishInterlace(out, frame);
}

function finishInterlace(out, frame) {
    if (!frame.interlaced) return out;
    const rows = new Uint8Array(out.length);
    let row = 0;
    for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
        for (let y = start; y < frame.h; y += step, row++) rows.set(out.subarray(row * frame.w, (row + 1) * frame.w), y * frame.w);
    }
    return rows;
}

// Box-filters an RGBA canvas into an RGB cell of a grid, over grey where it is see-through.
function drawCell(rgba, width, height, grid, gridW, cx, cy, cw, ch) {
    for (let y = 0; y < ch; y++) {
        const y0 = Math.floor(y * height / ch);
        const y1 = Math.max(y0 + 1, Math.floor((y + 1) * height / ch));
        for (let x = 0; x < cw; x++) {
            const x0 = Math.floor(x * width / cw);
            const x1 = Math.max(x0 + 1, Math.floor((x + 1) * width / cw));
            let r = 0, g = 0, bl = 0, n = 0;
            for (let sy = y0; sy < y1; sy++) {
                for (let sx = x0; sx < x1; sx++) {
                    const p = (sy * width + sx) * 4;
                    const a = rgba[p + 3] / 255;
                    r += rgba[p] * a + 128 * (1 - a);
                    g += rgba[p + 1] * a + 128 * (1 - a);
                    bl += rgba[p + 2] * a + 128 * (1 - a);
                    n++;
                }
            }
            const q = ((cy + y) * gridW + cx + x) * 3;
            grid[q] = r / n;
            grid[q + 1] = g / n;
            grid[q + 2] = bl / n;
        }
    }
}

// Composites the GIF and returns up to GIF_SAMPLES evenly spaced frames, packed four to a grid,
// as RGB images { w, h, rgb }, plus the middle one of them larger (`read`) for reading its text.
// Throws if the GIF is too big to decode.
export function gifSamples(bytes) {
    const { width, height, frames } = gifFrames(bytes);
    if (!frames.length || width * height > GIF_MAX_CANVAS) throw new Error("too big");
    const count = Math.min(GIF_SAMPLES, frames.length);
    const wanted = new Set();
    for (let k = 0; k < count; k++) wanted.add(count === 1 ? 0 : Math.round(k * (frames.length - 1) / (count - 1)));
    const readAt = [...wanted][Math.floor(wanted.size / 2)];
    const readScale = Math.min(1, READ_SIDE / Math.max(width, height));
    const read = { w: Math.max(1, Math.round(width * readScale)), h: Math.max(1, Math.round(height * readScale)) };
    read.rgb = new Uint8Array(read.w * read.h * 3);
    const last = Math.max(...wanted);
    let work = 0;
    for (let f = 0; f <= last; f++) work += frames[f].w * frames[f].h;
    if (work > GIF_MAX_WORK) throw new Error("too big");

    const scale = Math.min(1, CELL / Math.max(width, height));
    const cw = Math.max(1, Math.round(width * scale));
    const ch = Math.max(1, Math.round(height * scale));
    const per = count === 1 ? 1 : 4;
    const images = [];
    let current = null;
    let slot = 0;
    const canvas = new Uint8Array(width * height * 4);
    for (let f = 0; f <= last; f++) {
        const frame = frames[f];
        const saved = frame.disposal === 3 ? canvas.slice() : null;
        const indices = decodeFrame(bytes, frame);
        const pal = frame.palette;
        if (pal) {
            for (let y = 0; y < frame.h; y++) {
                const cy = frame.y + y;
                if (cy >= height) break;
                for (let x = 0; x < frame.w; x++) {
                    const cx = frame.x + x;
                    if (cx >= width) break;
                    const index = indices[y * frame.w + x];
                    if (index === frame.transparent || index * 3 + 2 >= pal.length) continue;
                    const p = (cy * width + cx) * 4;
                    canvas[p] = pal[index * 3];
                    canvas[p + 1] = pal[index * 3 + 1];
                    canvas[p + 2] = pal[index * 3 + 2];
                    canvas[p + 3] = 255;
                }
            }
        }
        if (wanted.has(f)) {
            if (!current) {
                const cols = per === 1 ? 1 : 2;
                const rows = per === 1 ? 1 : 2;
                current = { w: cw * cols, h: ch * rows, rgb: new Uint8Array(cw * cols * ch * rows * 3).fill(128) };
                images.push(current);
                slot = 0;
            }
            drawCell(canvas, width, height, current.rgb, current.w, (slot % 2) * cw, Math.floor(slot / 2) * ch, cw, ch);
            if (++slot === per) current = null;
        }
        if (f === readAt) drawCell(canvas, width, height, read.rgb, read.w, 0, 0, read.w, read.h);
        if (frame.disposal === 2) {
            for (let y = frame.y; y < Math.min(height, frame.y + frame.h); y++) {
                canvas.fill(0, (y * width + frame.x) * 4, (y * width + Math.min(width, frame.x + frame.w)) * 4);
            }
        } else if (saved) {
            canvas.set(saved);
        }
    }
    return { images, read, frames: frames.length, sampled: count };
}

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(parts) {
    let c = 0xffffffff;
    for (const part of parts) for (let i = 0; i < part.length; i++) c = CRC_TABLE[(c ^ part[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(kind, data) {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    const name = new TextEncoder().encode(kind);
    out.set(name, 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32([name, data]));
    return out;
}

async function zlib(data) {
    const stream = new Blob([data]).stream().pipeThrough(new CompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodePng({ w, h, rgb }) {
    const raw = new Uint8Array((w * 3 + 1) * h);
    for (let y = 0; y < h; y++) raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1);
    const ihdr = new Uint8Array(13);
    const view = new DataView(ihdr.buffer);
    view.setUint32(0, w);
    view.setUint32(4, h);
    ihdr.set([8, 2, 0, 0, 0], 8);
    const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", ihdr), pngChunk("IDAT", await zlib(raw)), pngChunk("IEND", new Uint8Array(0))];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}

function base64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
}

// What the models are shown for an upload: the file itself, or a GIF's sampled frames (`images`
// for Clef) and its middle sample (`read`, a data URI for Moondream).
export async function checkImages(bytes, info) {
    if (info.type !== "image/gif") {
        const data = base64(bytes);
        return { images: [{ content_type: info.type, base64: data }], read: "data:" + info.type + ";base64," + data, grid: false };
    }
    const { images, read, sampled } = gifSamples(bytes);
    const out = [];
    for (const image of images) out.push({ content_type: "image/png", base64: base64(await encodePng(image)) });
    return { images: out, read: "data:image/png;base64," + base64(await encodePng(read)), grid: sampled > 1 };
}

async function judge(ai, images, grid) {
    const state = "An image a player wants to post in the public chat of a racing game that children play."
        + (grid ? " It is an animated GIF: each image is a grid of frames sampled from it, so judge every frame." : "");
    const answers = (await ai.run(CHECK_MODEL, { model: "clef-flash", state, questions: QUESTIONS, images }))?.answers;
    if (!answers) throw new Error("no answer");
    let worst = null;
    for (const id of Object.keys(QUESTIONS)) {
        const p = answers[id]?.noul;
        if (typeof p !== "number") throw new Error("no answer");
        if (p >= REFUSE_AT && (!worst || p > worst.p)) worst = { id, p };
    }
    return worst ? REASONS[worst.id] : null;
}

async function readText(ai, image) {
    const result = await ai.run(READ_MODEL, {
        task: "query",
        image,
        question: "Transcribe every word of text in this image exactly as written, including captions, signs and watermarks. If there is no text, answer NONE.",
        reasoning: false,
        temperature: 0,
        max_tokens: 200,
        stream: false,
    });
    const answer = result?.result?.answer ?? result?.answer;
    if (typeof answer !== "string") throw new Error("no answer");
    return answer;
}

// { ok: true } or { ok: false, why }. Throws if a model can't be reached, so the caller refuses
// the upload instead of letting it through unchecked.
export async function moderate(ai, bytes, info) {
    const { images, read, grid } = await checkImages(bytes, info);
    const [why, text] = await Promise.all([judge(ai, images, grid), readText(ai, read)]);
    if (why) return { ok: false, why, text };
    if (findSlurs(text).length) return { ok: false, why: "a slur", text };
    return { ok: true, text };
}
