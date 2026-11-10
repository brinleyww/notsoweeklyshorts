// Asks each browser once, on the main menu, whether to join the NSWS Discord. It only asks after
// Discord's invite API answers with the right server, so a network that blocks Discord (a school
// filter, or a block page in its place) never sees it; that visit doesn't count as asked.
(function () {
    if (window.__nswsDiscordInvite || window.top !== window) return;
    window.__nswsDiscordInvite = true;

    const ASKED_KEY = "_nswsDiscordAsked";
    const INVITE = "https://discord.gg/v5xrXSfvtE";
    const INVITE_API = "https://discord.com/api/v10/invites/v5xrXSfvtE?with_counts=true";
    const GUILD_ID = "1519748614681923685";
    const CHECK_TIMEOUT_MS = 8000;
    const MENU_IDLE_MS = 2500;

    const CSS = `
.nsws-dinv{margin:0;padding:0;position:fixed;inset:0;width:100%;height:100%;max-width:none;max-height:none;background-color:rgba(20,20,30,.5);border:none;pointer-events:auto;}
.nsws-dinv::backdrop{background-color:transparent;}
.nsws-dinv>div{position:absolute;left:50%;top:30%;transform:translateX(-50%);margin:0;padding:10px;width:500px;max-width:calc(100% - 20px);box-sizing:border-box;background-color:var(--surface-color,#28346a);text-align:center;}
.nsws-dinv .card{display:flex;align-items:center;gap:14px;margin:0 0 10px 0;padding:12px 14px;background-color:var(--surface-secondary-color,#212b58);text-align:left;color:var(--text-color,#fff);}
.nsws-dinv .card img{flex-shrink:0;width:64px;height:64px;border-radius:50%;}
.nsws-dinv .card img.hidden{display:none;}
.nsws-dinv .name{font-size:28px;line-height:1;}
.nsws-dinv .count{margin-top:6px;font-size:18px;opacity:.75;}
.nsws-dinv .count i{display:inline-block;width:.55em;height:.55em;margin:0 .3em 0 .7em;border-radius:50%;background:#43b581;vertical-align:.05em;}
.nsws-dinv p{margin:0 0 10px 0;padding:10px;background-color:var(--surface-secondary-color,#212b58);font-size:26px;line-height:1.05;color:var(--text-color,#fff);overflow-wrap:break-word;}
.nsws-dinv p small{display:block;margin-top:8px;font-size:18px;opacity:.75;}
.nsws-dinv .row{display:flex;justify-content:space-between;gap:10px;}
.nsws-dinv .button{min-width:140px;margin:0;text-decoration:none;}
`;

    function asked() {
        try {
            return localStorage.getItem(ASKED_KEY) != null;
        } catch {
            return true;
        }
    }

    function markAsked(how) {
        try {
            localStorage.setItem(ASKED_KEY, how + ":" + Date.now());
        } catch {}
    }

    async function reachDiscord() {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), CHECK_TIMEOUT_MS);
        try {
            const res = await fetch(INVITE_API, { cache: "no-store", credentials: "omit", signal: ctl.signal });
            if (!res.ok) return null;
            const data = await res.json();
            return data?.guild?.id === GUILD_ID ? data : null;
        } catch {
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    function menuIdle() {
        if (document.visibilityState !== "visible") return false;
        const menu = document.querySelector(".menu-ui > .main-buttons-container");
        if (!menu || menu.classList.contains("hidden") || !menu.offsetParent) return false;
        // The editor and Custom Tracks cover the menu without hiding it, and a prompt over them takes the keyboard from an editor test.
        return !document.querySelector("dialog[open], .device-preset-ui, #nrc-overlay, #nsws-editor:not(.hidden), .nt-host:not([hidden])");
    }

    function waitForMenu() {
        return new Promise((resolve) => {
            let since = 0;
            const tick = () => {
                if (!menuIdle()) since = 0;
                else if (!since) since = Date.now();
                else if (Date.now() - since >= MENU_IDLE_MS) return resolve();
                setTimeout(tick, 500);
            };
            tick();
        });
    }

    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    function show(invite) {
        if (!document.getElementById("nsws-dinv-style")) {
            const style = el("style");
            style.id = "nsws-dinv-style";
            style.textContent = CSS;
            document.head.appendChild(style);
        }
        const dialog = el("dialog", "nsws-dinv");
        const box = el("div");
        dialog.appendChild(box);

        const card = el("div", "card");
        const guild = invite.guild;
        if (guild.icon) {
            const icon = el("img", "hidden");
            icon.alt = "";
            icon.addEventListener("load", () => icon.classList.remove("hidden"));
            icon.src = "https://cdn.discordapp.com/icons/" + guild.id + "/" + guild.icon + ".png?size=128";
            card.appendChild(icon);
        }
        const info = el("div");
        info.appendChild(el("div", "name", guild.name || "Not So Weekly Shorts"));
        const members = invite.approximate_member_count;
        const online = invite.approximate_presence_count;
        if (members > 0) {
            const count = el("div", "count", members + " members");
            if (online > 0) {
                count.append(el("i"), online + " online");
            }
            info.appendChild(count);
        }
        card.appendChild(info);
        box.appendChild(card);

        const text = el("p", null, "Want to join the Not So Weekly Shorts Discord?");
        text.appendChild(el("small", null, "New weeks, cups and results go there first. Connect Discord under Tags in the Garage to get the DISCORD tag."));
        box.appendChild(text);

        const row = el("div", "row");
        const later = el("button", "button", "No thanks");
        const join = el("a", "button", "Join Discord");
        join.href = INVITE;
        join.target = "_blank";
        join.rel = "noopener";
        row.append(later, join);
        box.appendChild(row);

        let answer = "closed";
        const close = () => {
            markAsked(answer);
            if (dialog.open) dialog.close();
            dialog.remove();
        };
        later.addEventListener("click", () => {
            window.__nswsUIClick?.();
            answer = "no";
            close();
        });
        join.addEventListener("click", () => {
            window.__nswsUIClick?.();
            answer = "joined";
            setTimeout(close, 0);
        });
        dialog.addEventListener("close", close);
        dialog.addEventListener("click", (e) => {
            if (e.target === dialog) close();
        });

        document.body.appendChild(dialog);
        dialog.showModal();
        join.focus();
    }

    async function start() {
        if (asked()) return;
        const invite = await reachDiscord();
        if (!invite || asked()) return;
        await waitForMenu();
        if (asked() || window.__nswsTags?.state?.()?.discord?.inGuild) {
            if (!asked()) markAsked("in-server");
            return;
        }
        show(invite);
    }

    start();
})();
