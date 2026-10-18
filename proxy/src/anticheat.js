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

const CHECK_BATCH = 8;
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
        this.snapshotDirty = true;
        ctx.blockConcurrencyWhile(async () => this.migrate());
    }

    migrate() {
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
        this.migrateTallies();
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

    saveRun(track, week, entry, state, source, reason) {
        // An upsert, not INSERT OR REPLACE: a replace deletes the old row without firing the tally trigger.
        this.sql.exec(`INSERT INTO runs (id, track, week, user_id, nickname, frames, state, source, reason, at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET track = excluded.track, week = excluded.week, user_id = excluded.user_id,
                nickname = excluded.nickname, frames = excluded.frames, state = excluded.state, source = excluded.source,
                reason = excluded.reason, at = excluded.at`,
            entry.id, track, week, entry.userId ?? null, entry.nickname ?? null, entry.frames, state, source, reason ?? null, Date.now());
        this.snapshotDirty = true;
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
            this.snapshotDirty = true;
        }
        if (queued) await this.kick();
        return blocked;
    }

    // What the Worker falls back on while Durable Objects are refused, saved to KV when it has
    // changed: per board, the newest run seen, the runs to hide, the lobby holds, and valid runs
    // newer than the newest seen. Called by the Worker's cron.
    async saveSnapshot() {
        if (!this.env.FALLBACK || !this.snapshotDirty) return { saved: false };
        this.snapshotDirty = false;
        try {
            const tracks = {};
            const slot = (t) => (tracks[t] ??= { top: 0, blocked: [], holds: [], ok: [] });
            for (const r of this.sql.exec("SELECT track, MAX(cutoff, COALESCE(top, 0)) AS top FROM boards")) slot(r.track).top = r.top;
            for (const r of this.sql.exec(`SELECT id, track FROM runs WHERE state = 'invalid'
                UNION ALL SELECT id, track FROM runs WHERE state = 'pending' AND source != 'legacy'`)) slot(r.track).blocked.push(r.id);
            for (const r of this.sql.exec("SELECT id, track FROM runs WHERE state = 'valid' AND at > ?", Date.now() - SNAPSHOT_OK_WINDOW_MS)) {
                if (r.id > slot(r.track).top) slot(r.track).ok.push(r.id);
            }
            for (const r of this.sql.exec("SELECT track, user_id, frames, upload_id FROM lobby_runs WHERE state IN ('review', 'hidden')")) {
                slot(r.track).holds.push(...this.holdKeys(r));
            }
            const body = JSON.stringify(tracks);
            const hash = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)));
            if (hash === await this.ctx.storage.get("snapshotHash")) return { saved: false };
            await this.env.FALLBACK.put(SNAPSHOT_KEY, JSON.stringify({ at: Date.now(), tracks }));
            await this.ctx.storage.put("snapshotHash", hash);
            return { saved: true, bytes: body.length };
        } catch (err) {
            this.snapshotDirty = true;
            throw err;
        }
    }

    payload(track) {
        if (this.payloads.has(track)) return this.payloads.get(track);
        const row = this.sql.exec("SELECT payload FROM tracks WHERE id = ?", track).toArray()[0];
        const payload = row ? JSON.parse(row.payload) : null;
        if (payload) this.payloads.set(track, payload);
        return payload;
    }

    // Before a submission is checked: a run already rejected is refused without replaying it.
    async prepareSubmit(track, key) {
        const rejected = this.sql.exec("SELECT 1 FROM rejects WHERE key = ?", key).toArray().length > 0;
        if (rejected) {
            this.sql.exec("UPDATE rejects SET attempts = attempts + 1, last = ? WHERE key = ?", Date.now(), key);
            return { rejected: true, payload: null };
        }
        return { rejected: false, payload: this.payload(track) };
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
        if (Number.isSafeInteger(r.uploadId) && r.uploadId > 0) this.saveRun(r.track, r.week, entry, r.state, "proxy");
        if (r.state === "pending") {
            this.enqueue(Number.isSafeInteger(r.uploadId) ? r.uploadId : null, r.track, r.week, entry, r.recording);
            await this.kick();
        }
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
        this.snapshotDirty = true;
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
        this.snapshotDirty = true;
        this.boards.get(r.track)?.holds.add(r.userId + "|" + r.frames);
        return id;
    }

    async lobbyUploaded(id, uploadId) {
        if (!Number.isSafeInteger(uploadId)) return;
        const row = this.sql.exec("SELECT track FROM lobby_runs WHERE id = ?", id).toArray()[0];
        if (!row) return;
        this.sql.exec("UPDATE lobby_runs SET upload_id = ? WHERE id = ?", uploadId, id);
        this.snapshotDirty = true;
        this.boards.get(row.track)?.holds.add("#" + uploadId);
    }

    // The upload never reached Kodub, so there is nothing to review.
    async lobbyDiscard(id) {
        const row = this.sql.exec("SELECT * FROM lobby_runs WHERE id = ?", id).toArray()[0];
        if (!row) return;
        this.sql.exec("DELETE FROM lobby_runs WHERE id = ?", id);
        this.snapshotDirty = true;
        const holds = this.boards.get(row.track)?.holds;
        if (holds) for (const key of this.holdKeys(row)) holds.delete(key);
    }

    unhold(row) {
        this.snapshotDirty = true;
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
        this.snapshotDirty = true;
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

    async approve(id) {
        const row = this.sql.exec("SELECT track FROM runs WHERE id = ?", id).toArray()[0];
        if (!row) return { ok: false };
        this.sql.exec("UPDATE runs SET state = 'valid', source = 'approved', reason = NULL, at = ? WHERE id = ?", Date.now(), id);
        this.snapshotDirty = true;
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
        const lobby = this.sql.exec(`SELECT id, upload_id, track, week, user_id, nickname, frames, lobby, at FROM lobby_runs
            WHERE state = 'review' ORDER BY at DESC LIMIT ?`, LOG_LIMIT).toArray();
        return { tracks, counts, queue, rejects, rejectTotals, blocked, boards, lobby, lobbyCounts };
    }
}
