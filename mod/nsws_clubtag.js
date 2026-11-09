// Club tags worn by players (picked in a club's page): "[TAG] Name" wherever names are drawn, and the tag on the back of the car.
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

    // ---- the tag on the back of a car ----

    // Width over height of the text plate.
    const PLATE = 3.2;
    const textures = new Map();
    const placements = new WeakMap();
    const decals = new WeakMap();

    function texture(T, tag) {
        let t = textures.get(tag);
        if (t) return t;
        const c = document.createElement("canvas");
        c.width = 512;
        c.height = 512 / PLATE;
        // The game's three.js build has no CanvasTexture.
        t = new T.Texture(c);
        t.colorSpace = T.SRGBColorSpace;
        t.anisotropy = 4;
        const draw = () => {
            const g = c.getContext("2d");
            if (!g) return;
            g.clearRect(0, 0, c.width, c.height);
            let size = Math.round(c.height * 0.82);
            const font = (s) => "italic bold " + s + "px ForcedSquare, Arial, sans-serif";
            g.font = font(size);
            const w = g.measureText(tag).width;
            if (w > c.width - 36) {
                size = Math.floor(size * (c.width - 36) / w);
                g.font = font(size);
            }
            // A dark backing keeps the tag readable over a busy livery.
            const tw = Math.min(c.width, g.measureText(tag).width + size * 0.5);
            const th = Math.min(c.height, size * 1.05);
            const x0 = (c.width - tw) / 2, y0 = (c.height - th) / 2, k = th * 0.22;
            g.fillStyle = "rgba(12,16,34,0.78)";
            g.beginPath();
            g.moveTo(x0 + k, y0);
            g.lineTo(x0 + tw, y0);
            g.lineTo(x0 + tw - k, y0 + th);
            g.lineTo(x0, y0 + th);
            g.closePath();
            g.fill();
            g.textAlign = "center";
            g.textBaseline = "middle";
            g.lineJoin = "round";
            g.lineWidth = Math.max(6, size * 0.12);
            g.strokeStyle = "rgba(0,0,0,0.85)";
            g.strokeText(tag, c.width / 2, c.height / 2 + 4);
            g.fillStyle = "#fff";
            g.fillText(tag, c.width / 2, c.height / 2 + 4);
            t.needsUpdate = true;
        };
        draw();
        try { document.fonts?.load("italic bold 100px ForcedSquare").then(draw, () => {}); } catch {}
        textures.set(tag, t);
        return t;
    }

    // Where the text sits on a body: rays from behind find a flat, upright part of the rear (front is +z).
    function placement(T, mesh) {
        const geo = mesh.geometry;
        if (placements.has(geo)) return placements.get(geo);
        let out = null;
        try {
            if (!geo.boundingBox) geo.computeBoundingBox();
            const b = geo.boundingBox;
            const probe = new T.Mesh(geo, new T.MeshBasicMaterial({ side: T.DoubleSide }));
            probe.updateMatrixWorld(true);
            const ray = new T.Raycaster();
            const dir = new T.Vector3(0, 0, 1);
            const hitAt = (x, y) => {
                ray.set(new T.Vector3(x, y, b.min.z - 1), dir);
                const h = ray.intersectObject(probe, false)[0];
                if (!h?.face) return null;
                const n = h.face.normal.clone().normalize();
                if (n.z > 0) n.negate();
                return { p: h.point, n };
            };
            const height = b.max.y - b.min.y;
            const halfWidth = (b.max.x - b.min.x) / 2;
            // Each edge of the plate must still lie on the surface, not hang over a gap or a step.
            const fits = (c, w) => [[-1, 0], [1, 0], [0, -1], [0, 1]].every(([sx, sy]) => {
                const h = hitAt(sx * w / 2, c.y + sy * w / PLATE / 2);
                return h && Math.abs(h.p.clone().sub(c.p).dot(c.n)) < 0.05;
            });
            // The biggest plate wins (a tailgate over a small bumper), then the lower spot (a bumper over a rear window).
            let best = null;
            for (let f = 0.2; f <= 0.8; f += 0.075) {
                const y = b.min.y + height * f;
                const c = hitAt(0, y);
                if (!c || c.n.z > -0.6) continue;
                c.y = y;
                let w = Math.min(0.7, halfWidth * 1.1);
                while (w >= 0.24 && !fits(c, w)) w *= 0.8;
                c.w = Math.max(w, 0.24);
                if (!best || c.w > best.w + 0.03) best = c;
            }
            if (best) {
                const w = best.w;
                const n = best.n;
                const up = new T.Vector3(0, 1, 0);
                const x = new T.Vector3().crossVectors(up, n).normalize();
                const y = new T.Vector3().crossVectors(n, x).normalize();
                out = {
                    pos: best.p.clone().addScaledVector(n, 0.008),
                    quat: new T.Quaternion().setFromRotationMatrix(new T.Matrix4().makeBasis(x, y, n)),
                    w
                };
            }
            probe.material.dispose();
        } catch {
            out = null;
        }
        placements.set(geo, out);
        return out;
    }

    function dropDecal(car) {
        const d = decals.get(car);
        if (!d) return;
        d.mesh.parent?.remove(d.mesh);
        d.mesh.geometry.dispose();
        d.mesh.material.dispose();
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
        if (old && old.tag === tag && old.mesh.parent === body) return;
        dropDecal(c);
        if (!tag || !T || !body?.geometry) return;
        const at = placement(T, body);
        if (!at) return;
        const mat = new T.MeshBasicMaterial({
            // alphaTest: setOpacity(1) turns transparent off, which would show the canvas's empty pixels as black.
            map: texture(T, tag), transparent: true, alphaTest: 0.25, depthWrite: false,
            polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
        });
        if (c.__opacity != null && c.__opacity < 1) mat.opacity = c.__opacity;
        const mesh = new T.Mesh(new T.PlaneGeometry(at.w, at.w / PLATE), mat);
        mesh.name = "NSWSClubTag";
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.position.copy(at.pos);
        mesh.quaternion.copy(at.quat);
        body.add(mesh);
        decals.set(c, { tag, mesh });
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
