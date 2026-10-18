// Weekly bingo. Every NSWS week has one 5x5 card, the same for everyone, made from that week's tracks
// (one column per track: B I N G O) and harder things to do on the site, with a free centre. Squares
// mark themselves as the player plays; the Worker keeps the marks (Accounts.markBingo, live week only)
// and counts bingos, a full row, column or diagonal, over every week for the bingo tags. A card with a
// bingo can be swapped for a new one (round + 1); its bingos stay counted.
//
// Only finished runs count, and medal squares judge each run's own time, so restarting, idling or
// opening menus never marks anything.
(function () {
    const SIZE = 5;
    const FREE = 12;
    const LETTERS = "BINGO";
    const ICON = "images/bingo.svg";
    const PROGRESS_KEY = "_nswsBingo2:";
    const ROUND_KEY = "_nswsBingoRound:";
    const MARK_DELAY_MS = 800;
    const POPUP_MS = 3400;
    const RESET_CONFIRM_MS = 6000;
    const MEDAL_RETRY_MS = 15000;
    const MEDAL_RANK = { bronze: 1, silver: 2, gold: 3, author: 4 };
    const ENV_COLORS = { Winter: "#bed8f7", Desert: "#ede2af" };

    // once: judged from the leaderboard or saved medals rather than runs, so only on a week's first card.
    const TASKS = {
        easy: [
            { id: "bronze", text: (n) => "Bronze time on " + n },
            { id: "finish3", text: (n) => "Finish " + n + " 3 times" },
        ],
        medium: [
            { id: "silver", text: (n) => "Silver time on " + n },
            { id: "bronze3", text: (n) => "3 bronze-time runs on " + n },
            { id: "finish10", text: (n) => "Finish " + n + " 10 times" },
            { id: "tophalf", text: (n) => "Top half on " + n, once: true },
        ],
        hard: [
            { id: "gold", text: (n) => "Gold time on " + n },
            { id: "silver3", text: (n) => "3 silver-time runs on " + n },
            { id: "top10", text: (n) => "Top 10 on " + n, once: true },
        ],
        epic: [
            { id: "author", text: (n) => "Author time on " + n },
            { id: "gold3", text: (n) => "3 gold-time runs on " + n },
            { id: "top3", text: (n) => "Top 3 on " + n, once: true },
        ],
    };
    const ACTIVITIES = [
        { id: "finish25", text: "Finish 25 runs on this week's tracks", hint: "Any of this week's tracks. Only finished runs count." },
        { id: "drive15", text: "Drive 15 minutes of finished runs", hint: "Adds up the times of your finished runs, on any track." },
        { id: "bronzeall", text: "Bronze time on every track", hint: "A run inside the bronze time on each of this week's tracks." },
        { id: "gold2", text: "Gold time on 2 tracks", hint: "Two different tracks from this week." },
        { id: "silver5", text: "5 silver-time runs this week", hint: "Runs inside the silver time on any of this week's tracks." },
        { id: "clean5", text: "Finish 5 runs in a row without restarting", hint: "Same track, every run to the finish line. A restart before the finish starts the count again." },
        { id: "past3", text: "Finish 3 tracks from older weeks", hint: "Older weeks are further down the Play menu." },
        { id: "pastsilver", text: "Silver time on an older week's track", hint: "Older weeks are further down the Play menu." },
        { id: "kodub3", text: "Finish 3 Official & Community tracks", hint: "Play menu, top right: Official & Community." },
        { id: "cup", text: "Finish a race in a cup", hint: "Competitions on the main menu." },
        // Retired, but kept in the shuffle so cards already in play keep their squares where the marks are.
        { id: "days3", retired: true },
        { id: "share", text: "Share a PB image", hint: "Press Share PB on the banner after a new personal best." },
    ];

    const CSS = `
.nsws-bingo-btn>img{width:22px;height:22px;}
#nsws-bingo{position:fixed;inset:0;z-index:9998;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.7);}
#nsws-bingo *{box-sizing:border-box;}
#nsws-bingo>.box{position:relative;display:flex;flex-direction:column;width:min(820px,96vw);max-height:94vh;background:var(--surface-color);color:var(--text-color);clip-path:polygon(0 0,100% 0,calc(100% - 14px) 100%,0 100%);outline:none;}
#nsws-bingo .checker{height:8px;flex-shrink:0;background:repeating-conic-gradient(#fff 0 25%,#112052 0 50%) 0 0/8px 8px;opacity:.85;}
#nsws-bingo .top{display:flex;align-items:center;gap:10px;padding:10px 20px;background:var(--surface-secondary-color);}
#nsws-bingo .top>h1{margin:0 auto 0 0;font-size:32px;font-weight:normal;color:#b3c1ff;text-shadow:0 2px 0 #112052;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#nsws-bingo .top>h1>small{font-size:20px;color:rgba(255,255,255,.6);text-shadow:none;}
#nsws-bingo .top>.button{margin:0;font-size:20px;padding:6px 14px;}
#nsws-bingo .top>.button:disabled{opacity:.35;}
#nsws-bingo .body{overflow-y:auto;padding:14px 20px 20px;}
#nsws-bingo .heads,#nsws-bingo .squares{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:6px;}
#nsws-bingo .squares{position:relative;grid-auto-rows:1fr;}
#nsws-bingo .head{display:flex;flex-direction:column;align-items:center;justify-content:flex-end;padding:2px 0 4px;min-width:0;}
#nsws-bingo .head>b{font-weight:normal;font-size:38px;line-height:1;color:#ffc94a;text-shadow:0 3px 0 #112052;}
#nsws-bingo .head>span{max-width:100%;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#nsws-bingo .cell{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;min-height:78px;padding:6px 8px;border:0;background:var(--button-color);color:var(--text-color);font:inherit;font-size:15px;line-height:1.2;text-align:center;overflow-wrap:anywhere;cursor:default;}
#nsws-bingo .cell.go{cursor:pointer;}
#nsws-bingo .cell.go:hover{background:var(--button-hover-color);}
#nsws-bingo .cell>span{position:relative;z-index:1;}
#nsws-bingo .cell>.count{font-size:13px;color:rgba(255,255,255,.55);}
#nsws-bingo .cell>.bar{position:absolute;left:0;bottom:0;height:3px;background:#ffc94a;opacity:.7;}
#nsws-bingo .cell.done{background:#4a3a12;}
#nsws-bingo .cell.done::before{content:"";position:absolute;left:50%;top:50%;width:min(60px,76%);aspect-ratio:1;transform:translate(-50%,-50%);border-radius:50%;background:rgba(255,190,50,.55);box-shadow:0 0 0 3px rgba(255,201,74,.35);}
#nsws-bingo .cell.done>span{color:#fff;text-shadow:0 1px 0 #000,0 0 3px #000;}
#nsws-bingo .cell.free{background:#112052;}
#nsws-bingo .cell.free::before{display:none;}
#nsws-bingo .cell.free>span{font-size:24px;color:#ffc94a;text-shadow:none;}
#nsws-bingo .strikes{position:absolute;inset:0;width:100%;height:100%;z-index:2;pointer-events:none;overflow:visible;}
#nsws-bingo .strikes>line{stroke:#e8323f;stroke-width:6px;stroke-linecap:round;opacity:.9;filter:drop-shadow(0 1px 1px rgba(0,0,0,.6));}
#nsws-bingo .strikes>line.new{stroke-dasharray:100;stroke-dashoffset:100;animation:nsws-bingo-strike .5s ease-out forwards;}
@keyframes nsws-bingo-strike{to{stroke-dashoffset:0;}}
#nsws-bingo .tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:14px 0 10px;}
#nsws-bingo .tile{padding:8px 14px;background:var(--button-color);clip-path:polygon(8px 0,100% 0,calc(100% - 8px) 100%,0 100%);}
#nsws-bingo .tile>.k{font-size:13px;color:rgba(255,255,255,.6);}
#nsws-bingo .tile>.v{margin-top:2px;font-size:26px;color:#b3c1ff;}
#nsws-bingo .tile>.v .nsws-tag{font-size:16px;}
#nsws-bingo .note{min-height:20px;margin:0 0 10px;font-size:15px;line-height:1.35;color:rgba(255,255,255,.75);}
#nsws-bingo .note.good{color:#96ff96;}
#nsws-bingo .note.warn{color:#ffd27a;}
#nsws-bingo .row{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px;}
#nsws-bingo .row>.button{margin:0;font-size:20px;padding:7px 16px;}
#nsws-bingo .row>.button:disabled{opacity:.35;}
#nsws-bingo .how{padding:10px 16px;background:var(--surface-secondary-color);clip-path:polygon(0 0,100% 0,calc(100% - 10px) 100%,0 100%);}
#nsws-bingo .how>h2{margin:0 0 4px;font-size:18px;font-weight:normal;}
#nsws-bingo ol{margin:0;padding-left:22px;font-size:14px;line-height:1.5;color:rgba(255,255,255,.85);}
#nsws-bingo .msg{padding:30px 10px;text-align:center;font-size:17px;color:rgba(255,255,255,.65);}
#nsws-bingo .msg>.button{margin-top:12px;font-size:18px;}
@media (max-width:640px){#nsws-bingo .cell{min-height:62px;font-size:12px;padding:4px;}#nsws-bingo .cell>.count{font-size:11px;}#nsws-bingo .cell.free>span{font-size:15px;}#nsws-bingo .head>b{font-size:28px;}#nsws-bingo .tiles{grid-template-columns:1fr;}#nsws-bingo .strikes>line{stroke-width:4px;}}
.nsws-bingo-line{display:inline-flex;align-items:center;gap:6px;margin-left:18px;font-size:22px;vertical-align:middle;color:#ffc94a;cursor:pointer;pointer-events:auto;}
.nsws-bingo-line>img{width:22px;height:22px;}
#nsws-bingo-pop{position:fixed;left:0;top:12%;width:100%;z-index:10002;text-align:center;pointer-events:none;font-family:ForcedSquare,Arial,sans-serif;font-style:italic;animation:nsws-bingo-pop .3s ease-out forwards;}
#nsws-bingo-pop>.big{display:inline-block;padding:0 40px;font-size:72px;font-weight:bold;color:#ffc94a;text-shadow:4px 4px 0 #112052,0 0 12px rgba(255,201,74,.8);background:linear-gradient(90deg,transparent,rgba(17,32,82,.75) 20%,rgba(17,32,82,.75) 80%,transparent);}
#nsws-bingo-pop>.sub{margin-top:4px;font-size:24px;color:#fff;text-shadow:2px 2px 0 #000;}
#nsws-bingo-pop.out{transition:opacity .5s;opacity:0;}
@keyframes nsws-bingo-pop{0%{opacity:0;transform:scale(.6);}70%{opacity:1;transform:scale(1.08);}100%{opacity:1;transform:scale(1);}}
`;

    let state = null;
    let view = null;
    let markTimer = 0;
    let marking = false;
    let failed = false;
    const buttons = new Set();

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function button(text, onClick) {
        const b = el("button", "button", text);
        b.addEventListener("click", (e) => {
            window.__nswsUIClick?.();
            onClick(e);
        });
        return b;
    }

    function icon(src) {
        const img = el("img");
        img.src = src;
        img.alt = "";
        img.draggable = false;
        return img;
    }

    function hash(text) {
        let h = 2166136261;
        for (let i = 0; i < text.length; i++) {
            h ^= text.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return h >>> 0;
    }

    function random(seed) {
        return () => {
            seed = (seed + 0x6d2b79f5) | 0;
            let t = seed;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function shuffle(list, rnd) {
        const a = [...list];
        for (let i = a.length - 1; i > 0; i--) {
            const j = Math.floor(rnd() * (i + 1));
            [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
    }

    function weekName(week) {
        const w = (window.__nswsWeeks || []).find((x) => x.week === week);
        return w?.label || "Week " + week;
    }

    function trackName(t) {
        return String(t.name || "").replace(/^\d+\s*-\s*/, "") || t.short || "this track";
    }

    function bingosText(n) {
        return n + (n === 1 ? " bingo" : " bingos");
    }

    // The same card for everyone on the same round: seeded by the week, the round and the track ids.
    // Each column is one track with an easy, a medium and a hard square (one column gets an epic one
    // instead), and the rest of the card is activities.
    const cards = new Map();
    function cardFor(week, round = roundOf(week)) {
        const key = week + ":" + round;
        if (cards.has(key)) return cards.get(key);
        const tracks = window.__nswsTracksForWeek?.(week) ?? [];
        if (!tracks.length) return null;
        const rnd = random(hash("nsws-bingo2|" + week + "|" + round + "|" + tracks.map((t) => t.id).join(",")));
        const columns = tracks.length >= SIZE
            ? shuffle(tracks.map((_, i) => i), rnd).slice(0, SIZE).sort((a, b) => a - b).map((i) => tracks[i])
            : Array.from({ length: SIZE }, (_, i) => tracks[i % tracks.length]);
        const activities = shuffle(ACTIVITIES, rnd);
        const epicColumn = Math.floor(rnd() * SIZE);
        const used = new Set();
        const squares = new Array(SIZE * SIZE);
        squares[FREE] = { kind: "free", text: "FREE" };
        for (let c = 0; c < SIZE; c++) {
            const track = columns[c];
            const cells = [];
            for (const tier of ["easy", "medium", c === epicColumn ? "epic" : "hard"]) {
                const options = shuffle(TASKS[tier].filter((t) => round === 0 || !t.once), rnd);
                const task = options.find((t) => !used.has(t.id + "|" + track.id)) ?? options[0];
                used.add(task.id + "|" + track.id);
                cells.push({ kind: "track", task: task.id, track: { id: track.id, name: trackName(track) }, text: task.text(trackName(track)) });
            }
            while (cells.length < (c === 2 ? SIZE - 1 : SIZE)) {
                let act = activities.shift();
                if (act.retired) act = activities.pop();
                cells.push({ kind: "act", act: act.id, text: act.text, hint: act.hint });
            }
            const rows = shuffle([0, 1, 2, 3, 4].filter((r) => !(c === 2 && r === 2)), rnd);
            cells.forEach((cell, i) => {
                squares[rows[i] * SIZE + c] = cell;
            });
        }
        const card = { week, round, columns, tracks, squares };
        cards.set(key, card);
        return card;
    }

    const LINES = (() => {
        const lines = [];
        for (let i = 0; i < SIZE; i++) {
            lines.push([0, 1, 2, 3, 4].map((j) => i * SIZE + j), [0, 1, 2, 3, 4].map((j) => j * SIZE + i));
        }
        lines.push([0, 6, 12, 18, 24], [4, 8, 12, 16, 20]);
        return lines;
    })();

    function linesOf(marks) {
        return LINES.filter((line) => line.every((i) => i === FREE || marks & (1 << i)));
    }

    function liveWeek() {
        return window.__nswsCurrentWeek ?? null;
    }

    function serverCard(week) {
        return state?.bingo?.cards?.find((c) => c.week === week) ?? null;
    }

    // The Worker's round for the week, or the last one this device saw while the account loads.
    function roundOf(week) {
        const card = serverCard(week);
        if (card && Number.isSafeInteger(card.round)) return card.round;
        try {
            const r = Number(localStorage.getItem(ROUND_KEY + week));
            if (Number.isSafeInteger(r) && r >= 0) return r;
        } catch {}
        return 0;
    }

    function marksOf(week) {
        return (serverCard(week)?.marks ?? 0) | (1 << FREE);
    }

    // Counters for this device, one set per card (week and round): finishes, medal-time runs and the
    // best medal time per track, the best leaderboard place seen, finished seconds, older and Kodub
    // tracks finished, the longest run of finishes without a restart, and one-off activities.
    function blank() {
        return { finishes: {}, runs: {}, best: {}, ranks: {}, acts: {}, driven: 0, past: {}, pastBest: 0, kodub: {}, clean: 0 };
    }

    function progress(week, round = roundOf(week)) {
        try {
            const p = JSON.parse(localStorage.getItem(PROGRESS_KEY + week + ":" + round));
            if (p && typeof p === "object") return { ...blank(), ...p };
        } catch {}
        return blank();
    }

    function saveProgress(week, round, p) {
        try {
            localStorage.setItem(PROGRESS_KEY + week + ":" + round, JSON.stringify(p));
        } catch {}
    }

    // Old cards' counters are no use once their week or round is over.
    function pruneProgress() {
        const live = liveWeek();
        if (live == null) return;
        const keep = PROGRESS_KEY + live + ":" + roundOf(live);
        try {
            for (let i = localStorage.length - 1; i >= 0; i--) {
                const k = localStorage.key(i);
                if (!k) continue;
                if (k.startsWith("_nswsBingo:") || (k.startsWith(PROGRESS_KEY) && k !== keep && !k.startsWith(PROGRESS_KEY + (live + 1) + ":"))) {
                    localStorage.removeItem(k);
                }
            }
        } catch {}
    }

    function tier(trackId) {
        return MEDAL_RANK[window.__nswsMedalTier?.(trackId)] ?? 0;
    }

    // Best medal time on a track for this card. A week's first card also takes medals already saved,
    // which were earned on this week's tracks.
    function bestTier(id, card, p) {
        return Math.max(p.best[id] ?? 0, card.round === 0 ? tier(id) : 0);
    }

    function sum(values) {
        return values.reduce((a, b) => a + b, 0);
    }

    function uniqueTracks(card) {
        return [...new Set(card.tracks.map((t) => t.id))];
    }

    // How far a square is: { have, need } plus, for counted squares, a label for the cell.
    function measure(square, card, p) {
        if (square.kind === "free") return { have: 1, need: 1 };
        if (square.kind === "act") {
            const ids = uniqueTracks(card);
            switch (square.act) {
                case "finish25": return { have: sum(ids.map((id) => p.finishes[id] ?? 0)), need: 25, count: true };
                case "drive15": return { have: Math.floor(p.driven / 60), need: 15, count: true, unit: " min" };
                case "bronzeall": return { have: ids.filter((id) => bestTier(id, card, p) >= 1).length, need: ids.length, count: true };
                case "gold2": return { have: ids.filter((id) => bestTier(id, card, p) >= 3).length, need: Math.min(2, ids.length), count: true };
                case "silver5": return { have: sum(ids.map((id) => p.runs[id]?.[1] ?? 0)), need: 5, count: true };
                case "clean5": return { have: p.clean, need: 5, count: true };
                case "past3": return { have: Object.keys(p.past).length, need: 3, count: true };
                case "pastsilver": return { have: p.pastBest >= 2 ? 1 : 0, need: 1 };
                case "kodub3": return { have: Object.keys(p.kodub).length, need: 3, count: true };
                default: return { have: p.acts[square.act] ? 1 : 0, need: 1 };
            }
        }
        const id = square.track.id;
        const rank = p.ranks[id];
        const runs = p.runs[id] ?? [];
        switch (square.task) {
            case "finish3": return { have: p.finishes[id] ?? 0, need: 3, count: true };
            case "finish10": return { have: p.finishes[id] ?? 0, need: 10, count: true };
            case "bronze3": return { have: runs[0] ?? 0, need: 3, count: true };
            case "silver3": return { have: runs[1] ?? 0, need: 3, count: true };
            case "gold3": return { have: runs[2] ?? 0, need: 3, count: true };
            case "tophalf": return { have: rank && rank[0] <= Math.max(1, Math.ceil(rank[1] / 2)) ? 1 : 0, need: 1 };
            case "top10": return { have: rank && rank[0] <= 10 ? 1 : 0, need: 1 };
            case "top3": return { have: rank && rank[0] <= 3 ? 1 : 0, need: 1 };
            default: return { have: bestTier(id, card, p) >= (MEDAL_RANK[square.task] ?? 9) ? 1 : 0, need: 1 };
        }
    }

    function isDone(square, card, p) {
        const m = measure(square, card, p);
        return m.have >= m.need;
    }

    // Squares done on this device that the Worker hasn't marked yet go out in one request.
    function scheduleMark() {
        clearTimeout(markTimer);
        markTimer = setTimeout(sendMarks, MARK_DELAY_MS);
    }

    function canMark(week) {
        const live = state?.bingo?.live;
        return live == null || (week >= live && week <= live + 1);
    }

    async function sendMarks() {
        const week = liveWeek();
        const card = week != null && cardFor(week);
        const tags = window.__nswsTags;
        const token = tags?.profileToken?.();
        if (!card || !state?.bingo || !token || marking || !canMark(week)) return;
        const p = progress(week, card.round);
        const marks = marksOf(week);
        const fresh = card.squares.map((sq, i) => (!(marks & (1 << i)) && isDone(sq, card, p) ? i : -1)).filter((i) => i >= 0);
        if (!fresh.length) return;
        marking = true;
        try {
            const { status, data } = await tags.api("bingo/mark", { userToken: token, week, round: card.round, squares: fresh });
            if (status === 200) tags.apply(data);
        } catch {} finally {
            marking = false;
        }
    }

    // Counts go on the live week's current card.
    function bump(update) {
        const week = liveWeek();
        const card = week != null && cardFor(week);
        if (!card) return;
        const p = progress(week, card.round);
        if (update(p, card) === false) return;
        saveProgress(week, card.round, p);
        scheduleMark();
        if (view && view.week === week) render();
    }

    function isKodubTrack(id) {
        try {
            const tracks = window.__nswsCup?.services?.().tracks;
            return !!tracks && (tracks.isOfficialTrack(id) || tracks.isCommunityTrack(id));
        } catch {
            return false;
        }
    }

    // Finishes in a row on one track: a new run after a finish keeps the count, a new run before the
    // finish (a restart) or another track starts it again.
    let run = { track: null, finished: false, streak: 0 };
    function onTraffic(e) {
        const { name, track } = e.detail || {};
        if (name === "attempts" && track) {
            if (run.track !== track || !run.finished) run.streak = 0;
            run.track = track;
            run.finished = false;
        }
    }

    function onFinish(e) {
        const { track, seconds } = e.detail || {};
        if (typeof track !== "string" || !(seconds > 0)) return;
        const week = liveWeek();
        const card = week != null && cardFor(week);
        if (!card) return;
        const own = card.tracks.some((t) => t.id === track);
        const trackWeek = window.__nswsTrackWeek?.(track) ?? null;
        if (run.track === track && !run.finished) run.streak++;
        else run.streak = 1;
        run.track = track;
        run.finished = true;
        const streak = run.streak;
        const inCup = !!window.__nswsCupApp?.inCup?.();
        bump((p) => {
            if (own) p.finishes[track] = (p.finishes[track] ?? 0) + 1;
            p.driven += seconds;
            p.clean = Math.max(p.clean, streak);
            if (trackWeek != null && trackWeek < week) p.past[track] = 1;
            if (trackWeek == null && isKodubTrack(track)) p.kodub[track] = 1;
            if (inCup) p.acts.cup = 1;
        });
        if (own || (trackWeek != null && trackWeek < week)) judgeRun(track, seconds, own, card.round, 0);
    }

    // The medal this run's own time earns. The Author Time comes from the leaderboard, so a failed
    // fetch is tried again a few times.
    function judgeRun(track, seconds, own, round, tries) {
        const check = window.__nswsMedalForTime;
        if (!check) return;
        check(track, seconds).then((result) => {
            if (result === "failed") {
                if (tries < 3) setTimeout(() => judgeRun(track, seconds, own, round, tries + 1), MEDAL_RETRY_MS);
                return;
            }
            const rank = MEDAL_RANK[result] ?? 0;
            if (!rank) return;
            bump((p, card) => {
                if (card.round !== round) return false;
                if (!own) {
                    p.pastBest = Math.max(p.pastBest, rank);
                    return;
                }
                const runs = p.runs[track] ?? (p.runs[track] = [0, 0, 0, 0]);
                for (let i = 0; i < rank; i++) runs[i]++;
                p.best[track] = Math.max(p.best[track] ?? 0, rank);
            });
        }, () => {});
    }

    function onPlacement(e) {
        const { trackId, position, total } = e.detail || {};
        if (!(position > 0) || !(total > 0)) return;
        bump((p, card) => {
            if (card.round !== 0 || !card.tracks.some((t) => t.id === trackId)) return false;
            const best = p.ranks[trackId];
            if (best && best[0] <= position && best[1] >= total) return false;
            p.ranks[trackId] = [Math.min(position, best?.[0] ?? Infinity), Math.max(total, best?.[1] ?? 0)];
        });
    }

    function onActivity(e) {
        const kind = e.detail?.kind;
        if (kind !== "share") return;
        bump((p) => {
            if (p.acts[kind]) return false;
            p.acts[kind] = 1;
        });
    }

    // Celebrates squares the Worker has just marked: a toast for squares, a banner for a bingo.
    function celebrate(before, after) {
        const week = liveWeek();
        const was = before?.bingo?.cards?.find((c) => c.week === week);
        const now = after?.bingo?.cards?.find((c) => c.week === week);
        if (!now || !before?.bingo || (was?.round ?? 0) !== (now.round ?? 0)) return;
        const card = cardFor(week, now.round ?? 0);
        if (!card) return;
        const oldMarks = (was?.marks ?? 0) | (1 << FREE);
        const fresh = card.squares.filter((_, i) => now.marks & (1 << i) && !(oldMarks & (1 << i)));
        if (!fresh.length) return;
        const oldLines = linesOf(oldMarks).length;
        const newLines = linesOf(now.marks).length;
        if (newLines > oldLines) {
            popup(newLines - oldLines > 1 ? "DOUBLE BINGO!" : "BINGO!",
                bingosText(newLines) + " on this card · " + bingosText(after.bingo.total) + " in all");
            return;
        }
        window.__nswsTags?.toast(fresh.length === 1 ? "Bingo square: " + fresh[0].text + " ✓"
            : fresh.length === 2 ? "Bingo squares: " + fresh[0].text + " and " + fresh[1].text + " ✓"
            : fresh.length + " bingo squares done! See your card from Bingo on the main menu.");
    }

    function popup(big, sub) {
        document.getElementById("nsws-bingo-pop")?.remove();
        const box = el("div");
        box.id = "nsws-bingo-pop";
        box.append(el("div", "big", big), el("div", "sub", sub));
        document.body.appendChild(box);
        setTimeout(() => box.classList.add("out"), POPUP_MS);
        setTimeout(() => box.remove(), POPUP_MS + 600);
    }

    function mountButton(b) {
        b.classList.add("nsws-bingo-btn");
        buttons.add(b);
        paintButton(b);
    }

    function paintButton(b) {
        const total = state?.bingo?.total;
        b.textContent = "";
        b.append(icon(ICON), " Bingo" + (total != null ? ": " + total : ""));
        const week = liveWeek();
        const marks = week != null ? marksOf(week) : 0;
        b.title = "Weekly bingo: " + countMarks(marks) + " / 25 squares on your card";
    }

    function countMarks(marks) {
        let n = 0;
        for (let i = 0; i < SIZE * SIZE; i++) if (marks & (1 << i)) n++;
        return n;
    }

    function lineText(week) {
        const marks = marksOf(week);
        const lines = linesOf(marks).length;
        return "Bingo " + countMarks(marks) + "/25" + (lines ? " · " + bingosText(lines) : "");
    }

    // A note on the current week's heading in the Play menu. Runs every second, and several observers
    // watch the whole page, so the DOM is only touched when the text changes.
    function paintPlayLine() {
        const week = liveWeek();
        const menu = document.querySelector(".track-selection-ui:not(.hidden)");
        if (!menu || week == null) return;
        const old = menu.querySelector(".nsws-bingo-line");
        if (!state?.bingo || !cardFor(week)) {
            old?.remove();
            return;
        }
        const names = new Set([weekName(week), ...((window.__nswsWeeks || []).find((x) => x.week === week)?.parts || []).map((p) => p.label)]);
        const title = [...menu.querySelectorAll(".group-title")].find((t) => names.has(t.firstChild?.textContent?.trim()));
        if (!title) return;
        const text = lineText(week);
        if (old && old.parentNode === title && old.dataset.text === text) return;
        const line = old && old.parentNode === title ? old : el("span", "nsws-bingo-line");
        line.dataset.text = text;
        line.textContent = "";
        line.append(icon(ICON), text);
        line.title = "Open this week's bingo card";
        if (line !== old) {
            old?.remove();
            line.addEventListener("click", (e) => {
                e.stopPropagation();
                window.__nswsUIClick?.();
                open();
            });
            title.appendChild(line);
        }
    }

    function shareLines(week = liveWeek()) {
        const card = week != null && cardFor(week);
        if (!card) return null;
        const marks = marksOf(week);
        const rows = [];
        for (let r = 0; r < SIZE; r++) {
            let row = "";
            for (let c = 0; c < SIZE; c++) {
                const i = r * SIZE + c;
                row += i === FREE ? "⭐" : marks & (1 << i) ? "🟩" : "⬛";
            }
            rows.push(row);
        }
        const lines = linesOf(marks).length;
        return ["NSWS Bingo · " + weekName(week) + (card.round ? " · card " + (card.round + 1) : "") + (lines ? " · " + bingosText(lines) : ""), ...rows];
    }

    function onKey(e) {
        if (e.key !== "Escape" && e.code !== "Escape") return;
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
    }

    function close() {
        if (!view) return;
        view.overlay.remove();
        window.removeEventListener("keydown", onKey, true);
        view = null;
    }

    function open(week = liveWeek()) {
        if (view) return;
        const overlay = el("div");
        overlay.id = "nsws-bingo";
        const box = el("div", "box");
        box.tabIndex = -1;
        box.appendChild(el("div", "checker"));
        const top = el("div", "top");
        const body = el("div", "body");
        box.append(top, body);
        overlay.appendChild(box);
        overlay.addEventListener("pointerdown", (e) => {
            if (e.target === overlay) close();
        });
        for (const type of ["keydown", "keyup", "keypress"]) overlay.addEventListener(type, (e) => e.stopPropagation());
        document.body.appendChild(overlay);
        window.addEventListener("keydown", onKey, true);
        box.focus();
        view = { overlay, top, body, week, note: "", noteKind: "", struck: null, confirmAt: 0, busy: false };
        failed = false;
        render();
        window.__nswsTags?.refresh().catch(() => {
            failed = true;
            render();
        });
    }

    // Weeks with a card to look at: the live one and any the player has marks on.
    function weeksToShow() {
        const weeks = new Set((state?.bingo?.cards ?? []).map((c) => c.week));
        if (liveWeek() != null) weeks.add(liveWeek());
        return [...weeks].filter((w) => cardFor(w)).sort((a, b) => a - b);
    }

    function setNote(text, kind = "") {
        if (!view) return;
        view.note = text;
        view.noteKind = kind;
        render();
    }

    // A red line through each bingo, drawn over the squares from the first cell's centre to the last.
    function strikes(lines, week, round) {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("class", "strikes");
        svg.setAttribute("viewBox", "0 0 100 100");
        svg.setAttribute("preserveAspectRatio", "none");
        const key = week + ":" + round;
        const seen = view.struck?.key === key ? view.struck.lines : null;
        const at = (i) => [((i % SIZE) * 2 + 1) * 10, (Math.floor(i / SIZE) * 2 + 1) * 10];
        for (const line of lines) {
            const [x1, y1] = at(line[0]);
            const [x2, y2] = at(line[line.length - 1]);
            // Run each line a little past the end cells' centres, like a pen stroke.
            const dx = (x2 - x1) * 0.08;
            const dy = (y2 - y1) * 0.08;
            const l = document.createElementNS("http://www.w3.org/2000/svg", "line");
            l.setAttribute("x1", x1 - dx);
            l.setAttribute("y1", y1 - dy);
            l.setAttribute("x2", x2 + dx);
            l.setAttribute("y2", y2 + dy);
            l.setAttribute("vector-effect", "non-scaling-stroke");
            l.setAttribute("pathLength", "100");
            if (seen && !seen.has(line.join())) l.classList.add("new");
            svg.appendChild(l);
        }
        view.struck = { key, lines: new Set(lines.map((l) => l.join())) };
        return svg;
    }

    async function resetCard(week, round) {
        const tags = window.__nswsTags;
        const token = tags?.profileToken?.();
        if (!token || !view || view.busy) return;
        view.busy = true;
        render();
        try {
            const { status, data } = await tags.api("bingo/reset", { userToken: token, week, round });
            if (status === 200) {
                try {
                    localStorage.removeItem(PROGRESS_KEY + week + ":" + round);
                } catch {}
                tags.apply(data);
                if (view) view.struck = null;
                setNote("New card! Your bingos from the last one still count.", "good");
            } else {
                setNote("Couldn't start a new card. Try again in a moment.", "warn");
                tags.refresh().catch(() => {});
            }
        } catch {
            setNote("Couldn't start a new card. Try again in a moment.", "warn");
        } finally {
            if (view) {
                view.busy = false;
                render();
            }
        }
    }

    function render() {
        if (!view) return;
        const { top, body } = view;
        const live = liveWeek();
        const week = view.week;
        const weeks = weeksToShow();
        const at = weeks.indexOf(week);
        const round = roundOf(week);
        top.textContent = "";
        const prev = button("◀", () => {
            view.week = weeks[at - 1];
            view.note = "";
            render();
        });
        const next = button("▶", () => {
            view.week = weeks[at + 1];
            view.note = "";
            render();
        });
        prev.disabled = at <= 0;
        next.disabled = at < 0 || at >= weeks.length - 1;
        prev.title = "Earlier week";
        next.title = "Later week";
        const h1 = el("h1", null, weekName(week) + " bingo");
        if (round > 0) h1.append(" ", el("small", null, "· card " + (round + 1)));
        top.append(h1, prev, next, button("✕", close));

        body.textContent = "";
        const card = cardFor(week, round);
        if (!state?.bingo || !card) {
            const msg = el("div", "msg", failed ? "Couldn't load your bingo card." : !card ? "There's no card for this week." : "Loading your bingo card…");
            if (failed) msg.append(el("br"), button("Retry", () => {
                failed = false;
                render();
                window.__nswsTags?.refresh().catch(() => {
                    failed = true;
                    render();
                });
            }));
            body.appendChild(msg);
            return;
        }
        const isLive = week === live;
        const marks = marksOf(week);
        const lines = linesOf(marks);
        const p = isLive ? progress(week, round) : null;

        const heads = el("div", "heads");
        card.columns.forEach((t, c) => {
            const head = el("div", "head");
            const name = el("span", null, trackName(t));
            if (ENV_COLORS[t.env]) name.style.color = ENV_COLORS[t.env];
            head.append(el("b", null, LETTERS[c]), name);
            heads.appendChild(head);
        });
        body.appendChild(heads);

        const grid = el("div", "squares");
        card.squares.forEach((sq, i) => {
            const done = !!(marks & (1 << i));
            const cell = el("button", "cell" + (sq.kind === "free" ? " free" : "") + (done ? " done" : ""));
            cell.appendChild(el("span", null, sq.kind === "free" ? "★ FREE" : sq.text));
            cell.title = done ? "Done" : sq.kind === "free" ? "Free square" : sq.hint || sq.text;
            if (p && !done && sq.kind !== "free") {
                const m = measure(sq, card, p);
                if (m.count && m.have > 0) {
                    cell.appendChild(el("span", "count", Math.min(m.have, m.need) + " / " + m.need + (m.unit || "")));
                    const bar = el("div", "bar");
                    bar.style.width = Math.min(100, (m.have / m.need) * 100) + "%";
                    cell.appendChild(bar);
                }
            }
            if (isLive && !done && sq.kind === "track" && window.__nswsOpenTrack) {
                cell.classList.add("go");
                cell.title = sq.text + " (click to open the track)";
                cell.addEventListener("click", () => {
                    window.__nswsUIClick?.();
                    close();
                    window.__nswsOpenTrack(sq.track.id);
                });
            } else if (isLive && !done && sq.hint) {
                cell.classList.add("go");
                cell.addEventListener("click", () => setNote(sq.hint));
            }
            grid.appendChild(cell);
        });
        grid.appendChild(strikes(lines, week, round));
        body.appendChild(grid);

        const banked = serverCard(week)?.banked ?? 0;
        const tiles = el("div", "tiles");
        const tile = (k, v) => {
            const t = el("div", "tile");
            t.append(el("div", "k", k), el("div", "v", v));
            return t;
        };
        tiles.append(
            tile(round > 0 || banked ? "This card · " + bingosText(banked) + " from earlier cards" : isLive ? "This card" : "That card",
                countMarks(marks) + " / 25 · " + bingosText(lines.length)),
            tile("Bingos in all", String(state.bingo.total) + (state.bingo.blackouts ? " · " + state.bingo.blackouts + " blackout" + (state.bingo.blackouts === 1 ? "" : "s") : "")),
        );
        const nextTag = (window.__nswsTags?.catalog ?? []).find((t) => t.bingos > state.bingo.total);
        const tagTile = tile(nextTag ? "Next tag" : "Bingo tags", "");
        const v = tagTile.lastChild;
        if (nextTag) {
            v.append(window.__nswsTags.chip(nextTag.id) ?? "", " at " + nextTag.bingos);
        } else {
            v.textContent = "All earned!";
        }
        tiles.appendChild(tagTile);
        body.appendChild(tiles);

        const canReset = isLive && lines.length > 0 && canMark(week);
        const confirming = canReset && Date.now() - view.confirmAt < RESET_CONFIRM_MS;
        // A note set by a click stays; otherwise the note follows the card.
        const note = view.note || (!isLive ? "This week is over, so its card can't change any more."
            : countMarks(marks) === 25 ? "Blackout! Start a new card whenever you like. Every bingo you've made stays counted."
            : lines.length ? "Nice! Keep going for more bingos on this card, or start a new card. Every bingo you've made stays counted."
            : "Squares mark themselves as you finish runs. Click a track square to go race it.");
        const noteKind = view.note ? view.noteKind : lines.length && isLive ? "good" : "";
        body.appendChild(el("p", "note " + noteKind, note));

        const row = el("div", "row");
        row.appendChild(button("Copy bingo card", () => {
            const text = (window.__nswsShare?.weekCard?.(week)) ?? shareLines(week)?.join("\n");
            if (!text) return;
            copy(text).then(() => setNote("Copied! Paste it in Discord or a chat.", "good"), () => {});
        }));
        if (isLive) {
            const reset = button(view.busy ? "Starting…" : confirming ? "Yes, new card" : "New card", () => {
                if (!canReset || view.busy) return;
                if (!confirming) {
                    const asked = view.confirmAt = Date.now();
                    setNote("Start a new card? Your " + bingosText(banked + lines.length) + " this week stay counted, but every square starts over. Press Yes, new card to go.", "warn");
                    setTimeout(() => {
                        if (view?.confirmAt !== asked) return;
                        view.confirmAt = 0;
                        setNote("");
                    }, RESET_CONFIRM_MS);
                    return;
                }
                view.confirmAt = 0;
                resetCard(week, round);
            });
            reset.disabled = !canReset || view.busy;
            reset.title = canReset ? "Swap this card for a new one. Your bingos stay counted." : "Get a bingo first, then you can start a new card.";
            row.appendChild(reset);
        }
        body.appendChild(row);

        const how = el("div", "how");
        how.appendChild(el("h2", null, "How it works"));
        const steps = el("ol");
        for (const step of [
            "Every week has a new card, the same for everyone. Each column is one of the week's tracks.",
            "Squares mark themselves as you finish runs, on any device with this profile. Restarts and unfinished runs never count.",
            "Medal squares need one run inside that medal's time on this card. Medals from before only count on a week's first card.",
            "A full row, column or diagonal is a bingo, struck out in red. The free square in the middle counts for you.",
            "Once you have a bingo you can start a new card for the same week. Bingos from every card add up to bingo tags for the chat.",
        ]) steps.appendChild(el("li", null, step));
        how.appendChild(steps);
        body.appendChild(how);
    }

    function copy(text) {
        if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
        return Promise.reject(new Error("no clipboard"));
    }

    function onAccount(e) {
        const before = state;
        state = e.detail;
        const week = liveWeek();
        const card = week != null ? serverCard(week) : null;
        if (card && Number.isSafeInteger(card.round)) {
            try {
                localStorage.setItem(ROUND_KEY + week, String(card.round));
            } catch {}
        }
        celebrate(before, state);
        for (const b of buttons) {
            if (b.isConnected) paintButton(b);
            else buttons.delete(b);
        }
        pruneProgress();
        paintPlayLine();
        render();
        scheduleMark();
    }

    if (!document.getElementById("nsws-bingo-style")) {
        const style = el("style");
        style.id = "nsws-bingo-style";
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    window.addEventListener("nsws-account", onAccount);
    window.addEventListener("nsws-traffic", onTraffic);
    window.addEventListener("nsws-finish", onFinish);
    window.addEventListener("nsws-placement", onPlacement);
    window.addEventListener("nsws-activity", onActivity);
    // Medals land in storage a moment after a finish, and the Play menu builds its headings when it
    // opens; a cheap check catches both.
    setInterval(() => {
        if (!state || document.visibilityState !== "visible") return;
        paintPlayLine();
    }, 1000);
    setInterval(() => {
        if (state && document.visibilityState === "visible") scheduleMark();
    }, 15000);

    window.__nswsBingo = { mountButton, open, cardFor, shareLines, state: () => state?.bingo ?? null };
})();
