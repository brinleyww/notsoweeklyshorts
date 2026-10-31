// The limited Halloween event, 2026: the night menu, the main menu button, its panel and the Play menu's countdown. Everything
// turns itself off when the window ends, so nothing has to ship to end it. Keep the dates, tracks and time in step with
// proxy/src/halloween.js and the week's entry in main.bundle.js.
(function () {
    const FROM = Date.UTC(2026, 9, 31);
    const UNTIL = Date.UTC(2026, 10, 3, 3, 41);
    const WEEK = 1031;
    const TRACK = "b145eb72b1699e086776e43e1d07f95d4c13f7bd1a0c9240ec9d1cbc53f547a8";
    const ROUTE = "fff0f88c24a69f3919b7bea7ea6686a37414fdfb3dee6211f55cfb9792131279";
    const LABEL = "Halloween";
    const HORSEMAN_FRAMES = 16800;
    const BINGO_TRACKS = [
        TRACK,
        ROUTE,
        "4b742980c7970ecc3e3419c2935bc8272a6cc8c0fedb40552b0a2fbeb19b5f2d",
        "934290e7f5d95eb0f0915ed8f9ce6503851b4b87d1ea5926a0c8a3e6ea9dbd8d",
        "fb895534b1f4450b67e4287b7b69531be21364c561879daf3e015dcf410f2185",
    ];
    const GOTHIC = [
        "2ec74a179c8aba94354e3c6dee2a2920bedd7d84adf4d0a691f4a7453afdb1e8",
        "76269faf38e8726671c05b2b9044f7aa3e66c4313cb4fa5d0fbb23fc8524fe9e",
        "520c4f511821ced30b99bceafbb02e6b7531e867126b0756e68d5e157691ef2f",
        "3cd94552b12fb3a8ac45ca3a5e21a882b71b31c788989b396ab382afc69414ac",
        "5159a8dac6a1f397407a7b5233ad570613531f6609f7dc897490c28c9f2c7a4e",
    ];
    const CUPS = [Date.UTC(2026, 9, 31, 20), Date.UTC(2026, 10, 1, 20)];
    const TAG_IDS = ["horseman", "haunted", "pumpkin"];

    const CSS = `
:root.nsws-halloween{--surface-color:#2c2148;--surface-secondary-color:#231a3b;--surface-tertiary-color:#17102a;--surface-transparent-color:rgba(44,33,72,.5);--button-color:#1c1433;--button-hover-color:#46306a;--button-active-color:#140e26;}
:root.nsws-halloween.nsws-menu-scene #screen{filter:brightness(.5) saturate(.65) hue-rotate(-14deg);}
.nsws-haunted-btn>img{width:22px;height:22px;}
.nsws-haunted-btn{box-shadow:inset 0 -3px #ff8a1e;}
.nsws-haunted-btn.short>span{display:none;}
.nsws-haunted-left{margin-left:18px;font-size:22px;color:#ff8a1e;vertical-align:middle;}
#nsws-haunted{position:fixed;inset:0;z-index:9998;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.7);}
#nsws-haunted *{box-sizing:border-box;}
#nsws-haunted>.box{display:flex;flex-direction:column;width:min(640px,96vw);max-height:94vh;background:var(--surface-color);color:var(--text-color);border-top:4px solid #ff8a1e;outline:none;}
#nsws-haunted .top{display:flex;align-items:center;gap:10px;padding:10px 20px;background:var(--surface-secondary-color);}
#nsws-haunted .top>h1{margin:0 auto 0 0;font-size:30px;font-weight:normal;white-space:nowrap;}
#nsws-haunted .top>small{font-size:15px;color:rgba(255,255,255,.65);}
#nsws-haunted .top>.button{margin:0;font-size:20px;padding:6px 14px;}
#nsws-haunted .body{overflow-y:auto;padding:6px 20px 18px;}
#nsws-haunted h2{margin:14px 0 2px;padding-bottom:3px;font-size:15px;font-weight:normal;font-style:italic;color:rgba(255,255,255,.65);border-bottom:1px solid #fff;}
#nsws-haunted .line{display:flex;align-items:center;justify-content:space-between;gap:14px;min-height:46px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.1);font-size:17px;}
#nsws-haunted .line>div>small{display:block;margin-top:2px;font-size:13px;line-height:1.3;color:rgba(255,255,255,.65);}
#nsws-haunted .line>.right{flex-shrink:0;display:flex;align-items:center;gap:10px;font-size:15px;white-space:nowrap;}
#nsws-haunted .line .button{margin:0;font-size:17px;padding:5px 14px;}
#nsws-haunted .line .button.main{box-shadow:inset 0 -3px #ff8a1e;}
#nsws-haunted .yes{color:#ffb066;}
#nsws-haunted .no{color:rgba(255,255,255,.5);}
#nsws-haunted .line .button:disabled{opacity:.35;}
@media (max-width:560px){#nsws-haunted .line{flex-wrap:wrap;}#nsws-haunted .top{padding:8px 12px;}#nsws-haunted .top>h1{font-size:24px;}#nsws-haunted .top>small{font-size:13px;white-space:nowrap;}}
`;

    let view = null;
    let account = null;
    const buttons = new Set();

    function active(now = Date.now()) {
        return now >= FROM && now < UNTIL;
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function button(text, onClick, className) {
        const b = el("button", "button" + (className ? " " + className : ""), text);
        b.addEventListener("click", () => {
            window.__nswsUIClick?.();
            onClick(b);
        });
        return b;
    }

    function beatsHorseman(track, seconds) {
        return track === TRACK && HORSEMAN_FRAMES != null && Math.round(seconds * 1000) <= HORSEMAN_FRAMES;
    }

    function timeText(frames) {
        const m = Math.floor(frames / 60000);
        const s = (frames % 60000) / 1000;
        return (m ? m + ":" + s.toFixed(3).padStart(6, "0") : s.toFixed(3)) + " s";
    }

    function whenText(at) {
        return new Date(at).toLocaleString(undefined, { weekday: "long", hour: "numeric", minute: "2-digit" });
    }

    function timeLeft() {
        const minutes = Math.max(0, Math.ceil((UNTIL - Date.now()) / 60000));
        const hours = Math.floor(minutes / 60);
        const rest = minutes % 60;
        if (!minutes) return "Ended";
        const parts = [hours ? hours + (hours === 1 ? " hour" : " hours") : "", rest ? rest + " min" : ""];
        return parts.filter(Boolean).join(" ") + " left";
    }

    function line(title, note, ...right) {
        const row = el("div", "line");
        const left = el("div", null, title);
        if (note) left.appendChild(el("small", null, note));
        const side = el("div", "right");
        side.append(...right);
        row.append(left, side);
        return row;
    }

    function ownedTags() {
        return account?.owned ?? [];
    }

    function render() {
        if (!view) return;
        const { top, body } = view;
        top.textContent = "";
        top.append(el("h1", null, LABEL), el("small", null, timeLeft()), button("✕", close));
        body.textContent = "";

        body.appendChild(el("h2", null, "Race"));
        const play = (id, className) => button("Play", () => {
            close();
            window.__nswsOpenTrack?.(id);
        }, className);
        body.appendChild(line("Haunted - Bloodbourne", "Limited tracks with boards of their own and times shown live.", play(TRACK, "main")));
        body.appendChild(line("Dead Man's Line", "Tight and flat out, from one transition to the next.", play(ROUTE)));
        body.appendChild(line("Beat the Headless Horseman", HORSEMAN_FRAMES != null ? "His time on Haunted - Bloodbourne: " + timeText(HORSEMAN_FRAMES) : null,
            el("span", ownedTags().includes("horseman") ? "yes" : "no", ownedTags().includes("horseman") ? "Beaten" : "Not yet")));
        body.appendChild(line("Halloween bingo", "A second card just for this event. Your weekly card keeps counting too.", button("Open card", () => {
            close();
            window.__nswsBingo?.open(WEEK);
        })));
        body.appendChild(line("Horseman cups", CUPS.map(whenText).join(" and ") + ". The link goes up in an announcement."));

        body.appendChild(el("h2", null, "Bring a friend"));
        const link = window.__nswsTags?.refLink?.();
        const copyLink = button("Copy link", (b) => {
            if (!link || !navigator.clipboard?.writeText) return;
            navigator.clipboard.writeText(link).then(() => {
                b.textContent = "Copied!";
            }, () => {});
        });
        copyLink.disabled = !link;
        body.appendChild(line("Invite someone new", "You both get PUMPKIN once they upload a run.", copyLink));

        body.appendChild(el("h2", null, "Tags you can only earn during this event"));
        for (const id of TAG_IDS) {
            const tag = window.__nswsTags?.catalog?.find((t) => t.id === id);
            if (!tag) continue;
            const owned = ownedTags().includes(id);
            body.appendChild(line("", tag.need, window.__nswsTags.chip(id) ?? "", el("span", owned ? "yes" : "no", owned ? "Earned" : "Not yet")));
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
        overlay.id = "nsws-haunted";
        const box = el("div", "box");
        box.tabIndex = -1;
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
        view = { overlay, top, body };
        render();
        window.__nswsTags?.refresh?.().catch(() => {});
    }

    function mountButton(b) {
        b.classList.add("nsws-haunted-btn");
        const img = el("img");
        img.src = "images/pumpkin.svg";
        img.alt = "";
        img.draggable = false;
        b.append(img, el("span", null, " " + LABEL));
        buttons.add(b);
        setTimeout(fitButtons, 0);
    }

    // Long translations leave the bottom bar no room in a small window: its last button is pinned right, so the others run under it.
    function fitButtons() {
        for (const b of buttons) {
            const shown = [...(b.parentElement?.children ?? [])].filter((e) => e.offsetWidth);
            if (shown.length < 2) continue;
            b.classList.remove("short");
            const pinned = shown[shown.length - 1];
            if (shown[shown.length - 2].getBoundingClientRect().right > pinned.getBoundingClientRect().left) b.classList.add("short");
        }
    }

    // Runs every second, and several observers watch the whole page, so the DOM is only touched when the text changes.
    function paintCountdown() {
        const menu = document.querySelector(".track-selection-ui:not(.hidden)");
        if (!menu) return;
        const text = timeLeft();
        const title = [...menu.querySelectorAll(".group-title")].find((t) => t.firstChild?.textContent?.trim() === LABEL);
        if (!title) return;
        const old = title.querySelector(".nsws-haunted-left");
        if (old?.textContent === text) return;
        const left = old ?? el("span", "nsws-haunted-left");
        left.textContent = text;
        if (!old) title.appendChild(left);
    }

    function paintTheme() {
        document.documentElement.classList.toggle("nsws-halloween", active());
        if (!active()) {
            close();
            for (const b of buttons) b.remove();
            buttons.clear();
        }
    }

    const style = el("style");
    style.id = "nsws-haunted-style";
    style.textContent = CSS;
    document.head.appendChild(style);
    paintTheme();
    setInterval(paintTheme, 60000);
    setInterval(() => document.visibilityState === "visible" && paintCountdown(), 1000);
    // The game rescales the bar in its own resize handling, so this has to measure a little later.
    let fitTimer = 0;
    window.addEventListener("resize", () => {
        clearTimeout(fitTimer);
        fitTimer = setTimeout(fitButtons, 300);
    });
    document.fonts?.ready.then(fitButtons, () => {});
    window.addEventListener("nsws-account", (e) => {
        account = e.detail;
        render();
        fitButtons();
    });

    window.__nswsHalloween = {
        week: WEEK,
        track: TRACK,
        label: LABEL,
        gothic: GOTHIC,
        active,
        open,
        mountButton,
        beatsHorseman,
        bingoTracks: () => BINGO_TRACKS,
    };
})();
