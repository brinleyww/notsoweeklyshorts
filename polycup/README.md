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
- `nsws/entry.ts` replaces `src/main.ts`: a small stand-in for PolyModLoader's keybind calls (the
  bindings live in the game's Settings: Competitions and Ghosts) and the Competitions screen
  (`nsws/hub.ts`: open cups, join by code or `?cup=CODE` link, hosting).

## Changes to PolyCup's own source

Each is marked "Not So Weekly Shorts" in the file:

- `native.ts`: `connectNative` uses the site bridge; no load-time source patching.
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
