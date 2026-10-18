// Sharing. A new personal best gets a Share button on its banner: it turns the PB screen (the 3D view
// plus the banner, without the HUD) into an image to copy or save. The week card is a line of medal
// emojis and the week's bingo card for the current week, with the player's referral link. On a week that is still live, every
// time in the image reads SECRET, like the leaderboard, except the green improvement on the player's own
// previous PB. Sharing counts for the weekly bingo.
(function () {
    const TIME = /[+\-−]?\d+(?::\d{1,2})*[.,]\d+s?/g;
    const MIN_WIDTH = 1280;
    const MAX_WIDTH = 1920;
    const MEDALS = { author: "💎", gold: "🥇", silver: "🥈", bronze: "🥉" };
    const FINISHED = "🏁";
    const UNPLAYED = "⬛";
    const SHOW_DELAY_MS = 1200;

    const CSS = `
.time-announcer-ui>.nsws-share-row{display:flex;justify-content:center;margin-top:18px;opacity:0;transition:opacity .4s ease-in-out;pointer-events:none;}
.time-announcer-ui>.nsws-share-row.show{opacity:1;}
.time-announcer-ui>.nsws-share-row.show>.button{pointer-events:auto;}
.time-announcer-ui>.nsws-share-row>.button{margin:0;padding:6px 22px;font-size:26px;}
.nsws-share-row>.button>img,#nsws-share .button>img{width:22px;height:22px;margin-right:4px;vertical-align:-3px;pointer-events:none;}
#nsws-share{position:fixed;inset:0;z-index:9998;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.7);}
#nsws-share *{box-sizing:border-box;}
#nsws-share>.box{position:relative;display:flex;flex-direction:column;width:min(900px,96vw);max-height:94vh;background:var(--surface-color);color:var(--text-color);clip-path:polygon(0 0,100% 0,calc(100% - 14px) 100%,0 100%);outline:none;}
#nsws-share .checker{height:8px;flex-shrink:0;background:repeating-conic-gradient(#fff 0 25%,#112052 0 50%) 0 0/8px 8px;opacity:.85;}
#nsws-share .top{display:flex;align-items:center;gap:12px;padding:12px 20px;background:var(--surface-secondary-color);}
#nsws-share .top>h1{margin:0 auto 0 0;font-size:32px;font-weight:normal;color:#b3c1ff;text-shadow:0 2px 0 #112052;}
#nsws-share .top>.button{margin:0;font-size:20px;padding:6px 14px;}
#nsws-share .body{overflow-y:auto;padding:16px 20px 20px;}
#nsws-share .shot{display:flex;align-items:center;justify-content:center;min-height:120px;background:var(--surface-tertiary-color);}
#nsws-share .shot>img{display:block;max-width:100%;max-height:46vh;}
#nsws-share .shot>.wait{padding:40px;font-size:18px;color:rgba(255,255,255,.6);}
#nsws-share .note{min-height:20px;margin:8px 0 0;font-size:15px;line-height:1.35;color:rgba(255,255,255,.7);}
#nsws-share .note.good{color:#96ff96;}
#nsws-share .note.bad{color:#ff9a9a;}
#nsws-share .row{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;}
#nsws-share .row>.button{margin:0;font-size:20px;padding:7px 16px;}
#nsws-share .card{margin-top:16px;padding:12px 16px;background:var(--surface-secondary-color);clip-path:polygon(0 0,100% 0,calc(100% - 10px) 100%,0 100%);}
#nsws-share .card>h2{margin:0 0 4px;font-size:20px;font-weight:normal;}
#nsws-share .card>.sub{margin:0 0 8px;font-size:13px;color:rgba(255,255,255,.55);}
#nsws-share .card>pre{margin:0;padding:10px 12px;background:var(--surface-tertiary-color);font-family:inherit;font-size:17px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text;}
`;

    let view = null;
    let logo = null;

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function button(text, onClick, iconSrc) {
        const b = el("button", "button");
        if (iconSrc) {
            const img = el("img");
            img.src = iconSrc;
            img.alt = "";
            b.appendChild(img);
        }
        b.append(text);
        b.addEventListener("click", (e) => {
            window.__nswsUIClick?.();
            onClick(e);
        });
        return b;
    }

    function nickname() {
        try {
            const slot = parseInt(localStorage.getItem("polytrack_v5_prod_user_slot") ?? "0", 10);
            const nick = JSON.parse(localStorage.getItem("polytrack_v5_prod_user_" + (slot >= 0 ? slot : 0)))?.nickname;
            return typeof nick === "string" && nick.trim() ? nick.trim() : null;
        } catch {
            return null;
        }
    }

    function weekName(week) {
        const w = (window.__nswsWeeks || []).find((x) => x.week === week);
        return w?.label || "Week " + week;
    }

    function siteLink() {
        return window.__nswsShareBase || location.origin + location.pathname.replace(/index\.html$/, "");
    }

    function shareLink() {
        return window.__nswsTags?.refLink?.() || siteLink();
    }

    function copyText(text) {
        if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
        return new Promise((resolve, reject) => {
            const area = el("textarea");
            area.value = text;
            area.style.cssText = "position:fixed;left:-9999px;top:0;";
            document.body.appendChild(area);
            area.select();
            const ok = document.execCommand("copy");
            area.remove();
            ok ? resolve() : reject(new Error("copy failed"));
        });
    }

    function activity(kind) {
        window.dispatchEvent(new CustomEvent("nsws-activity", { detail: { kind } }));
    }

    // Spoiler-free, like a Wordle grid: the bingo card, then one emoji per track, best medal or just a finish.
    function weekCard(week = window.__nswsCurrentWeek) {
        const tracks = window.__nswsTracksForWeek?.(week) ?? [];
        if (!tracks.length) return null;
        const marks = tracks.map((t) => {
            const tier = window.__nswsMedalTier?.(t.id);
            if (tier && MEDALS[tier]) return MEDALS[tier];
            return window.__nswsPersonalBest?.(t.id) != null ? FINISHED : UNPLAYED;
        });
        const done = marks.filter((m) => m !== UNPLAYED).length;
        const bingo = window.__nswsBingo?.shareLines?.(week);
        const lines = bingo ? [...bingo] : ["Not So Weekly Shorts · " + weekName(week)];
        lines.push(marks.join("") + "  " + done + "/" + tracks.length + " tracks", shareLink());
        return lines.join("\n");
    }

    function copyWeekCard(week) {
        const card = weekCard(week);
        if (!card) return Promise.reject(new Error("no week"));
        return copyText(card).then(() => {
            if (week == null || week === window.__nswsCurrentWeek) activity("card");
        });
    }

    function loadLogo() {
        if (logo) return logo;
        logo = new Promise((resolve) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = "images/logo.svg";
        });
        return logo;
    }

    function parseShadows(value) {
        if (!value || value === "none") return [];
        return value.split(/,(?![^(]*\))/).map((part) => {
            const color = part.match(/rgba?\([^)]*\)|#[0-9a-f]+|[a-z]+/i)?.[0] ?? "#000";
            const nums = (part.replace(color, "").match(/-?[\d.]+px/g) ?? []).map(parseFloat);
            return { color, x: nums[0] ?? 0, y: nums[1] ?? 0, blur: nums[2] ?? 0 };
        });
    }

    function isClear(color) {
        return !color || color === "transparent" || /rgba\([^)]*,\s*0\)$/.test(color);
    }

    function drawText(ctx, node, cs, k, secret, clip) {
        let text = node.textContent;
        if (!text.trim()) return;
        const range = document.createRange();
        range.selectNodeContents(node);
        const r = range.getBoundingClientRect();
        if (!r.width || !r.height) return;
        if (secret) text = text.replace(TIME, "SECRET");
        ctx.save();
        if (clip) {
            ctx.beginPath();
            ctx.rect(clip.left * k, clip.top * k, clip.width * k, clip.height * k);
            ctx.clip();
        }
        ctx.font = cs.fontStyle + " " + cs.fontWeight + " " + parseFloat(cs.fontSize) * k + "px " + cs.fontFamily;
        ctx.textBaseline = "alphabetic";
        const m = ctx.measureText(text);
        // Anchored the way the page aligns it, so a SECRET wider than the time grows away from its neighbours.
        const align = cs.textAlign;
        const x = align === "right" || align === "end" ? r.right * k - m.width
            : align === "left" || align === "start" ? r.left * k
            : (r.left + r.width / 2) * k - m.width / 2;
        const y = r.top * k + (r.height * k + m.fontBoundingBoxAscent - m.fontBoundingBoxDescent) / 2;
        ctx.fillStyle = cs.color;
        for (const s of parseShadows(cs.textShadow).reverse()) {
            ctx.shadowColor = s.color;
            ctx.shadowOffsetX = s.x * k;
            ctx.shadowOffsetY = s.y * k;
            ctx.shadowBlur = s.blur * k;
            ctx.fillText(text, x, y);
        }
        ctx.shadowColor = "transparent";
        ctx.fillText(text, x, y);
        ctx.restore();
    }

    function intersect(a, b) {
        if (!a) return b;
        const left = Math.max(a.left, b.left);
        const top = Math.max(a.top, b.top);
        return { left, top, width: Math.max(0, Math.min(a.left + a.width, b.left + b.width) - left), height: Math.max(0, Math.min(a.top + a.height, b.top + b.height) - top) };
    }

    // Draws the banner as the page shows it: backgrounds, images and text at their on-screen boxes,
    // clipped only where the page clips (overflow hidden, e.g. a long track name).
    function drawElement(ctx, node, k, secret, alpha, clip = null) {
        if (node.classList.contains("nsws-share-row")) return;
        // The improvement on the old PB; the other .difference block (with a .title) compares to an opponent.
        if (node.classList.contains("difference") && !node.querySelector(".title")) secret = false;
        const cs = getComputedStyle(node);
        if (cs.display === "none" || cs.visibility === "hidden") return;
        const opacity = alpha * parseFloat(cs.opacity || "1");
        if (opacity < 0.02) return;
        const r = node.getBoundingClientRect();
        if (cs.overflowX !== "visible" || cs.overflowY !== "visible") clip = intersect(clip, r);
        ctx.globalAlpha = opacity;
        if (!isClear(cs.backgroundColor) && r.width && r.height) {
            ctx.fillStyle = cs.backgroundColor;
            ctx.fillRect(r.left * k, r.top * k, r.width * k, r.height * k);
        }
        if (node.tagName === "IMG") {
            if (node.complete && node.naturalWidth) ctx.drawImage(node, r.left * k, r.top * k, r.width * k, r.height * k);
            return;
        }
        for (const child of node.childNodes) {
            ctx.globalAlpha = opacity;
            if (child.nodeType === Node.TEXT_NODE) drawText(ctx, child, cs, k, secret, clip);
            else if (child.nodeType === Node.ELEMENT_NODE) drawElement(ctx, child, k, secret, opacity, clip);
        }
        ctx.globalAlpha = 1;
    }

    async function drawFooter(ctx, w, h, trackId) {
        const bar = Math.round(h * 0.075);
        const top = h - bar;
        ctx.globalAlpha = 1;
        ctx.fillStyle = "rgba(25, 32, 66, 0.9)";
        ctx.fillRect(0, top, w, bar);
        ctx.fillStyle = "#ffc94a";
        ctx.fillRect(0, top, w, Math.max(2, Math.round(bar * 0.05)));
        const pad = Math.round(bar * 0.3);
        let x = pad;
        const img = await loadLogo();
        if (img?.naturalWidth) {
            const lh = bar * 0.72;
            const lw = lh * (img.naturalWidth / img.naturalHeight);
            ctx.drawImage(img, x, top + (bar - lh) / 2, lw, lh);
            x += lw + pad;
        }
        const week = window.__nswsTrackWeek?.(trackId);
        const who = [nickname(), week != null ? weekName(week) : null].filter(Boolean).join(" · ");
        ctx.textBaseline = "middle";
        ctx.font = "italic " + Math.round(bar * 0.4) + "px ForcedSquare, Arial, sans-serif";
        ctx.fillStyle = "#fff";
        ctx.fillText(who, x, top + bar / 2);
        const link = siteLink().replace(/^https?:\/\//, "").replace(/\/$/, "");
        ctx.font = "italic " + Math.round(bar * 0.32) + "px ForcedSquare, Arial, sans-serif";
        ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
        ctx.textAlign = "right";
        ctx.fillText(link, w - pad, top + bar / 2);
        ctx.textAlign = "left";
    }

    async function renderShot(panel, trackId, secret) {
        await document.fonts?.ready;
        const screen = document.getElementById("screen");
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const w = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, vw * (window.devicePixelRatio || 1))));
        const h = Math.round(w * vh / vw);
        const k = w / vw;
        const canvas = el("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#192042";
        ctx.fillRect(0, 0, w, h);
        // The game canvas keeps its last frame (preserveDrawingBuffer), so it can be read at any time.
        if (screen?.width) {
            const r = screen.getBoundingClientRect();
            ctx.drawImage(screen, r.left * k, r.top * k, r.width * k, r.height * k);
        }
        if (panel.isConnected) drawElement(ctx, panel, k, secret, 1);
        await drawFooter(ctx, w, h, trackId);
        return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("no image"))), "image/png"));
    }

    function fileName(trackName) {
        const safe = String(trackName || "track").replace(/[\\/:*?"<>|]+/g, "").trim() || "track";
        return "NSWS - " + safe + " - PB.png";
    }

    function onKey(e) {
        if (e.key !== "Escape" && e.code !== "Escape") return;
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
    }

    function close() {
        if (!view) return;
        if (view.url) URL.revokeObjectURL(view.url);
        view.overlay.remove();
        window.removeEventListener("keydown", onKey, true);
        view = null;
    }

    function setNote(text, kind) {
        if (!view) return;
        view.note.textContent = text;
        view.note.className = "note" + (kind ? " " + kind : "");
    }

    async function openShare(panel, trackId, trackName) {
        if (view) return;
        const week = window.__nswsTrackWeek?.(trackId);
        const secret = week != null && week === window.__nswsCurrentWeek;
        // Taken before the window opens, so the shot is the PB screen and not this window.
        const shot = renderShot(panel, trackId, secret);

        const overlay = el("div");
        overlay.id = "nsws-share";
        const box = el("div", "box");
        box.tabIndex = -1;
        box.appendChild(el("div", "checker"));
        const top = el("div", "top");
        top.append(el("h1", null, "Share your PB"), button("✕", close));
        const body = el("div", "body");
        box.append(top, body);
        overlay.appendChild(box);
        overlay.addEventListener("pointerdown", (e) => {
            if (e.target === overlay) close();
        });
        for (const type of ["keydown", "keyup", "keypress"]) overlay.addEventListener(type, (e) => e.stopPropagation());

        const frame = el("div", "shot");
        frame.appendChild(el("div", "wait", "Taking the picture…"));
        body.appendChild(frame);
        const note = el("p", "note", secret ? weekName(week) + " is still live, so your time shows as SECRET. Your improvement still shows." : "");
        const row = el("div", "row");
        body.append(row, note);
        view = { overlay, note, url: null, blob: null };

        const canCopy = !!(navigator.clipboard?.write && window.ClipboardItem);
        const copyButton = button("Copy image", async () => {
            if (!view?.blob) return;
            try {
                await navigator.clipboard.write([new ClipboardItem({ "image/png": view.blob })]);
                setNote("Copied! Paste it into Discord or a chat.", "good");
                activity("share");
            } catch {
                setNote("Your browser wouldn't copy the image. Save it instead.", "bad");
            }
        }, "images/copy.svg");
        const saveButton = button("Save image", () => {
            if (!view?.url) return;
            const a = el("a");
            a.href = view.url;
            a.download = fileName(trackName);
            document.body.appendChild(a);
            a.click();
            a.remove();
            setNote("Saved.", "good");
            activity("share");
        }, "images/save.svg");
        if (canCopy) row.appendChild(copyButton);
        row.appendChild(saveButton);
        for (const b of row.children) b.disabled = true;

        if (week != null) {
            const card = el("div", "card");
            card.append(el("h2", null, "Week card"), el("p", "sub", "Your " + weekName(week) + " bingo card and medals with no times, plus your invite link."));
            const pre = el("pre", null, weekCard(week));
            const copyCard = button("Copy week card", () => {
                copyWeekCard(week).then(() => setNote("Week card copied!", "good"), () => setNote("Couldn't copy the week card.", "bad"));
            }, "images/copy.svg");
            const cardRow = el("div", "row");
            cardRow.appendChild(copyCard);
            card.append(pre, cardRow);
            body.appendChild(card);
        }

        document.body.appendChild(overlay);
        window.addEventListener("keydown", onKey, true);
        box.focus();

        try {
            const blob = await shot;
            if (!view || view.overlay !== overlay) return;
            view.blob = blob;
            view.url = URL.createObjectURL(blob);
            const img = el("img");
            img.src = view.url;
            img.alt = "Your personal best";
            frame.textContent = "";
            frame.appendChild(img);
            for (const b of row.children) b.disabled = false;
            const file = new File([blob], fileName(trackName), { type: "image/png" });
            if (navigator.canShare?.({ files: [file] })) {
                row.appendChild(button("Share…", () => {
                    navigator.share({ files: [file], text: "My new PB on Not So Weekly Shorts! " + shareLink() }).then(() => activity("share"), () => {});
                }, "images/share.svg"));
            }
            if (!canCopy && !secret) setNote("Save the image, then post it anywhere.");
        } catch {
            if (!view || view.overlay !== overlay) return;
            frame.textContent = "";
            frame.appendChild(el("div", "wait", "Couldn't take the picture."));
        }
    }

    function onPB(e) {
        const panel = e.detail?.panel;
        const trackId = window.__getCurrentTrack?.()?.getId?.();
        if (!panel || !trackId || window.__nswsCupApp?.inCup?.()) return;
        const row = el("div", "nsws-share-row");
        const b = button(" Share PB", (ev) => {
            ev.stopPropagation();
            openShare(panel, trackId, e.detail.trackName);
        }, "images/share.svg");
        // Never take focus: Enter and Space are driving keys.
        b.addEventListener("mousedown", (ev) => ev.preventDefault());
        b.tabIndex = -1;
        row.appendChild(b);
        panel.appendChild(row);
        setTimeout(() => row.classList.add("show"), SHOW_DELAY_MS);
    }

    if (!document.getElementById("nsws-share-style")) {
        const style = el("style");
        style.id = "nsws-share-style";
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    window.addEventListener("nsws-pb", onPB);
    window.__nswsShare = { weekCard, copyWeekCard };
})();
