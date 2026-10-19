// Offers to rejoin a cup when the player comes back after closing its tab by accident. While a
// player is in a cup (not organizing it), competitions/src/app.ts keeps a record of it here; leaving
// on purpose clears it. Competitions itself only loads once someone opens a cup, so this lives apart.
(() => {
    const KEY = "nsws-sc-rejoin";
    const MAX_AGE_MS = 6 * 3600000;
    const forget = () => {
        try {
            localStorage.removeItem(KEY);
        } catch {}
    };
    let saved = null;
    try {
        saved = JSON.parse(localStorage.getItem(KEY) || "null");
    } catch {}
    if (!saved) return;
    if (typeof saved.code !== "string" || !/^[A-HJ-NP-Z2-9]{5}$/.test(saved.code) || !(Date.now() - saved.at < MAX_AGE_MS)) return forget();
    // A cup link (read here before main.bundle.js takes it out of the address) opens its own cup.
    if (new URLSearchParams(location.search).has("cup")) return;

    async function offer() {
        let cup;
        try {
            const res = await fetch(window.__nswsApiBase + "nsws/cup/info?code=" + saved.code, { cache: "no-store" });
            if (!res.ok) return;
            cup = (await res.json()).cup;
        } catch {
            return;
        }
        if (!cup || cup.status?.phase === "done") return forget();
        const box = window.__nswsMessageBox;
        if (!box || box.isOpen || window.__nswsCupApp?.inCup()) return;
        box.showConfirm(`You were in the cup "${cup.name}" when the tab closed, and it's still running. Rejoin it?`, "Not now", "Rejoin", forget, () => {
            window.__nswsCupRejoin = { code: saved.code, role: saved.role === "spectator" ? "spectator" : "racer", info: cup };
            window.__nswsCompetitions?.join(saved.code);
        });
    }

    // main.bundle.js calls this once, when the menu first appears; true means it is opening a cup link.
    let onLoad = null;
    let offered = false;
    const wrapped = () => {
        const joining = onLoad?.() ?? false;
        if (!joining && !offered) {
            offered = true;
            void offer();
        }
        return joining;
    };
    Object.defineProperty(window, "__nswsCompetitionsOnLoad", {
        configurable: true,
        get: () => (onLoad ? wrapped : undefined),
        set: (fn) => {
            onLoad = fn;
        },
    });
})();
