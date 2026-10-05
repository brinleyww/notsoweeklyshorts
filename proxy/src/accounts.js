// Accounts: who holds each nickname, every account's clips, and shared clip links. One
// Durable Object ("global"). An account is the game's userId, the SHA-256 of its private
// token; the token itself is never stored.

import { DurableObject } from "cloudflare:workers";

const MAX_NICK = 100;
const MAX_CLIP_NAME = 100;
const MAX_CLIP_CODE = 300_000;
const MAX_CLIPS = 1000;
const SHARES_PER_HOUR = 30;
const SHARE_ID = /^[A-Za-z0-9]{10}$/;
const CLIP_ID = /^[0-9a-f]{16}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SHARE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
// Names that compare equal: case, width variants and spacing are ignored, so "Bob",
// "BOB" and "B o b" are one name.
const IGNORED_IN_NAMES = /[\p{Cc}\p{Cf}\p{Z}\s]/gu;
// The game's own fallback for an empty nickname, which everyone may use.
const SHARED_NAMES = new Set(["", "anonymous"]);

export function nameKey(nickname) {
    return String(nickname ?? "").normalize("NFKC").toLowerCase().replace(IGNORED_IN_NAMES, "");
}

function text(value, max) {
    return typeof value === "string" ? value.slice(0, max) : "";
}

function randomId(length, alphabet) {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

async function sha256Hex(value) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export class Accounts extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.sql = ctx.storage.sql;
        this.sql.exec(`CREATE TABLE IF NOT EXISTS names (
            name_key TEXT PRIMARY KEY, user_id TEXT NOT NULL, nickname TEXT NOT NULL, at INTEGER NOT NULL)`);
        this.sql.exec("CREATE INDEX IF NOT EXISTS names_user ON names(user_id)");
        this.sql.exec(`CREATE TABLE IF NOT EXISTS clips (
            user_id TEXT NOT NULL, id TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL,
            player TEXT NOT NULL, track TEXT NOT NULL, frames INTEGER NOT NULL, created INTEGER NOT NULL,
            code TEXT NOT NULL, PRIMARY KEY (user_id, id), UNIQUE (user_id, key))`);
        this.sql.exec(`CREATE TABLE IF NOT EXISTS shares (
            id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, at INTEGER NOT NULL, code TEXT NOT NULL)`);
        this.sql.exec("CREATE INDEX IF NOT EXISTS shares_user ON shares(user_id, at)");
    }

    holder(key) {
        return this.sql.exec("SELECT user_id FROM names WHERE name_key = ?", key).toArray()[0]?.user_id ?? null;
    }

    available(userId, nickname) {
        const key = nameKey(nickname);
        if (SHARED_NAMES.has(key)) return true;
        const holder = this.holder(key);
        return holder == null || holder === userId;
    }

    checkName(userId, nickname) {
        return { available: this.available(userId, text(nickname, MAX_NICK)) };
    }

    // Taking a new name gives up every name the account held before.
    claimName(userId, nickname) {
        nickname = text(nickname, MAX_NICK);
        if (!this.available(userId, nickname)) return { available: false };
        const key = nameKey(nickname);
        this.sql.exec("DELETE FROM names WHERE user_id = ? AND name_key != ?", userId, key);
        if (!SHARED_NAMES.has(key)) {
            this.sql.exec("INSERT OR REPLACE INTO names (name_key, user_id, nickname, at) VALUES (?, ?, ?, ?)",
                key, userId, nickname, Date.now());
        }
        return { available: true };
    }

    // Names seen in use upstream (leaderboards, profiles, uploads) are kept for whoever was
    // seen with them first, so existing players keep theirs. Nothing is given up here: a
    // board can still show a name its player has since changed.
    observeNames(list) {
        if (!Array.isArray(list)) return;
        const now = Date.now();
        for (const item of list.slice(0, 10_000)) {
            const userId = item?.userId;
            const nickname = text(item?.nickname, MAX_NICK);
            const key = nameKey(nickname);
            if (!HEX64.test(userId ?? "") || SHARED_NAMES.has(key)) continue;
            this.sql.exec("INSERT OR IGNORE INTO names (name_key, user_id, nickname, at) VALUES (?, ?, ?, ?)",
                key, userId, nickname, now);
        }
    }

    listClips(userId) {
        return this.sql.exec(
            "SELECT id, key, name, player, track, frames, created FROM clips WHERE user_id = ? ORDER BY created, id", userId,
        ).toArray().map((r) => ({
            id: r.id, key: r.key, name: r.name, playerName: r.player, trackId: r.track, frames: r.frames, createdAt: r.created,
        }));
    }

    getClip(userId, id) {
        const row = this.sql.exec("SELECT name, code FROM clips WHERE user_id = ? AND id = ?", userId, String(id)).toArray()[0];
        return row ? { name: row.name, code: row.code } : null;
    }

    // An identical recording already in the account is not stored twice.
    addClip(userId, clip) {
        const key = text(clip?.key, 64);
        const code = text(clip?.code, MAX_CLIP_CODE + 1);
        const frames = clip?.frames;
        if (!HEX64.test(key) || !code.startsWith("ClipsBrin") || code.length > MAX_CLIP_CODE) return { error: "bad" };
        if (!Number.isSafeInteger(frames) || frames < 1) return { error: "bad" };
        const existing = this.sql.exec("SELECT id FROM clips WHERE user_id = ? AND key = ?", userId, key).toArray()[0];
        if (existing) return { id: existing.id, duplicate: true };
        const count = this.sql.exec("SELECT COUNT(*) AS n FROM clips WHERE user_id = ?", userId).one().n;
        if (count >= MAX_CLIPS) return { error: "full" };
        const id = randomId(16, "0123456789abcdef");
        const created = Number.isSafeInteger(clip.createdAt) && clip.createdAt > 0 ? clip.createdAt : Date.now();
        this.sql.exec(
            "INSERT INTO clips (user_id, id, key, name, player, track, frames, created, code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            userId, id, key, text(clip.name, MAX_CLIP_NAME) || "Clip", text(clip.playerName, MAX_NICK),
            text(clip.trackId, 64), frames, created, code,
        );
        return { id, duplicate: false };
    }

    renameClip(userId, id, name) {
        name = text(name, MAX_CLIP_NAME).trim();
        if (!CLIP_ID.test(String(id)) || !name) return { ok: false };
        this.sql.exec("UPDATE clips SET name = ? WHERE user_id = ? AND id = ?", name, userId, id);
        return { ok: true };
    }

    deleteClip(userId, id) {
        this.sql.exec("DELETE FROM clips WHERE user_id = ? AND id = ?", userId, String(id));
        return { ok: true };
    }

    // A link holds its own copy of the clip, so it keeps working after the clip is renamed
    // or deleted. Sharing the same clip again gives the same link.
    async shareClip(userId, code) {
        code = text(code, MAX_CLIP_CODE + 1);
        if (!code.startsWith("ClipsBrin") || code.length > MAX_CLIP_CODE) return { error: "bad" };
        const hash = await sha256Hex(code);
        const existing = this.sql.exec("SELECT id FROM shares WHERE hash = ?", hash).toArray()[0];
        if (existing) return { id: existing.id };
        const recent = this.sql.exec("SELECT COUNT(*) AS n FROM shares WHERE user_id = ? AND at > ?",
            userId, Date.now() - 3_600_000).one().n;
        if (recent >= SHARES_PER_HOUR) return { error: "busy" };
        let id;
        do id = randomId(10, SHARE_ALPHABET);
        while (this.sql.exec("SELECT 1 FROM shares WHERE id = ?", id).toArray().length);
        this.sql.exec("INSERT INTO shares (id, hash, user_id, at, code) VALUES (?, ?, ?, ?, ?)", id, hash, userId, Date.now(), code);
        return { id };
    }

    getShare(id) {
        if (!SHARE_ID.test(String(id))) return null;
        const row = this.sql.exec("SELECT code FROM shares WHERE id = ?", id).toArray()[0];
        return row ? { code: row.code } : null;
    }
}
