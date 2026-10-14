// Weekly streak: NSWS weeks in a row with a run uploaded while the week was live. The Worker keeps the
// weeks and works the streak out (streakOf in proxy/src/accounts.js); this draws it on the main menu's
// bottom bar, in the Streak window and on the Play menu's current week, and says when a week counts.
(function () {
    const FLAME = "images/streak.svg";
    // A run uploads a few seconds after the finish; the week shows as counted once the Worker has it.
    const RECHECK_MS = [4000, 10000, 25000];

    const CSS = `
.nsws-streak-btn{position:relative;}
.nsws-streak-btn>.due{display:inline-block;width:8px;height:8px;margin-left:6px;border-radius:50%;background:#ffc94a;vertical-align:middle;box-shadow:0 0 6px #ffc94a;}
#nsws-streak{position:fixed;inset:0;z-index:9998;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.7);}
#nsws-streak *{box-sizing:border-box;}
#nsws-streak>.box{position:relative;display:flex;flex-direction:column;width:min(760px,96vw);max-height:94vh;background:var(--surface-color);color:var(--text-color);clip-path:polygon(0 0,100% 0,calc(100% - 14px) 100%,0 100%);}
#nsws-streak .checker{height:8px;flex-shrink:0;background:repeating-conic-gradient(#fff 0 25%,#112052 0 50%) 0 0/8px 8px;opacity:.85;}
#nsws-streak .top{display:flex;align-items:center;gap:12px;padding:12px 20px;background:var(--surface-secondary-color);}
#nsws-streak .top>h1{margin:0 auto 0 0;font-size:32px;font-weight:normal;color:#b3c1ff;text-shadow:0 2px 0 #112052;}
#nsws-streak .top>.button{margin:0;font-size:20px;padding:6px 14px;}
#nsws-streak .body{overflow-y:auto;padding:16px 20px 20px;}
#nsws-streak .hero{display:flex;align-items:center;gap:18px;flex-wrap:wrap;padding:14px 18px;background:var(--surface-secondary-color);clip-path:polygon(0 0,100% 0,calc(100% - 10px) 100%,0 100%);}
#nsws-streak .hero>img{width:64px;height:64px;filter:drop-shadow(0 3px 0 #112052);}
#nsws-streak .hero.off>img{opacity:.35;}
#nsws-streak .hero .n{font-size:64px;line-height:1;color:#ffc94a;text-shadow:0 3px 0 #112052;}
#nsws-streak .hero.off .n{color:var(--text-color);opacity:.6;}
#nsws-streak .hero .unit{font-size:22px;}
#nsws-streak .hero .best{margin-left:auto;text-align:right;font-size:16px;color:rgba(255,255,255,.65);}
#nsws-streak .hero .best>b{display:block;font-weight:normal;font-size:28px;color:#b3c1ff;}
#nsws-streak .weeks{display:grid;grid-template-columns:repeat(8,minmax(0,1fr));gap:6px;margin:14px 0;}
#nsws-streak .wk{display:flex;flex-direction:column;align-items:center;gap:4px;padding:8px 0 6px;background:var(--surface-tertiary-color);clip-path:polygon(6px 0,100% 0,calc(100% - 6px) 100%,0 100%);font-size:14px;}
#nsws-streak .wk>.mark{display:flex;align-items:center;justify-content:center;width:30px;height:30px;font-size:20px;line-height:1;}
#nsws-streak .wk.played{background:#ffc94a;color:#2a1a00;}
#nsws-streak .wk.played>.mark img{width:24px;height:24px;filter:brightness(0) saturate(100%) invert(10%) sepia(40%) saturate(2000%) hue-rotate(10deg);}
#nsws-streak .wk.shield{background:#2f6fe0;}
#nsws-streak .wk.missed{opacity:.45;}
#nsws-streak .wk.open{background:transparent;outline:2px dashed rgba(255,255,255,.45);outline-offset:-4px;clip-path:none;}
#nsws-streak .status{margin:0 0 6px;font-size:20px;line-height:1.35;}
#nsws-streak .status.good{color:#96ff96;}
#nsws-streak .shield{margin:0 0 12px;font-size:15px;line-height:1.35;color:rgba(255,255,255,.7);}
#nsws-streak .row{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 14px;}
#nsws-streak .row>.button{margin:0;font-size:20px;padding:7px 16px;}
#nsws-streak .card{padding:12px 16px;background:var(--surface-secondary-color);clip-path:polygon(0 0,100% 0,calc(100% - 10px) 100%,0 100%);}
#nsws-streak .card>h2{margin:0 0 6px;font-size:20px;font-weight:normal;}
#nsws-streak ol{margin:0;padding-left:22px;font-size:15px;line-height:1.5;color:rgba(255,255,255,.85);}
#nsws-streak .msg{padding:30px 10px;text-align:center;font-size:17px;color:rgba(255,255,255,.65);}
#nsws-streak .msg>.button{margin-top:12px;font-size:18px;}
.nsws-streak-line{display:inline-flex;align-items:center;gap:6px;margin-left:18px;font-size:22px;vertical-align:middle;color:#ffc94a;cursor:pointer;pointer-events:auto;}
.nsws-streak-line>img{width:22px;height:22px;}
.nsws-streak-line.done{color:#96ff96;}
.nsws-streak-line.off{color:rgba(255,255,255,.65);}
@media (max-width:560px){#nsws-streak .weeks{grid-template-columns:repeat(4,minmax(0,1fr));}#nsws-streak .hero .n{font-size:48px;}}
`;

    let state = null;
    let view = null;
    let failed = false;
    const buttons = new Set();
    let recheck = [];

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

    function streak() {
        return state?.streak ?? null;
    }

    function weekName(week) {
        const w = (window.__nswsWeeks || []).find((x) => x.week === week);
        return w?.label || "Week " + week;
    }

    function weeksText(n) {
        return n + (n === 1 ? " week" : " weeks");
    }

    function firstTrack(week) {
        return window.__nswsTracksForWeek?.(week)?.[0]?.id ?? null;
    }

    // The menu's bottom bar is rebuilt now and then; every copy of the button is kept up to date.
    function mountButton(b) {
        b.classList.add("nsws-streak-btn");
        buttons.add(b);
        paintButton(b);
    }

    function paintButton(b) {
        const s = streak();
        b.textContent = "";
        b.append(icon(FLAME), " Streak" + (s ? ": " + s.weeks : ""));
        b.title = !s ? "Weekly streak" : s.thisWeek ? weekName(s.live) + " counted" : "Finish a run on " + weekName(s.live) + " to keep your streak";
        if (s && !s.thisWeek && s.weeks > 0) b.appendChild(el("span", "due"));
    }

    function paintAll() {
        for (const b of buttons) {
            if (b.isConnected) paintButton(b);
            else buttons.delete(b);
        }
        paintPlayLine();
        render();
    }

    function lineText(s) {
        if (s.thisWeek) return s.weeks + "-week streak · this week counted";
        if (s.weeks > 0) return s.weeks + "-week streak · finish a run to keep it";
        return "Finish a run this week to start a streak";
    }

    // A note on the current week's heading in the Play menu.
    function paintPlayLine() {
        const s = streak();
        const menu = document.querySelector(".track-selection-ui:not(.hidden)");
        if (!menu) return;
        const old = menu.querySelector(".nsws-streak-line");
        if (!s || s.live !== window.__nswsCurrentWeek) {
            old?.remove();
            return;
        }
        const names = new Set([weekName(s.live), ...((window.__nswsWeeks || []).find((x) => x.week === s.live)?.parts || []).map((p) => p.label)]);
        const title = [...menu.querySelectorAll(".group-title")].find((t) => names.has(t.firstChild?.textContent?.trim()));
        if (!title) return;
        const className = "nsws-streak-line" + (s.thisWeek ? " done" : s.weeks > 0 ? "" : " off");
        const text = lineText(s);
        // Runs every second, and several observers watch the whole page: only touch the DOM on a change.
        if (old && old.parentNode === title && old.className === className && old.dataset.text === text) return;
        const line = old && old.parentNode === title ? old : el("span", "nsws-streak-line");
        line.className = className;
        line.dataset.text = text;
        line.textContent = "";
        line.append(icon(FLAME), text);
        line.title = "Open your weekly streak";
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

    function open() {
        if (view) return;
        const overlay = el("div");
        overlay.id = "nsws-streak";
        const box = el("div", "box");
        box.appendChild(el("div", "checker"));
        const top = el("div", "top");
        top.append(el("h1", null, "Weekly streak"), button("✕", close));
        const body = el("div", "body");
        box.append(top, body);
        overlay.appendChild(box);
        overlay.addEventListener("pointerdown", (e) => {
            if (e.target === overlay) close();
        });
        for (const type of ["keydown", "keyup", "keypress"]) overlay.addEventListener(type, (e) => e.stopPropagation());
        document.body.appendChild(overlay);
        window.addEventListener("keydown", onKey, true);
        view = { overlay, body, copied: false };
        failed = false;
        render();
        window.__nswsTags?.refresh().catch(() => {
            failed = true;
            render();
        });
    }

    const MARKS = { played: "✓", shield: "", missed: "–", open: "?" };

    function render() {
        if (!view) return;
        const body = view.body;
        body.textContent = "";
        const s = streak();
        if (!s) {
            const msg = el("div", "msg", failed ? "Couldn't load your streak." : "Loading your streak…");
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

        const hero = el("div", "hero" + (s.weeks ? "" : " off"));
        const count = el("div");
        count.append(el("span", "n", String(s.weeks)), el("span", "unit", s.weeks === 1 ? " week in a row" : " weeks in a row"));
        const best = el("div", "best", "Best");
        best.appendChild(el("b", null, weeksText(s.best)));
        hero.append(icon(FLAME), count, best);
        body.appendChild(hero);

        // Always the last eight weeks; weeks before the first one played show as missed.
        const weeks = el("div", "weeks");
        const marks = new Map(s.marks.map((m) => [m.week, m.mark]));
        for (let w = Math.max(1, s.live - 7); w <= s.live; w++) {
            const kind = marks.get(w) ?? (w === s.live ? "open" : "missed");
            const tile = el("div", "wk " + kind);
            const mark = el("div", "mark");
            if (kind === "played") mark.appendChild(icon(FLAME));
            else if (kind === "shield") mark.textContent = "🛡️";
            else mark.textContent = MARKS[kind];
            tile.append(mark, el("div", null, "W" + w));
            tile.title = weekName(w) + ": " + { played: "played", shield: "missed, covered by your shield", missed: "not played", open: "not played yet" }[kind];
            weeks.appendChild(tile);
        }
        body.appendChild(weeks);

        const live = weekName(s.live);
        if (s.thisWeek) {
            body.appendChild(el("p", "status good", live + " counted. Come back for the next week to make it " + weeksText(s.weeks + 1) + "."));
        } else {
            body.appendChild(el("p", "status", s.weeks > 0
                ? "Finish a run on any " + live + " track to make it " + weeksText(s.weeks + 1) + "."
                : "Finish a run on any " + live + " track to start a streak."));
        }
        body.appendChild(el("p", "shield", s.shield
            ? "🛡️ Streak shield ready: if you miss a week, it saves your streak."
            : "🛡️ Streak shield used. It comes back after " + weeksText(s.refillIn) + " in a row."));

        const row = el("div", "row");
        const trackId = firstTrack(s.live);
        if (!s.thisWeek && trackId && window.__bw_selectTrackById) {
            row.appendChild(button("Play " + live, () => {
                close();
                window.__bw_selectTrackById(trackId);
            }));
        }
        if (window.__nswsShare) {
            row.appendChild(button(view.copied ? "Copied!" : "Copy week card", () => {
                window.__nswsShare.copyWeekCard().then(() => {
                    if (!view) return;
                    view.copied = true;
                    render();
                }).catch(() => {});
            }));
        }
        if (row.childNodes.length) body.appendChild(row);

        const how = el("div", "card");
        how.appendChild(el("h2", null, "How it works"));
        const steps = el("ol");
        for (const step of [
            "A week counts when you finish a run on any of its tracks while it's the current week.",
            "Old weeks don't count, so play each week while it's live.",
            "Miss a week and your streak starts again, unless your shield covers it.",
            "A used shield comes back after 3 weeks in a row.",
        ]) steps.appendChild(el("li", null, step));
        how.appendChild(steps);
        body.appendChild(how);
    }

    // After a personal best on the live week, re-read the account until the week shows as counted.
    function onPB() {
        const s = streak();
        const trackId = window.__getCurrentTrack?.()?.getId?.();
        if (!s || s.thisWeek || !trackId || window.__nswsTrackWeek?.(trackId) !== s.live) return;
        for (const t of recheck) clearTimeout(t);
        recheck = RECHECK_MS.map((ms) => setTimeout(() => {
            if (streak()?.thisWeek) return;
            window.__nswsTags?.refresh().catch(() => {});
        }, ms));
    }

    function onAccount(e) {
        const before = streak();
        state = e.detail;
        const after = streak();
        if (before && after && !before.thisWeek && after.thisWeek && before.live === after.live) {
            for (const t of recheck) clearTimeout(t);
            recheck = [];
            window.__nswsTags?.toast(weekName(after.live) + " counted! Your streak is " + weeksText(after.weeks) + " 🔥");
        }
        paintAll();
    }

    if (!document.getElementById("nsws-streak-style")) {
        const style = el("style");
        style.id = "nsws-streak-style";
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    window.addEventListener("nsws-account", onAccount);
    window.addEventListener("nsws-pb", onPB);
    // The Play menu builds its headings when it opens; a cheap check finds them.
    setInterval(() => {
        if (state && document.visibilityState === "visible") paintPlayLine();
    }, 1000);

    window.__nswsStreak = { mountButton, open, state: streak };
})();
