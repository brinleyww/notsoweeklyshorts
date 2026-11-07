// Clubs tab of the Custom Tracks screen: clubs with members and campaigns of tracks.
(function () {
    "use strict";
    const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;
    const MODES = [["normal", "Normal"], ["rocket", "Rocket League"], ["royale", "Royale"]];
    const MODE_NAME = Object.fromEntries(MODES);
    const ROLE_NAME = { owner: "Owner", admin: "Admin", member: "Member" };
    const MAX_TRACKS = 25;

    const S = {
        container: null,
        view: { type: "home" },
        mine: null,
        mineError: null,
        mineAt: 0,
        clubs: new Map(),
        byCode: new Map(),
        members: new Map(),
        campaigns: new Map(),
        progress: new Map(),
        myId12: null,
        registered: false,
        pending: null,
        drawId: 0
    };

    const T = () => window.__nswsTracks || null;

    function readNick() {
        try {
            const slot = parseInt(localStorage.getItem("polytrack_v5_prod_user_slot") ?? "0", 10);
            const nick = JSON.parse(localStorage.getItem("polytrack_v5_prod_user_" + (slot >= 0 ? slot : 0)))?.nickname;
            return typeof nick === "string" && nick.trim() ? nick.trim() : "Guest";
        } catch {
            return "Guest";
        }
    }

    function user() {
        let u = null;
        try { u = T()?.user?.(); } catch {}
        const token = u?.token || window.__nswsProfileToken?.() || null;
        return { token: /^[0-9a-f]{64}$/.test(token || "") ? token : null, nickname: (u?.nickname || readNick()).slice(0, 24) };
    }

    function needUser() {
        const u = user();
        if (!u.token) throw new Error("Clubs need a game profile. Make one in the game first, then come back.");
        return u;
    }

    async function myId12() {
        const token = user().token;
        if (!token || !crypto?.subtle) return null;
        if (S.myId12?.token === token) return S.myId12.id;
        const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
        const id = Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
        S.myId12 = { token, id };
        return id;
    }

    async function api(path, body) {
        const t = T();
        let j;
        if (t?.api) {
            j = await t.api(path, body, { method: body === undefined ? "GET" : "POST" });
        } else {
            const base = window.__nswsApiBase;
            if (!base) throw new Error("The NSWS server isn't set up on this page.");
            let r;
            try {
                r = await fetch(base + path, body === undefined ? { method: "GET" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
            } catch {
                throw new Error("Couldn't reach the NSWS server. Check your connection and try again.");
            }
            try { j = await r.json(); } catch { j = null; }
            if (!r.ok || !j) throw new Error(j?.error || (r.status === 429 ? "Too many requests. Wait a minute and try again." : "The server couldn't do that right now (" + r.status + ")."));
        }
        if (j?.busy) throw new Error("NSWS is busy right now. Try again in a few minutes.");
        if (j?.error) throw new Error(j.error);
        return j || {};
    }

    function say(text) {
        if (window.__nswsMessageBox?.show) window.__nswsMessageBox.show(text, "Ok", null);
        else modal("Clubs", h("div", "nc-p", text), [{ label: "Ok", primary: true }]);
    }

    function toast(text) {
        try {
            if (T()?.ui?.toast) return T().ui.toast(text);
        } catch {}
        const t = h("div", "nc-toast", text);
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 2600);
    }

    async function copy(text, what) {
        let ok = false;
        try {
            await navigator.clipboard.writeText(text);
            ok = true;
        } catch {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.style.cssText = "position:fixed;left:-9999px;top:0;";
            document.body.appendChild(ta);
            ta.select();
            try { ok = document.execCommand("copy"); } catch {}
            ta.remove();
        }
        toast(ok ? what + " copied" : "Couldn't copy. " + text);
    }

    function h(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = String(text);
        return e;
    }

    // Wraps the click so a slow request can't be sent twice and errors reach the player.
    function btn(label, fn, opts) {
        opts = opts || {};
        let b;
        const run = async (e) => {
            e?.stopPropagation?.();
            if (b.disabled) return;
            b.disabled = true;
            try {
                await fn(e);
            } catch (err) {
                say(err?.message || String(err));
            } finally {
                b.disabled = !!opts.disabled;
            }
        };
        try {
            const made = T()?.ui?.button?.(label, run, { primary: !!opts.primary });
            if (made instanceof HTMLElement) b = made;
        } catch {}
        if (!b) {
            b = h("button", "button", label);
            b.type = "button";
            b.addEventListener("click", run);
        }
        b.classList.add("nc-btn");
        if (opts.primary) b.classList.add("nc-primary");
        if (opts.small) b.classList.add("small");
        if (opts.title) b.title = opts.title;
        if (opts.disabled) b.disabled = true;
        return b;
    }

    function guardKeys(e) {
        for (const ev of ["keydown", "keyup", "keypress"]) {
            e.addEventListener(ev, (k) => {
                if (k.key !== "Escape") k.stopPropagation();
            });
        }
        return e;
    }

    function input(value, max, placeholder) {
        const e = h("input", "nc-in");
        e.type = "text";
        e.value = value || "";
        if (max) e.maxLength = max;
        if (placeholder) e.placeholder = placeholder;
        e.spellcheck = false;
        return guardKeys(e);
    }

    function textarea(value, max, placeholder) {
        const e = h("textarea", "nc-in");
        e.value = value || "";
        if (max) e.maxLength = max;
        if (placeholder) e.placeholder = placeholder;
        e.spellcheck = false;
        return guardKeys(e);
    }

    function row(label, control, meta) {
        const r = h("div", "nc-row");
        const m = h("div", "nc-main");
        m.appendChild(h("div", "nc-label", label));
        if (meta) m.appendChild(h("div", "nc-meta", meta));
        r.appendChild(m);
        const c = h("div", "nc-ctl");
        for (const x of [].concat(control || [])) c.appendChild(x);
        r.appendChild(c);
        return r;
    }

    function sec(text) {
        return h("div", "nc-sec", text);
    }

    function chip(text, cls) {
        return h("span", "nc-chip" + (cls ? " " + cls : ""), text);
    }

    function when(t) {
        t = Number(t);
        if (!t) return "";
        if (t < 1e12) t *= 1000;
        try { return new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }); } catch { return ""; }
    }

    function plural(n, one, many) {
        return n + " " + (n === 1 ? one : many || one + "s");
    }

    function clubLink(code) {
        return (window.__nswsShareBase || location.origin + location.pathname.replace(/index\.html$/, "")) + "?club=" + code;
    }

    function normCode(text) {
        const s = String(text || "").trim();
        const m = s.match(/[?&]club=([A-Za-z0-9]{6})/);
        const c = (m ? m[1] : s.replace(/[\s-]/g, "")).toUpperCase();
        return CODE_RE.test(c) ? c : null;
    }

    function isBE(code) {
        return typeof code === "string" && code.startsWith("PolyTrackBE");
    }

    function modal(title, body, actions, opts) {
        const root = h("div", "nc-modal");
        const box = h("div", "nc-box");
        box.tabIndex = -1;
        box.appendChild(h("div", "nc-box-h", title));
        const b = h("div", "nc-box-b");
        if (body) b.appendChild(body);
        box.appendChild(b);
        const f = h("div", "nc-box-f");
        let closed = false;
        const close = () => {
            if (closed) return;
            closed = true;
            root.remove();
            opts?.onClose?.();
        };
        for (const a of actions || []) {
            f.appendChild(btn(a.label, async () => {
                const keep = a.onClick ? await a.onClick() : undefined;
                if (keep !== false) close();
            }, { primary: a.primary }));
        }
        box.appendChild(f);
        root.appendChild(box);
        for (const ev of ["touchstart", "touchmove", "touchend", "touchcancel", "pointerdown", "mousedown", "wheel", "keyup", "keypress"]) {
            root.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
        }
        root.addEventListener("keydown", (e) => {
            e.stopPropagation();
            if (e.key === "Escape") close();
        });
        root.addEventListener("click", (e) => {
            if (e.target === root) close();
        });
        document.body.appendChild(root);
        (box.querySelector("input,textarea") || box).focus();
        return close;
    }

    function confirmBox(title, text, okLabel) {
        return new Promise((resolve) => {
            let answer = false;
            modal(title, h("div", "nc-p", text), [
                { label: "Cancel" },
                { label: okLabel || "Ok", primary: true, onClick: () => { answer = true; } }
            ], { onClose: () => resolve(answer) });
        });
    }

    function go(view) {
        S.view = view;
        draw();
    }

    function draw() {
        const c = S.container;
        if (!c) return;
        injectCss();
        const id = ++S.drawId;
        const alive = () => id === S.drawId && S.container === c;
        c.textContent = "";
        const root = h("div", "nc");
        root.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
        c.appendChild(root);
        const v = S.view;
        const fn = { join: drawJoin, club: drawClub, campaign: drawCampaign, edit: drawEdit }[v.type] || drawHome;
        try {
            fn(root, v, alive);
        } catch (err) {
            root.appendChild(h("div", "nc-err", err?.message || String(err)));
        }
    }

    // fetcher must fill the cache the view reads, or the view loads forever.
    function loading(root, alive, fetcher, text) {
        const box = h("div", "nc-empty", text || "Loading...");
        root.appendChild(box);
        Promise.resolve().then(fetcher).then(() => {
            if (alive()) draw();
        }, (err) => {
            if (!alive()) return;
            box.textContent = "";
            box.className = "nc-empty";
            box.appendChild(h("div", "nc-err", err?.message || String(err)));
            box.appendChild(btn("Try again", () => draw(), { small: true }));
        });
        return box;
    }

    function top(root, title, back, extra) {
        const t = h("div", "nc-top");
        if (back) t.appendChild(btn("Back", back, { small: true }));
        const name = h("div", "nc-title");
        name.appendChild(document.createTextNode(title));
        if (extra) name.appendChild(extra);
        t.appendChild(name);
        root.appendChild(t);
        return t;
    }

    async function fetchMine() {
        const u = user();
        S.mineAt = Date.now();
        if (!u.token) {
            S.mine = [];
            S.mineError = "Clubs need a game profile. Make one in the game first.";
            return;
        }
        try {
            const j = await api("nsws/tracks/club/mine", { token: u.token });
            S.mine = Array.isArray(j.clubs) ? j.clubs : [];
            S.mineError = null;
        } catch (err) {
            S.mine = S.mine || [];
            S.mineError = err?.message || String(err);
        }
    }

    function mineOf(clubId) {
        return (S.mine || []).find((c) => c.id === clubId) || null;
    }

    function keepClub(club) {
        if (!club?.id) return null;
        S.clubs.set(club.id, club);
        if (club.code) S.byCode.set(club.code, club.id);
        return club;
    }

    async function fetchClubByCode(code) {
        const j = await api("nsws/tracks/club/" + encodeURIComponent(code));
        if (!keepClub(j.club)) throw new Error("No club has the code " + code + ".");
        S.byCode.set(code, j.club.id);
        return j.club;
    }

    function drawHome(root, v, alive) {
        top(root, "Clubs");
        root.appendChild(h("div", "nc-sub", "Clubs share campaigns of tracks. Join one with a code or link, or start your own."));

        root.appendChild(sec("Join a club"));
        const code = input(v.typed || "", 200, "Club code or link");
        code.addEventListener("input", () => { v.typed = code.value; });
        const join = btn("Join", () => {
            const c = normCode(code.value);
            if (!c) throw new Error("Club codes are 6 letters and numbers, like K7QPZ3. You can also paste a club link.");
            go({ type: "join", code: c });
        }, { primary: true });
        code.addEventListener("keydown", (e) => {
            if (e.key === "Enter") join.click();
        });
        root.appendChild(row("Code or link", [code, join]));

        root.appendChild(sec("My clubs"));
        if (S.mine === null) {
            loading(root, alive, fetchMine);
        } else {
            if (S.mineError) root.appendChild(h("div", "nc-err nc-pad", S.mineError));
            if (!S.mine.length && !S.mineError) root.appendChild(h("div", "nc-empty", "You aren't in any clubs yet."));
            for (const c of S.mine) {
                const r = row("", btn("Open", () => openClub(c), { small: true }),
                    [ROLE_NAME[c.role] || "Member", plural(c.memberCount || 0, "member"), plural(c.campaignCount || 0, "campaign")].join("  /  "));
                const label = r.querySelector(".nc-label");
                label.textContent = c.name || "Club";
                if (c.tag) label.appendChild(h("span", "nc-tag", " [" + c.tag + "]"));
                r.classList.add("click");
                r.addEventListener("click", () => openClub(c));
                root.appendChild(r);
            }
        }

        root.appendChild(sec("Start a club"));
        root.appendChild(row("Create a club", btn("Create club", createDialog), "You can own up to 3 clubs."));
    }

    function openClub(c) {
        S.members.delete(c.id);
        go({ type: "club", clubId: c.id, code: c.code, tab: "campaigns", fetched: false });
    }

    function createDialog() {
        needUser();
        const body = h("div");
        const name = input("", 32, "Club name");
        const tag = input("", 5, "TAG");
        const desc = textarea("", 300, "What's the club about? (optional)");
        desc.rows = 4;
        body.appendChild(row("Name", name));
        body.appendChild(row("Tag", tag, "Up to 5 letters or numbers"));
        body.appendChild(h("div", "nc-label nc-pad", "Description"));
        body.appendChild(desc);
        modal("Create a club", body, [
            { label: "Cancel" },
            {
                label: "Create",
                primary: true,
                onClick: async () => {
                    const u = needUser();
                    const n = name.value.trim();
                    const t = tag.value.trim();
                    if (!n) throw new Error("Give the club a name.");
                    if (t && !/^[A-Za-z0-9]{1,5}$/.test(t)) throw new Error("The tag can only use letters and numbers (up to 5).");
                    const j = await api("nsws/tracks/club/create", { token: u.token, nickname: u.nickname, name: n, tag: t, description: desc.value.trim() });
                    const club = keepClub(j.club);
                    await fetchMine();
                    if (club) go({ type: "club", clubId: club.id, code: club.code, tab: "campaigns", fetched: true });
                    else draw();
                    toast("Club created");
                }
            }
        ]);
    }

    function drawJoin(root, v, alive) {
        top(root, "Join a club", () => go({ type: "home" }));
        const id = S.byCode.get(v.code);
        const club = id ? S.clubs.get(id) : null;
        if (!v.fetched || !club) {
            v.fetched = true;
            const jobs = [fetchClubByCode(v.code)];
            if (S.mine === null) jobs.push(fetchMine());
            loading(root, alive, () => Promise.all(jobs), "Looking up club " + v.code + "...");
            return;
        }
        clubHeader(root, club);
        const member = mineOf(club.id);
        const camps = club.campaigns || [];
        root.appendChild(sec("Campaigns"));
        if (!camps.length) root.appendChild(h("div", "nc-empty", "No campaigns yet."));
        for (const c of camps) root.appendChild(row(c.name || "Campaign", null, plural((c.tracks || []).length, "track")));
        root.appendChild(sec(member ? "You're in this club" : "Join"));
        if (member) {
            root.appendChild(row("Open the club page", btn("Open club", () => openClub(club), { primary: true })));
        } else {
            root.appendChild(row("Join " + (club.name || "this club"), btn("Join club", async () => {
                const u = needUser();
                const j = await api("nsws/tracks/club/join", { token: u.token, nickname: u.nickname, code: v.code });
                const joined = keepClub(j.club) || club;
                await fetchMine();
                go({ type: "club", clubId: joined.id, code: joined.code, tab: "campaigns", fetched: true });
                toast("Joined " + (joined.name || "the club"));
            }, { primary: true }), "You can be in up to 20 clubs."));
        }
    }

    function clubHeader(root, club, back) {
        const tag = club.tag ? h("span", "nc-tag", " [" + club.tag + "]") : null;
        top(root, club.name || "Club", back, tag);
        const meta = [plural(club.memberCount || 0, "member")];
        if (club.ownerName) meta.push("Owner: " + club.ownerName);
        if (club.created) meta.push("Since " + when(club.created));
        root.appendChild(h("div", "nc-sub", meta.join("  /  ")));
        if (club.description) root.appendChild(h("div", "nc-desc", club.description));
    }

    function drawClub(root, v, alive) {
        const club = S.clubs.get(v.clubId);
        if (!v.fetched || !club) {
            v.fetched = true;
            const jobs = [v.code ? fetchClubByCode(v.code).then((c) => { v.clubId = c.id; }) : Promise.reject(new Error("That club can't be found."))];
            if (S.mine === null) jobs.push(fetchMine());
            if (club) {
                Promise.all(jobs).then(() => { if (alive()) draw(); }, () => {});
            } else {
                top(root, "Club", () => go({ type: "home" }));
                loading(root, alive, () => Promise.all(jobs));
                return;
            }
        }
        const me = mineOf(club.id);
        const role = me?.role || null;
        clubHeader(root, club, () => go({ type: "home" }));
        if (!role) {
            root.appendChild(row("You aren't in this club", btn("Join club", () => go({ type: "join", code: club.code, fetched: false }), { primary: true })));
        }

        root.appendChild(sec("Invite"));
        const codeText = h("span", "nc-code", club.code || "");
        root.appendChild(row("Club code", [codeText, btn("Copy code", () => copy(club.code, "Code"), { small: true }), btn("Copy link", () => copy(clubLink(club.code), "Link"), { small: true })], "Friends join with the code or by opening the link."));

        const tabs = [["campaigns", "Campaigns"], ["members", "Members"]];
        if (role === "owner") tabs.push(["settings", "Settings"]);
        if (!tabs.some((t) => t[0] === v.tab)) v.tab = "campaigns";
        const bar = h("div", "nc-tabs");
        for (const [id, label] of tabs) {
            const t = h("button", "nc-tab" + (v.tab === id ? " on" : ""), label);
            t.type = "button";
            t.addEventListener("click", () => {
                v.tab = id;
                draw();
            });
            bar.appendChild(t);
        }
        root.appendChild(bar);
        const body = h("div", "nc-tabbody");
        root.appendChild(body);
        if (v.tab === "members") drawMembers(body, club, role, alive);
        else if (v.tab === "settings") drawSettings(body, club);
        else drawCampaignList(body, club, role);
    }

    function drawCampaignList(root, club, role) {
        const canEdit = role === "owner" || role === "admin";
        const camps = club.campaigns || [];
        if (canEdit) {
            root.appendChild(row("New campaign", btn("New campaign", () => {
                if (camps.length >= 20) throw new Error("A club can have up to 20 campaigns. Delete one first.");
                go({ type: "edit", clubId: club.id, campaignId: null, draft: { name: "", tracks: [] }, dirty: false });
            }, { primary: role !== null }), "Up to " + MAX_TRACKS + " tracks each, 20 campaigns per club."));
        }
        if (!camps.length) {
            root.appendChild(h("div", "nc-empty", canEdit ? "No campaigns yet. Make the first one with New campaign." : "No campaigns yet."));
            return;
        }
        for (const c of camps) {
            const n = (c.tracks || []).length;
            const open = () => go({ type: "campaign", clubId: club.id, campaignId: c.id, fetched: false });
            const r = row(c.name || "Campaign", btn("Open", open, { small: true }), plural(n, "track") + (c.updated ? "  /  Updated " + when(c.updated) : ""));
            r.classList.add("click");
            r.addEventListener("click", open);
            root.appendChild(r);
        }
    }

    function drawMembers(root, club, role, alive) {
        const list = S.members.get(club.id);
        if (!role) {
            root.appendChild(h("div", "nc-empty", "Join the club to see its members."));
            return;
        }
        if (!list) {
            loading(root, alive, async () => {
                const u = needUser();
                const [j] = await Promise.all([api("nsws/tracks/club/members", { token: u.token, clubId: club.id }), myId12().catch(() => null)]);
                S.members.set(club.id, Array.isArray(j.members) ? j.members : []);
            });
            return;
        }
        const me = S.myId12?.id || null;
        const order = { owner: 0, admin: 1, member: 2 };
        const sorted = list.slice().sort((a, b) => (order[a.role] ?? 3) - (order[b.role] ?? 3) || (a.joined || 0) - (b.joined || 0));
        for (const m of sorted) {
            const isMe = me && m.userId === me;
            const ctl = [chip(ROLE_NAME[m.role] || "Member", m.role === "member" ? "" : "nc-chip-strong")];
            if (role === "owner" && !isMe && m.role !== "owner") {
                if (m.role === "member") ctl.push(btn("Make admin", () => setRole(club, m, "admin"), { small: true }));
                else ctl.push(btn("Make member", () => setRole(club, m, "member"), { small: true }));
                ctl.push(btn("Make owner", () => setRole(club, m, "owner"), { small: true }));
                ctl.push(btn("Kick", () => setRole(club, m, "kick"), { small: true }));
            }
            root.appendChild(row((m.name || "Player") + (isMe ? " (you)" : ""), ctl, m.joined ? "Joined " + when(m.joined) : ""));
        }
        if (role !== "owner") {
            root.appendChild(sec("Leave"));
            root.appendChild(row("Leave this club", btn("Leave club", async () => {
                if (!(await confirmBox("Leave club", "Leave " + (club.name || "this club") + "? You can join again with the code.", "Leave"))) return;
                const u = needUser();
                await api("nsws/tracks/club/leave", { token: u.token, clubId: club.id });
                await fetchMine();
                go({ type: "home" });
                toast("Left the club");
            })));
        } else {
            root.appendChild(h("div", "nc-note", "Owners can't leave. Make someone else the owner first, or delete the club in Settings."));
        }
    }

    async function setRole(club, m, role) {
        const who = m.name || "this player";
        const asks = {
            owner: ["Make owner", "Make " + who + " the owner of " + (club.name || "the club") + "? You'll become an admin and can't undo this yourself.", "Make owner"],
            kick: ["Kick", "Remove " + who + " from the club? They can join again with the code unless you change it.", "Kick"]
        };
        if (asks[role] && !(await confirmBox(...asks[role]))) return;
        const u = needUser();
        await api("nsws/tracks/club/role", { token: u.token, clubId: club.id, member: m.userId, role });
        S.members.delete(club.id);
        if (role === "owner" || role === "kick") {
            await fetchMine();
            try { await fetchClubByCode(club.code); } catch {}
        }
        draw();
    }

    function drawSettings(root, club) {
        root.appendChild(sec("Club"));
        const name = input(club.name, 32);
        const tag = input(club.tag, 5);
        const desc = textarea(club.description, 300);
        desc.rows = 4;
        root.appendChild(row("Name", name));
        root.appendChild(row("Tag", tag, "Up to 5 letters or numbers"));
        root.appendChild(h("div", "nc-label nc-pad", "Description"));
        root.appendChild(desc);
        const save = btn("Save", async () => {
            const n = name.value.trim();
            const t = tag.value.trim();
            if (!n) throw new Error("The club needs a name.");
            if (t && !/^[A-Za-z0-9]{1,5}$/.test(t)) throw new Error("The tag can only use letters and numbers (up to 5).");
            await updateClub(club, { name: n, tag: t, description: desc.value.trim() });
            toast("Club saved");
        }, { primary: true });
        const sr = h("div", "nc-actions");
        sr.appendChild(save);
        root.appendChild(sr);

        root.appendChild(sec("Invite code"));
        root.appendChild(row("New invite code", btn("New code", async () => {
            if (!(await confirmBox("New invite code", "Make a new code? The old code and every old club link stop working. Members stay in the club.", "New code"))) return;
            await updateClub(club, { newCode: true });
            toast("New code: " + (S.clubs.get(club.id)?.code || ""));
        }), "Use this if the code got shared somewhere it shouldn't."));

        root.appendChild(sec("Delete"));
        root.appendChild(row("Delete this club", btn("Delete club", async () => {
            if (!(await confirmBox("Delete club", "Delete " + (club.name || "this club") + " with all its campaigns and members? This can't be undone. Tracks saved in My Tracks stay.", "Delete"))) return;
            const u = needUser();
            await api("nsws/tracks/club/delete", { token: u.token, clubId: club.id });
            S.clubs.delete(club.id);
            S.byCode.delete(club.code);
            await fetchMine();
            go({ type: "home" });
            toast("Club deleted");
        }), "Removes the club for everyone."));
    }

    async function updateClub(club, fields) {
        const u = needUser();
        const j = await api("nsws/tracks/club/update", Object.assign({ token: u.token, clubId: club.id }, fields));
        await fetchMine();
        let fresh = keepClub(j.club);
        if (!fresh) {
            const code = mineOf(club.id)?.code || club.code;
            try { fresh = await fetchClubByCode(code); } catch {}
        }
        if (fresh && club.code && fresh.code !== club.code) S.byCode.delete(club.code);
        if (S.view.type === "club" && S.view.clubId === club.id) S.view.code = (fresh || club).code;
        draw();
    }

    function campKey(clubId, campaignId) {
        return clubId + "/" + campaignId;
    }

    async function fetchCampaign(clubId, campaignId) {
        const j = await api("nsws/tracks/campaign/get", { token: user().token, clubId, campaignId, code: S.clubs.get(clubId)?.code || null });
        if (!j.campaign) throw new Error("That campaign doesn't exist any more.");
        S.campaigns.set(campKey(clubId, campaignId), j.campaign);
        return j.campaign;
    }

    function trackRow(i, t, ctl, last) {
        const r = h("div", "nc-row" + (last ? " nc-last" : ""));
        r.appendChild(h("div", "nc-num", String(i + 1)));
        const m = h("div", "nc-main");
        m.appendChild(h("div", "nc-label", t.name || "Track " + (i + 1)));
        m.appendChild(h("div", "nc-meta", t.author ? "by " + t.author : ""));
        r.appendChild(m);
        const c = h("div", "nc-ctl");
        if (t.mode && t.mode !== "normal") c.appendChild(chip(MODE_NAME[t.mode] || t.mode, "nc-chip-strong"));
        if (isBE(t.code)) {
            const be = chip("Better Editor");
            be.title = "Uses Better Editor blocks, which download the first time you play one";
            c.appendChild(be);
        }
        for (const x of [].concat(ctl || [])) c.appendChild(x);
        r.appendChild(c);
        return r;
    }

    async function playTrack(key, list, i) {
        const t = list[i];
        if (!t?.code) throw new Error("That track couldn't be loaded.");
        const tr = T();
        if (!tr?.play) throw new Error("Custom Tracks didn't load, so tracks can't be played right now. Reload the page.");
        S.progress.set(key, i);
        const ok = await tr.play(t.code, { mode: t.mode || "normal" });
        if (ok === false) {
            if (S.container) draw();
        }
    }

    function drawCampaign(root, v, alive) {
        const club = S.clubs.get(v.clubId);
        const key = campKey(v.clubId, v.campaignId);
        const preview = club?.campaigns?.find((c) => c.id === v.campaignId) || null;
        const full = S.campaigns.get(key);
        const back = () => go({ type: "club", clubId: v.clubId, code: club?.code, tab: "campaigns", fetched: true });
        const camp = full || preview;
        top(root, camp?.name || "Campaign", back);
        const role = mineOf(v.clubId)?.role || null;
        const canEdit = role === "owner" || role === "admin";
        if (!v.fetched) {
            v.fetched = true;
            const job = fetchCampaign(v.clubId, v.campaignId);
            if (full) job.then(() => { if (alive()) draw(); }, () => {});
            else {
                if (club) root.appendChild(h("div", "nc-sub", (club.name || "Club") + (club.tag ? " [" + club.tag + "]" : "")));
                loading(root, alive, () => job);
                return;
            }
        }
        if (!full) {
            loading(root, alive, () => fetchCampaign(v.clubId, v.campaignId));
            return;
        }
        const tracks = full.tracks || [];
        const meta = [plural(tracks.length, "track")];
        if (club) meta.unshift((club.name || "Club") + (club.tag ? " [" + club.tag + "]" : ""));
        if (full.updated) meta.push("Updated " + when(full.updated));
        root.appendChild(h("div", "nc-sub", meta.join("  /  ")));

        const last = S.progress.has(key) ? S.progress.get(key) : -1;
        const next = last >= 0 && last + 1 < tracks.length ? last + 1 : 0;
        const acts = h("div", "nc-actions");
        acts.appendChild(btn(next > 0 ? "Play next (" + (next + 1) + ")" : "Play campaign", () => playTrack(key, tracks, next), { primary: true, disabled: !tracks.length }));
        acts.appendChild(btn("Save all to My Tracks", async () => {
            const tr = T();
            if (!tr?.addMany) throw new Error("Custom Tracks didn't load. Reload the page and try again.");
            const r = await tr.addMany(tracks.map((t) => ({ code: t.code, mode: t.mode || "normal" })), { source: "club:" + (club?.code || "") });
            const bits = [];
            if (r?.added) bits.push(r.added + " added");
            if (r?.updated) bits.push(r.updated + " updated");
            if (r?.failed?.length) bits.push(r.failed.length + " failed");
            toast(bits.length ? "My Tracks: " + bits.join(", ") : "Already in My Tracks");
        }, { disabled: !tracks.length }));
        acts.appendChild(btn("Share", async () => {
            const tr = T();
            const items = tracks.map((t) => ({ code: t.code, mode: t.mode || "normal" }));
            if (tr?.openShare) return tr.openShare(items, full.name);
            if (!tr?.shareLink) throw new Error("Custom Tracks didn't load. Reload the page and try again.");
            const r = await tr.shareLink(items, full.name);
            await copy(r.url, "Link");
        }, { disabled: !tracks.length }));
        if (canEdit) {
            acts.appendChild(btn("Edit", () => go({
                type: "edit", clubId: v.clubId, campaignId: v.campaignId, dirty: false,
                draft: { name: full.name || "", tracks: tracks.map((t) => ({ code: t.code, mode: t.mode || "normal", name: t.name, author: t.author, trackId: t.trackId })) }
            })));
            acts.appendChild(btn("Delete", async () => {
                if (!(await confirmBox("Delete campaign", "Delete " + (full.name || "this campaign") + " for everyone in the club? This can't be undone.", "Delete"))) return;
                const u = needUser();
                await api("nsws/tracks/campaign/delete", { token: u.token, clubId: v.clubId, campaignId: v.campaignId });
                S.campaigns.delete(key);
                if (club?.campaigns) club.campaigns = club.campaigns.filter((c) => c.id !== v.campaignId);
                go({ type: "club", clubId: v.clubId, code: club?.code, tab: "campaigns", fetched: false });
                toast("Campaign deleted");
            }));
        }
        root.appendChild(acts);

        root.appendChild(sec("Tracks"));
        if (!tracks.length) root.appendChild(h("div", "nc-empty", "This campaign has no tracks yet."));
        tracks.forEach((t, i) => root.appendChild(trackRow(i, t, btn("Play", () => playTrack(key, tracks, i), { small: true }), i === last)));
        if (last >= 0) root.appendChild(h("div", "nc-note", "After a track, come back here and press Play next."));
    }

    async function trackInfo(code, mode) {
        const tr = T();
        let p = null;
        try {
            p = tr?.parseAsync ? await tr.parseAsync(code) : tr?.parse?.(code);
        } catch {}
        if (!p) {
            if (!/^PolyTrack/.test(code)) return null;
            return { code, mode: mode || "normal", name: "", author: "", trackId: null };
        }
        if (!p.ok) return null;
        return { code: p.code || code, mode: mode || "normal", name: p.name || "", author: p.author || "", trackId: p.trackId || null };
    }

    function drawEdit(root, v) {
        const d = v.draft;
        const back = async () => {
            if (v.dirty && !(await confirmBox("Discard changes", "Leave without saving? Your changes to this campaign will be lost.", "Discard"))) return;
            if (v.campaignId) go({ type: "campaign", clubId: v.clubId, campaignId: v.campaignId, fetched: true });
            else go({ type: "club", clubId: v.clubId, code: S.clubs.get(v.clubId)?.code, tab: "campaigns", fetched: true });
        };
        top(root, v.campaignId ? "Edit campaign" : "New campaign", back);
        const changed = () => {
            v.dirty = true;
            draw();
        };

        root.appendChild(sec("Campaign"));
        const name = input(d.name, 32, "Campaign name");
        name.addEventListener("input", () => {
            d.name = name.value;
            v.dirty = true;
        });
        root.appendChild(row("Name", name));

        root.appendChild(sec("Tracks (" + d.tracks.length + " of " + MAX_TRACKS + ")"));
        const add = h("div", "nc-actions");
        add.appendChild(btn("Add from My Tracks", async () => {
            const tr = T();
            if (!tr?.pick) throw new Error("Custom Tracks didn't load. Reload the page and try again.");
            const picked = await tr.pick({ multi: true });
            if (!picked?.length) return;
            const r = addTracks(d, picked.map((t) => ({ code: t.code, mode: t.mode || "normal", name: t.name || "", author: t.author || "", trackId: t.trackId || null })));
            reportAdd(r);
            if (r.added) changed();
        }, { disabled: d.tracks.length >= MAX_TRACKS }));
        add.appendChild(btn("Paste codes", () => pasteDialog(d, changed), { disabled: d.tracks.length >= MAX_TRACKS }));
        root.appendChild(add);

        if (!d.tracks.length) root.appendChild(h("div", "nc-empty", "No tracks yet. Add some from My Tracks or paste track codes, a pack code or an NSWS track link."));
        d.tracks.forEach((t, i) => {
            const sel = h("select", "nc-in nc-sel");
            for (const [val, label] of MODES) {
                const o = h("option", null, label);
                o.value = val;
                sel.appendChild(o);
            }
            sel.value = MODE_NAME[t.mode] ? t.mode : "normal";
            guardKeys(sel);
            sel.addEventListener("change", () => {
                t.mode = sel.value;
                changed();
            });
            const move = (to) => {
                const [x] = d.tracks.splice(i, 1);
                d.tracks.splice(to, 0, x);
                changed();
            };
            const ctl = [
                sel,
                btn("\u25B2", () => move(i - 1), { small: true, disabled: i === 0, title: "Move up" }),
                btn("\u25BC", () => move(i + 1), { small: true, disabled: i === d.tracks.length - 1, title: "Move down" }),
                btn("Remove", () => {
                    d.tracks.splice(i, 1);
                    changed();
                }, { small: true })
            ];
            const r = trackRow(i, Object.assign({}, t, { mode: "normal" }), ctl);
            root.appendChild(r);
        });
        if (d.tracks.some((t) => isBE(t.code))) root.appendChild(h("div", "nc-note", "Better Editor tracks use new blocks. They download the first time a player plays one (about 60 MB), then they race like any other track."));
        if (d.tracks.some((t) => t.mode === "royale")) root.appendChild(h("div", "nc-note", "Royale: each checkpoint number has two gates. After crossing one, a reset puts you at the other gate of that number."));

        const foot = h("div", "nc-actions nc-foot");
        foot.appendChild(btn("Cancel", back));
        foot.appendChild(btn(v.campaignId ? "Save campaign" : "Create campaign", async () => {
            const u = needUser();
            const n = (d.name || "").trim();
            if (!n) throw new Error("Give the campaign a name.");
            if (!d.tracks.length) throw new Error("Add at least one track.");
            const body = {
                token: u.token,
                clubId: v.clubId,
                name: n,
                tracks: d.tracks.map((t) => ({ code: t.code, mode: t.mode || "normal", name: (t.name || "").slice(0, 64), author: (t.author || "").slice(0, 64), trackId: t.trackId || null }))
            };
            if (v.campaignId) body.campaignId = v.campaignId;
            const j = await api("nsws/tracks/campaign/save", body);
            const c = j.campaign || {};
            const id = c.id || v.campaignId;
            if (!id) throw new Error("The campaign was saved but the server didn't say where. Reopen the club.");
            const saved = Object.assign({ id, name: n, updated: Date.now() }, c);
            if (!Array.isArray(saved.tracks) || saved.tracks.some((t) => !t.code)) saved.tracks = body.tracks;
            S.campaigns.set(campKey(v.clubId, id), saved);
            const club = S.clubs.get(v.clubId);
            if (club) {
                const lite = { id, name: saved.name, updated: saved.updated, tracks: saved.tracks.map((t) => ({ name: t.name, author: t.author, mode: t.mode, trackId: t.trackId })) };
                const list = (club.campaigns || []).filter((x) => x.id !== id);
                const at = (club.campaigns || []).findIndex((x) => x.id === id);
                list.splice(at >= 0 ? at : list.length, 0, lite);
                club.campaigns = list;
            }
            v.dirty = false;
            go({ type: "campaign", clubId: v.clubId, campaignId: id, fetched: true });
            toast(v.campaignId ? "Campaign saved" : "Campaign created");
        }, { primary: true }));
        root.appendChild(foot);
    }

    function addTracks(d, items) {
        let added = 0, dup = 0, full = 0;
        for (const t of items) {
            if (!t?.code) continue;
            if (d.tracks.some((x) => x.code === t.code || (t.trackId && x.trackId === t.trackId))) {
                dup++;
                continue;
            }
            if (d.tracks.length >= MAX_TRACKS) {
                full++;
                continue;
            }
            d.tracks.push(t);
            added++;
        }
        return { added, dup, full };
    }

    function reportAdd(r, failed) {
        const bits = [];
        bits.push(plural(r.added, "track") + " added");
        if (r.dup) bits.push(r.dup + " already in the campaign");
        if (r.full) bits.push(r.full + " left out (" + MAX_TRACKS + " max)");
        if (failed) bits.push(failed + " couldn't be read");
        if (r.full || failed) say(bits.join(", ") + ".");
        else toast(bits.join(", "));
    }

    function pasteDialog(d, changed) {
        const body = h("div");
        body.appendChild(h("div", "nc-p", "Paste track codes (one per line), a pack code or an NSWS track link."));
        const ta = textarea("", 0, "PolyTrack2...");
        ta.rows = 7;
        body.appendChild(ta);
        modal("Paste codes", body, [
            { label: "Cancel" },
            {
                label: "Add",
                primary: true,
                onClick: async () => {
                    const text = ta.value.trim();
                    if (!text) throw new Error("Paste at least one code first.");
                    const tr = T();
                    let res;
                    if (tr?.importText) res = await tr.importText(text);
                    else res = { tracks: text.split(/\s+/).filter((s) => /^PolyTrack/.test(s)).map((code) => ({ code, mode: "normal" })) };
                    const list = res?.tracks || [];
                    if (!list.length) {
                        if (res?.club) throw new Error("That's a club code, not a track. Paste track codes or a track link.");
                        throw new Error("No track codes found in that text.");
                    }
                    const items = [];
                    let failed = 0;
                    for (const t of list) {
                        const info = await trackInfo(t.code, t.mode);
                        if (info) items.push(info);
                        else failed++;
                    }
                    const r = addTracks(d, items);
                    reportAdd(r, failed);
                    if (r.added) changed();
                }
            }
        ]);
    }

    let cssDone = false;
    function injectCss() {
        if (cssDone) return;
        cssDone = true;
        const css = `
.nc{color:var(--text-color,#fff);text-align:left;padding:2px 2px 18px;font-size:18px;}
.nc *{box-sizing:border-box;}
.nc-top{display:flex;align-items:center;gap:12px;margin:2px 0 4px;}
.nc-title{flex:1;min-width:0;font-size:30px;overflow-wrap:anywhere;}
.nc-tag{opacity:.65;}
.nc-sub{opacity:.65;font-size:16px;margin:2px 0;}
.nc-desc{white-space:pre-wrap;overflow-wrap:anywhere;margin:10px 0 2px;font-size:17px;opacity:.9;max-width:760px;}
.nc-sec{font-style:italic;opacity:.6;font-size:15px;border-bottom:1px solid #fff;margin:22px 0 2px;padding:0 2px 3px;}
.nc-row{display:flex;align-items:center;gap:10px;padding:7px 4px;min-height:48px;border-bottom:1px solid rgba(255,255,255,.1);}
.nc-row.click{cursor:pointer;}
.nc-row.click:hover{background:rgba(255,255,255,.04);}
.nc-row.nc-last{box-shadow:inset 3px 0 0 #7272c2;}
.nc-main{flex:1;min-width:0;}
.nc-label{font-size:19px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.nc-meta{font-size:14px;opacity:.6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.nc-ctl{display:flex;align-items:center;justify-content:flex-end;gap:6px;flex-wrap:wrap;}
.nc-num{flex:none;width:34px;text-align:center;font-size:21px;opacity:.7;}
.nc-chip{font-size:13px;padding:2px 8px;border:1px solid rgba(255,255,255,.3);white-space:nowrap;opacity:.8;}
.nc-chip-strong{border-color:#8f8ff0;opacity:1;}
.nc-code{font-size:24px;letter-spacing:2px;margin-right:6px;user-select:all;}
.nc-actions{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0 4px;}
.nc-foot{justify-content:flex-end;margin-top:18px;}
.nc-tabs{display:flex;gap:2px;margin-top:20px;border-bottom:1px solid rgba(255,255,255,.2);}
.nc-tab{background:none;border:0;border-bottom:3px solid transparent;color:inherit;font:inherit;font-size:19px;padding:8px 16px 6px;opacity:.6;cursor:pointer;}
.nc-tab:hover{opacity:.9;}
.nc-tab.on{opacity:1;border-bottom-color:#7272c2;}
.nc-tabbody{padding-top:4px;}
.nc-empty{opacity:.6;padding:14px 4px;}
.nc-empty .button{margin-top:8px;}
.nc-note{opacity:.6;font-size:15px;padding:10px 4px 0;}
.nc-pad{padding:10px 4px 4px;}
.nc-p{margin:0 0 10px;line-height:1.35;overflow-wrap:anywhere;}
.nc-err{color:#ff9a9a;overflow-wrap:anywhere;}
.nc .button.nc-btn,.nc-box .button.nc-btn{margin:0;font-size:18px;padding:6px 16px;}
.nc .button.nc-btn.small{font-size:15px;padding:4px 11px;}
.button.nc-primary{box-shadow:inset 0 -3px 0 #7272c2;}
.nc-in{background:#192042;color:#fff;border:1px solid #3b477f;font:inherit;font-size:17px;padding:6px 9px;outline:none;border-radius:0;}
.nc-in:focus{border-color:#8f8ff0;}
.nc input.nc-in{width:min(280px,52vw);}
.nc textarea.nc-in,.nc-box textarea.nc-in{display:block;width:100%;resize:vertical;min-height:70px;}
.nc-box input.nc-in{width:min(260px,50vw);}
.nc-sel{padding:4px 6px;font-size:15px;}
.nc-modal{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.55);touch-action:auto;}
.nc-box{display:flex;flex-direction:column;width:min(560px,100%);max-height:calc(100vh - 32px);background:var(--surface-color,#28346a);color:var(--text-color,#fff);clip-path:polygon(0 0,100% 0,calc(100% - 14px) 100%,0 100%);outline:none;font-size:18px;text-align:left;}
.nc-box-h{padding:12px 18px;font-size:24px;background:#212b58;}
.nc-box-b{flex:1;overflow:auto;padding:12px 18px;}
.nc-box-b .nc-row{padding-left:0;padding-right:0;}
.nc-box-f{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;padding:10px 22px 14px 18px;}
.nc-toast{position:fixed;left:50%;bottom:40px;transform:translateX(-50%);z-index:2147483001;background:#192042;color:#fff;padding:9px 18px;font-size:17px;pointer-events:none;max-width:90vw;}
@media (max-width:640px){
.nc-row{flex-wrap:wrap;}
.nc-ctl{width:100%;justify-content:flex-start;}
.nc-title{font-size:24px;}
.nc input.nc-in{width:100%;}
}`;
        const s = document.createElement("style");
        s.id = "nsws-clubs-css";
        s.textContent = css;
        document.head.appendChild(s);
    }

    function refreshHome() {
        if (Date.now() - S.mineAt > 1500) S.mine = null;
    }

    function register() {
        const t = T();
        if (!t?.registerTab) return false;
        t.registerTab({
            id: "clubs",
            label: "Clubs",
            render(container) {
                S.container = container;
                refreshHome();
                draw();
            },
            onShow() {
                refreshHome();
                draw();
            }
        });
        S.registered = true;
        const p = S.pending;
        S.pending = null;
        if (p?.join) openJoin(p.join);
        else if (p?.open) open();
        return true;
    }

    function openJoin(code) {
        const c = normCode(code);
        if (!c) {
            say("That isn't a club code. Club codes are 6 letters and numbers.");
            return;
        }
        if (!S.registered) {
            S.pending = { join: c };
            return;
        }
        S.view = { type: "join", code: c, fetched: false };
        T()?.openLibrary?.("clubs");
        draw();
    }

    function open() {
        if (!S.registered) {
            S.pending = { open: true };
            return;
        }
        T()?.openLibrary?.("clubs");
    }

    window.__nswsClubs = { openJoin, open };

    function start() {
        if (register()) return;
        let tries = 0;
        const timer = setInterval(() => {
            if (register()) clearInterval(timer);
            else if (++tries > 60) {
                clearInterval(timer);
                if (S.pending) say("Custom Tracks didn't load, so clubs can't open. Reload the page and try again.");
                S.pending = null;
            }
        }, 250);
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
})();
