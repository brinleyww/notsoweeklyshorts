// Car parts that only come out of crates (mod/nsws_crates.js). They live in the ordinary car style at fixed indices past
// the stock ones, so every NSWS player sees them on ghosts, replays and boards. Rims, exhausts and cars are built here
// from primitives and the stock meshes when the car models load (main.bundle.js). Never reorder or remove entries: an
// index is what saved styles and runs hold. Gaps between the stock parts and BASE are reserved for future stock parts.
(function () {
    const BASE = { patterns: 40, rims: 40, exhausts: 10, bodies: 10 };
    const STOCK = { patterns: 16, rims: 12, exhausts: 8, bodies: 7 };
    // Free stock parts with no model file, built below, in the reserved slots right after the bundle's own. `built` makes
    // the car_bodies.glb loop skip them; they are not `crate`, so the garage lists them.
    const BUILT = { bodies: [{ model: "BodyStadium", lowModel: "BodyStadium", name: "Stadium", built: true }] };
    const STADIUM = STOCK.bodies;

    // g = the id the Worker counts by; never reuse one.
    const PARTS = {
        patterns: [
            { g: 0, id: "dots", name: "Polka Dots", r: "milspec", note: "Fun at parties. Not at checkpoints." },
            { g: 1, id: "checker", name: "Checkerboard", r: "milspec", note: "Finish line chic." },
            { g: 2, id: "pinstripe", name: "Pinstripes", r: "milspec", note: "Business casual, at 300 km/h." },
            { g: 3, id: "hazard", name: "Hazard", r: "milspec", note: "Accurate." },
            { g: 4, id: "tiger", name: "Tiger", r: "restricted", note: "Eye of the tiger. Brain of the goldfish." },
            { g: 5, id: "hex", name: "Hex Grid", r: "restricted", note: "Honeycomb aerodynamics." },
            { g: 6, id: "pixel", name: "Pixel Camo", r: "classified", note: "Invisible in Minecraft." },
            { g: 7, id: "moo", name: "Moo", r: "covert", note: "Udderly fast." },
            { g: 8, id: "galaxy", name: "\u2605 Galaxy", r: "gold", note: "Your car, with the whole universe on it." },
        ],
        rims: [
            { g: 20, id: "steelie", name: "Steelie", r: "milspec", note: "Came free with the car. Literally." },
            { g: 21, id: "dish", name: "Deep Dish", r: "milspec", note: "Holds soup in an emergency." },
            { g: 22, id: "tri", name: "Tri-Spoke", r: "milspec", note: "Three is enough. Allegedly." },
            { g: 23, id: "turbofan", name: "Turbofan", r: "restricted", note: "Cools the brakes. Cools you, even." },
            { g: 24, id: "wire", name: "Wire Spoke", r: "restricted", note: "Like a bicycle, but committed." },
            { g: 25, id: "saw", name: "Saw Blade", r: "classified", note: "Please do not bump people." },
            { g: 26, id: "nut", name: "Big Nut", r: "covert", note: "One lug nut to rule them all." },
            { g: 27, id: "donut", name: "\u2605 Donut", r: "gold", note: "Glazed. Sprinkled. Grip not included." },
        ],
        exhausts: [
            { g: 40, id: "quad", name: "Quad Pipes", r: "milspec", note: "Four times the noise. Same speed." },
            { g: 41, id: "ovals", name: "Twin Ovals", r: "milspec", note: "Oval pipes, for oval racing." },
            { g: 42, id: "trumpet", name: "Trumpet", r: "restricted", note: "Plays one note. Loudly." },
            { g: 43, id: "hextips", name: "Hex Tips", r: "classified", note: "Six sides of pure attitude." },
            { g: 44, id: "turbine", name: "Jet Turbine", r: "covert", note: "Not street legal. Not anything legal." },
            { g: 45, id: "afterburner", name: "\u2605 Afterburner", r: "gold", note: "Always lit. Never explained." },
        ],
        // Only height and width change, so the wheel arches stay over the wheels.
        bodies: [
            { g: 50, id: "pancake", name: "Pancake", r: "milspec", base: 0, scale: [1, 0.68, 1], lift: -0.04, note: "Fits under doors." },
            { g: 51, id: "slammed", name: "Slammed Rally", r: "milspec", base: 1, scale: [1, 0.92, 1], lift: -0.07, note: "Speed bumps are now a personal enemy." },
            { g: 52, id: "lifted", name: "Lifted Truck", r: "restricted", base: 2, scale: [1, 1.1, 1], lift: 0.06, note: "Sees over traffic. And over the finish." },
            { g: 53, id: "widebody", name: "Widebody", r: "classified", base: 3, scale: [1.12, 0.96, 1], lift: -0.02, note: "Fender flares the size of your ego." },
            { g: 54, id: "groundfx", name: "Ground Effect", r: "covert", base: 4, scale: [1.08, 0.82, 1], lift: -0.05, note: "Sucked to the road. Spiritually." },
            { g: 55, id: "goldpengu", name: "\u2605 Golden Pengu", r: "gold", base: 6, scale: [1, 1, 1], lift: 0, gold: true, note: "The penguin has been dipped." },
        ],
    };
    for (const kind of Object.keys(PARTS)) PARTS[kind].forEach((p, n) => {
        p.kind = kind;
        p.index = BASE[kind] + n;
    });

    function entry(kind, part) {
        if (kind === "patterns") return { url: "images/crate_" + part.id + ".svg", crate: true };
        if (kind === "bodies") return { model: "Crate_" + part.id, lowModel: "Crate_" + part.id + "_low", name: part.name, crate: true };
        return { model: "Crate_" + part.id, crate: true };
    }

    // The lists CarStyle appends to its own, padded with reserved slots up to BASE.
    function list(kind, stockLength) {
        if (stockLength !== STOCK[kind]) console.warn("Crate parts: stock " + kind + " changed (" + stockLength + "); check BASE");
        const out = [];
        const built = stockLength === STOCK[kind] ? BUILT[kind] ?? [] : [];
        for (let n = stockLength; n < BASE[kind]; n++) out.push(built[n - stockLength] ?? { reserved: true, crate: true, model: null, url: "images/pattern_stripe.svg" });
        for (const p of PARTS[kind]) out.push(entry(kind, p));
        return out;
    }

    function byIndex(kind, index) {
        return PARTS[kind]?.[index - BASE[kind]] ?? null;
    }

    let T = null;
    let U = null;

    // The game's three.js is tree-shaken down to BoxGeometry, so the other shapes are built here, matching three's own
    // layouts (lathe around y, circle facing +z, torus around z, cylinder and cone along y).
    function geometry(positions, indices) {
        const g = new T.BufferGeometry();
        g.setAttribute("position", new T.BufferAttribute(new Float32Array(positions), 3));
        if (indices) g.setIndex(indices);
        g.computeVertexNormals();
        return g;
    }
    function lathe(points, segments) {
        const pos = [];
        const idx = [];
        const n = points.length;
        for (let i = 0; i <= segments; i++) {
            const phi = (i / segments) * Math.PI * 2;
            for (const [r, h] of points) pos.push(r * Math.sin(phi), h, r * Math.cos(phi));
        }
        for (let i = 0; i < segments; i++) for (let j = 0; j < n - 1; j++) {
            const a = j + i * n, b = j + (i + 1) * n, c = j + 1 + (i + 1) * n, d = j + 1 + i * n;
            idx.push(a, b, d, c, d, b);
        }
        return geometry(pos, idx);
    }
    function circle(r, segments = 16) {
        const pos = [0, 0, 0];
        const idx = [];
        for (let i = 0; i <= segments; i++) {
            const a = (i / segments) * Math.PI * 2;
            pos.push(r * Math.cos(a), r * Math.sin(a), 0);
        }
        for (let i = 1; i <= segments; i++) idx.push(i, i + 1, 0);
        return geometry(pos, idx);
    }
    function cylinder(rTop, rBottom, height, segments = 16, open = false) {
        const side = lathe([[rBottom, -height / 2], [rTop, height / 2]], segments);
        if (open) return side;
        const parts = [side.toNonIndexed()];
        if (rTop > 0) parts.push(circle(rTop, segments).applyMatrix4(new T.Matrix4().makeRotationX(-Math.PI / 2)).translate(0, height / 2, 0).toNonIndexed());
        if (rBottom > 0) parts.push(circle(rBottom, segments).applyMatrix4(new T.Matrix4().makeRotationX(Math.PI / 2)).translate(0, -height / 2, 0).toNonIndexed());
        return U.mergeGeometries(parts, false);
    }
    function cone(r, height, segments = 16) {
        return cylinder(0, r, height, segments, false);
    }
    function torus(R, tube, tubeSegments = 8, segments = 32) {
        const profile = [];
        for (let k = 0; k <= tubeSegments; k++) {
            const a = (k / tubeSegments) * Math.PI * 2;
            profile.push([R + tube * Math.cos(a), tube * Math.sin(a)]);
        }
        return lathe(profile, segments).applyMatrix4(new T.Matrix4().makeRotationX(Math.PI / 2));
    }

    function prep(g) {
        if (g.index) g = g.toNonIndexed();
        for (const name of Object.keys(g.attributes)) if (name !== "position" && name !== "normal") g.deleteAttribute(name);
        if (!g.attributes.normal) g.computeVertexNormals();
        return g;
    }

    function place(g, { rx = 0, ry = 0, rz = 0, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1 } = {}) {
        const m = new T.Matrix4().compose(new T.Vector3(x, y, z), new T.Quaternion().setFromEuler(new T.Euler(rx, ry, rz)), new T.Vector3(sx, sy, sz));
        return prep(g).applyMatrix4(m);
    }

    // Parts grouped by material slot, merged into one mesh whose groups follow the materials array.
    function build(slots, materials, name) {
        const used = [];
        const mats = [];
        slots.forEach((list, n) => {
            if (!list.length) return;
            used.push(U.mergeGeometries(list, false));
            mats.push(materials[n]);
        });
        const mesh = new T.Mesh(U.mergeGeometries(used, true), mats);
        mesh.name = name;
        return mesh;
    }

    // ---- Rims. Wheels spin on x, tyre radius 0.331, half-width 0.172, centred on the origin; left wheels may be
    // mirrored, so both faces get the same rim. Everything stays inside |x| <= 0.165 and r <= 0.236 (inside the tyre).

    const FACE = 0.165;

    function tire() {
        const profile = [[0.236, -0.15], [0.29, -0.172], [0.322, -0.165], [0.331, -0.12], [0.331, 0.12], [0.322, 0.165], [0.29, 0.172], [0.236, 0.15], [0.236, -0.15]];
        return place(lathe(profile, 28), { rz: -Math.PI / 2 });
    }

    // A disc facing along x, its outer face at |x| = outer.
    function disc(r, depth, outer, s, segments = 24) {
        return place(cylinder(r, r, depth, segments), { rz: Math.PI / 2, x: s * (outer - depth / 2) });
    }

    function bothFaces(fn) {
        return [...fn(1), ...fn(-1)];
    }

    function radial(geometryFn, count, r, x, extra = {}) {
        return Array.from({ length: count }, (_, n) => {
            const a = (n / count) * Math.PI * 2;
            return place(geometryFn(n), { rx: a, x, y: Math.cos(a) * r, z: Math.sin(a) * r, ...extra });
        });
    }

    function ring(r, tube, x) {
        return place(torus(r, tube, 8, 32), { ry: Math.PI / 2, x });
    }

    function barrel() {
        return place(cylinder(0.234, 0.234, 0.3, 28, true), { rz: Math.PI / 2 });
    }

    const RIMS = {
        steelie: () => [
            [tire(), ...bothFaces((s) => radial(() => cylinder(0.024, 0.024, 0.012, 10), 8, 0.15, s * (FACE - 0.035), { rz: Math.PI / 2 }))],
            [barrel(), ...bothFaces((s) => [disc(0.226, 0.03, FACE - 0.03, s, 28), ring(0.2, 0.01, s * (FACE - 0.025))])],
            bothFaces((s) => [disc(0.055, 0.03, FACE - 0.015, s, 12)]),
        ],
        dish: () => [
            [tire()],
            [barrel(), ...bothFaces((s) => [place(cylinder(0.232, 0.17, 0.07, 28, true), { rz: s * Math.PI / 2, x: s * (FACE - 0.035) }), disc(0.17, 0.016, FACE - 0.06, s, 28)])],
            bothFaces((s) => [disc(0.045, 0.03, FACE - 0.04, s, 12), ...radial(() => cylinder(0.012, 0.012, 0.025, 6), 5, 0.085, s * (FACE - 0.06), { rz: Math.PI / 2 })]),
        ],
        tri: () => [
            [tire()],
            [barrel(), ...bothFaces((s) => [ring(0.212, 0.016, s * (FACE - 0.03)), ...radial(() => new T.BoxGeometry(0.03, 0.17, 0.065), 3, 0.125, s * (FACE - 0.03))])],
            bothFaces((s) => [disc(0.055, 0.04, FACE - 0.01, s, 16)]),
        ],
        turbofan: () => [
            [tire()],
            [barrel(), ...bothFaces((s) => [ring(0.212, 0.016, s * (FACE - 0.03)), ...radial(() => new T.BoxGeometry(0.05, 0.15, 0.012), 14, 0.135, s * (FACE - 0.035), { rz: 0.55 * s })])],
            bothFaces((s) => [disc(0.06, 0.04, FACE - 0.01, s, 16)]),
        ],
        wire: () => [
            [tire()],
            [barrel(), ...bothFaces((s) => [ring(0.212, 0.01, s * (FACE - 0.03)), ...Array.from({ length: 24 }, (_, n) => {
                const a = (n / 24) * Math.PI * 2;
                return place(cylinder(0.004, 0.004, 0.2, 4), { rx: a + (n % 2 ? 0.35 : -0.35), x: s * (FACE - 0.03 - (n % 2) * 0.035), y: Math.cos(a) * 0.115, z: Math.sin(a) * 0.115 });
            })])],
            bothFaces((s) => [disc(0.042, 0.07, FACE - 0.03, s, 12), place(cone(0.035, 0.03, 8), { rz: -s * Math.PI / 2, x: s * (FACE - 0.015) })]),
        ],
        saw: () => [
            [tire()],
            [barrel(), ...bothFaces((s) => [disc(0.2, 0.012, FACE - 0.02, s, 32), ...radial(() => cone(0.02, 0.045, 3), 18, 0.21, s * (FACE - 0.026), { rz: 0.4 })])],
            bothFaces((s) => [disc(0.05, 0.03, FACE - 0.005, s, 12)]),
        ],
        nut: () => [
            [tire()],
            [barrel(), ...bothFaces((s) => [disc(0.226, 0.016, FACE - 0.07, s, 28)])],
            bothFaces((s) => [place(cylinder(0.15, 0.15, 0.05, 6), { rz: Math.PI / 2, x: s * (FACE - 0.04) }), disc(0.06, 0.02, FACE, s, 20)]),
        ],
        donut: () => [
            [tire()],
            [barrel(), ...bothFaces((s) => [place(torus(0.14, 0.045, 12, 32), { ry: Math.PI / 2, sx: 0.7, x: s * (FACE - 0.035) })])],
            bothFaces((s) => Array.from({ length: 26 }, (_, n) => {
                const a = n * 2.39996;
                const r = 0.115 + ((n * 37) % 9) * 0.006;
                return place(new T.BoxGeometry(0.01, 0.028, 0.008), { rx: a * 3, x: s * (FACE - 0.008), y: Math.cos(a) * r, z: Math.sin(a) * r });
            })),
        ],
    };

    // ---- Exhausts, in body space: +z is the front. Kept to the stock exhaust's box (x within 0.27, y -0.30 to -0.44,
    // ending at z -2.0 to -2.06) so they sit where the stock ones do on every body.

    function pipe(x, y, z0, z1, r, segments = 14) {
        return place(cylinder(r, r, Math.abs(z1 - z0), segments, true), { rx: Math.PI / 2, x, y, z: (z0 + z1) / 2 });
    }
    function cap(x, y, z, r, segments = 14) {
        return place(circle(r, segments), { ry: Math.PI, x, y, z });
    }

    const EXHAUSTS = {
        quad: () => {
            const xs = [-0.21, -0.11, 0.11, 0.21];
            return [xs.map((x) => cap(x, -0.375, -2.02, 0.036)), xs.map((x) => pipe(x, -0.375, -1.72, -2.03, 0.043))];
        },
        ovals: () => {
            const xs = [-0.16, 0.16];
            return [xs.map((x) => place(circle(0.058, 18), { ry: Math.PI, sy: 0.6, x, y: -0.375, z: -2.035 })), xs.map((x) => place(cylinder(0.065, 0.065, 0.32, 18, true), { rx: Math.PI / 2, sz: 0.6, x, y: -0.375, z: -1.88 }))];
        },
        trumpet: () => [
            [cap(0, -0.37, -2.06, 0.085, 18)],
            [pipe(0, -0.37, -1.72, -1.9, 0.04), place(cylinder(0.095, 0.04, 0.17, 18, true), { rx: -Math.PI / 2, y: -0.37, z: -1.975 })],
        ],
        hextips: () => {
            const xs = [-0.2, 0.2];
            return [xs.map((x) => cap(x, -0.375, -2.04, 0.05, 6)), xs.map((x) => place(cylinder(0.06, 0.06, 0.32, 6, true), { rx: Math.PI / 2, ry: Math.PI / 6, x, y: -0.375, z: -1.89 }))];
        },
        turbine: () => [
            [cap(0, -0.36, -2.04, 0.12, 20), ...Array.from({ length: 9 }, (_, n) => {
                const a = (n / 9) * Math.PI * 2;
                return place(new T.BoxGeometry(0.025, 0.1, 0.008), { rz: a, x: -Math.sin(a) * 0.065, y: -0.36 + Math.cos(a) * 0.065, z: -2.0 });
            })],
            [pipe(0, -0.36, -1.72, -2.05, 0.125, 20), place(torus(0.125, 0.014, 8, 24), { y: -0.36, z: -2.05 }), place(cone(0.035, 0.07, 12), { rx: -Math.PI / 2, y: -0.36, z: -2.0 })],
        ],
        afterburner: () => {
            const xs = [-0.14, 0.14];
            return [
                xs.map((x) => cap(x, -0.37, -1.99, 0.06, 18)),
                xs.flatMap((x) => [place(cylinder(0.072, 0.06, 0.3, 18, true), { rx: -Math.PI / 2, x, y: -0.37, z: -1.88 }), place(torus(0.072, 0.012, 8, 24), { x, y: -0.37, z: -2.03 })]),
                xs.map((x) => cap(x, -0.37, -2.0, 0.058, 18)),
            ];
        },
    };

    function materialsOf(mesh) {
        return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    }

    function glow(base) {
        const m = base.clone();
        m.name = "CrateGlow";
        m.color?.set?.(0xff7a1a);
        if (m.emissive) {
            m.emissive.set(0xff6a00);
            m.emissiveIntensity = 2.2;
        }
        m.transparent = false;
        return m;
    }

    function goldify(mats) {
        return mats.map((m) => {
            if (m.name === "Main" || m.name === "MainPlain" || m.name === "BrakeLight" || m.name === "PenguEye") return m;
            const g = m.clone();
            const dark = /black/i.test(m.name);
            g.color?.set?.(dark ? 0x7a5410 : 0xf2c14e);
            if ("metalness" in g) g.metalness = 0.65;
            if ("roughness" in g) g.roughness = 0.3;
            if (g.emissive) g.emissive.set(dark ? 0x1a1000 : 0x3a2600);
            return g;
        });
    }

    // ---- The Stadium body: an open-wheel racer drawn over the stock car's wheels, suspension and exhaust, in the body
    // frame (+z the nose, +x the left). Wheel centres sit near y -0.41 (front x 0.628 z 1.348, rear x 0.721 z -1.527,
    // radius 0.331, half-width 0.172) and the road near y -0.74. Everything stays clear of a front wheel steered 30
    // degrees and of the wheels with the suspension fully up.
    // Flat-shaded triangle lists made of convex pieces, each face turned away from its piece's centre so the game's
    // one-sided materials show it on both sides of the car.
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    function mid(P) {
        const m = [0, 0, 0];
        for (const p of P) (m[0] += p[0]), (m[1] += p[1]), (m[2] += p[2]);
        return m.map((v) => v / P.length);
    }
    function tri(out, a, b, c, h) {
        const u = sub(b, a), v = sub(c, a);
        const nx = u[1] * v[2] - u[2] * v[1], ny = u[2] * v[0] - u[0] * v[2], nz = u[0] * v[1] - u[1] * v[0];
        if (nx * nx + ny * ny + nz * nz < 1e-14) return;
        const flip = nx * h[0] + ny * h[1] + nz * h[2] < 0;
        out.push(...a, ...(flip ? c : b), ...(flip ? b : c));
    }
    function poly(out, P, c) {
        const h = sub(mid(P), c);
        for (let k = 1; k + 1 < P.length; k++) tri(out, P[0], P[k], P[k + 1], h);
    }
    // Rings of points (same count, same order round), each joined to the next; both end rings are capped.
    function loft(out, R) {
        for (let i = 0; i + 1 < R.length; i++) {
            const A = R[i], B = R[i + 1], m = A.length, c = mid([...A, ...B]);
            for (let k = 0; k < m; k++) poly(out, [A[k], A[(k + 1) % m], B[(k + 1) % m], B[k]], c);
            if (i === 0) poly(out, A, c);
            if (i + 2 === R.length) poly(out, B, c);
        }
    }
    // A ring across the car at z from half its outline, [x, y] up the left side; the right side mirrors it.
    const section = (z, half) => [...half.map(([x, y]) => [x, y, z]), ...half.map(([x, y]) => [-x, y, z]).reverse()];
    // Eight corners numbered like a box's (bit 0: +x, bit 1: +y, bit 2: +z).
    function hexa(out, P) {
        const c = mid(P);
        for (const f of [[0, 1, 3, 2], [4, 5, 7, 6], [0, 1, 5, 4], [2, 3, 7, 6], [0, 2, 6, 4], [1, 3, 7, 5]]) poly(out, f.map((i) => P[i]), c);
    }
    function block(out, x, y, z, hx, hy, hz) {
        const P = [];
        for (let k = 0; k < 8; k++) P.push([x + (k & 1 ? hx : -hx), y + (k & 2 ? hy : -hy), z + (k & 4 ? hz : -hz)]);
        hexa(out, P);
    }
    function bar(out, a, b, r, n = 6) {
        const d = sub(b, a), L = Math.hypot(...d), w = d.map((v) => v / L);
        const t = Math.abs(w[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
        let u = [w[1] * t[2] - w[2] * t[1], w[2] * t[0] - w[0] * t[2], w[0] * t[1] - w[1] * t[0]];
        const ul = Math.hypot(...u);
        u = u.map((v) => v / ul);
        const v = [w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2], w[0] * u[1] - w[1] * u[0]];
        const R = (p) => Array.from({ length: n }, (_, k) => {
            const q = ((k + 0.5) / n) * Math.PI * 2, cs = Math.cos(q) * r, sn = Math.sin(q) * r;
            return [p[0] + u[0] * cs + v[0] * sn, p[1] + u[1] * cs + v[1] * sn, p[2] + u[2] * cs + v[2] * sn];
        });
        loft(out, [R(a), R(b)]);
    }
    // A strip lying on a surface along [z, y] points, from x0 to x1, t thick.
    function strip(out, line, x0, x1, t) {
        for (let i = 0; i + 1 < line.length; i++) {
            const [za, ya] = line[i], [zb, yb] = line[i + 1];
            hexa(out, [[x0, ya, za], [x1, ya, za], [x0, ya + t, za], [x1, ya + t, za], [x0, yb, zb], [x1, yb, zb], [x0, yb + t, zb], [x1, yb + t, zb]]);
        }
    }

    // Slots: paint (primary), second (secondary), black, carbon, frame (frame colour), brake light, visor.
    function stadiumShapes() {
        const P = { paint: [], second: [], black: [], carbon: [], frame: [], brake: [], visor: [] };
        // Monocoque from the nose tip to the tail.
        loft(P.paint, [
            section(1.98, [[0.07, -0.53], [0.09, -0.46], [0.06, -0.42]]),
            section(1.7, [[0.14, -0.55], [0.17, -0.45], [0.11, -0.36]]),
            section(1.15, [[0.2, -0.57], [0.25, -0.43], [0.16, -0.27]]),
            section(0.62, [[0.26, -0.58], [0.31, -0.4], [0.22, -0.19]]),
            section(-0.45, [[0.28, -0.58], [0.33, -0.4], [0.24, -0.17]]),
            section(-1.2, [[0.25, -0.57], [0.29, -0.42], [0.19, -0.25]]),
            section(-1.92, [[0.17, -0.54], [0.2, -0.44], [0.12, -0.32]]),
        ]);
        strip(P.second, [[1.98, -0.42], [1.7, -0.36], [1.15, -0.27], [0.62, -0.19]], -0.045, 0.045, 0.006);
        // Engine cover rising into the airbox behind the driver.
        loft(P.paint, [
            section(-0.4, [[0.2, -0.2], [0.15, 0.03], [0.07, 0.11]]),
            section(-0.7, [[0.24, -0.22], [0.18, 0.02], [0.08, 0.09]]),
            section(-1.3, [[0.21, -0.26], [0.13, -0.12], [0.06, -0.09]]),
            section(-1.85, [[0.13, -0.34], [0.09, -0.3], [0.04, -0.28]]),
        ]);
        block(P.black, 0, 0.05, -0.401, 0.06, 0.035, 0.006);
        // Cockpit opening, driver's helmet and visor.
        block(P.black, 0, -0.172, 0.05, 0.17, 0.016, 0.42);
        const helmet = (y, r) => Array.from({ length: 8 }, (_, k) => [Math.cos(((k + 0.5) / 8) * Math.PI * 2) * r, y, -0.22 + Math.sin(((k + 0.5) / 8) * Math.PI * 2) * r]);
        loft(P.second, [[0, 0.07], [0.05, 0.11], [0.11, 0.12], [0.17, 0.1], [0.21, 0.04]].map(([dy, r]) => helmet(-0.17 + dy, r)));
        block(P.visor, 0, -0.065, -0.103, 0.075, 0.024, 0.012);
        // Halo round the cockpit, from the nose top to the airbox.
        bar(P.frame, [0, -0.17, 0.5], [0, -0.03, 0.36], 0.022);
        for (const s of [1, -1]) {
            bar(P.frame, [0, -0.03, 0.36], [s * 0.15, -0.015, 0.24], 0.022);
            bar(P.frame, [s * 0.15, -0.015, 0.24], [s * 0.21, 0, 0], 0.022);
            bar(P.frame, [s * 0.21, 0, 0], [s * 0.15, 0.02, -0.42], 0.022);
        }
        for (const s of [1, -1]) {
            // Sidepods between the wheels, with an intake at the front and a stripe down the side.
            const S = [
                { z: -1.05, xi: 0.28, xo: 0.44, yb: -0.56, ti: -0.36, to: -0.44 },
                { z: 0.3, xi: 0.29, xo: 0.6, yb: -0.58, ti: -0.28, to: -0.36 },
                { z: 0.8, xi: 0.27, xo: 0.5, yb: -0.57, ti: -0.34, to: -0.4 },
            ];
            for (let i = 0; i + 1 < S.length; i++) {
                const pod = [], band = [];
                for (let k = 0; k < 8; k++) {
                    const q = S[i + (k >> 2)];
                    pod.push([s * (k & 1 ? q.xo : q.xi), k & 2 ? (k & 1 ? q.to : q.ti) : q.yb, q.z]);
                    band.push([s * (q.xo + (k & 1 ? 0.007 : 0)), q.yb + (k & 2 ? 0.12 : 0.075), q.z]);
                }
                hexa(P.paint, pod);
                hexa(P.second, band);
            }
            block(P.black, s * 0.385, -0.47, 0.803, 0.09, 0.06, 0.006);
            // Front wing: main plane, flap and end plate, on pylons under the nose.
            block(P.second, s * 0.39, -0.6, 1.88, 0.39, 0.015, 0.1);
            block(P.paint, s * 0.37, -0.565, 1.82, 0.37, 0.012, 0.035);
            block(P.second, s * 0.79, -0.56, 1.87, 0.012, 0.07, 0.12);
            block(P.black, s * 0.06, -0.56, 1.86, 0.012, 0.035, 0.08);
            // Rear wing end plates (inside the rear wheels) with light strips, and the pylons.
            block(P.second, s * 0.515, 0.08, -1.8, 0.015, 0.2, 0.16);
            block(P.brake, s * 0.515, 0.12, -1.963, 0.012, 0.1, 0.005);
            block(P.frame, s * 0.05, -0.06, -1.8, 0.012, 0.25, 0.07);
        }
        // Rear wing main plane (the club tag lies on it) and its lip.
        block(P.paint, 0, 0.2, -1.8, 0.5, 0.018, 0.13);
        block(P.second, 0, 0.235, -1.935, 0.5, 0.03, 0.008);
        // Floor, gearbox round the exhausts, diffuser and rain light.
        block(P.carbon, 0, -0.595, -0.15, 0.5, 0.012, 1.0);
        block(P.carbon, 0, -0.4, -1.75, 0.28, 0.07, 0.17);
        block(P.carbon, 0, -0.53, -1.62, 0.34, 0.05, 0.31);
        block(P.brake, 0, -0.31, -1.89, 0.06, 0.022, 0.04);
        return [P.paint, P.second, P.black, P.carbon, P.frame, P.brake, P.visor];
    }

    function stadiumBody(chassis) {
        const ms = materialsOf(chassis);
        const by = (n) => ms.find((m) => m.name === n);
        const main = by("Main") ?? ms[0];
        const black = by("AirIntake") ?? ms[0];
        // MainPlain takes the primary colour and Secondary the secondary one (VisualCar.setCarStyle); no pattern UVs.
        const own = (src, name, hex, rough) => {
            const m = src.clone();
            m.name = name;
            if ("map" in m) m.map = null;
            m.color?.setHex?.(hex);
            if (rough != null && "roughness" in m) m.roughness = rough;
            return m;
        };
        const mats = [own(main, "MainPlain", 0x969696), own(main, "Secondary", 0x969696), black, own(black, "StadiumCarbon", 0x1b1d21, 0.6),
            by("Metal") ?? black, by("BrakeLight") ?? black, own(black, "StadiumVisor", 0x0d1016, 0.12)];
        const slots = stadiumShapes().map((list) => list.length ? [geometry(list)] : []);
        return build(slots, mats, "BodyStadium");
    }

    // Called from VisualCar.initResources once car.glb is in (rims, exhausts) and again once car_bodies.glb is (bodies).
    function buildParts({ THREE, utils, models, stage }) {
        T = THREE;
        U = utils;
        try {
            if (stage === "parts") {
                const wm = materialsOf(models.rims.get(0));
                const tireMat = wm.find((m) => m.name === "Tire") ?? wm[0];
                const rimMat = wm.find((m) => m.name === "Rim") ?? wm[1] ?? wm[0];
                const metalMat = wm.find((m) => m.name === "Metal") ?? rimMat;
                for (const p of PARTS.rims) models.rims.set(p.index, build(RIMS[p.id](), [tireMat, rimMat, metalMat], "Crate_" + p.id));
                const ex = materialsOf(models.exhausts.get(0));
                const darkMat = ex.find((m) => m.name === "AirIntake") ?? ex[0];
                const exMetal = ex.find((m) => m.name === "Metal") ?? ex[ex.length - 1];
                const hot = glow(darkMat);
                for (const p of PARTS.exhausts) models.exhausts.set(p.index, build(EXHAUSTS[p.id](), [darkMat, exMetal, hot], "Crate_" + p.id));
                // Built with car.glb, so menus and thumbnails have it before car_bodies.glb is in.
                try {
                    const stadium = stadiumBody(models.bodies.get(0));
                    models.bodies.set(STADIUM, stadium);
                    models.bodiesLow.set(STADIUM, stadium);
                } catch (err) {
                    console.error("Stadium body failed to build", err);
                }
            } else if (stage === "bodies") {
                const make = (src, p) => {
                    const g = src.geometry.clone();
                    g.applyMatrix4(new T.Matrix4().makeScale(...p.scale));
                    if (p.lift) g.translate(0, p.lift, 0);
                    const mesh = new T.Mesh(g, p.gold ? goldify(materialsOf(src)) : src.material);
                    // The base body's name keeps per-body extras (club tag spots) working; crateFit says how it moved.
                    mesh.name = src.name;
                    mesh.userData.crateFit = { sx: p.scale[0], sy: p.scale[1], sz: p.scale[2], lift: p.lift };
                    return mesh;
                };
                for (const p of PARTS.bodies) {
                    const src = models.bodies.get(p.base);
                    if (!src) continue;
                    const low = models.bodiesLow.get(p.base) ?? src;
                    const high = make(src, p);
                    models.bodies.set(p.index, high);
                    models.bodiesLow.set(p.index, low === src ? high : make(low, p));
                }
            }
        } catch (err) {
            console.error("Crate parts failed to build", err);
        }
    }

    window.__nswsCrateParts = { BASE, STOCK, PARTS, list, byIndex, buildParts };
})();
