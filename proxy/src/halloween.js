// The limited Halloween event. Keep in step with mod/nsws_halloween.js and the week's entry in main.bundle.js. The week is a number of its own, above any real week, and
// it is never renumbered once runs exist: runs are stored under ids derived from it.
export const HALLOWEEN = {
    week: 1031,
    from: Date.UTC(2026, 9, 31),
    until: Date.UTC(2026, 10, 3, 3, 41),
    horsemanTrack: "c6f92a36ad919acc18e680d1ac3c244fab63e6882f90807af315dd8a24930ee5",
    horsemanFrames: 12600,
};

export function halloweenLive(now = Date.now()) {
    return now >= HALLOWEEN.from && now < HALLOWEEN.until;
}
