// Builds mod/competitions.js from src/.  node competitions/build.mjs
// Needs esbuild: npm i -D esbuild, or set ESBUILD to an esbuild package folder.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const esbuild = require(process.env.ESBUILD || 'esbuild');

await esbuild.build({
  entryPoints: [path.join(here, 'src/main.ts')],
  outfile: path.join(here, '../mod/competitions.js'),
  bundle: true,
  format: 'iife',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  charset: 'ascii',
  loader: { '.css': 'text' },
  banner: { js: '/* Cuppa (Not So Weekly Shorts Competitions). Built from competitions/ - edit the source, not this file. */' },
  logLevel: 'info',
});
