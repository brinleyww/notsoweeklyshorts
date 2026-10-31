// Asks every player once whether they want the chat on, pointing at the home menu's Chat button.
// It stays unanswered until a button is pressed, so closing the tab means being asked again.
(() => {
    const KEY = "_nswsChatAsked";
    const TICK_MS = 500;
    const CSS = `
#nsws-chat-ask{position:fixed;inset:0;z-index:10000;font-family:ForcedSquare,Arial,sans-serif;pointer-events:auto;animation:nsws-chat-ask-in .2s ease-out;}
#nsws-chat-ask>.spot{position:fixed;box-sizing:border-box;box-shadow:0 0 0 200vmax rgba(20,20,30,.6);cursor:pointer;}
#nsws-chat-ask>.spot::after{content:"";position:absolute;inset:0;border:3px solid #8f8ff0;animation:nsws-chat-ask-pulse 1.2s ease-in-out infinite alternate;}
body:has(#nsws-chat-ask) #nsws-chat-toggle{color:#fff!important;}
#nsws-chat-ask>.card{position:fixed;box-sizing:border-box;width:420px;max-width:calc(100vw - 24px);background-color:var(--surface-color,#28346a);color:var(--text-color,#fff);clip-path:polygon(0 0,100% 0,calc(100% - 14px) 100%,0 100%);}
#nsws-chat-ask h2{margin:0;padding:14px 24px 0 18px;font-size:30px;font-weight:normal;}
#nsws-chat-ask p{margin:0;padding:6px 24px 14px 18px;font-size:19px;opacity:.8;}
#nsws-chat-ask .buttons{display:flex;gap:10px;padding:0 24px 12px 12px;}
#nsws-chat-ask .button{flex:1;margin:0;padding:8px 10px;font-size:22px;}
#nsws-chat-ask .button.on{box-shadow:inset 0 -3px 0 #7272c2;}
@keyframes nsws-chat-ask-in{from{opacity:0;}}
@keyframes nsws-chat-ask-pulse{from{opacity:.35;}to{opacity:1;}}
`;
    const SPOT_PAD = 3;
    const MARGIN = 12;
    let root = null;
    let spot = null;
    let card = null;
    let steady = 0;
    let timer = 0;

    const read = () => {
        try {
            return localStorage.getItem(KEY);
        } catch {
            return "1";
        }
    };
    const markAsked = () => {
        clearInterval(timer);
        try {
            localStorage.setItem(KEY, "1");
        } catch {}
    };

    // The real menu button, only while nothing covers it: races, Settings and cup panels all hide or cover it.
    function shownButton() {
        const button = document.getElementById("nsws-chat-toggle");
        if (!button || document.querySelector(".menu-ui > .main-buttons-container.hidden")) return null;
        const box = button.getBoundingClientRect();
        if (!box.width || !box.height) return null;
        const top = document.elementsFromPoint(box.left + box.width / 2, box.top + box.height / 2).find((el) => !root?.contains(el));
        return top && button.contains(top) ? button : null;
    }

    function place() {
        const button = root && document.getElementById("nsws-chat-toggle");
        if (!button) return;
        const box = button.getBoundingClientRect();
        spot.style.left = box.left - SPOT_PAD + "px";
        spot.style.top = box.top - SPOT_PAD + "px";
        spot.style.width = box.width + 2 * SPOT_PAD + "px";
        spot.style.height = box.height + 2 * SPOT_PAD + "px";
        card.style.left = Math.max(MARGIN, Math.min(box.left, window.innerWidth - card.offsetWidth - MARGIN)) + "px";
        card.style.bottom = window.innerHeight - box.top + MARGIN + "px";
    }

    function close() {
        root?.remove();
        root = null;
        window.removeEventListener("resize", place);
        window.removeEventListener("keydown", onKey, true);
    }

    function answer(on) {
        const button = document.getElementById("nsws-chat-toggle");
        close();
        markAsked();
        if (on && !window.__nswsChat.isEnabled()) button ? button.click() : window.__nswsChat.setEnabled(true);
        else window.__nswsUIClick?.();
    }

    function onKey(e) {
        if (e.code !== "Escape") return;
        e.preventDefault();
        e.stopImmediatePropagation();
        answer(false);
    }

    function makeButton(icon, label, on) {
        const button = document.createElement("button");
        button.className = on ? "button on" : "button";
        button.innerHTML = '<img class="button-icon" src="images/' + icon + '.svg"> ';
        button.append(label);
        button.addEventListener("click", () => answer(on));
        return button;
    }

    function open() {
        if (!document.getElementById("nsws-chat-ask-style")) {
            const style = document.createElement("style");
            style.id = "nsws-chat-ask-style";
            style.textContent = CSS;
            document.head.appendChild(style);
        }
        root = document.createElement("div");
        root.id = "nsws-chat-ask";
        spot = document.createElement("div");
        spot.className = "spot";
        spot.addEventListener("click", () => answer(true));
        card = document.createElement("div");
        card.className = "card";
        const title = document.createElement("h2");
        title.textContent = "Turn on chat?";
        const text = document.createElement("p");
        text.textContent = "Talk with other players while you race. You can change this any time with this button.";
        const buttons = document.createElement("div");
        buttons.className = "buttons";
        buttons.append(makeButton("chat_off", "Keep off", false), makeButton("chat_on", "Turn on", true));
        card.append(title, text, buttons);
        root.append(spot, card);
        document.body.appendChild(root);
        place();
        window.addEventListener("resize", place);
        window.addEventListener("keydown", onKey, true);
    }

    function tick() {
        if (document.visibilityState === "hidden" || !window.__nswsChat) return;
        if (window.__nswsChat.isEnabled()) {
            close();
            return markAsked();
        }
        const shown = !!shownButton();
        // Waits a moment so a menu that only flashes up before the first-launch race doesn't count.
        steady = shown ? steady + 1 : 0;
        if (root) {
            if (shown) place();
            else close();
        } else if (steady >= 2) {
            open();
        }
    }

    if (read()) return;
    timer = setInterval(tick, TICK_MS);
})();
