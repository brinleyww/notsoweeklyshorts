// Multiplayer lobbies. Everything goes through the Worker (proxy/src/lobby.js): the lobby, the
// rounds and every car position. LobbyConnection speaks the game's own multiplayer interface, so
// a round is the game's multiplayer race (ghost cars, Players list, session results).
(function () {
    const API = window.__nswsApiBase;
    if (!API || !window.WebSocket) return;

    const WS_URL = API.replace(/^http/, "ws") + "nsws/lobby/ws";
    const LIST_URL = API + "nsws/lobby/list";
    const VISITOR_KEY = "nsws_visitor";
    const SETTINGS_KEY = "_nswsLobbySettings";
    // Car states arrive every 50 frames; they go out in one message per batch (see lobby.js on cost).
    const CAR_BATCH_MS = 200;
    // Seconds other cars are drawn behind real time, so a batch arrives before it is needed.
    const REMOTE_DELAY = 0.45;
    const PING_TICK_MS = 5000;
    const LOBBY_PING_EVERY = 4;
    const RECONNECT_TRIES = 5;
    const LIST_REFRESH_MS = 10000;
    const OPEN_TIMEOUT_MS = 10000;
    const MAX_BUFFERED = 256 * 1024;
    const CHAT_SHOWN = 60;
    const FEED_MS = 9000;
    const CODE_RE = /^[A-HJ-NP-Z2-9]{5}$/;
    // How far into the break the warm-up starts, so the results are seen first.
    const WARMUP_DELAY_MS = 5000;

    const DEFAULTS = {
        name: "", public: true, rounds: 5, minutes: 3, maxPlayers: 8, intermission: 20,
        skip: "majority", scoring: "h2h", lateJoin: true, liveTimes: true, ghosts: true, warmup: true, weeks: null,
    };

    function storageGet(key) {
        try {
            return localStorage.getItem(key);
        } catch {
            return null;
        }
    }

    function storageSet(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch {}
    }

    function visitorId() {
        let id = storageGet(VISITOR_KEY);
        if (!/^[0-9a-f]{32}$/.test(id || "")) {
            id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
            storageSet(VISITOR_KEY, id);
        }
        return id;
    }

    const bridge = () => window.__nswsMp || null;

    // ?lobby=CODE (an invite link) joins that lobby once the menu is up.
    let pendingLobby = null;
    try {
        const url = new URL(location.href);
        const code = (url.searchParams.get("lobby") || "").trim().toUpperCase();
        if (url.searchParams.has("lobby")) {
            url.searchParams.delete("lobby");
            history.replaceState(history.state, "", url.pathname + url.search + url.hash);
        }
        if (/^[A-HJ-NP-Z2-9]{5}$/.test(code)) pendingLobby = code;
    } catch {}

    function inviteLink(code) {
        return location.origin + location.pathname + "?lobby=" + code;
    }
    const uiClick = () => window.__nswsUIClick?.();

    function el(tag, className, text) {
        const e = document.createElement(tag);
        if (className) e.className = className;
        if (text != null) e.textContent = text;
        return e;
    }

    function button(text, onClick, className) {
        const b = el("button", "button" + (className ? " " + className : ""), text);
        b.addEventListener("click", () => {
            uiClick();
            onClick(b);
        });
        return b;
    }

    function setText(node, text) {
        if (node.textContent !== text) node.textContent = text;
    }

    function fmtTime(frames) {
        if (frames == null) return "DNF";
        if (frames < 0) return "\u2713";
        const m = Math.floor(frames / 60000);
        const s = Math.floor((frames % 60000) / 1000);
        const ms = frames % 1000;
        return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0") + "." + String(ms).padStart(3, "0");
    }

    function fmtClock(ms) {
        const total = Math.max(0, Math.ceil(ms / 1000));
        return Math.floor(total / 60) + ":" + String(total % 60).padStart(2, "0");
    }

    function ordinal(n) {
        const tail = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th";
        return n + tail;
    }

    function weekParts(w) {
        return w.parts || [{ label: w.label, tracks: w.tracks || [] }];
    }

    let trackIndexCache = null;
    function trackIndex() {
        if (trackIndexCache) return trackIndexCache;
        const index = new Map();
        for (const w of window.__nswsWeeks || []) {
            for (const p of weekParts(w)) {
                for (const t of p.tracks || []) index.set(t.id, { week: w.week, label: p.label || w.label || "Week " + w.week, name: t.name, thumb: t.thumb });
            }
        }
        return trackIndexCache = index;
    }

    function weekList() {
        return [...(window.__nswsWeeks || [])].sort((a, b) => a.week - b.week).map((w) => {
            const ids = weekParts(w).flatMap((p) => (p.tracks || []).map((t) => t.id));
            return { week: w.week, ids };
        }).filter((w) => w.ids.length);
    }

    function trackLabel(id) {
        const t = trackIndex().get(id);
        return t ? { name: t.name.replace(/^\d+\s*-\s*/, ""), where: "Week " + t.week, thumb: t.thumb } : { name: "Unknown map", where: "", thumb: null };
    }

    function findTrack(id) {
        let found = null;
        bridge()?.forEachTrack((tid, group, meta, env, trackData, thumb) => {
            if (!found && tid === id) found = { meta, trackData, thumb };
        });
        return found;
    }

    function loadSettings() {
        try {
            return { ...DEFAULTS, ...JSON.parse(storageGet(SETTINGS_KEY) || "{}") };
        } catch {
            return { ...DEFAULTS };
        }
    }

    function withPool(settings) {
        const weeks = weekList();
        const chosen = Array.isArray(settings.weeks) ? weeks.filter((w) => settings.weeks.includes(w.week)) : weeks;
        return { ...settings, weeks: chosen.map((w) => w.week), pool: chosen.flatMap((w) => w.ids) };
    }

    // The lobby race in progress, so uploads from it carry the lobby code (Race Control reviews them).
    let lobbyRun = null;
    window.__nswsLobbyTag = (trackId) => lobbyRun && lobbyRun.ids.has(trackId) ? "&nswsLobby=" + lobbyRun.code : "";

    function writeU32(out, at, v) {
        out[at] = v & 255;
        out[at + 1] = v >>> 8 & 255;
        out[at + 2] = v >>> 16 & 255;
        out[at + 3] = v >>> 24 & 255;
    }

    function readU32(d, at) {
        return (d[at] | d[at + 1] << 8 | d[at + 2] << 16 | d[at + 3] << 24) >>> 0;
    }

    function standings(players) {
        return [...players].sort((a, b) => b.points - a.points || b.wins - a.wins
            || (a.rounds ? a.places / a.rounds : 99) - (b.rounds ? b.places / b.rounds : 99) || a.id - b.id);
    }

    // The game's multiplayer connection interface (see Dl in main.bundle.js), over one WebSocket.
    class LobbyConnection {
        constructor(handlers) {
            this.h = handlers;
            this.ws = null;
            this.code = null;
            this.you = null;
            this.state = null;
            this.sessionId = 0;
            this.sessionEnded = true;
            this.loadingSession = null;
            this.cb = { lost: [], reset: [], update: [], end: [], newSession: [], msg: [], players: [] };
            this.resetCounter = 0;
            this.buffer = [];
            this.bufferBytes = 0;
            this.flushTimer = null;
            this.loadedSent = false;
            this.selfRecord = null;
            this.holdOpen = false;
            this.closed = false;
            this.left = false;
            this.fatal = null;
            this.kicked = false;
            this.tries = 0;
            this.pings = {};
            this.ownPing = null;
            this.offset = 0;
            this.styles = new Map();
            this.playCategory = "community";
            this.remoteDelay = REMOTE_DELAY;
            this.pingTimer = null;
            this.pingTicks = 0;
            this.warmupId = null;
            this.warmupPlanned = null;
            this.warmupTimer = null;
        }

        isWarmup() {
            return this.warmupId != null && this.warmupId === this.sessionId && !this.sessionEnded;
        }

        open(params) {
            this.params = params;
            const url = WS_URL + (params.create ? "?create=1" : "?code=" + encodeURIComponent(params.code));
            let ws;
            try {
                ws = new WebSocket(url);
            } catch {
                return this.onClose(null);
            }
            ws.binaryType = "arraybuffer";
            this.ws = ws;
            this.welcomed = false;
            const openTimer = setTimeout(() => {
                if (ws.readyState === WebSocket.CONNECTING) ws.close();
            }, OPEN_TIMEOUT_MS);
            ws.addEventListener("open", () => {
                clearTimeout(openTimer);
                const mp = bridge();
                const profile = mp?.profile();
                ws.send(JSON.stringify({
                    t: "hello", v: visitorId(), nick: profile?.nickname ?? "Guest", country: profile?.countryCode ?? null,
                    car: profile?.carStyle?.serialize?.() ?? "", settings: params.create ? params.settings : undefined,
                }));
            });
            ws.addEventListener("message", (e) => {
                if (ws === this.ws) this.onMessage(e.data);
            });
            ws.addEventListener("close", () => {
                clearTimeout(openTimer);
                this.onClose(ws);
            });
        }

        onClose(ws) {
            if (ws && ws !== this.ws) return;
            this.ws = null;
            this.stopPinger();
            if (this.left || this.closed) return;
            const canRetry = !this.fatal && !this.kicked && this.code && this.tries < RECONNECT_TRIES;
            if (canRetry) {
                this.tries++;
                this.h.reconnecting(true);
                setTimeout(() => {
                    if (!this.left && !this.closed) this.open({ code: this.code });
                }, 800 * this.tries);
                return;
            }
            this.finish(this.kicked ? "kicked" : "disconnected", this.fatal || (this.kicked ? "You were kicked from the lobby." : "Lost connection to the lobby."));
        }

        finish(reason, text) {
            if (this.closed) return;
            this.closed = true;
            lobbyRun = null;
            clearTimeout(this.flushTimer);
            this.stopPinger();
            for (const cb of [...this.cb.lost]) cb(reason);
            this.h.closed(text);
        }

        leave() {
            if (this.closed) return;
            this.left = true;
            this.closed = true;
            lobbyRun = null;
            clearTimeout(this.flushTimer);
            this.stopPinger();
            this.sendJson({ t: "leave" });
            try {
                this.ws?.close(1000);
            } catch {}
            this.ws = null;
            this.h.closed(null);
        }

        sendJson(data) {
            const ws = this.ws;
            if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
        }

        startPinger() {
            this.stopPinger();
            this.pingTicks = 0;
            this.pingTimer = setInterval(() => this.ping(), PING_TICK_MS);
            this.ping();
        }

        stopPinger() {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }

        ping() {
            const ws = this.ws;
            if (!ws || ws.readyState !== WebSocket.OPEN) return;
            const phase = this.state?.phase;
            if ((!phase || phase === "lobby") && this.pingTicks++ % LOBBY_PING_EVERY) return;
            this.pingSent = performance.now();
            ws.send("ping");
        }

        serverNow() {
            return Date.now() + this.offset;
        }

        me() {
            return this.state?.players.find((p) => p.id === this.you) ?? null;
        }

        isHost() {
            return !!this.state && this.state.host === this.you;
        }

        inRace() {
            return this.cb.newSession.length > 0;
        }

        onMessage(data) {
            if (data === "pong") {
                if (this.pingSent != null) {
                    this.ownPing = Math.round(performance.now() - this.pingSent);
                    this.pingSent = null;
                    this.sendJson({ t: "ping", ms: this.ownPing });
                }
                return;
            }
            if (data instanceof ArrayBuffer) return this.onBinary(data);
            let m;
            try {
                m = JSON.parse(data);
            } catch {
                return;
            }
            switch (m?.t) {
            case "welcome":
                this.you = m.you;
                this.welcomed = true;
                this.tries = 0;
                this.h.reconnecting(false);
                this.startPinger();
                this.h.welcome(m);
                return;
            case "state":
                this.offset = m.now - Date.now();
                return this.applyState(m);
            case "rec": {
                const p = this.state?.players.find((q) => q.id === m.id);
                if (p) p.best = m.f;
                this.firePlayers();
                return this.h.update();
            }
            case "loaded": {
                const p = this.state?.players.find((q) => q.id === m.id);
                if (p) {
                    p.loaded = true;
                    p.inRound = m.inRound;
                }
                return this.h.update();
            }
            case "skip":
                if (!this.state) return;
                for (const p of this.state.players) p.skip = m.votes.includes(p.id);
                this.state.skipNeed = m.need;
                this.state.skipsLeft = m.left;
                return this.h.update();
            case "pings":
                this.pings = m.p || {};
                return;
            case "chat":
                return this.h.chat(m.m);
            case "msg":
                return this.h.toast(m.text);
            case "err":
                this.fatal = m.text;
                return;
            case "kicked":
                this.kicked = true;
                return;
            }
        }

        applyState(snap) {
            const prev = this.state;
            this.state = snap;
            this.code = snap.code;
            if (this.params?.create) this.params = { code: snap.code };
            const me = this.me();
            const racing = snap.phase === "loading" || snap.phase === "race";
            const warming = this.isWarmup();
            if (racing && me?.inRound && snap.session !== this.sessionId && this.loadingSession !== snap.session) {
                this.beginSession(snap.session, snap.track, false);
            } else if (racing && warming && !me?.inRound) {
                // Warmed up, but sits this round out (joined mid-match with late joining off).
                this.endSession();
                this.backToLobby();
            }
            if (!racing && this.sessionId && !this.sessionEnded && this.sessionId !== snap.warmup) this.endSession();
            if (snap.phase === "results" && snap.warmup != null && snap.nextTrack && me && !me.left && this.warmupPlanned !== snap.warmup) {
                this.warmupPlanned = snap.warmup;
                clearTimeout(this.warmupTimer);
                const delay = Math.max(0, Math.min(WARMUP_DELAY_MS, (snap.deadline - snap.now) / 3));
                this.warmupTimer = setTimeout(() => {
                    const now = this.state;
                    if (!this.closed && now?.phase === "results" && now.warmup === snap.warmup) this.beginSession(snap.warmup, snap.nextTrack, true);
                }, delay);
            }
            if (snap.phase === "lobby" && prev && prev.phase !== "lobby") this.backToLobby();
            this.firePlayers();
            this.h.state(snap, prev);
        }

        firePlayers() {
            for (const cb of [...this.cb.players]) cb(this.sessionId);
        }

        async beginSession(session, trackId, warmup) {
            this.loadingSession = session;
            const sitOut = (text) => {
                if (this.loadingSession === session) this.loadingSession = null;
                if (!warmup && this.state?.session === session) this.sendJson({ t: "loaded", s: session, fail: true });
                this.h.toast(text);
            };
            const entry = findTrack(trackId);
            if (!entry) return sitOut("This map isn't on your copy of the site yet. Reload the page to get the newest weeks.");
            let trackData;
            try {
                trackData = await entry.trackData();
            } catch {
                return sitOut("This map failed to load, so you sit it out.");
            }
            const current = warmup ? this.state?.warmup : this.state?.session;
            if (this.closed || this.loadingSession !== session || current !== session) return;
            this.loadingSession = null;
            this.flush();
            this.sessionId = session;
            this.sessionEnded = false;
            this.resetCounter = 0;
            this.buffer = [];
            this.bufferBytes = 0;
            this.loadedSent = false;
            this.selfRecord = null;
            this.warmupId = warmup ? session : null;
            const mode = bridge().GameMode.Competitive;
            const meta = entry.meta;
            lobbyRun = { code: this.code, ids: new Set([trackId, trackData.getId?.()].filter(Boolean)) };
            this.h.raceStarting(warmup);
            if (this.inRace()) {
                for (const cb of [...this.cb.newSession]) cb(session, mode, meta, trackData);
            } else {
                bridge().startRace(meta, trackData, { multiplayerConnection: this, sessionId: session, gameMode: mode });
            }
        }

        endSession() {
            this.flush();
            this.sessionEnded = true;
            for (const cb of [...this.cb.end]) cb();
        }

        // The race keeps the connection only while it hands over to the next race; going back to
        // the menu disposes it, so hold it open across that.
        backToLobby() {
            if (this.inRace()) {
                this.holdOpen = true;
                bridge().toMenu();
            }
            this.h.lobby();
        }

        dispose() {
            for (const key of Object.keys(this.cb)) this.cb[key] = [];
            lobbyRun = null;
            setTimeout(() => this.h.update(), 0);
            if (this.holdOpen) {
                this.holdOpen = false;
                return;
            }
            this.leave();
        }

        addConnectionLostCallback(cb) {
            if (this.closed) cb(this.kicked ? "kicked" : "disconnected");
            else this.cb.lost.push(cb);
        }

        removeConnectionLostCallback(cb) {
            this.cb.lost = this.cb.lost.filter((x) => x !== cb);
        }

        addCarResetCallback(cb) {
            this.cb.reset.push(cb);
        }

        removeCarResetCallback(cb) {
            this.cb.reset = this.cb.reset.filter((x) => x !== cb);
        }

        addCarUpdateCallback(cb) {
            this.cb.update.push(cb);
        }

        removeCarUpdateCallback(cb) {
            this.cb.update = this.cb.update.filter((x) => x !== cb);
        }

        addEndSessionCallback(session, cb) {
            this.cb.end.push(cb);
            if (session !== this.sessionId || this.sessionEnded) cb();
        }

        removeEndSessionCallback(cb) {
            this.cb.end = this.cb.end.filter((x) => x !== cb);
        }

        addNewSessionCallback(session, cb) {
            this.cb.newSession.push(cb);
            setTimeout(() => this.h.update(), 0);
        }

        removeNewSessionCallback(cb) {
            this.cb.newSession = this.cb.newSession.filter((x) => x !== cb);
        }

        addServerMessageCallback(cb) {
            this.cb.msg.push(cb);
        }

        removeServerMessageCallback(cb) {
            this.cb.msg = this.cb.msg.filter((x) => x !== cb);
        }

        addPlayersChangedCallback(cb) {
            this.cb.players.push(cb);
        }

        removePlayersChangedCallback(cb) {
            this.cb.players = this.cb.players.filter((x) => x !== cb);
        }

        ghostsOn() {
            return !!this.state?.settings.ghosts;
        }

        sendBinary(type, payload) {
            const ws = this.ws;
            if (!ws || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > MAX_BUFFERED) return;
            const out = new Uint8Array(9 + (payload ? payload.length : 0));
            out[0] = type;
            writeU32(out, 1, this.sessionId);
            writeU32(out, 5, this.resetCounter);
            if (payload) out.set(payload, 9);
            ws.send(out);
        }

        sendCarReset(session, counter) {
            if (session !== this.sessionId || this.sessionEnded) return;
            if (!this.loadedSent) {
                this.loadedSent = true;
                if (!this.isWarmup()) this.sendJson({ t: "loaded", s: session });
            }
            if (counter <= this.resetCounter) return;
            this.buffer = [];
            this.bufferBytes = 0;
            this.resetCounter = counter;
            if (this.ghostsOn()) this.sendBinary(2, null);
        }

        sendCarUpdate(session, counter, carState) {
            if (session !== this.sessionId || this.sessionEnded || !this.ghostsOn()) return;
            if (counter > this.resetCounter) {
                this.buffer = [];
                this.bufferBytes = 0;
                this.resetCounter = counter;
            } else if (counter < this.resetCounter) return;
            const bytes = bridge().CarState._c(carState);
            this.buffer.push(bytes);
            this.bufferBytes += bytes.length;
            if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), CAR_BATCH_MS);
        }

        flush() {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
            if (!this.buffer.length) return;
            const raw = new Uint8Array(this.bufferBytes);
            let at = 0;
            for (const b of this.buffer) {
                raw.set(b, at);
                at += b.length;
            }
            this.buffer = [];
            this.bufferBytes = 0;
            const deflate = new (bridge().pako.Deflate)({ level: 6 });
            deflate.push(raw, true);
            if (!deflate.err) this.sendBinary(1, deflate.result);
        }

        onBinary(buffer) {
            const d = new Uint8Array(buffer);
            if (d.length < 13) return;
            const type = d[0];
            const pid = readU32(d, 1);
            const session = readU32(d, 5);
            const counter = readU32(d, 9);
            if (session !== this.sessionId || this.sessionEnded) return;
            if (type === 2) {
                for (const cb of [...this.cb.reset]) cb(session, pid, counter);
                return;
            }
            if (type !== 1) return;
            const mp = bridge();
            const inflate = new mp.pako.Inflate();
            inflate.push(d.subarray(13), true);
            if (inflate.err || !(inflate.result instanceof Uint8Array)) return;
            const data = inflate.result;
            let at = 0;
            while (at < data.length) {
                let read;
                try {
                    read = mp.CarState.VO(data.subarray(at));
                } catch {
                    return;
                }
                at += read.numberOfBytes;
                const q = read.carState.quaternion;
                const len = Math.hypot(q.x, q.y, q.z, q.w);
                if (len === 0) Object.assign(q, { x: 0, y: 0, z: 0, w: 1 });
                else Object.assign(q, { x: q.x / len, y: q.y / len, z: q.z / len, w: q.w / len });
                for (const cb of [...this.cb.update]) cb(session, pid, counter, read.carState);
            }
        }

        sendRecord(session, time) {
            if (session !== this.sessionId || this.sessionEnded || this.isWarmup()) return;
            this.selfRecord = time.clone ? time.clone() : time;
            this.sendJson({ t: "rec", s: session, f: time.numberOfFrames });
            const me = this.me();
            if (me && (me.best == null || me.best < 0 || time.numberOfFrames < me.best)) me.best = time.numberOfFrames;
            this.firePlayers();
            this.h.update();
        }

        getPing(id) {
            return id === this.you ? this.ownPing : this.pings[id] ?? null;
        }

        style(text) {
            let style = this.styles.get(text);
            if (!style) {
                style = bridge().CarStyle.deserializeSafe(text || "");
                this.styles.set(text, style);
            }
            return style;
        }

        getPlayers() {
            const s = this.state;
            const mp = bridge();
            if (!s || !mp) return [];
            const warm = this.isWarmup();
            return s.players.filter((p) => p.id === this.you || (!p.left && (warm ? p.connected : p.inRound))).map((p) => {
                const self = p.id === this.you;
                const frames = warm ? null : self && this.selfRecord ? this.selfRecord.numberOfFrames : p.best;
                return {
                    id: p.id,
                    nickname: p.nick,
                    countryCode: p.country ? mp.country(p.country) : null,
                    carStyle: this.style(p.car),
                    record: frames > 0 ? new mp.Time(frames) : null,
                    isSelf: self,
                };
            });
        }

        getMaxPlayers() {
            return this.state?.settings.maxPlayers ?? 8;
        }
    }

    const CSS = `
.nsws-mp-overlay{position:fixed;inset:0;z-index:9998;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.72);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);color:var(--text-color);font-family:inherit;pointer-events:auto}
.nsws-mp-overlay.open{display:flex}
.nsws-mp-panel{width:min(1100px,96vw);height:min(760px,92vh);display:flex;flex-direction:column;background:var(--surface-color);clip-path:polygon(0 0,100% 0,calc(100% - 14px) 100%,0 100%);overflow:hidden}
.nsws-mp-head{display:flex;align-items:center;gap:14px;padding:14px 22px;background:var(--surface-secondary-color);flex-shrink:0;min-height:44px}
.nsws-mp-head h2{margin:0;font-size:32px;font-weight:400;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nsws-mp-body{flex:1;display:flex;gap:14px;padding:14px;overflow:hidden;min-height:0}
.nsws-mp-col{display:flex;flex-direction:column;gap:10px;min-width:0;min-height:0}
.nsws-mp-box{background:var(--surface-secondary-color);padding:12px 14px;display:flex;flex-direction:column;gap:8px;min-height:0}
.nsws-mp-box h3{margin:0;font-size:22px;font-weight:400;opacity:.75}
.nsws-mp-foot{display:flex;gap:10px;padding:10px 14px;background:var(--surface-secondary-color);flex-shrink:0;align-items:center;flex-wrap:wrap}
.nsws-mp-foot .grow{flex:1}
.nsws-mp-overlay .button{font-size:22px;padding:6px 16px}
.nsws-mp-overlay .button.small{font-size:16px;padding:3px 10px}
.nsws-mp-overlay .button.on{background-color:#2f6db5;box-shadow:inset 0 -3px 0 #9fdcff}
.nsws-mp-overlay .button.primary{background-color:#1d6b3a}
.nsws-mp-scroll{overflow-y:auto;min-height:0;flex:1}
.nsws-mp-scroll::-webkit-scrollbar{width:8px}.nsws-mp-scroll::-webkit-scrollbar-thumb{background:var(--button-hover-color)}
.nsws-mp-input{font:inherit;font-size:22px;color:var(--text-color);background:var(--surface-tertiary-color);border:none;padding:8px 12px;outline:none;min-width:0}
.nsws-mp-input:focus{background:var(--button-active-color)}
.nsws-mp-code{font-size:40px;letter-spacing:6px;text-transform:uppercase;text-align:center;width:100%;box-sizing:border-box}
.nsws-mp-row{display:flex;align-items:center;gap:10px;padding:6px 8px;background:var(--surface-tertiary-color);font-size:20px;min-height:34px}
.nsws-mp-row .grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nsws-mp-row .dim,.nsws-mp-dim{opacity:.55}
.nsws-mp-row.self{box-shadow:inset 3px 0 0 #6fd3ff}
.nsws-mp-row img.flag{width:24px;height:16px;object-fit:cover}
.nsws-mp-tag{font-size:14px;padding:1px 6px;background:var(--button-color);opacity:.9;white-space:nowrap}
.nsws-mp-tag.host{background:#8a6d12}.nsws-mp-tag.ready{background:#1d6b3a}.nsws-mp-tag.away{background:#6b1d1d}
.nsws-mp-field{display:flex;align-items:center;gap:10px;font-size:19px;flex-wrap:wrap}
.nsws-mp-field>label{flex:0 0 190px;opacity:.8}
.nsws-mp-field input[type=range]{flex:1;min-width:120px;accent-color:#6fd3ff}
.nsws-mp-field input[type=range]::-webkit-slider-thumb{width:18px;height:18px;margin:-7px 0 0 0;border-width:3px}
.nsws-mp-field .val{min-width:64px;text-align:right}
.nsws-mp-seg{display:flex;gap:4px;flex-wrap:wrap}
.nsws-mp-seg .button{font-size:16px!important;padding:3px 12px!important}
.nsws-mp-weeks{display:flex;flex-wrap:wrap;gap:5px}
.nsws-mp-weeks .button{font-size:16px!important;padding:3px 10px!important}
.nsws-mp-hint{font-size:15px;opacity:.6}
.nsws-mp-chatlog{display:flex;flex-direction:column;gap:3px;font-size:17px;overflow-y:auto;flex:1;min-height:60px;word-break:break-word}
.nsws-mp-chatlog .who{opacity:.65;margin-right:6px}
.nsws-mp-chatlog .sys{opacity:.5;font-style:italic}
.nsws-mp-banner{padding:10px 14px;background:#1d3f6b;font-size:20px}
.nsws-mp-error{color:#ff9a9a;font-size:18px;min-height:22px}
.nsws-mp-hud{position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:9990;display:none;flex-direction:column;align-items:center;gap:6px;pointer-events:none;color:var(--text-color);font-family:inherit}
.nsws-mp-hud.open{display:flex}
.nsws-mp-pill{background:rgba(25,32,66,.85);padding:6px 18px;font-size:24px;white-space:nowrap;clip-path:polygon(8px 0,100% 0,calc(100% - 8px) 100%,0 100%);display:flex;gap:14px;align-items:baseline}
.nsws-mp-pill .clock{font-size:30px;min-width:70px;text-align:center}
.nsws-mp-pill .clock.low{color:#ff8080}
.nsws-mp-hudbtns{display:flex;gap:6px;pointer-events:auto}
.nsws-mp-hudbtns .button{font-size:17px;padding:3px 12px}
.nsws-mp-hudbtns .button.on{background-color:#1d6b3a}
.nsws-mp-board{position:fixed;left:10px;top:50%;transform:translateY(-50%);z-index:9989;display:none;flex-direction:column;gap:2px;min-width:230px;max-width:300px;pointer-events:none;font-family:inherit;color:var(--text-color)}
.nsws-mp-board.open{display:flex}
.nsws-mp-board .r{display:flex;gap:8px;align-items:center;background:rgba(25,32,66,.78);padding:3px 10px;font-size:17px}
.nsws-mp-board .r.self{background:rgba(51,75,119,.92)}
.nsws-mp-board .r .n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nsws-mp-board .r .p{opacity:.6;font-size:14px;min-width:34px;text-align:right}
.nsws-mp-feed{position:fixed;left:10px;bottom:120px;z-index:9989;display:flex;flex-direction:column;gap:3px;pointer-events:none;max-width:380px;font-family:inherit;color:var(--text-color)}
.nsws-mp-feed div{background:rgba(25,32,66,.78);padding:3px 10px;font-size:16px;transition:opacity .5s}
.nsws-mp-toasts{position:fixed;top:120px;left:50%;transform:translateX(-50%);z-index:10000;display:flex;flex-direction:column;gap:4px;align-items:center;pointer-events:none;font-family:inherit;color:var(--text-color)}
.nsws-mp-toasts div{background:rgba(17,32,82,.92);padding:6px 16px;font-size:19px;transition:opacity .4s}
.nsws-mp-results{position:fixed;inset:0;z-index:9995;display:none;align-items:center;justify-content:center;pointer-events:none;font-family:inherit;color:var(--text-color)}
.nsws-mp-results.open{display:flex}
.nsws-mp-results .card{pointer-events:auto;width:min(720px,94vw);max-height:86vh;display:flex;flex-direction:column;background:var(--surface-color);clip-path:polygon(0 0,100% 0,calc(100% - 12px) 100%,0 100%)}
.nsws-mp-results .card.min{display:none}
.nsws-mp-results h2{margin:0;padding:12px 20px;background:var(--surface-secondary-color);font-size:30px;font-weight:400}
.nsws-mp-results .sub{padding:8px 20px 0;font-size:19px;opacity:.75}
.nsws-mp-results .list{padding:10px 14px;display:flex;flex-direction:column;gap:4px;overflow-y:auto}
.nsws-mp-results .foot{display:flex;gap:10px;align-items:center;padding:10px 14px;background:var(--surface-secondary-color)}
.nsws-mp-results .foot .grow{flex:1;font-size:19px;opacity:.8}
.nsws-mp-results .button{font-size:19px;padding:4px 14px}
.nsws-mp-results .gain{color:#7dff9e;min-width:44px;text-align:right}
.nsws-mp-podium{display:flex;justify-content:center;align-items:flex-end;gap:10px;padding:14px 14px 0}
.nsws-mp-podium div{display:flex;flex-direction:column;align-items:center;justify-content:flex-end;width:150px;background:var(--surface-secondary-color);padding:8px 6px;font-size:18px;text-align:center;overflow:hidden}
.nsws-mp-podium b{font-size:28px;font-weight:400}
.nsws-mp-results .reopen{pointer-events:auto;position:fixed;right:12px;top:50%;font-size:18px;padding:4px 12px}
body.nsws-mp-board-open .player-list-ui{display:none}
.nsws-mp-confirm{position:fixed;inset:0;z-index:10002;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);font-family:inherit;color:var(--text-color)}
.nsws-mp-confirm .card{width:min(520px,92vw);background:var(--surface-color);padding:20px;display:flex;flex-direction:column;gap:16px;clip-path:polygon(0 0,100% 0,calc(100% - 10px) 100%,0 100%)}
.nsws-mp-confirm .text{font-size:22px}
.nsws-mp-confirm .row{display:flex;gap:10px;justify-content:flex-end}
.nsws-mp-confirm .button{font-size:20px;padding:5px 16px}
.nsws-mp-confirm .button.primary{background-color:#1d6b3a}
`;

    const ui = {
        conn: null,
        root: null,
        view: null,
        listTimer: null,
        hudTimer: null,
        chat: [],
        minimized: false,
    };

    function ensureDom() {
        if (ui.root) return;
        const style = el("style");
        style.textContent = CSS;
        document.head.appendChild(style);
        ui.root = el("div", "nsws-mp-overlay");
        ui.root.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Escape") close();
        });
        ui.root.addEventListener("keyup", (e) => e.stopPropagation());
        document.body.appendChild(ui.root);
        ui.hud = el("div", "nsws-mp-hud");
        ui.pill = el("div", "nsws-mp-pill");
        ui.pillRound = el("span");
        ui.pillClock = el("span", "clock");
        ui.pillMap = el("span", "nsws-mp-dim");
        ui.pill.append(ui.pillRound, ui.pillClock, ui.pillMap);
        ui.hudBtns = el("div", "nsws-mp-hudbtns");
        ui.skipBtn = button("Skip map", () => {
            const me = ui.conn?.me();
            if (me) ui.conn.sendJson({ t: "skip", on: !me.skip });
        });
        ui.boardBtn = button("Standings", () => {
            ui.boardHidden = !ui.boardHidden;
            renderHud();
        });
        ui.endBtn = button("End match", () => {
            confirmBox("End the match for everyone and show the final standings?", "End match", () => ui.conn?.sendJson({ t: "end" }));
        });
        ui.hudBtns.append(ui.skipBtn, ui.boardBtn, ui.endBtn);
        ui.hud.append(ui.pill, ui.hudBtns);
        document.body.appendChild(ui.hud);
        ui.board = el("div", "nsws-mp-board");
        document.body.appendChild(ui.board);
        ui.feed = el("div", "nsws-mp-feed");
        document.body.appendChild(ui.feed);
        ui.toasts = el("div", "nsws-mp-toasts");
        document.body.appendChild(ui.toasts);
        ui.results = el("div", "nsws-mp-results");
        document.body.appendChild(ui.results);
    }

    function confirmBox(text, okText, onOk) {
        ensureDom();
        const shade = el("div", "nsws-mp-confirm");
        const card = el("div", "card");
        card.appendChild(el("div", "text", text));
        const row = el("div", "row");
        const done = () => shade.remove();
        row.append(button("Cancel", done), button(okText, () => {
            done();
            onOk();
        }, "primary"));
        card.appendChild(row);
        shade.appendChild(card);
        shade.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Escape") done();
        });
        document.body.appendChild(shade);
        row.lastChild.focus();
    }

    function toast(text, ms = 3500) {
        ensureDom();
        const t = el("div", null, text);
        ui.toasts.appendChild(t);
        while (ui.toasts.children.length > 4) ui.toasts.firstChild.remove();
        setTimeout(() => {
            t.style.opacity = "0";
            setTimeout(() => t.remove(), 450);
        }, ms);
    }

    function feed(text) {
        if (!ui.hud.classList.contains("open")) return;
        const line = el("div", null, text);
        ui.feed.appendChild(line);
        while (ui.feed.children.length > 5) ui.feed.firstChild.remove();
        setTimeout(() => {
            line.style.opacity = "0";
            setTimeout(() => line.remove(), 550);
        }, FEED_MS);
    }

    function open() {
        ensureDom();
        ui.root.classList.add("open");
        if (ui.conn && !ui.conn.closed) showLobby();
        else showHub();
    }

    function close() {
        clearInterval(ui.listTimer);
        ui.listTimer = null;
        ui.root?.classList.remove("open");
    }

    function panel(title, headExtra) {
        ui.root.innerHTML = "";
        clearInterval(ui.listTimer);
        ui.listTimer = null;
        const p = el("div", "nsws-mp-panel");
        const head = el("div", "nsws-mp-head");
        const h = el("h2", null, title);
        head.appendChild(h);
        if (headExtra) head.append(...headExtra);
        p.appendChild(head);
        ui.root.appendChild(p);
        return { p, head, h };
    }

    function flag(country) {
        const code = country && bridge()?.country(country);
        if (!code) return null;
        const img = el("img", "flag");
        img.src = "images/countries/" + code + ".svg";
        img.draggable = false;
        return img;
    }

    function showHub(error) {
        ui.view = "hub";
        const { p } = panel("Multiplayer", [button("Close", close)]);
        const body = el("div", "nsws-mp-body");
        p.appendChild(body);

        const left = el("div", "nsws-mp-col");
        left.style.flex = "1.6";
        const listBox = el("div", "nsws-mp-box");
        listBox.style.flex = "1";
        const listHead = el("div", "nsws-mp-field");
        const listTitle = el("h3", null, "Public lobbies");
        listTitle.style.flex = "1";
        const refresh = button("Refresh", () => loadList(), "small");
        listHead.append(listTitle, refresh);
        const list = el("div", "nsws-mp-scroll");
        list.style.display = "flex";
        list.style.flexDirection = "column";
        list.style.gap = "5px";
        listBox.append(listHead, list);
        left.appendChild(listBox);

        const right = el("div", "nsws-mp-col");
        right.style.flex = "1";
        const joinBox = el("div", "nsws-mp-box");
        joinBox.appendChild(el("h3", null, "Join with a code"));
        const code = el("input", "nsws-mp-input nsws-mp-code");
        code.maxLength = 5;
        code.placeholder = "CODE";
        code.spellcheck = false;
        code.autocomplete = "off";
        const err = el("div", "nsws-mp-error", error || "");
        const join = button("Join", () => tryJoin(), "primary");
        const tryJoin = () => {
            const value = code.value.trim().toUpperCase();
            if (!CODE_RE.test(value)) {
                err.textContent = "Lobby codes are 5 letters and numbers.";
                return;
            }
            connect({ code: value });
        };
        code.addEventListener("keydown", (e) => {
            if (e.key === "Enter") tryJoin();
        });
        joinBox.append(code, join, err);
        const createBox = el("div", "nsws-mp-box");
        createBox.appendChild(el("h3", null, "Host a match"));
        createBox.appendChild(el("div", "nsws-mp-hint", "Random Not So Weekly Shorts maps, a time limit per round, and everyone racing everyone. You pick the rules."));
        createBox.appendChild(button("Create lobby", () => showCreate(), "primary"));
        const how = el("div", "nsws-mp-box");
        how.appendChild(el("h3", null, "How it works"));
        for (const line of [
            "Each round is a random NSWS map with a time limit. Set your best time before the clock runs out.",
            "Head-to-head scoring: you score a point for every player you beat on that map.",
            "Don't like the map? Vote to skip it.",
            "Your personal bests still count on the leaderboards.",
        ]) how.appendChild(el("div", "nsws-mp-hint", "\u2022 " + line));
        right.append(joinBox, createBox, how);
        body.append(left, right);

        async function loadList() {
            refresh.disabled = true;
            try {
                const res = await fetch(LIST_URL, { cache: "no-store" });
                if (!res.ok) throw new Error();
                const data = await res.json();
                if (ui.view !== "hub") return;
                list.innerHTML = "";
                if (!data.lobbies?.length) list.appendChild(el("div", "nsws-mp-hint", "No public lobbies right now. Create one!"));
                for (const l of data.lobbies || []) {
                    const row = el("div", "nsws-mp-row");
                    const name = el("div", "grow");
                    name.append(el("span", null, l.name), el("span", "dim", "  " + l.host));
                    const status = l.phase === "lobby" ? "Waiting" : "Round " + l.round + "/" + l.rounds;
                    const full = l.players >= l.max;
                    const closed = l.phase !== "lobby" && !l.lateJoin;
                    const go = button(full ? "Full" : "Join", () => connect({ code: l.code }), "small");
                    go.disabled = full || closed;
                    row.append(name, el("span", "nsws-mp-tag", status), el("span", "dim", l.players + "/" + l.max), el("span", "dim", l.minutes + " min"), go);
                    list.appendChild(row);
                }
            } catch {
                if (ui.view === "hub") {
                    list.innerHTML = "";
                    list.appendChild(el("div", "nsws-mp-error", "Couldn't load the lobby list."));
                }
            } finally {
                refresh.disabled = false;
            }
        }
        loadList();
        ui.listTimer = setInterval(() => {
            if (ui.root.classList.contains("open") && document.visibilityState === "visible") loadList();
        }, LIST_REFRESH_MS);
        setTimeout(() => code.focus(), 0);
    }

    // The settings controls. `onChange` gets the full settings object after every change.
    function settingsForm(initial, editable, onChange) {
        const s = { ...DEFAULTS, ...initial };
        const box = el("div");
        box.style.display = "flex";
        box.style.flexDirection = "column";
        box.style.gap = "9px";
        const changed = () => onChange?.({ ...s });

        const name = el("input", "nsws-mp-input");
        name.maxLength = 32;
        name.placeholder = (bridge()?.profile()?.nickname || "My") + "'s lobby";
        name.value = s.name || "";
        name.disabled = !editable;
        name.style.flex = "1";
        name.addEventListener("input", () => {
            s.name = name.value;
            changed();
        });
        box.appendChild(field("Lobby name", name));

        function field(label, ...controls) {
            const f = el("div", "nsws-mp-field");
            f.append(el("label", null, label), ...controls);
            return f;
        }

        function range(label, key, min, max, unit) {
            const input = el("input");
            input.type = "range";
            input.min = String(min);
            input.max = String(max);
            input.value = String(s[key]);
            input.disabled = !editable;
            const val = el("span", "val");
            const show = () => val.textContent = s[key] + unit(s[key]);
            input.addEventListener("input", () => {
                s[key] = parseInt(input.value, 10);
                show();
                changed();
            });
            show();
            box.appendChild(field(label, input, val));
        }

        function seg(label, key, options, hint) {
            const wrap = el("div", "nsws-mp-seg");
            const buttons = options.map(([value, text]) => {
                const b = button(text, () => {
                    if (!editable) return;
                    s[key] = value;
                    paint();
                    changed();
                }, "small");
                b.disabled = !editable && s[key] !== value;
                return [value, b];
            });
            const hintEl = hint ? el("div", "nsws-mp-hint") : null;
            const paint = () => {
                for (const [value, b] of buttons) b.classList.toggle("on", s[key] === value);
                if (hintEl) hintEl.textContent = hint(s[key]);
            };
            wrap.append(...buttons.map(([, b]) => b));
            box.appendChild(field(label, wrap));
            if (hintEl) box.appendChild(hintEl);
            paint();
        }

        seg("Visibility", "public", [[true, "Public"], [false, "Private (code only)"]]);
        range("Rounds", "rounds", 1, 20, () => "");
        range("Minutes per round", "minutes", 1, 15, () => " min");
        range("Max players", "maxPlayers", 2, 16, () => "");
        range("Break between rounds", "intermission", 5, 60, () => " s");
        seg("Scoring", "scoring", [["h2h", "Head-to-head"], ["wins", "Round wins"]], (v) => v === "h2h"
            ? "Every round, you get a point for each player you beat. Beat all 3 rivals = 3 points."
            : "Only the round winner scores: 1 point per map won.");
        seg("Vote skip", "skip", [["majority", "Majority"], ["twothirds", "Two thirds"], ["all", "Everyone"], ["off", "Off"]]);
        seg("Opponents' times", "liveTimes", [[true, "Live"], [false, "Hidden until the round ends"]]);
        seg("Opponents' cars", "ghosts", [[true, "Shown"], [false, "Hidden"]]);
        seg("Join mid-match", "lateJoin", [[true, "Allowed"], [false, "Wait for next match"]]);
        seg("Warm-up in the break", "warmup", [[true, "On"], [false, "Off"]], (v) => v
            ? "After each round's results, everyone can practise the next map until the round starts. Warm-up times don't count."
            : "The break only shows the results.");

        const weeks = weekList();
        const chosen = new Set(Array.isArray(s.weeks) ? s.weeks : weeks.map((w) => w.week));
        const weekWrap = el("div", "nsws-mp-weeks");
        const count = el("span", "nsws-mp-hint");
        const weekButtons = weeks.map((w) => {
            const b = button("Week " + w.week, () => {
                if (!editable) return;
                if (chosen.has(w.week)) chosen.delete(w.week);
                else chosen.add(w.week);
                syncWeeks();
            }, "small");
            return [w, b];
        });
        const all = button("All", () => {
            if (!editable) return;
            weeks.forEach((w) => chosen.add(w.week));
            syncWeeks();
        }, "small");
        const paintWeeks = () => {
            for (const [w, b] of weekButtons) {
                b.classList.toggle("on", chosen.has(w.week));
                b.disabled = !editable && !chosen.has(w.week);
            }
            all.disabled = !editable;
            const maps = weeks.filter((w) => chosen.has(w.week)).reduce((n, w) => n + w.ids.length, 0);
            count.textContent = maps + (maps === 1 ? " map" : " maps") + (maps ? "" : " - pick at least one week");
        };
        const syncWeeks = () => {
            s.weeks = chosen.size === weeks.length ? null : weeks.filter((w) => chosen.has(w.week)).map((w) => w.week);
            paintWeeks();
            changed();
        };
        weekWrap.append(all, ...weekButtons.map(([, b]) => b));
        box.appendChild(field("Map pool", weekWrap));
        box.appendChild(count);
        paintWeeks();
        return { element: box, get: () => ({ ...s }) };
    }

    function showCreate() {
        ui.view = "create";
        const { p } = panel("Create lobby");
        const body = el("div", "nsws-mp-body");
        const scroll = el("div", "nsws-mp-box nsws-mp-scroll");
        scroll.style.flex = "1";
        const form = settingsForm(loadSettings(), true, null);
        scroll.appendChild(form.element);
        body.appendChild(scroll);
        p.appendChild(body);
        const foot = el("div", "nsws-mp-foot");
        const err = el("div", "nsws-mp-error grow");
        foot.append(button("Back", () => showHub()), err, button("Create", () => {
            const settings = form.get();
            const full = withPool(settings);
            if (!full.pool.length) {
                err.textContent = "Pick at least one week of maps.";
                return;
            }
            storageSet(SETTINGS_KEY, JSON.stringify(settings));
            connect({ create: true, settings: full });
        }, "primary"));
        p.appendChild(foot);
    }

    function showConnecting(text) {
        ui.view = "connecting";
        const { p } = panel(text);
        const body = el("div", "nsws-mp-body");
        body.style.alignItems = "center";
        body.style.justifyContent = "center";
        body.appendChild(el("div", "nsws-mp-hint", "Connecting to the lobby..."));
        p.appendChild(body);
        const foot = el("div", "nsws-mp-foot");
        foot.appendChild(button("Cancel", () => {
            ui.conn?.leave();
            showHub();
        }));
        p.appendChild(foot);
    }

    function connect(params) {
        if (!bridge()) {
            toast("The game is still loading.");
            return;
        }
        if (ui.conn && !ui.conn.closed) ui.conn.leave();
        ui.chat = [];
        const conn = new LobbyConnection({
            welcome: (m) => {
                if (ui.conn !== conn) return;
                ui.chat = (m.chat || []).slice();
            },
            state: (snap, prev) => {
                if (ui.conn !== conn) return;
                onState(snap, prev);
            },
            update: () => {
                if (ui.conn === conn) refresh();
            },
            chat: (m) => {
                if (ui.conn !== conn) return;
                ui.chat.push(m);
                if (ui.chat.length > CHAT_SHOWN) ui.chat.shift();
                if (ui.view === "lobby") renderChat();
                feed(m.nick + ": " + m.text);
            },
            toast: (text) => {
                if (ui.conn !== conn) return;
                toast(text);
                if (ui.view === "lobby") {
                    ui.chat.push({ sys: true, text });
                    if (ui.chat.length > CHAT_SHOWN) ui.chat.shift();
                    renderChat();
                }
            },
            reconnecting: (on) => {
                if (ui.conn === conn && on) toast("Reconnecting to the lobby...");
            },
            raceStarting: (warmup) => {
                if (ui.conn !== conn) return;
                close();
                if (warmup) {
                    ui.minimized = true;
                    toast("Warm-up on the next map - times don't count.");
                }
                renderMatchUi();
            },
            lobby: () => {
                if (ui.conn !== conn) return;
                ensureDom();
                ui.root.classList.add("open");
                showLobby();
            },
            closed: (text) => {
                if (ui.conn !== conn) return;
                ui.conn = null;
                hideMatchUi();
                if (text) {
                    if (ui.root.classList.contains("open") || !conn.inRace()) {
                        ui.root.classList.add("open");
                        showHub(text);
                    } else toast(text, 6000);
                } else if (ui.root.classList.contains("open")) showHub();
            },
        });
        ui.conn = conn;
        showConnecting(params.create ? "Creating lobby" : "Joining " + params.code);
        conn.open(params);
    }

    function hideMatchUi() {
        clearInterval(ui.hudTimer);
        ui.hudTimer = null;
        ui.hud?.classList.remove("open");
        ui.board?.classList.remove("open");
        ui.results?.classList.remove("open");
        if (ui.results) ui.results.innerHTML = "";
        ui.resultsKey = null;
        ui.boardKey = null;
        if (ui.feed) ui.feed.innerHTML = "";
        document.body.classList.remove("nsws-mp-board-open");
    }

    function onState(snap, prev) {
        const conn = ui.conn;
        const me = conn.me();
        if (!prev) {
            if (snap.phase === "lobby" || !me?.inRound) {
                ensureDom();
                ui.root.classList.add("open");
                showLobby();
            }
        } else if (ui.view === "lobby" && ui.root.classList.contains("open")) {
            const settingsChanged = JSON.stringify(prev.settings) !== JSON.stringify(snap.settings);
            if (settingsChanged && !conn.isHost()) renderLobby(true);
            else renderLobby(false);
        }
        if (prev && prev.phase !== snap.phase) {
            if (snap.phase === "results" || snap.phase === "final") ui.minimized = false;
        }
        renderMatchUi();
    }

    function refresh() {
        if (ui.view === "lobby" && ui.root.classList.contains("open")) renderLobby(false);
        renderMatchUi();
    }

    function showLobby() {
        ui.view = "lobby";
        ui.lobbyBuilt = null;
        renderLobby(true);
    }

    function renderLobby(rebuildSettings) {
        const conn = ui.conn;
        const s = conn?.state;
        if (!s) return;
        const host = conn.isHost();
        if (!ui.lobbyBuilt || ui.lobbyBuilt.host !== host || rebuildSettings && !host) buildLobby();
        const L = ui.lobbyBuilt;
        setText(L.title, s.settings.name);
        setText(L.code, s.code);
        setText(L.vis, s.settings.public ? "Public" : "Private");
        const me = conn.me();
        const inMatch = s.phase !== "lobby";
        L.banner.style.display = inMatch ? "" : "none";
        if (inMatch) {
            let text = "Match in progress - round " + s.round + " of " + s.settings.rounds + ".";
            if (s.phase === "final") text = "The match is over. Back to the lobby in a moment.";
            else if (!me?.inRound) text += s.settings.lateJoin || me?.rounds ? " You'll race from the next map." : " You'll play in the next match.";
            setText(L.banner, text);
        }

        L.players.innerHTML = "";
        const list = inMatch ? standings(s.players) : s.players;
        list.forEach((p, i) => {
            const row = el("div", "nsws-mp-row" + (p.id === conn.you ? " self" : ""));
            if (inMatch) row.appendChild(el("span", "dim", ordinal(i + 1)));
            const f = flag(p.country);
            if (f) row.appendChild(f);
            const name = el("div", "grow", p.nick);
            row.appendChild(name);
            if (p.id === s.host) row.appendChild(el("span", "nsws-mp-tag host", "HOST"));
            if (p.id === conn.you) row.appendChild(el("span", "nsws-mp-tag", "YOU"));
            if (!inMatch && p.ready) row.appendChild(el("span", "nsws-mp-tag ready", "READY"));
            if (p.left) row.appendChild(el("span", "nsws-mp-tag away", "LEFT"));
            else if (!p.connected) row.appendChild(el("span", "nsws-mp-tag away", "RECONNECTING"));
            if (inMatch) row.appendChild(el("span", null, p.points + " pts"));
            const ping = conn.getPing(p.id);
            if (ping != null) row.appendChild(el("span", "dim", ping + " ms"));
            if (host && p.id !== conn.you && !p.left) {
                row.appendChild(button("Make host", () => conn.sendJson({ t: "host", id: p.id }), "small"));
                row.appendChild(button("Kick", () => {
                    confirmBox('Kick "' + p.nick + '" from the lobby? They can\'t come back.', "Kick", () => conn.sendJson({ t: "kick", id: p.id }));
                }, "small"));
            }
            L.players.appendChild(row);
        });
        setText(L.count, s.players.filter((p) => !p.left).length + "/" + s.settings.maxPlayers);

        L.ready.style.display = inMatch ? "none" : "";
        L.ready.classList.toggle("on", !!me?.ready);
        setText(L.ready, me?.ready ? "Ready \u2713" : "Ready");
        L.start.style.display = host && !inMatch ? "" : "none";
        const readyCount = s.players.filter((p) => p.ready || p.id === s.host).length;
        setText(L.start, "Start match (" + readyCount + "/" + s.players.length + " ready)");
        L.end.style.display = host && inMatch && s.phase !== "final" ? "" : "none";
        L.toLobby.style.display = host && s.phase === "final" ? "" : "none";
        L.settingsNote.textContent = host ? (inMatch ? "Settings can change between matches." : "Changes apply for everyone right away.") : "Only the host can change these.";
        if (rebuildSettings || !L.form || L.formInMatch !== inMatch) {
            L.formInMatch = inMatch;
            L.settings.innerHTML = "";
            const initial = host ? { ...loadSettings(), ...s.settings, weeks: s.settings.weeks?.length && s.settings.weeks.length < weekList().length ? s.settings.weeks : null } : { ...s.settings, weeks: s.settings.weeks };
            L.form = settingsForm(initial, host && !inMatch, host ? (next) => {
                storageSet(SETTINGS_KEY, JSON.stringify(next));
                clearTimeout(ui.settingsTimer);
                ui.settingsTimer = setTimeout(() => {
                    const full = withPool(next);
                    if (full.pool.length) conn.sendJson({ t: "settings", settings: full });
                }, 450);
            } : null);
            L.settings.appendChild(L.form.element);
        }
    }

    function buildLobby() {
        const conn = ui.conn;
        const host = conn.isHost();
        const code = el("span", "nsws-mp-tag");
        code.style.fontSize = "26px";
        code.style.letterSpacing = "4px";
        code.style.cursor = "pointer";
        code.title = "Click to copy";
        code.addEventListener("click", () => {
            navigator.clipboard?.writeText(conn.code).then(() => toast("Lobby code copied."), () => {});
        });
        const vis = el("span", "nsws-mp-tag");
        const extra = [el("span", "nsws-mp-dim", "Code"), code, vis];
        if (host) {
            extra.push(button("Copy invite link", (b) => {
                const link = inviteLink(conn.code);
                navigator.clipboard?.writeText(link).then(() => toast("Invite link copied. Anyone who opens it joins this lobby."), () => {
                    b.textContent = link;
                });
            }, "small"));
        }
        extra.push(button("Hide", close));
        const { p, h } = panel("", extra);
        const banner = el("div", "nsws-mp-banner");
        p.appendChild(banner);
        const body = el("div", "nsws-mp-body");
        p.appendChild(body);

        const left = el("div", "nsws-mp-col");
        left.style.flex = "1";
        const playersBox = el("div", "nsws-mp-box");
        playersBox.style.flex = "1.2";
        const ph = el("div", "nsws-mp-field");
        const pt = el("h3", null, "Players");
        pt.style.flex = "1";
        const count = el("span", "nsws-mp-dim");
        ph.append(pt, count);
        const players = el("div", "nsws-mp-scroll");
        players.style.display = "flex";
        players.style.flexDirection = "column";
        players.style.gap = "4px";
        playersBox.append(ph, players);
        const chatBox = el("div", "nsws-mp-box");
        chatBox.style.flex = "1";
        chatBox.appendChild(el("h3", null, "Lobby chat"));
        const log = el("div", "nsws-mp-chatlog");
        const input = el("input", "nsws-mp-input");
        input.maxLength = 200;
        input.placeholder = "Say something...";
        input.addEventListener("keydown", (e) => {
            if (e.key !== "Enter") return;
            const text = input.value.trim();
            if (!text) return;
            conn.sendJson({ t: "chat", text });
            input.value = "";
        });
        chatBox.append(log, input);
        left.append(playersBox, chatBox);

        const right = el("div", "nsws-mp-col");
        right.style.flex = "1";
        const setBox = el("div", "nsws-mp-box nsws-mp-scroll");
        setBox.style.flex = "1";
        setBox.appendChild(el("h3", null, "Match settings"));
        const settingsNote = el("div", "nsws-mp-hint");
        const settings = el("div");
        setBox.append(settingsNote, settings);
        right.appendChild(setBox);
        body.append(left, right);

        const foot = el("div", "nsws-mp-foot");
        const ready = button("Ready", () => conn.sendJson({ t: "ready", on: !conn.me()?.ready }));
        const start = button("Start match", () => conn.sendJson({ t: "start" }), "primary");
        const end = button("End match", () => {
            confirmBox("End the match for everyone and show the final standings?", "End match", () => conn.sendJson({ t: "end" }));
        });
        const toLobby = button("Back to lobby now", () => conn.sendJson({ t: "lobby" }));
        const leave = button("Leave lobby", () => {
            conn.leave();
            showHub();
        });
        foot.append(leave, el("div", "grow"), end, toLobby, ready, start);
        p.appendChild(foot);
        ui.lobbyBuilt = { host, title: h, code, vis, banner, players, count, log, ready, start, end, toLobby, settings, settingsNote, form: null };
        renderChat();
    }

    function renderChat() {
        const log = ui.lobbyBuilt?.log;
        if (!log) return;
        const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 30;
        log.innerHTML = "";
        for (const m of ui.chat) {
            const line = el("div", m.sys ? "sys" : null);
            if (m.sys) line.textContent = m.text;
            else line.append(el("span", "who", m.nick + ":"), document.createTextNode(m.text));
            log.appendChild(line);
        }
        if (atBottom) log.scrollTop = log.scrollHeight;
    }

    function renderMatchUi() {
        ensureDom();
        const conn = ui.conn;
        const s = conn?.state;
        const racingUi = !!s && s.phase !== "lobby" && conn.inRace();
        ui.hud.classList.toggle("open", racingUi);
        if (racingUi && !ui.hudTimer) ui.hudTimer = setInterval(renderHud, 250);
        if (!racingUi && ui.hudTimer) {
            clearInterval(ui.hudTimer);
            ui.hudTimer = null;
        }
        renderHud();
        renderResults();
    }

    function renderHud() {
        const conn = ui.conn;
        const s = conn?.state;
        if (!s || !ui.hud.classList.contains("open")) {
            ui.board.classList.remove("open");
            return;
        }
        const me = conn.me();
        const now = conn.serverNow();
        const warm = conn.isWarmup();
        const label = trackLabel(warm ? s.nextTrack : s.track);
        setText(ui.pillRound, warm ? "Warm-up" : "Round " + s.round + "/" + s.settings.rounds);
        let clock = "";
        if (s.phase === "loading") {
            const racers = s.players.filter((p) => p.inRound && !p.left && p.connected);
            clock = "Loading " + racers.filter((p) => p.loaded).length + "/" + racers.length;
        } else if (s.phase === "race" && s.endsAt) clock = fmtClock(s.endsAt - now);
        else if (s.phase === "results") clock = (warm ? "Round " + (s.round + 1) + " in " : "Next in ") + fmtClock(s.deadline - now);
        else if (s.phase === "final") clock = "Match over";
        setText(ui.pillClock, clock);
        ui.pillClock.classList.toggle("low", s.phase === "race" && s.endsAt - now < 15000);
        setText(ui.pillMap, label.name + (label.where ? " \u00b7 " + label.where : ""));

        const racing = s.phase === "loading" || s.phase === "race";
        const canSkip = racing && me?.inRound && s.settings.skip !== "off" && s.skipsLeft > 0;
        ui.skipBtn.style.display = canSkip ? "" : "none";
        const votes = s.players.filter((p) => p.skip).length;
        setText(ui.skipBtn, (me?.skip ? "Skipping \u2713 " : "Skip map ") + votes + "/" + s.skipNeed);
        ui.skipBtn.classList.toggle("on", !!me?.skip);
        ui.endBtn.style.display = conn.isHost() && racing ? "" : "none";
        setText(ui.boardBtn, ui.boardHidden ? "Show standings" : "Hide standings");

        ui.board.classList.toggle("open", !ui.boardHidden && racing);
        if (!ui.boardHidden && racing) {
            const rows = s.players.filter((p) => (p.inRound || p.best != null) && !p.left)
                .sort((a, b) => rank(a) - rank(b) || b.points - a.points);
            const key = JSON.stringify(rows.map((p) => [p.id, p.best, p.points, p.skip]));
            if (key !== ui.boardKey) {
                ui.boardKey = key;
                ui.board.innerHTML = "";
                rows.forEach((p, i) => {
                    const r = el("div", "r" + (p.id === conn.you ? " self" : ""));
                    r.append(el("span", null, String(i + 1)), el("span", "n", p.nick), el("span", null, p.best == null ? "--:--.---" : fmtTime(p.best)), el("span", "p", p.points + "p"));
                    ui.board.appendChild(r);
                });
            }
        }
    }

    function rank(p) {
        if (p.best == null) return Infinity;
        if (p.best < 0) return 1e9;
        return p.best;
    }

    function renderResults() {
        const conn = ui.conn;
        const s = conn?.state;
        const show = !!s && (s.phase === "results" || s.phase === "final");
        ui.results.classList.toggle("open", show);
        document.body.classList.toggle("nsws-mp-board-open", show && !ui.minimized);
        if (!show) {
            ui.resultsKey = null;
            return;
        }
        const key = s.phase + ":" + s.session + ":" + s.round + ":" + ui.minimized + ":" + conn.isHost() + ":" + JSON.stringify(s.players.map((p) => [p.id, p.points, p.left, p.connected]));
        if (key === ui.resultsKey) return updateResultsClock();
        ui.resultsKey = key;
        ui.results.innerHTML = "";
        if (ui.minimized) {
            ui.results.appendChild(button(s.phase === "final" ? "Show final standings" : "Show results", () => {
                ui.minimized = false;
                renderResults();
            }, "reopen"));
            return;
        }
        const card = el("div", "card");
        const byId = new Map(s.players.map((p) => [p.id, p]));
        if (s.phase === "results" && s.results) {
            const r = s.results;
            const label = trackLabel(r.track);
            card.appendChild(el("h2", null, "Round " + r.round + " results"));
            card.appendChild(el("div", "sub", label.name + (label.where ? " \u00b7 " + label.where : "")));
            const list = el("div", "list");
            for (const row of r.rows) {
                const p = byId.get(row.id);
                const line = el("div", "nsws-mp-row" + (row.id === conn.you ? " self" : ""));
                line.append(el("span", null, row.place ? ordinal(row.place) : "-"), el("div", "grow", p?.nick ?? "?"),
                    el("span", null, fmtTime(row.f)), el("span", "gain", "+" + row.gained), el("span", "dim", (p?.points ?? 0) + " pts"));
                list.appendChild(line);
            }
            card.appendChild(list);
        } else {
            card.appendChild(el("h2", null, "Final standings"));
            const table = standings(s.players);
            const podium = el("div", "nsws-mp-podium");
            const heights = [120, 150, 100];
            for (const idx of [1, 0, 2]) {
                const p = table[idx];
                if (!p) continue;
                const step = el("div");
                step.style.height = heights[idx === 0 ? 1 : idx === 1 ? 0 : 2] + "px";
                step.append(el("b", null, ordinal(idx + 1)), el("span", null, p.nick), el("span", "nsws-mp-dim", p.points + " pts"));
                podium.appendChild(step);
            }
            card.appendChild(podium);
            const list = el("div", "list");
            table.forEach((p, i) => {
                const line = el("div", "nsws-mp-row" + (p.id === conn.you ? " self" : ""));
                line.append(el("span", null, ordinal(i + 1)), el("div", "grow", p.nick + (p.left ? " (left)" : "")),
                    el("span", null, p.points + " pts"), el("span", "dim", p.wins + (p.wins === 1 ? " win" : " wins")));
                list.appendChild(line);
            });
            for (const h of s.history || []) {
                const label = trackLabel(h.track);
                const winners = h.winners.map((id) => byId.get(id)?.nick ?? "?").join(", ") || "nobody finished";
                list.appendChild(el("div", "nsws-mp-hint", "Round " + h.round + ": " + label.name + " - " + winners));
            }
            card.appendChild(list);
        }
        const foot = el("div", "foot");
        ui.resultsClock = el("div", "grow");
        foot.appendChild(ui.resultsClock);
        if (s.phase === "final" && conn.isHost()) foot.appendChild(button("Back to lobby now", () => conn.sendJson({ t: "lobby" })));
        foot.appendChild(button("Lobby", () => {
            ensureDom();
            ui.root.classList.add("open");
            showLobby();
        }));
        foot.appendChild(button("Hide", () => {
            ui.minimized = true;
            renderResults();
        }));
        card.appendChild(foot);
        ui.results.appendChild(card);
        updateResultsClock();
    }

    function updateResultsClock() {
        const conn = ui.conn;
        const s = conn?.state;
        if (!s || !ui.resultsClock) return;
        const left = fmtClock(s.deadline - conn.serverNow());
        const text = s.phase === "final" ? "Back to the lobby in " + left
            : s.results?.last ? "Final standings in " + left : "Next map in " + left;
        setText(ui.resultsClock, text);
    }

    setInterval(() => {
        if (ui.results?.classList.contains("open")) updateResultsClock();
    }, 500);

    window.addEventListener("pagehide", () => {
        if (ui.conn && !ui.conn.closed) ui.conn.leave();
    });

    window.__nswsLobby = { open };
    // Called when the menu first appears; true when it joined an invite link's lobby.
    window.__nswsLobbyOnLoad = () => {
        if (!pendingLobby) return false;
        const code = pendingLobby;
        pendingLobby = null;
        ensureDom();
        ui.root.classList.add("open");
        connect({ code });
        return true;
    };
})();
