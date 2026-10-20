// Site traffic for the owner dashboard. One Durable Object ("global") holds it all in
// SQLite. Visitors are random ids the page makes up; no token or IP is ever stored.

import { DurableObject } from "cloudflare:workers";

// Everything is summed into 10-minute buckets: `t` is epoch seconds / BUCKET_S.
const BUCKET_S = 600;
const DAY_MS = 86_400_000;
// The free plan allows 100k Durable Object requests and 100k rows written a day, and every open
// tab beats. Past BEAT_BUDGET_PER_MIN sessions online, the beat reply stretches every tab's gap so
// the whole site stays near that many beats a minute.
const BEAT_BUDGET_PER_MIN = 20;
const MAX_VISIBLE_GAP_S = 900;
const MAX_NEXT_S = 1800;
// No beat may claim more time than this, however long it has been since the last one.
const MAX_BEAT_S = MAX_NEXT_S + 60;
// After a restart, sessions seen this recently count as online until their next beat says otherwise.
const RESTORE_LIVE_S = 400;
// A session counts as online until its promised next beat is this late.
const LIVE_GRACE_MS = 45_000;
// A hidden tab sends nothing. Once its promised beat is late it counts as away, still online, until
// it says goodbye (closing the tab). One that dies without a goodbye stays until the object restarts.
const MINUTE_RING = 180;
// New sessions allowed per IP address per hour. Schools share one address, so it is generous.
const OPENS_PER_IP_HOUR = 120;

const EVENT_NAMES = ["attempts", "finishes", "uploads", "replays", "clips", "editor", "garage", "standings"];
const STATES = new Set(["menu", "race", "editor", "watch", "garage"]);

// The free plan allows 5M SQLite rows read a day, and every stats query scans its whole range, so
// Race Control keeps what it fetched in the owner's browser and only asks again on Refresh.
const RANGES = {
    day: { ms: DAY_MS, step: 600 },
    "3d": { ms: 3 * DAY_MS, step: 1800 },
    week: { ms: 7 * DAY_MS, step: 3600 },
    month: { ms: 30 * DAY_MS, step: 6 * 3600 },
    all: { ms: null, step: 86_400 },
};
// Sessions opened this recently are put back online when the object restarts; older ones come back
// with their next beat, which for a hidden tab is when it is shown again.
const RESTORE_MS = 3 * 60 * 60_000;

const SESSION_LENGTHS = [60, 300, 900, 1800, 3600, 7200];

// Focused time goes to Accounts (hours played) in one batch per this long, not one call per beat.
const PLAY_FLUSH_MS = 5 * 60_000;
// Most one visitor can be credited per batch; a late alarm, or one stretched beat, still fits.
const PLAY_CAP_S = Math.max(2 * PLAY_FLUSH_MS / 1000, MAX_VISIBLE_GAP_S + 60);

// Announcements: one is live at a time, and a newer one replaces it. Players get it with their
// next beat, so even "online now" has to stay up a few minutes for everyone's beat to come in.
const ANNOUNCE_SHOW_S = new Set([6, 10, 15, 30]);
const ANNOUNCE_REACH_MIN = new Set([5, 60, 1440]);
const ANNOUNCE_NAME = 32;
const ANNOUNCE_TEXT = 160;
const ANNOUNCE_HISTORY = 20;
const POLL_OPTIONS = 10;
const POLL_OPTION_TEXT = 40;
// A poll takes votes until the owner closes it, or for this long. It stays on a player's screen until they close it.
const POLL_OPEN_MS = 7 * DAY_MS;
const POLL_CACHE = 20;
// New votes per IP address per poll. Schools share one address.
const VOTES_PER_IP = 30;

function pollOptions(row) {
    if (!row?.poll) return null;
    try {
        const list = JSON.parse(row.poll);
        return Array.isArray(list) && list.length >= 2 ? list : null;
    } catch {
        return null;
    }
}

function pollOpen(row, now) {
    return row.poll_closed == null && now < row.at + POLL_OPEN_MS;
}

function pollVotes(row, count) {
    let list = [];
    try {
        list = JSON.parse(row.votes);
    } catch {}
    return Array.from({ length: count }, (_, i) => (Number.isSafeInteger(list?.[i]) && list[i] > 0 ? list[i] : 0));
}

function clampNumber(value, max) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.min(n, max) : 0;
}

function tally(map, key, runtime) {
    const k = key || "?";
    const row = map.get(k) ?? { key: k, opens: 0, runtime: 0 };
    row.opens++;
    row.runtime += runtime;
    map.set(k, row);
}

function topRows(map, limit) {
    return [...map.values()].sort((a, b) => b.opens - a.opens || b.runtime - a.runtime).slice(0, limit);
}

export class TrafficStats extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.sql = ctx.storage.sql;
        this.online = new Map();
        // Most players online in each recent minute, oldest first: [minute, count].
        this.ring = [];
        // IP -> { hour, opens }, only in memory; addresses are never written to storage.
        this.opensByIp = new Map();
        this.ann = null;
        // `${ip} ${poll id}` -> new votes, only in memory.
        this.votesByIp = new Map();
        // Recent poll rows by id, so beats asking for counts read no rows.
        this.polls = new Map();
        // All-time totals, loaded the first time the dashboard asks and then kept up by record().
        this.totals = null;
        // The runtime odometer adds a second per person online, away ones too, each second. People only
        // change when a session opens or ends, so it is credited from the last change on each beat.
        // `owed` is bucket -> seconds not written yet.
        this.onlineCredit = { at: Date.now(), people: 0, owed: new Map() };
        // visitor -> focused seconds not yet handed to Accounts. Lost if the object is evicted first.
        this.play = new Map();
        this.playAlarm = false;
        ctx.blockConcurrencyWhile(async () => {
            this.migrate();
            this.restoreLive();
            this.ann = this.sql.exec("SELECT * FROM announcements WHERE stopped IS NULL AND until > ? ORDER BY id DESC LIMIT 1",
                Date.now()).toArray()[0] ?? null;
        });
    }

    migrate() {
        this.sql.exec(`CREATE TABLE IF NOT EXISTS buckets (
            t INTEGER PRIMARY KEY,
            runtime REAL NOT NULL DEFAULT 0, focus REAL NOT NULL DEFAULT 0, driving REAL NOT NULL DEFAULT 0,
            opens INTEGER NOT NULL DEFAULT 0, new_visitors INTEGER NOT NULL DEFAULT 0, peak INTEGER NOT NULL DEFAULT 0,
            attempts INTEGER NOT NULL DEFAULT 0, finishes INTEGER NOT NULL DEFAULT 0, uploads INTEGER NOT NULL DEFAULT 0,
            replays INTEGER NOT NULL DEFAULT 0, clips INTEGER NOT NULL DEFAULT 0, editor INTEGER NOT NULL DEFAULT 0,
            garage INTEGER NOT NULL DEFAULT 0, standings INTEGER NOT NULL DEFAULT 0)`);
        this.sql.exec(`CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY, visitor TEXT NOT NULL, start INTEGER NOT NULL, last INTEGER NOT NULL,
            runtime REAL NOT NULL DEFAULT 0, focus REAL NOT NULL DEFAULT 0, driving REAL NOT NULL DEFAULT 0,
            attempts INTEGER NOT NULL DEFAULT 0, finishes INTEGER NOT NULL DEFAULT 0, ended INTEGER NOT NULL DEFAULT 0,
            repeat_visit INTEGER NOT NULL DEFAULT 0, nickname TEXT, country TEXT, device TEXT, os TEXT, browser TEXT,
            referrer TEXT, site TEXT)`);
        this.sql.exec("CREATE INDEX IF NOT EXISTS sessions_start ON sessions(start)");
        this.sql.exec(`CREATE TABLE IF NOT EXISTS visitors (
            id TEXT PRIMARY KEY, first INTEGER NOT NULL, last INTEGER NOT NULL, opens INTEGER NOT NULL DEFAULT 0)`);
        this.sql.exec("CREATE TABLE IF NOT EXISTS minutes (m INTEGER PRIMARY KEY, online INTEGER NOT NULL)");
        this.sql.exec(`CREATE TABLE IF NOT EXISTS track_days (
            day INTEGER NOT NULL, track TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
            finishes INTEGER NOT NULL DEFAULT 0, uploads INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (day, track)) WITHOUT ROWID`);
        this.sql.exec(`CREATE TABLE IF NOT EXISTS announcements (
            id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, until INTEGER NOT NULL,
            name TEXT NOT NULL, color TEXT NOT NULL, text TEXT NOT NULL, show_s INTEGER NOT NULL,
            online INTEGER NOT NULL DEFAULT 0, seen INTEGER NOT NULL DEFAULT 0, stopped INTEGER)`);
        // An official cup's announcement carries its code, for a Join button.
        if (!this.sql.exec("PRAGMA table_info(announcements)").toArray().some((c) => c.name === "cup"))
            this.sql.exec("ALTER TABLE announcements ADD COLUMN cup TEXT");
        // A poll's options and its running counts, both JSON arrays.
        const columns = new Set(this.sql.exec("PRAGMA table_info(announcements)").toArray().map((c) => c.name));
        if (!columns.has("poll")) {
            this.sql.exec("ALTER TABLE announcements ADD COLUMN poll TEXT");
            this.sql.exec("ALTER TABLE announcements ADD COLUMN votes TEXT");
        }
        if (!columns.has("poll_change")) {
            this.sql.exec("ALTER TABLE announcements ADD COLUMN poll_change INTEGER NOT NULL DEFAULT 0");
            this.sql.exec("ALTER TABLE announcements ADD COLUMN poll_closed INTEGER");
        }
        this.sql.exec(`CREATE TABLE IF NOT EXISTS poll_votes (
            ann INTEGER NOT NULL, voter TEXT NOT NULL, choice INTEGER NOT NULL, at INTEGER NOT NULL,
            PRIMARY KEY (ann, voter)) WITHOUT ROWID`);
        this.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
        // Person-seconds online for the odometer. Buckets from before it existed stay NULL and count their runtime.
        if (!this.sql.exec("PRAGMA table_info(buckets)").toArray().some((c) => c.name === "online_s"))
            this.sql.exec("ALTER TABLE buckets ADD COLUMN online_s REAL");
    }

    notePlay(visitor, seconds) {
        if (!(seconds > 0) || !this.env.ACCOUNTS) return;
        this.play.set(visitor, (this.play.get(visitor) ?? 0) + seconds);
        if (this.playAlarm) return;
        this.playAlarm = true;
        this.ctx.storage.setAlarm(Date.now() + PLAY_FLUSH_MS).catch(() => {
            this.playAlarm = false;
        });
    }

    async alarm() {
        this.playAlarm = false;
        if (!this.env.ACCOUNTS) return;
        // The first batch ever is every session's focused time so far. Beats noted before now are
        // already in those sums, so the pending map is dropped in the same step.
        const backfill = !this.sql.exec("SELECT 1 FROM meta WHERE k = 'play_backfill'").toArray().length;
        const entries = backfill
            ? this.sql.exec("SELECT visitor, SUM(focus) AS s FROM sessions GROUP BY visitor HAVING s > 0").toArray().map((r) => [r.visitor, r.s])
            : [...this.play];
        this.play.clear();
        if (!entries.length) return;
        try {
            await this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromName("global")).creditPlay(entries, backfill ? 0 : PLAY_CAP_S);
            if (backfill) this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('play_backfill', ?)", String(Date.now()));
        } catch (err) {
            console.error("play credit failed:", err && err.message);
            if (!backfill) for (const [v, s] of entries) this.play.set(v, (this.play.get(v) ?? 0) + s);
            this.playAlarm = true;
            await this.ctx.storage.setAlarm(Date.now() + PLAY_FLUSH_MS);
        }
    }

    // The in-memory list of who is online is lost when the object is evicted.
    restoreLive() {
        const now = Date.now();
        this.ring = this.sql.exec("SELECT m, online FROM minutes WHERE m > ? ORDER BY m",
            Math.floor(now / 60_000) - MINUTE_RING).toArray().map((r) => [r.m, r.online]);
        const rows = this.sql.exec(
            "SELECT * FROM sessions WHERE start > ? AND ended = 0", now - RESTORE_MS).toArray();
        for (const row of rows) {
            this.online.set(row.id, {
                id: row.id, visitor: row.visitor, start: row.start, last: row.last,
                expires: row.last + RESTORE_LIVE_S * 1000, runtime: row.runtime, ended: false,
                nickname: row.nickname, country: row.country, device: row.device, os: row.os,
                browser: row.browser, site: row.site, state: "menu", track: null,
            });
        }
        this.onlineCredit = { at: now, people: this.liveCounts(now).people, owed: new Map() };
    }

    creditOnline(now) {
        const c = this.onlineCredit;
        if (c.people) {
            for (let from = c.at; from < now;) {
                const t = Math.floor(from / 1000 / BUCKET_S);
                const to = Math.min(now, (t + 1) * BUCKET_S * 1000);
                c.owed.set(t, (c.owed.get(t) ?? 0) + c.people * (to - from) / 1000);
                from = to;
            }
        }
        c.at = Math.max(c.at, now);
    }

    // Active sessions beat on time; away ones stopped beating but never said goodbye. People are
    // counted by visitor id, which all tabs of a browser share: any active tab makes them active, and
    // `people` includes the away ones. Each shown tab beats, so the beat budget uses `activeTabs`.
    liveCounts(now) {
        let activeTabs = 0;
        // visitor -> has an active tab
        const people = new Map();
        for (const s of this.online.values()) {
            if (s.ended) continue;
            if (s.expires > now) {
                activeTabs++;
                people.set(s.visitor, true);
            } else if (!people.has(s.visitor)) {
                people.set(s.visitor, false);
            }
        }
        let away = 0;
        for (const active of people.values()) if (!active) away++;
        return { people: people.size, away, activeTabs };
    }

    onlineCount(now) {
        return this.liveCounts(now).people;
    }

    noteMinute(now, online) {
        const minute = Math.floor(now / 60_000);
        const last = this.ring[this.ring.length - 1];
        if (last && last[0] === minute) {
            if (online <= last[1]) return;
            last[1] = online;
        } else {
            this.ring.push([minute, online]);
            while (this.ring.length > MINUTE_RING) this.ring.shift();
            this.sql.exec("DELETE FROM minutes WHERE m <= ?", minute - MINUTE_RING);
        }
        this.sql.exec("INSERT OR REPLACE INTO minutes (m, online) VALUES (?, ?)", minute, online);
    }

    allowOpen(ip, now) {
        if (!ip) return true;
        const hour = Math.floor(now / 3_600_000);
        const entry = this.opensByIp.get(ip);
        if (!entry || entry.hour !== hour) {
            if (this.opensByIp.size > 5000) this.opensByIp.clear();
            this.opensByIp.set(ip, { hour, opens: 1 });
            return true;
        }
        return ++entry.opens <= OPENS_PER_IP_HOUR;
    }

    openSession(b, meta, now) {
        const visitor = this.sql.exec("SELECT first FROM visitors WHERE id = ?", b.v).toArray()[0];
        const isNew = !visitor;
        if (isNew) this.sql.exec("INSERT INTO visitors (id, first, last, opens) VALUES (?, ?, ?, 1)", b.v, now, now);
        else this.sql.exec("UPDATE visitors SET last = ?, opens = opens + 1 WHERE id = ?", now, b.v);
        const start = now - b.rt * 1000;
        this.sql.exec(`INSERT INTO sessions (id, visitor, start, last, repeat_visit, nickname, country, device, os, browser, referrer, site)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            b.s, b.v, start, start, isNew ? 0 : 1, b.nick, meta.country, meta.device, meta.os, meta.browser, b.ref, meta.site);
        return {
            session: {
                id: b.s, visitor: b.v, start, last: start, expires: 0, runtime: 0, ended: false,
                nickname: b.nick, country: meta.country, device: meta.device, os: meta.os,
                browser: meta.browser, site: meta.site, state: "menu", track: null,
            },
            isNew,
        };
    }

    async beat(b, meta) {
        const counts = this.record(b, meta);
        return {
            online: counts?.people ?? null, away: counts?.away ?? null,
            ann: this.liveAnnouncement(), pv: b.pl ? this.pollState(b.pl) : null, nv: this.visibleGap(counts),
        };
    }

    // Seconds between a shown tab's beats. Away tabs send nothing, so only active ones are budgeted.
    visibleGap(counts = this.liveCounts(Date.now())) {
        return Math.min(MAX_VISIBLE_GAP_S, Math.max(60, Math.ceil(counts.activeTabs * 60 / BEAT_BUDGET_PER_MIN)));
    }

    record(b, meta) {
        const now = Date.now();
        this.creditOnline(now);
        let s = this.online.get(b.s);
        let opened = false;
        let isNew = false;
        if (!s) {
            const row = this.sql.exec("SELECT * FROM sessions WHERE id = ?", b.s).toArray()[0];
            if (row) {
                // Another visitor's session id is never taken over.
                if (row.visitor !== b.v) return;
                s = {
                    id: row.id, visitor: row.visitor, start: row.start, last: row.last, expires: 0,
                    runtime: row.runtime, ended: false, nickname: row.nickname, country: row.country,
                    device: row.device, os: row.os, browser: row.browser, site: row.site, state: "menu", track: null,
                };
            } else {
                if (!this.allowOpen(meta.ip, now)) return;
                ({ session: s, isNew } = this.openSession(b, meta, now));
                opened = true;
            }
            this.online.set(b.s, s);
        } else if (s.visitor !== b.v) {
            return;
        }

        const sinceLast = Math.max(0, (now - s.last) / 1000);
        const runtime = opened ? 0 : Math.min(b.rt, sinceLast + 15, MAX_BEAT_S);
        const focus = Math.min(b.ft, runtime);
        const driving = Math.min(b.dt, runtime);
        this.notePlay(b.v, focus);

        s.last = now;
        s.runtime += runtime;
        s.ended = !!b.end;
        s.expires = now + b.nx * 1000 + LIVE_GRACE_MS;
        if (b.nick) s.nickname = b.nick;
        if (b.st) s.state = b.st;
        s.track = b.tk;

        const ev = b.ev;
        this.sql.exec(`UPDATE sessions SET last = ?, runtime = runtime + ?, focus = focus + ?, driving = driving + ?,
            attempts = attempts + ?, finishes = finishes + ?, ended = ?, nickname = COALESCE(?, nickname) WHERE id = ?`,
            now, runtime, focus, driving, ev.attempts, ev.finishes, s.ended ? 1 : 0, b.nick, b.s);

        const counts = this.liveCounts(now);
        const online = counts.people;
        this.noteMinute(now, online);
        const t = Math.floor(now / 1000 / BUCKET_S);
        const credit = this.onlineCredit;
        credit.people = online;
        const onlineNow = credit.owed.get(t) ?? 0;
        credit.owed.delete(t);
        let onlineSeconds = onlineNow;
        for (const [bt, seconds] of credit.owed) {
            onlineSeconds += seconds;
            this.sql.exec(`INSERT INTO buckets (t, online_s) VALUES (?, ?)
                ON CONFLICT(t) DO UPDATE SET online_s = COALESCE(online_s, runtime) + excluded.online_s`, bt, seconds);
        }
        credit.owed.clear();
        if (this.totals) {
            this.totals.onlineTime += onlineSeconds;
            if (opened) this.totals.opens++;
            if (isNew) this.totals.visitors++;
            if (!this.totals.peak || online > this.totals.peak.online) this.totals.peak = { online, t };
        }
        this.sql.exec(`INSERT INTO buckets (t, runtime, focus, driving, opens, new_visitors, peak,
                attempts, finishes, uploads, replays, clips, editor, garage, standings, online_s)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(t) DO UPDATE SET runtime = runtime + excluded.runtime, focus = focus + excluded.focus,
                online_s = COALESCE(online_s, runtime) + excluded.online_s,
                driving = driving + excluded.driving, opens = opens + excluded.opens,
                new_visitors = new_visitors + excluded.new_visitors, peak = MAX(peak, excluded.peak),
                attempts = attempts + excluded.attempts, finishes = finishes + excluded.finishes,
                uploads = uploads + excluded.uploads, replays = replays + excluded.replays,
                clips = clips + excluded.clips, editor = editor + excluded.editor,
                garage = garage + excluded.garage, standings = standings + excluded.standings`,
            t, runtime, focus, driving, opened ? 1 : 0, isNew ? 1 : 0, online,
            ev.attempts, ev.finishes, ev.uploads, ev.replays, ev.clips, ev.editor, ev.garage, ev.standings, onlineNow);

        const day = Math.floor(now / DAY_MS);
        for (const [track, [attempts, finishes, uploads]] of b.tr) {
            this.sql.exec(`INSERT INTO track_days (day, track, attempts, finishes, uploads) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(day, track) DO UPDATE SET attempts = attempts + excluded.attempts,
                    finishes = finishes + excluded.finishes, uploads = uploads + excluded.uploads`,
                day, track, attempts, finishes, uploads);
        }

        // Once per session; a restart of this object forgets seenAnn, so a session can rarely count twice.
        if (b.an && s.seenAnn !== b.an) {
            s.seenAnn = b.an;
            this.sql.exec("UPDATE announcements SET seen = seen + 1 WHERE id = ?", b.an);
        }

        for (const [id, other] of this.online) {
            if (other.ended) this.online.delete(id);
        }
        return counts;
    }

    liveAnnouncement() {
        const a = this.ann;
        if (!a || a.until <= Date.now()) return null;
        return {
            id: a.id, at: a.at, until: a.until, name: a.name, color: a.color, text: a.text, show: a.show_s, cup: a.cup ?? null,
            poll: pollOptions(a), change: !!a.poll_change,
        };
    }

    announce(a) {
        const now = Date.now();
        this.sql.exec("UPDATE announcements SET stopped = ? WHERE stopped IS NULL AND until > ?", now, now);
        this.ann = this.sql.exec(`INSERT INTO announcements (at, until, name, color, text, show_s, online, cup, poll, votes, poll_change)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
            now, now + a.reach * 60_000, a.name, a.color, a.text, a.show, this.onlineCount(now), a.cup ?? null,
            a.poll ? JSON.stringify(a.poll) : null, a.poll ? JSON.stringify(a.poll.map(() => 0)) : null, a.pollChange ? 1 : 0).one();
        if (a.poll) this.cachePoll(this.ann);
        return this.announcements();
    }

    cachePoll(row) {
        this.polls.delete(row.id);
        this.polls.set(row.id, row);
        while (this.polls.size > POLL_CACHE) this.polls.delete(this.polls.keys().next().value);
    }

    pollRow(id) {
        let row = this.polls.get(id);
        if (row) return row;
        row = this.sql.exec("SELECT * FROM announcements WHERE id = ?", id).toArray()[0];
        if (row && pollOptions(row)) this.cachePoll(row);
        return row;
    }

    // Counts for a player looking at a poll's results.
    pollState(id) {
        const row = this.pollRow(id);
        const options = pollOptions(row);
        if (!options) return null;
        return { id, votes: pollVotes(row, options.length), open: pollOpen(row, Date.now()), change: !!row.poll_change };
    }

    closePoll(id) {
        const row = this.pollRow(id);
        if (!pollOptions(row)) return this.announcements();
        if (row.poll_closed == null) {
            row.poll_closed = Date.now();
            this.sql.exec("UPDATE announcements SET poll_closed = ? WHERE id = ?", row.poll_closed, id);
            if (this.ann?.id === id) this.ann.poll_closed = row.poll_closed;
        }
        return this.announcements();
    }

    // One vote per visitor per poll. Voting again moves it only if the owner allowed that;
    // otherwise the reply carries the vote that stands.
    vote(visitor, id, choice, ip) {
        const now = Date.now();
        const row = this.pollRow(id);
        const options = pollOptions(row);
        if (!options || choice >= options.length) return { error: "closed" };
        const votes = pollVotes(row, options.length);
        if (!pollOpen(row, now)) return { error: "closed", votes };
        if (!this.sql.exec("SELECT 1 FROM visitors WHERE id = ?", visitor).toArray().length) return { error: "unknown" };
        const before = this.sql.exec("SELECT choice FROM poll_votes WHERE ann = ? AND voter = ?", id, visitor).toArray()[0]?.choice;
        if (before === choice) return { votes, choice };
        if (before != null && !row.poll_change) return { votes, choice: before };
        if (before == null) {
            const key = (ip || "?") + " " + id;
            const used = this.votesByIp.get(key) ?? 0;
            if (used >= VOTES_PER_IP) return { error: "busy" };
            if (this.votesByIp.size > 5000) this.votesByIp.clear();
            this.votesByIp.set(key, used + 1);
        } else if (votes[before] > 0) {
            votes[before]--;
        }
        votes[choice]++;
        this.sql.exec(`INSERT INTO poll_votes (ann, voter, choice, at) VALUES (?, ?, ?, ?)
            ON CONFLICT(ann, voter) DO UPDATE SET choice = excluded.choice, at = excluded.at`, id, visitor, choice, now);
        row.votes = JSON.stringify(votes);
        if (this.ann?.id === id) this.ann.votes = row.votes;
        this.sql.exec("UPDATE announcements SET votes = ? WHERE id = ?", row.votes, id);
        return { votes, choice };
    }

    // Without an id, stops whatever is live (Race Control). With one, only that announcement, so a
    // cup that closes never ends someone else's message.
    stopAnnouncement(id) {
        if (id != null && this.ann?.id !== id) {
            this.sql.exec("UPDATE announcements SET stopped = ? WHERE id = ? AND stopped IS NULL", Date.now(), id);
            return { stopped: null, ...this.announcements() };
        }
        const stopped = this.ann?.id ?? null;
        if (stopped != null) this.sql.exec("UPDATE announcements SET stopped = ? WHERE id = ?", Date.now(), stopped);
        this.ann = null;
        return { stopped, ...this.announcements() };
    }

    announcements() {
        const now = Date.now();
        const current = this.liveAnnouncement();
        const list = this.sql.exec("SELECT * FROM announcements ORDER BY id DESC LIMIT ?", ANNOUNCE_HISTORY).toArray()
            .map((r) => {
                const poll = pollOptions(r);
                return {
                    id: r.id, at: r.at, until: r.until, name: r.name, color: r.color, text: r.text, show: r.show_s,
                    online: r.online, seen: r.seen, stopped: r.stopped, live: r.id === current?.id, cup: r.cup ?? null,
                    poll, votes: poll ? pollVotes(r, poll.length) : null,
                    change: !!r.poll_change, open: !!poll && pollOpen(this.polls.get(r.id) ?? r, now),
                };
            });
        return { current, list, online: this.onlineCount(now), now };
    }

    // One row per person (see liveCounts), showing their active tab over an away one, then the one that
    // beat last. `pending` is the odometer's seconds not credited yet, which keeps its running total exact.
    liveView(now) {
        // visitor -> { s: the tab shown, isAway, tabs, since }
        const people = new Map();
        const credit = this.onlineCredit;
        let pending = credit.people * Math.max(0, now - credit.at) / 1000;
        for (const seconds of credit.owed.values()) pending += seconds;
        for (const s of this.online.values()) {
            if (s.ended) continue;
            const isAway = s.expires <= now;
            const p = people.get(s.visitor);
            if (!p) {
                people.set(s.visitor, { s, isAway, tabs: 1, since: s.start });
                continue;
            }
            p.tabs++;
            p.since = Math.min(p.since, s.start);
            if (p.isAway === isAway ? s.last > p.s.last : p.isAway) {
                p.s = s;
                p.isAway = isAway;
            }
        }
        const sessions = [];
        let away = 0;
        for (const { s, isAway, tabs, since } of people.values()) {
            if (isAway) away++;
            sessions.push({
                nickname: s.nickname, country: s.country, device: s.device, os: s.os, browser: s.browser,
                site: s.site, state: isAway ? "away" : s.state, track: isAway ? null : s.track, since, tabs,
            });
        }
        sessions.sort((a, b) => a.since - b.since);
        const minute = Math.floor(now / 60_000);
        const ring = this.ring.filter(([m]) => m > minute - MINUTE_RING);
        return { online: sessions.length, away, pending, sessions, ring, now };
    }

    loadTotals() {
        if (this.totals) return this.totals;
        const sums = this.sql.exec(
            "SELECT COALESCE(SUM(COALESCE(online_s, runtime)), 0) AS online, COALESCE(SUM(opens), 0) AS opens FROM buckets").one();
        const peak = this.sql.exec("SELECT t, peak FROM buckets ORDER BY peak DESC, t ASC LIMIT 1").toArray()[0];
        this.totals = {
            onlineTime: sums.online,
            opens: sums.opens,
            visitors: this.sql.exec("SELECT COUNT(*) AS n FROM visitors").one().n,
            peak: peak ? { online: peak.peak, t: peak.t } : null,
        };
        return this.totals;
    }

    async liveStats() {
        const view = this.liveView(Date.now());
        const totals = this.loadTotals();
        return { ...view, totalRuntime: totals.onlineTime, totalOpens: totals.opens };
    }

    async stats(rangeKey, tzOffsetMin) {
        const range = RANGES[rangeKey] ?? RANGES.day;
        const tz = Math.max(-840, Math.min(840, Math.trunc(tzOffsetMin) || 0)) * 60;
        return { ...this.computeStats(range, tz, Date.now()), live: await this.liveStats() };
    }

    computeStats(range, tz, now) {
        const startMs = range.ms == null ? 0 : now - range.ms;
        const startT = Math.floor(startMs / 1000 / BUCKET_S);
        const step = range.step;

        // One pass over the range's buckets for the series, the totals and the heat map.
        const SUMMED = ["runtime", "focus", "driving", "opens", "newVisitors", "attempts", "finishes", "uploads",
            "replays", "clips", "editor", "garage", "standings"];
        const totals = Object.fromEntries(SUMMED.map((k) => [k, 0]));
        totals.peak = 0;
        const series = [];
        const heatCells = new Map();
        for (const b of this.sql.exec("SELECT * FROM buckets WHERE t >= ? ORDER BY t", startT)) {
            b.newVisitors = b.new_visitors;
            for (const k of SUMMED) totals[k] += b[k];
            totals.peak = Math.max(totals.peak, b.peak);
            const local = b.t * BUCKET_S + tz;
            const g = Math.trunc(local / step);
            let row = series[series.length - 1];
            if (!row || row.g !== g) {
                row = { g, runtime: 0, focus: 0, driving: 0, opens: 0, newVisitors: 0, peak: b.peak, attempts: 0, finishes: 0, uploads: 0 };
                series.push(row);
            }
            for (const k of ["runtime", "focus", "driving", "opens", "newVisitors", "attempts", "finishes", "uploads"]) row[k] += b[k];
            row.peak = Math.max(row.peak, b.peak);
            // Sunday = 0. Epoch day 0 was a Thursday.
            const wd = (Math.trunc(local / 86400) + 4) % 7;
            const h = Math.trunc((local % 86400) / 3600);
            const cell = heatCells.get(wd * 24 + h) ?? { wd, h, runtime: 0, opens: 0 };
            cell.runtime += b.runtime;
            cell.opens += b.opens;
            heatCells.set(wd * 24 + h, cell);
        }
        const heat = [...heatCells.keys()].sort((a, b) => a - b).map((k) => heatCells.get(k));

        const firstBucket = this.sql.exec("SELECT MIN(t) AS t FROM buckets").one().t;
        const { peak: peakEver, visitors: visitorsEver } = this.loadTotals();
        const busiestDay = this.sql.exec(`SELECT CAST((t * ${BUCKET_S} + ?) / 86400 AS INTEGER) AS d, SUM(runtime) AS runtime, SUM(opens) AS opens
            FROM buckets GROUP BY d ORDER BY runtime DESC LIMIT 1`, tz).toArray()[0] ?? null;

        const countries = new Map();
        const devices = new Map();
        const oses = new Map();
        const browsers = new Map();
        const referrers = new Map();
        const sites = new Map();
        const players = new Map();
        const uniques = new Map();
        const lengths = new Array(SESSION_LENGTHS.length + 1).fill(0);
        const visitors = new Set();
        let returningOpens = 0;
        let sessionCount = 0;
        let longest = null;

        for (const s of this.sql.exec(`SELECT visitor, start, runtime, focus, driving, attempts, finishes, repeat_visit,
                nickname, country, device, os, browser, referrer, site FROM sessions WHERE start >= ?`, startMs)) {
            sessionCount++;
            visitors.add(s.visitor);
            if (s.repeat_visit) returningOpens++;
            tally(countries, s.country, s.runtime);
            tally(devices, s.device, s.runtime);
            tally(oses, s.os, s.runtime);
            tally(browsers, s.browser, s.runtime);
            tally(referrers, s.referrer || "direct", s.runtime);
            tally(sites, s.site, s.runtime);

            let i = 0;
            while (i < SESSION_LENGTHS.length && s.runtime >= SESSION_LENGTHS[i]) i++;
            lengths[i]++;
            if (!longest || s.runtime > longest.runtime) {
                longest = { runtime: s.runtime, start: s.start, nickname: s.nickname, country: s.country };
            }

            const p = players.get(s.visitor) ?? {
                nickname: null, country: null, opens: 0, runtime: 0, driving: 0, attempts: 0, finishes: 0, lastSeen: 0,
            };
            p.opens++;
            p.runtime += s.runtime;
            p.driving += s.driving;
            p.attempts += s.attempts;
            p.finishes += s.finishes;
            if (s.start >= p.lastSeen) {
                p.lastSeen = s.start;
                if (s.nickname) p.nickname = s.nickname;
                if (s.country) p.country = s.country;
            }
            players.set(s.visitor, p);

            const g = Math.floor((s.start / 1000 + tz) / step);
            let set = uniques.get(g);
            if (!set) uniques.set(g, (set = new Set()));
            set.add(s.visitor);
        }

        const tracks = this.sql.exec(`SELECT track, SUM(attempts) AS attempts, SUM(finishes) AS finishes, SUM(uploads) AS uploads
            FROM track_days WHERE day >= ? GROUP BY track ORDER BY attempts DESC, finishes DESC LIMIT 20`,
            Math.floor(startMs / DAY_MS)).toArray();

        const nowG = Math.floor((now / 1000 + tz) / step);
        let firstG;
        if (range.ms != null) firstG = Math.floor((startMs / 1000 + tz) / step);
        else if (firstBucket != null) firstG = Math.floor((firstBucket * BUCKET_S + tz) / step);
        else firstG = nowG;

        return {
            range: { step, firstG, nowG, tz, start: startMs },
            series,
            uniques: [...uniques].map(([g, set]) => [g, set.size]),
            totals: { ...totals, sessions: sessionCount, visitors: visitors.size, returningOpens },
            heat,
            lengths: { edges: SESSION_LENGTHS, counts: lengths },
            countries: topRows(countries, 25),
            devices: topRows(devices, 6),
            oses: topRows(oses, 8),
            browsers: topRows(browsers, 8),
            referrers: topRows(referrers, 12),
            sites: topRows(sites, 6),
            players: [...players.values()].sort((a, b) => b.runtime - a.runtime).slice(0, 25),
            tracks,
            records: {
                firstSeen: firstBucket == null ? null : firstBucket * BUCKET_S * 1000,
                peak: peakEver ? { online: peakEver.online, at: peakEver.t * BUCKET_S * 1000 } : null,
                busiestDay: busiestDay ? { day: busiestDay.d, runtime: busiestDay.runtime, opens: busiestDay.opens } : null,
                longest,
                visitorsEver,
            },
        };
    }
}

// Validates a beat from the page. Returns null for anything malformed.
export function readBeat(text) {
    if (typeof text !== "string" || text.length > 4096) return null;
    let raw;
    try {
        raw = JSON.parse(text);
    } catch {
        return null;
    }
    if (!raw || typeof raw !== "object") return null;
    const id = /^[0-9a-f]{32}$/;
    if (!id.test(raw.s ?? "") || !id.test(raw.v ?? "")) return null;

    const ev = {};
    for (const name of EVENT_NAMES) ev[name] = Math.floor(clampNumber(raw.ev?.[name], 500));

    const tr = [];
    if (raw.tr && typeof raw.tr === "object") {
        for (const [track, counts] of Object.entries(raw.tr).slice(0, 30)) {
            if (!/^[0-9a-f]{64}$/.test(track) || !Array.isArray(counts)) continue;
            const c = [0, 1, 2].map((i) => Math.floor(clampNumber(counts[i], 500)));
            if (c[0] || c[1] || c[2]) tr.push([track, c]);
        }
    }

    const text64 = (value, max) => {
        if (typeof value !== "string") return null;
        const clean = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
        return clean || null;
    };
    const ref = text64(raw.ref, 64);

    return {
        s: raw.s,
        v: raw.v,
        rt: clampNumber(raw.rt, MAX_BEAT_S),
        ft: clampNumber(raw.ft, MAX_BEAT_S),
        dt: clampNumber(raw.dt, MAX_BEAT_S),
        nx: Math.max(20, Math.min(MAX_NEXT_S, clampNumber(raw.nx, MAX_NEXT_S) || 60)),
        end: raw.end === 1 || raw.end === true,
        nick: text64(raw.nick, 40),
        ref: ref && /^[a-z0-9.-]+$/i.test(ref) ? ref.toLowerCase() : null,
        st: STATES.has(raw.st) ? raw.st : null,
        tk: typeof raw.tk === "string" && /^[0-9a-f]{64}$/.test(raw.tk) ? raw.tk : null,
        an: Number.isSafeInteger(raw.an) && raw.an > 0 ? raw.an : null,
        pl: Number.isSafeInteger(raw.pl) && raw.pl > 0 ? raw.pl : null,
        ev,
        tr,
    };
}

function announceText(value, max) {
    if (typeof value !== "string") return "";
    // Controls, bidi overrides and other invisible characters, which could hide or reorder text.
    const text = value.normalize("NFC").replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\u2028\u2029]/gu, "").replace(/\s+/g, " ").trim();
    return [...text].slice(0, max).join("");
}

// Validates an announcement from the owner's panel. Null if it has no message.
export function readAnnouncement(body) {
    const text = announceText(body?.text, ANNOUNCE_TEXT);
    if (!text) return null;
    return {
        name: announceText(body.name, ANNOUNCE_NAME) || "Owner",
        text,
        color: /^#[0-9a-f]{6}$/i.test(body.color ?? "") ? body.color.toLowerCase() : "#b3c1ff",
        show: ANNOUNCE_SHOW_S.has(body.show) ? body.show : 10,
        reach: ANNOUNCE_REACH_MIN.has(body.reach) ? body.reach : 5,
        cup: /^[A-HJ-NP-Z2-9]{5}$/.test(body.cup ?? "") ? body.cup : null,
        poll: readPoll(body.poll),
        pollChange: body.pollChange === true,
    };
}

// A poll's answers: 2 to POLL_OPTIONS different ones, or null for a plain announcement.
function readPoll(raw) {
    if (!Array.isArray(raw)) return null;
    const options = [];
    const seen = new Set();
    for (const value of raw.slice(0, 40)) {
        const text = announceText(value, POLL_OPTION_TEXT);
        const key = text.toLowerCase();
        if (!text || seen.has(key)) continue;
        seen.add(key);
        options.push(text);
        if (options.length === POLL_OPTIONS) break;
    }
    return options.length >= 2 ? options : null;
}

// A player's vote: { visitor, id, choice }, or null.
export function readVote(text) {
    let raw;
    try {
        raw = JSON.parse(text);
    } catch {
        return null;
    }
    if (!/^[0-9a-f]{32}$/.test(raw?.v ?? "") || !Number.isSafeInteger(raw.id) || raw.id <= 0) return null;
    if (!Number.isSafeInteger(raw.c) || raw.c < 0 || raw.c >= POLL_OPTIONS) return null;
    return { visitor: raw.v, id: raw.id, choice: raw.c };
}

// Coarse labels only; the raw user agent is never stored.
export function describeClient(request) {
    const ua = request.headers.get("User-Agent") || "";
    let os = "Other";
    if (/CrOS/.test(ua)) os = "ChromeOS";
    else if (/Android/.test(ua)) os = "Android";
    else if (/iPhone|iPad|iPod/.test(ua)) os = "iOS";
    else if (/Windows/.test(ua)) os = "Windows";
    else if (/Macintosh|Mac OS X/.test(ua)) os = "macOS";
    else if (/Linux/.test(ua)) os = "Linux";

    let browser = "Other";
    if (/Edg\//.test(ua)) browser = "Edge";
    else if (/OPR\/|Opera/.test(ua)) browser = "Opera";
    else if (/Firefox\/|FxiOS/.test(ua)) browser = "Firefox";
    else if (/SamsungBrowser/.test(ua)) browser = "Samsung";
    else if (/Chrome\/|CriOS/.test(ua)) browser = "Chrome";
    else if (/Safari\//.test(ua)) browser = "Safari";

    let device = "Desktop";
    if (/iPad|Tablet/.test(ua) || (/Android/.test(ua) && !/Mobile/.test(ua))) device = "Tablet";
    else if (/Mobi|iPhone|iPod/.test(ua)) device = "Phone";

    const country = request.cf?.country;
    return {
        os,
        browser,
        device,
        country: typeof country === "string" && /^[A-Z]{2}$/.test(country) ? country : null,
    };
}
