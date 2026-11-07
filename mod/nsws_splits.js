// Trackmania-style checkpoint splits in the top middle of the screen: speed, time and difference at each
// checkpoint and the finish. The reference is the run the timer's own Difference column uses (the fastest
// ghost picked for the race, usually the player's PB).
(function () {
    const SHOW_MS = 3500;

    const CSS = `
.nsws-splits{position:absolute;top:130px;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;align-items:flex-start;color:#fff;line-height:1;white-space:nowrap;pointer-events:none;z-index:1;}
.nsws-splits:not(.show){display:none;}
.nsws-splits>div{box-sizing:border-box;height:33px;display:flex;align-items:center;background:rgba(4,24,44,.68);}
.nsws-splits>.speed{width:126px;justify-content:space-between;padding:0 5px 0 8px;font-size:27px;}
.nsws-splits>.speed>.d{color:#80ffaa;}
.nsws-splits>.speed>.d.down{color:#ff8080;}
.nsws-splits>.time{width:126px;margin-top:4px;justify-content:center;font-size:29px;}
.nsws-splits>.diff{height:31px;min-width:82px;padding:0 8px;justify-content:center;font-size:28px;}
.nsws-splits>.diff.slower{background:rgba(250,92,90,.82);}
.nsws-splits>.diff.faster{background:rgba(74,108,255,.82);}
.nsws-splits .hidden{display:none;}
`;

    function addStyle() {
        if (document.getElementById("nsws-splits-style")) return;
        const style = document.createElement("style");
        style.id = "nsws-splits-style";
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    function el(tag, className) {
        const node = document.createElement(tag);
        node.className = className;
        return node;
    }

    // Frames are milliseconds.
    function clock(frames) {
        const n = Math.abs(frames), m = Math.floor(n / 60000), s = Math.floor(n % 60000 / 1000), ms = n % 1000;
        return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0") + "." + String(ms).padStart(3, "0");
    }

    function delta(frames) {
        const n = Math.abs(frames), m = Math.floor(n / 60000), s = Math.floor(n % 60000 / 1000), ms = String(n % 1000).padStart(3, "0");
        const sign = frames > 0 ? "+" : frames < 0 ? "-" : "";
        return sign + (m > 0 ? m + ":" + String(s).padStart(2, "0") : s) + "." + ms;
    }

    // split: { time, ref, speed, refSpeed } with times in frames and speeds in km/h; ref and refSpeed may be null.
    function paint(box, split, imperial) {
        const unit = imperial ? 1.609344 : 1;
        box.speedValue.textContent = (Math.abs(split.speed) / unit).toFixed(1);
        box.speedDiff.classList.toggle("hidden", split.refSpeed == null);
        if (split.refSpeed != null) {
            const d = Math.round((Math.abs(split.speed) - Math.abs(split.refSpeed)) / unit * 10) / 10;
            box.speedDiff.textContent = (d < 0 ? "-" : "+") + Math.abs(d).toFixed(1);
            box.speedDiff.classList.toggle("down", d < 0);
        }
        box.time.textContent = clock(split.time);
        box.diff.classList.toggle("hidden", split.ref == null);
        if (split.ref != null) {
            const d = split.time - split.ref;
            box.diff.textContent = delta(d);
            box.diff.classList.toggle("slower", d > 0);
            box.diff.classList.toggle("faster", d < 0);
        }
    }

    // One per race, inside the race's HUD element so it hides with the rest of the HUD.
    function create(parent, imperial) {
        if (window.__nswsSettingBoolean?.("CpSplits") !== true) return null;
        addStyle();
        const box = el("div", "nsws-splits");
        const speed = el("div", "speed");
        box.speedValue = el("span", "v");
        box.speedDiff = el("span", "d");
        speed.append(box.speedValue, box.speedDiff);
        box.time = el("div", "time");
        box.diff = el("div", "diff");
        box.append(speed, box.time, box.diff);
        parent.appendChild(box);
        let timer = 0;

        function show(split, stay) {
            clearTimeout(timer);
            paint(box, split, imperial);
            box.classList.add("show");
            if (!stay) timer = setTimeout(hide, SHOW_MS);
        }

        function hide() {
            clearTimeout(timer);
            box.classList.remove("show");
        }

        return {
            checkpoint: (split) => show(split, false),
            finish: (split) => show(split, true),
            hide,
            dispose() {
                hide();
                box.remove();
            },
        };
    }

    window.__nswsSplits = { create, wanted: () => window.__nswsSettingBoolean?.("CpSplits") === true };
})();
