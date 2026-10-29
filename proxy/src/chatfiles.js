// Chat uploads that aren't images: any file except programs and scripts. The page loads this file
// too (for a quick answer before uploading), so it must not import anything.

const PROGRAM_EXT = new Set([
    "exe", "com", "scr", "pif", "bat", "cmd", "msi", "msix", "msixbundle", "msp", "mst", "dll", "sys", "drv", "ocx", "cpl",
    "ps1", "psm1", "psd1", "ps1xml", "vb", "vbs", "vbe", "js", "jse", "mjs", "wsf", "wsh", "wsc", "hta", "html", "htm", "xhtml",
    "shtml", "svg", "svgz", "mht", "mhtml", "xht", "jar", "class", "jnlp", "apk", "xapk", "apks", "aab", "ipa", "app", "dmg", "pkg",
    "mpkg", "deb", "rpm", "sh", "bash", "zsh", "csh", "ksh", "command", "run", "appimage", "lnk", "url", "website", "reg", "scf",
    "inf", "ins", "isp", "appx", "appxbundle", "application", "gadget", "iso", "img", "vhd", "vhdx", "docm", "dotm", "xlsm",
    "xltm", "xlam", "pptm", "potm", "ppam", "ppsm", "sldm", "py", "pyw", "pyc", "pyz", "pl", "rb", "php", "lua", "applescript",
    "scpt", "workflow", "action", "elf", "out", "ko", "so", "dylib", "bundle", "crx", "xpi", "vsix", "msc", "settingcontent-ms",
    "library-ms", "search-ms", "diagcab", "cab", "chm", "hlp", "xll", "xla", "ade", "adp", "mde", "mdb", "accde", "sct", "wsb",
]);

export const MAX_FILE_NAME = 100;

function extension(name) {
    const dot = name.lastIndexOf(".");
    return dot < 0 ? "" : name.slice(dot + 1).toLowerCase().replace(/[\s.]+$/, "");
}

// Why a file name can't be posted, or null.
export function blockedName(name) {
    return PROGRAM_EXT.has(extension(String(name ?? "").trim().replace(/[.\s]+$/, ""))) ? "Programs and scripts can't be posted." : null;
}

// The name players see: no folders, no characters a download dialog refuses.
export function fileName(name) {
    const clean = String(name ?? "").replace(/^.*[\\/]/, "").replace(/[<>:"|?*\\/]/g, "_").trim();
    return clean || "file";
}

function ascii(b, at, n) {
    return String.fromCharCode(...b.subarray(at, at + n));
}

function u16(b, at) {
    return b[at] | (b[at + 1] << 8);
}

function u32(b, at) {
    return (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16)) + b[at + 3] * 0x1000000;
}

function isProgram(b) {
    if (b.length >= 2 && b[0] === 0x4d && b[1] === 0x5a) return true;
    if (b.length >= 2 && b[0] === 0x23 && b[1] === 0x21) return true;
    if (b.length < 4) return false;
    const magic = u32(b, 0);
    return magic === 0x464c457f || magic === 0xfeedface || magic === 0xfeedfacf || magic === 0xcefaedfe
        || magic === 0xcffaedfe || magic === 0xbebafeca;
}

// The names inside a zip, or null if it isn't one (or can't be read).
function zipNames(b) {
    if (b.length < 22 || u32(b, 0) !== 0x04034b50) return null;
    for (let end = b.length - 22; end >= Math.max(0, b.length - 65557); end--) {
        if (u32(b, end) !== 0x06054b50) continue;
        const count = u16(b, end + 10);
        let at = u32(b, end + 16);
        const names = [];
        for (let i = 0; i < count; i++) {
            if (at + 46 > b.length || u32(b, at) !== 0x02014b50) return null;
            const nameLength = u16(b, at + 28);
            names.push(new TextDecoder().decode(b.subarray(at + 46, at + 46 + nameLength)));
            at += 46 + nameLength + u16(b, at + 30) + u16(b, at + 32);
        }
        return names;
    }
    return null;
}

// What the chat plays inline, from the bytes, not the name.
function playable(b) {
    if (b.length < 12) return null;
    if (ascii(b, 4, 4) === "ftyp") return /^M4[AB] /.test(ascii(b, 8, 4)) ? "audio/mp4" : "video/mp4";
    if (u32(b, 0) === 0xa3df451a) return "video/webm";
    if (ascii(b, 0, 4) === "OggS") return "audio/ogg";
    if (ascii(b, 0, 4) === "fLaC") return "audio/flac";
    if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WAVE") return "audio/wav";
    if (ascii(b, 0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe6) === 0xe2)) return "audio/mpeg";
    return null;
}

// { type, name } for a file the chat takes, or { error }.
export function checkFile(bytes, rawName) {
    const name = fileName(rawName);
    const blocked = blockedName(name);
    if (blocked) return { error: blocked };
    if (isProgram(bytes)) return { error: "Programs and scripts can't be posted." };
    const inside = zipNames(bytes);
    if (inside === null && bytes.length >= 4 && u32(bytes, 0) === 0x04034b50) return { error: "Couldn't read that zip." };
    if (inside?.some((n) => blockedName(n))) return { error: "That zip has a program or script in it." };
    return { type: playable(bytes) ?? "application/octet-stream", name };
}
