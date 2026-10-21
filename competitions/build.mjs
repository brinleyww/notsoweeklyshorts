// Builds mod/competitions.js from src/.  node competitions/build.mjs
// Needs esbuild: npm i -D esbuild, or set ESBUILD to an esbuild package folder.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const esbuild = require(process.env.ESBUILD || 'esbuild');

const common = { bundle: true, format: 'iife', target: 'es2022', minify: true, legalComments: 'none', charset: 'ascii', logLevel: 'info' };

await esbuild.build({
  ...common,
  entryPoints: [path.join(here, 'src/main.ts')],
  outfile: path.join(here, '../mod/competitions.js'),
  loader: { '.css': 'text' },
  banner: { js: '/* Cuppa (Not So Weekly Shorts Competitions). Built from competitions/ - edit the source, not this file. */' },
});

// The bot planner, loaded into a copy of the game's simulation worker (src/bots/worker).
await esbuild.build({
  ...common,
  entryPoints: [path.join(here, 'src/bots/worker/index.ts')],
  outfile: path.join(here, '../mod/cuppa_bots.js'),
  banner: { js: '/* Cuppa bot planner. Built from competitions/ - edit the source, not this file. */' },
});
