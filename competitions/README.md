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
  (`verifyRun`) and broadcasts the state when it changes. `engine.ts` is its pure tournament logic
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
  chat feed, notices, podium), `panel.ts` (Tab: cup, standings, rounds, players, tracks, rules, chat;
  the Tracks tab lists the cup's whole map pool to everyone, and only the organizer gets Play next),
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
session calls the cup once a frame before drawing (`cupFrameHook`), and just before it moves the other
cars (`cupCarsHook`).

## Formats and rules

Quickplay, Sprint, Championship, Formula, Pick & Ban, Knockout, Time Attack and Bumper Cars are only
starting points: every format is a set of the same rules (`rules.ts`), and the organizer can change
each one on its own on the cup panel's setup page. Players see the same rules read-only. Mid-cup,
the safe ones stay editable: break, finish window, late joiners, free camera, next track, ready ends
warm-up, countdown, choosing time, skip votes and the points cap. The cap never goes to a total a
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
a joining human takes a bot's place on a full grid, and bumper-car cups have no bots (they can't react
to a hit).

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
  inputs there, and edits of its own keys as a TAS runner makes them (one brake or lift there shortened at
  either end or left out). Experts may go up to 12% faster than their hint and 3 units beside its line
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
Pages that join late get every chunk of the round so far.

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
