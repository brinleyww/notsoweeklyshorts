// Why a run's inputs look machine-made, for the owner to review. Nothing is hidden or refused because of these.
const FAST_PRESS_MS = 10;
const FAST_PRESSES = 3;
const KEYS_PER_SECOND = 15;
const SAME_LENGTH_SHARE = 0.4;
const MIN_PRESSES = 20;
// up, right, down, left, reset, then the seven Rocket League keys. The physics version channel comes after.
const KEY_CHANNELS = 12;
// Royale tracks press reset for a few ms on every run, so it says nothing about the player.
const RESET_CHANNEL = 4;

async function inflate(recording) {
    const binary = atob(recording.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

function readKeys(raw) {
    const keys = [];
    let at = 0;
    while (keys.length < KEY_CHANNELS && at + 3 <= raw.length) {
        const count = raw[at] | raw[at + 1] << 8 | raw[at + 2] << 16;
        if (at + 3 + 3 * count > raw.length) throw new Error("recording cut short");
        const toggles = new Array(count);
        let frame = 0;
        for (let i = 0; i < count; i++) {
            const p = at + 3 + 3 * i;
            frame += raw[p] | raw[p + 1] << 8 | raw[p + 2] << 16;
            toggles[i] = frame;
        }
        keys.push(toggles);
        at += 3 + 3 * count;
    }
    return keys;
}

export function flagsFromKeys(keys, frames, effort = {}) {
    const lengths = [];
    let changes = 0;
    keys.forEach((toggles, channel) => {
        if (channel === RESET_CHANNEL) return;
        changes += toggles.length;
        for (let i = 0; i + 1 < toggles.length; i += 2) lengths.push(toggles[i + 1] - toggles[i]);
    });
    const counts = new Map();
    let top = 0;
    let topLength = 0;
    let fast = 0;
    for (const n of lengths) {
        if (n < FAST_PRESS_MS) fast++;
        const c = (counts.get(n) || 0) + 1;
        counts.set(n, c);
        if (c > top) {
            top = c;
            topLength = n;
        }
    }
    const flags = {};
    const perSecond = changes / Math.max(frames / 1000, 0.001);
    if (fast >= FAST_PRESSES) flags.fast = fast;
    if (perSecond > KEYS_PER_SECOND) flags.rate = Math.round(perSecond * 10) / 10;
    if (lengths.length >= MIN_PRESSES && top / lengths.length >= SAME_LENGTH_SHARE) {
        flags.same = Math.round(top / lengths.length * 100);
        flags.len = topLength;
    }
    if (effort.drivenMs != null && effort.drivenMs < frames) flags.driven = effort.drivenMs;
    else if (effort.tries === 0) flags.tries = 0;
    return Object.keys(flags).length ? JSON.stringify(flags) : "";
}

// "" = nothing stands out. Otherwise JSON holding only the rules the run set off.
export async function inputFlags(recording, frames, effort) {
    return flagsFromKeys(readKeys(await inflate(recording)), frames, effort);
}
