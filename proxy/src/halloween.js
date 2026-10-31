// The limited Halloween event. Keep in step with mod/nsws_halloween.js and the week's entry in main.bundle.js. The week is a number of its own, above any real week, and
// it is never renumbered once runs exist: runs are stored under ids derived from it.
export const HALLOWEEN = {
    week: 1031,
    from: Date.UTC(2026, 9, 31),
    until: Date.UTC(2026, 10, 3, 3, 41),
    horsemanTrack: "b145eb72b1699e086776e43e1d07f95d4c13f7bd1a0c9240ec9d1cbc53f547a8",
    horsemanFrames: 16800,
};

export function halloweenLive(now = Date.now()) {
    return now >= HALLOWEEN.from && now < HALLOWEEN.until;
}
