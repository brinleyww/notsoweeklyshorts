// Weekly bingo. Every NSWS week has one 5x5 card, the same for everyone, made from that week's tracks
// (one column per track: B I N G O) and things to do on the site, with a free centre. Squares mark
// themselves as the player plays; the Worker keeps the marks (Accounts.markBingo, live week only) and
// counts bingos, a full row, column or diagonal, over every week for the bingo tags.
(function () {
    const SIZE = 5;
    const FREE = 12;
    const LETTERS = "BINGO";
    const ICON = "images/bingo.svg";
    const PROGRESS_KEY = "_nswsBingo:";
    const MARK_DELAY_MS = 1200;
    const TICK_MS = 5000;
    const POPUP_MS = 3400;
    const MEDAL_RANK = { bronze: 1, silver: 2, gold: 3, author: 4 };
    const ENV_COLORS = { Winter: "#bed8f7", Desert: "#ede2af" };

    const TASKS = {
        easy: [
            { id: "finish", text: (n) => "Finish " + n },
            { id: "start15", text: (n) => "Start " + n + " 15 times" },
        ],
        medium: [
            { id: "bronze", text: (n) => "Bronze medal on " + n },
            { id: "finish5", text: (n) => "Finish " + n + " 5 times" },
            { id: "pb3", text: (n) => "Set 3 PBs on " + n },
            { id: "tophalf", text: (n) => "Top half on " + n },
        ],
        hard: [
            { id: "silver", text: (n) => "Silver medal on " + n },
            { id: "gold", text: (n) => "Gold medal on " + n },
            { id: "top10", text: (n) => "Top 10 on " + n },
            { id: "finish15", text: (n) => "Finish " + n + " 15 times" },
        ],
        epic: [{ id: "author", text: (n) => "Author medal on " + n }],
    };
    const ACTIVITIES = [
        { id: "share", text: "Share a PB image", hint: "Press Share PB on the banner after a new personal best." },
        { id: "card", text: "Copy your bingo card", hint: "Press Copy bingo card under the card." },
        { id: "chat", text: "Say hi in the chat", hint: "Turn the chat on from the main menu's bottom bar." },
        { id: "clip", text: "Save a clip", hint: "Press Shift+C after a run, or turn on auto clips in Settings." },
        { id: "past", text: "Finish a track from an older week", hint: "Older weeks are further down the Play menu." },
        { id: "kodub", text: "Finish an official PolyTrack track", hint: "Play menu, top right: Official & Community." },
        { id: "cup", text: "Join a cup", hint: "Competitions on the main menu." },
        { id: "watch", text: "Watch a replay", hint: "Open a track and press Watch." },
        { id: "standings", text: "Check the standings", hint: "Standings on the main menu." },
        { id: "time30", text: "Play 30 minutes this week", hint: "Time counts while NSWS is open and focused." },
        { id: "allfive", text: "Finish every track this week" },
        { id: "medals3", text: "Earn 3 medals this week" },
    ];
    const BY_ACT = new Map(ACTIVITIES.map((a) => [a.id, a]));

    const CSS = `
.nsws-bingo-btn>img{width:22px;height:22px;}
#nsws-bingo{position:fixed;inset:0;z-index:9998;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.7);}
#nsws-bingo *{box-sizing:border-box;}
#nsws-bingo>.box{position:relative;display:flex;flex-direction:column;width:min(820px,96vw);max-height:94vh;background:var(--surface-color);color:var(--text-color);clip-path:polygon(0 0,100% 0,calc(100% - 14px) 100%,0 100%);outline:none;}
#nsws-bingo .checker{height:8px;flex-shrink:0;background:repeating-conic-gradient(#fff 0 25%,#112052 0 50%) 0 0/8px 8px;opacity:.85;}
#nsws-bingo .top{display:flex;align-items:center;gap:10px;padding:10px 20px;background:var(--surface-secondary-color);}
#nsws-bingo .top>h1{margin:0 auto 0 0;font-size:32px;font-weight:normal;color:#b3c1ff;text-shadow:0 2px 0 #112052;white-space:nowrap;}
#nsws-bingo .top>.button{margin:0;font-size:20px;padding:6px 14px;}
#nsws-bingo .top>.button:disabled{opacity:.35;}
#nsws-bingo .body{overflow-y:auto;padding:14px 20px 20px;}
#nsws-bingo .card{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:6px;}
#nsws-bingo .head{display:flex;flex-direction:column;align-items:center;justify-content:flex-end;padding:2px 0 4px;min-width:0;}
#nsws-bingo .head>b{font-weight:normal;font-size:38px;line-height:1;color:#ffc94a;text-shadow:0 3px 0 #112052;}
#nsws-bingo .head>span{max-width:100%;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#nsws-bingo .cell{position:relative;display:flex;align-items:center;justify-content:center;min-height:74px;padding:6px 8px;border:0;background:var(--button-color);color:var(--text-color);font:inherit;font-size:15px;line-height:1.2;text-align:center;overflow-wrap:anywhere;cursor:default;}
#nsws-bingo .cell.go{cursor:pointer;}
#nsws-bingo .cell.go:hover{background:var(--button-hover-color);}
#nsws-bingo .cell>span{position:relative;z-index:1;}
#nsws-bingo .cell.done{background:#4a3a12;color:#fff;}
#nsws-bingo .cell.done::before{content:"";position:absolute;left:50%;top:50%;width:min(64px,80%);aspect-ratio:1;transform:translate(-50%,-50%) rotate(-8deg);border-radius:50%;background:radial-gradient(circle at 40% 38%,rgba(255,214,110,.9),rgba(255,180,40,.7) 60%,rgba(255,170,30,.3) 72%,transparent 74%);}
#nsws-bingo .cell.done>span{color:#fff;text-shadow:0 1px 0 #000,0 0 4px #000,0 0 2px #000;}
#nsws-bingo .cell.line{box-shadow:inset 0 0 0 3px #ffc94a;}
#nsws-bingo .cell.free{background:#112052;}
#nsws-bingo .cell.free>span{font-size:24px;color:#ffc94a;}
#nsws-bingo .tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:14px 0 10px;}
#nsws-bingo .tile{padding:8px 14px;background:var(--button-color);clip-path:polygon(8px 0,100% 0,calc(100% - 8px) 100%,0 100%);}
#nsws-bingo .tile>.k{font-size:13px;color:rgba(255,255,255,.6);}
#nsws-bingo .tile>.v{margin-top:2px;font-size:26px;color:#b3c1ff;}
#nsws-bingo .tile>.v .nsws-tag{font-size:16px;}
#nsws-bingo .note{min-height:20px;margin:0 0 10px;font-size:15px;line-height:1.35;color:rgba(255,255,255,.75);}
#nsws-bingo .note.good{color:#96ff96;}
#nsws-bingo .row{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px;}
#nsws-bingo .row>.button{margin:0;font-size:20px;padding:7px 16px;}
#nsws-bingo .how{padding:10px 16px;background:var(--surface-secondary-color);clip-path:polygon(0 0,100% 0,calc(100% - 10px) 100%,0 100%);}
#nsws-bingo .how>h2{margin:0 0 4px;font-size:18px;font-weight:normal;}
#nsws-bingo ol{margin:0;padding-left:22px;font-size:14px;line-height:1.5;color:rgba(255,255,255,.85);}
#nsws-bingo .msg{padding:30px 10px;text-align:center;font-size:17px;color:rgba(255,255,255,.65);}
#nsws-bingo .msg>.button{margin-top:12px;font-size:18px;}
@media (max-width:640px){#nsws-bingo .cell{min-height:58px;font-size:12px;padding:4px;}#nsws-bingo .head>b{font-size:28px;}#nsws-bingo .tiles{grid-template-columns:1fr;}}
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

    // The same card for everyone: seeded by the week and its track ids. Each column is one track with
    // an easy, a medium and a hard square (the hard one is the Author medal on some weeks), and the
    // rest of the card is activities.
    const cards = new Map();
    function cardFor(week) {
        if (cards.has(week)) return cards.get(week);
        const tracks = window.__nswsTracksForWeek?.(week) ?? [];
        if (!tracks.length) return null;
        const rnd = random(hash("nsws-bingo|" + week + "|" + tracks.map((t) => t.id).join(",")));
        const columns = tracks.length >= SIZE
            ? shuffle(tracks.map((_, i) => i), rnd).slice(0, SIZE).sort((a, b) => a - b).map((i) => tracks[i])
            : Array.from({ length: SIZE }, (_, i) => tracks[i % tracks.length]);
        const activities = shuffle(ACTIVITIES, rnd);
        const authorColumn = rnd() < 0.5 ? Math.floor(rnd() * SIZE) : -1;
        const used = new Set();
        const squares = new Array(SIZE * SIZE);
        squares[FREE] = { kind: "free", text: "FREE" };
        for (let c = 0; c < SIZE; c++) {
            const track = columns[c];
            const cells = [];
            for (const tier of ["easy", "medium", c === authorColumn ? "epic" : "hard"]) {
                const options = shuffle(TASKS[tier], rnd);
                const task = options.find((t) => !used.has(t.id + "|" + track.id)) ?? options[0];
                used.add(task.id + "|" + track.id);
                cells.push({ kind: "track", task: task.id, track: { id: track.id, name: trackName(track) }, text: task.text(trackName(track)) });
            }
            while (cells.length < (c === 2 ? SIZE - 1 : SIZE)) {
                const act = activities.shift();
                cells.push({ kind: "act", act: act.id, text: act.text, hint: act.hint });
            }
            const rows = shuffle([0, 1, 2, 3, 4].filter((r) => !(c === 2 && r === 2)), rnd);
            cells.forEach((cell, i) => {
                squares[rows[i] * SIZE + c] = cell;
            });
        }
        const card = { week, columns, tracks, squares };
        cards.set(week, card);
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

    // Counters for this device, one set per week: starts, finishes and PBs per track, the best
    // leaderboard place seen, activities done and focused seconds.
    function progress(week) {
        try {
            const p = JSON.parse(localStorage.getItem(PROGRESS_KEY + week));
            if (p && typeof p === "object") return { starts: {}, finishes: {}, pbs: {}, ranks: {}, acts: {}, secs: 0, ...p };
        } catch {}
        return { starts: {}, finishes: {}, pbs: {}, ranks: {}, acts: {}, secs: 0 };
    }

    function saveProgress(week, p) {
        try {
            localStorage.setItem(PROGRESS_KEY + week, JSON.stringify(p));
        } catch {}
    }

    function liveWeek() {
        return window.__nswsCurrentWeek ?? null;
    }

    function tier(trackId) {
        return MEDAL_RANK[window.__nswsMedalTier?.(trackId)] ?? 0;
    }

    function finished(trackId, p) {
        return window.__nswsPersonalBest?.(trackId) != null || (p.finishes[trackId] ?? 0) > 0;
    }

    function isDone(square, card, p) {
        if (square.kind === "free") return true;
        if (square.kind === "act") {
            switch (square.act) {
                case "time30": return p.secs >= 1800;
                case "allfive": return card.tracks.every((t) => finished(t.id, p));
                case "medals3": return card.tracks.filter((t) => tier(t.id) > 0).length >= 3;
                default: return !!p.acts[square.act];
            }
        }
        const id = square.track.id;
        const rank = p.ranks[id];
        switch (square.task) {
            case "finish": return finished(id, p);
            case "start15": return (p.starts[id] ?? 0) >= 15;
            case "finish5": return (p.finishes[id] ?? 0) >= 5;
            case "finish15": return (p.finishes[id] ?? 0) >= 15;
            case "pb3": return (p.pbs[id] ?? 0) >= 3;
            case "tophalf": return !!rank && rank[0] <= Math.max(1, Math.ceil(rank[1] / 2));
            case "top10": return !!rank && rank[0] <= 10;
            default: return tier(id) >= (MEDAL_RANK[square.task] ?? 9);
        }
    }

    function serverCard(week) {
        return state?.bingo?.cards?.find((c) => c.week === week) ?? null;
    }

    function marksOf(week) {
        return (serverCard(week)?.marks ?? 0) | (1 << FREE);
    }

    // Squares done on this device that the Worker hasn't marked yet go out in one request.
    function scheduleMark() {
        clearTimeout(markTimer);
        markTimer = setTimeout(sendMarks, MARK_DELAY_MS);
    }

    async function sendMarks() {
        const week = liveWeek();
        const card = week != null && cardFor(week);
        const tags = window.__nswsTags;
        const token = tags?.profileToken?.();
        if (!card || !state?.bingo || !token || marking) return;
        if (state.bingo.live != null && (week < state.bingo.live || week > state.bingo.live + 1)) return;
        const p = progress(week);
        const marks = marksOf(week);
        const fresh = card.squares.map((sq, i) => (!(marks & (1 << i)) && isDone(sq, card, p) ? i : -1)).filter((i) => i >= 0);
        if (!fresh.length) return;
        marking = true;
        const { status, data } = await tags.api("bingo/mark", { userToken: token, week, squares: fresh });
        marking = false;
        if (status === 200) tags.apply(data);
    }

    function bump(week, update) {
        const p = progress(week);
        if (update(p) === false) return;
        saveProgress(week, p);
        scheduleMark();
    }

    function onTraffic(e) {
        const { name, track } = e.detail || {};
        const week = liveWeek();
        const card = week != null && cardFor(week);
        if (!card) return;
        const own = track && card.tracks.some((t) => t.id === track);
        bump(week, (p) => {
            if (name === "attempts" && own) p.starts[track] = (p.starts[track] ?? 0) + 1;
            else if (name === "finishes") {
                if (own) p.finishes[track] = (p.finishes[track] ?? 0) + 1;
                const trackWeek = track ? window.__nswsTrackWeek?.(track) : null;
                if (trackWeek != null && trackWeek < week) p.acts.past = 1;
                if (trackWeek == null && track && isKodubTrack(track)) p.acts.kodub = 1;
                if (window.__nswsCupApp?.inCup?.()) p.acts.cup = 1;
            } else if (name === "replays") p.acts.watch = 1;
            else if (name === "clips") p.acts.clip = 1;
            else if (name === "standings") p.acts.standings = 1;
            else return false;
        });
    }

    function isKodubTrack(id) {
        try {
            const tracks = window.__nswsCup?.services?.().tracks;
            return !!tracks && (tracks.isOfficialTrack(id) || tracks.isCommunityTrack(id));
        } catch {
            return false;
        }
    }

    function onPB() {
        const week = liveWeek();
        const card = week != null && cardFor(week);
        const track = window.__getCurrentTrack?.()?.getId?.();
        if (!card || !track || !card.tracks.some((t) => t.id === track)) return;
        bump(week, (p) => {
            p.pbs[track] = (p.pbs[track] ?? 0) + 1;
        });
    }

    function onPlacement(e) {
        const { trackId, position, total } = e.detail || {};
        const week = liveWeek();
        const card = week != null && cardFor(week);
        if (!card || !card.tracks.some((t) => t.id === trackId) || !(position > 0) || !(total > 0)) return;
        bump(week, (p) => {
            const best = p.ranks[trackId];
            if (best && best[0] <= position && best[1] >= total) return false;
            p.ranks[trackId] = [Math.min(position, best?.[0] ?? Infinity), Math.max(total, best?.[1] ?? 0)];
        });
    }

    function onActivity(e) {
        const kind = e.detail?.kind;
        const week = liveWeek();
        if (week == null || !BY_ACT.has(kind)) return;
        bump(week, (p) => {
            if (p.acts[kind]) return false;
            p.acts[kind] = 1;
        });
    }

    let lastTick = Date.now();
    function tick() {
        const now = Date.now();
        const seconds = Math.min((now - lastTick) / 1000, TICK_MS / 500);
        lastTick = now;
        const week = liveWeek();
        if (week == null || document.visibilityState !== "visible" || !document.hasFocus()) return;
        const inCup = !!window.__nswsCupApp?.inCup?.();
        const p = progress(week);
        const before = p.secs >= 1800;
        p.secs += seconds;
        if (inCup) p.acts.cup = 1;
        saveProgress(week, p);
        if ((!before && p.secs >= 1800) || inCup) scheduleMark();
    }

    // Celebrates squares the Worker has just marked: a toast for squares, a banner for a bingo.
    function celebrate(before, after) {
        const week = liveWeek();
        const card = week != null && cardFor(week);
        const was = before?.bingo?.cards?.find((c) => c.week === week);
        const now = after?.bingo?.cards?.find((c) => c.week === week);
        if (!card || !now || !before?.bingo) return;
        const oldMarks = (was?.marks ?? 0) | (1 << FREE);
        const fresh = card.squares.filter((_, i) => now.marks & (1 << i) && !(oldMarks & (1 << i)));
        if (!fresh.length) return;
        const oldLines = linesOf(oldMarks).length;
        const newLines = linesOf(now.marks).length;
        if (newLines > oldLines) {
            popup(newLines - oldLines > 1 ? "DOUBLE BINGO!" : "BINGO!",
                bingosText(newLines) + " this week · " + bingosText(after.bingo.total) + " in all");
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
        b.title = "Weekly bingo: " + countMarks(marks) + " / 25 squares this week";
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
        return ["NSWS Bingo · " + weekName(week) + (lines ? " · " + bingosText(lines) : ""), ...rows];
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
        view = { overlay, top, body, week, note: "", noteKind: "" };
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

    function render() {
        if (!view) return;
        const { top, body } = view;
        const live = liveWeek();
        const week = view.week;
        const weeks = weeksToShow();
        const at = weeks.indexOf(week);
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
        top.append(el("h1", null, weekName(week) + " bingo"), prev, next, button("✕", close));

        body.textContent = "";
        const card = cardFor(week);
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
        const inLine = new Set(lines.flat());

        const grid = el("div", "card");
        card.columns.forEach((t, c) => {
            const head = el("div", "head");
            const name = el("span", null, trackName(t));
            if (ENV_COLORS[t.env]) name.style.color = ENV_COLORS[t.env];
            head.append(el("b", null, LETTERS[c]), name);
            grid.appendChild(head);
        });
        card.squares.forEach((sq, i) => {
            const done = !!(marks & (1 << i));
            const cell = el("button", "cell" + (sq.kind === "free" ? " free" : "") + (done ? " done" : "") + (inLine.has(i) && lines.length ? " line" : ""));
            cell.appendChild(el("span", null, sq.kind === "free" ? "★ FREE" : sq.text));
            cell.title = done ? "Done" : sq.kind === "free" ? "Free square" : sq.hint || sq.text;
            if (isLive && !done && sq.kind === "track" && window.__bw_selectTrackById) {
                cell.classList.add("go");
                cell.title = sq.text + " (click to open the track)";
                cell.addEventListener("click", () => {
                    window.__nswsUIClick?.();
                    close();
                    window.__bw_selectTrackById(sq.track.id);
                });
            } else if (isLive && !done && sq.hint) {
                cell.classList.add("go");
                cell.addEventListener("click", () => {
                    view.note = sq.hint;
                    view.noteKind = "";
                    render();
                });
            }
            grid.appendChild(cell);
        });
        body.appendChild(grid);

        const tiles = el("div", "tiles");
        const tile = (k, v) => {
            const t = el("div", "tile");
            t.append(el("div", "k", k), el("div", "v", v));
            return t;
        };
        tiles.append(
            tile(isLive ? "This card" : "That card", countMarks(marks) + " / 25 · " + bingosText(lines.length)),
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

        if (!view.note) {
            view.note = !isLive ? "This week is over, so its card can't change any more."
                : lines.length ? "Nice! Every row, column and diagonal you finish is another bingo."
                : "Squares mark themselves as you play. Click a track square to go race it.";
            view.noteKind = lines.length && isLive ? "good" : "";
        }
        body.appendChild(el("p", "note " + view.noteKind, view.note));

        const row = el("div", "row");
        row.appendChild(button("Copy bingo card", () => {
            const text = (window.__nswsShare?.weekCard?.(week)) ?? shareLines(week)?.join("\n");
            if (!text) return;
            copy(text).then(() => {
                if (isLive) window.dispatchEvent(new CustomEvent("nsws-activity", { detail: { kind: "card" } }));
                if (!view) return;
                view.note = "Copied! Paste it in Discord or a chat.";
                view.noteKind = "good";
                render();
            }, () => {});
        }));
        body.appendChild(row);

        const how = el("div", "how");
        how.appendChild(el("h2", null, "How it works"));
        const steps = el("ol");
        for (const step of [
            "Every week has a new card, the same for everyone. Each column is one of the week's tracks.",
            "Squares mark themselves as you play, on any device with this profile.",
            "A full row, column or diagonal is a bingo. The free square in the middle counts for you.",
            "Cards only change while their week is live. Bingos from every week add up to bingo tags for the chat.",
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
        celebrate(before, state);
        for (const b of buttons) {
            if (b.isConnected) paintButton(b);
            else buttons.delete(b);
        }
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
    window.addEventListener("nsws-pb", onPB);
    window.addEventListener("nsws-placement", onPlacement);
    window.addEventListener("nsws-activity", onActivity);
    setInterval(tick, TICK_MS);
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
