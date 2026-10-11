// Builds mod/polycup.js from PolyCup's source (src/) and the site adapter (nsws/).
//   node polycup/build.mjs            (needs esbuild: npm i -D esbuild, or set ESBUILD to its folder)
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const esbuild = require(process.env.ESBUILD || 'esbuild');

// PolyCup's layer scales with the window like the game's own UI (world-cup.css, :host). It is laid
// out at no less than the game's 1150 x 800 layout size, so viewport units are converted to that
// space and media queries that can never match there are dropped (ones that always match are kept
// without their condition).
const LAYOUT = { width: 1150, height: 800 };
function mediaMatch(condition) {
  if (condition.includes(',')) return null;
  let result = true;
  for (const part of condition.split(/\band\b/)) {
    const m = /\(\s*(max|min)-(width|height)\s*:\s*(\d+)px\s*\)/.exec(part);
    if (!m) {
      if (part.trim()) return null;
      continue;
    }
    const [, kind, axis, px] = m;
    const value = Number(px);
    if (kind === 'max' && value < LAYOUT[axis]) return false;
    if (kind === 'min' && value <= LAYOUT[axis]) continue;
    result = null;
  }
  return result;
}
export function scaleCss(css) {
  let out = '';
  for (let at = 0; at < css.length; ) {
    const media = css.indexOf('@media', at);
    if (media < 0) {
      out += css.slice(at);
      break;
    }
    const open = css.indexOf('{', media);
    let depth = 1,
      end = open + 1;
    for (; depth && end < css.length; end++) {
      if (css[end] === '{') depth++;
      else if (css[end] === '}') depth--;
    }
    const match = mediaMatch(css.slice(media + 6, open));
    out += css.slice(at, media);
    if (match === true) out += scaleCss(css.slice(open + 1, end - 1));
    else if (match === null) out += css.slice(media, open + 1) + scaleCss(css.slice(open + 1, end - 1)) + '}';
    at = end;
  }
  return out.replace(/(\d*\.?\d+)(dvh|svh|lvh|vh|vw)\b/g, (_, n, unit) => `calc(${n} * var(--${unit === 'vw' ? 'vw' : 'vh'}))`);
}
const scaledCss = {
  name: 'nsws-scaled-css',
  setup(build) {
    build.onLoad({ filter: /world-cup\.css$/ }, async (args) => ({
      contents:
        ':host{--vw:calc(1vw / var(--s,1));--vh:calc(1dvh / var(--s,1))}' +
        scaleCss(await readFile(args.path, 'utf8')),
      loader: 'text',
    }));
  },
};

await esbuild.build({
  plugins: [scaledCss],
  entryPoints: [path.join(here, 'nsws/entry.ts')],
  outfile: path.join(here, '../mod/polycup.js'),
  bundle: true,
  format: 'iife',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  loader: { '.css': 'text', '.svg': 'text' },
  banner: { js: '/* PolyCup by Kiki (github.com/Prawnfoot05/PolyCup), used with permission. Built from polycup/ - edit the source, not this file. */' },
  logLevel: 'info',
});
