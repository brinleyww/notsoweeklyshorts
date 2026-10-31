// Accounts: who holds each nickname, every account's clips, and shared clip links. One
// Durable Object ("global"). An account is the game's userId, the SHA-256 of its private
// token; the token itself is never stored.

import { DurableObject } from "cloudflare:workers";
import { censor, findSlurs } from "./chatfilter.js";

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
const RECENT_REFERRALS = 5;
const CHAT_UID = /^[0-9a-f]{16}$/;
const VISITOR = /^[0-9a-f]{32}$/;
// The weekly bingo card is 5x5 with a free centre. The card itself is made on the page
// (mod/nsws_bingo.js); the Worker only keeps which squares are marked, as a bitmask.
const BINGO_SIZE = 5;
const BINGO_FREE = 1 << 12;
const BINGO_FULL = (1 << 25) - 1;
const BINGO_LINES = (() => {
    const lines = [];
    const bit = (r, c) => 1 << (r * BINGO_SIZE + c);
    for (let i = 0; i < BINGO_SIZE; i++) {
        let row = 0;
        let col = 0;
        for (let j = 0; j < BINGO_SIZE; j++) {
            row |= bit(i, j);
            col |= bit(j, i);
        }
        lines.push(row, col);
    }
    let down = 0;
    let up = 0;
    for (let i = 0; i < BINGO_SIZE; i++) {
        down |= bit(i, i);
        up |= bit(i, BINGO_SIZE - 1 - i);
    }
    lines.push(down, up);
    return lines;
})();
const BINGO_HISTORY = 12;
const MAX_BONUS = 10_000;
const TOP_RECRUITERS = 5;
const SEARCH_RESULTS = 12;
// Every visit shows the top recruiters, and counting them scans every referral.
const TOP_TTL_MS = 60_000;

// Keep in step with TAGS in mod/nsws_tags.js, which draws them. "referred" belongs to anyone
// who redeemed a code, "milestone" to anyone with that many confirmed referrals, "hours" to anyone
// who has played that long, "bingo" to anyone with that many bingos in all, "blackout" to anyone who
// marked a whole card, "king" to the one player holding the most WRs, "shop" is bought with referral
// points, and "grant" only the owner hands out.
export const TAGS = {
    king: { kind: "king" },
    bingo: { kind: "bingo", bingos: 1 },
    dauber: { kind: "bingo", bingos: 5 },
    fullhouse: { kind: "bingo", bingos: 15 },
    jackpot: { kind: "bingo", bingos: 30 },
    cardshark: { kind: "bingo", bingos: 60 },
    blackout: { kind: "blackout" },
    firstlaps: { kind: "hours", hours: 1 },
    regular: { kind: "hours", hours: 5 },
    grinder: { kind: "hours", hours: 10 },
    veteran: { kind: "hours", hours: 25 },
    roadwarrior: { kind: "hours", hours: 50 },
    centurion: { kind: "hours", hours: 100 },
    lifer: { kind: "hours", hours: 250 },
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
    cupchamp: { kind: "grant" },
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

function liveWeek(env) {
    const n = Number(env.CURRENT_WEEK);
    return Number.isSafeInteger(n) ? n : null;
}

// Rows, columns and diagonals all marked; the free centre always counts.
export function bingoLines(marks) {
    const m = marks | BINGO_FREE;
    return BINGO_LINES.filter((line) => (m & line) === line).length;
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
        // Focused seconds on the site, credited in batches by TrafficStats from its beats.
        this.sql.exec("CREATE TABLE IF NOT EXISTS playtime (user_id TEXT PRIMARY KEY, seconds REAL NOT NULL)");
        // Marked squares of each weekly bingo card (bit = row * 5 + column). A player who has a bingo
        // can start a new card for the same week: round goes up, and the old card's bingos and
        // blackout move into banked / banked_full.
        this.sql.exec(`CREATE TABLE IF NOT EXISTS bingo (
            user_id TEXT NOT NULL, week INTEGER NOT NULL, marks INTEGER NOT NULL, at INTEGER NOT NULL,
            round INTEGER NOT NULL DEFAULT 0, banked INTEGER NOT NULL DEFAULT 0, banked_full INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (user_id, week)) WITHOUT ROWID`);
        const bingoColumns = this.sql.exec("PRAGMA table_info(bingo)").toArray().map((c) => c.name);
        if (!bingoColumns.includes("round")) {
            // The first cards (v9.50) had other squares, so their marks mean nothing on today's
            // cards: bank their bingos and start everyone on a clean card.
            this.sql.exec("ALTER TABLE bingo ADD COLUMN round INTEGER NOT NULL DEFAULT 0");
            this.sql.exec("ALTER TABLE bingo ADD COLUMN banked INTEGER NOT NULL DEFAULT 0");
            this.sql.exec("ALTER TABLE bingo ADD COLUMN banked_full INTEGER NOT NULL DEFAULT 0");
            for (const row of this.sql.exec("SELECT user_id, week, marks FROM bingo").toArray()) {
                this.sql.exec("UPDATE bingo SET banked = ?, banked_full = ?, marks = ? WHERE user_id = ? AND week = ?",
                    bingoLines(row.marks), (row.marks | BINGO_FREE) === BINGO_FULL ? 1 : 0, BINGO_FREE, row.user_id, row.week);
            }
        }
        // First place on each NSWS board, as the Worker last served it (noteWrs).
        this.sql.exec(`CREATE TABLE IF NOT EXISTS wrs (
            track TEXT PRIMARY KEY, week INTEGER NOT NULL, user_id TEXT NOT NULL, nickname TEXT NOT NULL,
            frames INTEGER NOT NULL, at INTEGER NOT NULL) WITHOUT ROWID`);
        // The one NSWS King. before only holds a tag for a King crowned when the crown was still put
        // on for them; they get it back when they lose the crown.
        this.sql.exec(`CREATE TABLE IF NOT EXISTS wr_king (
            id INTEGER PRIMARY KEY CHECK (id = 0), user_id TEXT NOT NULL, since INTEGER NOT NULL, before TEXT)`);
        this.top = null;
        this.wrs = null;
        this.king = null;
    }

    // Every WR row, kept in memory: boards are read all the time and almost never change their leader.
    wrTable() {
        if (!this.wrs) {
            this.wrs = new Map();
            for (const r of this.sql.exec("SELECT track, week, user_id, nickname, frames, at FROM wrs")) this.wrs.set(r.track, r);
            this.king = this.sql.exec("SELECT user_id, since, before FROM wr_king WHERE id = 0").toArray()[0] ?? null;
        }
        return this.wrs;
    }

    wrCount(userId) {
        let n = 0;
        for (const w of this.wrTable().values()) if (w.user_id === userId) n++;
        return n;
    }

    kingId() {
        this.wrTable();
        return this.king?.user_id ?? null;
    }

    kingInfo() {
        const userId = this.kingId();
        if (!userId) return null;
        let nickname = this.nicknameOf(userId);
        if (!nickname) for (const w of this.wrs.values()) if (w.user_id === userId) nickname = w.nickname;
        return { nickname: censor(nickname || "Unknown"), wrs: this.wrCount(userId), since: this.king.since };
    }

    // "userId|frames" of every WR holder, for the leaderboards' snapshot (see AntiCheat.saveSnapshot).
    wrKeys() {
        const keys = {};
        for (const [track, w] of this.wrTable()) keys[track] = w.user_id + "|" + w.frames;
        return keys;
    }

    // entries: [{ track, week, userId, nickname, frames }], userId null for a board with nobody on it.
    // The Worker only sends tracks the anti-cheat knows, with their real week. Returns chat retags.
    noteWrs(entries) {
        if (!Array.isArray(entries)) return { error: "bad" };
        const table = this.wrTable();
        const touched = new Set();
        const now = Date.now();
        this.ctx.storage.transactionSync(() => {
            for (const e of entries) {
                if (!HEX64.test(e?.track ?? "") || !Number.isSafeInteger(e.week)) continue;
                const old = table.get(e.track);
                if (!HEX64.test(e.userId ?? "")) {
                    if (!old) continue;
                    this.sql.exec("DELETE FROM wrs WHERE track = ?", e.track);
                    table.delete(e.track);
                    touched.add(old.user_id);
                    continue;
                }
                const nickname = text(e.nickname, MAX_NICK);
                const frames = Number.isSafeInteger(e.frames) ? e.frames : 0;
                if (old && old.user_id === e.userId && old.frames === frames && old.nickname === nickname && old.week === e.week) continue;
                // at is when this player took the record, so a faster run of their own keeps it.
                const row = { track: e.track, week: e.week, user_id: e.userId, nickname, frames, at: old?.user_id === e.userId ? old.at : now };
                this.sql.exec(`INSERT INTO wrs (track, week, user_id, nickname, frames, at) VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(track) DO UPDATE SET week = excluded.week, user_id = excluded.user_id, nickname = excluded.nickname,
                        frames = excluded.frames, at = excluded.at`,
                    row.track, row.week, row.user_id, row.nickname, row.frames, row.at);
                table.set(e.track, row);
                if (old?.user_id !== e.userId) {
                    touched.add(e.userId);
                    if (old) touched.add(old.user_id);
                }
            }
        });
        return { retags: touched.size ? this.crown(touched) : [] };
    }

    // Most WRs wins. A tie keeps the current King; with no King among the tied, whoever got there first.
    crown(touched) {
        const counts = new Map();
        const reached = new Map();
        for (const w of this.wrTable().values()) {
            counts.set(w.user_id, (counts.get(w.user_id) ?? 0) + 1);
            reached.set(w.user_id, Math.max(reached.get(w.user_id) ?? 0, w.at));
        }
        const current = this.king?.user_id ?? null;
        let best = current && counts.has(current) ? current : null;
        for (const [id, n] of counts) {
            const top = best ? counts.get(best) : 0;
            if (n > top || (n === top && best !== current && reached.get(id) < reached.get(best))) best = id;
        }
        const retags = new Set(best && touched.has(best) ? [best] : []);
        if (best !== current) {
            this.ctx.storage.transactionSync(() => {
                if (current) {
                    const before = this.king.before;
                    if (this.tagProfile(current).equipped === "king") this.setEquipped(current, isTag(before) ? before : null);
                    retags.add(current);
                }
                if (best) {
                    this.king = { user_id: best, since: Date.now(), before: null };
                    this.sql.exec("INSERT OR REPLACE INTO wr_king (id, user_id, since, before) VALUES (0, ?, ?, ?)",
                        best, this.king.since, this.king.before);
                    retags.add(best);
                } else {
                    this.king = null;
                    this.sql.exec("DELETE FROM wr_king WHERE id = 0");
                }
            });
        }
        return [...retags].map((userId) => ({ uids: this.chatUids(userId), tag: this.chatTagOf(userId) })).filter((r) => r.uids.length);
    }

    // The tag as the chat stores it; the King's carries their WR count ("king:7").
    chatTagOf(userId) {
        const equipped = this.tagProfile(userId).equipped;
        if (!equipped || !this.ownedTags(userId).has(equipped)) return null;
        return equipped === "king" ? "king:" + this.wrCount(userId) : equipped;
    }

    hoursOf(userId) {
        return (this.sql.exec("SELECT seconds FROM playtime WHERE user_id = ?", userId).toArray()[0]?.seconds ?? 0) / 3600;
    }

    // Every card's marks, newest first, with the bingo count over all of them.
    bingoOf(userId) {
        const cards = this.sql.exec("SELECT week, marks, round, banked, banked_full FROM bingo WHERE user_id = ? ORDER BY week DESC", userId).toArray();
        let total = 0;
        let blackouts = 0;
        for (const c of cards) {
            total += c.banked + bingoLines(c.marks);
            blackouts += c.banked_full + ((c.marks | BINGO_FREE) === BINGO_FULL ? 1 : 0);
        }
        return {
            live: liveWeek(this.env), total, blackouts,
            cards: cards.slice(0, BINGO_HISTORY).map((c) => ({ week: c.week, round: c.round, banked: c.banked, marks: c.marks | BINGO_FREE })),
        };
    }

    bingoRow(userId, week) {
        return this.sql.exec("SELECT marks, round FROM bingo WHERE user_id = ? AND week = ?", userId, week).toArray()[0] ?? null;
    }

    bingoOpen(week) {
        const live = liveWeek(this.env);
        return live != null && week >= live && week <= live + 1;
    }

    // Squares are only marked on the live week's card (or the next week's, between a site push and
    // the Worker's CURRENT_WEEK bump), so old cards stay as they were. Marks for an older round of
    // the card (another tab, a slow request) are dropped; the reply tells the page the round.
    markBingo(userId, week, round, squares) {
        if (!Number.isSafeInteger(week) || !Number.isSafeInteger(round) || !Array.isArray(squares) || squares.length > 25) return { error: "bad" };
        if (!this.bingoOpen(week)) return { error: "closed" };
        let add = 0;
        for (const i of squares) {
            if (!Number.isSafeInteger(i) || i < 0 || i >= 25) return { error: "bad" };
            add |= 1 << i;
        }
        if (round === (this.bingoRow(userId, week)?.round ?? 0)) {
            this.sql.exec(`INSERT INTO bingo (user_id, week, marks, at) VALUES (?, ?, ?, ?)
                ON CONFLICT(user_id, week) DO UPDATE SET marks = marks | excluded.marks, at = excluded.at`,
                userId, week, add | BINGO_FREE, Date.now());
        }
        return this.changed(userId);
    }

    // A new card for the same week, once this one has a bingo. Its bingos (and blackout) are kept.
    resetBingo(userId, week, round) {
        if (!Number.isSafeInteger(week) || !Number.isSafeInteger(round)) return { error: "bad" };
        if (!this.bingoOpen(week)) return { error: "closed" };
        const row = this.bingoRow(userId, week);
        if (!row || row.round !== round || bingoLines(row.marks) < 1) return { error: "locked" };
        this.sql.exec(`UPDATE bingo SET banked = banked + ?, banked_full = banked_full + ?, marks = ?, round = round + 1, at = ?
            WHERE user_id = ? AND week = ?`,
            bingoLines(row.marks), (row.marks | BINGO_FREE) === BINGO_FULL ? 1 : 0, BINGO_FREE, Date.now(), userId, week);
        return this.changed(userId);
    }

    // entries: [visitorId, seconds]. A visitor counts for the account its browser is linked to
    // (chat_links, set on every visit).
    async playByAccount(entries) {
        const perUser = new Map();
        for (const entry of entries) {
            const [visitor, seconds] = Array.isArray(entry) ? entry : [];
            if (!VISITOR.test(visitor ?? "") || !(seconds > 0)) continue;
            const uid = (await sha256Hex("nsws-chat:" + visitor)).slice(0, 16);
            const userId = this.sql.exec("SELECT user_id FROM chat_links WHERE uid = ?", uid).toArray()[0]?.user_id;
            if (userId) perUser.set(userId, (perUser.get(userId) ?? 0) + seconds);
        }
        return perUser;
    }

    async creditPlay(entries) {
        if (!Array.isArray(entries)) return { error: "bad" };
        const perUser = await this.playByAccount(entries);
        this.ctx.storage.transactionSync(() => {
            for (const [userId, seconds] of perUser) {
                this.sql.exec(`INSERT INTO playtime (user_id, seconds) VALUES (?, ?)
                    ON CONFLICT(user_id) DO UPDATE SET seconds = seconds + excluded.seconds`, userId, seconds);
            }
        });
        return { ok: true, accounts: perUser.size };
    }

    // Lifts each account to the total given, and never lowers one.
    async restorePlay(entries) {
        if (!Array.isArray(entries)) return { error: "bad" };
        const perUser = await this.playByAccount(entries);
        this.ctx.storage.transactionSync(() => {
            for (const [userId, seconds] of perUser) {
                this.sql.exec(`INSERT INTO playtime (user_id, seconds) VALUES (?, ?)
                    ON CONFLICT(user_id) DO UPDATE SET seconds = MAX(seconds, excluded.seconds)`, userId, seconds);
            }
        });
        return { ok: true, accounts: perUser.size };
    }

    nicknameOf(userId) {
        return this.sql.exec("SELECT nickname FROM names WHERE user_id = ? ORDER BY at DESC LIMIT 1", userId).toArray()[0]?.nickname ?? null;
    }

    // Every account keeps one code for good, so a link posted anywhere keeps working.
    // ref_expired holds the codes that ran out while codes still changed every 10 minutes.
    refCode(userId) {
        const row = this.sql.exec("SELECT code FROM ref_codes WHERE user_id = ?", userId).toArray()[0];
        if (row) return row.code;
        let code;
        do code = randomId(8, REF_ALPHABET);
        while (this.sql.exec("SELECT 1 FROM ref_codes WHERE code = ? UNION ALL SELECT 1 FROM ref_expired WHERE code = ?", code, code)
            .toArray().length);
        this.sql.exec("INSERT INTO ref_codes (user_id, code, at) VALUES (?, ?, ?)", userId, code, Date.now());
        return code;
    }

    recentReferrals(userId) {
        return this.sql.exec(
            "SELECT referred, confirmed FROM referrals WHERE referrer = ? AND confirmed IS NOT NULL ORDER BY confirmed DESC LIMIT ?",
            userId, RECENT_REFERRALS,
        ).toArray().map((r) => ({ nickname: this.nicknameOf(r.referred) || "A friend", at: r.confirmed }));
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
    ownedTags(userId, counts = this.referralCounts(userId), hours = this.hoursOf(userId), bingo = this.bingoOf(userId)) {
        const owned = new Set();
        if (this.sql.exec("SELECT 1 FROM referrals WHERE referred = ?", userId).toArray().length) owned.add("referred");
        for (const [id, tag] of Object.entries(TAGS)) {
            if (tag.kind === "milestone" && counts.confirmed >= tag.referrals) owned.add(id);
            if (tag.kind === "hours" && hours >= tag.hours) owned.add(id);
            if (tag.kind === "bingo" && bingo.total >= tag.bingos) owned.add(id);
            if (tag.kind === "blackout" && bingo.blackouts > 0) owned.add(id);
        }
        if (this.kingId() === userId) owned.add("king");
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
        const hours = this.hoursOf(userId);
        const bingo = this.bingoOf(userId);
        const owned = this.ownedTags(userId, counts, hours, bingo);
        const by = this.sql.exec("SELECT referrer FROM referrals WHERE referred = ?", userId).toArray()[0]?.referrer;
        return {
            code: this.refCode(userId),
            now: Date.now(),
            hours,
            bingo,
            wrs: this.wrCount(userId),
            king: this.kingInfo(),
            recent: this.recentReferrals(userId),
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
        return { state, linked: linked ? { uids: [uid], tag: this.chatTagOf(userId) } : null };
    }

    redeem(userId, code, ipHash) {
        code = String(code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
        if (!REF_CODE.test(code)) return { error: "code" };
        const row = this.sql.exec("SELECT user_id FROM ref_codes WHERE code = ?", code).toArray()[0];
        if (!row) {
            return this.sql.exec("SELECT 1 FROM ref_expired WHERE code = ?", code).toArray().length ? { error: "expired" } : { error: "code" };
        }
        const referrer = row.user_id;
        if (referrer === userId) return { error: "self" };
        if (this.sql.exec("SELECT 1 FROM referrals WHERE referred = ?", userId).toArray().length) return { error: "already" };
        if (this.sql.exec("SELECT 1 FROM referrals WHERE referred = ? AND referrer = ?", referrer, userId).toArray().length) {
            return { error: "mutual" };
        }
        this.sql.exec("INSERT INTO referrals (referred, referrer, at, ip, confirmed) VALUES (?, ?, ?, ?, NULL)",
            userId, referrer, Date.now(), ipHash);
        return { ok: true, referrer: this.nicknameOf(referrer) || "a player", state: this.tagState(userId) };
    }

    // Called by the Worker after an upload to an NSWS board: the upload confirms a referral.
    uploaded(userId) {
        const cursor = this.sql.exec("UPDATE referrals SET confirmed = ? WHERE referred = ? AND confirmed IS NULL", Date.now(), userId);
        if (cursor.rowsWritten > 0) this.top = null;
    }

    setEquipped(userId, tag) {
        this.sql.exec(`INSERT INTO tag_profile (user_id, equipped, bonus) VALUES (?, ?, 0)
            ON CONFLICT(user_id) DO UPDATE SET equipped = excluded.equipped`, userId, tag);
    }

    changed(userId) {
        const state = this.tagState(userId);
        return { state, retag: { uids: this.chatUids(userId), tag: this.chatTagOf(userId) } };
    }

    // Bought tags are kept for good; the player puts them on.
    buyTag(userId, tag) {
        if (!isTag(tag) || TAGS[tag].kind !== "shop") return { error: "bad" };
        const state = this.tagState(userId);
        if (!state.owned.includes(tag)) {
            if (state.points < TAGS[tag].cost) return { error: "points" };
            this.sql.exec("INSERT INTO tag_bought (user_id, tag, cost, at) VALUES (?, ?, ?, ?)", userId, tag, TAGS[tag].cost, Date.now());
        }
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
        return userId ? this.chatTagOf(userId) : null;
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
