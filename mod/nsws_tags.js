// Name tags shown next to a player's name in the chat. They are earned by referring friends to
// the site or given out by the owner. The Worker (proxy/src/accounts.js) decides who owns what;
// this file only draws them: in the chat, the garage's Tags tab, the Referrals window and Race Control.
(function () {
    const API = window.__nswsApiBase;
    const VISITOR_KEY = "nsws_visitor";
    const PENDING_KEY = "_nswsRefPending";
    const TOKEN = /^[0-9a-f]{64}$/;
    const CODE = /^[A-HJ-NP-Z2-9]{8}$/;
    const TOAST_MS = 7000;
    const ARM_MS = 4000;

    // Keep in step with TAGS in proxy/src/accounts.js (ids, costs and referral counts).
    const TAGS = [
        { id: "rookie", label: "ROOKIE", group: "shop", cost: 1 },
        { id: "pitcrew", label: "PIT CREW", group: "shop", cost: 2 },
        { id: "drifter", label: "DRIFTER", group: "shop", cost: 3 },
        { id: "nitro", label: "NITRO", group: "shop", cost: 4 },
        { id: "ghost", label: "GHOST", group: "shop", cost: 5 },
        { id: "apex", label: "APEX", group: "shop", cost: 6 },
        { id: "turbo", label: "TURBO", group: "shop", cost: 8 },
        { id: "photofinish", label: "PHOTO FINISH", group: "shop", cost: 10 },
        { id: "legend", label: "LEGEND", group: "shop", cost: 15 },
        { id: "spectrum", label: "SPECTRUM", group: "shop", cost: 20 },
        { id: "referred", label: "REFERRED", group: "earned", need: "Join NSWS with a friend's referral code." },
        { id: "recruiter", label: "RECRUITER", group: "earned", referrals: 5, need: "Refer 5 players." },
        { id: "ambassador", label: "AMBASSADOR", group: "earned", referrals: 15, need: "Refer 15 players." },
        { id: "hypetrain", label: "HYPE TRAIN", group: "earned", referrals: 30, need: "Refer 30 players." },
        { id: "winner", label: "NSWS WINNER", group: "discord", need: "Win a week of Not So Weekly Shorts." },
        { id: "sweep", label: "CLEAN SWEEP", group: "discord", need: "Finish #1 on every map of one week." },
        { id: "builder", label: "MAPPO BUILDER", group: "discord", need: "Build a map that gets used in NSWS." },
        { id: "youtuber", label: "YOUTUBER", group: "discord", need: "Run a YouTube channel that covers NSWS." },
        { id: "author", label: "AUTHOR TIME", group: "discord", need: "Set the Author Time medals for a week." },
        { id: "og", label: "OG", group: "discord", need: "Have played NSWS since the early weeks." },
    ];
    const BY_ID = new Map(TAGS.map((t) => [t.id, t]));
    const GROUPS = [
        ["shop", "Referral shop", "Bought with referral points. A tag you buy is yours for good."],
        ["earned", "Referral rewards", "Free once you get there."],
        ["discord", "Discord tags", "Only the owner gives these out, to go with the Discord roles."],
    ];

    const CSS = `
.nsws-tag{display:inline-flex;align-items:center;gap:.35em;padding:.16em .55em .12em;font-family:ForcedSquare,Arial,sans-serif;font-style:italic;font-weight:normal;line-height:1;letter-spacing:.03em;white-space:nowrap;color:#fff;background:#5b6478;clip-path:polygon(.32em 0,100% 0,calc(100% - .32em) 100%,0 100%);vertical-align:middle;}
#nsws-chat .nsws-tag,#nrc-overlay .nsws-tag{font-family:ForcedSquare,Arial,sans-serif;font-style:italic;line-height:1;}
.nsws-tag.t-referred{background:#1f8f7a;}
.nsws-tag.t-recruiter{background:#2f6fe0;}
.nsws-tag.t-ambassador{background:linear-gradient(90deg,#6a3fd6,#a274ff);}
.nsws-tag.t-hypetrain{background:linear-gradient(90deg,#ff3d77,#ff9f1c,#ff3d77);background-size:200% 100%;animation:nsws-tag-slide 2.4s linear infinite;}
.nsws-tag.t-rookie{background:#5b6478;}
.nsws-tag.t-pitcrew{background:#d8452f;}
.nsws-tag.t-drifter{background:linear-gradient(100deg,#ff8a00,#c4002f);}
.nsws-tag.t-nitro{background:#0a3a8c;color:#8ae8ff;text-shadow:0 0 4px #21c8ff,0 0 9px #21c8ff;}
.nsws-tag.t-ghost{background:rgba(255,255,255,.16);color:#f2f5ff;text-shadow:0 0 6px rgba(255,255,255,.85);}
.nsws-tag.t-apex{background:#b6f23a;color:#14200a;}
.nsws-tag.t-turbo{background:repeating-linear-gradient(-45deg,#ffd400 0 6px,#efb300 6px 12px);color:#141414;}
.nsws-tag.t-photofinish{background:repeating-conic-gradient(#fff 0 25%,#c9cede 0 50%) 0 0/10px 10px;color:#111;}
.nsws-tag.t-legend{background:linear-gradient(110deg,#a8740a 0%,#ffd76a 35%,#fff6cf 50%,#ffd76a 65%,#a8740a 100%);background-size:250% 100%;color:#2a1a00;animation:nsws-tag-shine 3s linear infinite;}
.nsws-tag.t-spectrum{background:linear-gradient(90deg,#ff5b5b,#ffb347,#f9f871,#5bff9b,#5bc8ff,#a36bff,#ff5b5b);background-size:300% 100%;color:#14141e;animation:nsws-tag-rainbow 4s linear infinite;}
.nsws-tag.t-winner{background:linear-gradient(180deg,#ffe07a,#e0a400);color:#2b1d00;}
.nsws-tag.t-sweep{background:linear-gradient(90deg,#5b21ff,#c43cff);text-shadow:0 0 6px rgba(255,255,255,.55);}
.nsws-tag.t-builder{background:#2a9d4b;}
.nsws-tag.t-youtuber{background:#ff0033;}
.nsws-tag.t-youtuber::before{content:"";flex-shrink:0;border-style:solid;border-width:.32em 0 .32em .52em;border-color:transparent transparent transparent #fff;}
.nsws-tag.t-author{background:#103d3b;color:#5ff2d6;}
.nsws-tag.t-og{background:#111;color:#ffcc66;}
@keyframes nsws-tag-shine{from{background-position:0 0;}to{background-position:166.667% 0;}}
@keyframes nsws-tag-slide{from{background-position:0 0;}to{background-position:200% 0;}}
@keyframes nsws-tag-rainbow{from{background-position:0 0;}to{background-position:150% 0;}}
@media (prefers-reduced-motion:reduce){.nsws-tag{animation:none!important;}}

.customization-panel-ui>.panel.nsws-tags{position:absolute;inset:0 0 64px 0;pointer-events:none;}
.nsws-tags .bar{position:absolute;right:var(--safe-area-right);bottom:0;top:64px;display:flex;flex-direction:column;width:min(380px,48vw);box-sizing:border-box;background:var(--surface-secondary-color);pointer-events:auto;}
.nsws-tags .bar>.head{flex-shrink:0;padding:12px 14px;background:var(--surface-color);}
.nsws-tags .bar>.head>.points{font-size:30px;color:#b3c1ff;}
.nsws-tags .bar>.head>.points small{font-size:16px;color:rgba(255,255,255,.65);margin-left:6px;}
.nsws-tags .bar>.head>.sub{font-size:14px;color:rgba(255,255,255,.6);margin:2px 0 8px;}
.nsws-tags .bar>.head>.button{margin:0;font-size:18px;padding:6px 14px;}
.nsws-tags .bar>.list{flex:1;min-height:0;overflow-y:auto;padding:4px 6px 10px;}
.nsws-tags .bar h3{margin:12px 4px 2px;font-size:18px;font-weight:normal;color:#b3c1ff;}
.nsws-tags .bar p{margin:0 4px 6px;font-size:12px;line-height:1.3;color:rgba(255,255,255,.5);}
.nsws-tags .item{display:flex;align-items:center;gap:10px;width:100%;margin:0 0 3px;padding:8px 10px;border:2px solid rgb(38,31,88);background:var(--button-color);color:var(--text-color);font:inherit;text-align:left;cursor:pointer;box-sizing:border-box;}
.nsws-tags .item:hover{background:var(--button-hover-color);}
.nsws-tags .item.selected{background:var(--button-hover-color);border-color:#fff;box-shadow:inset 0 0 5px #fff;}
.nsws-tags .item>.nsws-tag{font-size:18px;}
.nsws-tags .item>.none{font-size:18px;color:rgba(255,255,255,.7);}
.nsws-tags .item>.req{margin-left:auto;font-size:13px;color:rgba(255,255,255,.55);text-align:right;white-space:nowrap;}
.nsws-tags .item.owned>.req{color:#96ff96;}
.nsws-tags .item.on>.req{color:#ffc94a;}
.nsws-tags .item.locked>.nsws-tag{filter:saturate(.35) brightness(.75);}
.nsws-tags .plate{position:absolute;left:50%;top:78px;transform:translateX(-50%);display:flex;align-items:center;gap:10px;max-width:calc(100% - 2 * min(380px,48vw) - 40px);padding:6px 14px;background:rgba(20,20,30,.55);font-size:24px;white-space:nowrap;text-shadow:0 0 4px #000;}
.nsws-tags .plate>.nick{overflow:hidden;text-overflow:ellipsis;}
.nsws-tags .preview{position:absolute;left:calc(var(--safe-area-left) + 10px);bottom:10px;width:min(430px,calc(100% - min(380px,48vw) - 30px));box-sizing:border-box;background:var(--surface-secondary-color);pointer-events:auto;clip-path:polygon(0 0,100% 0,calc(100% - 10px) 100%,0 100%);}
.nsws-tags .preview>.cap{padding:4px 12px;background:var(--surface-color);font-size:20px;}
.nsws-tags .preview>.chat{margin:10px 12px;padding:6px 10px 8px 22px;position:relative;background:#212b58;box-shadow:0 2px 8px rgba(0,0,0,.3);font-size:16px;line-height:1.35;}
.nsws-tags .preview>.chat::before{content:"";position:absolute;left:9px;top:6px;bottom:6px;width:3px;background:var(--c);opacity:.8;}
.nsws-tags .preview>.chat .meta{display:flex;align-items:center;flex-wrap:wrap;gap:0 7px;}
.nsws-tags .preview>.chat .nick{font-weight:bold;color:var(--c);}
.nsws-tags .preview>.chat .nsws-tag{font-size:.72em;}
.nsws-tags .preview>.chat .time{font-size:.7em;opacity:.5;}
.nsws-tags .preview>.info{padding:0 12px 12px;}
.nsws-tags .preview>.info>.need{font-size:15px;line-height:1.3;color:rgba(255,255,255,.8);}
.nsws-tags .preview>.info>.status{min-height:18px;margin:6px 0 0;font-size:14px;color:rgba(255,255,255,.55);}
.nsws-tags .preview>.info>.button{margin:8px 0 0;font-size:20px;}
.nsws-tags .preview>.info>.button.armed{color:#ffc94a;box-shadow:inset 0 -3px 0 #ffc94a;}
.nsws-tags .msg{padding:30px 16px;text-align:center;font-size:16px;color:rgba(255,255,255,.6);}
.nsws-tags .msg>.button{margin-top:12px;font-size:18px;}
@media (max-width:720px){.nsws-tags .plate{display:none;}.nsws-tags .preview>.chat{display:none;}}

#nsws-ref{position:fixed;inset:0;z-index:9998;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.7);}
#nsws-ref *{box-sizing:border-box;}
#nsws-ref>.box{position:relative;display:flex;flex-direction:column;width:min(860px,96vw);max-height:94vh;background:var(--surface-color);color:var(--text-color);clip-path:polygon(0 0,100% 0,calc(100% - 14px) 100%,0 100%);}
#nsws-ref .checker{height:8px;flex-shrink:0;background:repeating-conic-gradient(#fff 0 25%,#112052 0 50%) 0 0/8px 8px;opacity:.85;}
#nsws-ref .top{display:flex;align-items:center;gap:12px;padding:12px 20px;background:var(--surface-secondary-color);}
#nsws-ref .top>h1{margin:0 auto 0 0;font-size:32px;font-weight:normal;color:#b3c1ff;text-shadow:0 2px 0 #112052;}
#nsws-ref .top>.button{margin:0;font-size:20px;padding:6px 14px;}
#nsws-ref .body{overflow-y:auto;padding:16px 20px 20px;}
#nsws-ref .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,330px),1fr));gap:12px;margin-bottom:12px;}
#nsws-ref .card{padding:14px 16px;background:var(--surface-secondary-color);clip-path:polygon(0 0,100% 0,calc(100% - 10px) 100%,0 100%);min-width:0;}
#nsws-ref .card>h2{margin:0 0 6px;font-size:20px;font-weight:normal;}
#nsws-ref .card>.sub{margin:0 0 10px;font-size:13px;line-height:1.35;color:rgba(255,255,255,.55);}
#nsws-ref .code{margin:4px 0 10px;font-size:44px;letter-spacing:.12em;color:#ffc94a;text-shadow:0 3px 0 #112052;user-select:all;font-variant-numeric:tabular-nums;}
#nsws-ref .code.old{opacity:.35;}
#nsws-ref .timer{margin:-2px 0 12px;}
#nsws-ref .timer>.label{margin-bottom:5px;font-size:14px;color:rgba(255,255,255,.7);}
#nsws-ref .timer>.label>b{font-weight:normal;color:#fff;font-variant-numeric:tabular-nums;}
#nsws-ref .timer>.track{height:6px;background:var(--surface-tertiary-color);}
#nsws-ref .timer>.track>.fill{height:100%;background:#ffc94a;transition:width .25s linear;}
#nsws-ref .timer.low>.track>.fill{background:#ff7a59;}
#nsws-ref .timer.low>.label>b{color:#ff9a7f;}
#nsws-ref .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}
#nsws-ref .row>.button{margin:0;font-size:18px;padding:7px 14px;}
#nsws-ref .row>input{flex:1;min-width:0;margin:0;padding:8px 14px;border:0;outline:0;background:var(--surface-tertiary-color);color:var(--text-color);font-size:24px;letter-spacing:.1em;text-transform:uppercase;clip-path:polygon(0 0,100% 0,calc(100% - 8px) 100%,0 100%);user-select:text;}
#nsws-ref .row>input::placeholder{letter-spacing:normal;text-transform:none;opacity:.35;}
#nsws-ref .note{min-height:20px;margin:8px 0 0;font-size:14px;line-height:1.35;color:rgba(255,255,255,.7);}
#nsws-ref .note.good{color:#96ff96;}
#nsws-ref .note.bad{color:#ff9a9a;}
#nsws-ref .tiles{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:12px;}
#nsws-ref .tile{padding:10px 14px;background:var(--button-color);clip-path:polygon(8px 0,100% 0,calc(100% - 8px) 100%,0 100%);}
#nsws-ref .tile>.k{font-size:13px;color:rgba(255,255,255,.6);}
#nsws-ref .tile>.v{margin-top:4px;font-size:30px;color:#b3c1ff;}
#nsws-ref ol{margin:0;padding-left:22px;font-size:15px;line-height:1.5;color:rgba(255,255,255,.85);}
#nsws-ref .top5{display:flex;flex-direction:column;gap:6px;font-size:16px;}
#nsws-ref .top5>div{display:flex;gap:10px;}
#nsws-ref .top5>div>span:first-child{width:24px;color:rgba(255,255,255,.45);}
#nsws-ref .top5>div>span:nth-child(2){flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
#nsws-ref .top5>div:first-child>span:first-child{color:#ffc94a;}
#nsws-ref .empty{font-size:14px;color:rgba(255,255,255,.45);}
@media (max-width:560px){#nsws-ref .code{font-size:32px;}#nsws-ref .tiles{grid-template-columns:1fr;}}

#nsws-tags-toast{position:fixed;left:50%;bottom:90px;z-index:10003;max-width:min(520px,92vw);padding:10px 16px;transform:translateX(-50%);border-left:4px solid #ffc94a;background:var(--surface-color,#28346a);color:var(--text-color,#fff);font-size:17px;line-height:1.35;box-shadow:0 6px 20px rgba(0,0,0,.45);pointer-events:none;transition:opacity .5s;}
#nsws-tags-toast.out{opacity:0;}
`;

    let state = null;
    let loading = null;
    // Server time minus this browser's, so the code's countdown matches the Worker's clock.
    let clockOffset = 0;
    let garage = null;
    let ref = null;

    function storageGet(key) {
        try {
            return localStorage.getItem(key);
        } catch {
            return null;
        }
    }

    function storageSet(key, value) {
        try {
            if (value == null) localStorage.removeItem(key);
            else localStorage.setItem(key, value);
        } catch {}
    }

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

    function profileToken() {
        const token = window.__nswsProfileToken?.();
        return TOKEN.test(token || "") ? token : null;
    }

    // The same random id the chat and the traffic beat use; the Worker links its hash to the account.
    function visitorId() {
        let id = storageGet(VISITOR_KEY);
        if (!/^[0-9a-f]{32}$/.test(id || "")) {
            id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
            storageSet(VISITOR_KEY, id);
        }
        return id;
    }

    function nickname() {
        try {
            const slot = parseInt(localStorage.getItem("polytrack_v5_prod_user_slot") ?? "0", 10);
            const nick = JSON.parse(localStorage.getItem("polytrack_v5_prod_user_" + (slot >= 0 ? slot : 0)))?.nickname;
            return typeof nick === "string" && nick.trim() ? nick.trim() : "Guest";
        } catch {
            return "Guest";
        }
    }

    function cleanCode(text) {
        return String(text ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    }

    // { status, data }; status 0 when the proxy couldn't be reached.
    async function api(path, body) {
        if (!API) return { status: 0, data: null };
        let response;
        try {
            response = await fetch(API + "nsws/" + path, {
                method: "POST",
                headers: { "Content-Type": "text/plain" },
                body: JSON.stringify(body),
                cache: "no-store",
            });
        } catch {
            return { status: 0, data: null };
        }
        let data = null;
        try {
            data = await response.json();
        } catch {}
        return { status: response.status, data };
    }

    function chip(id) {
        const tag = BY_ID.get(id);
        if (!tag) return null;
        const span = el("span", "nsws-tag t-" + id, tag.label);
        span.title = tag.label;
        return span;
    }

    function setState(next) {
        if (!next || typeof next !== "object" || !Array.isArray(next.owned)) return;
        if (Number.isFinite(next.now)) clockOffset = next.now - Date.now();
        if (ref && state?.code !== next.code) ref.copied = "";
        state = next;
        renderGarage();
        renderRef();
    }

    // Also links this browser's chat to the profile, so the chat can show its tag.
    function loadState() {
        const token = profileToken();
        if (!token) return Promise.reject(Object.assign(new Error("no profile"), { status: 0 }));
        if (loading?.token === token) return loading.promise;
        const promise = api("refer/me", { userToken: token, v: visitorId() }).then(({ status, data }) => {
            if (loading?.promise === promise) loading = null;
            if (status !== 200) throw Object.assign(new Error("refer/me " + status), { status });
            if (profileToken() === token) setState(data);
            return data;
        });
        loading = { token, promise };
        return promise;
    }

    let toastTimer = 0;
    function toast(text) {
        let box = document.getElementById("nsws-tags-toast");
        if (!box) {
            box = el("div");
            box.id = "nsws-tags-toast";
            document.body.appendChild(box);
        }
        box.textContent = text;
        box.classList.remove("out");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => box.classList.add("out"), TOAST_MS);
    }

    const REDEEM_ERRORS = {
        code: "There's no referral code like that. Check it and try again.",
        expired: "That code has expired. Codes change every 10 minutes, so ask your friend for their new one.",
        self: "That's your own code. Send it to a friend instead!",
        already: "This profile has already used a referral code.",
        mutual: "That player joined with your code, so you can't use theirs.",
        busy: "Too many referral codes from this network today. Try again tomorrow.",
    };

    // Resolves to { ok, text, keep }; keep means it's worth trying again later.
    async function redeem(code) {
        const token = profileToken();
        code = cleanCode(code);
        if (!CODE.test(code)) return { ok: false, text: REDEEM_ERRORS.code };
        if (!token) return { ok: false, text: "Your profile isn't ready yet. Try again in a moment.", keep: true };
        const { status, data } = await api("refer/redeem", { userToken: token, code });
        if (status === 200 && data?.ok) {
            setState(data.state);
            return { ok: true, text: "You joined with " + data.referrer + "'s code! The REFERRED tag is yours: wear it from Garage → Tags." };
        }
        if (data?.error && REDEEM_ERRORS[data.error]) return { ok: false, text: REDEEM_ERRORS[data.error] };
        if (status === 404) return { ok: false, text: "Referrals aren't switched on yet.", keep: true };
        return { ok: false, text: "Couldn't reach the server. Try again in a moment.", keep: true };
    }

    // ?ref=CODE links: the code is remembered and used as soon as the profile exists.
    function takeRefParam() {
        let params;
        try {
            params = new URLSearchParams(location.search);
        } catch {
            return;
        }
        const code = cleanCode(params.get("ref"));
        if (!params.has("ref")) return;
        params.delete("ref");
        const query = params.toString();
        try {
            history.replaceState(history.state, "", location.pathname + (query ? "?" + query : "") + location.hash);
        } catch {}
        if (CODE.test(code)) storageSet(PENDING_KEY, code);
    }

    async function redeemPending() {
        const code = storageGet(PENDING_KEY);
        if (!code) return;
        const result = await redeem(code);
        if (result.keep) return;
        storageSet(PENDING_KEY, null);
        if (result.ok || result.text !== REDEEM_ERRORS.already) toast(result.text);
    }

    function start() {
        takeRefParam();
        let tries = 0;
        const tick = () => {
            if (!profileToken()) {
                if (++tries < 40) setTimeout(tick, 3000);
                return;
            }
            redeemPending().catch(() => {}).finally(() => loadState().catch(() => {}));
        };
        setTimeout(tick, 4000);
    }

    function owns(id) {
        return !!state?.owned.includes(id);
    }

    function requirement(tag) {
        if (tag.group === "shop") return tag.cost === 1 ? "1 point" : tag.cost + " points";
        if (tag.referrals) return Math.min(state?.referrals ?? 0, tag.referrals) + " / " + tag.referrals + " referrals";
        if (tag.group === "discord") return "Owner only";
        return "Use a code";
    }

    function itemStatus(tag) {
        if (state?.equipped === tag.id) return "Wearing";
        if (owns(tag.id)) return "Owned";
        return requirement(tag);
    }

    function needText(tag) {
        if (tag.group === "shop") return "Costs " + requirement(tag) + " from the referral shop. You get a point for every friend you refer.";
        if (tag.group === "discord") return tag.need + " Only the owner can give this one out.";
        return tag.need;
    }

    function disarm(view) {
        clearTimeout(view.armTimer);
        view.armed = null;
    }

    async function act(view, kind, tag) {
        const token = profileToken();
        if (!token || view.busy) return;
        view.busy = true;
        view.note = kind === "buy" ? "Buying…" : "Saving…";
        renderGarage();
        const { status, data } = await api(kind === "buy" ? "tags/buy" : "tags/equip", { userToken: token, tag });
        view.busy = false;
        if (status === 200) {
            view.note = kind === "buy" ? "Bought! You're wearing it now. It shows in the chat on your next message."
                : tag ? "You're wearing it. It shows in the chat on your next message." : "No tag now.";
            setState(data);
        } else {
            view.note = data?.error === "points" ? "You don't have enough points for that."
                : data?.error === "locked" ? "You don't have that tag yet." : "Couldn't save that. Try again in a moment.";
            renderGarage();
        }
    }

    function mountGarage(panel) {
        panel.classList.add("nsws-tags");
        panel.textContent = "";
        const view = {
            panel,
            plate: el("div", "plate"),
            preview: el("div", "preview"),
            bar: el("div", "bar"),
            selected: undefined,
            color: "#b3c1ff",
            busy: false,
            note: "",
            armed: null,
            armTimer: 0,
            failed: null,
        };
        panel.append(view.plate, view.preview, view.bar);
        garage = view;
        window.__nswsChat?.ownColor?.().then((c) => {
            if (c) {
                view.color = c;
                renderGarage();
            }
        }).catch(() => {});
        // The Tags tab is only rebuilt while the garage is open; it re-reads the profile each time.
        const refresh = () => {
            view.failed = null;
            renderGarage();
            loadState().catch((err) => {
                view.failed = err.status === 404 ? "Tags aren't switched on yet." : "Couldn't load your tags.";
                renderGarage();
            });
        };
        view.refresh = refresh;
        refresh();
    }

    function renderGarage() {
        const view = garage;
        if (!view) return;
        if (!view.panel.isConnected) {
            garage = null;
            return;
        }
        const scroll = view.bar.querySelector(".list")?.scrollTop ?? 0;
        view.bar.textContent = "";
        view.preview.textContent = "";
        view.plate.textContent = "";

        if (!state) {
            const msg = el("div", "msg", view.failed || "Loading your tags…");
            if (view.failed) msg.append(el("br"), button("Retry", view.refresh));
            view.bar.appendChild(msg);
            view.preview.style.display = view.plate.style.display = "none";
            return;
        }
        view.preview.style.display = view.plate.style.display = "";
        if (view.selected === undefined) view.selected = state.equipped;

        const head = el("div", "head");
        const points = el("div", "points", String(state.points));
        points.appendChild(el("small", null, state.points === 1 ? "referral point" : "referral points"));
        const sub = el("div", "sub", state.referrals + (state.referrals === 1 ? " referral" : " referrals")
            + (state.pending ? " · " + state.pending + " waiting for their first run" : ""));
        head.append(points, sub, button("Referrals", () => openReferrals()));
        view.bar.appendChild(head);

        const list = el("div", "list");
        const pick = (id) => {
            if (view.selected !== id) {
                view.selected = id;
                view.note = "";
                disarm(view);
            }
            renderGarage();
        };
        const none = el("button", "item" + (view.selected === null ? " selected" : "") + (state.equipped == null ? " on" : ""));
        none.append(el("span", "none", "No tag"), el("span", "req", state.equipped == null ? "Wearing" : ""));
        none.addEventListener("click", () => pick(null));
        list.appendChild(none);
        for (const [group, title, desc] of GROUPS) {
            list.append(el("h3", null, title), el("p", null, desc));
            for (const tag of TAGS.filter((t) => t.group === group)) {
                const owned = owns(tag.id);
                const item = el("button", "item" + (owned ? " owned" : " locked") + (state.equipped === tag.id ? " on" : "")
                    + (view.selected === tag.id ? " selected" : ""));
                item.append(chip(tag.id), el("span", "req", itemStatus(tag)));
                item.title = needText(tag);
                item.addEventListener("click", () => pick(tag.id));
                list.appendChild(item);
            }
        }
        view.bar.appendChild(list);
        list.scrollTop = scroll;

        const selected = view.selected == null ? null : BY_ID.get(view.selected);
        const nick = nickname();
        const plateNick = el("span", "nick", nick);
        view.plate.appendChild(plateNick);
        if (selected) view.plate.appendChild(chip(selected.id));

        view.preview.appendChild(el("div", "cap", "Preview"));
        const chat = el("div", "chat");
        chat.style.setProperty("--c", view.color);
        const meta = el("div", "meta");
        meta.appendChild(el("span", "nick", nick));
        if (selected) meta.appendChild(chip(selected.id));
        meta.appendChild(el("span", "time", "Today at " + new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })));
        chat.append(meta, el("div", null, "gg, see you on the leaderboard"));
        view.preview.appendChild(chat);

        const info = el("div", "info");
        info.appendChild(el("div", "need", selected ? needText(selected) : "No tag next to your name."));
        let action = null;
        if (!selected) {
            if (state.equipped != null) action = button("Wear no tag", () => act(view, "equip", null));
        } else if (state.equipped === selected.id) {
            action = button("Take it off", () => act(view, "equip", null));
        } else if (owns(selected.id)) {
            action = button("Wear it", () => act(view, "equip", selected.id));
        } else if (selected.group === "shop") {
            const short = selected.cost - state.points;
            if (short > 0) {
                action = button("Need " + short + " more " + (short === 1 ? "point" : "points"), () => openReferrals());
                action.title = "Refer friends to earn points";
            } else {
                const armed = view.armed === selected.id;
                action = button(armed ? "Click again to buy" : "Buy for " + requirement(selected), () => {
                    if (view.armed !== selected.id) {
                        disarm(view);
                        view.armed = selected.id;
                        view.armTimer = setTimeout(() => {
                            disarm(view);
                            renderGarage();
                        }, ARM_MS);
                        renderGarage();
                        return;
                    }
                    disarm(view);
                    act(view, "buy", selected.id);
                });
                if (armed) action.classList.add("armed");
            }
        }
        if (action) {
            action.disabled = view.busy;
            info.appendChild(action);
        }
        info.appendChild(el("div", "status", view.note || (selected && !owns(selected.id) && selected.group !== "shop" ? "Locked" : "")));
        view.preview.appendChild(info);
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

    function refLink(code) {
        return location.origin + location.pathname + "?ref=" + code;
    }

    function stopKeys(e) {
        e.stopPropagation();
    }

    function onRefKey(e) {
        if (e.key !== "Escape" && e.code !== "Escape") return;
        e.preventDefault();
        e.stopImmediatePropagation();
        closeReferrals();
    }

    function codeLeft() {
        return state?.codeExpires ? state.codeExpires - (Date.now() + clockOffset) : null;
    }

    function clock(ms) {
        const s = Math.max(0, Math.ceil(ms / 1000));
        return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
    }

    // Runs four times a second while the window is open. At zero it fetches the new code.
    function tickRef() {
        const view = ref;
        const left = codeLeft();
        if (!view?.timer || left == null) return;
        const total = state.codeMs || 600_000;
        view.timer.classList.toggle("low", left < 60_000);
        view.timerFill.style.width = Math.max(0, Math.min(100, (left / total) * 100)) + "%";
        view.codeEl.classList.toggle("old", left <= 0);
        for (const b of view.copyButtons) b.disabled = left <= 0;
        if (left > 0) {
            view.timerLabel.textContent = "New code in ";
            view.timerLabel.appendChild(el("b", null, clock(left)));
            return;
        }
        view.timerLabel.textContent = "Getting your new code…";
        if (view.renewing || Date.now() - view.renewedAt < 3000) return;
        view.renewing = true;
        view.renewedAt = Date.now();
        loadState().catch(() => {}).finally(() => {
            view.renewing = false;
        });
    }

    function closeReferrals() {
        if (!ref) return;
        clearInterval(ref.ticker);
        ref.overlay.remove();
        window.removeEventListener("keydown", onRefKey, true);
        ref = null;
    }

    function openReferrals() {
        if (ref) return;
        const overlay = el("div");
        overlay.id = "nsws-ref";
        const box = el("div", "box");
        box.appendChild(el("div", "checker"));
        const top = el("div", "top");
        top.append(el("h1", null, "Referrals"), button("✕", closeReferrals));
        box.appendChild(top);
        const body = el("div", "body");
        box.appendChild(body);
        overlay.appendChild(box);
        overlay.addEventListener("pointerdown", (e) => {
            if (e.target === overlay) closeReferrals();
        });
        for (const type of ["keydown", "keyup", "keypress"]) overlay.addEventListener(type, stopKeys);
        document.body.appendChild(overlay);
        window.addEventListener("keydown", onRefKey, true);
        ref = { overlay, body, draft: storageGet(PENDING_KEY) || "", note: "", noteKind: "", busy: false, copied: "", failed: null,
            renewing: false, renewedAt: 0 };
        ref.ticker = setInterval(tickRef, 250);
        renderRef();
        loadState().catch((err) => {
            if (!ref) return;
            ref.failed = err.status === 404 ? "Referrals aren't switched on yet." : "Couldn't reach the server.";
            renderRef();
        });
    }

    function tileEl(k, v) {
        const t = el("div", "tile");
        t.append(el("div", "k", k), el("div", "v", v));
        return t;
    }

    function renderRef() {
        if (!ref) return;
        const view = ref;
        const active = document.activeElement;
        const typing = active?.tagName === "INPUT" && view.body.contains(active);
        const caret = typing ? active.selectionStart : null;
        view.body.textContent = "";
        const grid = el("div", "grid");

        const mine = el("div", "card");
        mine.append(el("h2", null, "Your code"), el("p", "sub", "It changes every 10 minutes, so send it to a friend who's ready to join. They type it in here (Referrals on the main menu), or just open your link."));
        view.codeEl = el("div", "code", state?.code ?? (view.failed ? "—" : "…"));
        mine.appendChild(view.codeEl);
        view.timer = view.timerLabel = view.timerFill = null;
        if (state?.codeExpires) {
            view.timer = el("div", "timer");
            view.timerLabel = el("div", "label");
            const track = el("div", "track");
            view.timerFill = el("div", "fill");
            track.appendChild(view.timerFill);
            view.timer.append(view.timerLabel, track);
            mine.appendChild(view.timer);
        }
        const copyRow = el("div", "row");
        const copy = (what, text) => copyText(text).then(() => {
            if (!ref) return;
            view.copied = what;
            renderRef();
        }).catch(() => {});
        const copyCode = button(view.copied === "code" ? "Copied!" : "Copy code", () => state && copy("code", state.code));
        const copyLink = button(view.copied === "link" ? "Copied!" : "Copy link", () => state && copy("link", refLink(state.code)));
        copyCode.disabled = copyLink.disabled = !state;
        view.copyButtons = [copyCode, copyLink];
        copyRow.append(copyCode, copyLink);
        mine.appendChild(copyRow);
        if (view.failed && !state) mine.appendChild(el("p", "note bad", view.failed));
        grid.appendChild(mine);

        const theirs = el("div", "card");
        theirs.appendChild(el("h2", null, "Got a code from a friend?"));
        if (state?.referredBy) {
            theirs.appendChild(el("p", "sub", "Every profile can use one code."));
            theirs.appendChild(el("p", "note good", "You joined with " + state.referredBy.nickname + "'s code. The REFERRED tag is yours."));
        } else {
            theirs.appendChild(el("p", "sub", "Type it in to give them a point. You get the REFERRED tag."));
            const row = el("div", "row");
            const input = el("input");
            input.type = "text";
            input.maxLength = 12;
            input.placeholder = "e.g. K7QM3PXA";
            input.autocomplete = "off";
            input.spellcheck = false;
            input.value = view.draft;
            input.addEventListener("input", () => {
                view.draft = input.value;
            });
            const go = async () => {
                if (view.busy) return;
                view.busy = true;
                view.note = "Checking…";
                view.noteKind = "";
                renderRef();
                const result = await redeem(view.draft);
                if (!ref) return;
                view.busy = false;
                view.note = result.ok ? "" : result.text;
                view.noteKind = result.ok ? "good" : "bad";
                if (result.ok) {
                    storageSet(PENDING_KEY, null);
                    toast(result.text);
                }
                renderRef();
            };
            input.addEventListener("keydown", (e) => {
                if (e.key === "Enter") go();
            });
            const redeemButton = button("Use code", go);
            redeemButton.disabled = view.busy;
            row.append(input, redeemButton);
            theirs.appendChild(row);
            if (typing) {
                requestAnimationFrame(() => {
                    input.focus();
                    if (caret != null) input.setSelectionRange(caret, caret);
                });
            }
        }
        theirs.appendChild(el("p", "note " + view.noteKind, view.note));
        grid.appendChild(theirs);
        view.body.appendChild(grid);

        const tiles = el("div", "tiles");
        tiles.append(
            tileEl("Points to spend", state ? String(state.points) : "–"),
            tileEl("Friends referred", state ? String(state.referrals) : "–"),
            tileEl("Waiting for a first run", state ? String(state.pending) : "–"),
        );
        view.body.appendChild(tiles);

        const lower = el("div", "grid");
        const how = el("div", "card");
        how.appendChild(el("h2", null, "How it works"));
        const steps = el("ol");
        for (const step of [
            "Send a friend your code or link. It changes every 10 minutes, so they need to use it before the timer runs out.",
            "They enter it on their profile (one code per profile).",
            "You get a point once they finish a run on any NSWS track.",
            "Spend points on tags in Garage → Tags. Your tag shows next to your name in the chat.",
            "Referring 5, 15 and 30 players unlocks free reward tags.",
        ]) steps.appendChild(el("li", null, step));
        how.appendChild(steps);
        lower.appendChild(how);

        const top = el("div", "card");
        top.appendChild(el("h2", null, "Top recruiters"));
        const rows = state?.top ?? [];
        if (!rows.length) {
            top.appendChild(el("div", "empty", state ? "Nobody yet. You could be first!" : "…"));
        } else {
            const listEl = el("div", "top5");
            rows.forEach((r, i) => {
                const row = el("div");
                row.append(el("span", null, String(i + 1)), el("span", null, r.nickname), el("span", null, String(r.referrals)));
                listEl.appendChild(row);
            });
            top.appendChild(listEl);
        }
        lower.appendChild(top);
        view.body.appendChild(lower);
        tickRef();
    }

    if (!document.getElementById("nsws-tags-style")) {
        const style = el("style");
        style.id = "nsws-tags-style";
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    window.__nswsTags = {
        catalog: TAGS.map((t) => ({ ...t })),
        chip,
        mountGarage,
        openReferrals,
        refresh: () => loadState(),
    };

    start();
})();
