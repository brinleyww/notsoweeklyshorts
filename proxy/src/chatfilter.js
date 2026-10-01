// Slur filter for the chat. Swearing is allowed; only the words below are replaced
// with "#". Text is folded to a skeleton first (accents, look-alike letters from other
// scripts, fancy Unicode, leetspeak, repeated letters, letters split up by spaces or
// symbols), and each match is mapped back to the original characters it came from.

// "strict" words are caught anywhere, even inside a longer word. "whole" words are short
// enough to sit inside innocent words (raccoon, spice, Pakistan), so they are only caught
// as a word of their own, optionally plural.
const STRICT = [
    "snigger", "nigger", "nigga", "niggah", "niggaz", "nigguh", "niggur", "nigglet", "niggress", "negroid",
    "faggot", "faggit", "fagget", "faggy", "tranny", "trannie", "shemale", "chingchong", "chinkie",
    "wetback", "raghead", "towelhead", "sandnigger", "zipperhead", "jigaboo", "jiggaboo", "jigabo",
    "porchmonkey", "junglebunny", "golliwog", "heilhitler", "siegheil", "gasthejews", "whitepower", "retarded",
];
const WHOLE = [
    "nig", "nigg", "niga", "nigah", "nigar", "negro", "fag", "fagg", "dyke", "chink", "gook",
    "spic", "kike", "kyke", "coon", "paki", "wog", "gyppo", "troon", "retard", "redskin", "injun", "sambo",
    "beaner", "darkie", "darky",
];
// Real words a strict word would otherwise catch (niggardly), as skeleton text after the match.
const ALLOW_AFTER = { nigga: /^rd/ };

// What each skeleton character can stand for. Letters always stand for themselves.
const LEET = {
    "0": "o", "1": "il", "2": "z", "3": "e", "4": "a", "5": "s", "6": "gb", "7": "tl", "8": "b", "9": "gq",
    "@": "a", "^": "a", "$": "s", "!": "il", "|": "il", "+": "t", "(": "c", "<": "c", "{": "c", "[": "c",
    "&": "e", "%": "x", "*": "aeiou", "?": "aeiou", "#": "aeiou",
};
// Sounds people swap in to dodge a filter. Only used for strict words: on short words
// they would catch "kiss" or "dice".
const SOUND_ALIKE = { k: "c", c: "k", q: "gk", z: "s", s: "z", y: "i", i: "y", v: "u", u: "uv", w: "u", x: "ks" };

// Letters from other scripts that look Latin, and letters NFKD leaves alone.
const LOOK_ALIKE = {
    "а": "a", "в": "b", "с": "c", "ԁ": "d", "е": "e", "ё": "e", "һ": "h", "і": "i", "ї": "i", "ј": "j", "к": "k",
    "м": "m", "н": "h", "о": "o", "р": "p", "ԛ": "q", "г": "r", "ѕ": "s", "т": "t", "у": "y", "х": "x", "ү": "y",
    "ԝ": "w", "п": "n", "и": "u", "л": "n", "ь": "b", "ʙ": "b", "ɢ": "g", "ɡ": "g", "ɪ": "i", "ʟ": "l",
    "ɴ": "n", "ʀ": "r", "ʏ": "y", "ᴀ": "a", "ᴄ": "c", "ᴅ": "d", "ᴇ": "e", "ᴊ": "j", "ᴋ": "k", "ᴍ": "m",
    "ᴏ": "o", "ᴘ": "p", "ᴛ": "t", "ᴜ": "u", "ᴠ": "v", "ᴡ": "w", "ᴢ": "z", "ꜰ": "f", "ꜱ": "s",
    "α": "a", "β": "b", "ε": "e", "η": "n", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t",
    "υ": "u", "χ": "x", "γ": "y", "ω": "w", "ς": "s", "σ": "o", "μ": "u", "λ": "a", "δ": "d", "π": "n",
    "ı": "i", "ł": "l", "ø": "o", "đ": "d", "ð": "d", "ħ": "h", "ŧ": "t", "ß": "ss", "æ": "ae", "œ": "oe",
    "ŋ": "n", "ƒ": "f", "ɑ": "a", "ɐ": "a", "ə": "e", "ɛ": "e", "ɨ": "i", "ɵ": "o", "ʉ": "u", "ɯ": "w",
    "€": "e", "£": "e", "¢": "c", "¥": "y", "©": "c", "®": "r", "×": "x", "¡": "i", "∩": "n", "Λ": "a", "∧": "a",
    "ⅰ": "i", "ⅼ": "l", "ⅽ": "c", "ⅾ": "d", "ⅿ": "m", "ⅴ": "v", "ⅹ": "x",
};

// Invisible characters, accents and zalgo marks. Apostrophes join a word instead of splitting it.
const SKIP = /[\p{M}\p{Cf}\u034f\u115f\u1160\u3164\uffa0\ufe00-\ufe0f'`\u2018\u2019\u02bc]/u;

function letterClasses(sounds) {
    const classes = {};
    for (let c = 97; c <= 122; c++) {
        const letter = String.fromCharCode(c);
        const stands = new Set([letter]);
        for (const [sym, letters] of Object.entries(LEET)) if (letters.includes(letter)) stands.add(sym);
        if (sounds) for (const [other, letters] of Object.entries(SOUND_ALIKE)) if (letters.includes(letter)) stands.add(other);
        classes[letter] = "[" + [...stands].map((s) => s.replace(/[\\\]\[^-]/g, "\\$&")).join("") + "]";
    }
    return classes;
}

// Each letter may repeat ("niiiigger"); the skeleton has already dropped separators.
function wordPattern(word, classes) {
    return [...word].map((ch) => classes[ch] + "+").join("");
}

const STRICT_CLASS = letterClasses(true);
const WHOLE_CLASS = letterClasses(false);
const STRICT_SORTED = STRICT.slice().sort((a, b) => b.length - a.length);
const STRICT_RE = new RegExp(STRICT_SORTED.map((w) => "(" + wordPattern(w, STRICT_CLASS) + ")").join("|"), "g");
const PLURAL = "(?:" + WHOLE_CLASS.s + "+|" + WHOLE_CLASS.e + "+" + WHOLE_CLASS.s + "+)?";
const WHOLE_RE = new RegExp("^(?:" + WHOLE.map((w) => wordPattern(w, WHOLE_CLASS)).join("|") + ")" + PLURAL + "$");
const MAX_WORD = Math.max(...STRICT.map((w) => w.length), ...WHOLE.map((w) => w.length)) + 3;

function foldChar(ch) {
    if (SKIP.test(ch)) return "";
    const code = ch.codePointAt(0);
    if (code >= 0x1f1e6 && code <= 0x1f1ff) return String.fromCharCode(97 + code - 0x1f1e6);
    let lower = ch.toLowerCase();
    if (LOOK_ALIKE[lower] != null) return LOOK_ALIKE[lower];
    lower = lower.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
    let out = "";
    for (const c of lower) out += LOOK_ALIKE[c] ?? c;
    // "⒩" decomposes to "(n)": keep only the letter.
    return out.length > 1 && /[a-z]/.test(out) ? out.replace(/[^a-z0-9]/g, "") : out;
}

// Splits text into words of skeleton characters, each remembering the original
// [start, end) it came from. Whitespace and symbols that stand for no letter split words.
function skeletonWords(text) {
    const words = [];
    let word = null;
    let index = 0;
    for (const ch of text) {
        const start = index;
        index += ch.length;
        const folded = foldChar(ch);
        if (folded === "") continue;
        for (const c of folded) {
            const kept = (c >= "a" && c <= "z") || LEET[c] != null;
            if (!kept) {
                word = null;
                continue;
            }
            if (!word) words.push(word = { chars: "", from: [], to: [] });
            word.chars += c;
            word.from.push(start);
            word.to.push(index);
        }
    }
    return words;
}

function strictMatches(skeleton) {
    const found = [];
    STRICT_RE.lastIndex = 0;
    let m;
    while ((m = STRICT_RE.exec(skeleton))) {
        const word = STRICT_SORTED[m.slice(1).findIndex((g) => g !== undefined)];
        const end = m.index + m[0].length;
        if (!ALLOW_AFTER[word]?.test(skeleton.slice(end))) found.push([m.index, end]);
        if (m[0].length === 0) STRICT_RE.lastIndex++;
    }
    return found;
}

// Symbols at the edge of a word ("fag!", "(coon)") may be punctuation rather than leet.
// Returns the [start, end) of the match within the skeleton.
function wholeMatch(skeleton) {
    if (WHOLE_RE.test(skeleton)) return [0, skeleton.length];
    const start = /^[^a-z]*/.exec(skeleton)[0].length;
    const end = skeleton.length - /[^a-z]*$/.exec(skeleton)[0].length;
    if (end <= start || (start === 0 && end === skeleton.length)) return null;
    return WHOLE_RE.test(skeleton.slice(start, end)) ? [start, end] : null;
}

// Returns the [start, end) ranges of the original text to censor.
export function findSlurs(text) {
    const words = skeletonWords(String(text));
    const ranges = [];
    const add = (word, a, b) => ranges.push([word.from[a], word.to[b - 1]]);

    for (const word of words) {
        for (const [a, b] of strictMatches(word.chars)) add(word, a, b);
        const whole = wholeMatch(word.chars);
        if (whole) add(word, ...whole);
    }

    // Words split up by spaces or symbols ("n i g g e r", "fa.g", "nig ger"): join runs of
    // neighbouring words and look for a slur that spans exactly those words, so that
    // "drag head" or "white powerup" are left alone.
    for (let i = 0; i < words.length; i++) {
        let joined = words[i].chars;
        const from = words[i].from.slice();
        const to = words[i].to.slice();
        for (let j = i + 1; j < words.length && joined.length < MAX_WORD * 2; j++) {
            joined += words[j].chars;
            from.push(...words[j].from);
            to.push(...words[j].to);
            const merged = { from, to };
            const whole = wholeMatch(joined);
            if (whole) add(merged, ...whole);
            for (const [a, b] of strictMatches(joined)) {
                if (a === 0 && /^(?:[sz5$]*|e[sz5$])$/.test(joined.slice(b))) add(merged, a, joined.length);
            }
        }
    }
    return ranges;
}

export function censor(text) {
    text = String(text);
    const ranges = findSlurs(text);
    if (!ranges.length) return text;
    const hide = new Uint8Array(text.length);
    for (const [a, b] of ranges) hide.fill(1, a, b);
    let out = "";
    let index = 0;
    for (const ch of text) {
        out += hide[index] && !/\s/.test(ch) ? "#" : ch;
        index += ch.length;
    }
    return out;
}
