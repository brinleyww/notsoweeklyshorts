// Crates: cosmetic paint jobs that drop from finished runs and open with keys earned from new PBs. Kept in this
// browser only (per profile). Paint never touches physics: everything here ends up as an ordinary car style.
(function () {
    const STORE = "nsws_crates_v1:";
    const DROP_CHANCE = 0.14;
    const DROP_PITY = 14;
    const DROP_GAP_MS = 3 * 60 * 1000;
    const DROPS_PER_DAY = 4;
    const KEYS_PER_DAY = 3;
    const MAX_ITEMS = 500;
    const TILE = 150;
    const GAP = 6;
    const SPIN_MS = 6200;

    const RARITIES = [
        { id: "milspec", name: "Mil-Spec", color: "#4b69ff", odds: 0.7992 },
        { id: "restricted", name: "Restricted", color: "#8847ff", odds: 0.1598 },
        { id: "classified", name: "Classified", color: "#d32ce6", odds: 0.032 },
        { id: "covert", name: "Covert", color: "#eb4b4b", odds: 0.0064 },
        { id: "gold", name: "Rare Special", color: "#e4ae39", odds: 0.0026 },
    ];
    const R = Object.fromEntries(RARITIES.map((r, i) => [r.id, i]));

    const WEARS = [
        { name: "Factory New", short: "FN", max: 0.07 },
        { name: "Minimal Wear", short: "MW", max: 0.15 },
        { name: "Field-Tested", short: "FT", max: 0.38 },
        { name: "Well-Worn", short: "WW", max: 0.45 },
        { name: "Battle-Scarred", short: "BS", max: 1.01 },
    ];

    // pattern = index into CarStyle.patterns, rims = a rims model (higher tiers only), body only for the Pengu knives.
    // c = [primary, secondary, frame, rims]; wear = [min, max] float.
    const ITEMS = [
        { name: "Parking Ticket", r: "milspec", pattern: 0, c: [0xf2c21b, 0x1a1a1a, 0x1a1a1a, 0x666666], note: "Comes with a fine you will never pay." },
        { name: "Rust Bucket", r: "milspec", pattern: 5, c: [0x8a4b2a, 0x5a3a28, 0x3b2a20, 0x5a4a40], wear: [0.06, 1], note: "Cannot be Factory New. It was born like this." },
        { name: "Learner Plates", r: "milspec", pattern: 7, c: [0xf4f4f4, 0xd61f1f, 0x1f1f1f, 0x888888], note: "Please be patient. Student driver." },
        { name: "Mud Season", r: "milspec", pattern: 4, c: [0x6b5a3e, 0x3e3425, 0x2a241b, 0x4d4436], note: "Was a different colour before the forest stage." },
        { name: "Rental Return", r: "milspec", pattern: 1, c: [0x9aa3ad, 0x2b2f36, 0x1a1c20, 0x9aa3ad], note: "Returned with less fuel than promised." },
        { name: "Sponsor Wanted", r: "milspec", pattern: 15, c: [0xffffff, 0xff2d95, 0x1a1a1a, 0xffffff], note: "Your logo here. Seriously. Anyone." },
        { name: "Grandma's Minivan", r: "milspec", pattern: 14, c: [0x8fa9c4, 0xd9cfb8, 0x5d6b7a, 0xc0c0c0], note: "Top speed: church." },
        { name: "Night Shift", r: "restricted", pattern: 9, c: [0x0d0f1f, 0x39ff88, 0x0d0f1f, 0x39ff88], note: "Drives best after 2 am, like everyone on this site." },
        { name: "Left Turn Only", r: "restricted", pattern: 3, c: [0x1d4fd6, 0xffd400, 0x111111, 0xffd400], note: "Built for ovals. Panics at right turns." },
        { name: "Pit Lane Pasta", r: "restricted", pattern: 12, c: [0xf5d76e, 0xc0392b, 0x3a2a10, 0xc0392b], note: "Al dente aerodynamics." },
        { name: "Gravel Gremlin", r: "restricted", pattern: 10, c: [0x3fa34d, 0x1b1b1b, 0x1b1b1b, 0x3fa34d], note: "Has never once stayed on the road." },
        { name: "Checkpoint Skipper", r: "restricted", pattern: 6, c: [0x7b2cff, 0xffffff, 0x1a0f33, 0xffffff], note: "Allegedly." },
        { name: "Redline", r: "classified", pattern: 2, rims: 3, c: [0x111111, 0xd10f0f, 0x111111, 0xd10f0f], note: "Shift at 9,000 rpm. Or never. Your call." },
        { name: "Hyper Goose", r: "classified", pattern: 11, rims: 5, c: [0x19c2b5, 0xff6a00, 0x10302e, 0xff6a00], note: "Honk." },
        { name: "Hot Sauce", r: "classified", pattern: 8, rims: 7, c: [0xff3b1f, 0xffb100, 0x3a0a05, 0xffb100], note: "Warning: contains chilli and overconfidence." },
        { name: "Author Time", r: "covert", pattern: 13, rims: 9, c: [0xf0c419, 0x101010, 0x101010, 0xf0c419], note: "Beat it. Then beat it again." },
        { name: "World Record", r: "covert", pattern: 15, rims: 10, c: [0xffffff, 0x0047ff, 0x0b1020, 0x0047ff], note: "Held for eleven glorious minutes." },
        { name: "\u2605 Pengu | Fade", r: "gold", body: 6, pattern: 14, rims: 11, c: [0xff4fa3, 0xffd23f, 0x6a2ca0, 0xffd23f], finish: "fade", wear: [0, 0.08], note: "A penguin. In a car. In a gradient." },
        { name: "\u2605 Pengu | Ice Hardened", r: "gold", body: 6, pattern: 11, rims: 11, c: [0xb8892e, 0x8a8f96, 0x2b2f36, 0x8a8f96], finish: "ice", wear: [0, 1], note: "Somebody, somewhere, is chasing template 661." },
        { name: "\u2605 Pengu | Dopplerganger", r: "gold", body: 6, pattern: 13, rims: 11, c: [0x7a1fd6, 0x111111, 0x111111, 0xcfcfcf], finish: "doppler", wear: [0, 0.08], note: "There are two of it. Neither of them can drive." },
    ];

    const QUIPS = [
        ["It's blue. Like your chances of beating Author Time.", "Certified mid.", "Adds 0 km/h. We checked.", "The crate shrugged."],
        ["Purple! Respectable. Frame it.", "Someone's mum is proud.", "Not bad. Not bad at all."],
        ["PINK. Somebody screenshot this.", "The chat would like to know your location."],
        ["RED. You may now be insufferable for exactly one week.", "Covert. Act natural."],
        ["\u2605 You absolute menace.", "\u2605 The penguin has chosen you."],
    ];

    const CSS = `
.customization-panel-ui>.panel.nsws-crates{position:absolute;inset:0 0 64px 0;pointer-events:none;}
.nsws-crates .bar{position:absolute;right:var(--safe-area-right);bottom:0;top:64px;display:flex;flex-direction:column;width:min(380px,48vw);box-sizing:border-box;background:var(--surface-secondary-color);pointer-events:auto;}
.nsws-crates .bar>.head{flex-shrink:0;padding:12px 14px;background:var(--surface-color);}
.nsws-crates .bar>.head>.count{font-size:30px;}
.nsws-crates .bar>.head>.count small{font-size:16px;color:rgba(255,255,255,.65);margin:0 10px 0 6px;}
.nsws-crates .bar>.head>.sub{font-size:13px;line-height:1.35;color:rgba(255,255,255,.6);margin:2px 0 8px;}
.nsws-crates .bar>.head>.button{margin:0;font-size:18px;padding:6px 14px;}
.nsws-crates .bar>.head>.button+.button{margin-left:6px;}
.nsws-crates .bar>.head>.button.main{box-shadow:inset 0 -3px #ffc94a;}
.nsws-crates .bar>.list{flex:1;min-height:0;overflow-y:auto;padding:4px 6px 10px;}
.nsws-crates .bar h3{margin:12px 4px 4px;font-size:17px;font-weight:normal;}
.nsws-crates .bar>.list>p{margin:20px 10px;font-size:15px;line-height:1.4;color:rgba(255,255,255,.55);text-align:center;}
.nsws-crates .bar>.foot{flex-shrink:0;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 12px;border-top:1px solid rgba(255,255,255,.1);font-size:13px;color:rgba(255,255,255,.55);}
.nsws-crates .bar>.foot>.button{margin:0;font-size:15px;padding:3px 10px;}
.nsws-crates .item{display:flex;align-items:center;gap:8px;width:100%;margin:0 0 3px;padding:7px 10px 7px 12px;border:2px solid rgb(38,31,88);border-left:5px solid var(--rc);background:var(--button-color);color:var(--text-color);font:inherit;font-size:16px;text-align:left;cursor:pointer;box-sizing:border-box;}
.nsws-crates .item:hover{background:var(--button-hover-color);}
.nsws-crates .item.selected{background:var(--button-hover-color);border-color:#fff;border-left-color:var(--rc);box-shadow:inset 0 0 5px #fff;}
.nsws-crates .item>.nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.nsws-crates .item>.w{margin-left:auto;flex-shrink:0;font-size:13px;color:rgba(255,255,255,.55);}
.nsws-crates .item.on>.w{color:#ffc94a;}
.nsws-crates .st{color:#cf6a32;}
.nsws-crates .preview{position:absolute;left:calc(var(--safe-area-left) + 10px);bottom:10px;width:min(430px,calc(100% - min(380px,48vw) - 30px));box-sizing:border-box;background:var(--surface-secondary-color);pointer-events:auto;clip-path:polygon(0 0,100% 0,calc(100% - 10px) 100%,0 100%);}
.nsws-crates .preview>.cap{padding:4px 12px;background:var(--surface-color);font-size:20px;border-bottom:3px solid var(--rc,transparent);}
.nsws-crates .preview>.cap>small{display:block;font-size:14px;color:var(--rc,rgba(255,255,255,.6));}
.nsws-crates .preview>.info{padding:8px 12px 12px;font-size:14px;line-height:1.4;color:rgba(255,255,255,.75);}
.nsws-crates .preview>.info>.note{font-style:italic;color:rgba(255,255,255,.6);margin-top:4px;}
.nsws-crates .preview>.info>.button{margin:8px 6px 0 0;font-size:18px;padding:5px 14px;}
.nsws-crates .preview>.info>.button.armed{color:#ff9696;box-shadow:inset 0 -3px #ff9696;}
.nsws-crates .preview>.info>input{width:100%;box-sizing:border-box;margin:8px 0 0;font-size:18px;}
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
#nsws-crate .tile{position:relative;display:flex;flex-direction:column;align-items:center;background:var(--button-color);border-bottom:4px solid var(--rc);padding:4px 4px 6px;min-width:0;}
#nsws-crate .tile>img,#nsws-crate .tile>.star{width:100%;max-width:120px;aspect-ratio:1;object-fit:contain;filter:drop-shadow(0 0 2px #000);}
#nsws-crate .tile>.star{display:flex;align-items:center;justify-content:center;font-size:64px;color:#e4ae39;}
#nsws-crate .tile>span{width:100%;font-size:13px;line-height:1.2;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
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
#nsws-crate .fine{margin:14px 0 0;font-size:13px;line-height:1.4;color:rgba(255,255,255,.5);}
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
        return n + " " + (n === 1 ? one : many);
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

    function profile() {
        try {
            return window.__nswsCup?.services?.().profiles?.getCurrentUserProfile?.() ?? null;
        } catch {
            return null;
        }
    }

    function storeKey() {
        const token = profile()?.token ?? window.__nswsProfileToken?.();
        return token ? STORE + hashText(token) : null;
    }

    let cached = null;
    function load() {
        const key = storeKey();
        if (!key) return null;
        if (cached?.key === key) return cached.state;
        let state = null;
        try {
            state = JSON.parse(localStorage.getItem(key));
        } catch {}
        if (!state || typeof state !== "object" || !Array.isArray(state.items)) {
            state = { v: 1, crates: 1, keys: 1, items: [], lastDrop: 0, pity: 0, day: today(), drops: 0, keyCount: 0, keyTracks: {}, off: false, equipped: null, opened: 0 };
        }
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
            state.drops = 0;
            state.keyCount = 0;
            state.keyTracks = {};
        }
    }

    function wearOf(f) {
        return WEARS.find((w) => f < w.max) ?? WEARS[WEARS.length - 1];
    }

    function hexToRgb(h) {
        return [(h >> 16) & 255, (h >> 8) & 255, h & 255];
    }

    function rgbToHex([r, g, b]) {
        return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
    }

    function mix(a, b, t) {
        const x = hexToRgb(a), y = hexToRgb(b);
        return rgbToHex(x.map((v, i) => v + (y[i] - v) * t));
    }

    function hueShift(hex, deg) {
        let [r, g, b] = hexToRgb(hex).map((v) => v / 255);
        const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
        if (max === min) return hex;
        const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
        h = ((h * 60 + deg) % 360 + 360) % 360 / 360;
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
        const f = (t) => {
            t = (t + 1) % 1;
            return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
        };
        return rgbToHex([f(h + 1 / 3), f(h), f(h - 1 / 3)].map((v) => v * 255));
    }

    function iceBlue(seed) {
        if (seed === 661) return 98;
        if (seed === 387 || seed === 670) return 86;
        return Math.round(4 + 38 * (((seed * 7919) % 1000) / 1000) ** 2);
    }

    const DOPPLER = [
        ["Phase 1", 0x1a0f2e, 0x5b1f8a],
        ["Phase 2", 0xd6338f, 0x3d1450],
        ["Phase 3", 0x1f8a6a, 0x123a4a],
        ["Phase 4", 0x2a63d6, 0x6a2ca0],
    ];
    function dopplerPhase(seed) {
        if (seed < 8) return ["Ruby", 0xd10f2a, 0x4a0510];
        if (seed < 16) return ["Sapphire", 0x0f4ad1, 0x051a4a];
        if (seed < 24) return ["Black Pearl", 0x1a1030, 0x3a2a6a];
        return DOPPLER[seed % 4];
    }

    function special(def, item) {
        if (def.finish === "fade") return "Fade " + (80 + (item.s % 21)) + "%";
        if (def.finish === "ice") return iceBlue(item.s) + "% blue" + (item.s === 661 ? " (the blue gem!)" : "");
        if (def.finish === "doppler") return dopplerPhase(item.s)[0];
        return null;
    }

    function colors(def, item) {
        let [p, s, f, r] = def.c;
        if (def.finish === "fade") {
            const t = (80 + (item.s % 21)) / 100;
            p = mix(0x6a2ca0, p, t);
            s = mix(0xff4fa3, s, t);
        } else if (def.finish === "ice") {
            p = mix(p, 0x1f5fd1, iceBlue(item.s) / 100);
        } else if (def.finish === "doppler") {
            const [, a, b] = dopplerPhase(item.s);
            p = a;
            s = b;
        } else {
            s = hueShift(s, ((item.s % 13) - 6));
        }
        const grime = Math.max(0, item.f - 0.05) * 0.55;
        return [p, s, f, r].map((c) => mix(c, 0x5e5242, grime));
    }

    function CarStyle() {
        return window.__clipCarStyleClass;
    }

    // The skin painted onto `base`: pattern and colours always, rims from Classified up, the body only for Pengu.
    function styleFor(item, base) {
        const C = CarStyle();
        const def = ITEMS[item.i];
        if (!C || !def) return null;
        const [p, s, f, r] = colors(def, item);
        const rims = def.rims ?? base?.rims ?? C.defaultRims;
        const body = def.body ?? base?.body ?? C.defaultBody;
        return new C(def.pattern, rims, base?.exhaust ?? C.defaultExhaust, p, s, f, r, body);
    }

    function wearing(item, current) {
        if (!item || !current) return false;
        const want = styleFor(item, current);
        return !!want && want.equals(current);
    }

    function currentStyle() {
        return garage?.hooks?.current?.() ?? profile()?.carStyle ?? null;
    }

    function equippedItem(state, current = currentStyle()) {
        const item = state.items.find((x) => x.u === state.equipped);
        return item && wearing(item, current) ? item : null;
    }

    function fullName(item, withWear = true) {
        const def = ITEMS[item.i];
        return (item.st != null ? (def.r === "gold" ? "\u2605 StatTrak\u2122 " + def.name.slice(2) : "StatTrak\u2122 " + def.name) : def.name)
            + (withWear ? " (" + wearOf(item.f).name + ")" : "");
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

    function makeItem(rarity, floatT = Math.random(), statTrak = Math.random() < 0.1) {
        const choices = ITEMS.map((d, i) => [d, i]).filter(([d]) => R[d.r] === rarity);
        const [def, i] = pick(choices);
        const [lo, hi] = def.wear ?? [0, 0.8];
        return {
            u: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
            i,
            f: Math.round((lo + (hi - lo) * floatT) * 1e9) / 1e9,
            s: Math.floor(Math.random() * 1000),
            st: statTrak ? 0 : null,
            at: Date.now(),
        };
    }

    function toast(text) {
        if (window.__nswsTags?.toast) return window.__nswsTags.toast(text);
        console.info(text);
    }

    function onFinish() {
        const state = load();
        if (!state) return;
        rollDay(state);
        const worn = equippedItem(state, profile()?.carStyle ?? null);
        if (worn && worn.st != null) worn.st++;
        let dropped = false;
        if (!state.off && state.drops < DROPS_PER_DAY && Date.now() - state.lastDrop >= DROP_GAP_MS) {
            state.pity = (state.pity ?? 0) + 1;
            if (state.pity >= DROP_PITY || Math.random() < DROP_CHANCE) {
                state.crates++;
                state.drops++;
                state.pity = 0;
                state.lastDrop = Date.now();
                dropped = true;
            }
        }
        save();
        if (dropped) setTimeout(() => toast("A crate dropped! Open it in Garage \u2192 Crates."), 1800);
        render();
    }

    function onNewPb(e) {
        const state = load();
        const track = e.detail?.track;
        if (!state || !track || state.off) return;
        rollDay(state);
        if (state.keyTracks[track] || state.keyCount >= KEYS_PER_DAY) return;
        state.keyTracks[track] = 1;
        state.keyCount++;
        state.keys++;
        save();
        setTimeout(() => toast("New PB, so you got a crate key."), 2600);
        render();
    }

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

    const thumbs = new Map();
    function thumb(style) {
        if (!style || !window.__nswsCarThumb) return Promise.resolve("");
        const key = style.serialize();
        if (!thumbs.has(key)) {
            if (thumbs.size > 80) thumbs.delete(thumbs.keys().next().value);
            thumbs.set(key, Promise.resolve(window.__nswsCarThumb(key)).catch(() => ""));
        }
        return thumbs.get(key);
    }

    function setImage(img, style) {
        thumb(style).then((src) => {
            if (src) img.src = src;
        });
    }

    function sampleFor(i, base) {
        return styleFor({ i, f: 0, s: 500, st: null }, base);
    }

    function tileFor(i, base, hideGold = true) {
        const def = ITEMS[i];
        const tile = el("div", "tile");
        tile.style.setProperty("--rc", RARITIES[R[def.r]].color);
        if (def.r === "gold" && hideGold) {
            tile.appendChild(el("div", "star", "\u2605"));
            tile.appendChild(el("span", null, "Rare Special Item"));
        } else {
            const img = el("img");
            img.alt = "";
            img.draggable = false;
            setImage(img, sampleFor(i, base));
            tile.append(img, el("span", null, def.name));
        }
        return tile;
    }

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

    function overlay(title, sub) {
        closeOverlay();
        const root = el("div");
        root.id = "nsws-crate";
        const box = el("div", "box");
        box.tabIndex = -1;
        const top = el("div", "top");
        const body = el("div", "body");
        top.append(el("h1", null, title), el("small", null, sub ?? ""), button("Close", () => (view?.spinning ? view.skip?.() : closeOverlay())));
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
        return view;
    }

    function counts(state) {
        return plural(state.crates, "crate") + " \u00b7 " + plural(state.keys, "key");
    }

    function openCrate() {
        const state = load();
        if (!state) return;
        const v = overlay("Not So Weekly Crate", counts(state));
        const base = currentStyle();
        v.body.appendChild(el("h2", null, "Contains one of these"));
        const grid = el("div", "grid");
        ITEMS.forEach((def, i) => {
            if (def.r !== "gold") grid.appendChild(tileFor(i, base));
        });
        grid.appendChild(tileFor(ITEMS.findIndex((d) => d.r === "gold"), base));
        v.body.appendChild(grid);
        const actions = el("div", "actions");
        const unlock = button("Unlock crate", () => spin(), "main");
        unlock.disabled = !state.crates || !state.keys;
        actions.appendChild(unlock);
        if (!state.keys) actions.appendChild(button("Buy key \u2014 $2.49", () => wallet(actions)));
        actions.appendChild(el("span", "msg", !state.crates ? "No crates yet. They drop from finished runs." : !state.keys ? "You need a key. Keys come from new PBs." : ""));
        v.body.appendChild(actions);
        v.body.appendChild(el("p", "fine", "Paint only: a skin never changes how your car drives, and nothing here costs money. "
            + "Crates drop from finished runs (up to " + DROPS_PER_DAY + " a day), keys from new PBs (up to " + KEYS_PER_DAY + " a day, one per track)."));
    }

    function wallet(actions) {
        const msg = actions.querySelector(".msg");
        if (msg) msg.textContent = "NSWS Wallet: $0.00. Keys can't be bought, so set a new PB instead. It's cheaper.";
    }

    function spin() {
        const state = load();
        if (!state || !state.crates || !state.keys || !view) return;
        state.crates--;
        state.keys--;
        state.opened = (state.opened ?? 0) + 1;
        const item = makeItem(rollRarity());
        const kept = state.items.length < MAX_ITEMS;
        if (kept) state.items.push(item);
        save();

        const v = view;
        const base = currentStyle();
        v.top.querySelector("small").textContent = counts(state);
        v.body.textContent = "";
        const reel = el("div", "reel");
        const strip = el("div", "strip");
        const COUNT = 56, WIN = 48;
        for (let n = 0; n < COUNT; n++) {
            const i = n === WIN ? item.i : makeItem(rollRarity()).i;
            strip.appendChild(tileFor(i, base, n !== WIN));
        }
        reel.append(strip, el("div", "mark"));
        v.body.appendChild(reel);
        const actions = el("div", "actions");
        const skip = button("Skip", () => v.skip());
        actions.appendChild(skip);
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
            setTimeout(() => view === v && reveal(item, true, kept), 350);
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

    function reveal(item, fromCrate, kept = true) {
        const state = load();
        if (!state || !view) return;
        const def = ITEMS[item.i];
        const rarity = R[def.r];
        const v = view;
        v.body.textContent = "";
        const won = el("div", "won pop");
        won.style.setProperty("--rc", RARITIES[rarity].color);
        const img = el("img");
        img.alt = "";
        setImage(img, styleFor(item, currentStyle()));
        const text = el("div");
        text.appendChild(el("div", "kind", RARITIES[rarity].name + (def.r === "gold" ? " \u2605" : "")));
        const name = el("div", "nm", fullName(item, false));
        if (item.st != null) name.classList.add("st");
        text.appendChild(name);
        const extra = special(def, item);
        text.appendChild(el("div", "meta", wearOf(item.f).name + " \u00b7 float " + item.f.toFixed(9) + " \u00b7 template #" + item.s + (extra ? " \u00b7 " + extra : "")));
        text.appendChild(el("div", "quip", pick(QUIPS[rarity])));
        won.append(img, text);
        v.body.appendChild(won);
        fanfare(rarity);

        const actions = el("div", "actions");
        actions.appendChild(button("Equip", (b) => {
            equip(item);
            b.disabled = true;
            b.textContent = "Equipped";
        }, "main"));
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
        if (fromCrate && state.crates && state.keys) actions.appendChild(button("Open another", () => openCrate()));
        else if (fromCrate && state.crates) actions.appendChild(button("Buy key \u2014 $2.49", () => wallet(actions)));
        actions.appendChild(button("Done", () => closeOverlay()));
        actions.appendChild(el("span", "msg", !kept ? "Your inventory is full, so this one wasn't kept." : ""));
        v.top.querySelector("small").textContent = counts(state);
        v.body.appendChild(actions);
    }

    function chatText(item) {
        return "\u{1F4E6} opened a crate and found: " + fullName(item) + " [crate:" + item.i + "." + Math.round(item.f * 1e4) + "." + item.s + "." + (item.st != null ? 1 : 0) + "]";
    }

    // Draws "[crate:i.f.s.t]" chat messages as an unboxing line; anything else stays plain text.
    function chatLine(text) {
        const m = /^\u{1F4E6} opened a crate and found: .* \[crate:(\d{1,2})\.(\d{1,5})\.(\d{1,3})\.([01])\]$/u.exec(text ?? "");
        if (!m || !ITEMS[+m[1]]) return null;
        const item = { i: +m[1], f: Math.min(1, +m[2] / 1e4), s: +m[3], st: m[4] === "1" ? 0 : null };
        const def = ITEMS[item.i];
        const line = el("span", "nsws-crate-chat", "opened a crate and found: ");
        const name = el("b", null, fullName(item));
        name.style.setProperty("--rc", RARITIES[R[def.r]].color);
        name.title = RARITIES[R[def.r]].name + " \u00b7 float " + item.f.toFixed(4) + " \u00b7 template #" + item.s;
        line.appendChild(name);
        return line;
    }

    function equip(item) {
        const state = load();
        if (!state) return;
        const base = currentStyle();
        const style = styleFor(item, base);
        if (!style) return;
        state.equipped = item.u;
        save();
        if (garage?.hooks?.apply) {
            garage.hooks.apply(style);
        } else {
            const services = window.__nswsCup?.services?.();
            const p = services?.profiles?.getCurrentUserProfile?.();
            if (!services || !p) return;
            services.profiles.setCarStyle(style);
            services.api?.submitUserProfile?.(p.token, p.nickname, p.countryCode, style)?.catch?.((e) => console.warn(e));
        }
        render();
    }

    function tradeUp() {
        const state = load();
        if (!state) return;
        const v = overlay("Trade up contract", counts(state));
        const current = currentStyle();
        const worn = equippedItem(state, current);
        v.body.appendChild(el("h2", null, "Sign away items of one grade for one of the next grade up"));
        for (let r = 0; r < RARITIES.length - 1; r++) {
            const need = r === R.covert ? 5 : 10;
            const pool = state.items.filter((x) => R[ITEMS[x.i].r] === r && x !== worn && !x.n);
            const row = el("div", "line");
            const left = el("div", null, need + " " + RARITIES[r].name + " \u2192 1 " + RARITIES[r + 1].name);
            left.style.color = RARITIES[r + 1].color;
            left.appendChild(el("small", null, "You have " + pool.length + " to spare (named and equipped items are kept). The new float is the average of the old ones."));
            const sign = button("Sign", () => contract(r, need));
            sign.disabled = pool.length < need;
            row.append(left, sign);
            v.body.appendChild(row);
        }
        v.body.appendChild(el("p", "fine", "Duplicates go first, then the most worn. StatTrak\u2122 carries over only if every item signed is StatTrak\u2122."));
    }

    function contract(rarity, need) {
        const state = load();
        if (!state) return;
        const worn = equippedItem(state);
        const pool = state.items.filter((x) => R[ITEMS[x.i].r] === rarity && x !== worn && !x.n);
        if (pool.length < need) return;
        const seen = new Map();
        for (const x of pool) seen.set(x.i, (seen.get(x.i) ?? 0) + 1);
        pool.sort((a, b) => (seen.get(b.i) - seen.get(a.i)) || (b.f - a.f));
        const used = pool.slice(0, need);
        const norm = used.map((x) => {
            const [lo, hi] = ITEMS[x.i].wear ?? [0, 0.8];
            return hi > lo ? (x.f - lo) / (hi - lo) : 0;
        });
        const avg = norm.reduce((a, b) => a + b, 0) / norm.length;
        const item = makeItem(rarity + 1, Math.max(0, Math.min(1, avg)), used.every((x) => x.st != null));
        const gone = new Set(used.map((x) => x.u));
        state.items = state.items.filter((x) => !gone.has(x.u));
        state.items.push(item);
        save();
        view.top.querySelector("h1").textContent = "Contract signed";
        reveal(item, false);
    }

    let garage = null;

    function mountGarage(panel, hooks) {
        panel.classList.add("nsws-crates");
        panel.textContent = "";
        garage = { panel, hooks: hooks ?? {}, bar: el("div", "bar"), preview: el("div", "preview"), selected: null, armed: false, naming: false };
        panel.append(garage.preview, garage.bar);
        render();
    }

    // The garage car shows the selected skin while this tab is open; this puts the real paint back.
    function leaveGarage() {
        if (!garage) return;
        const current = garage.hooks.current?.();
        if (current && garage.selected) window.__nswsGarageCar?.(current);
        garage.selected = null;
        garage.armed = garage.naming = false;
        render();
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
        const worn = equippedItem(state, current);

        const head = el("div", "head");
        const count = el("div", "count", String(state.crates));
        count.appendChild(el("small", null, state.crates === 1 ? "crate" : "crates"));
        count.append(String(state.keys));
        count.appendChild(el("small", null, state.keys === 1 ? "key" : "keys"));
        head.appendChild(count);
        head.appendChild(el("div", "sub", state.off
            ? "Drops are off. Turn them back on below."
            : "Crates drop from finished runs, keys come from new PBs. Paint only, never speed."));
        head.appendChild(button("Open crate", () => openCrate(), "main"));
        head.appendChild(button("Trade up", () => tradeUp()));
        g.bar.appendChild(head);

        const list = el("div", "list");
        if (!state.items.length) list.appendChild(el("p", null, "Nothing here yet. Open a crate and your skins land here."));
        for (let r = RARITIES.length - 1; r >= 0; r--) {
            const items = state.items.filter((x) => R[ITEMS[x.i]?.r] === r).sort((a, b) => b.at - a.at);
            if (!items.length) continue;
            const h = el("h3", null, RARITIES[r].name + " \u00b7 " + items.length);
            h.style.color = RARITIES[r].color;
            list.appendChild(h);
            for (const item of items) {
                const on = item === worn;
                const row = el("button", "item" + (on ? " on" : "") + (g.selected === item.u ? " selected" : ""));
                row.style.setProperty("--rc", RARITIES[r].color);
                const nm = el("span", "nm" + (item.st != null ? " st" : ""), item.n ? "\u201c" + item.n + "\u201d" : fullName(item, false));
                row.append(nm, el("span", "w", on ? "Equipped" : wearOf(item.f).short));
                row.title = fullName(item);
                row.addEventListener("click", () => {
                    window.__nswsUIClick?.();
                    g.selected = g.selected === item.u ? null : item.u;
                    g.armed = false;
                    g.naming = false;
                    const style = g.selected ? styleFor(item, current) : current;
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
        foot.appendChild(button(state.off ? "Drops: Off" : "Drops: On", () => {
            state.off = !state.off;
            save();
            render();
        }));
        g.bar.appendChild(foot);

        const item = state.items.find((x) => x.u === g.selected);
        g.preview.style.display = item ? "" : "none";
        if (!item) return;
        const def = ITEMS[item.i];
        const rarity = RARITIES[R[def.r]];
        g.preview.style.setProperty("--rc", rarity.color);
        const cap = el("div", "cap", item.n ? "\u201c" + item.n + "\u201d" : fullName(item, false));
        cap.appendChild(el("small", null, rarity.name + " \u00b7 " + wearOf(item.f).name));
        g.preview.appendChild(cap);
        const info = el("div", "info");
        const extra = special(def, item);
        info.appendChild(el("div", null, "Float " + item.f.toFixed(9) + " \u00b7 template #" + item.s + (extra ? " \u00b7 " + extra : "")));
        if (item.st != null) info.appendChild(el("div", "st", "StatTrak\u2122 finishes: " + item.st.toLocaleString()));
        if (item.n) info.appendChild(el("div", null, fullName(item)));
        info.appendChild(el("div", "note", def.note));
        if (g.naming) {
            const input = el("input");
            input.maxLength = 24;
            input.placeholder = "Name tag (empty removes it)";
            input.value = item.n ?? "";
            const done = () => {
                const name = input.value.replace(/\s+/g, " ").trim().slice(0, 24);
                item.n = name || undefined;
                g.naming = false;
                save();
                render();
            };
            input.addEventListener("keydown", (e) => {
                e.stopPropagation();
                if (e.key === "Enter") done();
                if (e.key === "Escape") {
                    g.naming = false;
                    render();
                }
            });
            info.append(input, button("Save name", done));
            setTimeout(() => input.focus(), 0);
        } else {
            const isOn = item === worn;
            const eq = button(isOn ? "Equipped" : "Equip", () => equip(item));
            eq.disabled = isOn;
            info.appendChild(eq);
            info.appendChild(button("Name tag", () => {
                g.naming = true;
                render();
            }));
            const drop = button(g.armed ? "Sure? Click again" : "Throw away", () => {
                if (!g.armed) {
                    g.armed = true;
                    return render();
                }
                state.items = state.items.filter((x) => x !== item);
                if (state.equipped === item.u) state.equipped = null;
                g.selected = null;
                g.armed = false;
                save();
                if (current) window.__nswsGarageCar?.(current);
                render();
            }, g.armed ? "armed" : "");
            if (isOn) drop.disabled = true;
            info.appendChild(drop);
        }
        g.preview.appendChild(info);
    }

    const style = el("style");
    style.id = "nsws-crates-style";
    style.textContent = CSS;
    document.head.appendChild(style);

    window.addEventListener("nsws-finish", onFinish);
    window.addEventListener("nsws-new-pb", onNewPb);

    window.__nswsCrates = { mountGarage, leaveGarage, chatLine, open: openCrate, tradeUp, items: ITEMS, rarities: RARITIES };
})();
