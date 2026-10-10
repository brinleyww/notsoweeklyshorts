// Not So Weekly Shorts entry point for PolyCup (replaces src/main.ts, which needs PolyModLoader).
// main.bundle.js loads this file the first time someone opens Competitions or a cup link.
import type { PolyModLoader } from '../src/game-types.ts';
import { Controller } from '../src/controller.ts';
import { CupUI } from '../src/ui.ts';
import { installTransport } from './transport.js';
import { CompetitionsHub } from './hub.ts';

type KeyBinding = { getter: () => string; callback: (event: KeyboardEvent) => void };
type Keys = { chat(): string; ghosts(): string; matches(event: KeyboardEvent, binding: string): boolean };

const site = window as unknown as {
  __nswsCupKeys?: Keys;
  __nswsKeyBindCapturing?: boolean;
  __nswsCupApp?: unknown;
  __nswsLobbyTag?: (trackId: string) => string;
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

// Personal bests set in a cup upload with the cup code, so Race Control holds them for review.
site.__nswsLobbyTag = () => {
  const code = hub.activeCode();
  return code ? '&nswsLobby=' + code : '';
};

site.__nswsCupApp = {
  open: () => hub.open(),
  join: (code: string) => hub.join(code),
  inCup: () => !!controller.state,
};
