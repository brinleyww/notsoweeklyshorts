// TrackHub: shared track packs (?tracks= and /t/ links), clubs and their campaigns, and the
// tracks players send to Race Control. One Durable Object ("global"). An account is the
// game's userId, the SHA-256 of its private token, worked out by the Worker; no token reaches here.
// Every method answers either its result or { status, error } with a sentence for the player.

import { DurableObject } from "cloudflare:workers";
import { moderate } from "./chatfilter.js";

export const PACK_ID = /^[0-9A-Za-z]{10}$/;
export const HUB_ID = /^[0-9A-Za-z]{12}$/;
const CLUB_CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const HEX64 = /^[0-9a-f]{64}$/;
const MEMBER_REF = /^[0-9a-f]{12,64}$/;
const PACK_TEXT = /^NSWSPack1[A-Za-z0-9_-]+=*$/;
const TAG = /^[A-Za-z0-9]{1,5}$/;
const MODES = new Set(["normal", "rocket", "royale"]);
const STATUSES = new Set(["new", "planned", "rejected"]);
const ROLE_ORDER = "CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END";

// Characters; pack codes and track codes are ASCII, so also bytes.
const MAX_PACK = 4_000_000;
const PACK_TRACKS = 50;
const PACKS_PER_DAY = 30;
// SQLite in a Durable Object refuses any value over 2 MB, so long texts are split across rows.
const CHUNK = 900_000;
const MAX_NICK = 24;
const MAX_CLUB_NAME = 32;
const MAX_DESCRIPTION = 300;
const MAX_TRACK_NAME = 64;
const MAX_AUTHOR = 32;
const MAX_ENV = 32;
const MAX_CAMPAIGN_NAME = 40;
const OWNED_MAX = 3;
const JOINED_MAX = 20;
const CAMPAIGNS_MAX = 20;
const CAMPAIGN_TRACKS = 25;
const MAX_CAMPAIGN_CODE = 1_000_000;
const MAX_CAMPAIGN_TOTAL = 4_000_000;
const MEMBERS_LIST = 500;
const CLUBS_PER_DAY = 5;
const JOINS_PER_DAY = 60;
const CLUB_EDITS_PER_DAY = 200;
const MAX_SUBMISSION = 2_000_000;
const MAX_NOTE = 500;
const SUBMITS_PER_DAY = 3;
const SUBMITS_WAITING = 10;
const MY_SUBMISSIONS = 50;
const ADMIN_LIST = 200;
const DAY_MS = 86_400_000;
// Storage is counted in bytes too: what one address may store a day (links, campaigns, submissions),
// what all of a club's campaigns may hold, and how long a link nobody opens is kept.
const BYTES_PER_DAY = 30_000_000;
const CLUB_BYTES_MAX = 8_000_000;
const PACK_IDLE_MS = 180 * DAY_MS;
const LIB_ID = /^[A-Za-z0-9_-]{6,24}$/;
const LIB_TRACKS = 500;
const LIB_BYTES = 30_000_000;
const LIB_CODE_MAX = 2_000_000;
const LIB_BATCH = 20;
// Room for a track's own picture (mod/nsws_tracks.js keeps it under 20 KB).
const LIB_META_MAX = 26_000;

const fail = (status, error) => ({ status, error });

function randomString(length, alphabet) {
    const limit = 256 - (256 % alphabet.length);
    let out = "";
    while (out.length < length) {
        for (const b of crypto.getRandomValues(new Uint8Array(length * 2))) {
            if (b < limit && out.length < length) out += alphabet[b % alphabet.length];
        }
    }
    return out;
}

async function sha256Hex(value) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const nick = (value) => moderate(value, MAX_NICK) || "Player";
const modeOf = (value) => (MODES.has(value) ? value : "normal");
const trackIdOf = (value) => (typeof value === "string" && HEX64.test(value) ? value : null);

// moderate() folds line breaks into spaces, so a description is cleaned a line at a time.
function cleanLines(value, max) {
    if (typeof value !== "string") return "";
    const lines = value.slice(0, max * 2).split(/\r?\n/).slice(0, 8).map((line) => moderate(line, max));
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
}

function cleanTag(value) {
    if (value == null || value === "") return { tag: "" };
    if (typeof value !== "string" || !TAG.test(value.trim())) return fail(400, "A club tag is 1 to 5 letters or digits.");
    const tag = value.trim();
    return moderate(tag, 5) === tag ? { tag } : fail(400, "That club tag isn't allowed.");
}

export class TrackHub extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.sql = ctx.storage.sql;
        this.sql.exec(`CREATE TABLE IF NOT EXISTS packs (id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
            count INTEGER NOT NULL, names TEXT NOT NULL, created INTEGER NOT NULL, size INTEGER NOT NULL, opened INTEGER)`);
        this.sql.exec(`CREATE TABLE IF NOT EXISTS blobs (kind TEXT NOT NULL, ref TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL,
            PRIMARY KEY (kind, ref, seq))`);
        this.sql.exec(`CREATE TABLE IF NOT EXISTS clubs (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, tag TEXT NOT NULL,
            description TEXT NOT NULL, owner_id TEXT NOT NULL, owner_name TEXT NOT NULL, created INTEGER NOT NULL,
            member_count INTEGER NOT NULL, campaign_count INTEGER NOT NULL)`);
        this.sql.exec(`CREATE TABLE IF NOT EXISTS members (club_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL,
            joined INTEGER NOT NULL, PRIMARY KEY (club_id, user_id))`);
        this.sql.exec("CREATE INDEX IF NOT EXISTS members_user ON members(user_id)");
        // summary: the tracks' [{name, author, mode, trackId}] as JSON, so a club page never reads the codes.
        this.sql.exec(`CREATE TABLE IF NOT EXISTS campaigns (id TEXT PRIMARY KEY, club_id TEXT NOT NULL, name TEXT NOT NULL,
            created INTEGER NOT NULL, updated INTEGER NOT NULL, summary TEXT NOT NULL)`);
        this.sql.exec("CREATE INDEX IF NOT EXISTS campaigns_club ON campaigns(club_id, created)");
        this.sql.exec(`CREATE TABLE IF NOT EXISTS campaign_tracks (campaign_id TEXT NOT NULL, pos INTEGER NOT NULL, code TEXT NOT NULL,
            mode TEXT NOT NULL, name TEXT NOT NULL, author TEXT NOT NULL, track_id TEXT, PRIMARY KEY (campaign_id, pos))`);
        this.sql.exec(`CREATE TABLE IF NOT EXISTS submissions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, nickname TEXT NOT NULL,
            name TEXT NOT NULL, author TEXT NOT NULL, track_id TEXT, env TEXT NOT NULL, mode TEXT NOT NULL, note TEXT NOT NULL,
            created INTEGER NOT NULL, status TEXT NOT NULL, week INTEGER, owner_note TEXT NOT NULL, size INTEGER NOT NULL)`);
        this.sql.exec("CREATE INDEX IF NOT EXISTS subs_user ON submissions(user_id, status)");
        this.sql.exec("CREATE INDEX IF NOT EXISTS subs_status ON submissions(status, created)");
        this.sql.exec("CREATE INDEX IF NOT EXISTS subs_created ON submissions(created)");
        // Daily counters for the rate limits, keyed like "pack:ip:<hash>". Day = UTC days since 1970.
        this.sql.exec("CREATE TABLE IF NOT EXISTS limits (day INTEGER NOT NULL, key TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, key))");
        // Each account's My Tracks; the code is in blobs (kind "l", ref "<user_id>:<id>").
        this.sql.exec(`CREATE TABLE IF NOT EXISTS library (user_id TEXT NOT NULL, id TEXT NOT NULL, meta TEXT NOT NULL, size INTEGER NOT NULL,
            updated INTEGER NOT NULL, PRIMARY KEY (user_id, id))`);
        this.prunedDay = -1;
    }

    first(query, ...args) {
        return this.sql.exec(query, ...args).toArray()[0] ?? null;
    }

    // ---- rate limits ----

    overLimit(keys, max) {
        const day = Math.floor(Date.now() / DAY_MS);
        return keys.some((key) => (this.first("SELECT n FROM limits WHERE day = ? AND key = ?", day, key)?.n ?? 0) >= max);
    }

    countHit(keys, by = 1) {
        const day = Math.floor(Date.now() / DAY_MS);
        if (this.prunedDay !== day) {
            this.sql.exec("DELETE FROM limits WHERE day < ?", day);
            this.pruneIdlePacks();
            this.prunedDay = day;
        }
        for (const key of keys) this.sql.exec("INSERT INTO limits (day, key, n) VALUES (?, ?, ?) ON CONFLICT (day, key) DO UPDATE SET n = n + ?", day, key, by, by);
    }

    overBytes(ipKey, size) {
        const day = Math.floor(Date.now() / DAY_MS);
        return (this.first("SELECT n FROM limits WHERE day = ? AND key = ?", day, "bytes:ip:" + ipKey)?.n ?? 0) + size > BYTES_PER_DAY;
    }

    pruneIdlePacks() {
        const ids = this.sql.exec("SELECT id FROM packs WHERE COALESCE(opened, created) < ? LIMIT 500", Date.now() - PACK_IDLE_MS).toArray();
        for (const { id } of ids) {
            this.dropBlob("p", id);
            this.sql.exec("DELETE FROM packs WHERE id = ?", id);
        }
    }

    // ---- long texts ----

    putBlob(kind, ref, text) {
        for (let at = 0, seq = 0; at < text.length; at += CHUNK, seq++) {
            this.sql.exec("INSERT INTO blobs (kind, ref, seq, data) VALUES (?, ?, ?, ?)", kind, ref, seq, text.slice(at, at + CHUNK));
        }
    }

    getBlob(kind, ref) {
        return this.sql.exec("SELECT data FROM blobs WHERE kind = ? AND ref = ? ORDER BY seq", kind, ref).toArray().map((r) => r.data).join("");
    }

    dropBlob(kind, ref) {
        this.sql.exec("DELETE FROM blobs WHERE kind = ? AND ref = ?", kind, ref);
    }

    freshId(table, column, length, alphabet) {
        for (;;) {
            const id = randomString(length, alphabet);
            if (!this.first(`SELECT 1 AS x FROM ${table} WHERE ${column} = ?`, id)) return id;
        }
    }

    // ---- packs ----

    async putPack({ pack, name, count, names, ipKey, userId }) {
        if (typeof pack !== "string" || !pack.startsWith("NSWSPack1")) return fail(400, "That isn't an NSWS track pack.");
        if (pack.length > MAX_PACK) return fail(413, "Those tracks are too big to share as one link (4 MB at most).");
        if (!PACK_TEXT.test(pack)) return fail(400, "That isn't an NSWS track pack.");
        const hash = await sha256Hex(pack);
        const known = this.first("SELECT id FROM packs WHERE hash = ?", hash);
        if (known) return { id: known.id };
        const keys = ["pack:ip:" + ipKey];
        if (userId) keys.push("pack:u:" + userId);
        if (this.overLimit(keys, PACKS_PER_DAY) || this.overBytes(ipKey, pack.length)) return fail(429, "You've made a lot of track links today. Try again tomorrow, or share a pack code instead.");
        const tracks = Math.max(1, Math.min(PACK_TRACKS, Math.floor(Number(count)) || 1));
        const shown = (Array.isArray(names) ? names : []).slice(0, 5).map((n) => moderate(n, MAX_TRACK_NAME)).filter(Boolean);
        const id = this.freshId("packs", "id", 10, ID_ALPHABET);
        this.ctx.storage.transactionSync(() => {
            this.sql.exec("INSERT INTO packs (id, hash, name, count, names, created, size) VALUES (?, ?, ?, ?, ?, ?, ?)",
                id, hash, moderate(name, MAX_TRACK_NAME), tracks, JSON.stringify(shown), Date.now(), pack.length);
            this.putBlob("p", id, pack);
            this.countHit(keys);
            this.countHit(["bytes:ip:" + ipKey], pack.length);
        });
        return { id };
    }

    packInfo(id) {
        if (!PACK_ID.test(id ?? "")) return null;
        const row = this.first("SELECT id, name, count, names, created FROM packs WHERE id = ?", id);
        return row ? { id: row.id, name: row.name, count: row.count, names: JSON.parse(row.names), created: row.created } : null;
    }

    getPack(id) {
        const info = this.packInfo(id);
        if (!info) return null;
        const now = Date.now();
        // At most one write a day per link keeps it from expiring.
        this.sql.exec("UPDATE packs SET opened = ? WHERE id = ? AND COALESCE(opened, created) < ?", now, info.id, now - DAY_MS);
        return { id: info.id, pack: this.getBlob("p", info.id), name: info.name, count: info.count, created: info.created };
    }

    // ---- clubs ----

    member(clubId, userId) {
        return this.first("SELECT user_id, name, role, joined FROM members WHERE club_id = ? AND user_id = ?", clubId, userId);
    }

    memberships(userId) {
        return this.first("SELECT COUNT(*) AS joined, COALESCE(SUM(role = 'owner'), 0) AS owned FROM members WHERE user_id = ?", userId);
    }

    clubView(club, role) {
        const campaigns = this.sql.exec("SELECT id, name, created, updated, summary FROM campaigns WHERE club_id = ? ORDER BY created LIMIT ?",
            club.id, CAMPAIGNS_MAX).toArray().map((c) => ({ id: c.id, name: c.name, created: c.created, updated: c.updated, tracks: JSON.parse(c.summary) }));
        const view = {
            id: club.id, code: club.code, name: club.name, tag: club.tag, description: club.description,
            ownerId: club.owner_id.slice(0, 12), ownerName: club.owner_name, created: club.created,
            memberCount: club.member_count, campaignCount: club.campaign_count, campaigns,
        };
        if (role !== undefined) view.role = role;
        return view;
    }

    clubById(clubId) {
        return HUB_ID.test(clubId ?? "") ? this.first("SELECT * FROM clubs WHERE id = ?", clubId) : null;
    }

    // A club and the caller's place in it, or a failure when the caller's role isn't one of `roles`.
    clubFor(userId, clubId, roles, refusal) {
        const club = this.clubById(clubId);
        if (!club) return { error: fail(404, "That club doesn't exist any more.") };
        const me = this.member(club.id, userId);
        if (!me) return { error: fail(403, "You aren't in that club.") };
        if (roles && !roles.includes(me.role)) return { error: fail(403, refusal) };
        return { club, me };
    }

    // By invite code, or by club id for members only (a new code locks out everyone else).
    getClub(ref, userId) {
        const text = String(ref ?? "").trim();
        const club = HUB_ID.test(text) ? this.clubById(text) : CLUB_CODE.test(text.toUpperCase()) ? this.first("SELECT * FROM clubs WHERE code = ?", text.toUpperCase()) : null;
        if (!club) return null;
        if (HUB_ID.test(text) && !(userId && this.member(club.id, userId))) return null;
        return this.clubView(club, userId ? (this.member(club.id, userId)?.role ?? null) : undefined);
    }

    createClub({ userId, ipKey, nickname, name, tag, description }) {
        const clubName = moderate(name, MAX_CLUB_NAME);
        if (!clubName) return fail(400, "Give the club a name.");
        const cleanedTag = cleanTag(tag);
        if (cleanedTag.error) return cleanedTag;
        const { joined, owned } = this.memberships(userId);
        if (owned >= OWNED_MAX) return fail(409, `You already own ${OWNED_MAX} clubs. Delete one or hand it to someone else first.`);
        if (joined >= JOINED_MAX) return fail(409, `You're in ${JOINED_MAX} clubs already. Leave one first.`);
        const keys = ["club:ip:" + ipKey, "club:u:" + userId];
        if (this.overLimit(keys, CLUBS_PER_DAY)) return fail(429, "You've made a lot of clubs today. Try again tomorrow.");
        const now = Date.now();
        const owner = nick(nickname);
        const club = {
            id: this.freshId("clubs", "id", 12, ID_ALPHABET), code: this.freshId("clubs", "code", 6, CODE_ALPHABET),
            name: clubName, tag: cleanedTag.tag, description: cleanLines(description, MAX_DESCRIPTION),
            owner_id: userId, owner_name: owner, created: now, member_count: 1, campaign_count: 0,
        };
        this.ctx.storage.transactionSync(() => {
            this.sql.exec(`INSERT INTO clubs (id, code, name, tag, description, owner_id, owner_name, created, member_count, campaign_count)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`, club.id, club.code, club.name, club.tag, club.description, userId, owner, now);
            this.sql.exec("INSERT INTO members (club_id, user_id, name, role, joined) VALUES (?, ?, ?, 'owner', ?)", club.id, userId, owner, now);
            this.countHit(keys);
        });
        return { club: this.clubView(club, "owner") };
    }

    joinClub({ userId, ipKey, nickname, code }) {
        const keys = ["join:ip:" + ipKey];
        if (this.overLimit(keys, JOINS_PER_DAY)) return fail(429, "Too many join attempts today. Try again tomorrow.");
        this.countHit(keys);
        const text = String(code ?? "").trim().toUpperCase().replace(/[\s-]/g, "");
        const club = CLUB_CODE.test(text) ? this.first("SELECT * FROM clubs WHERE code = ?", text) : null;
        if (!club) return fail(404, "No club has that code. Check it, or ask for a new invite.");
        const me = this.member(club.id, userId);
        if (me) return { club: this.clubView(club, me.role) };
        if (this.memberships(userId).joined >= JOINED_MAX) return fail(409, `You're in ${JOINED_MAX} clubs already. Leave one to join another.`);
        this.ctx.storage.transactionSync(() => {
            this.sql.exec("INSERT INTO members (club_id, user_id, name, role, joined) VALUES (?, ?, ?, 'member', ?)", club.id, userId, nick(nickname), Date.now());
            this.sql.exec("UPDATE clubs SET member_count = member_count + 1 WHERE id = ?", club.id);
        });
        club.member_count++;
        return { club: this.clubView(club, "member") };
    }

    leaveClub({ userId, clubId }) {
        const { club, me, error } = this.clubFor(userId, clubId);
        if (error) return error;
        if (me.role === "owner") return fail(409, "The owner can't leave. Hand the club to another member or delete it.");
        this.ctx.storage.transactionSync(() => {
            this.sql.exec("DELETE FROM members WHERE club_id = ? AND user_id = ?", club.id, userId);
            this.sql.exec("UPDATE clubs SET member_count = MAX(0, member_count - 1) WHERE id = ?", club.id);
        });
        return { ok: true };
    }

    myClubs({ userId }) {
        const clubs = this.sql.exec(`SELECT c.id, c.code, c.name, c.tag, m.role, c.member_count, c.campaign_count FROM members m
            JOIN clubs c ON c.id = m.club_id WHERE m.user_id = ? ORDER BY m.joined LIMIT ?`, userId, JOINED_MAX + OWNED_MAX).toArray();
        return { clubs: clubs.map((c) => ({ id: c.id, code: c.code, name: c.name, tag: c.tag, role: c.role, memberCount: c.member_count, campaignCount: c.campaign_count })) };
    }

    members({ userId, clubId }) {
        const { club, error } = this.clubFor(userId, clubId);
        if (error) return error;
        const rows = this.sql.exec(`SELECT user_id, name, role, joined FROM members WHERE club_id = ? ORDER BY ${ROLE_ORDER}, joined LIMIT ?`,
            club.id, MEMBERS_LIST).toArray();
        return { members: rows.map((m) => ({ userId: m.user_id.slice(0, 12), name: m.name, role: m.role, joined: m.joined })) };
    }

    updateClub({ userId, clubId, name, tag, description, newCode }) {
        const { club, error } = this.clubFor(userId, clubId, ["owner"], "Only the club's owner can change it.");
        if (error) return error;
        if (name !== undefined) {
            club.name = moderate(name, MAX_CLUB_NAME);
            if (!club.name) return fail(400, "Give the club a name.");
        }
        if (tag !== undefined) {
            const cleaned = cleanTag(tag);
            if (cleaned.error) return cleaned;
            club.tag = cleaned.tag;
        }
        if (description !== undefined) club.description = cleanLines(description, MAX_DESCRIPTION);
        if (newCode === true) club.code = this.freshId("clubs", "code", 6, CODE_ALPHABET);
        this.sql.exec("UPDATE clubs SET name = ?, tag = ?, description = ?, code = ? WHERE id = ?", club.name, club.tag, club.description, club.code, club.id);
        return { club: this.clubView(club, "owner") };
    }

    setRole({ userId, clubId, member, role }) {
        const { club, error } = this.clubFor(userId, clubId, ["owner"], "Only the club's owner can change roles.");
        if (error) return error;
        if (!["admin", "member", "kick", "owner"].includes(role)) return fail(400, "Unknown role.");
        const ref = String(member ?? "").toLowerCase();
        if (!MEMBER_REF.test(ref)) return fail(400, "Pick a member first.");
        // Member ids are shown as the first 12 hex digits, so a prefix range finds the full one.
        const found = this.sql.exec("SELECT user_id, name, role FROM members WHERE club_id = ? AND user_id >= ? AND user_id < ? LIMIT 2",
            club.id, ref, ref + "g").toArray();
        if (found.length !== 1) return fail(404, "That player isn't in the club any more.");
        const target = found[0];
        if (target.user_id === userId) return fail(400, "You can't change your own role.");
        if (role === "kick") {
            this.ctx.storage.transactionSync(() => {
                this.sql.exec("DELETE FROM members WHERE club_id = ? AND user_id = ?", club.id, target.user_id);
                this.sql.exec("UPDATE clubs SET member_count = MAX(0, member_count - 1) WHERE id = ?", club.id);
            });
        } else if (role === "owner") {
            if (this.memberships(target.user_id).owned >= OWNED_MAX) return fail(409, `${target.name} already owns ${OWNED_MAX} clubs.`);
            this.ctx.storage.transactionSync(() => {
                this.sql.exec("UPDATE members SET role = 'owner' WHERE club_id = ? AND user_id = ?", club.id, target.user_id);
                this.sql.exec("UPDATE members SET role = 'admin' WHERE club_id = ? AND user_id = ?", club.id, userId);
                this.sql.exec("UPDATE clubs SET owner_id = ?, owner_name = ? WHERE id = ?", target.user_id, target.name, club.id);
            });
        } else {
            this.sql.exec("UPDATE members SET role = ? WHERE club_id = ? AND user_id = ?", role, club.id, target.user_id);
        }
        return { ok: true };
    }

    deleteClub({ userId, clubId }) {
        const { club, error } = this.clubFor(userId, clubId, ["owner"], "Only the club's owner can delete it.");
        if (error) return error;
        this.ctx.storage.transactionSync(() => {
            this.sql.exec("DELETE FROM campaign_tracks WHERE campaign_id IN (SELECT id FROM campaigns WHERE club_id = ?)", club.id);
            this.sql.exec("DELETE FROM campaigns WHERE club_id = ?", club.id);
            this.sql.exec("DELETE FROM members WHERE club_id = ?", club.id);
            this.sql.exec("DELETE FROM clubs WHERE id = ?", club.id);
        });
        return { ok: true };
    }

    // ---- campaigns ----

    saveCampaign({ userId, ipKey, clubId, campaignId, name, tracks }) {
        const { club, error } = this.clubFor(userId, clubId, ["owner", "admin"], "Only the club's owner and admins can change campaigns.");
        if (error) return error;
        const title = moderate(name, MAX_CAMPAIGN_NAME);
        if (!title) return fail(400, "Give the campaign a name.");
        if (!Array.isArray(tracks)) return fail(400, "The campaign's track list is missing.");
        if (tracks.length > CAMPAIGN_TRACKS) return fail(400, `A campaign holds up to ${CAMPAIGN_TRACKS} tracks.`);
        let total = 0;
        const list = [];
        for (const t of tracks) {
            const code = typeof t?.code === "string" ? t.code.trim() : "";
            if (!code.startsWith("PolyTrack")) return fail(400, "One of the tracks isn't a PolyTrack code.");
            if (code.length > MAX_CAMPAIGN_CODE) return fail(413, "One of the tracks is too big for a campaign (1 MB at most).");
            total += code.length;
            if (total > MAX_CAMPAIGN_TOTAL) return fail(413, "These tracks are too big for one campaign (4 MB at most).");
            list.push({ code, mode: modeOf(t.mode), name: moderate(t.name, MAX_TRACK_NAME) || "Untitled", author: moderate(t.author, MAX_AUTHOR), trackId: trackIdOf(t.trackId) });
        }
        let campaign;
        if (campaignId != null) {
            campaign = HUB_ID.test(campaignId) ? this.first("SELECT id, created FROM campaigns WHERE id = ? AND club_id = ?", campaignId, club.id) : null;
            if (!campaign) return fail(404, "That campaign was deleted.");
        } else if (club.campaign_count >= CAMPAIGNS_MAX) {
            return fail(409, `A club holds up to ${CAMPAIGNS_MAX} campaigns.`);
        }
        const others = this.first(`SELECT COALESCE(SUM(LENGTH(code)), 0) AS n FROM campaign_tracks
            WHERE campaign_id IN (SELECT id FROM campaigns WHERE club_id = ? AND id != ?)`, club.id, campaign?.id ?? "").n;
        if (others + total > CLUB_BYTES_MAX) return fail(413, "This club's campaigns are full (8 MB of tracks at most). Delete a campaign or use smaller tracks.");
        const keys = ["camp:u:" + userId, "camp:ip:" + ipKey];
        if (this.overLimit(keys, CLUB_EDITS_PER_DAY) || this.overBytes(ipKey, total)) return fail(429, "You've saved a lot of campaigns today. Try again tomorrow.");
        const now = Date.now();
        const id = campaign?.id ?? this.freshId("campaigns", "id", 12, ID_ALPHABET);
        const created = campaign?.created ?? now;
        const summary = JSON.stringify(list.map(({ name: n, author, mode, trackId }) => ({ name: n, author, mode, trackId })));
        this.ctx.storage.transactionSync(() => {
            if (campaign) {
                this.sql.exec("DELETE FROM campaign_tracks WHERE campaign_id = ?", id);
                this.sql.exec("UPDATE campaigns SET name = ?, updated = ?, summary = ? WHERE id = ?", title, now, summary, id);
            } else {
                this.sql.exec("INSERT INTO campaigns (id, club_id, name, created, updated, summary) VALUES (?, ?, ?, ?, ?, ?)", id, club.id, title, now, now, summary);
                this.sql.exec("UPDATE clubs SET campaign_count = campaign_count + 1 WHERE id = ?", club.id);
            }
            list.forEach((t, pos) => this.sql.exec("INSERT INTO campaign_tracks (campaign_id, pos, code, mode, name, author, track_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
                id, pos, t.code, t.mode, t.name, t.author, t.trackId));
            this.countHit(keys);
            this.countHit(["bytes:ip:" + ipKey], total);
        });
        return { campaign: { id, clubId: club.id, name: title, created, updated: now, tracks: list } };
    }

    deleteCampaign({ userId, clubId, campaignId }) {
        const { club, error } = this.clubFor(userId, clubId, ["owner", "admin"], "Only the club's owner and admins can delete campaigns.");
        if (error) return error;
        const campaign = HUB_ID.test(campaignId ?? "") ? this.first("SELECT id FROM campaigns WHERE id = ? AND club_id = ?", campaignId, club.id) : null;
        if (!campaign) return fail(404, "That campaign was already deleted.");
        this.ctx.storage.transactionSync(() => {
            this.sql.exec("DELETE FROM campaign_tracks WHERE campaign_id = ?", campaign.id);
            this.sql.exec("DELETE FROM campaigns WHERE id = ?", campaign.id);
            this.sql.exec("UPDATE clubs SET campaign_count = MAX(0, campaign_count - 1) WHERE id = ?", club.id);
        });
        return { ok: true };
    }

    // Members, or anyone holding the club's current invite code.
    getCampaign({ userId, clubId, campaignId, code }) {
        if (!HUB_ID.test(clubId ?? "") || !HUB_ID.test(campaignId ?? "")) return null;
        const club = this.clubById(clubId);
        if (!club) return null;
        const byCode = typeof code === "string" && code.trim().toUpperCase() === club.code;
        if (!byCode && !(userId && this.member(club.id, userId))) return fail(403, "You aren't in that club. Ask for its new code.");
        const c = this.first("SELECT id, club_id, name, created, updated FROM campaigns WHERE id = ? AND club_id = ?", campaignId, clubId);
        if (!c) return null;
        const tracks = this.sql.exec("SELECT code, mode, name, author, track_id FROM campaign_tracks WHERE campaign_id = ? ORDER BY pos", c.id).toArray()
            .map((t) => ({ code: t.code, mode: t.mode, name: t.name, author: t.author, trackId: t.track_id }));
        return { campaign: { id: c.id, clubId: c.club_id, name: c.name, created: c.created, updated: c.updated, tracks } };
    }

    // ---- Race Control submissions ----

    submit({ userId, ipKey, nickname, code, mode, name, author, trackId, env, note }) {
        const text = typeof code === "string" ? code.trim() : "";
        if (!text.startsWith("PolyTrack")) return fail(400, "That isn't a PolyTrack track code.");
        if (text.length > MAX_SUBMISSION) return fail(413, "That track is too big to send (2 MB at most).");
        const waiting = this.first("SELECT COUNT(*) AS n FROM submissions WHERE user_id = ? AND status = 'new'", userId).n;
        if (waiting >= SUBMITS_WAITING) return fail(409, `You have ${SUBMITS_WAITING} tracks waiting for Race Control already. Wait until some are looked at.`);
        const keys = ["sub:ip:" + ipKey, "sub:u:" + userId];
        if (this.overLimit(keys, SUBMITS_PER_DAY) || this.overBytes(ipKey, text.length)) return fail(429, `You can send ${SUBMITS_PER_DAY} tracks a day. Try again tomorrow.`);
        const id = this.freshId("submissions", "id", 12, ID_ALPHABET);
        this.ctx.storage.transactionSync(() => {
            this.sql.exec(`INSERT INTO submissions (id, user_id, nickname, name, author, track_id, env, mode, note, created, status, week, owner_note, size)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', NULL, '', ?)`, id, userId, nick(nickname), moderate(name, MAX_TRACK_NAME) || "Untitled",
                moderate(author, MAX_AUTHOR), trackIdOf(trackId), moderate(env, MAX_ENV), modeOf(mode), cleanLines(note, MAX_NOTE), Date.now(), text.length);
            this.putBlob("s", id, text);
            this.countHit(keys);
            this.countHit(["bytes:ip:" + ipKey], text.length);
        });
        return { ok: true, id };
    }

    libraryList({ userId }) {
        const rows = this.sql.exec("SELECT id, meta, size, updated FROM library WHERE user_id = ? LIMIT ?", userId, LIB_TRACKS).toArray();
        let used = 0;
        const tracks = rows.map((r) => {
            used += r.size;
            let meta = {};
            try {
                meta = JSON.parse(r.meta);
            } catch {}
            return { ...meta, id: r.id, updated: r.updated };
        });
        return { tracks, used, maxBytes: LIB_BYTES, maxTracks: LIB_TRACKS };
    }

    libraryCodes({ userId, ids }) {
        if (!Array.isArray(ids) || ids.length > LIB_BATCH) return fail(400, "Bad request.");
        const codes = {};
        for (const id of ids) {
            if (typeof id !== "string" || !LIB_ID.test(id)) continue;
            if (!this.first("SELECT 1 AS x FROM library WHERE user_id = ? AND id = ?", userId, id)) continue;
            codes[id] = this.getBlob("l", userId + ":" + id);
        }
        return { codes };
    }

    libraryPut({ userId, ipKey, tracks }) {
        if (!Array.isArray(tracks) || !tracks.length || tracks.length > LIB_BATCH) return fail(400, "Bad request.");
        const usage = this.first("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM library WHERE user_id = ?", userId);
        let count = usage.n, bytes = usage.bytes, fresh = 0;
        const rows = [];
        for (const t of tracks) {
            if (!t || typeof t.id !== "string" || !LIB_ID.test(t.id)) return fail(400, "Bad request.");
            const old = this.first("SELECT size FROM library WHERE user_id = ? AND id = ?", userId, t.id);
            const code = typeof t.code === "string" ? t.code.trim() : null;
            if (code != null && (!code.startsWith("PolyTrack") || code.length > LIB_CODE_MAX)) return fail(400, "One of those tracks can't be saved to your account (2 MB at most).");
            if (code == null && !old) return fail(400, "Bad request.");
            const meta = JSON.stringify(t.meta && typeof t.meta === "object" ? t.meta : {});
            if (meta.length > LIB_META_MAX) return fail(400, "Bad request.");
            if (!old) count++;
            if (code != null) {
                bytes += code.length - (old?.size ?? 0);
                fresh += code.length;
            }
            rows.push({ id: t.id, code, meta, size: code != null ? code.length : old.size, updated: Number.isSafeInteger(t.updated) ? t.updated : Date.now() });
        }
        if (count > LIB_TRACKS) return fail(409, `Your account holds ${LIB_TRACKS} tracks at most. Delete some first.`);
        if (bytes > LIB_BYTES) return fail(409, "Your account's track space is full (30 MB). Delete some tracks first.");
        if (fresh && this.overBytes(ipKey, fresh)) return fail(429, "That's a lot of tracks for one day. Try again tomorrow.");
        this.ctx.storage.transactionSync(() => {
            for (const r of rows) {
                this.sql.exec(`INSERT INTO library (user_id, id, meta, size, updated) VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT (user_id, id) DO UPDATE SET meta = excluded.meta, size = excluded.size, updated = excluded.updated`,
                    userId, r.id, r.meta, r.size, r.updated);
                if (r.code != null) {
                    this.dropBlob("l", userId + ":" + r.id);
                    this.putBlob("l", userId + ":" + r.id, r.code);
                }
            }
            if (fresh) this.countHit(["bytes:ip:" + ipKey], fresh);
        });
        return { ok: true, used: bytes };
    }

    libraryDelete({ userId, ids }) {
        if (!Array.isArray(ids) || ids.length > LIB_BATCH) return fail(400, "Bad request.");
        this.ctx.storage.transactionSync(() => {
            for (const id of ids) {
                if (typeof id !== "string" || !LIB_ID.test(id)) continue;
                this.sql.exec("DELETE FROM library WHERE user_id = ? AND id = ?", userId, id);
                this.dropBlob("l", userId + ":" + id);
            }
        });
        return { ok: true };
    }

    mySubmissions({ userId }) {
        const rows = this.sql.exec("SELECT id, name, mode, status, week, created, owner_note FROM submissions WHERE user_id = ? ORDER BY created DESC LIMIT ?",
            userId, MY_SUBMISSIONS).toArray();
        return { submissions: rows.map((s) => ({ id: s.id, name: s.name, mode: s.mode, status: s.status, week: s.week, created: s.created, ownerNote: s.owner_note })) };
    }

    adminSubmissions(status) {
        const rows = STATUSES.has(status)
            ? this.sql.exec("SELECT * FROM submissions WHERE status = ? ORDER BY created DESC LIMIT ?", status, ADMIN_LIST).toArray()
            : this.sql.exec("SELECT * FROM submissions ORDER BY created DESC LIMIT ?", ADMIN_LIST).toArray();
        return { submissions: rows.map(submissionView) };
    }

    adminSubmission(id) {
        const row = HUB_ID.test(id ?? "") ? this.first("SELECT * FROM submissions WHERE id = ?", id) : null;
        if (!row) return fail(404, "That submission was deleted.");
        return { submission: { ...submissionView(row), code: this.getBlob("s", row.id) } };
    }

    adminSetStatus(id, { status, week, ownerNote }) {
        const row = HUB_ID.test(id ?? "") ? this.first("SELECT * FROM submissions WHERE id = ?", id) : null;
        if (!row) return fail(404, "That submission was deleted.");
        if (!STATUSES.has(status)) return fail(400, "Unknown status.");
        let planned = row.week;
        if (week !== undefined) {
            if (week === null || week === "") planned = null;
            else if (Number.isInteger(Number(week)) && Number(week) >= 1 && Number(week) <= 9999) planned = Number(week);
            else return fail(400, "The week must be a whole number.");
        }
        const note = ownerNote === undefined ? row.owner_note : cleanLines(String(ownerNote ?? ""), MAX_NOTE);
        this.sql.exec("UPDATE submissions SET status = ?, week = ?, owner_note = ? WHERE id = ?", status, planned, note, row.id);
        return { submission: submissionView({ ...row, status, week: planned, owner_note: note }) };
    }

    adminDelete(id) {
        if (!HUB_ID.test(id ?? "")) return fail(404, "That submission was already deleted.");
        this.ctx.storage.transactionSync(() => {
            this.sql.exec("DELETE FROM submissions WHERE id = ?", id);
            this.dropBlob("s", id);
        });
        return { ok: true };
    }
}

function submissionView(s) {
    return {
        id: s.id, name: s.name, author: s.author, trackId: s.track_id, env: s.env, mode: s.mode, note: s.note,
        nickname: s.nickname, userId12: s.user_id.slice(0, 12), created: s.created, status: s.status, week: s.week,
        ownerNote: s.owner_note, size: s.size,
    };
}
