// Builds mod/polycup.js from PolyCup's source (src/) and the site adapter (nsws/).
//   node polycup/build.mjs            (needs esbuild: npm i -D esbuild, or set ESBUILD to its folder)
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const esbuild = require(process.env.ESBUILD || 'esbuild');

await esbuild.build({
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
