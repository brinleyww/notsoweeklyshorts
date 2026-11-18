// Crates: car parts that only come out of crates (mod/nsws_crate_parts.js), bought with Bolts earned by playing. Never real
// money. The inventory is kept in this browser per profile; the Worker only counts how many of each part exist.
(function () {
    const STORE = "nsws_crates_v2:";
    const OLD_STORE = "nsws_crates_v1:";
    const PRICE = 50;
    const START_BOLTS = 50;
    const FINISH_BOLTS = 2;
    const FINISH_BOLTS_PER_DAY = 60;
    const PB_BOLTS = 15;
    const PB_REWARDS_PER_DAY = 3;
    const MAX_ITEMS = 500;
    const TILE = 150;
    const GAP = 6;
    const SPIN_MS = 6200;
    const COUNTS_MS = 5 * 60 * 1000;
    const REPORT_DELAY_MS = 15000;
    const WHEEL_SPINS_PER_DAY = 5;
    const WHEEL_BETS = [10, 25, 50, 100];
    const WHEEL_MS = 5200;
    // Clockwise from the top. Pays a little over even on average, with only five spins a day.
    const WHEEL = [
        { x: 0, label: "BANKRUPT", color: "#1b1b2b" },
        { x: 1.5, label: "\u00d71.5", color: "#8847ff" },
        { x: 0.5, label: "HALF", color: "#3a4a8a" },
        { x: 1, label: "PUSH", color: "#28346a" },
        { x: 2, label: "DOUBLE", color: "#d32ce6" },
        { x: 0, label: "BANKRUPT", color: "#1b1b2b" },
        { x: 1, label: "PUSH", color: "#28346a" },
        { x: 4, label: "\u00d74 JACKPOT", color: "#e4ae39" },
        { x: 0.5, label: "HALF", color: "#3a4a8a" },
        { x: 1.5, label: "\u00d71.5", color: "#8847ff" },
        { x: 0, label: "BANKRUPT", color: "#1b1b2b" },
        { x: 1, label: "PUSH", color: "#28346a" },
    ];
    const WHEEL_QUIPS = {
        0: ["The wheel giveth. Mostly it taketh.", "Bolts gone. Character built.", "That's racing."],
        0.5: ["Half back. Could be worse.", "A partial refund of dignity."],
        1: ["Nothing happened. Thrilling.", "You get your Bolts back, and a story nobody wants."],
        1.5: ["Up a bit! Act like you meant it.", "Profit. Small, but it's yours."],
        2: ["DOUBLE. Tell nobody, they'll want a go.", "Twice the Bolts, twice the swagger."],
        4: ["JACKPOT. The wheel would like to apologise to everyone else.", "\u00d74! Screenshot or it didn't happen."],
    };

    const RARITIES = [
        { id: "milspec", name: "Mil-Spec", color: "#4b69ff", odds: 0.7992, sell: 4 },
        { id: "restricted", name: "Restricted", color: "#8847ff", odds: 0.1598, sell: 12 },
        { id: "classified", name: "Classified", color: "#d32ce6", odds: 0.032, sell: 40 },
        { id: "covert", name: "Covert", color: "#eb4b4b", odds: 0.0064, sell: 150 },
        { id: "gold", name: "Rare Special", color: "#e4ae39", odds: 0.0026, sell: 600 },
    ];
    const R = Object.fromEntries(RARITIES.map((r, i) => [r.id, i]));

    const CRATES = [
        { kind: "patterns", name: "Pattern Crate", field: "pattern", label: "Patterns", one: "pattern" },
        { kind: "rims", name: "Rims Crate", field: "rims", label: "Rims", one: "rims" },
        { kind: "exhausts", name: "Exhaust Crate", field: "exhaust", label: "Exhausts", one: "exhaust" },
        { kind: "bodies", name: "Car Crate", field: "body", label: "Cars", one: "car" },
    ];
    const CRATE = Object.fromEntries(CRATES.map((c) => [c.kind, c]));

    const QUIPS = [
        ["Certified mid.", "Adds 0 km/h. We checked.", "The crate shrugged.", "It's blue. Like your chances of beating Author Time."],
        ["Purple! Respectable. Frame it.", "Someone's mum is proud.", "Not bad. Not bad at all."],
        ["PINK. Somebody screenshot this.", "The chat would like to know your location."],
        ["RED. You may now be insufferable for exactly one week.", "Covert. Act natural."],
        ["\u2605 You absolute menace.", "\u2605 The crate gods smile upon you."],
    ];

    const CSS = `
.customization-panel-ui>.panel.nsws-crates{position:absolute;inset:0 0 64px 0;pointer-events:none;}
.nsws-crates .bar{position:absolute;right:var(--safe-area-right);bottom:0;top:64px;display:flex;flex-direction:column;width:min(380px,48vw);box-sizing:border-box;background:var(--surface-secondary-color);pointer-events:auto;}
.nsws-crates .bar>.head{flex-shrink:0;padding:12px 14px;background:var(--surface-color);}
.nsws-crates .bar>.head>.count{font-size:30px;}
.nsws-crates .bar>.head>.count small{font-size:16px;color:rgba(255,255,255,.65);margin-left:6px;}
.nsws-crates .bar>.head>.sub{font-size:13px;line-height:1.35;color:rgba(255,255,255,.6);margin:2px 0 8px;}
.nsws-crates .bar>.head>.button{margin:0 6px 0 0;font-size:18px;padding:6px 12px;}
.nsws-crates .bar>.head>.button.main{box-shadow:inset 0 -3px #ffc94a;}
.nsws-crates .bar>.list{flex:1;min-height:0;overflow-y:auto;padding:4px 6px 10px;}
.nsws-crates .bar h3{margin:12px 4px 4px;font-size:17px;font-weight:normal;color:rgba(255,255,255,.8);}
.nsws-crates .bar>.list>p{margin:20px 10px;font-size:15px;line-height:1.4;color:rgba(255,255,255,.55);text-align:center;}
.nsws-crates .bar>.foot{flex-shrink:0;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 12px;border-top:1px solid rgba(255,255,255,.1);font-size:13px;color:rgba(255,255,255,.55);}
.nsws-crates .bar>.foot>.button{margin:0;font-size:15px;padding:3px 10px;}
.nsws-crates .item{display:flex;align-items:center;gap:8px;width:100%;margin:0 0 3px;padding:7px 10px 7px 12px;border:2px solid rgb(38,31,88);border-left:5px solid var(--rc);background:var(--button-color);color:var(--text-color);font:inherit;font-size:16px;text-align:left;cursor:pointer;box-sizing:border-box;}
.nsws-crates .item:hover{background:var(--button-hover-color);}
.nsws-crates .item.selected{background:var(--button-hover-color);border-color:#fff;border-left-color:var(--rc);box-shadow:inset 0 0 5px #fff;}
.nsws-crates .item>.nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.nsws-crates .item>.x{flex-shrink:0;font-size:13px;color:rgba(255,255,255,.55);}
.nsws-crates .item>.w{margin-left:auto;flex-shrink:0;font-size:13px;color:rgba(255,255,255,.55);}
.nsws-crates .item.on>.w{color:#ffc94a;}
.nsws-crates .st,#nsws-crate .st{color:#cf6a32;}
.nsws-crates .preview{position:absolute;left:calc(var(--safe-area-left) + 10px);bottom:10px;width:min(430px,calc(100% - min(380px,48vw) - 30px));box-sizing:border-box;background:var(--surface-secondary-color);pointer-events:auto;clip-path:polygon(0 0,100% 0,calc(100% - 10px) 100%,0 100%);}
.nsws-crates .preview>.cap{padding:4px 12px;background:var(--surface-color);font-size:20px;border-bottom:3px solid var(--rc,transparent);}
.nsws-crates .preview>.cap>small{display:block;font-size:14px;color:var(--rc,rgba(255,255,255,.6));}
.nsws-crates .preview>.info{padding:8px 12px 12px;font-size:14px;line-height:1.4;color:rgba(255,255,255,.75);}
.nsws-crates .preview>.info>.note{font-style:italic;color:rgba(255,255,255,.6);margin-top:4px;}
.nsws-crates .preview>.info>.button{margin:8px 6px 0 0;font-size:18px;padding:5px 14px;}
.nsws-crates .preview>.info>.button.armed{color:#ffc94a;box-shadow:inset 0 -3px #ffc94a;}
.nsws-crates .preview>.info>.button:disabled{opacity:.35;}
@media (max-width:720px){.nsws-crates .preview>.info>.note{display:none;}}
#nsws-crate{position:fixed;inset:0;z-index:10001;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.72);}
#nsws-crate *{box-sizing:border-box;}
#nsws-crate>.box{display:flex;flex-direction:column;width:min(940px,96vw);max-height:94vh;background:var(--surface-color);color:var(--text-color);outline:none;}
#nsws-crate .top{display:flex;align-items:center;gap:10px;padding:10px 20px;background:var(--surface-secondary-color);}
#nsws-crate .top>h1{margin:0 auto 0 0;font-size:28px;font-weight:normal;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#nsws-crate .top>small{font-size:15px;color:rgba(255,255,255,.65);white-space:nowrap;}
#nsws-crate .top>.button{margin:0;font-size:20px;padding:6px 14px;}
#nsws-crate .body{overflow-y:auto;padding:8px 20px 18px;}
#nsws-crate h2{margin:12px 0 8px;padding-bottom:3px;font-size:15px;font-weight:normal;font-style:italic;color:rgba(255,255,255,.65);border-bottom:1px solid #fff;}
#nsws-crate .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(118px,1fr));gap:6px;}
#nsws-crate .shop{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:8px;}
#nsws-crate .tile{position:relative;display:flex;flex-direction:column;align-items:center;background:var(--button-color);border-bottom:4px solid var(--rc);padding:4px 4px 6px;min-width:0;}
#nsws-crate .tile>img,#nsws-crate .tile>.star{width:100%;max-width:120px;aspect-ratio:1;object-fit:contain;filter:drop-shadow(0 0 2px #000);}
#nsws-crate .tile>.star{display:flex;align-items:center;justify-content:center;font-size:64px;color:#e4ae39;}
#nsws-crate .tile>span{width:100%;font-size:13px;line-height:1.2;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
#nsws-crate .tile>small{font-size:11px;color:rgba(255,255,255,.55);white-space:nowrap;}
#nsws-crate .shop .tile{cursor:pointer;border-bottom-color:#ffc94a;padding:8px;}
#nsws-crate .shop .tile:hover{background:var(--button-hover-color);}
#nsws-crate .shop .tile>img{max-width:150px;}
#nsws-crate .shop .tile>span{font-size:19px;}
#nsws-crate .shop .tile>small{font-size:13px;}
#nsws-crate .reel{position:relative;height:${TILE + 46}px;margin:6px 0 4px;overflow:hidden;background:var(--surface-tertiary-color);}
#nsws-crate .reel>.strip{position:absolute;left:0;top:8px;display:flex;gap:${GAP}px;will-change:transform;}
#nsws-crate .reel .tile{width:${TILE}px;flex-shrink:0;}
#nsws-crate .reel>.mark{position:absolute;left:50%;top:0;bottom:0;width:3px;margin-left:-1px;background:#ffc94a;box-shadow:0 0 6px #ffc94a;z-index:1;}
#nsws-crate .actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:12px;}
#nsws-crate .actions>.button{margin:0;font-size:20px;padding:6px 16px;}
#nsws-crate .actions>.button.main{box-shadow:inset 0 -3px #ffc94a;}
#nsws-crate .actions>.button:disabled{opacity:.35;}
#nsws-crate .actions>.msg{font-size:14px;color:rgba(255,255,255,.65);}
#nsws-crate .won{display:flex;gap:18px;align-items:center;padding:10px 0;}
#nsws-crate .won>img{width:220px;height:220px;flex-shrink:0;background:var(--button-color);border-bottom:5px solid var(--rc);filter:drop-shadow(0 0 2px #000);}
#nsws-crate .won>div{min-width:0;}
#nsws-crate .won .kind{font-size:15px;color:var(--rc);}
#nsws-crate .won .nm{font-size:30px;line-height:1.15;margin:2px 0 6px;}
#nsws-crate .won .meta{font-size:14px;line-height:1.5;color:rgba(255,255,255,.7);}
#nsws-crate .won .quip{margin-top:8px;font-size:17px;font-style:italic;}
#nsws-crate .won.pop{animation:nsws-crate-pop .45s ease-out;}
@keyframes nsws-crate-pop{0%{transform:scale(.9);opacity:0;}100%{transform:none;opacity:1;}}
#nsws-crate .line{display:flex;align-items:center;justify-content:space-between;gap:14px;min-height:46px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.1);font-size:17px;}
#nsws-crate .line>div>small{display:block;font-size:13px;color:rgba(255,255,255,.6);}
#nsws-crate .line>.button{margin:0;font-size:17px;padding:5px 14px;flex-shrink:0;}
#nsws-crate .line>.button:disabled{opacity:.35;}
#nsws-crate table{width:100%;border-collapse:collapse;font-size:15px;table-layout:fixed;}
#nsws-crate td:not(:first-child),#nsws-crate th:not(:first-child){width:17%;}
#nsws-crate td,#nsws-crate th{padding:5px 8px;border-bottom:1px solid rgba(255,255,255,.1);text-align:right;white-space:nowrap;}
#nsws-crate th{font-weight:normal;font-size:13px;color:rgba(255,255,255,.55);}
#nsws-crate td:first-child,#nsws-crate th:first-child{text-align:left;white-space:normal;border-left:4px solid var(--rc,transparent);}
#nsws-crate td.mine{color:#96ff96;}
#nsws-crate .fine{margin:14px 0 0;font-size:13px;line-height:1.4;color:rgba(255,255,255,.5);}
#nsws-crate .wheel{display:flex;flex-wrap:wrap;gap:20px;align-items:center;justify-content:center;padding:6px 0;}
#nsws-crate .wheel .disc{position:relative;width:min(340px,80vw);aspect-ratio:1;flex-shrink:0;}
#nsws-crate .wheel .disc>svg{width:100%;height:100%;display:block;will-change:transform;}
#nsws-crate .wheel .disc>.pin{position:absolute;left:50%;top:-6px;width:0;height:0;margin-left:-13px;border-left:13px solid transparent;border-right:13px solid transparent;border-top:26px solid #ffc94a;filter:drop-shadow(0 2px 2px #000);z-index:1;}
#nsws-crate .wheel .side{flex:1;min-width:220px;max-width:360px;}
#nsws-crate .wheel .side>p{margin:0 0 10px;font-size:15px;line-height:1.4;color:rgba(255,255,255,.75);}
#nsws-crate .wheel .bets{display:flex;flex-wrap:wrap;gap:0;margin:0 0 10px;}
#nsws-crate .wheel .bets>.button{margin:0;font-size:18px;padding:5px 14px;}
#nsws-crate .wheel .bets>.button.on{background:var(--button-hover-color);box-shadow:inset 0 -3px #ffc94a;}
#nsws-crate .wheel .bets>.button:disabled{opacity:.35;}
#nsws-crate .wheel .side>.button{margin:0;font-size:22px;padding:7px 20px;}
#nsws-crate .wheel .side>.button.main{box-shadow:inset 0 -3px #ffc94a;}
#nsws-crate .wheel .side>.button:disabled{opacity:.35;}
#nsws-crate .wheel .result{min-height:52px;margin-top:12px;font-size:20px;}
#nsws-crate .wheel .result>small{display:block;font-size:14px;font-style:italic;color:rgba(255,255,255,.65);}
#nsws-crate .wheel .result.win{color:#96ff96;}
#nsws-crate .wheel .result.lose{color:#ff9696;}
@media (max-width:620px){#nsws-crate .won{flex-direction:column;align-items:flex-start;}#nsws-crate .won>img{width:160px;height:160px;}#nsws-crate .top>small{display:none;}}
.nsws-crate-chat{color:rgba(255,255,255,.8);}
.nsws-crate-chat>b{font-weight:normal;color:var(--rc);}
`;

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function button(text, onClick, className) {
        const b = el("button", "button" + (className ? " " + className : ""), text);
        b.addEventListener("click", (e) => {
            e.stopPropagation();
            window.__nswsUIClick?.();
            onClick(b);
        });
        return b;
    }

    function plural(n, one, many = one + "s") {
        return n.toLocaleString() + " " + (n === 1 ? one : many);
    }

    function today() {
        const d = new Date();
        return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
    }

    // FNV-1a, only to keep each profile's inventory apart without writing the token into a storage key.
    function hashText(text) {
        let h = 0x811c9dc5;
        for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
        return (h >>> 0).toString(36);
    }

    function parts() {
        return window.__nswsCrateParts;
    }

    function partOf(item) {
        return parts()?.PARTS[item.k]?.[item.n] ?? null;
    }

    function allParts() {
        return Object.values(parts()?.PARTS ?? {}).flat();
    }

    function profile() {
        try {
            return window.__nswsCup?.services?.().profiles?.getCurrentUserProfile?.() ?? null;
        } catch {
            return null;
        }
    }

    function token() {
        return profile()?.token ?? window.__nswsProfileToken?.() ?? null;
    }

    function newId() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    // v12.11 crates held paint skins; whatever a profile had then becomes Bolts.
    function fromV1(t) {
        let bolts = START_BOLTS;
        try {
            const old = JSON.parse(localStorage.getItem(OLD_STORE + hashText(t)));
            if (old && Array.isArray(old.items)) {
                const tier = (i) => (i < 7 ? 0 : i < 12 ? 1 : i < 15 ? 2 : i < 17 ? 3 : 4);
                bolts += (old.crates ?? 0) * PRICE + (old.keys ?? 0) * 25 + old.items.reduce((sum, x) => sum + RARITIES[tier(x.i)].sell, 0);
            }
        } catch {}
        return bolts;
    }

    let cached = null;
    function load() {
        const t = token();
        if (!t || !parts()) return null;
        const key = STORE + hashText(t);
        if (cached?.key === key) return cached.state;
        let state = null;
        try {
            state = JSON.parse(localStorage.getItem(key));
        } catch {}
        if (!state || typeof state !== "object" || !Array.isArray(state.items)) {
            state = { v: 2, bolts: fromV1(t), items: [], prev: {}, equipped: {}, day: today(), finBolts: 0, pbCount: 0, pbTracks: {}, notes: true, opened: 0, pending: [] };
        }
        state.items = state.items.filter((x) => partOf(x));
        state.pending ??= [];
        state.prev ??= {};
        state.equipped ??= {};
        cached = { key, state };
        return state;
    }

    function save() {
        if (!cached) return;
        try {
            localStorage.setItem(cached.key, JSON.stringify(cached.state));
        } catch {}
    }

    window.addEventListener("storage", (e) => {
        if (cached && e.key === cached.key) {
            cached = null;
            render();
        }
    });

    function rollDay(state) {
        const d = today();
        if (state.day !== d) {
            state.day = d;
            state.finBolts = 0;
            state.pbCount = 0;
            state.pbTracks = {};
            state.wheelSpins = 0;
        }
    }

    function CarStyle() {
        return window.__clipCarStyleClass;
    }

    function currentStyle() {
        return garage?.hooks?.current?.() ?? profile()?.carStyle ?? null;
    }

    function withPart(style, kind, index) {
        const C = CarStyle();
        if (!C) return null;
        const s = style ?? C.deserializeSafe("");
        const v = { pattern: s.pattern, rims: s.rims, exhaust: s.exhaust, body: s.body };
        v[CRATE[kind].field] = index;
        return new C(v.pattern, v.rims, v.exhaust, s.primaryHex, s.secondaryHex, s.frameHex, s.rimsHex, v.body);
    }

    function wornIndex(kind, style = currentStyle()) {
        return style ? style[CRATE[kind].field] : null;
    }

    function isWorn(item, style = currentStyle()) {
        const p = partOf(item);
        return !!p && wornIndex(item.k, style) === p.index;
    }

    function fullName(item) {
        const name = partOf(item)?.name ?? "?";
        if (item.st == null) return name;
        return name.startsWith("\u2605 ") ? "\u2605 StatTrak\u2122 " + name.slice(2) : "StatTrak\u2122 " + name;
    }

    function rollRarity(rand = Math.random()) {
        let acc = 0;
        for (let i = 0; i < RARITIES.length; i++) {
            acc += RARITIES[i].odds;
            if (rand < acc) return i;
        }
        return 0;
    }

    function pick(list) {
        return list[Math.floor(Math.random() * list.length)];
    }

    function rollPart(kind, rarity) {
        const list = parts().PARTS[kind];
        let choices = list.map((p, n) => [p, n]).filter(([p]) => R[p.r] === rarity);
        if (!choices.length) choices = list.map((p, n) => [p, n]);
        return pick(choices)[1];
    }

    function makeItem(kind, rarity, statTrak = Math.random() < 0.1) {
        return { u: newId(), k: kind, n: rollPart(kind, rarity), st: statTrak ? 0 : null, at: Date.now() };
    }

    function toast(text) {
        const state = load();
        if (state && !state.notes) return;
        if (window.__nswsTags?.toast) return window.__nswsTags.toast(text);
        console.info(text);
    }

    function onFinish() {
        const state = load();
        if (!state) return;
        rollDay(state);
        const style = profile()?.carStyle ?? null;
        for (const c of CRATES) {
            const item = state.items.find((x) => x.u === state.equipped[c.kind]);
            if (item && item.st != null && isWorn(item, style)) item.st++;
        }
        const before = state.bolts;
        if (state.finBolts < FINISH_BOLTS_PER_DAY) {
            state.bolts += FINISH_BOLTS;
            state.finBolts += FINISH_BOLTS;
        }
        save();
        if (before < PRICE && state.bolts >= PRICE) setTimeout(() => toast("You have " + PRICE + " Bolts: buy a crate in Garage \u2192 Crates."), 1800);
        render();
    }

    function onNewPb(e) {
        const state = load();
        const track = e.detail?.track;
        if (!state || !track) return;
        rollDay(state);
        if (state.pbTracks[track] || state.pbCount >= PB_REWARDS_PER_DAY) return;
        state.pbTracks[track] = 1;
        state.pbCount++;
        state.bolts += PB_BOLTS;
        save();
        setTimeout(() => toast("+" + PB_BOLTS + " Bolts for a new PB."), 2600);
        render();
    }

    // ---- How many of each part exist across all players (proxy/src/crates.js).

    let counts = null;
    let countsAt = 0;
    let countsLoading = null;

    function api() {
        return window.__nswsApiBase || null;
    }

    function loadCounts() {
        if (countsLoading) return countsLoading;
        if ((counts && Date.now() - countsAt < COUNTS_MS) || !api()) return Promise.resolve(counts);
        countsLoading = fetch(api() + "nsws/crates/counts")
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
                if (data?.counts) {
                    counts = data.counts;
                    countsAt = Date.now();
                }
                return counts;
            })
            .catch(() => counts)
            .finally(() => {
                countsLoading = null;
                render();
                refreshOverlayCounts();
            });
        return countsLoading;
    }

    function existText(part) {
        return counts ? (counts[part.g] ?? 0).toLocaleString() : "\u2014";
    }

    let reportTimer = 0;
    function queue(state, events) {
        state.pending.push(...events);
        clearTimeout(reportTimer);
        reportTimer = setTimeout(report, REPORT_DELAY_MS);
    }

    async function report() {
        const state = load();
        const t = token();
        if (!state || !t || !state.pending.length || !api()) return;
        const events = state.pending.slice(0, 60);
        try {
            const r = await fetch(api() + "nsws/crates/report", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token: t, events }),
                keepalive: true,
            });
            if (!r.ok) return;
            const data = await r.json();
            const done = new Set(Array.isArray(data?.done) ? data.done : []);
            const fresh = load();
            if (!fresh) return;
            const sent = new Set(events.map((e) => e.u + ":" + e.e));
            fresh.pending = fresh.pending.filter((e) => !(done.has(e.u) && sent.has(e.u + ":" + e.e)));
            save();
            countsAt = 0;
        } catch {}
    }

    // ---- Sound.

    let audio = null;
    function volume() {
        const master = parseFloat(window.__nswsSetting?.("MasterVolume") ?? "1");
        const sfx = parseFloat(window.__nswsSetting?.("SoundEffectVolume") ?? "1");
        const v = (Number.isFinite(master) ? master : 1) * (Number.isFinite(sfx) ? sfx : 1);
        return Math.max(0, Math.min(1, v));
    }

    function blip(freq, at, length, gain, type = "triangle") {
        const v = volume();
        if (!v) return;
        try {
            audio ??= new (window.AudioContext || window.webkitAudioContext)();
            const t = audio.currentTime + at;
            const osc = audio.createOscillator();
            const g = audio.createGain();
            osc.type = type;
            osc.frequency.setValueAtTime(freq, t);
            g.gain.setValueAtTime(0.0001, t);
            g.gain.exponentialRampToValueAtTime(gain * v, t + 0.004);
            g.gain.exponentialRampToValueAtTime(0.0001, t + length);
            osc.connect(g).connect(audio.destination);
            osc.start(t);
            osc.stop(t + length + 0.02);
        } catch {}
    }

    function tick() {
        blip(1500 + Math.random() * 200, 0, 0.035, 0.06, "square");
    }

    function fanfare(rarity) {
        const notes = [[523, 659], [523, 659, 784], [523, 659, 784, 1047], [392, 523, 659, 784, 1047], [523, 659, 784, 1047, 1319, 1568]][rarity];
        notes.forEach((f, i) => blip(f, i * 0.09, 0.5, 0.12));
    }

    // ---- Thumbnails: the part on the player's own car, from where it shows best.

    function turn(yaw, pitch) {
        const a = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
        const b = [Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2)];
        return [
            a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
            a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
            a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
            a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
        ];
    }
    const VIEWS = {
        patterns: [null, null],
        rims: [turn(Math.PI / 2 + 0.35, -0.2), { look: [0.75, 0, 1.38], zoom: 2 }],
        exhausts: [turn(Math.PI * 0.8, -0.3), { look: [0, -0.15, -1.7], zoom: 0.95 }],
        bodies: [turn(Math.PI / 2 - 0.5, -0.3), null],
    };

    const thumbs = new Map();
    function thumb(kind, style) {
        if (!style || !window.__nswsCarThumb) return Promise.resolve("");
        const key = kind + ":" + style.serialize();
        if (!thumbs.has(key)) {
            if (thumbs.size > 120) thumbs.delete(thumbs.keys().next().value);
            const [t, close] = VIEWS[kind];
            thumbs.set(key, Promise.resolve(window.__nswsCarThumb(style.serialize(), t ?? undefined, close ?? undefined)).catch(() => ""));
        }
        return thumbs.get(key);
    }

    function partImage(kind, n, base) {
        const img = el("img");
        img.alt = "";
        img.draggable = false;
        const p = parts().PARTS[kind][n];
        thumb(kind, withPart(base, kind, p.index)).then((src) => {
            if (src) img.src = src;
        });
        return img;
    }

    function tileFor(kind, n, base, hideGold, withCount) {
        const p = parts().PARTS[kind][n];
        const tile = el("div", "tile");
        tile.style.setProperty("--rc", RARITIES[R[p.r]].color);
        if (p.r === "gold" && hideGold) {
            tile.append(el("div", "star", "\u2605"), el("span", null, "Rare Special Item"));
        } else {
            tile.append(partImage(kind, n, base), el("span", null, p.name));
        }
        if (withCount) {
            const small = el("small", null, existText(p) + " exist");
            small.dataset.g = p.g;
            tile.appendChild(small);
        }
        return tile;
    }

    // ---- Overlays.

    let view = null;

    function closeOverlay() {
        if (!view) return;
        cancelAnimationFrame(view.raf);
        view.overlay.remove();
        window.removeEventListener("keydown", onOverlayKey, true);
        view = null;
        render();
    }

    function onOverlayKey(e) {
        if (e.key !== "Escape" || !view) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (view.spinning) view.skip?.();
        else closeOverlay();
    }

    function boltsText() {
        const state = load();
        return state ? plural(state.bolts, "Bolt") : "";
    }

    function overlay(title) {
        closeOverlay();
        const root = el("div");
        root.id = "nsws-crate";
        const box = el("div", "box");
        box.tabIndex = -1;
        const top = el("div", "top");
        const body = el("div", "body");
        top.append(el("h1", null, title), el("small", null, boltsText()), button("Close", () => (view?.spinning ? view.skip?.() : closeOverlay())));
        box.append(top, body);
        root.appendChild(box);
        root.addEventListener("pointerdown", (e) => {
            if (e.target === root && !view?.spinning) closeOverlay();
        });
        for (const type of ["keydown", "keyup", "keypress"]) root.addEventListener(type, (e) => e.stopPropagation());
        document.body.appendChild(root);
        window.addEventListener("keydown", onOverlayKey, true);
        box.focus();
        view = { overlay: root, top, body, raf: 0, spinning: false };
        loadCounts();
        return view;
    }

    function refreshTop() {
        if (view) view.top.querySelector("small").textContent = boltsText();
    }

    function refreshOverlayCounts() {
        if (!view) return;
        for (const node of view.body.querySelectorAll("[data-g]")) {
            const p = allParts().find((x) => String(x.g) === node.dataset.g);
            if (p) node.textContent = node.dataset.bare ? existText(p) : existText(p) + " exist";
        }
    }

    function oddsText(kind, p) {
        const same = parts().PARTS[kind].filter((x) => x.r === p.r).length;
        const pct = (RARITIES[R[p.r]].odds / same) * 100;
        return (pct >= 1 ? pct.toFixed(1) : pct.toFixed(2)) + "%";
    }

    function openShop() {
        const state = load();
        if (!state) return;
        const v = overlay("Crates");
        const base = currentStyle();
        v.body.appendChild(el("h2", null, "Each crate costs " + PRICE + " Bolts and holds one part you can't get anywhere else"));
        const shop = el("div", "shop");
        for (const c of CRATES) {
            const list = parts().PARTS[c.kind];
            const tile = el("div", "tile");
            const showcase = Math.max(0, list.findIndex((p) => p.r === "covert"));
            tile.append(partImage(c.kind, showcase, base), el("span", null, c.name), el("small", null, list.length + " " + c.label.toLowerCase() + " \u00b7 " + PRICE + " Bolts"));
            tile.addEventListener("click", () => {
                window.__nswsUIClick?.();
                openCrate(c.kind);
            });
            shop.appendChild(tile);
        }
        v.body.appendChild(shop);
        v.body.appendChild(el("p", "fine", "Bolts come from playing: +" + FINISH_BOLTS + " for each finished run (up to " + FINISH_BOLTS_PER_DAY + " a day) and +" + PB_BOLTS
            + " for a new PB (up to " + PB_REWARDS_PER_DAY + " a day, one per track). Parts are looks only: nothing here changes how a car drives, and nothing costs real money."));
    }

    function openCrate(kind) {
        const state = load();
        if (!state) return;
        const c = CRATE[kind];
        const v = overlay(c.name);
        const base = currentStyle();
        v.body.appendChild(el("h2", null, "Contains one of these \u00b7 the small number is how many exist across all players"));
        const grid = el("div", "grid");
        const list = parts().PARTS[kind];
        list.forEach((p, n) => {
            if (p.r !== "gold") grid.appendChild(tileFor(kind, n, base, true, true));
        });
        list.forEach((p, n) => {
            if (p.r === "gold") grid.appendChild(tileFor(kind, n, base, true, true));
        });
        v.body.appendChild(grid);
        const actions = el("div", "actions");
        const buy = button("Buy and open \u2014 " + PRICE + " Bolts", () => spin(kind), "main");
        buy.disabled = state.bolts < PRICE;
        actions.append(buy, button("Back", () => openShop()));
        actions.appendChild(el("span", "msg", state.bolts < PRICE ? "You have " + plural(state.bolts, "Bolt") + ". Finish runs and set PBs to earn more." : ""));
        v.body.appendChild(actions);
    }

    function spin(kind) {
        const state = load();
        if (!state || state.bolts < PRICE || !view) return;
        state.bolts -= PRICE;
        state.opened = (state.opened ?? 0) + 1;
        const item = makeItem(kind, rollRarity());
        const kept = state.items.length < MAX_ITEMS;
        if (kept) {
            state.items.push(item);
            queue(state, [{ u: item.u, i: partOf(item).g, e: 1 }]);
        }
        save();

        const v = view;
        const base = currentStyle();
        refreshTop();
        v.body.textContent = "";
        const reel = el("div", "reel");
        const strip = el("div", "strip");
        const COUNT = 56, WIN = 48;
        for (let n = 0; n < COUNT; n++) {
            const idx = n === WIN ? item.n : rollPart(kind, rollRarity());
            strip.appendChild(tileFor(kind, idx, base, n !== WIN, false));
        }
        reel.append(strip, el("div", "mark"));
        v.body.appendChild(reel);
        const actions = el("div", "actions");
        actions.appendChild(button("Skip", () => v.skip()));
        v.body.appendChild(actions);

        const width = reel.clientWidth || 900;
        const step = TILE + GAP;
        const end = WIN * step + TILE / 2 - width / 2 + (Math.random() - 0.5) * TILE * 0.8;
        const started = performance.now();
        let lastIndex = -1;
        v.spinning = true;
        const finish = () => {
            if (!v.spinning) return;
            v.spinning = false;
            cancelAnimationFrame(v.raf);
            strip.style.transform = "translateX(" + -end + "px)";
            setTimeout(() => view === v && reveal(item, kind, kept), 350);
        };
        v.skip = finish;
        const frame = (now) => {
            if (!v.spinning) return;
            const t = Math.min(1, (now - started) / SPIN_MS);
            const x = end * (1 - Math.pow(1 - t, 4));
            strip.style.transform = "translateX(" + -x + "px)";
            const index = Math.floor((x + width / 2) / step);
            if (index !== lastIndex) {
                if (lastIndex >= 0) tick();
                lastIndex = index;
            }
            if (t < 1) v.raf = requestAnimationFrame(frame);
            else finish();
        };
        v.raf = requestAnimationFrame(frame);
    }

    function reveal(item, kind, kept = true) {
        const state = load();
        if (!state || !view) return;
        const p = partOf(item);
        const rarity = R[p.r];
        const v = view;
        v.body.textContent = "";
        const won = el("div", "won pop");
        won.style.setProperty("--rc", RARITIES[rarity].color);
        const text = el("div");
        text.appendChild(el("div", "kind", RARITIES[rarity].name + " " + CRATE[item.k].one + (p.r === "gold" ? " \u2605" : "")));
        const name = el("div", "nm" + (item.st != null ? " st" : ""), fullName(item));
        text.appendChild(name);
        const meta = el("div", "meta");
        const exist = el("span", null, existText(p));
        exist.dataset.g = p.g;
        exist.dataset.bare = "1";
        meta.append(exist, " exist \u00b7 you own " + state.items.filter((x) => x.k === item.k && x.n === item.n).length);
        text.appendChild(meta);
        text.appendChild(el("div", "quip", pick(QUIPS[rarity])));
        won.append(partImage(item.k, item.n, currentStyle()), text);
        v.body.appendChild(won);
        fanfare(rarity);

        const actions = el("div", "actions");
        if (kept) {
            const eq = button(isWorn(item) ? "Equipped" : "Equip", (b) => {
                equip(item);
                b.disabled = true;
                b.textContent = "Equipped";
            }, "main");
            eq.disabled = isWorn(item);
            actions.appendChild(eq);
        }
        const chat = window.__nswsChat;
        if (chat?.isEnabled?.() && chat.feed?.active?.()) {
            actions.appendChild(button("Show in chat", (b) => {
                b.disabled = true;
                chat.feed.post(chatText(item)).then(() => (b.textContent = "Posted"), (err) => {
                    b.disabled = false;
                    const msg = actions.querySelector(".msg");
                    if (msg) msg.textContent = err?.message ?? "Message not sent.";
                });
            }));
        }
        if (kind) {
            const again = button("Open another \u2014 " + PRICE + " Bolts", () => openCrate(kind));
            again.disabled = state.bolts < PRICE;
            actions.appendChild(again);
        }
        actions.appendChild(button("Done", () => closeOverlay()));
        actions.appendChild(el("span", "msg", kept ? "" : "Your inventory is full, so this one wasn't kept."));
        refreshTop();
        v.body.appendChild(actions);
    }

    function chatText(item) {
        return "\u{1F4E6} opened a crate and found: " + fullName(item) + " [crate:" + partOf(item).g + "." + (item.st != null ? 1 : 0) + "]";
    }

    // Draws "[crate:g.t]" chat messages as an unboxing line; anything else stays plain text.
    function chatLine(text) {
        const m = /^\u{1F4E6} opened a crate and found: .* \[crate:(\d{1,3})\.([01])\]$/u.exec(text ?? "");
        if (!m || !parts()) return null;
        const p = allParts().find((x) => x.g === +m[1]);
        if (!p) return null;
        const item = { k: p.kind, n: parts().PARTS[p.kind].indexOf(p), st: m[2] === "1" ? 0 : null };
        const line = el("span", "nsws-crate-chat", "opened a " + CRATE[p.kind].name + " and found: ");
        const name = el("b", null, fullName(item));
        name.style.setProperty("--rc", RARITIES[R[p.r]].color);
        name.title = RARITIES[R[p.r]].name + " " + CRATE[p.kind].one;
        line.appendChild(name);
        return line;
    }

    function applyStyle(style) {
        if (garage?.hooks?.apply) return garage.hooks.apply(style);
        const services = window.__nswsCup?.services?.();
        const p = services?.profiles?.getCurrentUserProfile?.();
        if (!services || !p) return;
        services.profiles.setCarStyle(style);
        services.api?.submitUserProfile?.(p.token, p.nickname, p.countryCode, style)?.catch?.((e) => console.warn(e));
    }

    function equip(item) {
        const state = load();
        const p = partOf(item);
        if (!state || !p) return;
        const current = currentStyle();
        const now = wornIndex(item.k, current);
        if (now != null && !parts().byIndex(item.k, now)) state.prev[item.k] = now;
        state.equipped[item.k] = item.u;
        save();
        const style = withPart(current, item.k, p.index);
        if (style) applyStyle(style);
        render();
    }

    // Back to the stock part the car had before its first crate part in that slot.
    function unequip(kind) {
        const state = load();
        const C = CarStyle();
        if (!state || !C) return;
        const defaults = { patterns: C.defaultPattern, rims: C.defaultRims, exhausts: C.defaultExhaust, bodies: C.defaultBody };
        const back = state.prev[kind] ?? defaults[kind];
        delete state.equipped[kind];
        save();
        const style = withPart(currentStyle(), kind, back);
        if (style) applyStyle(style);
        render();
    }

    function tradeUp() {
        const state = load();
        if (!state) return;
        const v = overlay("Trade up contract");
        const current = currentStyle();
        v.body.appendChild(el("h2", null, "Sign away parts of one grade for one of the next grade up"));
        for (let r = 0; r < RARITIES.length - 1; r++) {
            const need = r === R.covert ? 5 : 10;
            const pool = state.items.filter((x) => R[partOf(x).r] === r && !isWorn(x, current));
            const row = el("div", "line");
            const left = el("div", null, need + " " + RARITIES[r].name + " \u2192 1 " + RARITIES[r + 1].name);
            left.style.color = RARITIES[r + 1].color;
            left.appendChild(el("small", null, "You have " + pool.length + " to spare (parts on your car are kept). The new part comes from the crate of one of the parts signed."));
            const sign = button("Sign", () => contract(r, need));
            sign.disabled = pool.length < need;
            row.append(left, sign);
            v.body.appendChild(row);
        }
        v.body.appendChild(el("p", "fine", "Duplicates go first. StatTrak\u2122 carries over only if every part signed is StatTrak\u2122."));
    }

    function contract(rarity, need) {
        const state = load();
        if (!state || !view) return;
        const current = currentStyle();
        const pool = state.items.filter((x) => R[partOf(x).r] === rarity && !isWorn(x, current));
        if (pool.length < need) return;
        const seen = new Map();
        for (const x of pool) seen.set(x.k + x.n, (seen.get(x.k + x.n) ?? 0) + 1);
        pool.sort((a, b) => seen.get(b.k + b.n) - seen.get(a.k + a.n));
        const used = pool.slice(0, need);
        const item = makeItem(pick(used).k, rarity + 1, used.every((x) => x.st != null));
        const gone = new Set(used.map((x) => x.u));
        state.items = state.items.filter((x) => !gone.has(x.u));
        state.items.push(item);
        queue(state, [...used.map((x) => ({ u: x.u, e: -1 })), { u: item.u, i: partOf(item).g, e: 1 }]);
        save();
        view.top.querySelector("h1").textContent = "Contract signed";
        reveal(item, null);
    }

    function wheelSvg() {
        const ns = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(ns, "svg");
        svg.setAttribute("viewBox", "-100 -100 200 200");
        const step = 360 / WHEEL.length;
        const point = (deg, r) => [Math.sin((deg * Math.PI) / 180) * r, -Math.cos((deg * Math.PI) / 180) * r];
        WHEEL.forEach((s, i) => {
            const a0 = i * step - step / 2, a1 = a0 + step;
            const [x0, y0] = point(a0, 96), [x1, y1] = point(a1, 96);
            const path = document.createElementNS(ns, "path");
            path.setAttribute("d", "M0 0 L" + x0.toFixed(2) + " " + y0.toFixed(2) + " A96 96 0 0 1 " + x1.toFixed(2) + " " + y1.toFixed(2) + " Z");
            path.setAttribute("fill", s.color);
            path.setAttribute("stroke", "#0d1230");
            path.setAttribute("stroke-width", "1.2");
            svg.appendChild(path);
            const text = document.createElementNS(ns, "text");
            text.setAttribute("x", "0");
            text.setAttribute("y", "0");
            text.setAttribute("transform", "rotate(" + i * step + ") translate(0 -57) rotate(-90)");
            text.setAttribute("text-anchor", "middle");
            text.setAttribute("dominant-baseline", "middle");
            text.setAttribute("fill", s.x === 4 ? "#1b1300" : "#fff");
            text.setAttribute("font-size", s.label.length > 6 ? "9" : "11");
            text.setAttribute("style", "font-family:inherit");
            text.textContent = s.label;
            svg.appendChild(text);
        });
        const rim = document.createElementNS(ns, "circle");
        rim.setAttribute("r", "97");
        rim.setAttribute("fill", "none");
        rim.setAttribute("stroke", "#ffc94a");
        rim.setAttribute("stroke-width", "3");
        svg.appendChild(rim);
        const hub = document.createElementNS(ns, "circle");
        hub.setAttribute("r", "14");
        hub.setAttribute("fill", "#112052");
        hub.setAttribute("stroke", "#ffc94a");
        hub.setAttribute("stroke-width", "2");
        svg.appendChild(hub);
        return svg;
    }

    // The outcome is settled and saved before the wheel moves, so closing the page mid-spin changes nothing.
    function wheel() {
        const state = load();
        if (!state) return;
        rollDay(state);
        const v = overlay("Wheel of Bolts");
        const box = el("div", "wheel");
        const disc = el("div", "disc");
        const svg = wheelSvg();
        disc.append(el("div", "pin"), svg);
        const side = el("div", "side");
        const left = () => WHEEL_SPINS_PER_DAY - (state.wheelSpins ?? 0);
        side.appendChild(el("p", null, "Bet some Bolts and spin. Whatever the pointer lands on multiplies your bet: BANKRUPT loses it, HALF gives half back, PUSH gives it back, and the rest pay more. " + WHEEL_SPINS_PER_DAY + " spins a day."));
        const bets = el("div", "bets");
        let bet = WHEEL_BETS.find((b) => b <= state.bolts) ?? WHEEL_BETS[0];
        const betButtons = WHEEL_BETS.map((b) => {
            const btn = button(String(b), () => {
                bet = b;
                paint();
            });
            bets.appendChild(btn);
            return btn;
        });
        side.appendChild(bets);
        const go = button("Spin", () => spinWheel(), "main");
        side.appendChild(go);
        const result = el("div", "result");
        side.appendChild(result);
        const spinsLeft = el("p", null, "");
        side.appendChild(spinsLeft);
        box.append(disc, side);
        v.body.appendChild(box);
        v.body.appendChild(el("p", "fine", "Bolts only. Nothing here costs or pays real money."));

        let angle = 0;
        function paint() {
            betButtons.forEach((btn, i) => {
                btn.classList.toggle("on", WHEEL_BETS[i] === bet);
                btn.disabled = v.spinning || WHEEL_BETS[i] > state.bolts;
            });
            go.disabled = v.spinning || left() <= 0 || bet > state.bolts;
            go.textContent = left() <= 0 ? "Back tomorrow" : "Spin \u2014 " + bet + " Bolts";
            spinsLeft.textContent = left() > 0 ? plural(left(), "spin") + " left today" : "No spins left today.";
        }

        function spinWheel() {
            if (v.spinning || left() <= 0 || bet > state.bolts) return;
            const i = Math.floor(Math.random() * WHEEL.length);
            const seg = WHEEL[i];
            const stake = bet;
            const payout = Math.round(stake * seg.x);
            state.bolts += payout - stake;
            state.wheelSpins = (state.wheelSpins ?? 0) + 1;
            save();
            refreshTop();
            render();
            result.className = "result";
            result.textContent = "";
            const step = 360 / WHEEL.length;
            const jitter = (Math.random() - 0.5) * step * 0.7;
            const start = angle;
            const target = start + 360 * 5 + ((((-i * step - start) % 360) + 720) % 360) + jitter;
            const t0 = performance.now();
            let last = Math.floor(start / step);
            v.spinning = true;
            paint();
            const done = () => {
                v.spinning = false;
                angle = target;
                svg.style.transform = "rotate(" + target + "deg)";
                const net = payout - stake;
                result.className = "result " + (net > 0 ? "win" : net < 0 ? "lose" : "");
                result.textContent = seg.label + ": " + (net > 0 ? "+" + net : net === 0 ? "\u00b10" : String(net)) + " Bolts";
                result.appendChild(el("small", null, pick(WHEEL_QUIPS[seg.x])));
                if (seg.x >= 2) fanfare(seg.x === 4 ? 4 : 2);
                else if (seg.x === 0) blip(160, 0, 0.5, 0.12, "sawtooth");
                if (bet > state.bolts) bet = [...WHEEL_BETS].reverse().find((b) => b <= state.bolts) ?? WHEEL_BETS[0];
                paint();
            };
            v.skip = () => {
                if (!v.spinning) return;
                cancelAnimationFrame(v.raf);
                done();
            };
            const frame = (now) => {
                if (!v.spinning) return;
                const k = Math.min(1, (now - t0) / WHEEL_MS);
                const a = start + (target - start) * (1 - Math.pow(1 - k, 3.2));
                svg.style.transform = "rotate(" + a + "deg)";
                const tickAt = Math.floor((a + step / 2) / step);
                if (tickAt !== last) {
                    last = tickAt;
                    tick();
                }
                if (k < 1) v.raf = requestAnimationFrame(frame);
                else done();
            };
            v.raf = requestAnimationFrame(frame);
        }

        paint();
    }

    function collection() {
        const state = load();
        if (!state) return;
        const v = overlay("Collection");
        let owned = 0;
        for (const p of allParts()) if (state.items.some((x) => x.k === p.kind && parts().PARTS[p.kind][x.n] === p)) owned++;
        v.body.appendChild(el("h2", null, "You've found " + owned + " of " + allParts().length + " parts. Exist = how many are out there across all players."));
        for (const c of CRATES) {
            v.body.appendChild(el("h2", null, c.name));
            const table = el("table");
            const head = el("tr");
            for (const t of ["Part", "Odds", "Exist", "You own"]) head.appendChild(el("th", null, t));
            table.appendChild(head);
            const list = parts().PARTS[c.kind].map((p, n) => [p, n]).sort((a, b) => R[b[0].r] - R[a[0].r]);
            for (const [p, n] of list) {
                const tr = el("tr");
                const name = el("td", null, p.name);
                name.style.setProperty("--rc", RARITIES[R[p.r]].color);
                const exist = el("td", null, existText(p));
                exist.dataset.g = p.g;
                exist.dataset.bare = "1";
                const mine = state.items.filter((x) => x.k === c.kind && x.n === n).length;
                tr.append(name, el("td", null, oddsText(c.kind, p)), exist, el("td", mine ? "mine" : null, mine ? String(mine) : "\u2014"));
                table.appendChild(tr);
            }
            v.body.appendChild(table);
        }
        v.body.appendChild(el("p", "fine", "Counts refresh every few minutes. Selling a part or signing it into a trade up takes it out of the count."));
    }

    // ---- The Garage tab.

    let garage = null;

    function mountGarage(panel, hooks) {
        panel.classList.add("nsws-crates");
        panel.textContent = "";
        garage = { panel, hooks: hooks ?? {}, bar: el("div", "bar"), preview: el("div", "preview"), selected: null, armed: false };
        panel.append(garage.preview, garage.bar);
        loadCounts();
        if (load()?.pending.length) report();
        render();
    }

    // The garage car shows the selected part while this tab is open; this puts the real car back.
    function leaveGarage() {
        if (!garage) return;
        const current = garage.hooks.current?.();
        if (current && garage.selected) window.__nswsGarageCar?.(current);
        garage.selected = null;
        garage.armed = false;
        render();
    }

    function groupKey(x) {
        return x.k + ":" + x.n + ":" + (x.st != null ? "st" : "");
    }

    function render() {
        const g = garage;
        if (!g) return;
        if (!g.panel.isConnected) {
            garage = null;
            return;
        }
        const state = load();
        const scroll = g.bar.querySelector(".list")?.scrollTop ?? 0;
        g.bar.textContent = "";
        g.preview.textContent = "";
        if (!state) {
            g.bar.appendChild(el("div", "head", "Make a profile first."));
            g.preview.style.display = "none";
            return;
        }
        rollDay(state);
        const current = g.hooks.current?.() ?? null;

        const head = el("div", "head");
        const count = el("div", "count", state.bolts.toLocaleString());
        count.appendChild(el("small", null, state.bolts === 1 ? "Bolt" : "Bolts"));
        head.appendChild(count);
        head.appendChild(el("div", "sub", "Earn Bolts by finishing runs and setting PBs. A crate costs " + PRICE + " and holds a part you can't get anywhere else. Looks only, never speed."));
        head.appendChild(button("Crates", () => openShop(), "main"));
        head.appendChild(button("Trade up", () => tradeUp()));
        head.appendChild(button("Collection", () => collection()));
        head.appendChild(button("Wheel", () => wheel()));
        g.bar.appendChild(head);

        const list = el("div", "list");
        if (!state.items.length) list.appendChild(el("p", null, "No parts yet. Open a crate and they land here."));
        const groups = new Map();
        for (const x of state.items) {
            const key = groupKey(x);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(x);
        }
        for (const c of CRATES) {
            const rows = [...groups.values()].filter((xs) => xs[0].k === c.kind)
                .sort((a, b) => R[partOf(b[0]).r] - R[partOf(a[0]).r] || a[0].n - b[0].n);
            if (!rows.length) continue;
            list.appendChild(el("h3", null, c.label));
            for (const xs of rows) {
                const x = xs[0];
                const p = partOf(x);
                const on = isWorn(x, current);
                const key = groupKey(x);
                const row = el("button", "item" + (on ? " on" : "") + (g.selected === key ? " selected" : ""));
                row.style.setProperty("--rc", RARITIES[R[p.r]].color);
                row.append(el("span", "nm" + (x.st != null ? " st" : ""), fullName(x)));
                if (xs.length > 1) row.appendChild(el("span", "x", "\u00d7" + xs.length));
                row.appendChild(el("span", "w", on ? "Equipped" : RARITIES[R[p.r]].name));
                row.addEventListener("click", () => {
                    window.__nswsUIClick?.();
                    g.selected = g.selected === key ? null : key;
                    g.armed = false;
                    const style = g.selected ? withPart(current, x.k, p.index) : current;
                    if (style) window.__nswsGarageCar?.(style);
                    render();
                });
                list.appendChild(row);
            }
        }
        g.bar.appendChild(list);
        list.scrollTop = scroll;

        const foot = el("div", "foot");
        foot.appendChild(el("span", null, state.opened ? plural(state.opened, "crate") + " opened" : ""));
        foot.appendChild(button(state.notes ? "Notes: On" : "Notes: Off", () => {
            state.notes = !state.notes;
            save();
            render();
        }));
        g.bar.appendChild(foot);

        const xs = g.selected ? groups.get(g.selected) : null;
        g.preview.style.display = xs ? "" : "none";
        if (!xs) {
            g.selected = null;
            return;
        }
        const x = xs[0];
        const p = partOf(x);
        const rarity = RARITIES[R[p.r]];
        g.preview.style.setProperty("--rc", rarity.color);
        const cap = el("div", "cap", fullName(x));
        cap.appendChild(el("small", null, rarity.name + " " + CRATE[x.k].one + " \u00b7 " + CRATE[x.k].name));
        g.preview.appendChild(cap);
        const info = el("div", "info");
        const owned = state.items.filter((y) => y.k === x.k && y.n === x.n).length;
        info.appendChild(el("div", null, existText(p) + " exist \u00b7 you own " + owned));
        if (x.st != null) info.appendChild(el("div", "st", "StatTrak\u2122 finishes: " + Math.max(...xs.map((y) => y.st)).toLocaleString()));
        info.appendChild(el("div", "note", p.note));
        const on = isWorn(x, current);
        info.appendChild(on ? button("Unequip", () => {
            g.selected = null;
            unequip(x.k);
        }) : button("Equip", () => equip(xs.slice().sort((a, b) => (b.st ?? -1) - (a.st ?? -1))[0])));
        const value = rarity.sell;
        const lastOnCar = on && owned === 1;
        const sell = button(g.armed ? "Sure? Sell for " + value : "Sell one \u2014 " + value + " Bolts", () => {
            if (!g.armed) {
                g.armed = true;
                return render();
            }
            const victim = xs.slice().sort((a, b) => (a.st ?? -1) - (b.st ?? -1))[0];
            state.items = state.items.filter((y) => y !== victim);
            state.bolts += value;
            queue(state, [{ u: victim.u, e: -1 }]);
            g.armed = false;
            if (xs.length === 1) {
                g.selected = null;
                if (current) window.__nswsGarageCar?.(current);
            }
            save();
            render();
        }, g.armed ? "armed" : "");
        sell.disabled = lastOnCar;
        if (lastOnCar) sell.title = "Unequip it first";
        info.appendChild(sell);
        g.preview.appendChild(info);
    }

    const style = el("style");
    style.id = "nsws-crates-style";
    style.textContent = CSS;
    document.head.appendChild(style);

    window.addEventListener("nsws-finish", onFinish);
    window.addEventListener("nsws-new-pb", onNewPb);
    window.addEventListener("pagehide", () => report());

    window.__nswsCrates = { mountGarage, leaveGarage, chatLine, open: openShop, tradeUp, collection, wheel, crates: CRATES, rarities: RARITIES };
})();
