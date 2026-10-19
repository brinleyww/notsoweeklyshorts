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
  everything into binary frames. Each connection counts the records it got and keeps the last 1 MB
  it sent, so after a dropped socket or a proxy deploy both ends re-link and resend whatever the
  other end missed (PROXY.md, "Dropped connections" and "Deploys"). The game never sees the gap, so
  a racer keeps their place, and the organizer takes its code back. Every cup socket (matchmaking, relay, cup chat) is opened with
  `window.__nswsSocket` (`mod/nsws_socket.js`), which falls back to HTTPS on networks that block
  WebSockets (PROXY.md, "HTTPS fallback for sockets").
- `net.ts` adds the cup's own data channel (id 40, JSON) on each player connection.
- `host.ts` (`Organizer`) runs only on the organizer's page. It owns the cup state (`state.ts`),
  runs the round clock, loads tracks, replays each finish through the game's physics
  (`verifyRun`) and broadcasts the state when it changes. `engine.ts` is its pure tournament logic
  (scoring, knockouts, finals, votes, standings), `rules.ts` the formats and rule limits.
- `app.ts` runs on every page: it adopts the game's multiplayer connection, says hello with a
  random identity key kept per cup code (so a player who reloads gets their place and points back),
  syncs its clock with the organizer, and drives:
  - `driver.ts`: the local car. Controls are held until GO, the car starts on GO, finishes go to the
    organizer with their replay. Single-run rounds: restart (and respawning with no checkpoint) puts the car
    back at the start with the clock still running; restart pressed twice within 2 s retires. Time attack: restarts are free.
  - `spectate.ts`: watching. The camera rides another racer's car using that car's own chase or
    cockpit camera, so nothing is streamed. Director (auto), Follow (◀ ▶) or Free camera.
  - `smooth.ts`: draws every other car where it is now. Each page stamps its car's states with when
    that car started on the cup clock (`transport.js`), so a state's age is known; the car is drawn at
    (cup time now - its start), between real states or carried on from the newest along its path (up to
    1.2 s), and a correction after a brake, crash or landing fades out over ~0.1 s. The game's own remote
    playback (a buffer drawn 0.6 s behind, which skipped 50 ms a frame whenever a 200 ms bunch over- or
    under-filled it) gets no states. The organizer's own car goes out in its batches, so its start is in
    the cup state (`clk`). Measured with three pages at over 100 km/h: 33-58 m behind before, 0.3-1.2 m
    off (p95 0.8-2.4 m) now. Other cars are hidden while results, votes or loading cover the race.
    Live timing still reads states as they arrive. Bumper cars don't guess (a guessed car would be one
    you crash into): their pages send every 100 ms while driving and the game's own playback draws
    other cars 0.25 s behind its newest state (about 0.3-0.37 s behind the real car, was 0.5-0.57 s),
    which costs about twice the messages while racing, in bumper cups only.
  - Car states go straight between pages: the room passes a racer's stamped states (`kind 2` records)
    to every other page as well as the organizer (PROXY.md, "Competitions"), so they skip the organizer's
    page and its batching. The room stamps each copy with the link it came in on, and pages trust only
    the organizer's list of whose link is whose (`lk` in the cup state). The organizer's game then leaves them out of its batches to pages that get
    them this way (`window.__nswsCupDirect`, set in `app.ts` from `transport.js`), so each state is
    decoded once; with an older page or Worker on either end it relays them as before, and `smooth.ts`
    drops any copy it already has.
  - `live.ts`: live timing from the car states the game already sends: checkpoints, running order,
    gaps and splits, at no network cost.
- `ui/`: everything is in one shadow root over the game, scaled by the game's `--ui-scale-factor`.
  `hud.ts` (round bar, countdown, live board, split popup, spectator bar, results, votes, warm-up,
  chat feed, notices, podium), `panel.ts` (Tab: cup, standings, rounds, players, tracks, rules, chat),
  `hub.ts` (the Competitions screen), `layer.ts` (mounting, keys, the game toolbar buttons, layout),
  `keymenu.ts` (a Keys button joined to the speedometer that lists a racer's keys).
- Layout (`layer.ts`): four times a second the layer measures what the game draws (timer, speedometer,
  checkpoint count, touch buttons, other mods' counters) and places the round bar, the right column
  (watchers and the live board, with as many rows as fit) and the chat feed in the room left over. A
  card in the middle (vote, results) over the feed's corner hides the feed; chat then opens in the panel.
- Touch: the game's touch steering cancels every touch on `window` that isn't on a `<button>`, and a
  touch inside the shadow root looks like one on its host `<div>`, so the layer stops touch events at
  its host. The car is held only while a text box of the layer really has focus; a click outside the
  box ends the typing. Phone keyboards cover the page without resizing it, so while a box of the layer
  has focus the layer shrinks to `visualViewport` (`#fitKeyboard`) and the chat boxes sit above the
  keyboard.
- Never assign an `on*` property a handler that can return `false` (`el.onkeydown = (e) => e.key ===
  'Enter' && go()`): returning false cancels the event, which once made the cup code box untypable.
  `h()` attaches handlers with `addEventListener`, where the return value doesn't matter.
- Spectators tell the organizer whose car they follow (`act` `watch`, once the choice has held 0.8 s),
  and the racer sees "N watching" top right.
- `chat.ts`: two chat tabs in a cup, "Cup chat" (the cup's own room, `/nsws/chat?cup=CODE`) and
  "Everyone" (the main chat's messages and connection, `window.__nswsChat.feed`, when the player has
  it on), each with an unread count. The race overlay shows the open tab. The main chat window tucks
  away inside a cup. Outside a cup,
  the main chat shows the same fading previews over a race while its window is minimized, and the
  chat key opens a quick message line (`mod/nsws_chat.js`).

Game access is `window.__nswsCup` in `main.bundle.js` (`cupNative`, types in `game.ts`). The race
session calls the cup once a frame before drawing (`cupFrameHook`).

## Formats and rules

Quickplay, Sprint, Championship, Formula, Pick & Ban, Knockout, Time Attack and Bumper Cars are only
starting points: every format is a set of the same rules (`rules.ts`), and the organizer can change
each one on its own on the cup panel's setup page. Players see the same rules read-only. Mid-cup,
the safe ones stay editable: break, finish window, late joiners, free camera, next track, ready ends
warm-up, countdown, choosing time and skip votes.

- **Winning:** points (a typed points cap), a fixed number of rounds, or knockout (the slowest K go
  each round; exact ties at the cut stay; racers who leave are out). With points, the **finalist**
  switch makes the cap a finalist line: a finalist who then wins a round outright takes the cup.
- **Points per place:** all 25 places can be typed one by one, or filled from a formula (a curve that is
  70% log and 30% even steps, F1, even steps, the same for all) with the 1st and 25th values. A place never earns more than the
  one above it. Equal totals are split by countback.
- **Tracks:** rounds per track; next track by random, vote, winner picks, last place picks or the
  organizer (any track; the Tracks tab can also queue one); **pick and ban** (before the first round
  every racer bans, then picks, from one list; the picks become the playlist, repeated; bans always
  leave something to pick); skip votes (over half of the racers skips the track, or changes it after
  the round when someone already finished);.
- **Rounds:** one run (time limit auto/fixed/off, auto = 3x the best known time from the world record
  or the cup; finish window after the first finish) or time attack (its length); countdown; break.
- **Warm-up:** off, a track's first visit, or every new track; fixed length, or the world record times
  a multiplier with a minimum; optionally ended when every racer is ready.
- **Players:** late joiners, spectator free camera, bumper cars, PB uploads (held for review).
- **Presets:** save, copy as text, import from text. Presets saved by the old cup mode (PolyCup) are
  imported once and translated.

PB and WR badges mark finishes that beat the racer's own best or the track's world record (never in
bumper cars). Notices call out photo finishes, lead changes, new finalists, match points and the
final round. The organizer is warned (privately) when a racer sends a run identical to an earlier one.

## Organizer tools

Start, pause between rounds, next now, end round now, +30 s, restart round, void round (press
twice), skip track, end cup (press twice), race again (same or new tracks), move players between grid and spectators, remove players, message
everyone (a banner on every screen). End round, Restart and Void are also in the game's toolbar
during a round.

The Competitions screen only opens the room (name, maps, size, listed or not, race or only
organize); the format and rules are set on the cup panel's setup page afterwards, and the next room
starts on the format chosen last. There are no official cups: Cup Champion is a tag the owner grants
by hand on Race Control.

## Look

The UI follows PolyTrack's own menus: its navy surfaces, the game's slanted button (the hover fill and
white underline), plain headings and no gradients; gold only marks 1st place. Finalists show
"Finalist" in reddish orange in place of their points. Chat text uses the font picked in Settings > Chat.

## Cost on Cloudflare

Incoming WebSocket messages are billed, so a page batches what it sends: every 200 ms while its
car is moving (racers from the countdown on; the organizer while anyone's car moves or a round
runs), and every 1 s otherwise; the transport re-checks the pace every 100 ms, so a batch queued at
the slow pace never holds up a car that just started. Clicks,
finishes and phase changes flush at once. Live timing and spectating need no messages of their
own. On the game's unreliable channel the transport also drops what carries nothing: the empty car
batch the organizer's game sends everyone every 100 ms, repeated car states, pings beyond one per
10 s at the slow pace, and (while results, votes or loading cover the race) all but the newest car
state. Pages also stay quiet in the background (hidden, or another window focused): no pongs, clock
syncs, watch reports, cup chat keepalives or list refreshes, unless the player races in a round or
organizes. Clock syncs are every 30 s, and pings or watch changes reach the others with the next real
state change (at most 10 s later between rounds).

Measured with two pages (frames a second, before -> after): driving 4.0 -> 3.9 (unchanged by design),
the organizer in a countdown 3.6 -> 1.4, results 1.3-1.5 -> 0.3-0.4, votes and lobby 0.9-1.05 ->
0.1-0.27, a hidden page between rounds ~1 -> 0, a player who left 0. A 16-racer cup works out at
about 135 requests a minute before and 114 after while racing; driving is the floor at this pace.
With prediction (`smooth.ts`) the pace no longer shows as lag, only as guessing error: three weaving
racers at 110-156 km/h were drawn a median 1.1-1.9 m off (p95 2-6 m) at a 400 ms pace, against
0.3-1.2 m (p95 0.8-2.4 m) at 200 ms, for about half the driving frames.

A player who closes the tab by accident is offered the cup again from the menu
(`mod/nsws_cup_rejoin.js`, the game's own confirm box): while they are in a cup (not organizing it),
`app.ts` keeps `nsws-sc-rejoin` in localStorage, which leaving on purpose clears; Rejoin connects with
the same identity key, so the organizer gives back the same player, points and results.
