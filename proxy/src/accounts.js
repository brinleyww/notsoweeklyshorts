// Accounts: who holds each nickname, every account's clips, and shared clip links. One
// Durable Object ("global"). An account is the game's userId, the SHA-256 of its private
// token; the token itself is never stored.

import { DurableObject } from "cloudflare:workers";
import { findSlurs } from "./chatfilter.js";

const MAX_NICK = 100;
const MAX_CLIP_NAME = 100;
const MAX_CLIP_CODE = 300_000;
const MAX_CLIPS = 1000;
const SHARES_PER_HOUR = 30;
// Watching the same clip again within this long doesn't count as another view.
const VIEW_GAP_MS = 30_000;
const SHARE_ID = /^[A-Za-z0-9]{10}$/;
const CLIP_ID = /^[0-9a-f]{16}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SHARE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
// Names that compare equal: case, width variants and spacing are ignored, so "Bob",
// "BOB" and "B o b" are one name.
const IGNORED_IN_NAMES = /[\p{Cc}\p{Cf}\p{Z}\s]/gu;
// The game's own fallback for an empty nickname, which everyone may use.
const SHARED_NAMES = new Set(["", "anonymous"]);
const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const REF_CODE = /^[A-HJ-NP-Z2-9]{8}$/;
// Each account's code changes every REF_CODE_MS. A code still works for REF_GRACE_MS after the
// page's countdown reaches zero, for a friend who was halfway through typing it.
const REF_CODE_MS = 10 * 60_000;
const REF_GRACE_MS = 30_000;
// Expired codes are remembered this long, so a late friend hears "expired", not "no such code".
const REF_EXPIRED_KEEP_MS = 86_400_000;
const CHAT_UID = /^[0-9a-f]{16}$/;
// A whole school shares one address, so these only stop one person farming referrals.
const REDEEMS_PER_IP_DAY = 10;
const REDEEMS_PER_IP_REFERRER_DAY = 3;
const MAX_BONUS = 10_000;
const TOP_RECRUITERS = 5;
const SEARCH_RESULTS = 12;
// Every visit shows the top recruiters, and counting them scans every referral.
const TOP_TTL_MS = 60_000;

// Keep in step with TAGS in mod/nsws_tags.js, which draws them. "referred" belongs to anyone
// who redeemed a code, "milestone" to anyone with that many confirmed referrals, "shop" is
// bought with referral points, and "grant" only the owner hands out.
export const TAGS = {
    referred: { kind: "referred" },
    recruiter: { kind: "milestone", referrals: 5 },
    ambassador: { kind: "milestone", referrals: 15 },
    hypetrain: { kind: "milestone", referrals: 30 },
    rookie: { kind: "shop", cost: 1 },
    pitcrew: { kind: "shop", cost: 2 },
    drifter: { kind: "shop", cost: 3 },
    nitro: { kind: "shop", cost: 4 },
    ghost: { kind: "shop", cost: 5 },
    apex: { kind: "shop", cost: 6 },
    turbo: { kind: "shop", cost: 8 },
    photofinish: { kind: "shop", cost: 10 },
    legend: { kind: "shop", cost: 15 },
    spectrum: { kind: "shop", cost: 20 },
    winner: { kind: "grant" },
    sweep: { kind: "grant" },
    builder: { kind: "grant" },
    youtuber: { kind: "grant" },
    author: { kind: "grant" },
    og: { kind: "grant" },
};

function isTag(id) {
    return typeof id === "string" && Object.hasOwn(TAGS, id);
}

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
        // Views belong to the run (the clip's key), so every copy of a shared clip adds to the same count.
        this.sql.exec(`CREATE TABLE IF NOT EXISTS views (
            key TEXT NOT NULL, user_id TEXT NOT NULL, count INTEGER NOT NULL, last INTEGER NOT NULL,
            PRIMARY KEY (key, user_id))`);
        this.sql.exec(`CREATE TABLE IF NOT EXISTS ref_codes (
            user_id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, at INTEGER NOT NULL)`);
        this.sql.exec("CREATE TABLE IF NOT EXISTS ref_expired (code TEXT PRIMARY KEY, at INTEGER NOT NULL)");
        // A referral only earns its referrer a point once the new player uploads a run on an NSWS
        // track (confirmed), so a stack of empty profiles is worth nothing. ip is a hash.
        this.sql.exec(`CREATE TABLE IF NOT EXISTS referrals (
            referred TEXT PRIMARY KEY, referrer TEXT NOT NULL, at INTEGER NOT NULL, ip TEXT NOT NULL, confirmed INTEGER)`);
        this.sql.exec("CREATE INDEX IF NOT EXISTS referrals_referrer ON referrals(referrer)");
        this.sql.exec("CREATE INDEX IF NOT EXISTS referrals_ip ON referrals(ip, at)");
        this.sql.exec(`CREATE TABLE IF NOT EXISTS tag_bought (
            user_id TEXT NOT NULL, tag TEXT NOT NULL, cost INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (user_id, tag))`);
        this.sql.exec(`CREATE TABLE IF NOT EXISTS tag_grants (
            user_id TEXT NOT NULL, tag TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (user_id, tag))`);
        this.sql.exec(`CREATE TABLE IF NOT EXISTS tag_profile (
            user_id TEXT PRIMARY KEY, equipped TEXT, bonus INTEGER NOT NULL DEFAULT 0)`);
        // The chat knows a player only by the hash of their random visitor id (uid); the page
        // links it to the account so the chat can show the account's tag without its token.
        this.sql.exec("CREATE TABLE IF NOT EXISTS chat_links (uid TEXT PRIMARY KEY, user_id TEXT NOT NULL, at INTEGER NOT NULL)");
        this.sql.exec("CREATE INDEX IF NOT EXISTS chat_links_user ON chat_links(user_id)");
        this.top = null;
    }

    nicknameOf(userId) {
        return this.sql.exec("SELECT nickname FROM names WHERE user_id = ? ORDER BY at DESC LIMIT 1", userId).toArray()[0]?.nickname ?? null;
    }

    // The account's current code and when it expires; an expired one is replaced here.
    refCode(userId) {
        const now = Date.now();
        const row = this.sql.exec("SELECT code, at FROM ref_codes WHERE user_id = ?", userId).toArray()[0];
        if (row && now - row.at < REF_CODE_MS) return { code: row.code, expires: row.at + REF_CODE_MS };
        if (row) {
            this.sql.exec("INSERT OR REPLACE INTO ref_expired (code, at) VALUES (?, ?)", row.code, now);
            this.sql.exec("DELETE FROM ref_expired WHERE at < ?", now - REF_EXPIRED_KEEP_MS);
        }
        let code;
        do code = randomId(8, REF_ALPHABET);
        while (this.sql.exec("SELECT 1 FROM ref_codes WHERE code = ? UNION ALL SELECT 1 FROM ref_expired WHERE code = ?", code, code)
            .toArray().length);
        this.sql.exec("INSERT OR REPLACE INTO ref_codes (user_id, code, at) VALUES (?, ?, ?)", userId, code, now);
        return { code, expires: now + REF_CODE_MS };
    }

    referralCounts(userId) {
        const row = this.sql.exec(
            "SELECT COUNT(confirmed) AS confirmed, COUNT(*) - COUNT(confirmed) AS pending FROM referrals WHERE referrer = ?", userId,
        ).one();
        return { confirmed: row.confirmed, pending: row.pending };
    }

    tagProfile(userId) {
        return this.sql.exec("SELECT equipped, bonus FROM tag_profile WHERE user_id = ?", userId).toArray()[0] ?? { equipped: null, bonus: 0 };
    }

    // Every tag this account may wear right now.
    ownedTags(userId, counts = this.referralCounts(userId)) {
        const owned = new Set();
        if (this.sql.exec("SELECT 1 FROM referrals WHERE referred = ?", userId).toArray().length) owned.add("referred");
        for (const [id, tag] of Object.entries(TAGS)) {
            if (tag.kind === "milestone" && counts.confirmed >= tag.referrals) owned.add(id);
        }
        for (const r of this.sql.exec("SELECT tag FROM tag_bought WHERE user_id = ?", userId)) if (isTag(r.tag)) owned.add(r.tag);
        for (const r of this.sql.exec("SELECT tag FROM tag_grants WHERE user_id = ?", userId)) if (isTag(r.tag)) owned.add(r.tag);
        return owned;
    }

    topRecruiters() {
        if (this.top && Date.now() - this.top.at < TOP_TTL_MS) return this.top.list;
        const list = this.sql.exec(
            `SELECT referrer, COUNT(*) AS n, MIN(confirmed) AS first FROM referrals WHERE confirmed IS NOT NULL
            GROUP BY referrer ORDER BY n DESC, first LIMIT ?`, TOP_RECRUITERS,
        ).toArray().map((r) => ({ nickname: this.nicknameOf(r.referrer) || "Unknown", referrals: r.n }));
        this.top = { at: Date.now(), list };
        return list;
    }

    tagState(userId) {
        const counts = this.referralCounts(userId);
        const profile = this.tagProfile(userId);
        const spent = this.sql.exec("SELECT COALESCE(SUM(cost), 0) AS n FROM tag_bought WHERE user_id = ?", userId).one().n;
        const owned = this.ownedTags(userId, counts);
        const by = this.sql.exec("SELECT referrer FROM referrals WHERE referred = ?", userId).toArray()[0]?.referrer;
        const ref = this.refCode(userId);
        return {
            code: ref.code,
            codeExpires: ref.expires,
            now: Date.now(),
            codeMs: REF_CODE_MS,
            referrals: counts.confirmed,
            pending: counts.pending,
            bonus: profile.bonus,
            spent,
            points: counts.confirmed + profile.bonus - spent,
            owned: [...owned],
            equipped: profile.equipped && owned.has(profile.equipped) ? profile.equipped : null,
            referredBy: by ? { nickname: this.nicknameOf(by) || "a player" } : null,
            top: this.topRecruiters(),
        };
    }

    chatUids(userId) {
        return this.sql.exec("SELECT uid FROM chat_links WHERE user_id = ?", userId).toArray().map((r) => r.uid);
    }

    // The page calls this on every visit. linked tells the Worker the chat should re-read the tag.
    refState(userId, uid) {
        let linked = false;
        if (CHAT_UID.test(uid ?? "")) {
            const row = this.sql.exec("SELECT user_id FROM chat_links WHERE uid = ?", uid).toArray()[0];
            if (row?.user_id !== userId) {
                this.sql.exec("INSERT OR REPLACE INTO chat_links (uid, user_id, at) VALUES (?, ?, ?)", uid, userId, Date.now());
                linked = true;
            }
        }
        const state = this.tagState(userId);
        return { state, linked: linked ? { uids: [uid], tag: state.equipped } : null };
    }

    redeem(userId, code, ipHash) {
        code = String(code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
        if (!REF_CODE.test(code)) return { error: "code" };
        const row = this.sql.exec("SELECT user_id, at FROM ref_codes WHERE code = ?", code).toArray()[0];
        if (!row) {
            return this.sql.exec("SELECT 1 FROM ref_expired WHERE code = ?", code).toArray().length ? { error: "expired" } : { error: "code" };
        }
        if (Date.now() - row.at >= REF_CODE_MS + REF_GRACE_MS) return { error: "expired" };
        const referrer = row.user_id;
        if (referrer === userId) return { error: "self" };
        if (this.sql.exec("SELECT 1 FROM referrals WHERE referred = ?", userId).toArray().length) return { error: "already" };
        if (this.sql.exec("SELECT 1 FROM referrals WHERE referred = ? AND referrer = ?", referrer, userId).toArray().length) {
            return { error: "mutual" };
        }
        const dayAgo = Date.now() - 86_400_000;
        const fromIp = this.sql.exec("SELECT COUNT(*) AS n FROM referrals WHERE ip = ? AND at > ?", ipHash, dayAgo).one().n;
        const fromIpToReferrer = this.sql.exec("SELECT COUNT(*) AS n FROM referrals WHERE ip = ? AND at > ? AND referrer = ?",
            ipHash, dayAgo, referrer).one().n;
        if (fromIp >= REDEEMS_PER_IP_DAY || fromIpToReferrer >= REDEEMS_PER_IP_REFERRER_DAY) return { error: "busy" };
        this.sql.exec("INSERT INTO referrals (referred, referrer, at, ip, confirmed) VALUES (?, ?, ?, ?, NULL)",
            userId, referrer, Date.now(), ipHash);
        return { ok: true, referrer: this.nicknameOf(referrer) || "a player", state: this.tagState(userId) };
    }

    // Called by the Worker after an upload to an NSWS board.
    confirmReferral(userId) {
        this.sql.exec("UPDATE referrals SET confirmed = ? WHERE referred = ? AND confirmed IS NULL", Date.now(), userId);
        this.top = null;
    }

    setEquipped(userId, tag) {
        this.sql.exec(`INSERT INTO tag_profile (user_id, equipped, bonus) VALUES (?, ?, 0)
            ON CONFLICT(user_id) DO UPDATE SET equipped = excluded.equipped`, userId, tag);
    }

    changed(userId) {
        const state = this.tagState(userId);
        return { state, retag: { uids: this.chatUids(userId), tag: state.equipped } };
    }

    // Bought tags are kept for good and put on straight away.
    buyTag(userId, tag) {
        if (!isTag(tag) || TAGS[tag].kind !== "shop") return { error: "bad" };
        const state = this.tagState(userId);
        if (!state.owned.includes(tag)) {
            if (state.points < TAGS[tag].cost) return { error: "points" };
            this.sql.exec("INSERT INTO tag_bought (user_id, tag, cost, at) VALUES (?, ?, ?, ?)", userId, tag, TAGS[tag].cost, Date.now());
        }
        this.setEquipped(userId, tag);
        return this.changed(userId);
    }

    equipTag(userId, tag) {
        if (tag != null && !isTag(tag)) return { error: "bad" };
        if (tag != null && !this.ownedTags(userId).has(tag)) return { error: "locked" };
        this.setEquipped(userId, tag);
        return this.changed(userId);
    }

    // The tag the chat shows next to this visitor's messages, or null.
    chatTag(uid) {
        if (!CHAT_UID.test(uid ?? "")) return null;
        const userId = this.sql.exec("SELECT user_id FROM chat_links WHERE uid = ?", uid).toArray()[0]?.user_id;
        if (!userId) return null;
        const equipped = this.tagProfile(userId).equipped;
        return equipped && this.ownedTags(userId).has(equipped) ? equipped : null;
    }

    // Owner tools, found by account or by exact nickname (names are unique to one account).
    lookupTags(nickname, userId) {
        if (HEX64.test(userId ?? "")) {
            const current = this.nicknameOf(userId);
            if (!current) return { error: "missing" };
            return { userId, nickname: current, granted: this.grantsOf(userId), state: this.tagState(userId) };
        }
        const key = nameKey(text(nickname, MAX_NICK));
        if (SHARED_NAMES.has(key)) return { error: "missing" };
        const row = this.sql.exec("SELECT user_id, nickname FROM names WHERE name_key = ?", key).toArray()[0];
        if (!row) return { error: "missing" };
        return { userId: row.user_id, nickname: row.nickname, granted: this.grantsOf(row.user_id), state: this.tagState(row.user_id) };
    }

    // Owner search over every name an account has been seen with, compared like nameKey.
    // Best first: the whole name, then names starting with the query, containing it, and
    // finally holding its letters in order ("ckd" finds "Cookedbyapringle"). One or two letters
    // in order match nearly everyone, so that last step waits for a third.
    searchPlayers(query) {
        const q = nameKey(text(query, MAX_NICK));
        if (!q) return { results: [] };
        const esc = (s) => s.replace(/[\\%_]/g, (c) => "\\" + c);
        const loose = [...q].length >= 3 ? "%" + [...q].map(esc).join("%") + "%" : "%" + esc(q) + "%";
        const rows = this.sql.exec(
            `SELECT user_id, nickname, CASE WHEN name_key = ? THEN 0 WHEN name_key LIKE ? ESCAPE '\\' THEN 1
                WHEN name_key LIKE ? ESCAPE '\\' THEN 2 ELSE 3 END AS rank
            FROM names WHERE name_key LIKE ? ESCAPE '\\' ORDER BY rank, length(name_key), at DESC LIMIT 300`,
            q, esc(q) + "%", "%" + esc(q) + "%", loose,
        ).toArray();
        const seen = new Map();
        for (const r of rows) {
            if (seen.size >= SEARCH_RESULTS) break;
            if (!seen.has(r.user_id)) seen.set(r.user_id, r);
        }
        return {
            results: [...seen.values()].map((r) => {
                const nickname = this.nicknameOf(r.user_id) || r.nickname;
                const equipped = this.tagProfile(r.user_id).equipped;
                return {
                    userId: r.user_id, nickname, matched: r.nickname,
                    equipped: isTag(equipped) ? equipped : null, granted: this.grantsOf(r.user_id),
                };
            }),
        };
    }

    grantsOf(userId) {
        return this.sql.exec("SELECT tag FROM tag_grants WHERE user_id = ?", userId).toArray().map((r) => r.tag).filter(isTag);
    }

    grantTag(userId, tag, on) {
        if (!HEX64.test(userId ?? "") || !isTag(tag) || TAGS[tag].kind !== "grant") return { error: "bad" };
        if (on) this.sql.exec("INSERT OR IGNORE INTO tag_grants (user_id, tag, at) VALUES (?, ?, ?)", userId, tag, Date.now());
        else this.sql.exec("DELETE FROM tag_grants WHERE user_id = ? AND tag = ?", userId, tag);
        return { ...this.changed(userId), granted: this.grantsOf(userId) };
    }

    addBonus(userId, amount) {
        if (!HEX64.test(userId ?? "") || !Number.isSafeInteger(amount) || Math.abs(amount) > MAX_BONUS) return { error: "bad" };
        this.sql.exec(`INSERT INTO tag_profile (user_id, equipped, bonus) VALUES (?, NULL, ?)
            ON CONFLICT(user_id) DO UPDATE SET bonus = MAX(-${MAX_BONUS}, MIN(${MAX_BONUS}, bonus + excluded.bonus))`, userId, amount);
        return { ...this.changed(userId), granted: this.grantsOf(userId) };
    }

    tagOverview() {
        const grants = this.sql.exec("SELECT user_id, tag, at FROM tag_grants ORDER BY at DESC LIMIT 500").toArray()
            .filter((r) => isTag(r.tag))
            .map((r) => ({ userId: r.user_id, nickname: this.nicknameOf(r.user_id) || "Unknown", tag: r.tag, at: r.at }));
        const totals = this.sql.exec("SELECT COUNT(*) AS all_, COUNT(confirmed) AS confirmed FROM referrals").one();
        const bought = this.sql.exec("SELECT tag, COUNT(*) AS n FROM tag_bought GROUP BY tag ORDER BY n DESC").toArray();
        return {
            grants,
            top: this.sql.exec(
                `SELECT referrer, COUNT(confirmed) AS n, COUNT(*) AS total FROM referrals GROUP BY referrer
                ORDER BY n DESC, total DESC LIMIT 20`,
            ).toArray().map((r) => ({ nickname: this.nicknameOf(r.referrer) || "Unknown", referrals: r.n, pending: r.total - r.n })),
            referrals: totals.all_,
            confirmed: totals.confirmed,
            bought: bought.filter((r) => isTag(r.tag)).map((r) => ({ tag: r.tag, count: r.n })),
        };
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

    // Names are held to the chat's slur filter (chatfilter.js) as well as being unique.
    checkName(userId, nickname) {
        nickname = text(nickname, MAX_NICK);
        if (findSlurs(nickname).length) return { available: false, blocked: true };
        return { available: this.available(userId, nickname) };
    }

    // Taking a new name gives up every name the account held before.
    claimName(userId, nickname) {
        nickname = text(nickname, MAX_NICK);
        if (findSlurs(nickname).length) return { available: false, blocked: true };
        if (!this.available(userId, nickname)) return { available: false };
        const key = nameKey(nickname);
        this.sql.exec("DELETE FROM names WHERE user_id = ? AND name_key != ?", userId, key);
        this.top = null;
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

    // Views count everyone but the account asking, so a player's own replays don't add up.
    listClips(userId) {
        return this.sql.exec(
            `SELECT c.id, c.key, c.name, c.player, c.track, c.frames, c.created,
                (SELECT COUNT(*) FROM views v WHERE v.key = c.key AND v.user_id != c.user_id) AS people,
                (SELECT COALESCE(SUM(v.count), 0) FROM views v WHERE v.key = c.key AND v.user_id != c.user_id) AS views
            FROM clips c WHERE c.user_id = ? ORDER BY c.created, c.id`, userId,
        ).toArray().map((r) => ({
            id: r.id, key: r.key, name: r.name, playerName: r.player, trackId: r.track, frames: r.frames, createdAt: r.created,
            people: r.people, views: r.views,
        }));
    }

    recordView(userId, key) {
        if (!HEX64.test(String(key))) return { error: "bad" };
        const now = Date.now();
        const row = this.sql.exec("SELECT last FROM views WHERE key = ? AND user_id = ?", key, userId).toArray()[0];
        if (!row) this.sql.exec("INSERT INTO views (key, user_id, count, last) VALUES (?, ?, 1, ?)", key, userId, now);
        else if (now - row.last >= VIEW_GAP_MS) this.sql.exec("UPDATE views SET count = count + 1, last = ? WHERE key = ? AND user_id = ?", now, key, userId);
        return { ok: true };
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
