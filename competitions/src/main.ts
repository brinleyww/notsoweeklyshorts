// Cuppa, the Competitions of Not So Weekly Shorts. main.bundle.js loads this file the first
// time someone opens Competitions or a cup link.
import { App } from './app.ts';
import { site } from './game.ts';
import { installTransport } from './transport.js';
import { Layer } from './ui/layer.ts';
import type { CupInfo } from './ui/hub.ts';
import { FORMATS, importOldPresets } from './rules.ts';

installTransport();
importOldPresets();

const app = new App();
const layer = new Layer(app);

function leave(message: string, delay = 0) {
  const connection = app.connection;
  if (!connection) return;
  // Everyone else hears it from the organizer before the room goes.
  if (app.org) {
    for (const id of app.net.ids()) app.net.send(id, { k: 'bye', why: 'The organizer closed the cup.' }, true);
    delay = Math.max(delay, 500);
  }
  setTimeout(() => {
    if (app.connection !== connection) return;
    layer.panel.setOpen(false);
    site.__nswsCup?.toMenu();
    if (message) setTimeout(() => site.__nswsMessageBox?.show(message, 'Ok', null), 600);
  }, delay);
}
app.onLeave = (message) => leave(message);

site.__nswsCupRoom = () => layer.hub.room();
site.__nswsCupLeave = (message) => leave(message);
// Personal bests set in a cup upload with the cup code, so Race Control holds them for review.
site.__nswsLobbyTag = () => {
  const room = layer.hub.room();
  return room ? '&nswsLobby=' + room.code : '';
};
(site as unknown as { __nswsCupKeysPanel: () => void }).__nswsCupKeysPanel = () => layer.keys.open();

site.__nswsCupApp = {
  open: () => (app.connection && app.game ? layer.panel.setOpen(true) : layer.hub.open()),
  join: (code: string) => {
    // Set by mod/nsws_cup_rejoin.js when the player chose to rejoin the cup they were in.
    const rejoin = site.__nswsCupRejoin;
    site.__nswsCupRejoin = undefined;
    if (rejoin?.code === code && rejoin.info) return layer.hub.rejoin(code, rejoin.info as CupInfo, rejoin.role);
    return layer.hub.join(code);
  },
  inCup: () => !!app.state,
  debug: () => ({
    host: app.isHost,
    me: app.me,
    phase: app.state?.phase ?? null,
    round: app.state?.round ?? null,
    session: app.info?.sessionId ?? null,
    racing: app.driver.racing,
    done: app.driver.done,
    blocked: app.game ? app.driver.blocks(app.game) : null,
    watching: app.watch.active,
    target: app.watch.target,
    offset: app.driver.offset,
    error: app.error,
  }),
  app,
  layer,
  formats: FORMATS,
};
