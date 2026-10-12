# Cuppa (Competitions)

The main menu's **Competitions** button opens Cuppa, the site's live cup mode. It is
built from `src/` into `mod/competitions.js`, which only loads when someone opens Competitions or
a `?cup=CODE` link. Edit the source, not the built file.

```sh
npm i -D esbuild        # or set ESBUILD to an esbuild package folder
node competitions/build.mjs
```

## How it runs

A cup rides on the game's own multiplayer: the organizer's page is the game's multiplayer host,
everyone else is a client, and every round is a game session (a new session for each new track,
the same session with the cars reset for another round on the same track). The proxy stands in for
Kodub's matchmaking and WebRTC (`proxy/src/lobby.js`, PROXY.md "Competitions").

- `transport.js` fakes RTCPeerConnection / RTCDataChannel over one WebSocket per page, batching
  everything into binary frames.
- `net.ts` adds the cup's own data channel (id 40, JSON) on each player connection.
- `host.ts` (`Organizer`) runs only on the organizer's page. It owns the cup state (`state.ts`),
  runs the round clock, loads tracks, replays each finish through the game's physics
  (`verifyRun`) and broadcasts the state when it changes. `engine.ts` is its pure tournament logic
  (scoring, knockouts, finals, votes, standings), `rules.ts` the formats and rule limits.
- `app.ts` runs on every page: it adopts the game's multiplayer connection, says hello with a
  random identity key kept per cup code (so a player who reloads gets their place and points back),
  syncs its clock with the organizer, and drives:
  - `driver.ts`: the local car. Controls are held until GO, the car starts on GO, finishes go to the
    organizer with their replay. Single-run rounds: restart pressed twice retires, respawning with no
    checkpoint restarts the car with the clock still running. Time attack: restarts are free.
  - `spectate.ts`: watching. The camera rides another racer's car using that car's own chase or
    cockpit camera, so nothing is streamed. Director (auto), Follow (◀ ▶) or Free camera.
  - `live.ts`: live timing from the car states the game already sends: checkpoints, running order,
    gaps and splits, at no network cost.
- `ui/`: everything is in one shadow root over the game, scaled by the game's `--ui-scale-factor`.
  `hud.ts` (round bar, countdown, live board, split popup, spectator bar, results, votes, warm-up,
  chat feed, notices, podium), `panel.ts` (Tab: cup, standings, rounds, players, tracks, rules, chat),
  `hub.ts` (the Competitions screen), `layer.ts` (mounting, keys, the game toolbar buttons).
- `chat.ts`: the cup chat on the site's universal chat (`/nsws/chat?cup=CODE`) plus a tab for the
  main chat.

Game access is `window.__nswsCup` in `main.bundle.js` (`cupNative`, types in `game.ts`). The race
session calls the cup once a frame before drawing (`cupFrameHook`).

## Formats

Quickplay, Sprint, Championship, Formula, Cup Finals, Knockout, Time Attack and Bumper Cars are
presets of the same rules (`rules.ts`); the organizer can change any rule in the lobby and save
their own presets. A few rules (break length, finish window, late joiners, free camera, next-track
choice) can change mid-cup.

- Winning: first to N points, a fixed number of rounds, finals (reach N to become a finalist, then
  win a round) or knockout (the slowest K are out each round; exact ties at the cut stay).
- Rounds per track, then the next track: random, vote, winner picks, last place picks, or the
  organizer picks (any track, from the Tracks tab, which can also queue the next one).
- Round style: one run (finish window after the first finish, a time limit) or time attack.
- Warm-up on each new track (racers can ready up to end it early), collisions, late joiners,
  spectator free camera, the organizer's custom tracks, PB uploads (held for review).
- Points: 200 for 1st falling with the log of the place to 10 for 25th; Formula uses F1's shape.
  Equal points are split by countback.

## Organizer tools

Start, pause between rounds, next now, end round now, +30 s, restart round, void round, skip
track, end cup, race again, move players between grid and spectators, remove players, message
everyone (a banner on every screen). End round, Restart and Void are also in the game's toolbar
during a round. Official cups (owner key) are announced and post their results for the Cup
Champion tag.

## Cost on Cloudflare

Incoming WebSocket messages are billed, so a page batches what it sends: every 200 ms while its
car is moving (or, for the organizer, while anyone's is), and every 1 s otherwise. Clicks,
finishes and phase changes flush at once. Live timing and spectating need no messages of their
own. Measured with two pages: about 3.5 frames a second per driving page, about 1 a second idle.
