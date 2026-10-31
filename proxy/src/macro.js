// Macro checks on a run's own inputs, so patching the page's detector (mod/nsws_macro.js) gets a cheater nothing.
// PROXY.md, "Macro lockout", has the numbers. More lenient than the page: a recording can't tell a keyboard from a
// controller stick shaking on its threshold, and its times can sit on a ~16.7 ms frame grid, which makes steady tapping look
// identical. A share at 24 or 30 taps catches real players on that grid.

export const MACRO_LOCK_MS = 300_000;
export const MACRO_REASONS = new Set(["speed", "click", "hold", "metronome", "replay", "script"]);

const MAX_GAP = 1000;
const NO_RELEASE = 1;
const SPEED_TAPS = 20;
const SPEED_MS = 30;
const TINY_HOLD = 5;
const TINY_HOLDS = 8;
const SAME_TAPS = 40;
const SAME_MS = 1.5;
const SAME_SHARE = 0.9;
// Far more than any real run holds; a bigger one is left to the physics check.
const MAX_BYTES = 4_000_000;

async function inflate(recording) {
    const bin = atob(recording.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate")).getReader();
    const parts = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_BYTES) {
            await reader.cancel();
            return null;
        }
        parts.push(value);
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}

// The four driving channels. Rocket League's come after, and aren't a person's taps alone.
function drivingChannels(buf) {
    const channels = [];
    let p = 0;
    for (let c = 0; c < 4 && p + 3 <= buf.length; c++) {
        const n = buf[p] | buf[p + 1] << 8 | buf[p + 2] << 16;
        p += 3;
        if (p + 3 * n > buf.length) return null;
        const times = new Array(n);
        for (let i = 0, t = 0; i < n; i++, p += 3) times[i] = t += buf[p] | buf[p + 1] << 8 | buf[p + 2] << 16;
        channels.push(times);
    }
    return channels;
}

function mean(w) {
    return w.reduce((a, b) => a + b, 0) / w.length;
}

function sameShare(w) {
    let best = 0;
    for (const c of w) {
        let n = 0;
        for (const x of w) if (Math.abs(x - c) <= SAME_MS) n++;
        if (n > best) best = n;
    }
    return best / w.length;
}

function judgeChannel(times) {
    let gaps = [];
    let tiny = 0;
    let press = null;
    let up = -1e9;
    for (let i = 0; i < times.length; i += 2) {
        const at = times[i];
        const upAt = times[i + 1];
        if (at - up > NO_RELEASE) {
            if (press != null) {
                const gap = at - press;
                if (gap > MAX_GAP) {
                    gaps = [];
                    tiny = 0;
                } else {
                    gaps.push(gap);
                    if (gaps.length > SAME_TAPS) gaps.shift();
                }
            }
            press = at;
            if (gaps.length >= SPEED_TAPS && mean(gaps.slice(-SPEED_TAPS)) < SPEED_MS) return "speed";
            if (gaps.length >= SAME_TAPS && sameShare(gaps) >= SAME_SHARE) return "metronome";
        }
        if (upAt == null) break;
        tiny = upAt - press <= TINY_HOLD ? tiny + 1 : 0;
        if (tiny >= TINY_HOLDS) return "hold";
        up = upAt;
    }
    return null;
}

// null: nothing wrong, or a recording this can't read (the physics check deals with those).
export async function macroReason(recording) {
    try {
        const buf = await inflate(recording);
        const channels = buf && drivingChannels(buf);
        for (const times of channels ?? []) {
            const reason = judgeChannel(times);
            if (reason) return reason;
        }
    } catch {
        /* not a recording */
    }
    return null;
}
