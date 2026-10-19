// Site traffic for the owner dashboard, the owner's anti-cheat track sync, and the notice
// shown when a run fails the anti-cheat. Beats carry random ids, the nickname and what the
// player is doing; never the account token.
(function () {
    const API = window.__nswsApiBase;
    if (!API || !window.fetch || !window.crypto || !crypto.getRandomValues) return;

    // sha256("nsws-owner:" + token); the Worker checks the same hash before sending any stats.
    const OWNER_HASH = "965911be14a967812d548ebc4dd604e6d1a16601ffa26dc995532628fd0b6a6a";
    const VISITOR_KEY = "nsws_visitor";
    const BEAT_VISIBLE_S = 60;
    const MAX_GAP_S = 1800;
    const MIN_GAP_MS = 15000;
    // A longer gap between samples means the tab was frozen or the machine slept.
    const MAX_SAMPLE_S = 5;
    const TRACK_ID = /^[0-9a-f]{64}$/;
    const TRACK_EVENTS = { attempts: 0, finishes: 1, uploads: 2 };

    const randomHex = (bytes) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
    const sessionId = randomHex(16);
    let visitorId = null;
    try {
        visitorId = localStorage.getItem(VISITOR_KEY);
    } catch {}
    if (!/^[0-9a-f]{32}$/.test(visitorId || "")) {
        visitorId = randomHex(16);
        try {
            localStorage.setItem(VISITOR_KEY, visitorId);
        } catch {}
    }

    function readProfile() {
        try {
            const slot = parseInt(localStorage.getItem("polytrack_v5_prod_user_slot") ?? "0", 10);
            return JSON.parse(localStorage.getItem("polytrack_v5_prod_user_" + (slot >= 0 ? slot : 0)));
        } catch {
            return null;
        }
    }

    let runtime = 0;
    let focus = 0;
    let driving = 0;
    let events = {};
    let tracks = {};
    let seq = 0;
    let sentNick = null;
    let currentTrack = null;
    let seenAnn = null;
    let lastSample = performance.now();
    let lastBeat = -Infinity;
    // Only a tab that is shown beats. A hidden one sends nothing: once the gap its last beat promised
    // runs out the server counts it as away (still online) until it says goodbye on close, or for two
    // hours. It beats again as soon as it is shown. The beat reply stretches the gap when the site is busy (nv).
    let visibleGap = BEAT_VISIBLE_S;
    let promised = BEAT_VISIBLE_S;

    function currentState() {
        if (document.querySelector(".editor-ui")) return "editor";
        if (document.querySelector(".preview-toolbar-ui")) return "watch";
        if (document.querySelector(".game-ui")) return "race";
        if (document.querySelector(".customization-ui")) return "garage";
        return "menu";
    }

    function sample() {
        const now = performance.now();
        const seconds = Math.min((now - lastSample) / 1000, MAX_SAMPLE_S);
        lastSample = now;
        if (!(seconds > 0) || document.visibilityState === "hidden") return;
        runtime += seconds;
        if (document.hasFocus()) {
            focus += seconds;
            if (currentState() === "race") driving += seconds;
        }
    }

    function beat(end) {
        sample();
        const state = currentState();
        const body = {
            s: sessionId,
            v: visitorId,
            n: seq++,
            rt: Math.round(runtime * 10) / 10,
            ft: Math.round(focus * 10) / 10,
            dt: Math.round(driving * 10) / 10,
            nx: visibleGap,
            st: state,
            tk: state === "race" ? currentTrack : null,
            ev: events,
            tr: tracks,
        };
        if (end) body.end = 1;
        if (seenAnn) body.an = seenAnn;
        const watching = window.__nswsAnnounce?.watching?.();
        if (watching) body.pl = watching;
        if (body.n === 0 && document.referrer) {
            try {
                const host = new URL(document.referrer).host;
                if (host && host !== location.host) body.ref = host;
            } catch {}
        }
        const nick = readProfile()?.nickname;
        if (typeof nick === "string" && nick !== sentNick) body.nick = nick;

        const sent = { runtime, focus, driving, events, tracks, seenAnn };
        const asked = performance.now();
        runtime = focus = driving = 0;
        seenAnn = null;
        events = {};
        tracks = {};
        lastBeat = performance.now();
        promised = body.nx;
        // Counts the server didn't store go out again with the next beat, unless the page is going away.
        const keep = () => {
            if (end) return;
            runtime += sent.runtime;
            focus += sent.focus;
            driving += sent.driving;
            seenAnn = seenAnn || sent.seenAnn;
            for (const [k, v] of Object.entries(sent.events)) events[k] = (events[k] || 0) + v;
            for (const [k, v] of Object.entries(sent.tracks)) {
                const t = tracks[k] || (tracks[k] = [0, 0, 0]);
                for (let i = 0; i < 3; i++) t[i] += v[i];
            }
        };
        fetch(API + "nsws/beat", {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: JSON.stringify(body),
            keepalive: true,
            credentials: "omit",
        }).then((response) => {
            if (!response.ok) return;
            if (body.nick) sentNick = body.nick;
            if (response.status === 200) {
                response.json().then((data) => {
                    if (data?.busy) {
                        keep();
                        if (sentNick === body.nick) sentNick = null;
                        window.__nswsBusy?.fromData(data);
                    } else if (Number.isSafeInteger(data?.online)) {
                        window.__nswsBusy?.clear();
                    }
                    if (data && "ann" in data) window.__nswsAnnounce?.receive(data.ann, asked);
                    if (data?.pv) window.__nswsAnnounce?.pollUpdate?.(data.pv);
                    if (Number.isSafeInteger(data?.nv) && data.nv >= BEAT_VISIBLE_S) visibleGap = Math.min(data.nv, MAX_GAP_S);
                    if (!Number.isSafeInteger(data?.online)) return;
                    window.__nswsPlayersOnline = data.online;
                    window.__nswsPlayersAway = Number.isSafeInteger(data.away) ? data.away : 0;
                    window.dispatchEvent(new CustomEvent("nsws-players-online", { detail: data.online }));
                }, () => {});
            }
        }).catch(keep);
    }

    function tick() {
        sample();
        if (document.visibilityState === "hidden") return;
        if (performance.now() - lastBeat >= Math.min(promised, visibleGap) * 1000) beat(false);
    }

    setInterval(tick, 1000);
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "hidden") tick();
    });
    window.addEventListener("pagehide", () => beat(true));
    window.addEventListener("pageshow", (e) => {
        if (e.persisted) {
            lastSample = performance.now();
            beat(false);
        }
    });

    window.__nswsTraffic = {
        event(name, track) {
            events[name] = (events[name] || 0) + 1;
            // The weekly bingo (mod/nsws_bingo.js) counts the same things.
            window.dispatchEvent(new CustomEvent("nsws-traffic", { detail: { name, track: typeof track === "string" ? track : null } }));
            if (typeof track !== "string" || !TRACK_ID.test(track) || !(name in TRACK_EVENTS)) return;
            const t = tracks[track] || (tracks[track] = [0, 0, 0]);
            t[TRACK_EVENTS[name]]++;
            if (name === "attempts") currentTrack = track;
        },
        seen(id) {
            seenAnn = id;
        },
        // Resolves to { votes, choice } (the vote that stands), or rejects with { status, error, votes }.
        async vote(id, choice) {
            const response = await fetch(API + "nsws/poll", {
                method: "POST",
                headers: { "Content-Type": "text/plain" },
                body: JSON.stringify({ v: visitorId, id, c: choice }),
                credentials: "omit",
                cache: "no-store",
            });
            const data = await response.json().catch(() => null);
            if (!response.ok || !Array.isArray(data?.votes)) throw { status: response.status, error: data?.error, votes: data?.votes };
            return data;
        },
        // The beat reply carries the same online count Race Control shows.
        refreshOnline() {
            if (performance.now() - lastBeat >= MIN_GAP_MS * visibleGap / BEAT_VISIBLE_S) beat(false);
        },
    };

    async function ownerToken() {
        const token = readProfile()?.token;
        if (typeof token !== "string" || !TRACK_ID.test(token) || !crypto.subtle) return null;
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("nsws-owner:" + token));
        const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
        return hash === OWNER_HASH ? token : null;
    }

    function ownerPost(path, token, extra) {
        return fetch(API + "nsws/" + path, {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: JSON.stringify({ token, ...extra }),
            credentials: "omit",
            cache: "no-store",
        });
    }

    // The Worker can't decrypt or build tracks itself, so the owner's game sends each
    // Not So Weekly Shorts track's physics data the first time it is missing there.
    let syncing = null;
    function syncTracks(force) {
        if (syncing) return syncing;
        syncing = (async () => {
            const token = await ownerToken();
            if (!token || !window.__nswsTrackCheckData || !window.__nswsTracksForWeek) return { synced: 0, total: 0 };
            const status = await ownerPost("anticheat", token, {});
            if (!status.ok) throw new Error("HTTP " + status.status);
            const have = new Set((await status.json()).tracks.map((t) => t.id));
            const ids = [...new Set((window.__nswsWeeks || []).flatMap((w) => window.__nswsTracksForWeek(w.week).map((t) => t.id)))]
                .filter((id) => force || !have.has(id));
            let synced = 0;
            // One track per request keeps each one well inside the Worker's CPU limit.
            for (const id of ids) {
                const track = await window.__nswsTrackCheckData(id).catch(() => null);
                if (!track) continue;
                const response = await ownerPost("anticheat/tracks", token, { tracks: [track] });
                if (response.ok) synced++;
            }
            return { synced, total: ids.length };
        })().finally(() => {
            syncing = null;
        });
        return syncing;
    }

    // The Worker notes each NSWS board's first place when it serves the board (for the NSWS King tag),
    // so boards nobody opens would never count; the owner's page opens every one now and then.
    const WR_SWEEP_KEY = "_nswsWrSweep";
    const WR_SWEEP_MS = 12 * 3600_000;
    async function sweepWrs() {
        let last = 0;
        try {
            last = Number(localStorage.getItem(WR_SWEEP_KEY)) || 0;
        } catch {}
        if (Date.now() - last < WR_SWEEP_MS || !window.__nswsTracksForWeek || !window.__nswsTrackQuery) return;
        try {
            localStorage.setItem(WR_SWEEP_KEY, String(Date.now()));
        } catch {}
        const ids = [...new Set((window.__nswsWeeks || []).flatMap((w) => window.__nswsTracksForWeek(w.week).map((t) => t.id)))];
        for (const id of ids) {
            await fetch(API + "v6/leaderboard?version=0.6.2&trackId=" + id + "&skip=0&amount=1&onlyVerified=false" + window.__nswsTrackQuery(id),
                { credentials: "omit", cache: "no-store" }).catch(() => {});
        }
    }

    let autoSynced = false;
    let panelScript = null;
    window.__nswsOwner = {
        check: () => ownerToken().then((token) => {
            if (token && !autoSynced) {
                autoSynced = true;
                setTimeout(() => syncTracks(false).catch(() => {}).then(sweepWrs), 4000);
            }
            return !!token;
        }, () => false),
        syncTracks,
        token: ownerToken,
        api: API,
        async open() {
            if (!(await ownerToken())) return;
            if (!panelScript) {
                panelScript = new Promise((resolve, reject) => {
                    const script = document.createElement("script");
                    script.src = "mod/nsws_owner.js";
                    script.onload = resolve;
                    script.onerror = () => {
                        panelScript = null;
                        reject(new Error("Failed to load the owner dashboard"));
                    };
                    document.head.appendChild(script);
                });
            }
            await panelScript;
            window.__nswsOwnerPanel.open();
        },
    };

    let lastNotice = 0;
    window.__nswsRunRejected = () => {
        if (Date.now() - lastNotice < 15000) return;
        lastNotice = Date.now();
        const note = document.createElement("div");
        note.textContent = "This run failed the anti-cheat check, so it wasn't uploaded.";
        note.style.cssText = "position:fixed;left:50%;bottom:72px;transform:translateX(-50%);z-index:10003;" +
            "background:var(--surface-color,#28346a);color:#fff;padding:12px 22px;font-size:18px;" +
            "clip-path:polygon(8px 0,100% 0,calc(100% - 8px) 100%,0 100%);box-shadow:0 8px 24px rgba(0,0,0,.4);pointer-events:none;";
        document.body.appendChild(note);
        setTimeout(() => note.remove(), 6000);
    };

    beat(false);
})();
