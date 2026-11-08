// Feedback players send to the owner from the main menu: up to 200 words and a few images or videos.
// One instance ("global"). Only the owner reads it, through the admin routes in worker.js.

import { DurableObject } from "cloudflare:workers";

export const MAX_WORDS = 200;
export const MAX_FEEDBACK_CHARS = 2400;
export const MAX_FEEDBACK_FILES = 3;
// "Under 10 MB" as the page shows sizes (MB = 1024 * 1024).
export const MAX_FEEDBACK_FILE = 10 * 1024 * 1024 - 1;
export const MAX_FEEDBACK_BODY = MAX_FEEDBACK_FILES * MAX_FEEDBACK_FILE + 16384;
const MAX_NAME = 100;
const MAX_NICK = 32;
export const GAP_MS = 30 * 60_000;
// A whole school can share one address, so it gets a few more than one account does.
const PER_ADDRESS = 3;
const PER_DAY = 300;
// SQLite refuses values over 2 MB.
const PART = 1_000_000;
// The free plan has 5 GB of Durable Object storage for everything.
const MAX_STORED = 1_000_000_000;
const LIST_PAGE = 30;
const ID = /^[0-9A-Za-z]{12}$/;
const FILE_ID = /^[0-9A-Za-z]{12}-[0-2]$/;

export function wordCount(text) {
    return (String(text).trim().match(/\S+/g) ?? []).length;
}

// Keeps line breaks, unlike the chat's cleanText.
export function cleanFeedback(value) {
    if (typeof value !== "string") return "";
    return value.normalize("NFC")
        .replace(/\r\n?/g, "\n")
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200c\u200e-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g, "")
        .replace(/(\p{M}{2})\p{M}+/gu, "$1")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function ascii(b, at, n) {
    return String.fromCharCode(...b.subarray(at, at + n));
}

// What an attachment is, from its bytes, or null if it isn't an image or video.
export function mediaType(b) {
    if (b.length < 12) return null;
    if (b[0] === 0x89 && ascii(b, 1, 3) === "PNG") return "image/png";
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
    if (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a") return "image/gif";
    if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "image/webp";
    if (ascii(b, 4, 4) === "ftyp") {
        const brand = ascii(b, 8, 4);
        if (/^avi[fs]$/.test(brand)) return "image/avif";
        if (/^(heic|heix|mif1|msf1)$/.test(brand)) return "image/heic";
        if (brand === "qt  ") return "video/quicktime";
        if (/^M4[AB] /.test(brand)) return null;
        return "video/mp4";
    }
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
    return null;
}

// The upload body: a 4-byte big-endian header length, the header JSON, then each file's bytes in order.
export function readFeedbackBody(buffer) {
    const all = new Uint8Array(buffer);
    if (all.length < 4) return null;
    const headLength = new DataView(buffer).getUint32(0);
    if (headLength > 16000 || 4 + headLength > all.length) return null;
    let head;
    try {
        head = JSON.parse(new TextDecoder().decode(all.subarray(4, 4 + headLength)));
    } catch {
        return null;
    }
    if (!head || typeof head !== "object") return null;
    const sizes = Array.isArray(head.files) ? head.files.map((f) => f?.size) : [];
    if (sizes.length > MAX_FEEDBACK_FILES || !sizes.every((n) => Number.isSafeInteger(n) && n > 0)) return { head, error: "Bad request." };
    let at = 4 + headLength;
    const files = [];
    for (let i = 0; i < sizes.length; i++) {
        if (sizes[i] > MAX_FEEDBACK_FILE) return { head, error: "Each file has to be under 10 MB." };
        if (at + sizes[i] > all.length) return { head, error: "Bad request." };
        files.push({ name: String(head.files[i]?.name ?? "").replace(/^.*[\\/]/, "").slice(0, MAX_NAME), bytes: all.subarray(at, at + sizes[i]) });
        at += sizes[i];
    }
    if (at !== all.length) return { head, error: "Bad request." };
    return { head, files };
}

function randomId() {
    const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    const limit = 256 - (256 % alphabet.length);
    let out = "";
    while (out.length < 12) {
        for (const b of crypto.getRandomValues(new Uint8Array(16))) if (b < limit && out.length < 12) out += alphabet[b % alphabet.length];
    }
    return out;
}

const fail = (status, error, extra) => ({ status, error, ...extra });

function waitText(ms) {
    const mins = Math.max(1, Math.ceil(ms / 60_000));
    return `You can send feedback once every 30 minutes. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`;
}

export class Feedback extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.sql = ctx.storage.sql;
        this.sql.exec(`CREATE TABLE IF NOT EXISTS feedback (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, ip TEXT NOT NULL, nickname TEXT NOT NULL,
            text TEXT NOT NULL, client TEXT NOT NULL, created INTEGER NOT NULL, seen INTEGER NOT NULL DEFAULT 0, files TEXT NOT NULL, size INTEGER NOT NULL)`);
        this.sql.exec("CREATE INDEX IF NOT EXISTS feedback_created ON feedback(created)");
        this.sql.exec("CREATE INDEX IF NOT EXISTS feedback_unseen ON feedback(seen, created)");
        this.sql.exec("CREATE TABLE IF NOT EXISTS parts (fid TEXT NOT NULL, part INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (fid, part))");
        // When each account / browser / address last sent, for the 30-minute gap. Rows older than a day are dropped.
        this.sql.exec("CREATE TABLE IF NOT EXISTS senders (key TEXT PRIMARY KEY, at INTEGER NOT NULL, n INTEGER NOT NULL)");
        this.sql.exec("CREATE INDEX IF NOT EXISTS senders_at ON senders(at)");
        // Running totals, so nothing has to add up the whole table: "bytes" stored, "day:<n>" sent that UTC day.
        this.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL)");
    }

    first(query, ...args) {
        return this.sql.exec(query, ...args).toArray()[0] ?? null;
    }

    meta(k) {
        return this.first("SELECT v FROM meta WHERE k = ?", k)?.v ?? 0;
    }

    bump(k, by) {
        this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = v + ?", k, by, by);
    }

    // ms until this sender may send again (0 = now). An address may send PER_ADDRESS within one gap.
    waitFor(keys, now) {
        let wait = 0;
        for (const [key, max] of keys) {
            const row = this.first("SELECT at, n FROM senders WHERE key = ?", key);
            if (!row || now - row.at >= GAP_MS) continue;
            if (row.n >= max) wait = Math.max(wait, row.at + GAP_MS - now);
        }
        return wait;
    }

    async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/send") {
            const result = await this.send(request);
            return Response.json(result, { status: result.error ? result.status || 400 : 200 });
        }
        const m = /^\/file\/([0-9A-Za-z]{12}-[0-2])$/.exec(url.pathname);
        if (m) return this.file(m[1]);
        return new Response("Not found", { status: 404 });
    }

    async send(request) {
        const userId = request.headers.get("X-User") || "";
        const ip = request.headers.get("X-Ip") || "";
        const visitor = request.headers.get("X-Visitor") || "";
        const client = (request.headers.get("X-Client") || "").slice(0, 120);
        const read = readFeedbackBody(await request.arrayBuffer());
        if (!read) return fail(400, "Bad request.");
        if (read.error) return fail(400, read.error);
        const text = cleanFeedback(read.head.text);
        if (!text && !read.files.length) return fail(400, "Write something first.");
        if (wordCount(text) > MAX_WORDS) return fail(400, `Feedback can be up to ${MAX_WORDS} words.`);
        if (text.length > MAX_FEEDBACK_CHARS) return fail(400, "That's too long.");
        const nickname = cleanFeedback(String(read.head.nickname ?? "")).replace(/\s+/g, " ").slice(0, MAX_NICK) || "Player";

        const now = Date.now();
        const keys = [["u:" + userId, 1], ["i:" + ip, PER_ADDRESS]];
        if (/^[0-9a-f]{32}$/.test(visitor)) keys.push(["v:" + visitor, 1]);
        const wait = request.headers.get("X-Owner") ? 0 : this.waitFor(keys, now);
        if (wait) return fail(429, waitText(wait), { wait });
        const day = Math.floor(now / 86_400_000);
        if (this.meta("day:" + day) >= PER_DAY) return fail(429, "The feedback box is full for today. Try again tomorrow.");

        const files = [];
        let size = 0;
        for (const f of read.files) {
            const type = mediaType(f.bytes);
            if (!type) return fail(400, `${f.name || "That file"} isn't an image or a video.`);
            files.push({ type, size: f.bytes.length, name: f.name });
            size += f.bytes.length;
        }
        if (size && this.meta("bytes") + size > MAX_STORED) return fail(507, "The feedback box has no room for files right now. Send it without them.");

        const id = randomId();
        this.ctx.storage.transactionSync(() => {
            read.files.forEach((f, i) => {
                for (let at = 0, part = 0; at < f.bytes.length; at += PART, part++) {
                    this.sql.exec("INSERT INTO parts (fid, part, data) VALUES (?, ?, ?)", id + "-" + i, part, f.bytes.slice(at, at + PART).buffer);
                }
            });
            this.sql.exec("INSERT INTO feedback (id, user_id, ip, nickname, text, client, created, files, size) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                id, userId, ip, nickname, text, client, now, JSON.stringify(files), size);
            for (const [key] of keys) {
                this.sql.exec(`INSERT INTO senders (key, at, n) VALUES (?, ?, 1) ON CONFLICT (key) DO UPDATE SET
                    n = CASE WHEN ? - at >= ? THEN 1 ELSE n + 1 END, at = CASE WHEN ? - at >= ? THEN ? ELSE at END`, key, now, now, GAP_MS, now, GAP_MS, now);
            }
            if (size) this.bump("bytes", size);
            if (this.meta("day:" + day) === 0) this.sql.exec("DELETE FROM meta WHERE k LIKE 'day:%'");
            this.bump("day:" + day, 1);
            this.sql.exec("DELETE FROM senders WHERE at < ?", now - 86_400_000);
        });
        return { ok: true, next: now + GAP_MS };
    }

    list({ before }) {
        const rows = Number.isSafeInteger(before)
            ? this.sql.exec("SELECT * FROM feedback WHERE created < ? ORDER BY created DESC LIMIT ?", before, LIST_PAGE + 1).toArray()
            : this.sql.exec("SELECT * FROM feedback ORDER BY created DESC LIMIT ?", LIST_PAGE + 1).toArray();
        const more = rows.length > LIST_PAGE;
        const items = rows.slice(0, LIST_PAGE).map((r) => ({
            id: r.id,
            nickname: r.nickname,
            userId12: r.user_id.slice(0, 12),
            address: r.ip.slice(0, 8),
            text: r.text,
            client: r.client,
            created: r.created,
            seen: !!r.seen,
            files: JSON.parse(r.files).map((f, i) => ({ ...f, fid: r.id + "-" + i })),
        }));
        const unseen = items.filter((i) => !i.seen).map((i) => i.id);
        for (const id of unseen) this.sql.exec("UPDATE feedback SET seen = 1 WHERE id = ?", id);
        return { items, more, unseen: this.unseen().unseen, stored: this.meta("bytes") };
    }

    unseen() {
        return { unseen: this.first("SELECT COUNT(*) AS n FROM feedback WHERE seen = 0").n };
    }

    file(fid) {
        if (!FILE_ID.test(fid)) return new Response("Not found", { status: 404 });
        const row = this.first("SELECT files FROM feedback WHERE id = ?", fid.slice(0, 12));
        const info = row ? JSON.parse(row.files)[Number(fid.slice(13))] : null;
        if (!info) return new Response("Not found", { status: 404 });
        const parts = this.sql.exec("SELECT data FROM parts WHERE fid = ? ORDER BY part", fid).toArray();
        const out = new Uint8Array(info.size);
        let at = 0;
        for (const p of parts) {
            const chunk = new Uint8Array(p.data);
            out.set(chunk, at);
            at += chunk.length;
        }
        return new Response(out, { headers: { "Content-Type": info.type } });
    }

    remove({ id }) {
        if (!ID.test(id ?? "")) return fail(404, "That feedback was already deleted.");
        const row = this.first("SELECT size FROM feedback WHERE id = ?", id);
        if (!row) return fail(404, "That feedback was already deleted.");
        this.ctx.storage.transactionSync(() => {
            for (let i = 0; i < MAX_FEEDBACK_FILES; i++) this.sql.exec("DELETE FROM parts WHERE fid = ?", id + "-" + i);
            this.sql.exec("DELETE FROM feedback WHERE id = ?", id);
            if (row.size) this.bump("bytes", -row.size);
        });
        return { ok: true };
    }
}
