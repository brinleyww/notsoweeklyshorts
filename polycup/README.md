# Competitions (PolyCup)

The main menu's **Competitions** button runs [PolyCup](https://github.com/Prawnfoot05/PolyCup) by
**Kiki** (Prawnfoot05), version 0.3.1, used with permission. `src/` is PolyCup's TypeScript source;
`nsws/` adapts it to this site. Build output: `mod/polycup.js` (do not edit it).

## How it runs here

PolyCup is a PolyModLoader mod for PolyTrack 0.6.3 that rides on the game's multiplayer: Kodub's
matchmaking server introduces the players, then everything goes peer to peer over WebRTC. This
site is a deobfuscated 0.6.0 build without PolyModLoader, and every part of a cup goes through the
proxy instead:

- `nsws/transport.js` replaces WebRTC. Every data channel of every player connection rides on one
  WebSocket per page (`/nsws/cup/mux`), bundled into at most one message every 200 ms, because
  Cloudflare bills per incoming WebSocket message.
- The game's matchmaking sockets go to `/nsws/cup/host` and `/nsws/cup/join` (`proxy/src/lobby.js`,
  one `LobbyRoom` Durable Object per cup code). The room stores nothing.
- `src/native.ts` gets its game access from `window.__nswsCup` in `main.bundle.js` (`cupNative`),
  instead of PolyModLoader patching 0.6.3's minified code. `main.bundle.js` also adds the 0.6.3
  invite API PolyCup uses (`requestInvite`/`getInvite`/`renewInvite`) on top of 0.6.0's `createInvite`.
- `nsws/entry.ts` replaces PolyCup's `main.ts`: a small stand-in for PolyModLoader's keybind calls
  (the bindings live in the game's Settings: Competitions and Ghosts) and the Competitions screen
  (`nsws/hub.ts`: open cups, join by code or `?cup=CODE` link, hosting).
- Hosting picks the cup's name and its maps before the room opens: the weekly shorts (on by
  default), Summer, Winter and Desert main tracks, and Kodub's community tracks by game version (in
  a flyout). The cup is created under that name (as the proxy filtered it), and players joining read
  the name and pool from `/nsws/cup/info` first. `cupNative` in `main.bundle.js` lists only the pool's
  maps (`window.__nswsCupPool`): weekly shorts and main tracks as "official", community as "community".
- During a multiplayer race the game's own Invite, Players and Change Track buttons are gone; the cup
  panel has all three.

## Updating PolyCup

The site's edits are merged onto each PolyCup release with a three-way merge: the previous release's
`src/` is the base, this folder's `src/` is one side and the new release's `src/` the other (0.3.0 to
0.3.1 was done this way). Then port what the new `main.ts` and `native.ts` add: `main.ts` becomes
`nsws/entry.ts`, and new NativeApi functions go into `cupNative` in `main.bundle.js`.

From 0.3.1: `physics-integrity.ts` hashes `polytrack_physics.wasm` (`entry.ts` gives it the URL; the
site's binary is the stock one), the spectator free camera (`freecamPressed`/`enterFreecam` in
`cupNative`, off on tracks whose week blocks free camera), the player menu, track removal and the
spectator eye counter. The physics reports and eye counts are only relayed when they change.

## Changes to PolyCup's own source

Each is marked "Not So Weekly Shorts" in the file:

- `native.ts`: `connectNative` uses the site bridge; no load-time source patching.
- `chat.ts`: rewritten. The cup chat runs on the site's universal chat, so it shares its filter, slow
  mode and timeouts: a Cup tab (`/nsws/chat?cup=CODE`) and a Global tab (the main chat, connected
  only once opened). `chat-ui.ts` keeps its look and place, with the two tabs at the top.
  PolyCup's own `chat-filter.ts` is gone.
- `cup.ts`, `controller.ts`, `ui.ts`, `types.ts`, `protocol.ts`, `validation.ts`: vote-skip for random
  tracks (`skip-vote` action, `skipVote` in the state). More than half of the racers skips the track;
  a live round is voided and a new random track is drawn.
- `presets.ts` (`poolAllows`), `preset-ui.ts`, `preset-summary.ts`, `draft.ts`, `ui.ts`: the map pool
  is the host's, so a preset only decides whether custom tracks are allowed.
- `ui.ts`, `controller.ts`: no "Create a Simple Cup" screen (the cup is named before the room opens),
  and no autosave or restore (a new room has a new code, so a restored cup couldn't reach its racers).
- `main.ts` and `version-check.ts` (PolyModLoader only) are removed.
- `controller.ts`: physics reports and spectator counts are sent only when they change (or every
  30 s / 10 s), not every 3 s / 1 s.
- `ui.ts`: the cup panel key (Tab) and the spectator keys ([ and ]) are rebindable, and a Keys button
  in the header opens `nsws/keys.ts`, the list of every key a cup uses (also on the Competitions
  screen). Its game keys are saved the same way as Settings -> Controls.
- `ui.ts`, `controller.ts`: a finished cup shows a final podium (each racer's car on their step, like
  Trackmania), then everyone returns to the menu with a message after 20 s (the organizer 3 s later).
  End Cup also sends everyone back (`onCupEnded`, `hub.leave`).
- `controller.ts`, `ui.ts`: a racer who leaves mid-round gets a DNF at once (one whose connection only
  stutters gets the usual grace period) and the round goes on; the "void the round" disconnect rule
  is gone. When everyone else leaves, the organizer gets a notice and the room stays open.
- `controller.ts`: the next random track loads during the break between rounds, and `main.bundle.js`
  starts a new multiplayer session after 1 s instead of the stock 5 s.
- `ui.ts`: the cup panel key (Tab) opens the panel and closes it on the next press (it used to be a
  hold-to-peek at the standings).
- `cup.ts`, `preset-ui.ts`: new cups start on Quickplay (random rotation, no draft); Standard is still
  in the preset list.
- `world-cup.css`, `dom.ts` (`uiScale`), `hud-layout.ts`, `chat-ui.ts`, `ranking-motion.ts`, `ui.ts`: the
  cup layer scales with the window like the game's UI (`--ui-scale-factor`). `build.mjs` converts the
  stylesheet's viewport units and drops media queries that can't match at the game's layout size. The
  Competitions screen and Keys list scale the same way.
- `controller.ts`, `ui.ts`: automatic rounds carry on after a void; Remove current track and Start next
  round wait for the game to be ready instead of failing; a round whose new game session never arrives
  asks for it again after 8 s; and the organizer has a Restart round button (same track, from the
  countdown, nobody scores the stopped attempt).
- `invite.ts`: a Link button that copies `?cup=CODE`.
- `ui.ts`, `toolbar.ts`: no F8 shortcut (the menu button and the race toolbar open the panel), no
  version label over the menus, and the HUD layout pass is throttled and only watches the game UI.
- `controller.ts`: the lobby list is read four times a second instead of every frame.
- `spectator.ts`: a longer spectator buffer, since camera poses arrive in batches.

## Build

```sh
npm i -D esbuild        # or set ESBUILD to an esbuild package folder
node polycup/build.mjs
```
