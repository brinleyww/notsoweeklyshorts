# Competitions (PolyCup)

The main menu's **Competitions** button runs [PolyCup](https://github.com/Prawnfoot05/PolyCup) by
**Kiki** (Prawnfoot05), version 0.3.0, used with permission. `src/` is PolyCup's TypeScript source;
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

## Changes to PolyCup's own source

Each is marked "Not So Weekly Shorts" in the file:

- `native.ts`: `connectNative` uses the site bridge; no load-time source patching.
- `chat.ts`: rewritten. The cup chat runs on the site's universal chat (`/nsws/chat?cup=CODE`), so it
  shares its filter, slow mode and timeouts; `chat-ui.ts` (how it looks and where it sits) is unchanged.
  PolyCup's own `chat-filter.ts` is gone.
- `cup.ts`, `controller.ts`, `ui.ts`, `types.ts`, `protocol.ts`, `validation.ts`: vote-skip for random
  tracks (`skip-vote` action, `skipVote` in the state). More than half of the racers skips the track;
  a live round is voided and a new random track is drawn.
- `presets.ts` (`poolAllows`), `preset-ui.ts`, `preset-summary.ts`, `draft.ts`, `ui.ts`: the map pool
  is the host's, so a preset only decides whether custom tracks are allowed.
- `ui.ts`, `controller.ts`: no "Create a Simple Cup" screen (the cup is named before the room opens),
  and no autosave or restore (a new room has a new code, so a restored cup couldn't reach its racers).
- `main.ts` and `version-check.ts` (PolyModLoader only) are removed.
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
