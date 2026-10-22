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
    cockpit camera, so nothing is streamed. Director (auto), Follow (◀ ▶) or Free camera.
  - `smooth.ts`: draws every other car a little in the past, always between two real states this page
    already has, so nothing is guessed and no car is ever drawn past the newest state its page sent.
    Each car has its own delay: the 98th percentile over the last 10 s of how long after a newest state
    the next states landed, plus about a frame. Its playback runs at most 5% fast or slow to follow that
    delay; when states are late it eases to a stop at the newest one and goes on when they land (after a
    stall of over 0.5 s it jumps on instead), and the delay goes up at once and back down at 100 ms a
    second. Positions follow a curve through the real states (cubic Hermite), rotations slerp, and the
    rest (wheels, suspension, steering, speed) is the game's own interpolation (`lerpCarState`), with
    checkpoints, the finish and crash sounds when the drawn car gets there. A respawn, a lost stretch of
    states, a reset press or the start is never drawn as motion: the car holds, then shows the new place;
    a restart (the game's car reset) ends the old run at once. Timing is this page's own
    `performance.now()`, so clock syncs never move a drawn car (the start stamps `transport.js` adds
    aren't used for drawing). It runs just before the game moves the other cars (`cupCarsHook`), so a
    followed car and its camera use the same state. The game's own remote playback gets no states.
    Node harness at the 200 ms pace (batches of 4-5 states, 1% network stalls): about 0.33 s behind the
    real car on a near connection, 0.46 s on a typical one and 0.9 s on bad Wi-Fi (13, 18 and 34 m at
    150 km/h), drawn within 2 cm (p95) of the real path; not yet measured in browsers. Other cars are
    hidden while results, votes or loading cover the race. Live timing still reads states as they
    arrive. Bumper cars keep the game's own playback: their pages send every 100 ms while driving and
    it draws other cars 0.25 s behind its newest state (about 0.3-0.37 s behind the real car), which
    costs about twice the messages while racing, in bumper cups only.
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
computer racers on the grid and **Bot skill** for how good they are: Easy, Medium, Hard, Expert, Mixed (one
of each from easy to expert), or Match the field (after every round each bot's skill moves toward the
humans' median time). Every bot is the default car with eight-sided wheels (`VisualCar.lowPolyWheels`),
686 triangles against the default car's 3,102 and up to 117,444 for the F1 body, in its own colours and
pattern (`botStyle`, from its name), and like every other car that isn't yours it casts no shadow and gets
none of PolyFX's lights, shine or reflections (`VisualCar.ghostLook`). Other racers and bots are never faded
out near your car (replay ghosts still are), so they stand on the grid in the countdown and show up at once
after a respawn. A cup with only bots racing keeps going while someone watches (the organizer's page in
front, or another person in the cup), and pauses before the next round once nobody does. Skill is how well a bot drives: how close to the reference's speed it takes corners,
how much room it leaves walls and edges, how often it slips up, and whether it follows drifts. Easy is skill
0.12-0.25 (Mixed starts at 0.15), Medium 0.5-0.62, Hard 0.72-0.82. Experts never slip up, leave walls no
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
- Bots of skill 0.95 and up (Expert, and the best of Mixed) drive themselves and learn the track their own
  way (`notes.ts`). Each takes one top run as a hint (the fastest ones, by name, so the same one every
  round): the driver follows its line and speeds, but how the bot drives each
  one-second section of it is in the bot's own notes: speed against the hint's (-4% to +6%), how far beside
  its line (up to 1.5 units, kept off walls and out of a jump's run-up) and how early it turns in. A new
  bot starts from rules hashed from its name, and every race run drives each section a little differently
  from that run's seed, so no two rounds are alike and it's all deterministic.
- The top expert (the one hinted by the fastest run) also searches its own run as the planner goes: before
  each section it tries four other ways through it from the same exact physics state, as in practice
  below, and drives on with the fastest, with no random inputs. The tries come from its round's seed, so
  every round differs. It costs 4-5 times that bot's planning, so it only runs before GO or while planning is
  more than 8 s ahead of the race clock (`Planner.roomy`). Lab, one expert, four seeds each (record, then
  with the search and without): Anubis 28.592 / 28.577 (28.51-28.63) / 28.73; Sky Bound 40.590 / 41.05 /
  41.62; Solaris 27.220 / 28.21 / 32.05; Natsu 26.042 / 26.87 (best 26.21) / 28.29.
- Experts learn in practice, in the learning worker (below), one expert after another: a run where before
  each section of its notes the bot tries four other ways through it, each from the same exact physics state to the end of the next section, and drives on with
  the fastest (time, less 10 ms per km/h it leaves with; a try that goes wrong is out). The notes that run
  ends with then race the old ones on three fresh race runs (with a race's variety and random inputs) and
  are kept only if they are no slower on any of them and 0.03 s faster in all: like the network, an expert
  never keeps what drove worse on its tests, and it can end up faster than its hint. Its next round on the track (in time attack, its next run)
  drives them. Notes are kept per track, bot name and hint run in localStorage (`nsws-cuppa-notes:<id>`,
  24 tracks). Without the learning worker (under 6 cores or 8 GB) experts drive their notes as they are.
  Measured on Anubis (record 28.592 s, `botlab/t25_notes.mjs`, two experts, four race runs each on fixed
  seeds; that run's tests used two fresh runs, now three): before practice 28.78 s (0.19 behind) and 30.86 s
  (on the second-best run, with wrecks); after 12 minutes of practice 29.24 s (two runs at 28.47 and 28.51 s,
  under the record, and one wreck at 30.55 s) and 29.44 s (no more wrecks). So practice makes a struggling
  expert steadier and lets a good one beat its hint, but its runs swing more: it isn't yet faster on average
  than the copied runs experts used to replay (0.1-0.3 s behind).
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
  0.9, to 0.95), and the experts' practice. It keeps going through rounds and breaks; bots take up the best
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
Nothing is guessed (`smooth.ts`), so the driving pace shows as delay: a car is drawn about one batch
interval plus the network's latency and jitter behind the real one (0.33-0.46 s at this pace on near
and typical connections, Node harness). Only a faster driving pace (more messages) or a lower latency
path draws them closer.

A player who closes the tab by accident is offered the cup again from the menu
(`mod/nsws_cup_rejoin.js`, the game's own confirm box): while they are in a cup (not organizing it),
`app.ts` keeps `nsws-sc-rejoin` in localStorage, which leaving on purpose clears; Rejoin connects with
the same identity key, so the organizer gives back the same player, points and results.
