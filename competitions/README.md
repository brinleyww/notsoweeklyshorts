# Cuppa (Competitions)

The main menu's **Competitions** button opens Cuppa, the site's live cup mode. It is
built from `src/` into `mod/competitions.js`, which only loads when someone opens Competitions or
a `?cup=CODE` link. Edit the source, not the built file.

**Copy invite link** hands out `<proxy>/c/CODE` rather than a link to the site, because only the
proxy can tell a chat app whose cup it is: it answers with the cup's name, format, phase, racers and
maps in the meta tags, a card drawn from them, and an instant redirect to `?cup=CODE` on the site
(PROXY.md, "Shared cup links"). Codes, old `?cup=` links and the new ones all paste into the join
box (`cupCode` in `src/ui/hub.ts`).

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
  (`verifyRun`, against the round's own track: a hidden organizer page draws no frames, so the game it last saw
  can still be the previous track's, and every run failed there) and broadcasts the state when it changes. `engine.ts` is its pure tournament logic
  (scoring, knockouts, finals, votes, standings), `rules.ts` the formats and rule limits.
- `app.ts` runs on every page: it adopts the game's multiplayer connection, says hello with a
  random identity key kept per cup code (so a player who reloads gets their place and points back),
  syncs its clock with the organizer, and drives:
  - `driver.ts`: the local car. Controls are held until GO, the car starts on GO, finishes go to the
    organizer with their replay. Single-run rounds: restart (and respawning with no checkpoint) puts the car
    back at the start with the clock still running; restart pressed twice within 2 s retires. Time attack: restarts are free.
  - `spectate.ts`: watching. The camera rides another racer's car using that car's own chase or
    cockpit camera, so nothing is streamed. Director (auto), Follow (◀ ▶) or Free camera. The
    spectator bar shows how far behind where that racer really is their car is drawn ("95 ms
    behind", `ghostBehind` in smooth.ts, smoothed and rounded to 5 ms; nothing for bots, before the
    start or past the finish).
  - `smooth.ts`: draws every other car where it is now (its own clock: the cup clock less the car's
    start, stamped on its states), or as close to now as its states allow. A car may be carried on at
    most 120 ms past its newest state, by that state's velocity, acceleration and turn; past that it
    eases to a stop and waits. Each car has its own delay behind now: the 98th percentile over the last
    10 s of how old its newest state was when the next states landed, plus about a frame, less the
    120 ms; with WebRTC (`rtc.js`) that is about 0. Playback runs at most 5% fast or slow to follow the
    delay, and the delay goes up at once when states run out and back down at 100 ms a second. When new
    states move where the car should have been, the difference (position and velocity) fades out
    through a critically damped spring over ~100 ms, so a correction never changes a car's speed at
    once; a difference over 5 m is a jump. Positions follow a curve through the real states (cubic
    Hermite), rotations slerp, and the rest (wheels, suspension, steering, speed) is the game's own
    interpolation (`lerpCarState`), with checkpoints, the finish and crash sounds when the drawn car
    gets there. A respawn, a lost stretch of states, a reset press or the start is never drawn as
    motion, nothing is carried past a finish or a respawn, and a restart (the game's car reset) ends
    the old run at once. It runs just before the game moves the other cars (`cupCarsHook`), so a
    followed car and its camera use the same state. The game's own remote playback gets no states.
    Bumper cups draw the same way; there each drawn car also gets `__cupKeys` (its drawn pose and
    where it heads 40/80/120 ms on, for the sim worker's collisions), and a hit felt on this page
    pushes the other car at once (`nudgeCar`, until its own states show the push or 400 ms).
    The acceleration is only carried on when the reading a step earlier agrees, so a hit or a landing
    isn't extrapolated into an overshoot.
    Node harness on 16 real CT runs (WR and #3 of 8 CTs, every ms of the game's physics), 60 fps:
    over the mux alone (200 ms pace, 70 ms latency) 0.28 s behind the real car (was 0.38 s); with
    WebRTC (45 ms latency, 8 ms jitter, 1% loss, a pose every 25 ms) 1 ms behind and 16 cm from the
    real car (p50; 0.9 m p95, mostly hard landings and wall hits), with step-to-step hitches of 15 cm
    p99 (11 cm before, drawing only real states). At 90 ms latency it holds about 60 ms behind.
    Browsers (`cup-test-tools/cdp/sc_rtc_rig.mjs` + `sc_rtc_ghostlat.mjs`, three racers, the local TURN
    at 45 ms + 1% loss, the mux at 70 ms): 0-24 ms behind and 0.14-0.77 m off (p50), no freezes or
    snaps; the same rig on the code before this was 347-421 ms and 8-14 m with freezes. With WebRTC
    unreachable: 240-314 ms. A bumper cup: 0-12 ms, 0.2-0.4 m.
  - `rtc.js`: car states also go straight between pages over WebRTC data channels (unordered, never
    resent), one per pair of pages, through TURN relays only (`iceTransportPolicy: "relay"`), so no page
    learns another's address: the room strips every non-relay candidate and every address from the
    connection lines, and gives out the TURN credentials (PROXY.md, "Competitions"). A page sends its
    car's own updates (every 50 ms) the moment the game makes them, and a 48-byte pose (position,
    rotation, speed, steering, keys) 25 ms after each (`main.bundle.js` VisualCar,
    `window.__nswsCarSample`); the receiver rebuilds a full state from that car's last one
    (`withPose`). The organizer's own car goes the same way (`window.__nswsRtcHostCar`). The mux still
    carries every state, and whichever copy lands first reaches the game (the second is dropped), so
    a page whose WebRTC fails only loses time. Without TURN on the Worker nothing changes.
  - Car states go straight between pages: the room passes a racer's stamped states (`kind 2` records)
    to every other page as well as the organizer (PROXY.md, "Competitions"), so they skip the organizer's
    page and its batching. The room stamps each copy with the link it came in on, and pages trust only
    the organizer's list of whose link is whose (`lk` in the cup state). The organizer's game then leaves them out of its batches to pages that get
    them this way (`window.__nswsCupDirect`, set in `app.ts` from `transport.js`), so each state is
    decoded once; with an older page or Worker on either end it relays them as before, and `smooth.ts`
    drops any copy it already has. The relay packs each state once, and pages that get the same list
    of cars share one compressed message. On the organizer's own page a racer's state reaches the cup
    (smooth.ts, live timing) as it lands, not at the next 100 ms relay.
  - `live.ts`: live timing from the car states the game already sends: checkpoints, running order,
    gaps and splits, at no network cost.
- `ui/`: everything is in one shadow root over the game, scaled by the game's `--ui-scale-factor`.
  `hud.ts` (round bar, countdown, live board, split popup, spectator bar, results, votes, warm-up,
  chat key hint, notices, podium), `panel.ts` (Tab: cup, standings, rounds, players, tracks, rules;
  the Tracks tab lists the cup's whole map pool to everyone, and only the organizer gets Play next),
  `hub.ts` (the Competitions screen), `layer.ts` (mounting, keys, the game toolbar buttons, layout),
  `keymenu.ts` (a Keys button joined to the speedometer that lists a racer's keys), `touchmenu.ts`
  and `touch.ts` (the same controls on touch screens).
- Layout (`layer.ts`): four times a second the layer measures what the game draws (timer, speedometer,
  checkpoint count, touch buttons, other mods' counters) and places the round bar, the right column
  (watchers and the live board, with as many rows as fit) and the chat key hint in the room left over. A
  card in the middle (vote, results) over the hint's corner hides the hint.
- Touch: the game's touch steering cancels every touch on `window` that isn't on a `<button>`, and a
  touch inside the shadow root looks like one on its host `<div>`, so the layer stops touch events at
  its host. The car is held only while a text box of the layer really has focus; a click outside the
  box ends the typing. Phone keyboards cover the page without resizing it, so while a box of the layer
  has focus the layer shrinks to `visualViewport` (`#fitKeyboard`) and its text boxes sit above the
  keyboard.
- Touch controls: touch screens have no keys, so every key has a button. A dock with Cup and Chat
  sits in the gap between the pedals and the steering (`#placeTouch` in `layer.ts`, which also places
  the warm-up and spectator bars). Cup opens a menu with the cup panel, hide other cars, hide HUD,
  restart, retire, skip vote, the camera modes and the organizer's quick round buttons; anything that
  can't be undone asks for a second tap. A new key needs an item there too. On a phone
  (`pointer: coarse`) the panel is one column, and Chat opens the chat window.
- Touch traps:
  - Browsers make a click only from the first finger down, so `tapWithOtherFingers` clicks a button
    tapped while a thumb holds accelerate.
  - The pedals stay up through the countdown (`native.touchPads`), and what they hold goes in at GO
    next to the held keys (`native.touchControls`).
  - The game's Reset button doesn't send a key, so in a race it asks the cup (`native.touchReset`):
    it starts over before the first checkpoint or when pressed again standing after a respawn, and
    never retires.
- Never assign an `on*` property a handler that can return `false` (`el.onkeydown = (e) => e.key ===
  'Enter' && go()`): returning false cancels the event, which once made the cup code box untypable.
  `h()` attaches handlers with `addEventListener`, where the return value doesn't matter.
- Spectators tell the organizer whose car they follow (`act` `watch`, once the choice has held 0.8 s),
  and the racer sees "N watching" top right.
- `chat.ts`: the cup chat is the main chat window (`mod/nsws_chat.js`) with two channels in a cup,
  "Cup" (the cup's own room, `/nsws/chat?cup=CODE`) and "Everyone", each with an unread count.
  `chat.ts` only hands the window the cup's room (`__nswsChat.setCup`); joining switches the window
  to Cup. Everything the main chat has works in both: emoji, GIFs, uploads, replies, reactions,
  edits, pings, profiles, the race previews while minimized and the chat key's quick line.
  Whispers go through the main room from either channel. The organizer mutes from a message's
  moderate menu. In a cup the window sits above the cup layer (and the Build Off editor), and it
  still opens with the main chat off, which then shows a "Turn it on" button under Everyone.

Game access is `window.__nswsCup` in `main.bundle.js` (`cupNative`, types in `game.ts`). The race
session calls the cup once a frame before drawing (`cupFrameHook`), and just before it moves the other
cars (`cupCarsHook`).

## Formats and rules

Quickplay, Sprint, Championship, Formula, Pick & Ban, Knockout, Time Attack and Bumper Cars are only
starting points: every format is a set of the same rules (`rules.ts`), and the organizer can change
each one on its own on the cup panel's setup page. Players see the same rules read-only. Mid-cup,
the safe ones stay editable: break, finish window, late joiners, free camera, next track, ready ends
warm-up, countdown, choosing time, skip votes, the points cap, and how the cup is won (points, rounds, knockout, the
finalist rule, rounds, knocked out per round). Rounds never go below the rounds played plus one; leaving knockout
brings the knocked-out racers back; a Build Off's rounds show Auto until its tracks are built. The cap never goes to a total a
racer already has (`pts >= target` takes the cup), so both the box's floor and `Organizer.adjust`
hold it at `leaderPoints(s) + 1`.

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
  the round when someone already finished).
- **Where the tracks come from** is picked before anything else: the Competitions menu's **Tracks** row (Game
  maps, Custom tracks, Build Off; `Source` in hub.ts, remembered in `nsws-sc-host`) and, once the room is open, the
  **Tracks** section at the top of the Cup tab (`Panel.#sourceSection`: Game maps, Maps + custom, Custom only; a Build
  Off has no button there, it shows as "Build Off" and in the lobby any of the three turns it off). Picking a format
  keeps it (`#apply`); only the Build Off format turns building on. For Custom tracks the menu
  takes tracks before the room opens (My Tracks or pasted, kept in page memory), they go in through `HostPlan.tracks`
  -> `App.#preload`, and the lobby is the first ordinary one. Without maps of their own such cups still need a lobby
  track, so their pool is the main tracks. The proxy keeps only the format text of a cup's status, so the organizer
  reports where its tracks come from as a suffix (`quickplay+custom`, `+mix`, `+build`; `cupFormat` in hub.ts)
  for the join card and the open cups list.
- **Custom tracks** (`customTracks` / `customOnly`): **Who adds tracks** (`customPick`): the organizer only, or everyone, each up to
  **Tracks per player** (`customLimit`, 1-10, default 5; the organizer has no limit); 30 in all. The Cup tab's Tracks section
  (and the Tracks tab) takes **Add from My Tracks** (`__nswsTracks.pick`, hidden without the library), a pasted stock or
  Better Editor code, or an NSWS pack code or link (expanded by `__nswsTracks.importText`); Start says why it can't go
  while a custom-only cup has no track. Each upload goes
  `App.uploadTrack` -> `trk` parts of 100k characters (with its mode `m`) -> `Organizer.addTrack`, which checks the
  rules again and keeps the uploader (`by`, `bn`) and mode. Only the organizer's page keeps the codes; the game sends
  the track to everyone when its round loads. The round's track ref carries `mode` (rocket/royale), and every page
  calls `__nswsTracks.registerModes` for it before the track loads (the organizer in `#load`, others in `App.#apply`).
  The organizer removes any upload, a player their own. Rounds on uploaded tracks never upload PBs and have no world record.
- **Casual** (`casual`; the hub's Mode row, Competitive / Casual, and the Mode section of the lobby): no clock, no
  points, no winner. `cleanRules` turns a casual cup into endless time attack, one round per track, skip votes and late
  joiners on. `#limitMs` is null, so a track ends only when over half the racers vote for a new one or the organizer
  presses New track (`#casualNext`: end the round now, show everyone's best time, then the next track by the Next track
  rule or the built playlist). `#seatCasual` puts newcomers, returning racers and Watch -> Race switches on the track
  at once. `closeRound` scores nothing; End session goes to a "Thanks for driving!" screen with no podium. Works with
  any track source, Build Off included (format `casual`, list text `casual+build`).
- **Build Off** (`build`, minutes, 0 = off; the Build Off format starts at 8, rounds mode, 2 per track): Start opens
  the `build` phase (`state.build.until`). Every human racer's page (and the organizer's) opens the editor
  (`mod/nsws_editor.js`) on a new track with the cup's own bar in place of the editor's (`BuildDesk`, build.ts, through
  `__nswsEditor.current/fresh/cup/note`): Back (or Esc) to the Cup tab, the cup name and phase, the clock, the track
  modes, **Send to the cup**, who has sent a track, the organizer's +2 min / End building now, and Leave (press twice).
  The cup layer is hidden while the editor covers the screen, so BuildDesk's notes go to the editor's note line then. A racer's new send
  replaces the one before (`addTrack` while building). When time is up, or everyone has sent one, `closing` gives 12 s
  (plus up to 20 s for uploads still arriving): pages send whatever is open in their editor unless it is unchanged or
  still the blank track it started with, and close it. The cup then plays the built tracks in a random order
  (`playlist`), a rounds cup lasting exactly tracks x rounds per track; with nothing built it goes back to the lobby.
  `state.built` marks a cup whose tracks are built: Race again races them again, Race again on new tracks builds anew.
  Outside the build phase only the organizer adds tracks. The organizer has **+2 min** and **End building now**.
- **Watching builders** (Build Off): anyone not building, a racer once the cup has their track, and the organizer
  (`mayWatch` in host.ts, `canWatch` in build.ts) get **Watch** beside every other builder in the Cup tab's build
  list, and can click a name in the editor's cup bar. The editor then shows that builder's track as it is now, their
  camera (eased, ~1 s behind; moving your own camera stops following until **Follow their camera**) and the block in
  their hand at the tile they point at; ◀ ▶ go to the next builder and **Back to my track** ends it. The watcher's
  own track and undo history wait untouched in Better Editor (`nsws_watch.js`, bridge 8): each new copy only changes
  the parts that differ (no reload, no unsaved mark), anything the watcher edits meanwhile is undone on the next sync,
  and the bridge answers `current` and autosave with the watcher's own track the whole time, so time up, Send and the
  finish guard never see the watched one (time up stops watching first anyway). A page tells the organizer whom it
  watches with the usual `act watch` (the state goes out at once during build time); a builder's page sends its track
  (`bs`, parts like `trk`, every 2 s and only when it changed) and its camera plus hand (`bc`, twice a second when
  they change) only while someone watches it, and the organizer keeps the latest of each for new watchers and passes
  them on. An editor older than bridge 8 says it needs a reload.
- **Saving tracks:** every uploaded track has **Save** (Tracks tab, and a list on the podium's Cup tab, raced ones first
  from `state.played`; the podium has **Save tracks**). Only the organizer keeps codes, so a page asks for one
  (`act code` -> `code` parts like `trk`, an empty answer for no) one at a time, 1.6 s apart (the organizer answers
  each player once per 1.5 s), and adds it with `__nswsTracks.add(code, {source: 'cup'})`. Tracks already in My Tracks
  show Saved.
- **Rounds:** one run (time limit auto/fixed/off, auto = 3x the best known time from the world record
  or the cup; finish window after the first finish) or time attack (its length); countdown; break.
- **Warm-up:** off, a track's first visit, or every new track; fixed length, or the world record times
  a multiplier with a minimum; optionally ended when every racer is ready.
- **Players:** late joiners, spectator free camera, bumper cars, PB uploads (straight onto the leaderboards, like a PB set outside a cup).
- **Presets:** save, copy as text, import from text. Presets saved by the old cup mode (PolyCup) are
  imported once and translated.

PB and WR badges mark finishes that beat the racer's own best or the track's world record (never in
bumper cars). Notices call out photo finishes, lead changes, new finalists, match points and the
final round. The organizer is warned (privately) when a racer sends a run identical to an earlier one.

## Bots

The setup page's **Bots** section, the first of the rules, has a count (Off, 1-8, `MAX_BOTS`) that puts
computer racers on the grid and **Bot skill** for how good they are: Easy, Medium, Hard, Expert, Mixed (a
quarter each of easy, medium, hard and expert), or Match the field (after every round each bot's skill moves toward the
humans' median time). Every bot is the default car with eight-sided wheels (`VisualCar.lowPolyWheels`),
686 triangles against the default car's 3,102 and up to 117,444 for the F1 body, in its own colours and
pattern (`botStyle`, from its name), and like every other car that isn't yours it casts no shadow and gets
none of PolyFX's lights, shine or reflections (`VisualCar.ghostLook`). Other racers and bots get the replay
ghosts' level of detail (`__nswsGhostLod` with `detailOnly`, in `mod/nsws_cinematic.js`): culled off screen
(the game drew every car mesh, ~20 draw calls a car, even behind the camera) and drawn simpler as they get
small (one material per wheel, then for the body, then no wheels), while the cup still decides whether they
show and sound. A bot's pattern texture is 512 px instead of 2048 (~21 MB of GPU memory each with
mipmaps), cars with the same pattern share one, and only the two bots nearest the camera within 60 m make
engine sounds. Measured on a racing guest with 8 bots on Anubis, CPU slowed 4x, same race in alternating
1 s blocks: 12.9 to 8.1 ms of frame work and 258 to 104 draw calls; every bot on screen was still drawn
(`cup-test-tools/cdp/sc_lodab.mjs`, `sc_cullcheck.mjs`). Other racers and bots are never faded
out near your car (replay ghosts still are), so they stand on the grid in the countdown and show up at once
after a respawn. A cup with only bots racing keeps going while someone watches (the organizer's page in
front, or another person in the cup), and pauses before the next round once nobody does. Skill is how well a bot drives: how close to the reference's speed it takes corners,
how much room it leaves walls and edges, how often it slips up, and whether it follows drifts. Easy is skill
0.12-0.25, Medium 0.5-0.62, Hard 0.72-0.82; Mixed is a quarter of each tier, expert included. Experts never slip up, leave walls no
margin, weave least, and take their hints from the three fastest runs. Expert is
skill 1. Bots are ordinary
players with `Player.bot` (skill and car style) and negative car ids (`botPid`), so the board, results,
standings, knockouts, the director camera and Follow all treat them like racers, with a BOT tag. They
never vote, ban, pick, ready up or keep a round waiting, their finishes don't start the finish window,
and a joining human takes a bot's place on a full grid.

Bots in bumper cups (`bumper` jobs): a bot is still planned on the organizer's page, but only up to 2 s ahead of
the race clock, with retries until 0.7 s ahead, and pages get its frames only 0.4 s past the race clock
(`Planner.showBy`, `commitAll`, short chunks), so the organizer hands them over every tick (100 ms), not every
500 ms (frames that came in bursts every 600 ms had every bot standing still 300-400 ms out of 600). Every racing page puts the bots into its own car's collision
step (`native.botKeys`: the pose drawn now and the next keyframes), so a page sees both sides of a hit
between its car and a bot: its own half as with any car, and the bot's half sent as a `bump` with the frame
it happened on (the sim worker reports `at` on the hit car's clock). The organizer passes it to the bot's
worker (`{b:'bump'}`); `Planner.bump` restores a snapshot from before that frame, drives the bot's own keys
up to it, adds the velocity change there (`Job.kicks`, applied again on every replay) and plans on, never
going back before a hit. Its frames from the hit on go out again in a chunk of their own, which pages take as
replacing everything from its first frame (`BotTimeline.push`); the frames it drives again before the hit are
the ones pages have and aren't sent twice (`Job.sameUntil`: it used to send the whole run again from the
start-line snapshot, and the bot stood still on every page until that caught up). On the page whose car hit
it, the bot is drawn pushed at once (`BotView.nudge`, 400 ms at most) until its new frames come; on every page
a replacement that moves what was already drawn eases in over ~60 ms (up to 5 m; more jumps). A pushed run
never becomes a bot's best run. A respawn within 5 s of a hit is the hit's doing, so it doesn't count towards
starting the run over (`Planner.hitRespawnsFree`, `hitFailMs`; more than 6 respawns a run, or 3 at one
checkpoint, send a bot back to the start line). Lab `botlab/t52_restarts.mjs` (12 CTs, 3 skills, `HITS=1 GAP=6000`:
a sideways hit every 6-10 s): restarts 36 -> 24 in 36 runs, mid-race ones 18 -> 10; the rest are before the first
checkpoint, where the game's reset is a restart (mostly weak bots, and Winterfell, 7 s to its first). Without
hits, 3 (normal cup) and 6 (bumper pacing) in the same 36. Lab: `botlab/t43_bump.mjs`; browser: `cdp/sc_botbump.mjs`, `cdp/sc_bumplab.mjs`
(bot freezes, hits and pushes on both pages; `RAM=1` for a rear-end between the two players).

Hits (the sim worker's collision step): for 2 s after a car spawns (the start, a restart or a respawn: its own
clock under 2 s, or a jump of over 5 m or a reset this page saw) it can't hit or be hit, and a pair still
overlapping after that passes through until it has separated. A pair that hit doesn't hit again for 250 ms
(it is pushed apart meanwhile), so pushing a car is a run of small bumps instead of driving through it. Each
page bounces its own car and sends the other car its half; when both pages felt the same hit (within 300 ms,
`messageType: 13` carries who sent it), each car takes it once. A car that runs into several at once (a pile
of them on one spot) bounces once a frame, off the first, and each of them still gets its push.

Bots hit each other too (`bots/clash.ts`): the organizer's page checks every pair of bots in their keyframes as
they come in (a moment ahead of the race clock, every 10 ms, between keyframes), with the sim worker's hull
boxes and bounce (equal masses, restitution 0.25, a little friction), and sends each bot its half as a hit at
that frame (`BotManager.bump`, as a player's hit). The same 2 s after a spawn, passing through until apart and
250 ms between a pair's hits; a bot that was hit is checked only up to the hit until its planner sends its
frames from there again (1 s at most).

In a bumper cup's race every car that spawned less than 2 s ago pulses blue on every page, spectators' too
(`native.bumperLook`; its own clock under 2 s, or a jump of over 5 m or a reset seen on that page; `cupPulse` on
the car: a blue emissive, the brake light left alone).

Custom tracks get the top runs of their own board like any other track (Kodub keeps a board for every
track id), as well as the organizer's PB and runs finished in the cup. When bots still sit a track out,
the note says why (no run to follow and no route found, or none of the runs replay).

How a bot drives (all on the organizer's page, `src/bots/worker`, built to `mod/cuppa_bots.js`):
- Workers: 1-3 copies of the game's own `simulation_worker.bundle.js`, named `nsws-cuppa-bots`, which
  then load `mod/cuppa_bots.js` and drive cars through the internals the worker exposes
  (`self.__nswsSimInternals`). It is the game's exact physics.
- References: the track's top 8 board runs (`native.boardRuns`, one leaderboard
  and one recordings request per track, cached a day in `nsws-cuppa-refs:<id>`), the organizer's own
  PB, and the cup's best checked runs on that track. Each is replayed once and kept frame by frame. On
  the week in progress the proxy hides other players' runs, so unless the owner organizes, bots there
  follow the organizer's PB and the cup's own runs (from the second round on the track).
- With nothing to follow, `explore.ts` maps the drivable surfaces with rays, connects them (ramps,
  ledges, short jumps), and runs A* through the checkpoints to the finish. That works on ordinary
  roads; tracks built on walls, loops or long jumps it can't find a way through, and the bots then sit
  the track out.
- Rocket League tracks (week 11): keys are 16 bits, the game's RL keys (jump, boost, rolls, nose) above the five
  driving bits (`Keys.rocket`). References keep them and are replayed with their recording's physics version
  (`Reference.version`, also used when a bot starts over on a record's keys); the driver presses the reference's RL keys
  where it is on the reference (no boost where it must slow); the input search also moves jump and boost presses.
  Keyframes carry the boost / flip effect bits only when they change (`X_ROCKET`, chunk version 2; chunks without
  them stay version 1), so pages draw bots' flames. Lab `botlab/t60_rocket.mjs`: bots match a boosting reference
  (13.93 s) where they drove 18.68 s without its RL keys.
- The driver (`driver.ts`) copies the reference's keys exactly while it is on the reference's state
  (the strongest bots replay the record until they leave it), otherwise follows the reference's steering
  input with lateral and heading correction, and caps speed from the reference's (times `pace` in corners
  and braking zones, never before a jump or in the fast run-up to a long flight). Rays measure the room left and right of every reference
  (`clearance.ts`) and weaker bots keep a margin from walls and edges where the record shaves them.
- The planner (`planner.ts`) runs every bot of a worker in 200 ms ticks and keeps a copy of the whole
  physics heap at tick boundaries (exact: all physics state lives in the wasm's memory). A bot that
  leaves its line, falls, spins, wrecks, gets stuck or misses a checkpoint is taken back a few ticks
  (the other bots replay their logged keys) and tries again with other settings: slower, or faster when
  it failed for lack of speed or at a jump, on grip instead of copying a drift, offset, and on another
  player's line (only one that passes close by), and at a jump some tries fly it on the reference's own
  keys from before the takeoff. When it keeps failing it does what a player would: respawn at its last
  checkpoint, or restart before the first one. A respawn that gets it nowhere (failing again before the
  next checkpoint, or too slow there for what comes next) goes the same way every time, so then it starts
  over and drives the keys of the slowest recorded run that still finishes before the round ends, a sure
  but late finish; with no recorded run (an explored route) it starts its own run over. Careless bots
  also make and keep the odd mistake.
- Bots don't DNF. One planned too little ahead at GO, or whose planning falls behind the race clock,
  keeps racing: pages draw it from where its plan has got to, its result stands, and within 2.5 s of the
  race clock its planner stops retrying failures until it is ahead again. Only the round's time limit (as
  for players) or a planner worker that dies can end a bot's round early.
- Every bot follows its own top run (`Persona.copy`, fastest first: experts, then the rest by skill) while
  there are enough, and has its own seed every round (the cup, the round and its name). Every run, and the
  rest of a run after a respawn, drives a little differently from that seed: two slow weaves across the line (wider for weaker bots, kept off walls, faded out in a
  jump's run-up) and corner pace that swings a few percent. About every 12 s a bot also gets a small input
  it didn't choose (a 40-150 ms nudge of the wheel or lift of the throttle, never just before a jump):
  sometimes that finds a better line, sometimes it costs a little. Off the start each bot also takes its own
  lane (up to about 3 units either side of its line, by its dealt run, kept off walls and out of a jump's
  run-up, faded out by 220 units in), so a grid of bots doesn't leave in single file. Sky Bound, 6 bots: at
  3 s they were spread from 1.9 left to 3.4 right of the record's line, against ±0.4 before.
- Past the finish a bot brakes and, like a ghost, leaves the track 0.4 s later (scenery past a finish,
  like chezbug's, would otherwise wreck it in front of everyone).
- Every bot drives its hint run (a top run: the fastest ones go to experts, by name, so the same one every
  round) its own way (`notes.ts`): the driver follows its line and speeds, but how the bot drives each
  one-second section of it is in the bot's notes: speed against the hint's (-4% to +6%), how far beside
  its line (up to 1.5 units, kept off walls and out of a jump's run-up) and how early it turns in. A new
  bot starts from rules hashed from its name; every race run drives each section a little differently.
- After every run a bot goes over it (`Planner.#think`), like a player thinking back on a run: where the
  run lost most against its hint, it goes back to the exact physics state where that section began and
  tries other ways through it, each first driven only to where the section three on begins and scored
  there against its run (time, less 10 ms per km/h it carries); the best is driven on to the finish with
  no slips, and only if it finishes sooner does it become the bot's run (`BotPlan`: its keys, notes and
  section times). The ways: a little faster, another line, another turn-in, now and then the hint run's own
  inputs there, edits of its own keys as a TAS runner makes them (one brake or lift there shortened at
  either end or left out, or a lift traded for a short brake and throttle for the rest), and, where the hint
  slides, the stretch on grip. Sections where nothing tried has helped are picked less often until one does,
  and the learning worker keeps snapshots at section starts within a go (each try starts from one instead of
  replaying the run from the start; about a fifth more tries a second, the same runs). The last two come from Arx Lucida's board: its TAS (23.388) and its next-best
  run (23.429) beat the record (23.690) by coasting about half as long, braking briefly instead, and taking
  the record's slides at 5.5 s and 12 s on grip (`botlab/t49_compare.mjs` puts two runs side by side). A run
  that drove most of the way on another player's line never becomes a bot's run: it has no sections of the
  hint to go over, so it was replayed unchanged every round. (Going back to its own line after the place it
  failed was tried: on Arx Lucida's test build the chaser then kept a 31.3 s run, so it isn't done; there, following
  the TAS, it needs another line at the 17 s hop on every run and so keeps no run of its own.) Experts may go up to 12% faster than their hint and 3 units beside its line
  (kept off walls): their record is a safety net (its line, where it braked, its jump run-ups), not a
  ceiling, and nothing they try is kept unless a whole run on the game's physics proved it faster, so they
  never crash on what they learned. In time attack this happens
  before every next run (up to 3 s, less as planning gets within 8 s of the race clock); in rounds when
  the bot's run is planned, and again (up to 20 s a bot) while the planner has nothing else to do. Where the
  organizer's page has a learning worker (6+ cores, 8 GB), it also goes over every expert's best run all
  cup long, 1.5 s at a time at up to half a core (`Learner` polish), and each faster run it proves reaches
  that bot's planner for its next run (`{b:'plan'}`). Lab (`botlab/t37_polish.mjs`): a Solaris expert's run
  28.62 -> 27.73 s in a minute of that (record 27.22). Experts
  then drive their best run exactly as it is, so an expert never drives slower than its best; the others
  drive the notes from it with their own slips. Runs stay on the organizer's page for the session; notes
  are kept per track, bot name and hint run in localStorage (`nsws-cuppa-notes:<id>`, 24 tracks).
- Practice makes a bot better on a track: after r runs there (rounds before, then every attempt in time
  attack) it has closed 40% x (1 - e^(-r/5)) of its gap to an expert's pace and slips that much less. The
  first run is as before.
- Retries after a failure (`Planner.#recover`): a retry that fails exactly as the one before (same kind,
  within 8 ms) started past the point where the run was lost, so it doesn't count as a try and the next one
  starts further back (0.2 s more each time, replaying the bot's own keys when no snapshot is that old), or,
  when it can't go further back, tries another setting from there. Before, 68% of all failures were such
  repeats, bots retried the same place up to 26 times and gave up. 8 community tracks, 12 bots each (expert
  and 0.7, 6 seeds, `botlab/t36_retries.mjs`): runs that only finished by replaying a recording 29 -> 3 of 96,
  respawns 43 -> 3, own driving +11.7% -> +7.6% against the record; planning costs ~1.7 times as much.
- Every run of a time attack starts on the bot's own hint again (a retry may have put it on another player's
  line), and the fastest run becomes its best run whichever line it ended on.
- In time attack, once a bot has a time, a run that goes wrong (a wreck, a fall it can't save) or falls
  far behind its best at the same point (1.5 s or 8%) is started over, like a player would. In a one-run
  round a wreck that leaves the car crawling (under half the hint's speed there) respawns at the checkpoint.
- Lab (`botlab/t27_ta.mjs`, 5 minutes of time attack, one bot each): Anubis (record 28.592) expert 28.65 ->
  28.588, skill 0.8 32.43 -> 29.73, 0.55 30.80 -> 30.25, 0.2 32.67 -> 30.91; experts on Solaris (27.22)
  28.79 -> 28.02 and Natsu (26.04) 27.77 -> 26.35. Rounds (`t29_rounds.mjs`): Anubis expert 28.86, 28.69,
  28.68, 28.62 over four rounds.
- The record chaser (`Persona.wr`, "World record bot"): only when the site owner organizes and switches it on
  (a switch in the Bots rules shown only on their page after the owner check, off at the start of every cup and never a
  cup rule, so no one else sees it), the real expert first by name (never a secret expert) goes after the
  fastest run. It starts as that run's own inputs (so its first round is the
  record's time) and goes over them as a TAS runner would (`Planner.#brute`): one edit in a window of 0.06-0.6 s
  (a press or release of one key moved up to 20 frames, a tap added or taken away, a stretch of a key held or
  let go made longer or shorter by up to a third, or taken out), the rest of its inputs as they were, the
  game's physics to the finish. It keeps an edit that finishes sooner, and one that finishes as soon but
  leaves its inputs further from the record's, so its run drifts away from the record without getting
  slower. A try is given up once it is 30 frames behind its run or off it by 30 units, and most tries that
  come back onto its run exactly are too (they can only finish when it does). It gets half the learning
  worker's turns and three times the idle pondering; the learning worker keeps up to six snapshots along the
  run for it (race workers only the start line's). Its search is plain physics, so a try costs a fraction
  of driving one (3-8 a second on a desktop). A quarter of its goes over its run are its own way instead
  (`Planner.ownShare`), which finds more where the record left time (Anubis; and Arx Lucida's TAS below).
  Lab (`botlab/t50_wrbench.mjs`, 13 tracks, 320 tries each): 13 of 13 under the record (mean -0.04%),
  every run replaying exactly from its keys; against Arx Lucida's TAS (test build "JMAI - Arx Lucida",
  23.388) 23.382, its inputs 7.9% different. Its line stays close to the record's (0.02-0.34 units on average), since it is the record's run
  improved, not a run of its own; driving its own way on the same tracks and tries it was 3.65% slower
  on average (median 0.77%; `Planner.seedRecord` off). Where the record doesn't replay on the track a cup plans on, it drives its own
  way as before.
- Bots learn from each other (`worker/shared.ts`, `Tip`): when a bot gets past a failure, how its retry did
  it (slower, another line) goes out with where it failed, and when going over its run finds a faster way
  through a section, that way goes out with where the section starts. Every worker on the track gets every
  tip (`{b:'tip'}` to the manager, `{b:'tips'}` to the others, kept for the session). Another bot only ever
  tries one: a fix is its first retry when it fails within 20 units of where the other bot did (before the
  same checkpoint), and a win is one of the ways it tries when going over the section of its own run where
  the win starts: that bot's pace and turn-in there, with the taker's own line and half a practice try's
  variety of its own, kept only if its whole run finishes sooner (such sections are gone over more often;
  each bot tries each win once, and only wins of 20 ms or more: most don't carry over to another bot's
  run, and trying them all took most of its tries on Arx Lucida).
  Everything else each bot tries is still its own, so they don't end up on the same run (Winterfell lab
  cup: any two experts' best runs held the same keys on 36-59% of frames). The record chaser takes
  others' fixes when a retry needs one; its own search is on its inputs and shares nothing.
- Every expert is skill 1 and as able as the others; what sets them apart is the record each one trains on
  (its own, fastest first): its line and way of driving. An expert on a slower record may drive up to 8%
  faster than that record (it starts halfway there and goes over its runs for the rest).
- When a retry gets a bot through a place it failed (a wreck, a fall, a spin, or a wall it bled 55 km/h
  against over 0.3 s where the record kept its speed), what the retry changed (slower, another line) goes
  into the bot's notes for those sections, so its next runs drive them that way (down to -15% pace; going
  over its runs speeds them up again where that was too careful). A failure its own slip caused teaches it
  nothing. Arx Lucida, 4 minutes of time attack, four bots: visible crashes 15 -> 3, none twice in one place.
- Every expert also searches its first run as the planner goes: before
  each section it tries four other ways through it from the same exact physics state and drives on with
  the fastest (time, less 10 ms per km/h it leaves with). It costs 4-5 times that bot's planning, so it
  only runs before GO or while planning is more than 8 s ahead of the race clock (`Planner.roomy`).
- The driver's speed plan stops at a respawn the reference made (tracks built around respawning, like
  Thank u next): past it the reference stands at the gate, which once made bots brake before the checkpoint.
  A car at full lock running wide only slows down when it is running out of room outside (under 2.5
  units): it used to brake hard at 0.75 units off the line, for seconds (Solaris 30.92 -> 28.83 s, Natsu
  28.84 -> 27.82 s, Winterfell 45.34 -> 44.53 s on an expert's first run; `botlab/t28_brakes.mjs`).
- Drifts: a bot more than ~4% slower than its record there used to drop the record's brake into a slide
  (a slower car needs no slide, it was assumed), so where the record rotates the car on the brake it stayed
  on grip at full lock and ran wide. Now, at full lock in the record's turn with the car pointing outside
  where the record's car points, it keeps the record's brake (0.05 rad out) or taps the brake itself where
  the record is sliding (0.15 rad out). 8 drift-heavy community tracks, 8 bots each (`t36_retries.mjs`):
  failures 1866 -> 1584, crashes left in the run 52 -> 43, respawns 28 -> 20, own pace +9.9% -> +9.0%
  behind the record, though 4 more runs (of 64) ended on a recording's keys, most on Re Akina. Most drift
  failures are not the slide itself (`t45_driftdrill.mjs`: the record's keys up to just before each slide,
  then the driver, from four entry speeds, all 71 tracks): handed over 0.8 s before, it got through 168 of
  188 tries; 3 s before, 154 of 180, and most of the rest clipped a wall the record passes within a few
  tenths of a unit. A car running wide at full lock now only lifts, never brakes: braking there threw it
  sideways into the outside wall (Solaris, 13 s, 246 -> 204 km/h). Same 8 tracks: failures 1853 -> 1817,
  runs ending on a recording 13 -> 11, crashes left in the run 52 -> 47, pace the same, planning 14% less.
- Bots have a neural network (`brain.ts`, 24 inputs, two hidden layers of 16, 706 weights) on top of the
  driver: each frame it reads the car (speed, steering, slip, how far off the line and how it points), the
  reference ahead (speed, steering input and curve 0.1-1 s on, a jump coming) and the room to the walls,
  and corrects the steering target and the speed limit (at most 0.25 input units and 6%). Its output
  layer starts at zero, so untrained it changes nothing. It learns by evolution strategies, a kind of
  reinforcement learning, on the game's own physics (`learn.ts`): a test plans one bot's whole run with
  the planner (retries, respawns, restarts and all) and costs the finish time plus 1 s for every wreck
  the bot had to live with; a random change to the weights and its opposite are tested on the same two
  fresh seeds as the current weights, and one is kept only if it is no worse on either seed and better
  overall. So it only ever keeps what drove better on its test.
- The learning runs during a cup on the organizer's page, in one more worker (only with at least 6 cores
  and 8 GB, at most half that worker's time), per track and per skill group (under 0.45, to 0.7, to
  0.9, to 0.95). It keeps going through rounds and breaks; bots take up the best
  weights at the next round on the track, and in time attack at their next run. What they learned is kept
  per track in localStorage (`nsws-cuppa-brain:<id>`, 40 tracks), so the next cup on that track starts
  from there. Measured in the lab (`botlab/t24_learn.mjs`, 15 minutes, then six unseen seeds): chezbug at
  0.6 from 22.99 to 21.13 s, Sky Bound at 0.8 from 42.51 to 41.47 s (faster on every seed), Anubis at 0.35
  from 32.14 to 31.71 s; Solaris at 0.6 was faster on four seeds but wrecked on two others (32.94 to
  33.72 s), so what it keeps drove better on its tests, not yet on every run. There are no offline-trained starting weights yet (`BASE_BRAIN` is empty):
  a lab run across many tracks (`t23_train.mjs`) was too slow and too noisy to beat no network.
- On a track of more than 4000 parts, every bot's physics world holds only the parts within 60 units of
  a reference plus every checkpoint, start and finish (`routeTrack`): a car never gets that far from one
  without being taken back. NyQuill's 63,183 parts become 3,298, and four bots take 51 MB of physics
  memory instead of 126 MB. The snapshot ring keeps fewer copies when the heap is big (320 MB at most).
  Runs copied from a recording use the whole track, where they were driven.

Bots reach pages as their car states, not their inputs, so pages never simulate them: keyframes every
50 ms plus every checkpoint, finish, hit and respawn (`codec.ts`), deflated, in `{k:'bots'}` chunks of
about 2 s of driving. Planning runs ahead of the race (GO waits, up to 15 s, until every bot has 6 s
planned), and a frame becomes final 3 s after it is planned, so every page has a bot's states well
before it needs them and draws it at exactly `cupNow - startAt` (`bots/view.ts`, `timeline.ts`:
Hermite positions, slerped rotation, the game's `lerpCarState` for the rest). Live timing, splits and
results come from the same states: the organizer records a bot's finish when the race clock reaches it.
Pages that join late get every chunk of the round so far. Bots and other racers leave skid marks like the
player's car, also while the race skips drawing them (30 m+ away and off screen: `VisualCar.leaveMarks`),
and a bot's marks stay on the road after it finishes and leaves the track (`visibility`'s `marks`). Low
performance mode still leaves other cars' marks out.

Cost: about 330-400 bytes a second per bot per page after deflate, riding the organizer's normal
batches, and no Worker change. Measured in a browser cup (organizer and one racer, Sky Bound, 5 bots
against none): the organizer sent 3.46 frames a second while racing against 3.42 without bots, and the
bots' first chunks added about two frames in the countdown; its upload went from 2.7 to 4.1 KB/s. The
only Worker requests are the leaderboard and recordings reads for a track's references, once a day.

Pages get states rather than inputs on purpose. A bot's run does replay bit for bit from its keys alone
(`botlab/t20_keys.mjs`: 10,599 keyframes over 8 tracks, NyQuill included, all identical), and keys would
be 55-90 bytes a second per bot instead of 330-400 (bots tap the steering keys 300-500 times a second).
But then every page would simulate every bot: 11-20 us per bot per 1 ms frame on a fast desktop,
several times that on the weak devices week 10 already strains, plus a physics world per bot. Billed
frames would stay the same, since bytes aren't billed and the chunks already ride batches that go anyway.

Planning 3-4 bots runs at 10-30 times real time on a desktop. On the 71 community tracks (4 bots per
track following the world record and three more board runs, `cup-test-tools/botlab`), 283 of 284 runs
finished, a median 2.7% behind the record at skill 0.97, 5.8% at 0.85, 10.4% at 0.6 and 19.1% at 0.3. About one
run in ten, mostly weak bots on tracks with long fast flights, only finished by starting over (1.5-2.5 times
the record); keeping the record's speed through the run-up to a long flight (`Reference.runUp`) came after
that benchmark and fixed Zenith's ending for a 0.6 bot.
On the tracks with long fast flights (Zenith, Frozen in Time, Flying Dreams) most bots below expert still
lose too much speed through the lap to make the last flights, and finish only by starting over.
Tests: `cup-test-tools/cdp/sc_bots.mjs` (a race with bots on the test track), `sc_botwr.mjs <ct>` (a
Kodub community track with its stored WR served through a faked leaderboard), `sc_botweek.mjs` (the same
for an NSWS week track from a runs file), `sc_botwatch.mjs` (a spectator following bots),
`sc_botcost.mjs` (frames and bytes each page sends, per phase, while one of those runs),
`sc_botsmooth.mjs` (frame times, bot stutter and sudden slow-downs on each page), `sc_botprof.mjs` (CPU
profile with the CPU slowed down).

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
runs), and every 1 s otherwise. A racer's batch leaves the moment the car state that closes the
pace is queued (the game samples one every 50 ms, so five states every 250 ms while driving), not
on a timer that raced that state (a lost race sent four states a frame and a frame more for no
newer state: 4.35 frames a second in a simulation, now 4.0). A hidden tab keeps the old timing.
The transport re-checks the pace every 100 ms, so a batch queued at the slow pace never holds up a
car that just started. Clicks,
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
Over the mux alone the driving pace still shows as delay (about 0.28 s behind the real car on a
typical connection, Node harness). WebRTC car states (`rtc.js`) cost no requests: the room only sees
the handshake (two messages a pair of pages, ~13 requests for a 16-page cup) and one credentials
call per page. They are paid in TURN traffic instead: about 6 KB/s per pair of pages each way while
both drive (20 full states and 20 poses a second), so roughly 1.4 MB/s for 16 racers (~5 GB an
hour) and 0.3 MB/s for 8. Cloudflare bills TURN at $0.05/GB after a free allowance (1,000 GB a
month, shared with its SFU, when this was written).

A player who closes the tab by accident is offered the cup again from the menu
(`mod/nsws_cup_rejoin.js`, the game's own confirm box): while they are in a cup (not organizing it),
`app.ts` keeps `nsws-sc-rejoin` in localStorage, which leaving on purpose clears; Rejoin connects with
the same identity key, so the organizer gives back the same player, points and results.
