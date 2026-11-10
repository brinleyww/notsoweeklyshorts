// Club tags worn by players (picked in a club's page): "[TAG] Name" wherever names are drawn, and the tag on top of the car.
(function () {
    "use strict";
    const CACHE_KEY = "nswsClubTags";
    const MINE_KEY = "nswsClubTagMine";
    const CACHE_MS = 10 * 60_000;
    // The Worker's list is cached for 2 minutes, so the player's own change wins until it has surely caught up.
    const MINE_MS = 10 * 60_000;
    const IGNORED = /[\p{Cc}\p{Cf}\p{Z}\s]/gu;

    let tags = new Map();
    let mine = null;
    let version = 1;
    let loading = null;
    let loadedAt = 0;

    const key = (nick) => String(nick ?? "").normalize("NFKC").toLowerCase().replace(IGNORED, "");
    // __getPlayerNickname only exists once a race screen has been made.
    const myNick = () => {
        try {
            const n = window.__getPlayerNickname?.();
            if (n) return n;
            const slot = parseInt(localStorage.getItem("polytrack_v5_prod_user_slot") ?? "0", 10);
            const nick = JSON.parse(localStorage.getItem("polytrack_v5_prod_user_" + (slot >= 0 ? slot : 0)) || "null")?.nickname;
            return typeof nick === "string" && nick.trim() ? nick.trim() : null;
        } catch {
            return null;
        }
    };

    function read(k) {
        try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; }
    }

    function write(k, v) {
        try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
    }

    function setList(obj) {
        const next = new Map();
        for (const [nick, tag] of Object.entries(obj || {})) {
            if (typeof tag === "string" && /^[A-Za-z0-9]{1,5}$/.test(tag)) next.set(key(nick), tag);
        }
        tags = next;
        changed();
    }

    function changed() {
        version++;
        for (const el of document.querySelectorAll("[data-ctag-nick]")) el.textContent = label(el.dataset.ctagNick);
        window.dispatchEvent(new CustomEvent("nsws-club-tags"));
    }

    function freshMine() {
        if (!mine || Date.now() - mine.at > MINE_MS) return null;
        return mine;
    }

    function of(nick) {
        const k = key(nick);
        if (!k) return null;
        const m = freshMine();
        if (m && key(m.nick) === k) return m.tag || null;
        return tags.get(k) || null;
    }

    function label(nick) {
        const tag = of(nick);
        return tag ? "[" + tag + "] " + nick : String(nick ?? "");
    }

    // A plain text element showing a name; it follows later changes to the list.
    function name(el, nick) {
        el.dataset.ctagNick = nick ?? "";
        el.textContent = label(nick);
        return el;
    }

    async function load(force) {
        if (loading) return loading;
        if (!force && Date.now() - loadedAt < CACHE_MS) return;
        const base = window.__nswsApiBase;
        if (!base) return;
        loading = (async () => {
            try {
                const r = await fetch(base + "nsws/tracks/club/tags", { method: "GET" });
                const j = r.ok ? await r.json() : null;
                if (j && j.tags && typeof j.tags === "object") {
                    loadedAt = Date.now();
                    write(CACHE_KEY, { at: loadedAt, tags: j.tags });
                    setList(j.tags);
                }
            } catch {} finally {
                loading = null;
            }
        })();
        return loading;
    }

    // tag null: the player took their tag off.
    function setMine(tag, nick) {
        nick = nick || myNick();
        if (!nick) return;
        const prev = of(nick);
        mine = { nick, tag: tag || null, at: Date.now() };
        write(MINE_KEY, mine);
        if (prev !== (tag || null)) changed();
    }

    function mineTag() {
        const n = myNick();
        return n ? of(n) : null;
    }

    // ---- the tag on top of a car ----

    // Width over depth of the text.
    const PLATE = 2;
    // Where the tag lies on each body model, read from the chase camera: height, z (front is +z), tilt towards the
    // rear in degrees and width. Two more numbers add a patch of body paint under it (width, depth) where stickers
    // or a wing would be in the way. Fixed spots, because one ray against a detailed body takes about 20 ms.
    const SPOTS = {
        Body: [0.072, -1.37, 11, 0.52],
        BodyRally: [0.343, -2.04, 7.3, 0.8],
        BodyRallyLow: [0.343, -2.04, 9.3, 0.8],
        BodyCybertruck: [0.538, -2.03, 7, 0.84],
        BodyNascar: [0.306, -1.86, 4.2, 0.5, 0.94, 0.27],
        BodyNascarLow: [0.306, -1.86, 4.2, 0.5, 0.94, 0.27],
        BodyF1: [0.182, -1.77, 0, 0.5, 0.66, 0.28],
        BodyF1Low: [0.182, -1.77, 0, 0.5, 0.66, 0.28],
        BodyFrame: [0.136, -1.175, 0, 0.48],
        BodyPengu: [1.502, -0.3, 40.3, 0.32]
    };
    const textures = new Map();
    const decals = new WeakMap();

    function texture(T, tag) {
        let t = textures.get(tag);
        if (t) return t;
        const c = document.createElement("canvas");
        c.width = 512;
        c.height = Math.round(512 / PLATE);
        // The game's three.js build has no CanvasTexture.
        t = new T.Texture(c);
        t.colorSpace = T.SRGBColorSpace;
        t.anisotropy = 8;
        const draw = () => {
            const g = c.getContext("2d");
            if (!g) return;
            g.setTransform(1, 0, 0, 1, 0, 0);
            g.clearRect(0, 0, c.width, c.height);
            g.font = "italic bold 200px ForcedSquare, Arial, sans-serif";
            g.lineJoin = "round";
            const m = g.measureText(tag);
            const high = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
            if (!(m.width > 0 && high > 0)) return;
            // The letters fill the plate's depth and a long tag is squeezed sideways: the camera sees it nearly edge-on.
            const sy = (c.height - 44) / high;
            const sx = Math.min(sy, (c.width - 44) / m.width);
            g.translate(c.width / 2, (c.height + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) * sy) / 2);
            g.scale(sx, sy);
            g.textAlign = "center";
            g.lineWidth = 22 / sy;
            g.strokeStyle = "rgba(0,0,0,0.85)";
            g.strokeText(tag, 0, 0);
            g.fillStyle = "#fff";
            g.fillText(tag, 0, 0);
            t.needsUpdate = true;
        };
        draw();
        try { document.fonts?.load("italic bold 100px ForcedSquare").then(draw, () => {}); } catch {}
        textures.set(tag, t);
        return t;
    }

    function dropDecal(car) {
        const d = decals.get(car);
        if (!d) return;
        d.group.parent?.remove(d.group);
        d.text.geometry.dispose();
        d.text.material.dispose();
        // The patch wears the body's own material, which is not ours to dispose.
        d.cover?.geometry.dispose();
        decals.delete(car);
    }

    // Called by VisualCar when the list or its body changes. nameTag: the nickname over the car, if any.
    // Runs inside the car's per-frame update, so nothing may throw out of it.
    function car(c, body, nameTag, redrawNameTag) {
        try {
            carTag(c, body, nameTag, redrawNameTag);
        } catch (err) {
            console.warn("club tag", err);
        }
    }

    function carTag(c, body, nameTag, redrawNameTag) {
        if (nameTag != null) {
            try { redrawNameTag?.(); } catch {}
        }
        const T = window.__nswsTHREE;
        const nick = nameTag ?? (c.__userControls ? myNick() : null);
        const tag = nick ? of(nick) : null;
        const old = decals.get(c);
        if (old && old.tag === tag && old.group.parent === body) return;
        dropDecal(c);
        const spot = SPOTS[body?.name];
        if (!tag || !T || !spot) return;
        const [y, z, tilt, w, coverW, coverD] = spot;
        const a = tilt * Math.PI / 180;
        const group = new T.Group();
        group.name = "NSWSClubTag";
        group.position.set(0, y, z);
        // Flat on the body with the top of the letters towards the front, so it reads from behind.
        group.quaternion.setFromRotationMatrix(new T.Matrix4().makeBasis(
            new T.Vector3(-1, 0, 0), new T.Vector3(0, Math.sin(a), Math.cos(a)), new T.Vector3(0, Math.cos(a), -Math.sin(a))));
        const paint = coverW ? (Array.isArray(body.material) ? body.material : [body.material]).find((m) => m.name === "MainPlain") : null;
        let cover = null;
        if (paint) {
            cover = new T.Mesh(new T.PlaneGeometry(coverW, coverD), paint);
            cover.castShadow = false;
            cover.receiveShadow = true;
            group.add(cover);
        }
        const mat = new T.MeshBasicMaterial({
            // alphaTest: setOpacity(1) turns transparent off, which would show the canvas's empty pixels as black.
            map: texture(T, tag), transparent: true, alphaTest: 0.25, depthWrite: false,
            polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
        });
        if (c.__opacity != null && c.__opacity < 1) mat.opacity = c.__opacity;
        const text = new T.Mesh(new T.PlaneGeometry(w, w / PLATE), mat);
        text.castShadow = false;
        text.receiveShadow = false;
        text.position.z = 0.003;
        group.add(text);
        body.add(group);
        decals.set(c, { tag, group, text, cover });
    }

    window.__nswsClubTag = {
        get version() { return version; },
        of, label, name, load, setMine, mine: mineTag, car, drop: dropDecal
    };

    const cached = read(CACHE_KEY);
    if (cached?.tags) {
        setList(cached.tags);
        if (Date.now() - (cached.at || 0) < CACHE_MS) loadedAt = cached.at;
    }
    const m = read(MINE_KEY);
    if (m && typeof m.nick === "string" && Date.now() - (m.at || 0) < MINE_MS) mine = m;

    const start = () => {
        load();
        setInterval(() => { if (document.visibilityState === "visible") load(); }, CACHE_MS);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
    else start();
})();
