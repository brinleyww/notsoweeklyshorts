// The picture and the words on a shared cup link (worker.js /c/<code>). Chat apps read the link's
// meta tags, so everything they show is drawn and written on this side: the cup's name, who is
// organizing it, what it is doing and which tracks it draws from.
//
// The card is drawn by hand in the game's own font (src/cupfont.js, straight segments only) in the
// colours of images/og.png, because a Worker has no canvas. Rendering runs inside the cup's Durable
// Object (lobby.js), which has the CPU time for it; the Worker only passes the bytes on.

import { FONT, FONT_UNITS } from "./cupfont.js";
import { encodePng } from "./chatmedia.js";

export const CARD_W = 1200;
export const CARD_H = 630;

// What the site calls each phase and each format (competitions/src/ui/hub.ts, rules.ts).
// A format added to the site later falls back to its id.
const PHASES = { setup: "In the lobby", racing: "Racing", break: "Between rounds", done: "Finished" };
const FORMATS = {
    quickplay: "Quickplay",
    sprint: "Sprint",
    championship: "Championship",
    formula: "Formula",
    draft: "Pick & Ban",
    knockout: "Knockout",
    timeattack: "Time Attack",
    bumper: "Bumper Cars",
};

// og-card.html, which renders images/og.png.
const TOP = 0x28346a, MID = 0x212b58, BOTTOM = 0x192042, DEEP = 0x112052;
const GOLD = 0xffc94a, PALE = 0xe6ebff, BLUE = 0xb3c1ff, WHITE = 0xffffff;
const SLANT = 0.21; // the italic the site's headings are set in
const SUB = 4; // sub-scanlines per row, for smooth edges

// ---- the font ----

let glyphs = null;

function font() {
    if (glyphs) return glyphs;
    glyphs = new Map();
    for (const line of FONT.split("\n")) {
        const first = line.indexOf("\t");
        const second = line.indexOf("\t", first + 1);
        if (first < 0 || second < 0) continue;
        glyphs.set(line.slice(0, first), { advance: Number(line.slice(first + 1, second)), path: line.slice(second + 1), shape: null });
    }
    return glyphs;
}

const glyph = (ch) => font().get(ch) ?? null;

// A glyph as closed contours of font units, each a flat run of x, y corners.
function shape(g) {
    if (g.shape) return g.shape;
    const out = [];
    const parts = g.path.split(" ");
    let at = null;
    for (let i = 0; i < parts.length; ) {
        const op = parts[i++];
        if (op === "m") {
            at = [Number(parts[i++]), Number(parts[i++])];
            out.push(at);
        } else if (op === "l" && at) {
            at.push(Number(parts[i++]), Number(parts[i++]));
        }
    }
    g.shape = out;
    return out;
}

function textWidth(text, size) {
    const scale = size / FONT_UNITS;
    let width = 0;
    for (const ch of text) width += (glyph(ch)?.advance ?? 0) * scale;
    return width;
}

// What is left of a name once the characters this font has no shape for are dropped. Null when too
// little of it survives to be worth drawing (an emoji or Japanese cup name, say).
function drawable(text) {
    let kept = "", dropped = 0;
    for (const ch of String(text ?? "")) {
        if (glyph(ch)) kept += ch;
        else if (ch.trim()) dropped++;
    }
    kept = kept.replace(/\s+/g, " ").trim();
    return kept && dropped <= [...kept].length ? kept : null;
}

// The largest size at or under `size` that fits, then an ellipsis if even `min` is too wide.
function fit(text, size, min, width) {
    let at = size;
    while (at > min && textWidth(text, at) > width) at -= 2;
    if (textWidth(text, at) <= width) return { text, size: at };
    let cut = text;
    while (cut.length > 1 && textWidth(cut + "…", at) > width) cut = cut.slice(0, -1);
    return { text: cut + "…", size: at };
}

// ---- drawing ----

const mix = (a, b, k) => Math.round(a + (b - a) * k);

function edge(edges, a, b) {
    if (a[1] === b[1]) return;
    const up = a[1] < b[1];
    edges.push({ x0: up ? a[0] : b[0], y0: up ? a[1] : b[1], x1: up ? b[0] : a[0], y1: up ? b[1] : a[1], dir: up ? 1 : -1 });
}

// A leaning box, like the site's buttons and pills (clip-path takes 8px off the top left).
const leaning = (x, y, w, h, cut) => [[x + cut, y], [x + w, y], [x + w - cut, y + h], [x, y + h]];
// A panel with its bottom right corner cut off, like the site's windows.
const cutCorner = (x, y, w, h, cut) => [[x, y], [x + w, y], [x + w - cut, y + h], [x, y + h]];

class Canvas {
    constructor(w, h) {
        this.w = w;
        this.h = h;
        this.rgb = new Uint8Array(w * h * 3);
        this.cover = new Float32Array(w);
    }

    // A vertical gradient through the stops, each [position 0 to 1, colour].
    gradient(stops) {
        for (let y = 0; y < this.h; y++) {
            const t = y / (this.h - 1);
            let i = 1;
            while (i < stops.length - 1 && stops[i][0] < t) i++;
            const [p0, c0] = stops[i - 1], [p1, c1] = stops[i];
            const k = p1 > p0 ? (t - p0) / (p1 - p0) : 0;
            const r = mix(c0 >> 16, c1 >> 16, k), g = mix((c0 >> 8) & 255, (c1 >> 8) & 255, k), b = mix(c0 & 255, c1 & 255, k);
            for (let x = 0, at = y * this.w * 3; x < this.w; x++) {
                this.rgb[at++] = r;
                this.rgb[at++] = g;
                this.rgb[at++] = b;
            }
        }
    }

    rect(x, y, w, h, color, alpha = 1) {
        const x0 = Math.max(0, Math.round(x)), x1 = Math.min(this.w, Math.round(x + w));
        const y0 = Math.max(0, Math.round(y)), y1 = Math.min(this.h, Math.round(y + h));
        for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) this.blend(py * this.w + px, color, alpha);
    }

    // The squares along the top of the site's cards.
    checker(x, y, w, h, size) {
        for (let py = 0; py < h; py += size) {
            for (let px = 0; px < w; px += size) {
                const on = (Math.floor(px / size) + Math.floor(py / size)) % 2 === 0;
                this.rect(x + px, y + py, Math.min(size, w - px), Math.min(size, h - py), on ? WHITE : DEEP, 0.9);
            }
        }
    }

    // A closed polygon of [x, y] corners: the slanted boxes the site cuts with clip-path.
    poly(points, color, alpha = 1) {
        const edges = [];
        for (let i = 0; i < points.length; i++) edge(edges, points[i], points[(i + 1) % points.length]);
        this.fill(edges, color, alpha);
    }

    text(text, x, baseline, size, color, { slant = SLANT, shadow = false, alpha = 1 } = {}) {
        const scale = size / FONT_UNITS;
        const edges = [];
        let pen = x;
        for (const ch of text) {
            const g = glyph(ch);
            if (!g) continue;
            for (const contour of shape(g)) {
                for (let i = 0; i < contour.length; i += 2) {
                    const j = (i + 2) % contour.length;
                    edge(
                        edges,
                        [pen + contour[i] * scale + slant * contour[i + 1] * scale, baseline - contour[i + 1] * scale],
                        [pen + contour[j] * scale + slant * contour[j + 1] * scale, baseline - contour[j + 1] * scale],
                    );
                }
            }
            pen += g.advance * scale;
        }
        if (shadow) this.fill(edges, DEEP, alpha, 3);
        this.fill(edges, color, alpha);
        return pen - x;
    }

    // Scanline fill, non-zero winding, SUB samples a row for smooth edges. `dy` drops the whole
    // shape down the card, which is how the site's text shadow is drawn.
    fill(edges, color, alpha, dy = 0) {
        if (!edges.length) return;
        let top = Infinity, bottom = -Infinity, left = Infinity, right = -Infinity;
        for (const e of edges) {
            top = Math.min(top, e.y0);
            bottom = Math.max(bottom, e.y1);
            left = Math.min(left, e.x0, e.x1);
            right = Math.max(right, e.x0, e.x1);
        }
        const y0 = Math.max(0, Math.floor(top + dy)), y1 = Math.min(this.h - 1, Math.ceil(bottom + dy));
        const x0 = Math.max(0, Math.floor(left)), x1 = Math.min(this.w - 1, Math.ceil(right));
        if (y1 < y0 || x1 < x0) return;
        // A whole line of text is filled in one pass, so every edge can cross the same scanline.
        const xs = new Float64Array(edges.length), dirs = new Int8Array(edges.length);
        for (let py = y0; py <= y1; py++) {
            this.cover.fill(0, x0, x1 + 1);
            for (let s = 0; s < SUB; s++) {
                const y = py - dy + (s + 0.5) / SUB;
                let n = 0;
                for (const e of edges) {
                    if (y < e.y0 || y >= e.y1) continue;
                    const x = e.x0 + (y - e.y0) * (e.x1 - e.x0) / (e.y1 - e.y0);
                    let i = n++;
                    for (; i > 0 && xs[i - 1] > x; i--) {
                        xs[i] = xs[i - 1];
                        dirs[i] = dirs[i - 1];
                    }
                    xs[i] = x;
                    dirs[i] = e.dir;
                }
                let winding = 0;
                for (let i = 0; i + 1 < n; i++) {
                    winding += dirs[i];
                    if (winding !== 0) this.span(xs[i], xs[i + 1], 1 / SUB);
                }
            }
            const row = py * this.w;
            for (let px = x0; px <= x1; px++) {
                const a = Math.min(1, this.cover[px]) * alpha;
                if (a > 0.004) this.blend(row + px, color, a);
            }
        }
    }

    span(xa, xb, amount) {
        const from = Math.max(xa, 0), to = Math.min(xb, this.w);
        if (to <= from) return;
        const first = Math.floor(from), last = Math.floor(to);
        if (first === last) {
            this.cover[first] += (to - from) * amount;
            return;
        }
        this.cover[first] += (first + 1 - from) * amount;
        for (let i = first + 1; i < last; i++) this.cover[i] += amount;
        if (last < this.w) this.cover[last] += (to - last) * amount;
    }

    blend(pixel, color, a) {
        const at = pixel * 3;
        if (a >= 1) {
            this.rgb[at] = color >> 16;
            this.rgb[at + 1] = (color >> 8) & 255;
            this.rgb[at + 2] = color & 255;
            return;
        }
        this.rgb[at] += ((color >> 16) - this.rgb[at]) * a;
        this.rgb[at + 1] += (((color >> 8) & 255) - this.rgb[at + 1]) * a;
        this.rgb[at + 2] += ((color & 255) - this.rgb[at + 2]) * a;
    }
}

// ---- what a cup link says ----

function poolLabel(pool) {
    const parts = [];
    if (pool?.shorts) {
        const weeks = [...(pool.weeks ?? [])].sort((a, b) => a - b);
        parts.push(weeks.length ? `Not So Weekly Shorts week${weeks.length > 1 ? "s" : ""} ${weeks.join(", ")}` : "Not So Weekly Shorts");
    }
    if (pool?.main?.length) parts.push(pool.main.join(", ") + " main tracks");
    if (pool?.community?.length) parts.push("Community " + pool.community.join(", "));
    return parts.join(" + ") || "No maps";
}

// The cup in words: its title, the lines under it, and the colour chat apps draw beside them.
export function describeCup(code, info) {
    if (!info) {
        return {
            name: `Cup ${code}`,
            title: `Cup ${code} has ended`,
            lines: ["This cup is not open any more.", "Open Competitions on Not So Weekly Shorts to join another one or host your own."],
            phase: "Ended",
            format: "",
            racers: null,
            maps: "",
            host: "",
            color: "#5d6a7c",
            open: false,
        };
    }
    const status = info.status ?? null;
    const format = status ? FORMATS[status.format] ?? status.format : "";
    const phase = status ? PHASES[status.phase] + (status.phase === "setup" || !status.round ? "" : ` · round ${status.round}`) : "Open";
    const racers = status ? status.racers : null;
    const name = info.name || `Cup ${code}`;
    return {
        name,
        title: name,
        lines: [
            [format, phase, racers == null ? null : `${racers} racing`].filter(Boolean).join(" · "),
            "Maps: " + poolLabel(info.pool),
            `Organized by ${info.host} · Cup code ${code}`,
        ],
        phase,
        format,
        racers,
        maps: poolLabel(info.pool),
        host: info.host,
        // The stripe beside the link: gold while a cup is racing, grey once it is over.
        color: status?.phase === "racing" ? "#ffc94a" : status?.phase === "done" ? "#5d6a7c" : "#28346a",
        open: true,
    };
}

// ---- the card ----

export async function renderCupCard(code, info, site) {
    const cup = describeCup(code, info);
    const card = new Canvas(CARD_W, CARD_H);
    card.gradient([[0, TOP], [0.58, MID], [1, BOTTOM]]);
    card.checker(0, 0, CARD_W, 14, 14);

    const kicker = card.text("CUPPA", 66, 96, 34, GOLD, { shadow: true });
    card.text(" · NOT SO WEEKLY SHORTS", 66 + kicker, 96, 34, BLUE, { shadow: true });

    // The name, as large as it fits on one line.
    const headline = fit(drawable(cup.name) ?? `Cup ${code}`, 88, 44, 1068);
    card.text(headline.text, 66, 212, headline.size, WHITE, { shadow: true });

    if (cup.open) {
        // A long nickname is cut short rather than pushing the racer count off the card.
        const racing = cup.racers == null ? "" : ` · ${cup.racers} racing`;
        const host = fit(drawable(cup.host) || "a racer", 30, 30, 1000 - textWidth("Organized by " + racing, 30));
        card.text("Organized by " + host.text + racing, 68, 262, 30, BLUE, { shadow: true });

        // The pills the site puts under a heading: what this cup plays and what it is doing. They
        // keep to the left of the code plate, however long a format or phase runs.
        let x = 66;
        for (const [label, color] of [[cup.format, GOLD], [cup.phase, PALE]]) {
            const text = label && drawable(label);
            if (!text || x + 120 > 770) continue;
            const pill = fit(text, 26, 20, 770 - x - 48);
            const width = textWidth(pill.text, pill.size) + 48;
            card.poly(leaning(x, 300, width, 54, 8), DEEP);
            card.text(pill.text, x + 26, 339, pill.size, color);
            x += width + 14;
        }

        // Below the code plate, so the track list has the whole width.
        const maps = fit(drawable(cup.maps) ?? "", 28, 22, 1068);
        card.text("MAPS", 66, 470, 24, BLUE, { shadow: true });
        card.text(maps.text, 66, 514, maps.size, PALE, { shadow: true });

        // The code, on a plate of its own.
        const px = 806, py = 292, pw = 328, ph = 178;
        card.poly(cutCorner(px + 7, py + 9, pw, ph, 18), 0x000000, 0.25);
        card.poly(cutCorner(px, py, pw, ph, 18), DEEP);
        card.rect(px, py, pw, 5, GOLD);
        card.text("CUP CODE", px + 28, py + 58, 26, GOLD);
        card.text(code, px + 28, py + 146, Math.min(76, (76 * (pw - 64)) / Math.max(1, textWidth(code, 76))), WHITE, { shadow: true });
    } else {
        card.text("This cup is not open any more.", 68, 268, 30, BLUE, { shadow: true });
        card.text("Open Competitions on the site to join another one,", 68, 330, 28, PALE, { shadow: true });
        card.text("or host a cup of your own.", 68, 374, 28, PALE, { shadow: true });
    }

    // The foot of the site's own card.
    card.rect(0, CARD_H - 62, CARD_W, 62, DEEP, 0.85);
    card.rect(0, CARD_H - 66, CARD_W, 4, GOLD);
    const address = site.replace(/^https?:\/\//, "").replace(/\/$/, "");
    card.text(address, CARD_W - 66 - textWidth(address, 26), CARD_H - 20, 26, BLUE);
    const foot = fit(cup.open ? "Open the link to take a place on the grid" : "Free in your browser", 26, 20, CARD_W - 162 - textWidth(address, 26));
    card.text(foot.text, 66, CARD_H - 20, foot.size, WHITE, { alpha: 0.85 });

    return encodePng({ w: CARD_W, h: CARD_H, rgb: card.rgb });
}
