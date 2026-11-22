// The tutorial for new players: six practice races with a coach ghost, then the tour (mod/nsws_tutorial_guide.js).
// Practice races (category "practice" in main.bundle.js) save nothing, upload nothing and count for nothing.
(function () {
    "use strict";
    if (window.__nswsTutorial) return;

    const STORE = "_nswsTutorial";
    const DATA = "tracks/tutorial/lessons.json";
    // KeyBind numbers in main.bundle.js.
    const BIND = { up: 0, right: 1, down: 2, left: 3, reset: 4, restart: 5, camera: 6, ui: 7, pause: 8, freecam: 25 };
    const MEDALS = [["author", "Author", 1], ["gold", "Gold", 1.05], ["silver", "Silver", 1.1], ["bronze", "Bronze", 1.2]];
    const KMH_PER_MPH = 1.609344;

    function readState() {
        try {
            const s = JSON.parse(localStorage.getItem(STORE) || "{}") || {};
            s.done && "object" === typeof s.done || (s.done = {});
            return s;
        } catch (e) {
            return { done: {} };
        }
    }
    const state = readState();
    function save() {
        try {
            localStorage.setItem(STORE, JSON.stringify(state));
        } catch (e) {}
    }

    function el(tag, className, ...children) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        node.append(...children.filter(c => null != c));
        return node;
    }
    function button(label, onClick, className = "") {
        const b = el("button", "button " + className, label);
        // Buttons over a race must never keep the keyboard: Space would press them again.
        b.tabIndex = -1;
        b.addEventListener("click", () => {
            b.blur();
            window.__nswsUIClick?.();
            onClick();
        });
        return b;
    }
    const sfx = name => {
        try {
            window.__nswsSfx?.(name);
        } catch (e) {}
    };
    const typing = () => {
        let a = document.activeElement;
        while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
        return !!a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable);
    };

    // Set by main.bundle.js, in the menus as well as in races.
    const touch = () => document.body.classList.contains("nsws-touch");
    const pad = () => !touch() && !!window.__nswsGamepad?.recent();
    function keyNames(action) {
        const binds = window.__nswsKeyBindings;
        const codes = (binds?.settings()?.getKeyBindings(BIND[action]) ?? []).filter(Boolean);
        const arrows = { ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Slash: "/" };
        return codes.map(c => arrows[c] ?? binds.format(c));
    }
    function cap(action) {
        const node = el("span", "tut-key");
        node.dataset.act = action;
        const icon = { up: "arrow_up", down: "arrow_down", left: "arrow_left", right: "arrow_right", reset: "reset", restart: "reset" }[action];
        if (touch() && icon) {
            const img = el("img");
            img.src = "images/" + icon + ".svg";
            img.alt = action;
            node.append(img);
            if ("restart" === action) node.append(" twice");
            return node;
        }
        const padName = pad() ? window.__nswsGamepad.nameFor?.(action) : "";
        const names = padName ? [padName] : keyNames(action);
        node.textContent = names.length ? names.join(" / ") : "no key set";
        return node;
    }
    // "{up}" in a lesson's text is that action's key.
    function rich(text) {
        const out = document.createDocumentFragment();
        text.split(/\{(\w+)\}/).forEach((part, i) => out.append(i % 2 ? cap(part) : part));
        return out;
    }

    function speedText(kmh) {
        return window.__nswsSettingBoolean?.("ImperialUnitsEnabled") ? Math.round(kmh / KMH_PER_MPH) + " mph" : kmh + " km/h";
    }
    // Frames are milliseconds.
    function clock(frames) {
        return (frames / 1000).toFixed(3) + " s";
    }
    function medalFor(frames, coach) {
        return MEDALS.find(([, , times]) => frames <= Math.round(coach * times)) ?? null;
    }
    function medalIcon(id) {
        const icon = el("span", "tut-medal " + id);
        return icon;
    }

    // A step is done once; `test` runs every frame of the race until then, with ms = game time since the last frame.

    const held = (run, key, ms, on, need) => {
        run.hold[key] = (run.hold[key] || 0) + (on ? ms : 0);
        return run.hold[key] / need;
    };
    const reachSpeed = (kmh, title, sub) => ({
        title,
        sub,
        short: () => speedText(kmh),
        test: r => r.started ? r.speed / kmh : 0
    });
    const finishStep = (title, sub) => ({ title, sub, short: () => "Finish", finish: true });

    const LESSONS = [
        {
            id: "go",
            name: "Go and steer",
            intro: "The clock waits until you press the gas. The orange car that sets off with you is your coach. Follow it.",
            steps: [
                reachSpeed(100, () => "Hold {up} to go", () => `Keep it held down until ${speedText(100)}.`),
                {
                    title: () => "Steer with {left} and {right}",
                    sub: () => "Short taps are smoother than holding the key.",
                    short: () => "Steer",
                    test: (r, ms) => {
                        const a = held(r, "left", ms, r.started && r.keys.left, 40), b = held(r, "right", ms, r.started && r.keys.right, 40);
                        return (Math.min(a, 1) + Math.min(b, 1)) / 2;
                    }
                },
                finishStep(() => "Cross the finish line", () => "Follow the coach's car and you'll get there.")
            ],
            win: "You can drive",
            tip: "Gas down, small taps to steer. That is most of the game."
        },
        {
            id: "brake",
            name: "Brake",
            intro: "Too fast into a corner and you hit the wall. Brake while you're still straight, then turn.",
            steps: [
                reachSpeed(150, () => "Hold {up}, get up to speed", () => "There's a corner at the end of this straight."),
                {
                    title: () => "Brake with {down} before the corner",
                    sub: () => "A short press is plenty.",
                    short: () => "Brake",
                    test: (r, ms) => held(r, "brake", ms, r.keys.down && r.speed > 60, 120)
                },
                finishStep(() => "Back on the gas to the finish", () => "Turn in, then get on the gas as the road straightens.")
            ],
            win: "Good brakes",
            tip: () => `The brakes stop you from ${speedText(180)} in about a second. Keep holding them and you reverse.`
        },
        {
            id: "slide",
            name: "Tight corners",
            intro: "Gas held turns wide. No gas turns tighter. Brake and steer together turns tightest.",
            steps: [
                {
                    title: () => "Let go of {up} while you turn",
                    sub: () => "Get moving, then coast into the hairpin.",
                    short: () => "Coast and turn",
                    test: (r, ms) => held(r, "coast", ms, r.started && r.speed > 50 && !r.keys.up && (r.keys.left || r.keys.right), 120)
                },
                {
                    title: () => "Tap {down} while you steer",
                    sub: () => "That swings the car round. Hold it too long and you spin.",
                    short: () => "Brake and turn",
                    test: (r, ms) => held(r, "swing", ms, r.started && r.speed > 30 && r.keys.down && (r.keys.left || r.keys.right), 80)
                },
                finishStep(() => "Gas out of the corner", () => "Straighten up and floor it to the finish.")
            ],
            win: "Corner sorted",
            tip: "Start wide, touch the inside, let the car drift back out wide. The straighter your line, the faster you go."
        },
        {
            id: "oops",
            name: "Crashes and restarts",
            intro: "Everyone crashes, all the time. Two buttons fix it.",
            steps: [
                {
                    title: () => "Drive through the checkpoint",
                    sub: () => "It saves your spot, and the finish only counts once you have every one.",
                    short: () => "Checkpoint",
                    test: r => r.checkpoints > 0 ? 1 : 0
                },
                {
                    title: r => r.checkpoints ? "Press {reset} to go back to it" : "Get the checkpoint, then press {reset}",
                    sub: () => "Pretend you just crashed. The clock keeps running.",
                    short: () => "Respawn",
                    event: "respawn"
                },
                {
                    title: () => "Now press {restart} to start over",
                    sub: () => "For when the run is ruined. You'll use this one a lot.",
                    short: () => "Restart",
                    after: 1,
                    event: "restart"
                },
                finishStep(() => "Drive it to the finish", () => "Checkpoint first, then the line.")
            ],
            win: "Nothing can stop you now",
            tip: "Respawning twice without driving off also starts the run over."
        },
        {
            id: "jump",
            name: "Jumps",
            intro: "You can't steer in the air, so line up first. Holding the brake in the air slows the nose from tipping.",
            steps: [
                reachSpeed(200, () => "Stay on {up}, dead straight", () => `Hit the jump at ${speedText(200)} or more.`),
                {
                    title: r => r.airborne ? "Now! Hold {down}" : "In the air, hold {down}",
                    sub: () => "Only once the wheels leave the road.",
                    short: () => "Air brake",
                    test: (r, ms) => held(r, "air", ms, r.airborne && r.keys.down, 100)
                },
                finishStep(() => "Land it and finish", () => "Gas again as soon as you land.")
            ],
            win: "Clean landing",
            tip: "Where a jump lands you is decided before you take off."
        },
        {
            id: "final",
            name: "Race the coach",
            exam: true,
            intro: "Everything at once. Match the coach for the Author medal. Any finish passes.",
            steps: [
                {
                    title: () => "Race the coach",
                    sub: () => "Two checkpoints, one jump, four real corners.",
                    short: () => "Checkpoint 1",
                    test: r => r.checkpoints > 0 ? 1 : 0
                },
                {
                    title: () => "Halfway. Keep pushing",
                    sub: () => "Brake early, gas early.",
                    short: () => "Checkpoint 2",
                    test: r => r.checkpoints > 1 ? 1 : 0
                },
                finishStep(() => "Bring it home", () => "Only lift when a corner needs it.")
            ],
            win: "Tutorial races done",
            tip: "Real tracks work the same: learn it, restart, shave off a little more each run."
        }
    ];

    let loading = null;
    function load() {
        return loading ??= fetch(DATA)
            .then(r => r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)))
            .catch(err => {
                loading = null;
                throw err;
            });
    }

    let starting = 0;
    let current = -1;
    let live = null;
    // A practice race is on screen, from its first car until it closes (live is cleared as the next one loads).
    let practising = false;

    function coachStyle() {
        const Style = window.__clipCarStyleClass, base = Style.deserializeSafe("");
        // The default style has a random colour each time.
        return new Style(base.pattern, base.rims, base.exhaust, 0xb02c00, 0xb02c00, 0x131313, 0x666666);
    }

    async function play(index, keepSteps) {
        if (Date.now() < starting) return;
        if (window.__nswsCupApp?.inCup?.()) return void window.__nswsMessageBox?.show("Leave the cup first, then start the tutorial.", "Ok", null);
        starting = Date.now() + 8000;
        try {
            const lesson = LESSONS[index];
            const data = (await load()).find(d => d.id === lesson.id);
            const parsed = window.__nswsTrackHooks?.parse(data?.code);
            const recording = window.__clipRecordingClass?.deserialize(data?.recording);
            if (!parsed?.trackData || !recording) throw new Error("Lesson " + lesson.id + " can't be read");
            const ghost = {
                recording,
                carStyle: coachStyle(),
                nickname: "Coach",
                time: new window.__clipTimeClass(data.frames),
                isSelf: false
            };
            closePanel();
            window.__nswsTutorialGuide?.close();
            current = index;
            live = null;
            fresh = { index, coach: data.frames, done: keepSteps && fresh?.index === index ? fresh.done.slice() : lesson.steps.map(() => false) };
            if (!window.__nswsPractice(parsed.trackMetadata, parsed.trackData, () => whenMenu(openHub), [ghost])) throw new Error("Practice race didn't start");
        } catch (err) {
            console.error("Tutorial:", err);
            starting = 0;
            window.__nswsMessageBox?.show("The tutorial didn't load. Check your connection and try again.", "Ok", null);
        }
    }

    // What carries over a restart of the same lesson.
    let fresh = null;

    function newCar(car, ui) {
        practising = true;
        if (!fresh) return;
        starting = 0;
        const again = live?.lesson === fresh;
        live?.coach?.remove();
        live?.result?.remove();
        live?.flash?.remove();
        live = {
            lesson: fresh,
            def: LESSONS[fresh.index],
            car,
            ui,
            frames: 0,
            stopped: 0,
            started: false,
            speed: 0,
            checkpoints: 0,
            airborne: false,
            hold: {},
            keys: {},
            drawn: ""
        };
        document.body.classList.add("nsws-tut-race");
        buildCoach();
        if (again) happened("restart");
        car.addResetCallback(() => {
            if (live?.car !== car || car.hasFinished()) return;
            // With no checkpoint to go back to, a reset is a start over.
            if (live.started) happened(live.checkpoints > 0 ? "respawn" : "restart");
        });
    }

    function happened(event) {
        if (!live) return;
        const { done } = live.lesson;
        live.def.steps.forEach((step, i) => {
            if (step.event !== event || done[i]) return;
            if (null != step.after && !done[step.after]) return;
            complete(i);
        });
    }

    function complete(i) {
        if (!live || live.lesson.done[i]) return;
        live.lesson.done[i] = true;
        live.drawn = "";
        if (live.def.steps[i].finish) return;
        sfx("go");
        praise(live.def.steps[i].short() + " ✓");
    }

    function praise(text) {
        if (!live?.ui) return;
        live.flash?.remove();
        live.flash = el("div", "tut-flash", text);
        live.ui.append(live.flash);
    }

    function tick(car) {
        if (live?.car !== car) return;
        const r = live;
        const frames = car.getTime().numberOfFrames;
        const ms = Math.max(0, Math.min(250, frames - r.frames));
        r.frames = frames;
        const c = car.getControls();
        for (const key of ["up", "down", "left", "right", "reset"]) r.keys[key] = !!c[key];
        r.started = car.hasStarted();
        r.speed = Math.abs(car.getSpeedKmh());
        r.checkpoints = car.getNextCheckpointIndex();
        r.airborne = r.started && frames > 500 && car.getCarState().wheelContact.every(w => null == w);
        for (const node of r.caps) node.classList.toggle("down", !!r.keys[node.dataset.act]);
        if (car.hasFinished()) return;

        const { done } = r.lesson, steps = r.def.steps;
        steps.forEach((step, i) => {
            if (done[i] || !step.test) return;
            if (step.test(r, ms) >= 1) complete(i);
        });
        r.stopped = r.started && r.speed < 15 ? r.stopped + ms : 0;
        draw();
    }

    function finish(car) {
        if (live?.car !== car) return;
        const r = live, { done } = r.lesson, steps = r.def.steps;
        const frames = car.getFinishTime()?.numberOfFrames ?? car.getTime().numberOfFrames;
        const missed = steps.findIndex((step, i) => !step.finish && !done[i]);
        if (missed < 0) {
            complete(steps.length - 1);
            const id = r.def.id, best = state.done[id];
            state.done[id] = Number.isFinite(best) ? Math.min(best, frames) : frames;
            save();
            sfx("record");
        }
        showResult(frames, missed);
    }

    function leave() {
        practising = false;
        live?.coach?.remove();
        live?.result?.remove();
        live?.flash?.remove();
        live = null;
        starting = 0;
        document.body.classList.remove("nsws-tut-race");
    }

    function buildCoach() {
        const r = live, index = r.lesson.index;
        r.count = el("span", "count", index === LESSONS.length - 1 ? "Final test" : `Lesson ${index + 1} of ${LESSONS.length}: ${r.def.name}`);
        const skip = button(index === LESSONS.length - 1 ? "Skip test" : "Skip lesson", next, "skip");
        r.title = el("h2");
        r.sub = el("p", "sub");
        r.fill = el("i");
        r.meter = el("div", "meter", r.fill);
        r.list = el("div", "steps");
        r.ticks = [];
        if (r.def.exam) {
            for (const [id, label, times] of MEDALS) {
                const limit = Math.round(r.lesson.coach * times);
                const node = el("span", "target", medalIcon(id), `${label} ${(limit / 1000).toFixed(3)}`);
                r.ticks.push({ node, limit });
                r.list.append(node);
            }
        } else {
            for (const step of r.def.steps) {
                const node = el("span", "step", step.short());
                r.ticks.push({ node });
                r.list.append(node);
            }
        }
        r.coach = el("div", "nsws-tut-coach", el("div", "head", r.count, skip), r.title, r.sub, r.meter, r.list);
        r.caps = [];
        r.ui?.append(r.coach);
        draw();
    }

    function draw() {
        const r = live;
        if (!r?.coach) return;
        const { done } = r.lesson, steps = r.def.steps;
        let i = done.indexOf(false);
        if (i < 0) i = steps.length - 1;
        const step = steps[i];

        let title = step.title(r), sub = step.sub(r);
        if (!r.started) {
            sub = r.def.intro;
            if (i > 0 || r.def.exam) title = "Hold {up} when you're ready";
        } else if (r.stopped > 2500) {
            sub = r.checkpoints ? "Stuck? {reset} goes back to the checkpoint, {restart} starts over." : "Stuck? {restart} starts over.";
        }
        const drawn = [title, sub, done.join(), touch(), pad()].join("|");
        if (drawn !== r.drawn) {
            r.drawn = drawn;
            r.title.replaceChildren(rich(title));
            r.sub.replaceChildren(rich(sub));
            r.caps = [...r.coach.querySelectorAll(".tut-key")];
            if (!r.def.exam)
                r.ticks.forEach(({ node }, n) => {
                    node.classList.toggle("done", !!done[n]);
                    node.classList.toggle("now", n === i);
                });
        }
        if (r.def.exam) for (const t of r.ticks) t.node.classList.toggle("gone", r.frames > t.limit);

        let part = 0;
        if (step.test && r.started) {
            // Held steps were already counted this frame, so ask again with no time passing.
            part = Math.max(0, Math.min(1, step.test(r, 0)));
        }
        const width = "scaleX(" + part.toFixed(2) + ")";
        if (r.width !== width) r.fill.style.transform = r.width = width;
    }

    const enterHint = () => touch() || pad() ? "" : " (Enter)";
    function showResult(frames, missed) {
        const r = live;
        if (!r) return;
        r.coach.classList.add("hidden");
        r.flash?.remove();
        r.result?.remove();
        const box = el("div", "nsws-tut-result");
        const row = el("div", "buttons");
        const last = r.lesson.index === LESSONS.length - 1;
        if (missed >= 0) {
            const title = el("p", "big");
            title.append(rich(r.def.steps[missed].title({ checkpoints: 0 })));
            box.append(el("h2", "", "So close"), el("p", "", "You finished, but this lesson still needs:"), title);
            row.append(button("Skip it", next), button("Try again" + enterHint(), () => play(r.lesson.index, true), "primary"));
            r.go = () => play(r.lesson.index, true);
        } else {
            const medal = r.def.exam ? medalFor(frames, r.lesson.coach) : null;
            box.classList.add("passed");
            box.append(el("h2", "", medal ? el("span", "", medalIcon(medal[0]), medal[1] + " medal") : r.def.win), el("p", "time", clock(frames)));
            if (r.def.exam) {
                const at = medal ? MEDALS.indexOf(medal) : MEDALS.length;
                const better = MEDALS[at - 1];
                box.append(el("p", "big", better
                    ? `${((frames - Math.round(r.lesson.coach * better[2])) / 1000).toFixed(3)} s off ${better[1]}. One more go?`
                    : "You beat the coach. Nothing left to teach you about driving."));
            }
            box.append(el("p", "", "function" === typeof r.def.tip ? r.def.tip() : r.def.tip));
            const progress = el("div", "progress");
            LESSONS.forEach(l => progress.append(el("i", null != state.done[l.id] ? "on" : "")));
            box.append(progress);
            const label = (last ? "Show me around" : "Next: " + LESSONS[r.lesson.index + 1].name) + enterHint();
            row.append(button("Race again", () => play(r.lesson.index)), button(label, next, "primary"));
            r.go = next;
        }
        box.append(row);
        r.result = box;
        r.shownAt = performance.now();
        r.ui?.append(box);
    }

    function next() {
        const index = live?.lesson.index ?? current;
        if (index + 1 < LESSONS.length) return void play(index + 1);
        starting = 0;
        window.__bw_returnToMenu?.();
        whenMenu(() => window.__nswsTutorialGuide?.tour());
    }

    // Enter is also the second Respawn key, so it is taken before the game sees it, and only on a result.
    window.addEventListener("keydown", e => {
        if (!live?.result || e.repeat || typing() || window.__nswsMessageBox?.isOpen) return;
        if ("Enter" !== e.code && "NumpadEnter" !== e.code) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        // Someone holding Respawn as they cross the line shouldn't skip the result.
        if (performance.now() - live.shownAt > 350) live.go();
    }, true);

    let menuWait = 0;
    function whenMenu(callback) {
        clearInterval(menuWait);
        const until = Date.now() + 15000;
        menuWait = setInterval(() => {
            if (Date.now() > until) return void clearInterval(menuWait);
            if (document.querySelector("#ui .game-ui")) return;
            const buttons = document.querySelector(".menu-ui > .main-buttons-container:not(.hidden)");
            if (!buttons) return;
            clearInterval(menuWait);
            callback();
        }, 100);
    }

    let panel = null;
    let panelEscape = null;
    function closePanel() {
        panel?.remove();
        panel = null;
        panelEscape = null;
    }
    function showPanel(onEscape, ...children) {
        closePanel();
        window.__nswsTutorialGuide?.close();
        panel = el("div", "", el("div", "nsws-tut-panel", ...children));
        panel.id = "nsws-tutorial";
        panelEscape = onEscape;
        document.body.append(panel);
    }
    window.addEventListener("keydown", e => {
        if (!panel || typing() || window.__nswsMessageBox?.isOpen) return;
        e.stopImmediatePropagation();
        if ("Escape" !== e.code) return;
        e.preventDefault();
        panelEscape();
    }, true);

    function resumeAt() {
        const i = LESSONS.findIndex(l => null == state.done[l.id]);
        return i < 0 ? LESSONS.length : i;
    }

    function openHub() {
        const rows = el("div", "rows");
        const row = (name, status, done, label, action) => {
            const right = el("span", "status" + (done ? " done" : ""), status);
            rows.append(el("div", "row", el("p", "", name), right, button(label, action)));
        };
        rows.append(el("h3", "", "Driving"));
        load().catch(() => {});
        LESSONS.forEach((l, i) => {
            const best = state.done[l.id], done = null != best;
            row(`${i + 1}. ${l.name}`, done ? (l.exam ? clock(best) : "Done") : "", done, done ? "Replay" : "Start", () => play(i));
        });
        rows.append(el("h3", "", "The game"));
        row("7. Tour and your first real track", state.tour ? "Done" : "", !!state.tour, state.tour ? "Replay" : "Start", () => {
            closePanel();
            window.__nswsTutorialGuide?.tour();
        });
        row("Keys and tips", "", false, "Open", () => {
            closePanel();
            window.__nswsTutorialGuide?.cheatSheet(openHub);
        });

        const at = resumeAt(), foot = el("div", "buttons", button("Back", closePanel));
        if (at < LESSONS.length) foot.append(button(at ? "Continue" : "Start tutorial", () => play(at), "primary"));
        else if (!state.tour)
            foot.append(button("Take the tour", () => {
                closePanel();
                window.__nswsTutorialGuide?.tour();
            }, "primary"));
        showPanel(closePanel, el("h2", "", "Tutorial"), el("p", "lead", "Six short races, then a quick tour. About 3 minutes. Practice runs don't go on any leaderboard."), rows, foot);
    }

    // skip: what a first launch did before there was a tutorial (this week's first track).
    function offer(skip) {
        state.offer = "open";
        save();
        load().catch(() => {});
        const answer = action => () => {
            state.offer = "answered";
            save();
            closePanel();
            action?.();
        };
        const list = el("ul", "");
        for (const text of ["Driving, braking, corners and jumps, one short race each", "A race against the coach for your first medal", "How weeks, secret times and medals work, then your first real track"])
            list.append(el("li", "", text));
        showPanel(
            answer(null),
            el("h2", "", "First time here?"),
            el("p", "lead", "Learn by driving. It takes about 3 minutes and you can skip any part."),
            list,
            el("div", "buttons", button("I can already play", answer(skip)), button("Teach me", answer(() => play(0)), "primary"))
        );
        return true;
    }

    const CSS = `
#nsws-tutorial{position:fixed;inset:0;z-index:10001;display:flex;align-items:center;justify-content:center;padding:10px;box-sizing:border-box;background-color:rgba(20,20,30,.6);font-family:ForcedSquare,Arial,sans-serif;pointer-events:auto;}
.nsws-tut-panel{display:flex;flex-direction:column;box-sizing:border-box;width:640px;max-width:100%;max-height:100%;background-color:var(--surface-color,#28346a);color:var(--text-color,#fff);border-top:4px solid #7272c2;}
.nsws-tut-panel>h2{margin:0;padding:14px 20px 0;font-size:38px;font-weight:normal;text-align:center;flex-shrink:0;}
.nsws-tut-panel>.lead{margin:0;padding:6px 20px 14px;font-size:20px;text-align:center;opacity:.8;flex-shrink:0;}
.nsws-tut-panel>ul{margin:0 10px;padding:14px 20px 14px 42px;min-height:0;overflow-y:auto;background-color:var(--surface-secondary-color,#212b58);font-size:21px;}
.nsws-tut-panel>ul>li{margin:6px 0;}
.nsws-tut-panel>.rows{min-height:0;overflow-y:auto;margin:0 10px;padding:0 14px 8px;background-color:var(--surface-secondary-color,#212b58);}
.nsws-tut-panel .rows>h3{margin:12px 0 2px;padding-bottom:3px;border-bottom:1px solid #fff;font-size:18px;font-style:italic;font-weight:normal;opacity:.7;}
.nsws-tut-panel .row{display:flex;align-items:center;gap:12px;min-height:46px;border-bottom:1px solid rgba(255,255,255,.12);}
.nsws-tut-panel .row:last-child{border-bottom:none;}
.nsws-tut-panel .row>p{flex:1;margin:0;min-width:0;font-size:21px;}
.nsws-tut-panel .row>.status{font-size:18px;opacity:.6;white-space:nowrap;}
.nsws-tut-panel .row>.status.done{color:#5f5;opacity:1;}
.nsws-tut-panel .row>.button{flex-shrink:0;width:112px;margin:0;padding:4px 10px;font-size:19px;}
.nsws-tut-panel>.buttons{display:flex;justify-content:space-between;gap:10px;padding:10px 20px 10px 10px;flex-shrink:0;}
.nsws-tut-panel>.buttons>.button{min-width:170px;margin:0;font-size:22px;}
.nsws-tut-panel .button.primary,.nsws-tut-result .button.primary{box-shadow:inset 0 -3px 0 #7272c2;}

.tut-key{display:inline-block;min-width:1.5em;margin:0 .12em;padding:0 .35em;box-sizing:border-box;background-color:var(--button-color,#112052);box-shadow:inset 0 -2px 0 rgba(255,255,255,.55);color:var(--text-color,#fff);text-align:center;white-space:nowrap;font-style:normal;}
.tut-key>img{width:.9em;height:.9em;vertical-align:-.08em;}
.tut-key.down{background-color:#7272c2;box-shadow:inset 0 2px 0 rgba(0,0,0,.3);}
.tut-medal{display:inline-block;width:.8em;height:.8em;margin-right:.3em;border-radius:50%;vertical-align:-.05em;}
.tut-medal.author{border-radius:0;background:url("images/medals/author.png") center/contain no-repeat;}
.tut-medal.gold{background-color:#ffd54a;}
.tut-medal.silver{background-color:#d9d9e3;}
.tut-medal.bronze{background-color:#d08a4a;}

.nsws-tut-coach{position:absolute;left:50%;top:10px;transform:translateX(-50%);z-index:1;box-sizing:border-box;width:min(620px,calc(100% - 20px));padding:6px 16px 8px;background-color:var(--surface-color,#28346a);color:var(--text-color,#fff);border-top:4px solid #7272c2;pointer-events:none;}
.nsws-tut-coach.hidden{display:none;}
.nsws-tut-coach>.head{display:flex;align-items:center;gap:10px;}
.nsws-tut-coach>.head>.count{flex:1;font-size:15px;font-style:italic;opacity:.7;}
.nsws-tut-coach>.head>.skip{margin:0;padding:1px 10px;font-size:15px;pointer-events:auto;}
.nsws-tut-coach>h2{margin:0;font-size:30px;line-height:1.2;font-weight:normal;}
.nsws-tut-coach>.sub{margin:2px 0 0;font-size:18px;line-height:1.25;opacity:.85;}
.nsws-tut-coach>.meter{height:4px;margin:7px 0 6px;overflow:hidden;background-color:var(--surface-tertiary-color,#192042);}
.nsws-tut-coach>.meter>i{display:block;height:100%;background-color:#8f8ff0;transform-origin:left;transform:scaleX(0);}
.nsws-tut-coach>.steps{display:flex;flex-wrap:wrap;gap:2px 16px;font-size:16px;}
.nsws-tut-coach .step{opacity:.45;}
.nsws-tut-coach .step::before{content:"\\25CB";margin-right:5px;}
.nsws-tut-coach .step.now{opacity:1;}
.nsws-tut-coach .step.done{opacity:1;color:#5f5;}
.nsws-tut-coach .step.done::before{content:"\\2713";}
.nsws-tut-coach .target{white-space:nowrap;}
.nsws-tut-coach .target.gone{opacity:.3;text-decoration:line-through;}

.tut-flash{position:absolute;left:0;right:0;top:27%;color:#5f5;font-size:44px;text-align:center;text-shadow:2px 2px 0 #112052;pointer-events:none;animation:nsws-tut-flash 1.1s ease-out forwards;}
@keyframes nsws-tut-flash{0%{opacity:0;transform:scale(1.3);}15%{opacity:1;transform:none;}70%{opacity:1;}100%{opacity:0;}}

.nsws-tut-result{position:absolute;left:50%;top:50%;transform:translate(-50%,-58%);z-index:2;box-sizing:border-box;width:min(600px,calc(100% - 20px));max-height:calc(100% - 20px);overflow-y:auto;background-color:var(--surface-color,#28346a);color:var(--text-color,#fff);border-top:4px solid #ff5;text-align:center;pointer-events:auto;animation:nsws-tut-in .25s ease-out;}
.nsws-tut-result.passed{border-top-color:#5f5;}
.nsws-tut-result>h2{margin:0;padding:12px 18px 0;font-size:40px;font-weight:normal;}
.nsws-tut-result>.time{margin:6px 10px;padding:6px;background-color:var(--surface-secondary-color,#212b58);font-size:38px;opacity:1;}
.nsws-tut-result>p{margin:0;padding:6px 20px;font-size:19px;opacity:.85;}
.nsws-tut-result>p.big{font-size:24px;opacity:1;}
.nsws-tut-result>.progress{display:flex;gap:4px;margin:8px 20px;}
.nsws-tut-result>.progress>i{flex:1;height:5px;background-color:var(--surface-tertiary-color,#192042);}
.nsws-tut-result>.progress>i.on{background-color:#7272c2;}
.nsws-tut-result>.buttons{display:flex;gap:10px;padding:10px 20px 10px 10px;}
.nsws-tut-result>.buttons>.button{flex:1;margin:0;padding:8px 10px;font-size:20px;}
.nsws-tut-result>.buttons>.button.primary{flex:1.5;}
@keyframes nsws-tut-in{from{opacity:0;}}

/* The coach's card and result stand in for these during a lesson. */
body.nsws-tut-race .game-ui .time-announcer-ui,body.nsws-tut-race .game-ui>.hint-ui,body.nsws-tut-race .game-toolbar-ui>.info-container,body.nsws-tut-race .game-toolbar-ui .button:has(img[src$="preview.svg"]){display:none!important;}

@media (max-height:560px),(max-width:700px){
.nsws-tut-coach{top:4px;padding:3px 10px 5px;width:min(480px,calc(100% - 12px));}
.nsws-tut-coach>h2{font-size:21px;}
.nsws-tut-coach>.sub{font-size:14px;}
.nsws-tut-coach>.steps{font-size:13px;}
.nsws-tut-coach>.head>.count,.nsws-tut-coach>.head>.skip{font-size:13px;}
.tut-flash{top:36%;font-size:30px;}
.nsws-tut-result{transform:translate(-50%,-50%);}
.nsws-tut-result>h2{font-size:28px;}
.nsws-tut-result>.time{font-size:26px;}
.nsws-tut-result>p,.nsws-tut-result>p.big{padding:3px 14px;font-size:16px;}
.nsws-tut-result>.buttons>.button{font-size:16px;}
.nsws-tut-panel>h2{font-size:28px;}
.nsws-tut-panel>.lead,.nsws-tut-panel>ul{font-size:16px;}
.nsws-tut-panel .row{min-height:38px;}
.nsws-tut-panel .row>p{font-size:17px;}
.nsws-tut-panel>.buttons>.button{min-width:0;font-size:18px;}
}
/* Touch scales the game's UI down to about half and puts the timer along the top and round buttons under it. */
body.nsws-touch .nsws-tut-coach{top:104px;width:min(780px,calc(100% - 830px));}
body.nsws-touch .nsws-tut-coach>h2{font-size:40px;}
body.nsws-touch .nsws-tut-coach>.sub{font-size:27px;}
body.nsws-touch .nsws-tut-coach>.steps,body.nsws-touch .nsws-tut-coach>.head>.count,body.nsws-touch .nsws-tut-coach>.head>.skip{font-size:24px;}
body.nsws-touch .tut-flash{top:42%;font-size:60px;}
body.nsws-touch .nsws-tut-result{width:min(900px,calc(100% - 20px));transform:translate(-50%,-50%);}
body.nsws-touch .nsws-tut-result>h2{font-size:56px;}
body.nsws-touch .nsws-tut-result>.time{font-size:46px;}
body.nsws-touch .nsws-tut-result>p,body.nsws-touch .nsws-tut-result>p.big{font-size:30px;}
body.nsws-touch .nsws-tut-result>.buttons>.button{padding:22px 10px;font-size:32px;}
@media (max-aspect-ratio:3/2){
body.nsws-touch .nsws-tut-coach{top:300px;width:min(980px,calc(100% - 24px));}
}
@media (prefers-reduced-motion:reduce){.nsws-tut-result{animation:none;}}
`;
    const style = el("style", "", CSS);
    style.id = "nsws-tutorial-style";
    document.head.append(style);

    window.__nswsTutorial = {
        open: openHub,
        // main.bundle.js, when a brand new player first reaches the menu.
        firstLaunch: offer,
        // The question was on screen when the tab closed, so it is asked again.
        pending: () => "open" === state.offer,
        racing: () => practising,
        newCar,
        tick,
        finish,
        leave,
        // For mod/nsws_tutorial_guide.js.
        kit: {
            el,
            button,
            rich,
            cap,
            touch,
            medalIcon,
            medals: MEDALS,
            bind: BIND,
            speedText,
            sfx,
            typing,
            showPanel,
            closePanel,
            tourDone() {
                state.tour = true;
                save();
            }
        }
    };
})();
