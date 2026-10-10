import { VERSION } from './cup.ts';
import type { PolyModLoader } from './game-types.ts';

// PML already advertises modID:modVersion in PolyTrack's signaling handshake.
export function registerVersionCheck(pml: PolyModLoader, insert: unknown) {
  const version = JSON.stringify(VERSION);
  pml.registerClassMixin('ii.prototype', 'renewInvite', {
    type: insert,
    token: 'const h = [];',
    func: `
      const cupMods = o.mods.filter(mod => typeof mod === 'string' && mod.startsWith('polytrack-world-cup:'));
      if (cupMods.length !== 1 || cupMods[0] !== 'polytrack-world-cup:' + ${version}) {
        e.send(JSON.stringify({version:'0.6.3',type:'declineJoin',session:t,
          reason:'IncompatibleMods',polyCupVersion:${version}}));
        return;
      }
    `,
  });
  pml.registerClassMixin('vc.prototype', 'joinInvite', {
    type: insert,
    token: 'const s = [];',
    func: `
      const cupMods = t.mods.filter(mod => typeof mod === 'string' && mod.startsWith('polytrack-world-cup:'));
      if (cupMods.length && (cupMods.length !== 1 || cupMods[0] !== 'polytrack-world-cup:' + ${version})) {
        const required = cupMods[0].slice('polytrack-world-cup:'.length).replace(/[^a-zA-Z0-9.+-]/g,'').slice(0,40);
        const error = new Dl('polycup-version');
        error.message = 'PolyCup version mismatch. Host: ' + required + '. Installed: ' + ${version} + '. Install the same version as the host, then rejoin.';
        o(error); u.close(); return;
      }
    `,
  });
  pml.registerClassMixin('vc.prototype', 'joinInvite', {
    type: insert,
    token: 'const e = t.reason;',
    func: `
      if (e === 'IncompatibleMods') {
        const required = typeof t.polyCupVersion === 'string' ? t.polyCupVersion.replace(/[^a-zA-Z0-9.+-]/g,'').slice(0,40) : null;
        const error = new Dl('polycup-version');
        error.message = required
          ? 'PolyCup version mismatch. Host: ' + required + '. Installed: ' + ${version} + '. Install the same version as the host, then rejoin.'
          : 'Incompatible mods. Installed PolyCup: ' + ${version} + '. PolyCup versions must match. Check the host’s mods and versions, then rejoin.';
        o(error); u.close(); return;
      }
    `,
  });
  pml.registerFuncMixin('qc', {
    type: insert,
    token: 'switch (e.errorType) {',
    func: `case 'polycup-version': n = e.message; break;`,
  });
}
