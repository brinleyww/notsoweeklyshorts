// Not So Weekly Shorts entry point for PolyCup (replaces src/main.ts, which needs PolyModLoader).
// main.bundle.js loads this file the first time someone opens Competitions or a cup link.
import type { PolyModLoader } from '../src/game-types.ts';
import { Controller } from '../src/controller.ts';
import { CupUI } from '../src/ui.ts';
import { installTransport } from './transport.js';
import { CompetitionsHub, poolLabel, type MapPool } from './hub.ts';
import { KeysPanel } from './keys.ts';
import { PhysicsIntegrity } from '../src/physics-integrity.ts';

type KeyBinding = { getter: () => string; callback: (event: KeyboardEvent) => void };
type Keys = { chat(): string; ghosts(): string; matches(event: KeyboardEvent, binding: string): boolean };

const site = window as unknown as {
  __nswsCupKeys?: Keys;
  __nswsKeyBindCapturing?: boolean;
  __nswsCupApp?: unknown;
  __nswsLobbyTag?: (trackId: string) => string;
  __nswsCupRoom?: () => { code: string; secret: string | null } | null;
  __nswsCupPool?: MapPool;
  __nswsCupPoolLabel?: () => string;
  __nswsCupKeysPanel?: () => void;
  __nswsCupLeave?: (message: string) => void;
};

installTransport();

// PolyCup registers two keys and a setting through PolyModLoader. Their bindings live in the
// game's Settings (main.bundle.js, "Competitions" and "Ghosts"); everything else is a no-op here.
const keys: KeyBinding[] = [];
const keyGetters: Record<string, () => string> = {
  PolyCupChat: () => site.__nswsCupKeys?.chat() ?? 'KeyY',
  PolyCupToggleGhosts: () => site.__nswsCupKeys?.ghosts() ?? 'KeyG',
};
const pml = {
  polyVersion: '0.6.0-nsws',
  registerClassMixin() {},
  registerFuncMixin() {},
  registerGlobalMixin() {},
  getFromPolyTrack() {
    throw new Error('Not available on this site.');
  },
  registerSettingCategory() {},
  registerSetting() {},
  registerBindCategory() {},
  // The site's physics binary, which PhysicsIntegrity hashes so the host sees modified copies.
  getPhysicsWasmURL: () => new URL('polytrack_physics.wasm', document.baseURI).href,
  registerKeybind(_label: string, key: string, _event: string, primary: string, _secondary: null, callback: (event: KeyboardEvent) => void) {
    keys.push({ getter: keyGetters[key] ?? (() => primary), callback });
  },
} as unknown as PolyModLoader;
window.addEventListener('keydown', (event) => {
  if (site.__nswsKeyBindCapturing || !site.__nswsCupKeys) return;
  for (const key of keys) if (site.__nswsCupKeys.matches(event, key.getter())) key.callback(event);
});

let ui: CupUI | undefined;
const controller = new Controller(() => ui?.render());
const physics = new PhysicsIntegrity();
physics.install(pml);
pml.getPhysicsWasmURL?.();
controller.setPhysicsSource(() => physics.report);
try {
  controller.init(pml);
  pml.registerKeybind('Open Cup chat', 'PolyCupChat', 'keydown', 'KeyY', null, (event) => ui?.chatHotkey(event));
  pml.registerKeybind("Toggle other players' ghosts", 'PolyCupToggleGhosts', 'keydown', 'KeyG', null, (event) => ui?.ghostHotkey(event));
} catch (error) {
  controller.fail(error);
}
ui = new CupUI(controller);
ui.render();

const hub = new CompetitionsHub(controller);
const keysPanel = new KeysPanel();
site.__nswsCupKeysPanel = () => keysPanel.open();

// Personal bests set in a cup upload with the cup code, so Race Control holds them for review.
site.__nswsLobbyTag = () => {
  const code = hub.activeCode();
  return code ? '&nswsLobby=' + code : '';
};

site.__nswsCupRoom = () => hub.room();
site.__nswsCupLeave = (message) => hub.leave(message);
// The organizer leaves a moment after the others, so nobody sees the room drop first.
// Official cups send their final standings (owner key), which gives the winner the Cup Champion tag.
const posted = new Set<string>();
window.setInterval(() => {
  const s = controller.state;
  if (!s || s.phase !== 'complete' || !hub.official || posted.has(s.id)) return;
  posted.add(s.id);
  const owner = (window as unknown as { __nswsOwner?: { token(): Promise<string | null> } }).__nswsOwner;
  void owner?.token().then((token) => {
    if (!token) return;
    const m = s.matches[s.matchIndex];
    const results = s.results.map((r) => ({
      nickname: s.roster.find((p) => p.id === r.id)?.name ?? '',
      place: r.place,
      score: m?.scores[r.id] ?? 0,
    }));
    return fetch((window as unknown as { __nswsApiBase: string }).__nswsApiBase + 'nsws/cup/result', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ token, cupId: s.id, code: hub.activeCode(), name: s.name, results }),
      credentials: 'omit',
      cache: 'no-store',
    });
  }).catch(() => posted.delete(s.id));
}, 2000);
controller.onCupEnded = (byMe) =>
  hub.leave(byMe ? 'You ended the cup.' : 'The organizer ended the cup.', byMe ? 2000 : 0);
site.__nswsCupPoolLabel = () => poolLabel(site.__nswsCupPool ?? { shorts: true, main: [], community: [] });

site.__nswsCupApp = {
  open: () => hub.open(),
  join: (code: string) => hub.join(code),
  inCup: () => !!controller.state,
  debug: () => controller.debugInfo(),
};
