// Anti-cheat for Not So Weekly Shorts boards (PROXY.md, "Anti-cheat"). A run shows only if
// the game's own physics, replaying its inputs, crosses every checkpoint and the finish on
// the frame it claims, and only if it reached Kodub through this proxy. Runs already on a
// board the first time it is seen here ("legacy") stay up while they are checked once in
// the background. The owner's runs skip every check.

import { DurableObject } from "cloudflare:workers";
import physicsModule from "./sim/physics.wasm";
import mathModule from "./sim/math.wasm";
import initData from "./sim/init.bin";
import { Simulator, readInit } from "./sim/run-check.js";
import { MACRO_LOCK_MS } from "./macro.js";
import { inputFlags } from "./inputflags.js";

const CHECK_BATCH = 8;
// 5 Kodub reads at once. Kodub refuses more than about 10 ids in one read.
const SCAN_RUNS = 5 * CHECK_BATCH;
const RETRY_MS = 60_000;
const LOG_LIMIT = 60;
// The Workers KV key (binding FALLBACK) for the verdicts the Worker uses while Cloudflare refuses
// Durable Object calls. Valid runs newer than this are listed by id, so a run the proxy passed
// shortly before the limit still shows.
export const SNAPSHOT_KEY = "anticheat-verdicts";
const SNAPSHOT_OK_WINDOW_MS = 2 * 86_400_000;

function hex(buffer) {
    return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

export class RunChecker extends DurableObject {
    async check(track, recording, frames) {
        this.simulator ??= new Simulator(physicsModule, mathModule, readInit(initData));
        return this.simulator.check(track, recording, frames);
    }
}

export class AntiCheat extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.sql = ctx.storage.sql;
        // track id -> { cutoff, runs: Map(id -> { state, source }), passes: Map("user|frames" -> state) }
        this.boards = new Map();
        this.payloads = new Map();
        // Tracks already in snap_dirty since this object woke.
        this.dirty = new Set();
        ctx.blockConcurrencyWhile(async () => {
            this.migrate();
            await this.recheckRocket();
        });
    }

    migrate() {
        this.sql.exec("CREATE TABLE IF NOT EXISTS macro_locks (user_id TEXT PRIMARY KEY, until INTEGER NOT NULL) WITHOUT ROWID");
        this.sql.exec(`CREATE TABLE IF NOT EXISTS tracks (
            id TEXT PRIMARY KEY, week INTEGER, payload TEXT NOT NULL, updated INTEGER NOT NULL)`);
        this.sql.exec(`CREATE TABLE IF NOT EXISTS boards (
            track TEXT PRIMARY KEY, week INTEGER, cutoff INTEGER NOT NULL, seen INTEGER NOT NULL)`);
        // state: valid | invalid | pending. source: proxy | legacy | outside | approved.
        this.sql.exec(`CREATE TABLE IF NOT EXISTS runs (
            id INTEGER PRIMARY KEY, track TEXT NOT NULL, week INTEGER, user_id TEXT, nickname TEXT,
            frames INTEGER, state TEXT NOT NULL, source TEXT NOT NULL, reason TEXT, at INTEGER NOT NULL)`);
        this.sql.exec("CREATE INDEX IF NOT EXISTS runs_track ON runs(track)");
        // Runs this proxy let through, recorded before they are sent so a board read can't
        // mistake them for outside uploads.
        this.sql.exec(`CREATE TABLE IF NOT EXISTS passes (
            track TEXT NOT NULL, user_id TEXT NOT NULL, frames INTEGER NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL,
            PRIMARY KEY (track, user_id, frames)) WITHOUT ROWID`);
        this.sql.exec(`CREATE TABLE IF NOT EXISTS rejects (
            key TEXT PRIMARY KEY, track TEXT, week INTEGER, user_id TEXT, nickname TEXT, frames INTEGER,
            reason TEXT, first INTEGER NOT NULL, last INTEGER NOT NULL, attempts INTEGER NOT NULL)`);
        this.sql.exec(`CREATE TABLE IF NOT EXISTS queue (
            qid INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, track TEXT NOT NULL, week INTEGER,
            user_id TEXT, nickname TEXT, frames INTEGER NOT NULL, recording TEXT, added INTEGER NOT NULL)`);
        // Personal bests set in a multiplayer lobby, kept for the owner to watch. state: review |
        // verified | hidden. The recording is dropped once the owner has decided.
        this.sql.exec(`CREATE TABLE IF NOT EXISTS lobby_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT, upload_id INTEGER, track TEXT NOT NULL, week INTEGER,
            user_id TEXT, nickname TEXT, frames INTEGER NOT NULL, lobby TEXT, car_style TEXT, recording TEXT,
            state TEXT NOT NULL DEFAULT 'review', at INTEGER NOT NULL)`);
        this.sql.exec("CREATE INDEX IF NOT EXISTS lobby_runs_state ON lobby_runs(state, at)");
        this.sql.exec("CREATE INDEX IF NOT EXISTS lobby_runs_track ON lobby_runs(track)");
        this.sql.exec("CREATE INDEX IF NOT EXISTS runs_state_at ON runs(state, at)");
        this.sql.exec("CREATE INDEX IF NOT EXISTS rejects_last ON rejects(last)");
        // top: the newest run id seen on the board. A run above it was never checked.
        try {
            this.sql.exec("ALTER TABLE boards ADD COLUMN top INTEGER");
            this.sql.exec("UPDATE boards SET top = (SELECT MAX(id) FROM runs WHERE runs.track = boards.track)");
        } catch {
            /* already added */
        }
        // achieved: when a run that waited out a server outage on the player's device was really set.
        // tie_id: where it sorts among equal times, in place of its own (later) upload id.
        // uploaded: when a run came through this proxy; NULL for runs from before this column.
        try {
            this.sql.exec("ALTER TABLE runs ADD COLUMN achieved INTEGER");
            this.sql.exec("ALTER TABLE runs ADD COLUMN tie_id INTEGER");
            this.sql.exec("ALTER TABLE runs ADD COLUMN uploaded INTEGER");
        } catch {
            /* already added */
        }
        this.sql.exec("CREATE INDEX IF NOT EXISTS runs_achieved ON runs(achieved) WHERE achieved IS NOT NULL");
        // flags: why inputflags.js flagged the run. NULL = not flagged, "" = the owner cleared it.
        try {
            this.sql.exec("ALTER TABLE runs ADD COLUMN flags TEXT");
        } catch {
            /* already added */
        }
        this.sql.exec("CREATE INDEX IF NOT EXISTS runs_flagged ON runs(track) WHERE flags != ''");
        this.migrateTallies();
        // Each board's part of the KV snapshot, rebuilt only when that board changes ("" in snap_dirty =
        // the track weeks). Rebuilding all of them on every cron read the whole runs table each time.
        const fresh = !this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'snap_tracks'").toArray().length;
        this.sql.exec("CREATE TABLE IF NOT EXISTS snap_tracks (track TEXT PRIMARY KEY, part TEXT NOT NULL) WITHOUT ROWID");
        this.sql.exec("CREATE TABLE IF NOT EXISTS snap_dirty (track TEXT PRIMARY KEY) WITHOUT ROWID");
        if (fresh) {
            this.sql.exec(`INSERT OR IGNORE INTO snap_dirty (track) SELECT track FROM boards UNION SELECT DISTINCT track FROM runs
                WHERE state != 'valid' OR achieved IS NOT NULL UNION SELECT DISTINCT track FROM lobby_runs UNION SELECT ''`);
        }
    }

    touch(track) {
        if (this.dirty.has(track)) return;
        this.dirty.add(track);
        this.sql.exec("INSERT OR IGNORE INTO snap_dirty (track) VALUES (?)", track);
    }

    // Once (2026-10-28): week 11's Rocket League runs failed when the page saved the wrong physics version or none, which
    // the checker now tries past. Its failed board runs are checked again and its refused uploads may be sent again.
    async recheckRocket() {
        if (await this.ctx.storage.get("recheck-rocket-1")) return;
        this.sql.exec(`INSERT INTO queue (run_id, track, week, user_id, nickname, frames, recording, added)
            SELECT id, track, week, user_id, nickname, frames, NULL, ? FROM runs
            WHERE week = 11 AND state = 'invalid' AND reason = 'no-finish'`, Date.now());
        this.sql.exec("DELETE FROM rejects WHERE week = 11 AND reason = 'no-finish'");
        await this.ctx.storage.put("recheck-rocket-1", true);
        await this.kick();
    }

    // The dashboard's totals. Counting the tables on every refresh read every row each time, which
    // used up the free plan's daily reads, so triggers keep the counts instead.
    migrateTallies() {
        const fresh = !this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tallies'").toArray().length;
        const bump = (key, by) => `INSERT INTO tallies (k, n) VALUES (${key}, ${by}) ON CONFLICT(k) DO UPDATE SET n = n + excluded.n;`;
        const run = (row) => `'run|' || ${row}.source || '|' || ${row}.state`;
        const lobby = (row) => `'lobby|' || ${row}.state`;
        this.ctx.storage.transactionSync(() => {
            this.sql.exec("CREATE TABLE IF NOT EXISTS tallies (k TEXT PRIMARY KEY, n INTEGER NOT NULL) WITHOUT ROWID");
            this.sql.exec(`CREATE TRIGGER IF NOT EXISTS runs_tally_add AFTER INSERT ON runs BEGIN ${bump(run("NEW"), 1)} END`);
            this.sql.exec(`CREATE TRIGGER IF NOT EXISTS runs_tally_move AFTER UPDATE OF source, state ON runs
                WHEN OLD.source IS NOT NEW.source OR OLD.state IS NOT NEW.state BEGIN ${bump(run("OLD"), -1)} ${bump(run("NEW"), 1)} END`);
            this.sql.exec(`CREATE TRIGGER IF NOT EXISTS runs_tally_drop AFTER DELETE ON runs BEGIN ${bump(run("OLD"), -1)} END`);
            this.sql.exec(`CREATE TRIGGER IF NOT EXISTS rejects_tally_add AFTER INSERT ON rejects BEGIN
                ${bump("'rejects'", 1)} ${bump("'reject_attempts'", "NEW.attempts")} END`);
            this.sql.exec(`CREATE TRIGGER IF NOT EXISTS rejects_tally_attempts AFTER UPDATE OF attempts ON rejects BEGIN
                ${bump("'reject_attempts'", "NEW.attempts - OLD.attempts")} END`);
            this.sql.exec(`CREATE TRIGGER IF NOT EXISTS rejects_tally_drop AFTER DELETE ON rejects BEGIN
                ${bump("'rejects'", -1)} ${bump("'reject_attempts'", "-OLD.attempts")} END`);
            this.sql.exec(`CREATE TRIGGER IF NOT EXISTS boards_tally_add AFTER INSERT ON boards BEGIN ${bump("'boards'", 1)} END`);
            this.sql.exec(`CREATE TRIGGER IF NOT EXISTS boards_tally_drop AFTER DELETE ON boards BEGIN ${bump("'boards'", -1)} END`);
            this.sql.exec(`CREATE TRIGGER IF NOT EXISTS lobby_tally_add AFTER INSERT ON lobby_runs BEGIN ${bump(lobby("NEW"), 1)} END`);
            this.sql.exec(`CREATE TRIGGER IF NOT EXISTS lobby_tally_move AFTER UPDATE OF state ON lobby_runs
                WHEN OLD.state IS NOT NEW.state BEGIN ${bump(lobby("OLD"), -1)} ${bump(lobby("NEW"), 1)} END`);
            this.sql.exec(`CREATE TRIGGER IF NOT EXISTS lobby_tally_drop AFTER DELETE ON lobby_runs BEGIN ${bump(lobby("OLD"), -1)} END`);
            if (!fresh) return;
            this.sql.exec("INSERT INTO tallies (k, n) SELECT 'run|' || source || '|' || state, COUNT(*) FROM runs GROUP BY source, state");
            this.sql.exec("INSERT INTO tallies (k, n) SELECT 'lobby|' || state, COUNT(*) FROM lobby_runs GROUP BY state");
            this.sql.exec("INSERT INTO tallies (k, n) SELECT 'rejects', COUNT(*) FROM rejects");
            this.sql.exec("INSERT INTO tallies (k, n) SELECT 'reject_attempts', COALESCE(SUM(attempts), 0) FROM rejects");
            this.sql.exec("INSERT INTO tallies (k, n) SELECT 'boards', COUNT(*) FROM boards");
        });
    }

    board(track, week, entries) {
        let board = this.boards.get(track);
        if (board) return board;
        let row = this.sql.exec("SELECT cutoff, top FROM boards WHERE track = ?", track).toArray()[0];
        if (!row) {
            // Everything on the board the first time it is seen here counts as legacy.
            const cutoff = entries.reduce((max, e) => (Number.isSafeInteger(e.id) && e.id > max ? e.id : max), 0);
            this.sql.exec("INSERT OR IGNORE INTO boards (track, week, cutoff, seen) VALUES (?, ?, ?, ?)", track, week, cutoff, Date.now());
            row = this.sql.exec("SELECT cutoff, top FROM boards WHERE track = ?", track).one();
        }
        board = { cutoff: row.cutoff, top: Math.max(row.cutoff, row.top ?? 0), runs: new Map(), passes: new Map(), holds: new Set() };
        for (const r of this.sql.exec("SELECT id, state, source FROM runs WHERE track = ?", track)) {
            board.runs.set(r.id, { state: r.state, source: r.source });
        }
        for (const p of this.sql.exec("SELECT user_id, frames, state FROM passes WHERE track = ?", track)) {
            board.passes.set(p.user_id + "|" + p.frames, p.state);
        }
        for (const h of this.sql.exec("SELECT user_id, frames, upload_id FROM lobby_runs WHERE track = ? AND state != 'verified'", track)) {
            for (const key of this.holdKeys(h)) board.holds.add(key);
        }
        this.boards.set(track, board);
        return board;
    }

    saveRun(track, week, entry, state, source, reason, uploaded = null) {
        // An upsert, not INSERT OR REPLACE: a replace deletes the old row without firing the tally trigger.
        this.sql.exec(`INSERT INTO runs (id, track, week, user_id, nickname, frames, state, source, reason, at, uploaded)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET track = excluded.track, week = excluded.week, user_id = excluded.user_id,
                nickname = excluded.nickname, frames = excluded.frames, state = excluded.state, source = excluded.source,
                reason = excluded.reason, at = excluded.at, uploaded = COALESCE(runs.uploaded, excluded.uploaded)`,
            entry.id, track, week, entry.userId ?? null, entry.nickname ?? null, entry.frames, state, source, reason ?? null, Date.now(), uploaded);
        this.touch(track);
        const run = { state, source };
        this.boards.get(track)?.runs.set(entry.id, run);
        return run;
    }

    enqueue(runId, track, week, entry, recording) {
        this.sql.exec(`INSERT INTO queue (run_id, track, week, user_id, nickname, frames, recording, added)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            runId, track, week, entry.userId ?? null, entry.nickname ?? null, entry.frames, recording ?? null, Date.now());
    }

    // Ids of the entries on this board that must not be shown.
    async classify(track, week, entries, ownerUserIds) {
        const owners = new Set(ownerUserIds);
        const board = this.board(track, week, entries);
        const blocked = [];
        let queued = false;
        for (const e of entries) {
            if (!Number.isSafeInteger(e.id) || e.id <= 0 || owners.has(e.userId)) continue;
            let run = board.runs.get(e.id);
            if (!run) {
                const pass = board.passes.get(e.userId + "|" + e.frames);
                if (pass) {
                    run = this.saveRun(track, week, e, pass, "proxy");
                } else if (e.id <= board.cutoff) {
                    run = this.saveRun(track, week, e, "pending", "legacy");
                    this.enqueue(e.id, track, week, e, null);
                    queued = true;
                } else {
                    run = this.saveRun(track, week, e, "invalid", "outside", "not-uploaded-here");
                }
            }
            const held = board.holds.has(e.userId + "|" + e.frames) || board.holds.has("#" + e.id);
            if (held || run.state === "invalid" || (run.state === "pending" && run.source !== "legacy")) blocked.push(e.id);
        }
        const top = entries.reduce((max, e) => (Number.isSafeInteger(e.id) && e.id > max ? e.id : max), board.top);
        if (top > board.top) {
            board.top = top;
            this.sql.exec("UPDATE boards SET top = ? WHERE track = ?", top, track);
            this.touch(track);
        }
        if (queued) await this.kick();
        return blocked;
    }

    // Saved to KV when it has changed: per board, the newest run seen, the runs to hide, the lobby holds,
    // and valid runs newer than the newest seen; each track's week; and the WR holders Accounts knows
    // (wrs, passed in by the Worker's cron). Leaderboards read it first, and fall back on it while
    // Durable Objects are refused.
    async saveSnapshot(wrs) {
        this.wrsText ??= (await this.ctx.storage.get("snapshotWrs")) ?? "{}";
        if (wrs && typeof wrs === "object") {
            const text = JSON.stringify(wrs);
            if (text !== this.wrsText) {
                this.wrsText = text;
                await this.ctx.storage.put("snapshotWrs", text);
                this.touch("");
            }
        }
        if (!this.env.FALLBACK) return { saved: false };
        // Taken off the list before anything is awaited, so a change made meanwhile marks its track again.
        const dirty = this.sql.exec("DELETE FROM snap_dirty RETURNING track").toArray().map((r) => r.track);
        if (!dirty.length) return { saved: false };
        this.dirty.clear();
        try {
            for (const track of dirty) if (track) this.snapshotPart(track);
            const tracks = {};
            for (const r of this.sql.exec("SELECT track, part FROM snap_tracks")) tracks[r.track] = JSON.parse(r.part);
            const weeks = Object.fromEntries((await this.trackWeeks()).map(([id, week]) => [id, week]));
            const wrsSaved = JSON.parse(this.wrsText);
            const body = JSON.stringify({ tracks, weeks, wrs: wrsSaved });
            const hash = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
            if (hash === await this.ctx.storage.get("snapshotHash")) return { saved: false };
            await this.env.FALLBACK.put(SNAPSHOT_KEY, JSON.stringify({ at: Date.now(), tracks, weeks, wrs: wrsSaved }));
            await this.ctx.storage.put("snapshotHash", hash);
            return { saved: true, bytes: body.length };
        } catch (err) {
            for (const track of dirty) this.touch(track);
            throw err;
        }
    }

    // One board's part: the newest run seen, the runs to hide, the lobby holds, valid runs newer than
    // the newest seen, and runs set during an outage and uploaded after it ([id, tie id, achieved,
    // nickname, frames, week]).
    snapshotPart(track) {
        const board = this.sql.exec("SELECT MAX(cutoff, COALESCE(top, 0)) AS top FROM boards WHERE track = ?", track).toArray()[0];
        const part = { top: board?.top ?? 0, blocked: [], holds: [], ok: [] };
        const okSince = Date.now() - SNAPSHOT_OK_WINDOW_MS;
        for (const r of this.sql.exec("SELECT id, week, nickname, frames, state, source, at, achieved, tie_id FROM runs WHERE track = ?", track)) {
            if (r.state === "invalid" || (r.state === "pending" && r.source !== "legacy")) part.blocked.push(r.id);
            else if (r.state === "valid" && r.at > okSince && r.id > part.top) part.ok.push(r.id);
            if (r.achieved != null && r.state !== "invalid") {
                (part.late ??= []).push([r.id, r.tie_id ?? r.id, r.achieved, r.nickname ?? "", r.frames, r.week]);
            }
        }
        for (const r of this.sql.exec("SELECT user_id, frames, upload_id FROM lobby_runs WHERE track = ? AND state IN ('review', 'hidden')", track)) {
            part.holds.push(...this.holdKeys(r));
        }
        const empty = !board && !part.blocked.length && !part.ok.length && !part.holds.length && !part.late;
        if (empty) this.sql.exec("DELETE FROM snap_tracks WHERE track = ?", track);
        else this.sql.exec("INSERT INTO snap_tracks (track, part) VALUES (?, ?) ON CONFLICT(track) DO UPDATE SET part = excluded.part", track, JSON.stringify(part));
    }

    payload(track) {
        if (this.payloads.has(track)) return this.payloads.get(track);
        const row = this.sql.exec("SELECT payload FROM tracks WHERE id = ?", track).toArray()[0];
        const payload = row ? JSON.parse(row.payload) : null;
        if (payload) this.payloads.set(track, payload);
        return payload;
    }

    // Before a submission is checked: a run already rejected is refused without replaying it.
    async prepareSubmit(track, key, userId) {
        const rejected = this.sql.exec("SELECT 1 FROM rejects WHERE key = ?", key).toArray().length > 0;
        if (rejected) {
            this.sql.exec("UPDATE rejects SET attempts = attempts + 1, last = ? WHERE key = ?", Date.now(), key);
            return { rejected: true, payload: null };
        }
        return { rejected: false, payload: this.payload(track), macroLeft: this.macroLeft(userId) };
    }

    macroLeft(userId) {
        const until = this.sql.exec("SELECT until FROM macro_locks WHERE user_id = ?", userId ?? "").toArray()[0]?.until ?? 0;
        return Math.max(0, until - Date.now());
    }

    startMacroLock(userId) {
        const now = Date.now();
        this.sql.exec("DELETE FROM macro_locks WHERE until <= ?", now);
        this.sql.exec("INSERT OR REPLACE INTO macro_locks (user_id, until) VALUES (?, ?)", userId, now + MACRO_LOCK_MS);
        return MACRO_LOCK_MS;
    }

    // The page's detector said so. Only the player's own token gets here, so this can only lock themselves out. A new flag
    // late in a lockout starts it again, or the page would wait 5 minutes while uploads opened in seconds.
    async macroReport(userId, nickname, reason) {
        const left = this.macroLeft(userId);
        if (left > MACRO_LOCK_MS - 60_000) return { left };
        if (!left) await this.reject({ key: "macro|" + userId + "|" + Date.now(), track: null, week: null, userId, nickname, frames: null, reason: "macro-" + reason });
        return { left: this.startMacroLock(userId) };
    }

    // The upload check said so, from the run's own inputs.
    async macroUpload(r) {
        await this.reject(r);
        return this.macroLeft(r.userId) || this.startMacroLock(r.userId);
    }

    async reject(r) {
        const now = Date.now();
        this.sql.exec(`INSERT INTO rejects (key, track, week, user_id, nickname, frames, reason, first, last, attempts)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
            ON CONFLICT(key) DO UPDATE SET attempts = attempts + 1, last = excluded.last`,
            r.key, r.track, r.week, r.userId, r.nickname, r.frames, r.reason, now, now);
    }

    // Called before the run is sent upstream. state is "valid", or "pending" when the track
    // hasn't been synced yet and the run will be checked once it is.
    async expect(r) {
        this.sql.exec(`INSERT INTO passes (track, user_id, frames, state, at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(track, user_id, frames) DO UPDATE SET state = excluded.state, at = excluded.at`,
            r.track, r.userId, r.frames, r.state, Date.now());
        this.boards.get(r.track)?.passes.set(r.userId + "|" + r.frames, r.state);
    }

    async confirm(r) {
        const entry = { id: r.uploadId, userId: r.userId, nickname: r.nickname, frames: r.frames };
        if (Number.isSafeInteger(r.uploadId) && r.uploadId > 0) {
            const now = Date.now();
            this.saveRun(r.track, r.week, entry, r.state, "proxy", null, now);
            if (r.flags) this.sql.exec("UPDATE runs SET flags = ? WHERE id = ?", r.flags, r.uploadId);
            if (Number.isSafeInteger(r.achieved) && r.achieved < now) this.backdate(r, now);
        }
        if (r.state === "pending") {
            this.enqueue(Number.isSafeInteger(r.uploadId) ? r.uploadId : null, r.track, r.week, entry, r.recording);
            await this.kick();
        }
    }

    // A run uploaded late but set at r.achieved goes ahead of every equal time set after it. Upload ids only
    // grow with time, so it takes the place of the earliest such run (tie_id) and orders by achieved within it.
    backdate(r, now) {
        const row = this.sql.exec(`SELECT MIN(COALESCE(tie_id, id)) AS tie FROM runs WHERE track = ? AND frames = ?
            AND id != ? AND COALESCE(user_id, '') != ? AND state != 'invalid' AND COALESCE(achieved, uploaded, 0) > ?`,
            r.track, r.frames, r.uploadId, r.userId ?? "", r.achieved).one();
        const tie = Number.isSafeInteger(row.tie) && row.tie < r.uploadId ? row.tie : r.uploadId;
        this.sql.exec("UPDATE runs SET achieved = ?, tie_id = ? WHERE id = ?", r.achieved, tie, r.uploadId);
        this.touch(r.track);
    }

    async kick() {
        if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + 100);
    }

    async fetchRecordings(ids) {
        const found = new Map();
        if (!ids.length) return found;
        const upstream = this.env.UPSTREAM || "https://vps.kodub.com";
        const origin = this.env.UPSTREAM_ORIGIN || "https://www.kodub.com";
        const url = new URL("/v6/recordings", upstream);
        url.searchParams.set("version", "0.6.2");
        url.searchParams.set("ids", ids.join(","));
        const response = await fetch(url.toString(), { headers: { Origin: origin, Referer: origin + "/" } });
        if (!response.ok) throw new Error("recordings " + response.status);
        const list = await response.json();
        if (!Array.isArray(list)) throw new Error("recordings: not a list");
        ids.forEach((id, i) => found.set(id, typeof list[i]?.recording === "string" ? list[i].recording : null));
        return found;
    }

    finish(item, result) {
        this.touch(item.track);
        const state = result.valid ? "valid" : "invalid";
        if (item.run_id != null) {
            this.sql.exec("UPDATE runs SET state = ?, reason = ?, at = ? WHERE id = ?", state, result.reason ?? null, Date.now(), item.run_id);
            const run = this.boards.get(item.track)?.runs.get(item.run_id);
            if (run) run.state = state;
        }
        if (item.user_id) {
            if (result.valid) {
                this.sql.exec("UPDATE passes SET state = 'valid' WHERE track = ? AND user_id = ? AND frames = ?", item.track, item.user_id, item.frames);
            } else {
                this.sql.exec("DELETE FROM passes WHERE track = ? AND user_id = ? AND frames = ?", item.track, item.user_id, item.frames);
            }
            const passes = this.boards.get(item.track)?.passes;
            const key = item.user_id + "|" + item.frames;
            if (passes?.has(key)) result.valid ? passes.set(key, "valid") : passes.delete(key);
        }
        this.sql.exec("DELETE FROM queue WHERE qid = ?", item.qid);
    }

    async alarm() {
        const items = this.sql.exec(`SELECT * FROM queue WHERE track IN (SELECT id FROM tracks)
            ORDER BY qid LIMIT ?`, CHECK_BATCH).toArray();
        if (!items.length) return;
        let recordings;
        try {
            recordings = await this.fetchRecordings(items.filter((i) => i.recording == null && i.run_id != null).map((i) => i.run_id));
        } catch (err) {
            console.error("anti-cheat: fetching recordings failed:", err && err.message);
            await this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
            return;
        }
        const checker = this.env.RUN_CHECKER.get(this.env.RUN_CHECKER.idFromName("main"));
        for (const item of items) {
            const recording = item.recording ?? recordings.get(item.run_id) ?? null;
            const result = recording == null
                ? { valid: false, reason: "no-recording" }
                : await checker.check(this.payload(item.track), recording, item.frames);
            this.finish(item, result);
        }
        await this.ctx.storage.setAlarm(Date.now() + 50);
    }

    // [track id, week] for every synced NSWS track.
    async trackWeeks() {
        this.weeks ??= this.sql.exec("SELECT id, week FROM tracks").toArray().map((r) => [r.id, r.week]);
        return this.weeks;
    }

    async putTracks(tracks) {
        const now = Date.now();
        this.weeks = null;
        this.touch("");
        for (const t of tracks) {
            this.sql.exec(`INSERT INTO tracks (id, week, payload, updated) VALUES (?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET week = excluded.week, payload = excluded.payload, updated = excluded.updated`,
                t.id, t.week, JSON.stringify(t.payload), now);
            this.payloads.delete(t.id);
        }
        await this.kick();
        return { stored: tracks.length };
    }

    holdKeys(row) {
        const keys = [];
        if (row.user_id) keys.push(row.user_id + "|" + row.frames);
        if (row.upload_id != null) keys.push("#" + row.upload_id);
        return keys;
    }

    // A lobby PB stays off the boards from before it is uploaded until the owner verifies it.
    async lobbyHold(r) {
        const id = this.sql.exec(`INSERT INTO lobby_runs (upload_id, track, week, user_id, nickname, frames, lobby, car_style, recording, at)
            VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
            r.track, r.week, r.userId, r.nickname, r.frames, r.lobby, r.carStyle, r.recording, Date.now()).one().id;
        this.touch(r.track);
        this.boards.get(r.track)?.holds.add(r.userId + "|" + r.frames);
        return id;
    }

    async lobbyUploaded(id, uploadId) {
        if (!Number.isSafeInteger(uploadId)) return;
        const row = this.sql.exec("SELECT track FROM lobby_runs WHERE id = ?", id).toArray()[0];
        if (!row) return;
        this.sql.exec("UPDATE lobby_runs SET upload_id = ? WHERE id = ?", uploadId, id);
        this.touch(row.track);
        this.boards.get(row.track)?.holds.add("#" + uploadId);
    }

    // The upload never reached Kodub, so there is nothing to review.
    async lobbyDiscard(id) {
        const row = this.sql.exec("SELECT * FROM lobby_runs WHERE id = ?", id).toArray()[0];
        if (!row) return;
        this.sql.exec("DELETE FROM lobby_runs WHERE id = ?", id);
        this.touch(row.track);
        const holds = this.boards.get(row.track)?.holds;
        if (holds) for (const key of this.holdKeys(row)) holds.delete(key);
    }

    unhold(row) {
        this.touch(row.track);
        const holds = this.boards.get(row.track)?.holds;
        if (holds) for (const key of this.holdKeys(row)) holds.delete(key);
    }

    async lobbyRecording(id) {
        const row = this.sql.exec("SELECT track, nickname, frames, car_style, recording FROM lobby_runs WHERE id = ?", id).toArray()[0];
        return row?.recording ? { track: row.track, nickname: row.nickname, frames: row.frames, carStyle: row.car_style, recording: row.recording } : null;
    }

    // "verified" keeps the run up; "hidden" takes it off the boards like a failed replay.
    async lobbyVerdict(id, verdict) {
        const row = this.sql.exec("SELECT * FROM lobby_runs WHERE id = ?", id).toArray()[0];
        if (!row || (verdict !== "verified" && verdict !== "hidden")) return { ok: false };
        this.sql.exec("UPDATE lobby_runs SET state = ?, recording = NULL, at = ? WHERE id = ?", verdict, Date.now(), id);
        this.touch(row.track);
        if (verdict === "verified") this.unhold(row);
        if (verdict === "hidden") {
            if (row.upload_id != null) {
                this.saveRun(row.track, row.week, { id: row.upload_id, userId: row.user_id, nickname: row.nickname, frames: row.frames },
                    "invalid", "lobby", "owner-hidden");
            }
            if (row.user_id) {
                this.sql.exec("DELETE FROM passes WHERE track = ? AND user_id = ? AND frames = ?", row.track, row.user_id, row.frames);
                this.boards.get(row.track)?.passes.delete(row.user_id + "|" + row.frames);
            }
        }
        return { ok: true };
    }

    // Every lobby PB still waiting, not only the ones the dashboard lists.
    async lobbyVerifyAll() {
        const rows = this.sql.exec("SELECT * FROM lobby_runs WHERE state = 'review'").toArray();
        if (!rows.length) return { verified: 0 };
        this.sql.exec("UPDATE lobby_runs SET state = 'verified', recording = NULL, at = ? WHERE state = 'review'", Date.now());
        for (const row of rows) this.unhold(row);
        return { verified: rows.length };
    }

    flaggedOn(track) {
        return this.sql.exec("SELECT id FROM runs WHERE track = ? AND flags != ''", track).toArray().map((r) => r.id);
    }

    // The owner looked and it's fine. A run is only flagged once, so this stays.
    unflag(id) {
        this.sql.exec("UPDATE runs SET flags = '' WHERE id = ?", id);
        return { ok: true };
    }

    // Looks at the next few runs from before flags existed. The page calls this until done. Only a flagged run gets
    // a write, and the place is kept in one key, so a scan writes about one row a step however clean the runs are.
    async scanFlags() {
        const after = (await this.ctx.storage.get("flag-scan")) ?? 0;
        const rows = this.sql.exec("SELECT id, frames, flags, source, state FROM runs WHERE id > ? ORDER BY id LIMIT ?", after, SCAN_RUNS).toArray();
        const todo = rows.filter((r) => r.flags == null && r.source !== "owner" && r.state !== "invalid");
        const reads = [];
        for (let i = 0; i < todo.length; i += CHECK_BATCH) reads.push(this.fetchRecordings(todo.slice(i, i + CHECK_BATCH).map((r) => r.id)));
        const found = new Map((await Promise.all(reads)).flatMap((part) => [...part]));
        let flagged = 0;
        for (const r of todo) {
            const recording = found.get(r.id);
            const flags = recording ? await inputFlags(recording, r.frames).catch(() => "") : "";
            if (!flags) continue;
            this.sql.exec("UPDATE runs SET flags = ? WHERE id = ?", flags, r.id);
            flagged++;
        }
        if (rows.length) await this.ctx.storage.put("flag-scan", rows[rows.length - 1].id);
        return { done: rows.length < SCAN_RUNS, scanned: rows.length, flagged };
    }

    async approve(id) {
        const row = this.sql.exec("SELECT track FROM runs WHERE id = ?", id).toArray()[0];
        if (!row) return { ok: false };
        this.sql.exec("UPDATE runs SET state = 'valid', source = 'approved', reason = NULL, at = ? WHERE id = ?", Date.now(), id);
        this.touch(row.track);
        this.sql.exec("DELETE FROM queue WHERE run_id = ?", id);
        for (const held of this.sql.exec("SELECT * FROM lobby_runs WHERE upload_id = ?", id).toArray()) this.unhold(held);
        this.sql.exec("UPDATE lobby_runs SET state = 'verified', recording = NULL WHERE upload_id = ?", id);
        const run = this.boards.get(row.track)?.runs.get(id);
        if (run) Object.assign(run, { state: "valid", source: "approved" });
        return { ok: true };
    }

    async summary() {
        const tracks = this.sql.exec("SELECT id, week, updated FROM tracks ORDER BY week, id").toArray();
        const tallies = new Map(this.sql.exec("SELECT k, n FROM tallies").toArray().map((r) => [r.k, r.n]));
        const counts = [];
        const lobbyCounts = [];
        for (const [k, n] of tallies) {
            const [kind, a, b] = k.split("|");
            if (n > 0 && kind === "run") counts.push({ source: a, state: b, n });
            if (n > 0 && kind === "lobby") lobbyCounts.push({ state: a, n });
        }
        const queue = this.sql.exec(`SELECT COUNT(*) AS n,
                COALESCE(SUM(CASE WHEN track IN (SELECT id FROM tracks) THEN 0 ELSE 1 END), 0) AS waiting
            FROM queue`).one();
        const rejects = this.sql.exec("SELECT * FROM rejects ORDER BY last DESC LIMIT ?", LOG_LIMIT).toArray();
        const rejectTotals = { runs: tallies.get("rejects") ?? 0, attempts: tallies.get("reject_attempts") ?? 0 };
        const blocked = this.sql.exec(`SELECT id, track, week, user_id, nickname, frames, source, reason, at FROM runs
            WHERE state = 'invalid' ORDER BY at DESC LIMIT ?`, LOG_LIMIT).toArray();
        const boards = tallies.get("boards") ?? 0;
        const flagged = this.sql.exec(`SELECT id, track, week, user_id, nickname, frames, flags, uploaded, at FROM runs
            WHERE flags != '' AND state != 'invalid' ORDER BY at DESC LIMIT ?`, LOG_LIMIT).toArray();
        const lobby = this.sql.exec(`SELECT id, upload_id, track, week, user_id, nickname, frames, lobby, at FROM lobby_runs
            WHERE state = 'review' ORDER BY at DESC LIMIT ?`, LOG_LIMIT).toArray();
        return { tracks, counts, queue, rejects, rejectTotals, blocked, flagged, boards, lobby, lobbyCounts };
    }
}
