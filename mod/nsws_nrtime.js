// No-respawn time (Trackmania's NR clock): each respawn winds it back to when the car first reached that checkpoint,
// so it is the run time minus the time spent between a checkpoint and the respawns to it. Display only.
(function () {
    const CSS = `
.timer-ui > .center{position:relative;}
.timer-ui > .center > .nsws-nr{position:absolute;left:0;bottom:100%;width:100%;margin:0 0 2px 0;padding:0;color:var(--text-color);font-size:22px;font-weight:normal;white-space:nowrap;pointer-events:none;text-shadow:1px 1px 1px var(--surface-color), -1px 1px 1px var(--surface-color), -1px -1px 1px var(--surface-color), 1px -1px 1px var(--surface-color);}
.timer-ui.up > .center > .nsws-nr{bottom:auto;top:100%;margin:2px 0 0 0;}
.timer-ui > .center > .nsws-nr.hidden{display:none;}
.time-announcer-ui > .difference.nsws-nr > p:not(.title){color:var(--text-color);}
`;

    let run = null;

    function enabled() {
        return window.__nswsSettingBoolean?.("NoRespawnTime") !== false;
    }

    function addStyle() {
        if (document.getElementById("nsws-nr-style")) return;
        const style = document.createElement("style");
        style.id = "nsws-nr-style";
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    // Frames are milliseconds.
    function clock(frames) {
        const n = Math.max(0, frames), m = Math.floor(n / 60000), s = Math.floor(n % 60000 / 1000), ms = n % 1000;
        return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0") + "." + String(ms).padStart(3, "0");
    }

    function frames(car) {
        return car.getFinishTime()?.numberOfFrames ?? car.getTime().numberOfFrames;
    }

    // The reset callback can run on the frame the reset key went down, before the car is back at its checkpoint,
    // so the restored checkpoint count is read once a later frame arrives.
    function settle(car) {
        if (run?.car !== car || null == run.pending || frames(car) <= run.pending && !car.hasFinished()) return;
        const base = run.reached[car.getNextCheckpointIndex()];
        if (null != base) run.offset = run.pending - base;
        run.pending = null;
    }

    function newCar(car, ui) {
        run = { car, ui, offset: 0, respawned: false, pending: null, reached: [0], line: null };
        hideLine(ui);
    }

    function checkpoint(car) {
        if (run?.car !== car) return;
        settle(car);
        run.reached[car.getNextCheckpointIndex()] = car.getTime().numberOfFrames - run.offset;
    }

    function respawn(car) {
        if (run?.car !== car || car.hasFinished()) return;
        // A reset with no checkpoint to go to puts the car back on the start with its clock at zero.
        if (!car.hasStarted()) return void Object.assign(run, { offset: 0, respawned: false, pending: null, reached: [0] });
        // The callback fires on the car state's reset edge; the live keys can already be up after a quick tap.
        if (!(car.getCarState?.()?.controls ?? car.getControls())?.reset) return;
        run.respawned = true;
        run.pending = car.getTime().numberOfFrames;
    }

    function nr(car) {
        settle(car);
        const base = null != run.pending ? run.reached[car.getNextCheckpointIndex()] : null;
        return frames(car) - (null != base ? run.pending - base : run.offset);
    }

    function hideLine(ui) {
        ui?.querySelector(".timer-ui > .center > .nsws-nr")?.classList.add("hidden");
    }

    function line() {
        if (run.line?.isConnected) return run.line;
        const center = run.ui?.querySelector(".timer-ui > .center");
        if (!center) return null;
        addStyle();
        run.line = center.querySelector(".nsws-nr");
        if (!run.line) {
            run.line = document.createElement("h2");
            run.line.className = "nsws-nr hidden";
            center.appendChild(run.line);
        }
        return run.line;
    }

    // Writing the DOM every frame, even unchanged, runs every page-wide MutationObserver.
    function update(car) {
        if (run?.car !== car) return;
        const show = run.respawned && enabled();
        if (!show && !run.line) return;
        const el = line();
        if (!el) return;
        if (el.classList.contains("hidden") === show) el.classList.toggle("hidden", !show);
        if (!show) return;
        const text = "No respawn " + clock(nr(car));
        if (el.textContent !== text) el.textContent = text;
    }

    function finish(car, ui) {
        if (run?.car !== car || !run.respawned || !enabled()) return;
        const time = nr(car);
        if (time === frames(car)) return;
        const panels = ui?.querySelectorAll(".time-announcer-ui");
        const panel = panels?.[panels.length - 1];
        if (!panel) return;
        addStyle();
        panel.querySelector(":scope > .nsws-nr")?.remove();
        const row = document.createElement("div"), title = document.createElement("p"), value = document.createElement("p");
        row.className = "difference nsws-nr";
        title.className = "title";
        title.textContent = "No respawn";
        value.textContent = clock(time);
        row.append(title, value);
        panel.appendChild(row);
    }

    window.__nswsNR = { newCar, checkpoint, respawn, update, finish };
})();
