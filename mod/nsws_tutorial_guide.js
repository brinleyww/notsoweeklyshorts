// The tutorial's second half: a tour of the real menus that ends in the player's first real track, and Keys and tips.
// Loaded after mod/nsws_tutorial.js.
(function () {
    "use strict";
    const kit = window.__nswsTutorial?.kit;
    if (!kit || window.__nswsTutorialGuide) return;
    const { el, button, rich, cap } = kit;

    const PAD = 5, GAP = 14, EDGE = 10;
    // A Better Editor track fetches its blocks before its screen opens.
    const SCREEN_WAIT_MS = 45000;

    const shown = node => !!node?.getClientRects().length;
    const first = selector => [...document.querySelectorAll(selector)].find(shown) ?? null;
    const all = (...selectors) => selectors.map(first).filter(Boolean);
    const onMenu = () => !!first(".menu-ui > .main-buttons-container:not(.hidden)");
    const onTracks = () => !!first(".track-selection-ui:not(.hidden)");
    const onTrack = () => !!first(".track-info-ui:not(.hidden)");

    function weekGroup() {
        const week = window.__nswsCurrentWeek;
        const w = (window.__nswsWeeks || []).find(x => x.week === week);
        if (!w) return null;
        const names = new Set([w.label || "Week " + week, "Week " + week, ...(w.parts || []).map(p => p.label)]);
        const title = [...document.querySelectorAll(".track-selection-ui:not(.hidden) .group-title")]
            .find(t => shown(t) && names.has(t.firstChild?.textContent?.trim()));
        return title?.parentElement ?? null;
    }

    function surfaces() {
        const rows = [
            ["#3f444d", "Road", "Normal grip"],
            ["#9a6a3c", "Wood", "Loads of grip, but slippery once it's wet"],
            ["#8f5a2b", "Dirt", "Less grip, drifts easily"],
            ["#4f9a45", "Grass", "About half the grip, long braking"],
            ["checker", "Checked grass", "A penalty. It slows you to a crawl"],
            ["#a8dcf0", "Ice and snow", "Barely any grip, so turn early"],
            ["#e8843c", "Plastic", "Slidey, and it bounces you if you hit it side on"],
            ["#2f7fd6", "Water", "Slows you down and leaves the tyres wet"]
        ];
        const box = el("div", "surfaces");
        for (const [colour, name, what] of rows) {
            const chip = el("i", "checker" === colour ? "checker" : "");
            if ("checker" !== colour) chip.style.backgroundColor = colour;
            box.append(el("div", "", chip, el("b", "", name), el("span", "", what)));
        }
        return box;
    }

    function medalList() {
        const box = el("div", "medals");
        const words = { author: "Match or beat the Author Time", gold: "Within 5% of it", silver: "Within 10%", bronze: "Within 20%" };
        for (const [id, label] of kit.medals) box.append(el("div", "", kit.medalIcon(id), el("b", "", label), el("span", "", words[id])));
        return box;
    }

    // Answered with the real key or by clicking, so it works on touch and a controller too.
    const QUESTIONS = [
        ["You crash right after a checkpoint. What do you press?", "reset"],
        ["The whole run is ruined. What now?", "restart"],
        ["A tight corner is coming up fast. What first?", "down"]
    ];
    const ANSWERS = [["reset", "Respawn"], ["restart", "Start over"], ["down", "Brake"]];
    function quiz(done) {
        let at = 0;
        const box = el("div", "quiz"), question = el("p", "question"), reply = el("p", "reply"), choices = el("div", "choices");
        const ask = () => {
            question.textContent = at < QUESTIONS.length ? `${at + 1} / ${QUESTIONS.length}  ${QUESTIONS[at][0]}` : "That's all three. You've got it.";
            choices.hidden = at >= QUESTIONS.length;
        };
        const answer = id => {
            if (at >= QUESTIONS.length) return;
            const right = QUESTIONS[at][1] === id;
            reply.className = right ? "reply right" : "reply wrong";
            if (right) {
                reply.textContent = "Right.";
                kit.sfx("go");
                if (++at === QUESTIONS.length) {
                    reply.textContent = "";
                    done();
                }
                ask();
            } else {
                reply.textContent = "That's " + ANSWERS.find(a => a[0] === id)[1].toLowerCase() + ". Try another.";
            }
        };
        for (const [id, label] of ANSWERS) {
            const b = button(label, () => answer(id));
            if (!kit.touch()) b.append(cap(id));
            choices.append(b);
        }
        box.append(question, choices, reply);
        box.onGameKey = e => {
            const settings = window.__nswsKeyBindings?.settings();
            const hit = ANSWERS.find(([id]) => settings?.checkKeyBinding(e, kit.bind[id]));
            if (!hit || at >= QUESTIONS.length) return false;
            e.repeat || answer(hit[0]);
            return true;
        };
        ask();
        return box;
    }

    // at: the screen the step needs. click: the player presses the real thing to move on.
    const STEPS = [
        {
            at: onMenu,
            title: "You can drive. Now where to go",
            text: "A quick look around, then your first real track.",
            next: "Show me"
        },
        {
            at: onMenu,
            target: () => all(".nsws-mb-settings"),
            title: "Settings",
            text: "Game lagging? Pick Low End at the top of Settings. Every key and controller button can be changed under Controls."
        },
        {
            at: onMenu,
            target: () => all(".nsws-mb-garage"),
            title: "Garage",
            text: "Change your username under Profile to be ranked. Export your private token there as a backup and never share it, it is your account. You can paint your car here too, and finishing runs earns Bolts for crates of car parts (looks only)."
        },
        {
            at: onMenu,
            target: () => all(".nsws-mb-standings"),
            title: "Standings",
            text: "Each week is one competition. The higher you place on each of its tracks, the more points you get."
        },
        {
            at: onMenu,
            target: () => all(".nsws-mb-comps"),
            title: "Competitions",
            text: "Race people live. Host a cup and send the link, or join one with its code. Bots can fill the empty spots."
        },
        {
            at: onMenu,
            target: () => all(".nsws-mb-load"),
            title: "Custom Tracks",
            text: "Tracks you make in the Custom Tracks Editor or import are kept here. Share them with a link or race them in a club."
        },
        {
            at: onMenu,
            target: () => all(".menu-ui > .button-bar"),
            title: "Down here",
            text: "Chat with other players, fill this week's Bingo card, see what changed in the Changelog. The rest is under More."
        },
        {
            at: onMenu,
            title: "Quick check",
            text: () => kit.touch() ? "Tap the answer." : "Press the key or click the answer.",
            body: quiz,
            gated: true
        },
        {
            at: onMenu,
            before: () => window.__nswsTrackMode?.("nsws"),
            target: () => all(".nsws-mb-play"),
            click: true,
            title: "Now the real thing",
            text: () => kit.touch() ? "Tap Play." : "Click Play."
        },
        {
            at: onTracks,
            target: () => [weekGroup()].filter(Boolean),
            title: "A new set of tracks every week",
            text: "These are this week's. They're short, so you run them over and over and get faster. Older weeks are further down and stay playable."
        },
        {
            at: onTracks,
            title: "Not every block is road",
            text: "Some tracks have special surfaces. Turbo plates and gates can change your speed or even your car.",
            body: surfaces
        },
        {
            at: onTracks,
            target: () => [weekGroup()?.querySelector(".track > .button")].filter(Boolean),
            click: true,
            title: "Pick your first track",
            text: () => kit.touch() ? "Tap it." : "Click it."
        },
        {
            at: onTrack,
            wait: true,
            target: () => all(".track-info-ui .leaderboard-ui"),
            title: "Times are secret until the week ends",
            text: "You see your own time and your place, everyone else's time says SECRET. Your best run is sent in by itself when you finish."
        },
        {
            at: onTrack,
            target: () => all(".track-info-ui .opponents-title", ".track-info-ui .opponents-container"),
            title: "Ghosts",
            text: "Once a week is over, pick names on its leaderboard to race their ghosts, or press Watch to see how they drove it. It's the quickest way to improve."
        },
        {
            at: onTrack,
            target: () => all(".track-info-ui .personal-best-title", ".track-info-ui .personal-best"),
            title: "Medals",
            text: "Each week's tracks get an Author Time from one fast driver. Your best run earns:",
            body: medalList
        },
        {
            at: onTrack,
            target: () => all(".track-info-ui .button.play"),
            click: true,
            last: true,
            title: "Go set a time",
            text: "Your first run is just for learning the track. Press Play. You can replay the tutorial from the main menu any time."
        }
    ];

    let root = null, shades = [], shield = null, spot = null, card = null;
    let at = -1, frame = 0, lostSince = 0, body = null, placed = "", scrolled = false;

    function build() {
        root = el("div");
        root.id = "nsws-tour";
        shades = [0, 1, 2, 3].map(() => el("div", "shade"));
        shield = el("div", "shield");
        spot = el("div", "spot");
        card = el("div", "card");
        root.append(...shades, shield, spot, card);
        document.body.append(root);
        frame = requestAnimationFrame(follow);
        window.addEventListener("keydown", onKey, true);
    }

    function close() {
        if (!root) return;
        cancelAnimationFrame(frame);
        window.removeEventListener("keydown", onKey, true);
        root.remove();
        root = null;
        body = null;
        at = -1;
    }

    function go(index) {
        at = index;
        const step = STEPS[at];
        if (!step) return close();
        step.before?.();
        lostSince = 0;
        placed = "";
        scrolled = false;
        const text = el("p", "text");
        text.append(rich("function" === typeof step.text ? step.text() : step.text));
        const next = step.click ? null : button(step.next ?? "Next", () => go(at + 1), "primary");
        body = step.body?.(() => {
            next.disabled = false;
        }) ?? null;
        if (next && step.gated) next.disabled = true;
        const back = at > 0 && STEPS[at - 1].at === step.at && !STEPS[at - 1].click && !STEPS[at - 1].gated ? button("Back", () => go(at - 1)) : null;
        const bar = el("div", "progress", el("i"));
        bar.firstChild.style.width = ((at + 1) / STEPS.length) * 100 + "%";
        card.replaceChildren(
            bar,
            el("h2", "", step.title),
            text,
            ...(body ? [body] : []),
            el("div", "buttons", button("Skip tour", close, "skip"), el("span", "space"), back, next)
        );
        card.scrollTop = 0;
    }

    function follow(now) {
        if (!root) return;
        frame = requestAnimationFrame(follow);
        const step = STEPS[at];
        if (!step) return;
        if (document.querySelector("#ui .game-ui")) {
            if (step.last) kit.tourDone();
            return close();
        }
        // A click step is over once the screen after it is up.
        const after = STEPS[at + 1];
        if (step.click && after && after.at !== step.at && after.at()) return go(at + 1);

        const here = step.at() && !window.__nswsMessageBox?.isOpen;
        const targets = here && step.target ? step.target() : [];
        const ready = here && (!step.target || targets.length > 0);
        root.classList.toggle("away", !ready);
        if (!ready) {
            lostSince ||= now;
            const limit = step.click || step.wait ? SCREEN_WAIT_MS : 2500;
            if (now - lostSince > limit) close();
            return;
        }
        lostSince = 0;
        if (step.target && !scrolled) {
            scrolled = true;
            if (targets[0].closest(".tracks-container")) targets[0].scrollIntoView({ block: targets[0].offsetHeight > innerHeight / 2 ? "start" : "center" });
        }
        place(targets, !!step.click);
    }

    function place(targets, clickable) {
        const W = innerWidth, H = innerHeight;
        let box = null;
        for (const t of targets) {
            const r = t.getBoundingClientRect();
            box = box
                ? { l: Math.min(box.l, r.left), t: Math.min(box.t, r.top), r: Math.max(box.r, r.right), b: Math.max(box.b, r.bottom) }
                : { l: r.left, t: r.top, r: r.right, b: r.bottom };
        }
        if (box) {
            box.l = Math.max(0, box.l - PAD);
            box.t = Math.max(0, box.t - PAD);
            box.r = Math.min(W, box.r + PAD);
            box.b = Math.min(H, box.b + PAD);
        }
        const cw = card.offsetWidth, ch = card.offsetHeight;
        const key = [W, H, cw, ch, clickable, box && Object.values(box).map(Math.round)].join();
        if (key === placed) return;
        placed = key;

        const put = (node, l, t, w, h) => Object.assign(node.style, { left: l + "px", top: t + "px", width: Math.max(0, w) + "px", height: Math.max(0, h) + "px" });
        spot.hidden = !box;
        shield.hidden = !box || clickable;
        if (!box) {
            put(shades[0], 0, 0, W, H);
            for (const s of shades.slice(1)) put(s, 0, 0, 0, 0);
            card.style.left = Math.max(EDGE, (W - cw) / 2) + "px";
            card.style.top = Math.max(EDGE, (H - ch) / 2) + "px";
            return;
        }
        put(shades[0], 0, 0, W, box.t);
        put(shades[1], 0, box.b, W, H - box.b);
        put(shades[2], 0, box.t, box.l, box.b - box.t);
        put(shades[3], box.r, box.t, W - box.r, box.b - box.t);
        put(spot, box.l, box.t, box.r - box.l, box.b - box.t);
        put(shield, box.l, box.t, box.r - box.l, box.b - box.t);

        const clampX = x => Math.max(EDGE, Math.min(W - cw - EDGE, x));
        const clampY = y => Math.max(EDGE, Math.min(H - ch - EDGE, y));
        const midX = (box.l + box.r - cw) / 2, midY = (box.t + box.b - ch) / 2;
        let spotAt;
        if (box.b + GAP + ch <= H - EDGE) spotAt = [clampX(midX), box.b + GAP];
        else if (box.t - GAP - ch >= EDGE) spotAt = [clampX(midX), box.t - GAP - ch];
        else if (box.r + GAP + cw <= W - EDGE) spotAt = [box.r + GAP, clampY(midY)];
        else if (box.l - GAP - cw >= EDGE) spotAt = [box.l - GAP - cw, clampY(midY)];
        // No room beside it: the end of the screen away from what is being pointed at.
        else spotAt = [clampX(midX), box.t + box.b > H ? EDGE : H - ch - EDGE];
        card.style.left = spotAt[0] + "px";
        card.style.top = spotAt[1] + "px";
    }

    function onKey(e) {
        if (!root || kit.typing() || window.__nswsMessageBox?.isOpen) return;
        // While the next screen loads the menus keep their own keys.
        if (root.classList.contains("away")) return;
        e.stopImmediatePropagation();
        if (body?.onGameKey?.(e)) return void e.preventDefault();
        const next = card.querySelector(".button.primary");
        if ("Escape" === e.code) close();
        else if (("Enter" === e.code || "NumpadEnter" === e.code || "ArrowRight" === e.code) && next && !next.disabled && !e.repeat) next.click();
        else return;
        e.preventDefault();
    }

    function tour() {
        kit.closePanel();
        close();
        if (!onMenu()) return;
        build();
        go(0);
    }

    function clipKey() {
        let code = "Shift+KeyC";
        try {
            code = localStorage.getItem("_clipKeyBind") || code;
        } catch (e) {}
        return window.__nswsKeyBindings?.format(code) ?? code;
    }

    function cheatSheet(back) {
        const rows = el("div", "rows sheet");
        const section = name => rows.append(el("h3", "", name));
        const row = (name, value) => rows.append(el("div", "row", el("p", "", name), el("span", "value", value)));

        section("Keys");
        for (const [id, name] of [["up", "Gas"], ["down", "Brake and reverse"], ["left", "Steer left"], ["right", "Steer right"], ["reset", "Back to the last checkpoint"], ["restart", "Start over"], ["camera", "Switch camera"], ["pause", "Pause"], ["ui", "Hide the screen info"], ["freecam", "Free camera"]])
            if (!kit.touch() || ["up", "down", "left", "right", "reset", "restart"].includes(id)) row(name, cap(id));
        if (!kit.touch()) {
            row("Save a clip", el("span", "tut-key", clipKey()));
            row("Leave the race", el("span", "tut-key", "Escape"));
        }

        section("Getting faster");
        for (const text of [
            "Straight lines are fast. Start a corner wide, touch the inside, come out wide.",
            "Brake before the corner, not in the middle of it.",
            "Letting go of the gas turns tighter. A brake tap while steering turns tighter still.",
            "Keep steering small. Sliding and scraping walls both cost speed.",
            "You can't steer in the air. Line up before the jump, hold brake to slow the nose tipping.",
            "Restart a bad start straight away. Every good player does it constantly.",
            "Race a ghost a little faster than you, not the world record."
        ])
            rows.append(el("p", "tip", text));

        section("How it works here");
        for (const text of [
            "A new set of short tracks comes out every week.",
            "The timer starts when you press the gas. The finish only counts after every checkpoint.",
            "Your best time is sent to the leaderboard by itself.",
            "Other players' times are SECRET until the week ends.",
            "Standings add up your places over the week's tracks.",
            "Change your username in Garage, under Profile, to be ranked. Export the private token there as a backup and keep it to yourself."
        ])
            rows.append(el("p", "tip", text));

        section("Medals");
        rows.append(medalList());
        section("Surfaces");
        rows.append(surfaces());

        kit.showPanel(back, el("h2", "", "Keys and tips"), el("p", "lead", kit.touch() ? "The buttons on your screen while you race." : "The keys shown are the ones you have set."), rows, el("div", "buttons", button("Back", back)));
    }

    const CSS = `
#nsws-tour{position:fixed;inset:0;z-index:10001;font-family:ForcedSquare,Arial,sans-serif;pointer-events:none;}
#nsws-tour.away>*{visibility:hidden;}
#nsws-tour [hidden]{display:none!important;}
#nsws-tour>.shade,#nsws-tour>.shield,#nsws-tour>.spot,#nsws-tour>.card{position:fixed;}
#nsws-tour>.shade{background-color:rgba(20,20,30,.62);pointer-events:auto;}
#nsws-tour>.shield{pointer-events:auto;}
#nsws-tour>.spot{box-sizing:border-box;border:3px solid #8f8ff0;animation:nsws-tour-pulse 1.1s ease-in-out infinite alternate;}
#nsws-tour>.card{box-sizing:border-box;width:430px;max-width:calc(100vw - 20px);max-height:calc(100vh - 20px);overflow-y:auto;background-color:var(--surface-color,#28346a);color:var(--text-color,#fff);pointer-events:auto;}
#nsws-tour>.card>.progress{height:4px;background-color:var(--surface-tertiary-color,#192042);}
#nsws-tour>.card>.progress>i{display:block;height:100%;background-color:#7272c2;}
#nsws-tour>.card>h2{margin:0;padding:10px 16px 0;font-size:28px;line-height:1.15;font-weight:normal;}
#nsws-tour>.card>.text{margin:0;padding:6px 16px 10px;font-size:18px;line-height:1.25;opacity:.85;}
#nsws-tour>.card>.buttons{display:flex;gap:8px;padding:6px 14px 10px 8px;}
#nsws-tour>.card>.buttons>.space{flex:1;}
#nsws-tour>.card>.buttons>.button{margin:0;padding:6px 14px;font-size:19px;}
#nsws-tour .button.primary{box-shadow:inset 0 -3px 0 #7272c2;}
#nsws-tour .button.primary:disabled{opacity:.4;box-shadow:none;}
#nsws-tour .quiz{margin:0 8px 4px;padding:8px 10px;background-color:var(--surface-secondary-color,#212b58);}
#nsws-tour .quiz>p{margin:0;font-size:19px;}
#nsws-tour .quiz>.choices{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0;}
#nsws-tour .quiz>.choices>.button{flex:1 1 110px;margin:0;padding:6px 8px;font-size:17px;}
#nsws-tour .quiz>.choices .tut-key{display:block;margin:4px auto 0;width:max-content;max-width:100%;}
#nsws-tour .quiz>.reply{min-height:1.2em;font-size:17px;}
#nsws-tour .quiz>.reply.right{color:#5f5;}
#nsws-tour .quiz>.reply.wrong{color:#ff8a8a;}
#nsws-tour .surfaces,#nsws-tour .medals{margin:0 8px 4px;padding:4px 10px;background-color:var(--surface-secondary-color,#212b58);}
#nsws-tour .surfaces>div,#nsws-tour .medals>div,.nsws-tut-panel .surfaces>div,.nsws-tut-panel .medals>div{display:flex;align-items:center;gap:8px;min-height:27px;font-size:17px;border-bottom:1px solid rgba(255,255,255,.12);}
#nsws-tour .surfaces>div:last-child,#nsws-tour .medals>div:last-child,.nsws-tut-panel .surfaces>div:last-child,.nsws-tut-panel .medals>div:last-child{border-bottom:none;}
.surfaces>div>i{flex-shrink:0;width:15px;height:15px;}
.surfaces>div>i.checker{background:repeating-conic-gradient(#4f9a45 0 25%,#2c6628 0 50%) 0 0/7.5px 7.5px;}
#nsws-tour .surfaces b,#nsws-tour .medals b,.nsws-tut-panel .surfaces b,.nsws-tut-panel .medals b{flex-shrink:0;width:118px;font-weight:normal;}
#nsws-tour .surfaces span:not(.tut-medal),#nsws-tour .medals span:not(.tut-medal),.nsws-tut-panel .surfaces span:not(.tut-medal),.nsws-tut-panel .medals span:not(.tut-medal){font-size:15px;opacity:.8;}
#nsws-tour .medals .tut-medal,.nsws-tut-panel .medals .tut-medal{flex-shrink:0;width:16px;height:16px;margin:0;}
.nsws-tut-panel .sheet>.tip{margin:0;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.12);font-size:18px;line-height:1.25;}
.nsws-tut-panel .sheet .value{font-size:18px;text-align:right;}
@keyframes nsws-tour-pulse{from{opacity:.4;}to{opacity:1;}}
@media (max-height:560px),(max-width:700px){
#nsws-tour>.card{width:370px;}
#nsws-tour>.card>h2{font-size:22px;}
#nsws-tour>.card>.text{font-size:15px;padding-bottom:6px;}
#nsws-tour>.card>.buttons>.button{font-size:16px;}
#nsws-tour .surfaces>div,#nsws-tour .medals>div{min-height:21px;font-size:14px;}
#nsws-tour .surfaces b,#nsws-tour .medals b{width:92px;}
#nsws-tour .surfaces span:not(.tut-medal),#nsws-tour .medals span:not(.tut-medal){font-size:12px;}
}
@media (prefers-reduced-motion:reduce){#nsws-tour>.spot{animation:none;}}
`;
    const style = el("style", "", CSS);
    style.id = "nsws-tour-style";
    document.head.append(style);

    window.__nswsTutorialGuide = { tour, cheatSheet, close };
})();
