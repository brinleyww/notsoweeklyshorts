// The universal chat window. Off until the player turns it on in Settings ("Chat"). The
// Worker censors every message and nickname before anyone sees them, so nothing here is
// trusted to do that.
(function () {
    const API = window.__nswsApiBase;
    if (!API || !window.WebSocket) return;

    const ENABLED_KEY = "_nswsChatEnabled";
    const LAYOUT_KEY = "_nswsChatLayout";
    const VISITOR_KEY = "nsws_visitor";
    const PING_SOUND_KEY = "_nswsChatPingSound";
    const RECENT_EMOJI_KEY = "_nswsChatRecentEmoji";
    const WS_URL = API.replace(/^http/, "ws") + "nsws/chat";
    // The same chat over plain HTTPS long-polling, for networks (often school or work) whose
    // firewall blocks WebSockets but lets ordinary requests like the leaderboard's through.
    const HTTP_URL = API + "nsws/chat/";
    const TRANSPORT_KEY = "_nswsChatHttpAt";
    const WS_OPEN_TIMEOUT_MS = 8000;
    const WS_FAILS_BEFORE_HTTP = 2;
    const HTTP_REMEMBER_MS = 12 * 3600000;
    const POLL_ABORT_MS = 35000;
    const SEND_ABORT_MS = 15000;
    const EMOJI_URL = "mod/nsws_emoji.json";
    const MAX_TEXT = 200;
    const MAX_ITEMS = 200;
    const KEEPALIVE_MS = 30000;
    const SLOW_MS = 1000;
    const PING_SOUND_GAP_MS = 4000;
    const WHO_MS = 5000;
    // Messages from one player closer together than this share one name header.
    const GROUP_MS = 5 * 60000;
    const RECENT_EMOJI = 27;
    const MAX_SUGGEST = 12;
    // Messages of only emoji, up to this many, are shown large.
    const JUMBO_MAX = 27;
    const TITLE_MARK = "(@) ";
    const MIN_W = 260;
    const MIN_H = 180;
    const MARGIN = 8;
    const LOG_BG = [0x21, 0x2b, 0x58];
    const FONT_KEY = "_nswsChatFont";
    const DEVICE_EMOJI = "'NSWS Flags','Segoe UI Emoji','Apple Color Emoji','Noto Color Emoji'";
    // The chat's own font choice (Settings > Chat). Discord draws emoji with Twemoji, so its look does too.
    const FONTS = [
        { id: "polytrack", title: "PolyTrack", text: "ForcedSquare,Arial", emoji: DEVICE_EMOJI, style: "italic", nameWeight: "bold" },
        { id: "discord", title: "Discord", text: "'NSWS Figtree'", emoji: "'NSWS Twemoji'," + DEVICE_EMOJI, style: "normal", nameWeight: "600" },
        { id: "rounded", title: "Rounded", text: "'NSWS Nunito'", emoji: DEVICE_EMOJI, style: "normal", nameWeight: "800" },
        { id: "system", title: "System", text: "system-ui,-apple-system,'Segoe UI',Roboto,Arial", emoji: DEVICE_EMOJI, style: "normal", nameWeight: "600" },
    ];
    const icon = (...codes) => String.fromCodePoint(...codes);
    const QUICK_REACTIONS = [0x1f44d, 0x1f602, 0x1f525].map((c) => String.fromCodePoint(c));
    const ADD_REACTION_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20.6 13.4A9 9 0 1 1 13 3.1"/><path d="M8.5 14.5s1.2 1.6 3.5 1.6 3.5-1.6 3.5-1.6"/><path d="M9 9.5h.01M15 9.5h.01"/><path d="M19 2.5v6M16 5.5h6"/></svg>';
    const TAB_ICONS = [0x1f600, 0x1f44b, 0x1f43b, 0x1f354, 0x1f697, 0x26bd, 0x1f4a1, 0x1f523, 0x1f3c1];

    // A font only downloads once something on screen uses it. Credits: mod/fonts/LICENSES.txt.
    // NSWS Flags is there because Windows has no flag emoji; it covers only flag characters, so it
    // goes first, ahead of text fonts that would otherwise draw a flag as two letters.
    const FONT_CSS = `
@font-face{font-family:'NSWS Flags';src:url(mod/fonts/TwemojiCountryFlags.woff2) format('woff2');unicode-range:U+1F1E6-1F1FF,U+1F3F4,U+E0061-E007F;font-display:swap;}
@font-face{font-family:'NSWS Figtree';src:url(mod/fonts/Figtree.woff2) format('woff2');font-weight:300 900;font-display:swap;}
@font-face{font-family:'NSWS Nunito';src:url(mod/fonts/Nunito.woff2) format('woff2');font-weight:200 1000;font-display:swap;}
@font-face{font-family:'NSWS Twemoji';src:url(mod/fonts/Twemoji.woff2) format('woff2');font-display:swap;}
`;

    // The game's stylesheet sets ForcedSquare italic on every element (*), so everything in the
    // chat inherits from the window instead, which holds the chosen font.
    const CSS = `
#nsws-chat,#nsws-chat-toast{font-style:var(--nsws-chat-font-style);line-height:1.2;}
#nsws-chat *,#nsws-chat-toast *{font-family:inherit;font-style:inherit;line-height:inherit;}
#nsws-chat{position:fixed;z-index:90;display:flex;flex-direction:column;min-width:${MIN_W}px;min-height:${MIN_H}px;background:var(--surface-color,#28346a);color:var(--text-color,#fff);font-family:'NSWS Flags',var(--nsws-chat-text),var(--nsws-chat-emoji),sans-serif;font-size:16px;box-shadow:0 8px 28px rgba(0,0,0,.45);pointer-events:auto;touch-action:none;}
#nsws-chat.min{min-height:0;height:auto!important;width:230px!important;min-width:0;}
#nsws-chat.min>:not(.bar){display:none!important;}
#nsws-chat.full{left:0!important;top:0!important;width:100%!important;height:100%!important;z-index:10002;font-size:19px;}
#nsws-chat.full>.grip{display:none;}
#nsws-chat>.bar{display:flex;align-items:center;gap:6px;height:36px;flex-shrink:0;padding:0 4px 0 10px;background:var(--button-color,#112052);cursor:move;user-select:none;}
#nsws-chat.full>.bar{cursor:default;}
#nsws-chat>.bar>.title{flex-shrink:0;}
#nsws-chat>.bar>.online{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:13px;opacity:.75;}
#nsws-chat>.bar>.online::before{content:"";display:inline-block;width:8px;height:8px;margin-right:5px;border-radius:50%;background:#3ba55d;vertical-align:1px;}
#nsws-chat>.bar>.online:empty::before{display:none;}
#nsws-chat>.bar>.unread{display:none;min-width:20px;padding:0 6px;border-radius:10px;background:#e0464b;font-size:14px;line-height:20px;text-align:center;}
#nsws-chat.min>.bar>.unread.on{display:block;}
#nsws-chat>.bar>.unread.ping{background:#f0b232;color:#1a1a1a;}
#nsws-chat>.bar>button{width:30px;height:28px;padding:0;border:0;background:transparent;color:inherit;font:inherit;font-size:18px;line-height:28px;cursor:pointer;}
#nsws-chat>.bar>button:hover{background:var(--button-hover-color,#334b77);}
#nsws-chat.ping-flash{animation:nsws-chat-ping 1.8s ease-out;}
@keyframes nsws-chat-ping{0%,35%{box-shadow:0 0 0 3px #f0b232,0 8px 28px rgba(0,0,0,.45);}100%{box-shadow:0 0 0 0 rgba(240,178,50,0),0 8px 28px rgba(0,0,0,.45);}}
#nsws-chat>.log{flex:1;min-height:0;overflow-y:auto;padding:4px 0 8px;background:var(--surface-secondary-color,#212b58);user-select:text;touch-action:pan-y;overflow-wrap:anywhere;}
#nsws-chat .m{position:relative;padding:1px 10px 1px 24px;line-height:1.35;}
#nsws-chat .m::before{content:"";position:absolute;left:11px;top:0;bottom:0;width:3px;background:var(--c);opacity:.8;}
#nsws-chat .m.head{margin-top:12px;padding-top:2px;}
#nsws-chat .m.head::before{border-radius:2px 2px 0 0;}
#nsws-chat .m:hover,#nsws-chat .m.open{background:rgba(0,0,0,.14);}
#nsws-chat .m>.meta{display:flex;align-items:baseline;flex-wrap:wrap;gap:0 7px;}
#nsws-chat .m>.meta>.nick{font-weight:var(--nsws-chat-name-weight);}
#nsws-chat .m>.meta>.badge{align-self:center;padding:0 5px;background:#e6a23c;color:#1a1a1a;font-family:ForcedSquare,Arial,sans-serif;font-style:italic;font-weight:normal;font-size:.7em;line-height:1;}
#nsws-chat .m>.meta>.time{font-size:.7em;opacity:.5;}
#nsws-chat .m>.text.jumbo{font-family:var(--nsws-chat-emoji),sans-serif;font-size:2.3em;line-height:1.2;}
#nsws-chat .m.pinged{background:rgba(240,178,50,.12);box-shadow:inset 3px 0 0 #f0b232;}
#nsws-chat .m.pinged:hover,#nsws-chat .m.pinged.open{background:rgba(240,178,50,.18);}
#nsws-chat .mention{padding:0 2px;background:rgba(88,101,242,.35);color:#d4d8ff;}
#nsws-chat .m>.actions{position:absolute;top:-14px;right:10px;z-index:1;display:none;align-items:center;gap:1px;padding:2px;border-radius:6px;background:var(--surface-color,#28346a);box-shadow:0 2px 10px rgba(0,0,0,.45);}
#nsws-chat .m:first-child>.actions{top:2px;}
#nsws-chat .m:hover>.actions,#nsws-chat .m.open>.actions{display:flex;}
#nsws-chat .m>.actions>.time{padding:0 6px;font-size:11px;white-space:nowrap;opacity:.6;}
#nsws-chat .m>.actions>button{display:flex;align-items:center;justify-content:center;width:28px;height:26px;padding:0;border:0;border-radius:4px;background:transparent;color:inherit;font-family:var(--nsws-chat-emoji),sans-serif;font-size:16px;cursor:pointer;}
#nsws-chat .m>.actions>button.more{font-family:inherit;font-weight:bold;}
#nsws-chat .m>.actions>button:hover{background:var(--button-hover-color,#334b77);}
#nsws-chat .m>.reactions{display:flex;flex-wrap:wrap;gap:4px;margin:3px 0 2px;}
#nsws-chat .reaction{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 7px;border:1px solid transparent;border-radius:8px;background:rgba(255,255,255,.08);color:inherit;font:inherit;font-size:13px;cursor:pointer;}
#nsws-chat .reaction:hover{border-color:rgba(255,255,255,.28);}
#nsws-chat .reaction.mine{border-color:#5865f2;background:rgba(88,101,242,.3);}
#nsws-chat .reaction>.e{font-family:var(--nsws-chat-emoji),sans-serif;font-size:16px;line-height:1;}
#nsws-chat .reaction.add{display:none;opacity:.75;}
#nsws-chat .m:hover .reaction.add,#nsws-chat .m.open .reaction.add{display:inline-flex;}
#nsws-chat svg{display:block;pointer-events:none;}
#nsws-chat>.log>.sys{padding:6px 14px 2px;font-size:.8em;font-style:italic;text-align:center;opacity:.6;}
#nsws-chat>.log>.tools{display:flex;flex-wrap:wrap;gap:4px;padding:3px 10px 6px 24px;}
#nsws-chat>.log>.tools>button,#nsws-chat>form>button{border:0;background:var(--button-color,#112052);color:inherit;font:inherit;font-size:14px;padding:3px 8px;cursor:pointer;}
#nsws-chat>.log>.tools>button:hover,#nsws-chat>form>button:hover{background:var(--button-hover-color,#334b77);}
#nsws-chat>.status{flex-shrink:0;padding:3px 10px;font-size:14px;background:var(--surface-tertiary-color,#192042);opacity:.8;}
#nsws-chat>.status:empty{display:none;}
#nsws-chat>form{display:flex;flex-shrink:0;gap:6px;padding:6px;}
#nsws-chat>form>input{flex:1;min-width:0;padding:6px 8px;border:0;outline:0;background:var(--surface-tertiary-color,#192042);color:inherit;font:inherit;user-select:text;}
#nsws-chat>form>input:focus{box-shadow:inset 0 0 0 2px var(--button-hover-color,#334b77);}
#nsws-chat>form>button{font-size:16px;padding:0 14px;}
#nsws-chat>form>button.emoji-button{padding:0 6px;background:transparent;font-family:var(--nsws-chat-emoji),sans-serif;font-size:20px;filter:grayscale(1);opacity:.75;}
#nsws-chat>form>button.emoji-button:hover,#nsws-chat>form>button.emoji-button.on{background:transparent;filter:none;opacity:1;transform:scale(1.12);}
#nsws-chat>.suggest{position:absolute;left:6px;right:6px;bottom:48px;z-index:2;display:none;flex-direction:column;max-height:min(300px,calc(100% - 90px));background:var(--surface-tertiary-color,#192042);box-shadow:0 -4px 16px rgba(0,0,0,.4);}
#nsws-chat>.suggest.on{display:flex;}
#nsws-chat>.suggest>.head{flex-shrink:0;padding:7px 10px 5px;font-size:12px;letter-spacing:.04em;text-transform:uppercase;opacity:.65;}
#nsws-chat>.suggest>.list{overflow-y:auto;padding-bottom:4px;}
#nsws-chat>.suggest>.list>div{display:flex;align-items:center;gap:9px;padding:5px 10px;cursor:pointer;}
#nsws-chat>.suggest>.list>div.sel{background:var(--button-hover-color,#334b77);}
#nsws-chat>.suggest>.list>div>.e{width:24px;font-family:var(--nsws-chat-emoji),sans-serif;font-size:20px;text-align:center;}
#nsws-chat>.suggest>.list>div>.dot{width:12px;height:12px;margin:0 6px;border-radius:50%;}
#nsws-chat>.emoji-panel{position:absolute;right:6px;bottom:48px;z-index:3;display:none;flex-direction:column;width:min(352px,calc(100% - 12px));height:min(340px,calc(100% - 90px));background:var(--surface-tertiary-color,#192042);box-shadow:0 -4px 20px rgba(0,0,0,.5);}
#nsws-chat>.emoji-panel.on{display:flex;}
#nsws-chat>.emoji-panel>input{flex-shrink:0;margin:8px 8px 6px;padding:6px 8px;border:0;outline:0;background:var(--surface-secondary-color,#212b58);color:inherit;font:inherit;font-size:15px;user-select:text;}
#nsws-chat>.emoji-panel>.tabs{display:flex;flex-shrink:0;gap:2px;padding:0 6px 6px;overflow-x:auto;}
#nsws-chat>.emoji-panel>.tabs>button{flex:1 0 auto;min-width:28px;height:28px;padding:0;border:0;background:transparent;font-family:var(--nsws-chat-emoji),sans-serif;font-size:17px;cursor:pointer;filter:grayscale(1);opacity:.6;}
#nsws-chat>.emoji-panel>.tabs>button:hover,#nsws-chat>.emoji-panel>.tabs>button.on{background:var(--button-hover-color,#334b77);filter:none;opacity:1;}
#nsws-chat>.emoji-panel>.grid{position:relative;flex:1;min-height:0;overflow-y:auto;padding:0 6px 6px;touch-action:pan-y;}
#nsws-chat>.emoji-panel>.grid>section>h4{position:sticky;top:0;z-index:1;margin:0;padding:6px 4px 4px;background:var(--surface-tertiary-color,#192042);color:rgba(255,255,255,.7);font-size:12px;font-weight:normal;letter-spacing:.04em;text-transform:uppercase;}
#nsws-chat>.emoji-panel>.grid>section>.set{display:grid;grid-template-columns:repeat(auto-fill,minmax(34px,1fr));}
#nsws-chat>.emoji-panel>.grid>section>.set>span{display:flex;align-items:center;justify-content:center;height:34px;font-family:var(--nsws-chat-emoji),sans-serif;font-size:22px;cursor:pointer;}
#nsws-chat>.emoji-panel>.grid>section>.set>span:hover{background:var(--button-hover-color,#334b77);}
#nsws-chat>.emoji-panel>.grid>.none{padding:20px;text-align:center;opacity:.6;}
#nsws-chat>.emoji-panel>.preview{display:flex;flex-shrink:0;align-items:center;gap:8px;height:40px;padding:0 10px;background:var(--surface-secondary-color,#212b58);font-size:14px;overflow:hidden;white-space:nowrap;}
#nsws-chat>.emoji-panel>.preview>.big{font-family:var(--nsws-chat-emoji),sans-serif;font-size:24px;}
#nsws-chat-toast{position:fixed;z-index:91;max-width:320px;padding:8px 12px 8px 10px;border-left:3px solid #f0b232;background:var(--surface-color,#28346a);color:var(--text-color,#fff);font-family:'NSWS Flags',var(--nsws-chat-text),var(--nsws-chat-emoji),sans-serif;font-size:15px;box-shadow:0 6px 20px rgba(0,0,0,.45);pointer-events:none;overflow-wrap:anywhere;transition:opacity .6s;}
#nsws-chat-toast.out{opacity:0;}
#nsws-chat>.grip{position:absolute;right:0;bottom:0;width:16px;height:16px;cursor:nwse-resize;background:linear-gradient(135deg,transparent 50%,rgba(255,255,255,.35) 50%);}
`;

    function currentFont() {
        const id = storageGet(FONT_KEY);
        return FONTS.find((f) => f.id === id) || FONTS[0];
    }

    function applyFont() {
        const font = currentFont();
        const style = document.documentElement.style;
        style.setProperty("--nsws-chat-text", font.text);
        style.setProperty("--nsws-chat-emoji", font.emoji);
        style.setProperty("--nsws-chat-name-weight", font.nameWeight);
        style.setProperty("--nsws-chat-font-style", font.style);
    }

    function storageGet(key) {
        try {
            return localStorage.getItem(key);
        } catch {
            return null;
        }
    }

    function storageSet(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch {}
    }

    function readNickname() {
        try {
            const slot = parseInt(localStorage.getItem("polytrack_v5_prod_user_slot") ?? "0", 10);
            const nick = JSON.parse(localStorage.getItem("polytrack_v5_prod_user_" + (slot >= 0 ? slot : 0)))?.nickname;
            return typeof nick === "string" && nick.trim() ? nick.trim() : "Guest";
        } catch {
            return "Guest";
        }
    }

    function visitorId() {
        let id = storageGet(VISITOR_KEY);
        if (!/^[0-9a-f]{32}$/.test(id || "")) {
            id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
            storageSet(VISITOR_KEY, id);
        }
        return id;
    }

    function luminance(rgb) {
        const [r, g, b] = rgb.map((v) => {
            v /= 255;
            return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }

    function hslToRgb(h, s, l) {
        const k = (n) => (n + h / 30) % 12;
        const a = s * Math.min(l, 1 - l);
        return [0, 8, 4].map((n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)))));
    }

    // Each player's own colour, from the random hex of their id, so everyone sees the same one.
    // Greys get some colour, and dark colours are lightened (keeping their hue) until they reach
    // 4.5:1 contrast on the chat's dark blue.
    const colors = new Map();
    function nickColor(uid) {
        if (colors.has(uid)) return colors.get(uid);
        const [r, g, b] = [0, 2, 4].map((i) => (parseInt(uid.slice(i, i + 2), 16) || 0) / 255);
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        let l = (max + min) / 2;
        const d = max - min;
        let s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
        let h = d === 0 ? (parseInt(uid.slice(6, 8), 16) || 0) * 360 / 256
            : max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
        h = (h + 360) % 360;
        s = Math.max(s, 0.5);
        const target = 4.5 * (luminance(LOG_BG) + 0.05) - 0.05;
        let rgb = hslToRgb(h, s, l);
        while (luminance(rgb) < target && l < 0.97) rgb = hslToRgb(h, s, l = Math.min(0.97, l + 0.02));
        const hex = "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("");
        colors.set(uid, hex);
        return hex;
    }

    function sameDay(a, b) {
        return new Date(a).toDateString() === new Date(b).toDateString();
    }

    function shortTime(at) {
        return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    }

    function headerTime(at) {
        const now = Date.now();
        if (sameDay(at, now)) return "Today at " + shortTime(at);
        if (sameDay(at, now - 86400000)) return "Yesterday at " + shortTime(at);
        return new Date(at).toLocaleDateString() + " " + shortTime(at);
    }

    let jumboTest = null;
    let emojiCount = null;
    try {
        jumboTest = new RegExp("^(?:\\p{RGI_Emoji}|\\s)+$", "v");
        emojiCount = new RegExp("\\p{RGI_Emoji}", "gv");
    } catch {}

    function isJumbo(text) {
        if (!jumboTest || !jumboTest.test(text)) return false;
        return (text.match(emojiCount) || []).length <= JUMBO_MAX;
    }

    let root = null;
    let log = null;
    let input = null;
    let statusLine = null;
    let onlineLabel = null;
    let unreadBadge = null;
    let minButton = null;
    let fullButton = null;
    let bellButton = null;
    let emojiButton = null;
    let suggestBox = null;
    let panel = null;
    let socket = null;
    // The long-polling connection, when WebSockets are blocked: { epoch, seq, key, controllers }.
    let http = null;
    let wsFails = 0;
    let keepAliveTimer = null;
    let retryTimer = null;
    let retryDelay = 2000;
    let me = null;
    let items = [];
    let unread = 0;
    let mentions = 0;
    let suggest = { kind: null, items: [], index: 0 };
    let users = [];
    let usersAt = 0;
    let toast = null;
    let audio = null;
    let lastChime = 0;
    // The page title from before a ping marked it, or null while it isn't marked.
    let titleBefore = null;
    // Sending waits until readyAt: one second after each message (slow mode), or the end of a timeout.
    let readyAt = 0;
    let timedOut = false;
    let lastText = "";
    let sendTimer = null;
    let waitTimer = null;
    let layout = loadLayout();
    let shown = null;

    // { groups: [{ name, emojis: [{ e, names, words }] }], byName: Map }, loaded on first use.
    let emoji = null;
    let emojiLoading = null;
    // The message the emoji panel is picking a reaction for, or null while it types into the box.
    let reactTarget = null;
    let lastPointer = "mouse";

    function loadEmoji() {
        if (emoji || emojiLoading) return emojiLoading;
        emojiLoading = fetch(EMOJI_URL).then((r) => r.json()).then((groups) => {
            const byName = new Map();
            const all = [];
            for (const g of groups) {
                g.emojis = g.emojis.map(([e, names, words], i) => {
                    const entry = { e, names: names.split(" "), words, order: all.length + i };
                    for (const name of entry.names) if (!byName.has(name)) byName.set(name, e);
                    return entry;
                });
                all.push(...g.emojis);
            }
            emoji = { groups, all, byName };
            return emoji;
        }).catch(() => {
            emojiLoading = null;
            return null;
        });
        return emojiLoading;
    }

    function recentEmoji() {
        try {
            const list = JSON.parse(storageGet(RECENT_EMOJI_KEY));
            return Array.isArray(list) ? list.filter((e) => typeof e === "string").slice(0, RECENT_EMOJI) : [];
        } catch {
            return [];
        }
    }

    function useEmoji(e) {
        storageSet(RECENT_EMOJI_KEY, JSON.stringify([e, ...recentEmoji().filter((x) => x !== e)].slice(0, RECENT_EMOJI)));
    }

    function emojiName(e) {
        return emoji?.all.find((x) => x.e === e)?.names[0] ?? "";
    }

    // ":sob:" becomes the emoji itself, wherever it is in the text.
    function replaceShortcodes(text) {
        if (!emoji) return text;
        return text.replace(/:([a-z0-9_+-]+):/gi, (whole, name) => {
            const e = emoji.byName.get(name.toLowerCase());
            if (!e) return whole;
            useEmoji(e);
            return e;
        });
    }

    function insertAtCaret(text, from, to) {
        const start = from ?? input.selectionStart ?? input.value.length;
        const end = to ?? input.selectionEnd ?? start;
        const value = input.value.slice(0, start) + text + input.value.slice(end);
        if ([...value].length > MAX_TEXT) return;
        input.value = value;
        const pos = start + text.length;
        input.setSelectionRange(pos, pos);
    }

    function loadLayout() {
        let saved = null;
        try {
            saved = JSON.parse(storageGet(LAYOUT_KEY));
        } catch {}
        const w = Math.max(MIN_W, Number(saved?.w) || 380);
        const h = Math.max(MIN_H, Number(saved?.h) || 340);
        return {
            w,
            h,
            x: Number.isFinite(saved?.x) ? saved.x : 12,
            y: Number.isFinite(saved?.y) ? saved.y : window.innerHeight - h - 12,
            min: !!saved?.min,
            full: !!saved?.full,
        };
    }

    function saveLayout() {
        storageSet(LAYOUT_KEY, JSON.stringify(layout));
    }

    // Keeps the title bar on screen, so the window can always be dragged back. Only a drag
    // commits the clamped values: a viewport that shrinks for a moment (a phone keyboard,
    // a resized window) mustn't shrink the saved layout.
    function applyLayout(commit) {
        if (!root) return;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const w = Math.min(Math.max(MIN_W, layout.w), vw - 2 * MARGIN);
        const h = Math.min(Math.max(MIN_H, layout.h), vh - 2 * MARGIN);
        const width = layout.min ? root.offsetWidth || 230 : w;
        shown = {
            w,
            h,
            x: Math.min(Math.max(0, layout.x), Math.max(0, vw - width)),
            y: Math.min(Math.max(0, layout.y), Math.max(0, vh - (layout.min ? 36 : h))),
        };
        if (commit === true) Object.assign(layout, shown);
        root.style.left = shown.x + "px";
        root.style.top = shown.y + "px";
        root.style.width = shown.w + "px";
        root.style.height = shown.h + "px";
        root.classList.toggle("min", layout.min);
        root.classList.toggle("full", layout.full && !layout.min);
        minButton.textContent = layout.min ? icon(0x25a1) : icon(0x2013);
        minButton.title = layout.min ? "Restore" : "Minimize";
        fullButton.textContent = layout.full ? icon(0x2750) : icon(0x26f6);
        fullButton.title = layout.full ? "Exit fullscreen" : "Fullscreen";
    }

    function setMinimized(min) {
        layout.min = min;
        if (min) {
            hideSuggest();
            closePanel();
        } else {
            unread = mentions = 0;
            updateUnread();
        }
        applyLayout();
        saveLayout();
        if (!min) scrollToEnd(true);
    }

    function setFullscreen(full) {
        layout.full = full;
        if (full) {
            layout.min = false;
            unread = mentions = 0;
            updateUnread();
        }
        applyLayout();
        saveLayout();
        scrollToEnd(true);
    }

    function updateUnread() {
        if (!unreadBadge) return;
        const count = mentions || unread;
        unreadBadge.textContent = (mentions ? "@" : "") + (count > 99 ? "99+" : String(count));
        unreadBadge.classList.toggle("on", count > 0);
        unreadBadge.classList.toggle("ping", mentions > 0);
    }

    function updateOnline() {
        if (!onlineLabel) return;
        const n = window.__nswsPlayersOnline;
        onlineLabel.textContent = Number.isSafeInteger(n) ? n + " online" : "";
    }

    function pingSoundOn() {
        return storageGet(PING_SOUND_KEY) !== "false";
    }

    function updateBell() {
        const on = pingSoundOn();
        bellButton.textContent = icon(on ? 0x1f514 : 0x1f515);
        bellButton.title = on ? "Ping sound: on" : "Ping sound: off";
    }

    // A soft two-note chime through its own AudioContext; nothing touches the game's audio.
    function playPing() {
        try {
            audio = audio || new AudioContext();
            if (audio.state === "suspended") audio.resume();
            const t = audio.currentTime;
            const gain = audio.createGain();
            gain.connect(audio.destination);
            gain.gain.setValueAtTime(0.0001, t);
            gain.gain.exponentialRampToValueAtTime(0.1, t + 0.015);
            gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
            for (const [freq, delay] of [[880, 0], [1320, 0.09]]) {
                const osc = audio.createOscillator();
                osc.type = "sine";
                osc.frequency.value = freq;
                osc.connect(gain);
                osc.start(t + delay);
                osc.stop(t + 0.42);
            }
        } catch {}
    }

    // Never takes focus, opens the window or catches clicks, so driving carries on untouched.
    function notifyPing(m) {
        if (layout.min) {
            mentions++;
            updateUnread();
            showToast(m);
        }
        root.classList.remove("ping-flash");
        void root.offsetWidth;
        root.classList.add("ping-flash");
        if (pingSoundOn() && Date.now() - lastChime > PING_SOUND_GAP_MS) {
            lastChime = Date.now();
            playPing();
        }
        if (document.visibilityState === "hidden" && titleBefore == null) {
            titleBefore = document.title;
            document.title = TITLE_MARK + (titleBefore || "PolyTrack");
        }
    }

    function showToast(m) {
        toast?.remove();
        toast = document.createElement("div");
        toast.id = "nsws-chat-toast";
        const who = document.createElement("b");
        who.textContent = m.nick;
        who.style.color = nickColor(m.uid);
        toast.append(who, " pinged you: ", m.text.length > 90 ? m.text.slice(0, 90) + "..." : m.text);
        document.body.appendChild(toast);
        const bar = root.getBoundingClientRect();
        const below = bar.bottom + 6 + toast.offsetHeight <= window.innerHeight;
        toast.style.left = Math.max(0, Math.min(bar.left, window.innerWidth - toast.offsetWidth)) + "px";
        toast.style.top = (below ? bar.bottom + 6 : Math.max(0, bar.top - 6 - toast.offsetHeight)) + "px";
        const shownToast = toast;
        setTimeout(() => shownToast.classList.add("out"), 5000);
        setTimeout(() => shownToast.remove(), 5600);
    }

    function pingsMe(m) {
        return !!me && m.uid !== me.uid && (m.pings || []).some((p) => p.uid === me.uid || p.uid === "*");
    }

    function appendText(el, text, pings) {
        const nicks = (pings || []).map((p) => p.nick).filter(Boolean).sort((a, b) => b.length - a.length);
        if (!nicks.length) return el.append(text);
        const re = new RegExp("@(?:" + nicks.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "giu");
        let at = 0;
        for (const match of text.matchAll(re)) {
            el.append(text.slice(at, match.index));
            const mention = document.createElement("span");
            mention.className = "mention";
            mention.textContent = match[0];
            el.appendChild(mention);
            at = match.index + match[0].length;
        }
        el.append(text.slice(at));
    }

    // What the text before the caret is asking to complete: ":so" (emoji) or "@na" (a player).
    function completionQuery() {
        const before = input.value.slice(0, input.selectionStart ?? input.value.length);
        const colon = /(^|[\s([{"'])(:([a-z0-9_+-]{2,32}))$/i.exec(before);
        if (colon) return { kind: "emoji", at: before.length - colon[2].length, query: colon[3].toLowerCase() };
        const at = before.lastIndexOf("@");
        if (at < 0 || (at > 0 && !/\s/.test(before[at - 1]))) return null;
        const query = before.slice(at + 1);
        return query.length > 32 || /^\s/.test(query) ? null : { kind: "mention", at, query: query.toLowerCase() };
    }

    // Discord's order: names that start with the query, then names with a word that does, then
    // names that contain it, then emoji whose description does; shorter names first within each.
    function emojiMatches(query, limit) {
        const scored = [];
        for (const entry of emoji.all) {
            let score = 9;
            for (const name of entry.names) {
                const s = name === query ? 0 : name.startsWith(query) ? 1 : name.includes("_" + query) ? 2 : name.includes(query) ? 3 : 9;
                score = Math.min(score, s);
            }
            if (score === 9 && entry.words.split(" ").some((w) => w.startsWith(query))) score = 4;
            if (score < 9) scored.push([score, entry]);
        }
        const best = (entry) => entry.names.find((n) => n.includes(query)) ?? entry.names[0];
        scored.sort((a, b) => a[0] - b[0] || best(a[1]).length - best(b[1]).length || a[1].order - b[1].order);
        return scored.slice(0, limit).map(([, entry]) => entry);
    }

    function hideSuggest() {
        suggest = { kind: null, items: [], index: 0 };
        suggestBox?.classList.remove("on");
    }

    function updateSuggest() {
        if (!input || panel?.classList.contains("on")) return hideSuggest();
        const q = me && completionQuery();
        if (!q) return hideSuggest();
        const index = suggest.kind === q.kind ? suggest.index : 0;
        let list;
        if (q.kind === "emoji") {
            if (!emoji) {
                loadEmoji().then(() => emoji && updateSuggest());
                return hideSuggest();
            }
            list = emojiMatches(q.query, MAX_SUGGEST).map((entry) => ({ label: ":" + entry.names[0] + ":", e: entry.e, insert: entry.e }));
        } else {
            if (Date.now() - usersAt > WHO_MS) {
                usersAt = Date.now();
                send({ t: "who" });
            }
            const seen = new Set();
            list = users.filter((u) => {
                const key = u.nick.toLowerCase();
                if (u.uid === me.uid || seen.has(key) || !key.startsWith(q.query)) return false;
                seen.add(key);
                return true;
            }).slice(0, 6).map((u) => ({ label: "@" + u.nick, uid: u.uid, insert: "@" + u.nick }));
            if (me.owner && "everyone".startsWith(q.query)) list.push({ label: "@everyone", insert: "@everyone" });
        }
        if (!list.length) return hideSuggest();
        suggest = { kind: q.kind, items: list, index: Math.min(index, list.length - 1) };

        suggestBox.textContent = "";
        const head = document.createElement("div");
        head.className = "head";
        head.textContent = q.kind === "emoji" ? "Emoji matching :" + q.query : "Players online";
        const box = document.createElement("div");
        box.className = "list";
        list.forEach((item, i) => {
            const row = document.createElement("div");
            if (i === suggest.index) row.className = "sel";
            const lead = document.createElement("span");
            if (item.e) {
                lead.className = "e";
                lead.textContent = item.e;
            } else {
                lead.className = "dot";
                lead.style.background = item.uid ? nickColor(item.uid) : "#f0b232";
            }
            row.append(lead, item.label);
            row.addEventListener("mousedown", (e) => {
                e.preventDefault();
                pickSuggest(i);
            });
            box.appendChild(row);
        });
        suggestBox.append(head, box);
        suggestBox.classList.add("on");
        box.children[suggest.index]?.scrollIntoView({ block: "nearest" });
    }

    function pickSuggest(i) {
        const q = completionQuery();
        const item = suggest.items[i];
        if (!q || !item) return;
        insertAtCaret(item.insert + " ", q.at, input.selectionStart ?? input.value.length);
        if (item.e) useEmoji(item.e);
        hideSuggest();
    }

    function suggestKeys(e) {
        if (!suggest.items.length) return;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            suggest.index = (suggest.index + (e.key === "ArrowDown" ? 1 : -1) + suggest.items.length) % suggest.items.length;
            updateSuggest();
        } else if (e.key === "Tab" || e.key === "Enter") {
            e.preventDefault();
            pickSuggest(suggest.index);
        } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopImmediatePropagation();
            hideSuggest();
        }
    }

    // Typing the closing colon of a known ":name:" turns it into the emoji straight away.
    function onInput() {
        const caret = input.selectionStart ?? input.value.length;
        const done = /:([a-z0-9_+-]+):$/i.exec(input.value.slice(0, caret));
        const e = done && emoji?.byName.get(done[1].toLowerCase());
        if (e) {
            insertAtCaret(e, caret - done[0].length, caret);
            useEmoji(e);
        }
        updateSuggest();
    }

    function closePanel() {
        reactTarget = null;
        if (!panel?.classList.contains("on")) return;
        panel.classList.remove("on");
        emojiButton.classList.remove("on");
        document.removeEventListener("pointerdown", outsidePanel, true);
    }

    function outsidePanel(e) {
        if (!panel.contains(e.target) && e.target !== emojiButton) closePanel();
    }

    function renderPanelGrid() {
        const grid = panel.querySelector(".grid");
        const tabs = panel.querySelector(".tabs");
        const query = panel.querySelector("input").value.trim().toLowerCase();
        grid.textContent = "";
        // Each header sits in its own section, so it only sticks while that section is in view.
        const section = (title, list) => {
            const box = document.createElement("section");
            const h = document.createElement("h4");
            h.textContent = title;
            const set = document.createElement("div");
            set.className = "set";
            for (const e of list) {
                const cell = document.createElement("span");
                cell.textContent = e;
                set.appendChild(cell);
            }
            box.append(h, set);
            grid.appendChild(box);
            return box;
        };
        tabs.style.display = query ? "none" : "";
        if (query) {
            const words = query.split(/\s+/);
            const found = emojiMatches(words[0], 400).filter((entry) => words.slice(1).every((w) => (entry.names.join(" ") + " " + entry.words).includes(w)));
            if (found.length) section("Search results", found.map((entry) => entry.e));
            else {
                const none = document.createElement("div");
                none.className = "none";
                none.textContent = "No emoji found";
                grid.appendChild(none);
            }
            grid.scrollTop = 0;
            return;
        }
        const sets = [];
        const recent = recentEmoji();
        if (recent.length) sets.push(section("Frequently used", recent));
        for (const g of emoji.groups) sets.push(section(g.name, g.emojis.map((entry) => entry.e)));
        tabs.textContent = "";
        const tabFor = [];
        if (recent.length) tabFor.push([icon(0x1f552), "Frequently used", sets[0]]);
        emoji.groups.forEach((g, i) => tabFor.push([icon(TAB_ICONS[i] || 0x2753), g.name, sets[i + (recent.length ? 1 : 0)]]));
        for (const [glyph, title, box] of tabFor) {
            const b = document.createElement("button");
            b.type = "button";
            b.textContent = glyph;
            b.title = title;
            b.addEventListener("click", () => {
                grid.scrollTop = box.offsetTop;
            });
            tabs.appendChild(b);
        }
        markTab();
    }

    function markTab() {
        const grid = panel.querySelector(".grid");
        let current = 0;
        [...grid.querySelectorAll("section")].forEach((box, i) => {
            if (box.offsetTop <= grid.scrollTop + 8) current = i;
        });
        [...panel.querySelectorAll(".tabs>button")].forEach((b, i) => b.classList.toggle("on", i === current));
    }

    function buildPanel() {
        panel = document.createElement("div");
        panel.className = "emoji-panel";
        const search = document.createElement("input");
        search.type = "text";
        search.placeholder = "Find the perfect emoji";
        search.autocomplete = "off";
        search.spellcheck = false;
        const tabs = document.createElement("div");
        tabs.className = "tabs";
        const grid = document.createElement("div");
        grid.className = "grid";
        const preview = document.createElement("div");
        preview.className = "preview";
        preview.textContent = "Shift-click to pick several";
        panel.append(search, tabs, grid, preview);

        search.addEventListener("input", renderPanelGrid);
        search.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                e.preventDefault();
                closePanel();
                input.focus();
            } else if (e.key === "Enter") {
                e.preventDefault();
                const first = grid.querySelector(".set>span");
                if (first) pickPanelEmoji(first.textContent, false);
            }
        });
        grid.addEventListener("scroll", markTab, { passive: true });
        grid.addEventListener("click", (e) => {
            const cell = e.target.closest(".set>span");
            if (cell) pickPanelEmoji(cell.textContent, e.shiftKey);
        });
        grid.addEventListener("mouseover", (e) => {
            const cell = e.target.closest(".set>span");
            if (!cell) return;
            preview.textContent = "";
            const big = document.createElement("span");
            big.className = "big";
            big.textContent = cell.textContent;
            preview.append(big, ":" + emojiName(cell.textContent) + ":");
        });
        root.appendChild(panel);
    }

    // Like Discord, shift-click adds several without closing the panel.
    function pickPanelEmoji(e, keepOpen) {
        if (reactTarget != null) {
            send({ t: "react", id: reactTarget, e });
        } else {
            input.focus();
            insertAtCaret(e);
        }
        useEmoji(e);
        if (!keepOpen) closePanel();
    }

    async function togglePanel(target) {
        const forReaction = Number.isSafeInteger(target) ? target : null;
        if (panel?.classList.contains("on") && reactTarget === forReaction) {
            closePanel();
            return;
        }
        if (!(await loadEmoji())) {
            addSystem("Couldn't load the emoji list.");
            return;
        }
        if (!panel) buildPanel();
        hideSuggest();
        reactTarget = forReaction;
        panel.querySelector("input").value = "";
        panel.querySelector("input").placeholder = forReaction != null ? "Pick a reaction" : "Find the perfect emoji";
        renderPanelGrid();
        panel.classList.add("on");
        emojiButton.classList.add("on");
        panel.querySelector(".grid").scrollTop = 0;
        panel.querySelector("input").focus();
        document.addEventListener("pointerdown", outsidePanel, true);
    }

    function setStatus(text) {
        if (statusLine) statusLine.textContent = text;
    }

    function nearBottom() {
        return log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    }

    function scrollToEnd(force) {
        if (log && (force || nearBottom())) log.scrollTop = log.scrollHeight;
    }

    function closeTools() {
        log?.querySelector(".tools")?.remove();
    }

    function ownerTools(el, m) {
        const open = el.nextElementSibling?.classList.contains("tools");
        closeTools();
        if (open) return;
        const tools = document.createElement("div");
        tools.className = "tools";
        const add = (label, data) => {
            const b = document.createElement("button");
            b.textContent = label;
            b.addEventListener("click", () => {
                send(data);
                closeTools();
            });
            tools.appendChild(b);
        };
        add("Delete", { t: "del", id: m.id });
        add("Mute 10m", { t: "mute", uid: m.uid, minutes: 10 });
        add("Mute 1h", { t: "mute", uid: m.uid, minutes: 60 });
        add("Mute 1d", { t: "mute", uid: m.uid, minutes: 1440 });
        add("Delete all theirs", { t: "clear", uid: m.uid });
        el.after(tools);
    }

    // Starts a new name header unless the last item is a message by the same player, under the
    // same name and badge, sent within GROUP_MS on the same day.
    function startsGroup(prev, m) {
        if (prev?.kind !== "msg") return true;
        const p = prev.m;
        return p.uid !== m.uid || p.nick !== m.nick || p.owner !== m.owner || m.at - p.at > GROUP_MS || !sameDay(p.at, m.at);
    }

    function quickReactions() {
        return [...new Set([...recentEmoji(), ...QUICK_REACTIONS])].slice(0, 3);
    }

    function reactionButton(m, kind) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = kind.users.some((u) => u.uid === me?.uid) ? "reaction mine" : "reaction";
        const e = document.createElement("span");
        e.className = "e";
        e.textContent = kind.e;
        b.append(e, String(kind.users.length));
        const names = kind.users.map((u) => u.nick);
        const who = names.length > 6 ? names.slice(0, 6).join(", ") + " and " + (names.length - 6) + " more" : names.join(", ");
        const name = emojiName(kind.e);
        b.title = who + " reacted with " + (name ? ":" + name + ":" : kind.e);
        b.addEventListener("click", () => send({ t: "react", id: m.id, e: kind.e }));
        return b;
    }

    function actionButton(label, title, onClick, html) {
        const b = document.createElement("button");
        b.type = "button";
        b.title = title;
        if (html) b.innerHTML = label;
        else b.textContent = label;
        b.addEventListener("click", onClick);
        return b;
    }

    // Shown on hover, or by a tap on touch screens: the time, quick reactions, the reaction
    // picker and, for the owner, the moderation tools.
    function actionsBar(el, m, head) {
        const bar = document.createElement("div");
        bar.className = "actions";
        if (!head) {
            const time = document.createElement("span");
            time.className = "time";
            time.textContent = shortTime(m.at);
            time.title = headerTime(m.at);
            bar.appendChild(time);
        }
        for (const e of quickReactions()) bar.appendChild(actionButton(e, "React with " + e, () => send({ t: "react", id: m.id, e })));
        bar.appendChild(actionButton(ADD_REACTION_ICON, "Add reaction", () => togglePanel(m.id), true));
        if (me?.owner) {
            const more = actionButton(icon(0x22ef), "Moderate", () => ownerTools(el, m));
            more.classList.add("more");
            bar.appendChild(more);
        }
        return bar;
    }

    function messageElement(m, head) {
        const el = document.createElement("div");
        el.className = head ? "m head" : "m";
        el.dataset.id = m.id;
        const color = nickColor(m.uid);
        el.style.setProperty("--c", color);
        if (head) {
            const meta = document.createElement("div");
            meta.className = "meta";
            const nick = document.createElement("span");
            nick.className = "nick";
            nick.style.color = color;
            nick.textContent = m.nick;
            meta.appendChild(nick);
            if (m.owner) {
                const badge = document.createElement("span");
                badge.className = "badge";
                badge.textContent = "OWNER";
                meta.appendChild(badge);
            }
            const time = document.createElement("span");
            time.className = "time";
            time.textContent = headerTime(m.at);
            meta.appendChild(time);
            el.appendChild(meta);
        }
        const text = document.createElement("div");
        text.className = isJumbo(m.text) ? "text jumbo" : "text";
        appendText(text, m.text, m.pings);
        el.appendChild(text);
        if (m.reactions?.length) {
            const row = document.createElement("div");
            row.className = "reactions";
            for (const kind of m.reactions) row.appendChild(reactionButton(m, kind));
            const add = actionButton(ADD_REACTION_ICON, "Add reaction", () => togglePanel(m.id), true);
            add.className = "reaction add";
            row.appendChild(add);
            el.appendChild(row);
        }
        el.appendChild(actionsBar(el, m, head));
        if (pingsMe(m)) el.classList.add("pinged");
        // Touch screens have no hover, so a tap opens the action bar.
        el.addEventListener("click", (e) => {
            if (lastPointer !== "touch" || e.target.closest("button")) return;
            const open = !el.classList.contains("open");
            for (const other of log.querySelectorAll(".m.open")) other.classList.remove("open");
            el.classList.toggle("open", open);
        });
        return el;
    }

    function rerenderMessage(id) {
        const index = items.findIndex((item) => item.kind === "msg" && item.m.id === id);
        const old = log?.querySelector('.m[data-id="' + id + '"]');
        if (index < 0 || !old) return;
        const stick = nearBottom();
        const el = itemElement(items[index], items[index - 1]);
        if (old.classList.contains("open")) el.classList.add("open");
        old.replaceWith(el);
        scrollToEnd(stick);
    }

    function applyReaction(data) {
        const m = items.find((item) => item.kind === "msg" && item.m.id === data.id)?.m;
        if (!m) return;
        m.reactions = m.reactions || [];
        let kind = m.reactions.find((k) => k.e === data.e);
        if (data.on) {
            if (!kind) m.reactions.push(kind = { e: data.e, users: [] });
            if (!kind.users.some((u) => u.uid === data.uid)) kind.users.push({ uid: data.uid, nick: data.nick });
        } else if (kind) {
            kind.users = kind.users.filter((u) => u.uid !== data.uid);
            if (!kind.users.length) m.reactions = m.reactions.filter((k) => k !== kind);
        }
        rerenderMessage(m.id);
    }

    function itemElement(item, prev) {
        if (item.kind === "msg") return messageElement(item.m, startsGroup(prev, item.m));
        const el = document.createElement("div");
        el.className = "sys";
        el.textContent = item.text;
        return el;
    }

    function renderLog() {
        if (!log) return;
        const stick = nearBottom();
        log.textContent = "";
        items.forEach((item, i) => log.appendChild(itemElement(item, items[i - 1])));
        scrollToEnd(stick);
    }

    function addItem(item) {
        items.push(item);
        if (items.length > MAX_ITEMS + 20) {
            items = items.slice(-MAX_ITEMS);
            renderLog();
            return;
        }
        if (!log) return;
        const stick = nearBottom();
        log.appendChild(itemElement(item, items[items.length - 2]));
        scrollToEnd(stick);
    }

    function addSystem(text) {
        addItem({ kind: "sys", text });
    }

    function connected() {
        return !!me && (socket?.readyState === WebSocket.OPEN || !!http);
    }

    function send(data) {
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
        else if (http && me) httpSend(data);
    }

    function onServer(data) {
        if (!data || typeof data !== "object") return;
        if (data.t === "init") {
            me = data.you;
            items = data.messages.map((m) => ({ kind: "msg", m }));
            items.push({ kind: "sys", text: "Connected. Be nice - slurs are filtered." });
            renderLog();
            scrollToEnd(true);
        } else if (data.t === "msg") {
            addItem({ kind: "msg", m: data.m });
            if (layout.min && data.m.uid !== me?.uid) {
                unread++;
                updateUnread();
            }
            if (pingsMe(data.m)) notifyPing(data.m);
        } else if (data.t === "who") {
            users = Array.isArray(data.users) ? data.users : [];
            if (suggest.kind === "mention" || document.activeElement === input) updateSuggest();
        } else if (data.t === "del") {
            items = items.filter((item) => item.kind !== "msg" || item.m.id !== data.id);
            renderLog();
        } else if (data.t === "react") {
            applyReaction(data);
        } else if (data.t === "clear") {
            items = items.filter((item) => item.kind !== "msg" || item.m.uid !== data.uid);
            for (const item of items) {
                if (item.kind !== "msg" || !item.m.reactions) continue;
                for (const kind of item.m.reactions) kind.users = kind.users.filter((u) => u.uid !== data.uid);
                item.m.reactions = item.m.reactions.filter((kind) => kind.users.length);
            }
            renderLog();
        } else if (data.t === "err") {
            addSystem(data.text);
        } else if (data.t === "slow" || data.t === "timeout") {
            // The server refused the last message, so it goes back in the box.
            if (!input.value) input.value = lastText;
            readyAt = Math.max(readyAt, Date.now() + Number(data.ms || SLOW_MS));
            if (data.t === "timeout") {
                timedOut = true;
                addSystem(data.text);
            } else {
                sendTimer = setTimeout(trySend, readyAt - Date.now());
            }
            showWait();
        }
    }

    function waitLabel(ms) {
        const seconds = Math.ceil(ms / 1000);
        return seconds < 60 ? seconds + "s" : Math.floor(seconds / 60) + "m " + (seconds % 60) + "s";
    }

    function showWait() {
        clearInterval(waitTimer);
        const tick = () => {
            const left = readyAt - Date.now();
            if (left <= 0 || !root) {
                clearInterval(waitTimer);
                timedOut = false;
                if (connected()) setStatus("");
                return;
            }
            setStatus(timedOut ? "Timed out for spamming: " + waitLabel(left) : "Slow mode: one message a second");
        };
        tick();
        waitTimer = setInterval(tick, 250);
    }

    async function connect() {
        clearTimeout(retryTimer);
        if (!root || socket || http) return;
        // This network blocked WebSockets recently: go straight to HTTPS, and check quietly
        // whether sockets work again so the next visit can use them.
        if (httpRecently()) {
            probeWebSocket();
            return connectHttp();
        }
        setStatus("Connecting...");
        let ws;
        try {
            ws = new WebSocket(WS_URL);
        } catch {
            return wsFailed();
        }
        socket = ws;
        let ready = false;
        // Some filters hold a blocked socket open forever instead of refusing it.
        const openTimer = setTimeout(() => {
            if (socket === ws && ws.readyState === WebSocket.CONNECTING) ws.close();
        }, WS_OPEN_TIMEOUT_MS);
        ws.addEventListener("open", async () => {
            clearTimeout(openTimer);
            retryDelay = 2000;
            setStatus("");
            const hello = { t: "hello", v: visitorId(), nick: readNickname() };
            const key = await ownerKey();
            if (key) hello.key = key;
            if (socket === ws) ws.send(JSON.stringify(hello));
            keepAliveTimer = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) ws.send("ping");
            }, KEEPALIVE_MS);
        });
        ws.addEventListener("message", (e) => {
            if (socket !== ws || e.data === "pong") return;
            let data;
            try {
                data = JSON.parse(e.data);
            } catch {
                return;
            }
            onServer(data);
            if (data?.t === "init") {
                ready = true;
                wsFails = 0;
                storageSet(TRANSPORT_KEY, "");
            }
        });
        ws.addEventListener("close", () => {
            clearTimeout(openTimer);
            if (socket !== ws) return;
            socket = null;
            clearInterval(keepAliveTimer);
            // A socket that worked and then dropped just reconnects; one that never got going
            // counts towards falling back to HTTPS.
            if (ready) retry();
            else wsFailed();
        });
    }

    async function ownerKey() {
        try {
            return (await window.__nswsOwner?.token?.()) || null;
        } catch {
            return null;
        }
    }

    function wsFailed() {
        socket = null;
        if (++wsFails >= WS_FAILS_BEFORE_HTTP) return connectHttp();
        retry();
    }

    function retry() {
        if (!root) return;
        setStatus("Chat is offline. Reconnecting...");
        retryTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30000);
    }

    function httpRecently() {
        const at = Number(storageGet(TRANSPORT_KEY));
        return at > 0 && Date.now() - at < HTTP_REMEMBER_MS;
    }

    // Opens a socket and closes it straight away. If it opens, this network allows WebSockets
    // again and the next visit tries them first. It never says hello, so it never joins.
    function probeWebSocket() {
        let ws;
        try {
            ws = new WebSocket(WS_URL);
        } catch {
            return;
        }
        const timer = setTimeout(() => ws.close(), WS_OPEN_TIMEOUT_MS);
        ws.addEventListener("open", () => {
            clearTimeout(timer);
            storageSet(TRANSPORT_KEY, "");
            ws.close();
        });
        ws.addEventListener("close", () => clearTimeout(timer));
    }

    async function connectHttp() {
        clearTimeout(retryTimer);
        if (!root || http) return;
        const session = { epoch: null, seq: 0, key: null, controllers: new Set(), offline: false };
        http = session;
        setStatus("Connecting...");
        session.key = await ownerKey();
        pollLoop(session);
    }

    // Plain POSTs with a text/plain body, so the browser sends them as-is with no CORS preflight.
    async function httpPost(session, path, extra, timeout) {
        const controller = new AbortController();
        session.controllers.add(controller);
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
            const body = { v: visitorId(), nick: readNickname(), ...extra };
            if (session.key) body.key = session.key;
            const res = await fetch(HTTP_URL + path, {
                method: "POST",
                headers: { "Content-Type": "text/plain" },
                body: JSON.stringify(body),
                cache: "no-store",
                signal: controller.signal,
            });
            if (!res.ok) throw new Error("HTTP " + res.status);
            return await res.json();
        } finally {
            clearTimeout(timer);
            session.controllers.delete(controller);
        }
    }

    // Each poll waits on the server until something happens (or about 20 s pass), then the next
    // one goes out at once. The server answers a stale or missing position with a full reload.
    async function pollLoop(session) {
        let delay = 2000;
        while (http === session) {
            try {
                const data = await httpPost(session, "poll", { epoch: session.epoch, after: session.seq }, POLL_ABORT_MS);
                if (http !== session) return;
                delay = 2000;
                session.epoch = data.epoch;
                session.seq = data.seq;
                if (data.init) {
                    onServer({ t: "init", ...data.init });
                    storageSet(TRANSPORT_KEY, String(Date.now()));
                }
                if (data.init || session.offline) {
                    session.offline = false;
                    setStatus("");
                }
                for (const event of data.events || []) onServer(event);
            } catch {
                if (http !== session) return;
                session.offline = true;
                setStatus("Chat is offline. Reconnecting...");
                await new Promise((resolve) => setTimeout(resolve, delay));
                delay = Math.min(delay * 2, 30000);
            }
        }
    }

    async function httpSend(data) {
        const session = http;
        try {
            const reply = await httpPost(session, "send", { msg: data }, SEND_ABORT_MS);
            if (http === session) for (const r of reply.replies || []) onServer(r);
        } catch {
            if (http !== session || data.t !== "msg") return;
            if (input && !input.value) input.value = data.text;
            addSystem("Couldn't send that. Try again.");
        }
    }

    function disconnect() {
        clearTimeout(retryTimer);
        clearTimeout(sendTimer);
        clearInterval(waitTimer);
        clearInterval(keepAliveTimer);
        const ws = socket;
        socket = null;
        const session = http;
        http = null;
        me = null;
        wsFails = 0;
        retryDelay = 2000;
        try {
            ws?.close();
        } catch {}
        for (const c of session?.controllers || []) c.abort();
    }

    function trySend() {
        clearTimeout(sendTimer);
        if (!input) return;
        const text = replaceShortcodes(input.value).replace(/\s+/g, " ").trim();
        if (!text) return;
        if (!connected()) {
            addSystem("Not connected yet.");
            return;
        }
        const wait = me.owner ? 0 : readyAt - Date.now();
        if (wait > 0) {
            // Slow mode sends it the moment it may; after a timeout the player presses Enter again.
            if (!timedOut) sendTimer = setTimeout(trySend, wait);
            showWait();
            return;
        }
        lastText = [...text].slice(0, MAX_TEXT).join("");
        send({ t: "msg", text: lastText, nick: readNickname() });
        input.value = "";
        hideSuggest();
        readyAt = Date.now() + SLOW_MS;
        clearInterval(waitTimer);
        setStatus("");
    }

    function submit(e) {
        e.preventDefault();
        trySend();
    }

    // Pointer drags for moving (the title bar) and resizing (the corner grip).
    function drag(handle, onMove, onEnd) {
        handle.addEventListener("pointerdown", (e) => {
            if (e.button !== 0 || e.target.closest("button")) return;
            e.preventDefault();
            const start = { x: e.clientX, y: e.clientY, layout: { ...shown } };
            let moved = false;
            handle.setPointerCapture(e.pointerId);
            const move = (ev) => {
                const dx = ev.clientX - start.x;
                const dy = ev.clientY - start.y;
                if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
                moved = true;
                onMove(start.layout, dx, dy);
                applyLayout(true);
            };
            const up = () => {
                handle.removeEventListener("pointermove", move);
                handle.removeEventListener("pointerup", up);
                handle.removeEventListener("pointercancel", up);
                if (moved) saveLayout();
                onEnd?.(moved);
            };
            handle.addEventListener("pointermove", move);
            handle.addEventListener("pointerup", up);
            handle.addEventListener("pointercancel", up);
        });
    }

    function stop(e) {
        e.stopPropagation();
    }

    function build() {
        if (!document.getElementById("nsws-chat-style")) {
            const style = document.createElement("style");
            style.id = "nsws-chat-style";
            style.textContent = CSS;
            document.head.appendChild(style);
        }
        root = document.createElement("div");
        root.id = "nsws-chat";

        const bar = document.createElement("div");
        bar.className = "bar";
        const title = document.createElement("span");
        title.className = "title";
        title.textContent = "Chat";
        onlineLabel = document.createElement("span");
        onlineLabel.className = "online";
        onlineLabel.title = "People playing on the site right now";
        unreadBadge = document.createElement("span");
        unreadBadge.className = "unread";
        minButton = document.createElement("button");
        minButton.addEventListener("click", () => setMinimized(!layout.min));
        fullButton = document.createElement("button");
        fullButton.addEventListener("click", () => setFullscreen(!layout.full));
        bellButton = document.createElement("button");
        bellButton.addEventListener("click", () => {
            storageSet(PING_SOUND_KEY, pingSoundOn() ? "false" : "true");
            updateBell();
        });
        updateBell();
        bar.append(title, onlineLabel, unreadBadge, bellButton, fullButton, minButton);

        log = document.createElement("div");
        log.className = "log";
        log.addEventListener("pointerdown", (e) => {
            lastPointer = e.pointerType;
        }, true);
        statusLine = document.createElement("div");
        statusLine.className = "status";

        const form = document.createElement("form");
        input = document.createElement("input");
        input.type = "text";
        input.maxLength = MAX_TEXT * 2;
        input.placeholder = "Say something...";
        input.autocomplete = "off";
        input.spellcheck = false;
        emojiButton = document.createElement("button");
        emojiButton.type = "button";
        emojiButton.className = "emoji-button";
        emojiButton.title = "Emoji";
        emojiButton.textContent = icon(0x1f600);
        emojiButton.addEventListener("click", () => togglePanel(null));
        const sendButton = document.createElement("button");
        sendButton.type = "submit";
        sendButton.textContent = "Send";
        form.append(input, emojiButton, sendButton);
        form.addEventListener("submit", submit);

        const grip = document.createElement("div");
        grip.className = "grip";
        suggestBox = document.createElement("div");
        suggestBox.className = "suggest";
        root.append(bar, log, statusLine, suggestBox, form, grip);

        // The game listens for keys and clicks on window; none of the chat's should reach it.
        for (const type of ["keydown", "keyup", "keypress"]) root.addEventListener(type, stop);
        input.addEventListener("keydown", suggestKeys);
        input.addEventListener("keydown", (e) => {
            if (e.key !== "Escape") return;
            if (panel?.classList.contains("on")) closePanel();
            else input.blur();
        });
        input.addEventListener("input", onInput);
        input.addEventListener("click", updateSuggest);
        input.addEventListener("blur", hideSuggest);
        root.addEventListener("animationend", () => root?.classList.remove("ping-flash"));
        for (const type of ["pointerdown", "mousedown", "mouseup", "click", "touchstart", "touchend", "wheel", "contextmenu"]) {
            root.addEventListener(type, stop);
        }

        drag(bar, (from, dx, dy) => {
            if (layout.full) return;
            layout.x = from.x + dx;
            layout.y = from.y + dy;
        }, (moved) => {
            if (!moved && layout.min) setMinimized(false);
        });
        drag(grip, (from, dx, dy) => {
            layout.w = from.w + dx;
            layout.h = from.h + dy;
        });

        document.body.appendChild(root);
        applyLayout();
        updateOnline();
        renderLog();
        scrollToEnd(true);
    }

    function onKey(e) {
        if (e.code !== "Escape" || !root || !layout.full || root.contains(document.activeElement)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        setFullscreen(false);
    }

    function enable() {
        if (root) return;
        build();
        window.addEventListener("keydown", onKey, true);
        window.addEventListener("resize", applyLayout);
        connect();
        setTimeout(loadEmoji, 2000);
    }

    function disable() {
        disconnect();
        closePanel();
        window.removeEventListener("keydown", onKey, true);
        window.removeEventListener("resize", applyLayout);
        root?.remove();
        toast?.remove();
        root = log = input = statusLine = onlineLabel = unreadBadge = null;
        minButton = fullButton = bellButton = emojiButton = suggestBox = panel = toast = null;
        items = [];
        suggest = { kind: null, items: [], index: 0 };
        unread = mentions = 0;
    }

    window.addEventListener("nsws-players-online", updateOnline);

    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible" || titleBefore == null) return;
        if (document.title.startsWith(TITLE_MARK)) document.title = titleBefore;
        titleBefore = null;
    });

    function isEnabled() {
        return storageGet(ENABLED_KEY) === "true";
    }

    const fontStyle = document.createElement("style");
    fontStyle.id = "nsws-chat-fonts";
    fontStyle.textContent = FONT_CSS;
    document.head.appendChild(fontStyle);
    applyFont();

    window.__nswsChat = {
        isEnabled,
        fonts: FONTS.map(({ id, title, text, style }) => ({ id, title, preview: text, style })),
        getFont: () => currentFont().id,
        setFont(id) {
            storageSet(FONT_KEY, id);
            applyFont();
        },
        setEnabled(on) {
            storageSet(ENABLED_KEY, on ? "true" : "false");
            on ? enable() : disable();
        },
    };

    if (isEnabled()) {
        if (document.body) enable();
        else document.addEventListener("DOMContentLoaded", enable);
    }
})();
