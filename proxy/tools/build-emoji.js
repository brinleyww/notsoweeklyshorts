// Builds mod/nsws_emoji.json, the chat's emoji list, from emojibase-data:
//   node proxy/tools/build-emoji.js <folder with emojibase-data's en/ files>
// The folder needs compact.json, data.json and shortcodes/{joypixels,github,iamcal}.json.
// JoyPixels names come first because they match Discord's (:sob:, :flag_us:, :thumbsup:).

const fs = require("fs");
const path = require("path");

// Emoji newer than this show as empty boxes on many phones and PCs.
const MAX_VERSION = 15;
const GROUPS = [
    [0, "Smileys & Emotion"], [1, "People & Body"], [3, "Animals & Nature"], [4, "Food & Drink"],
    [5, "Travel & Places"], [6, "Activities"], [7, "Objects"], [8, "Symbols"], [9, "Flags"],
];

const dir = process.argv[2];
if (!dir) throw new Error("Usage: node build-emoji.js <emojibase-data en folder>");
const read = (file) => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
const compact = read("compact.json");
const versions = new Map(read("data.json").map((e) => [e.hexcode, e.version]));
const presets = ["joypixels", "github", "iamcal"].map((name) => read("shortcodes/" + name + ".json"));

const out = GROUPS.map(([, name]) => ({ name, emojis: [] }));
for (const e of compact.slice().sort((a, b) => a.order - b.order)) {
    const group = GROUPS.findIndex(([id]) => id === e.group);
    if (group < 0 || !(versions.get(e.hexcode) <= MAX_VERSION)) continue;
    const names = [];
    for (const preset of presets) {
        for (const name of [].concat(preset[e.hexcode] ?? [])) {
            const clean = String(name).toLowerCase();
            // Flags keep :flag_us: but not the bare country code, which would top every 2-letter search.
            if (e.group === 9 && clean.length === 2) continue;
            if (/^[a-z0-9_+-]+$/.test(clean) && !names.includes(clean)) names.push(clean);
        }
    }
    if (!names.length) continue;
    const words = new Set([...(e.tags || []), ...(e.label || "").toLowerCase().split(/[^a-z0-9]+/)]);
    for (const name of names) words.delete(name);
    out[group].emojis.push([e.unicode, names.join(" "), [...words].filter(Boolean).join(" ")]);
}

const file = path.join(__dirname, "..", "..", "mod", "nsws_emoji.json");
fs.writeFileSync(file, JSON.stringify(out));
console.log(file, out.map((g) => g.name + " " + g.emojis.length).join(", "), fs.statSync(file).size + " bytes");
