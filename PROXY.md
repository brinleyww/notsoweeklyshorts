# Leaderboard proxy

`vps.kodub.com` only answers requests whose `Origin` header is one of Kodub's
own sites, and it never returns CORS headers, so the browser cannot call it
directly. `proxy/src/worker.js` sits in front of it: it forwards the request
with an accepted `Origin` and returns the response with CORS headers attached.

Leaderboard reads are not passed through untouched. Anything the page receives
can be read in the browser's network panel (disable-devtool is easy to get
around), so everything that has to stay hidden is removed in the Worker,
before it reaches the browser:

- **Banned players** are dropped from every leaderboard, from standings, and
  from the player count. Ranks close up behind them, across pages too.
- **The week in progress** (`CURRENT_WEEK` and later): other players' times,
  recording ids and user ids are never sent. Names and ranks still are. A
  player sees their own time only by sending their `userToken` — the
  `userTokenHash` the game normally sends is public (it is every entry's
  `userId`), so on its own it can't be trusted to mean "me".
- **Opening the proxy in a tab** (for example from the network panel), or
  calling it from any other site, gets `403`.

## Why it is a separate Worker

The site is served by **GitHub Pages**, which serves static files only and
cannot run a Worker. So the proxy deploys on its own Cloudflare hostname and the
site calls it cross-origin.

    brinleyww.github.io/notsoweeklyshorts/   ->  static site (GitHub Pages)
    notweeklyshorts.github.io/               ->  the same site, from a fork
    <worker>.workers.dev/v6/*               ->  this proxy  ->  vps.kodub.com

Every address the site is served from must be listed in `ALLOWED_ORIGINS`.
The proxy answers any other site with `403`, so a new address's leaderboards
fail to load until it is added and the Worker is deployed.

## Deploy

    cd proxy
    npx wrangler login      # your Cloudflare account
    npx wrangler deploy

Deploy the Worker **before** pushing a site change that relies on it. The
Worker works with the old page; the new page needs the new Worker (the ban
list no longer lives in the page).

Wrangler prints the deployed URL. It goes in `index.html`, **with a trailing
slash** — that is the only place the hostname appears:

    window.__nswsApiBase = "https://pt-leaderboard-proxy.bringleyw.workers.dev/";

## Every new week

When a new week goes live in `main.bundle.js`, set `CURRENT_WEEK` in
`proxy/wrangler.toml` to its number and deploy the Worker. Until you do, the
previous week's times stay hidden too.

## Keeping times off Kodub (`TRACK_SALT`)

The track ids are in `main.bundle.js`, and Kodub's API is public: anyone can
put a track id into another proxy (ptproxy.cwcinc.dev still works) and read
every time on it. The Worker can't stop that for runs stored under the real
track id.

So, once the `TRACK_SALT` secret is set, runs on weeks `>= HIDDEN_FROM_WEEK`
are stored on Kodub under a track id derived from that secret, which only the
Worker can work out. Reads show those runs merged with any runs already stored
under the real id, so nothing disappears when you switch it on.

    cd proxy
    npx wrangler secret put TRACK_SALT     # paste a long random string

- Runs set before the salt was switched on are still readable on Kodub under
  the real id. Only runs from then on are hidden.
- Never change `TRACK_SALT`, raise `HIDDEN_FROM_WEEK` or renumber a week once
  runs exist. Runs stored under the old ids would stop showing. Keep a copy of
  the salt somewhere safe.
- Hidden runs don't show on Kodub's own leaderboards (or through any other
  proxy), and Kodub's verifiers can't reach them, so they stay "pending". Your
  site shows unverified runs anyway, so nothing changes there.

## Configuration

`proxy/wrangler.toml`, under `[vars]`:

| Var                | Purpose                                                        |
| ------------------ | -------------------------------------------------------------- |
| `UPSTREAM`         | Where requests are forwarded (`https://vps.kodub.com`)         |
| `UPSTREAM_ORIGIN`  | The `Origin` value upstream will accept                        |
| `ALLOWED_ORIGINS`  | Sites allowed to call the proxy (`https://` + host, no path)   |
| `BANNED_NICKNAMES` | Removed from leaderboards and standings (not case-sensitive)   |
| `CURRENT_WEEK`     | Week in progress; its runs and later weeks' runs are secret    |
| `PUBLIC_NICKNAMES` | Times left visible during the week (the medals' Author Time)   |
| `HIDDEN_FROM_WEEK` | First week stored under secret track ids (needs `TRACK_SALT`)  |
| `OWNER_KEY_HASHES` | The owner, the only one who gets past any restriction (below) |
| `OWNER_USER_IDS`   | The owner's public userId; their runs always show            |

`PUBLIC_NICKNAMES` has to match `BENCHMARK_NICKNAME` and
`BENCHMARK_NICKNAME_WEEK_OVERRIDES` in `main.bundle.js`, or current-week medals
show "Couldn't check medal".

Vars can also be edited in the Cloudflare dashboard (Worker → Settings →
Variables), but the next `wrangler deploy` puts back what is in the file.

## Owner access

The owner's private token (the "owner key") is the only thing that gets past the
proxy's restrictions, and nobody else gets any exception. With it:

- Every run on the week in progress comes back in full (times and recordings), and
  the page stops showing them as "SECRET".
- The proxy works from any site or tool, and from a tab. The key counts when it is
  the `userToken` of a read or an upload, or when it is added to any request as
  `?nswsOwner=<key>` (removed before anything is sent to Kodub).
- The owner's uploads skip the anti-cheat replay, and runs by the owner's account
  (`OWNER_USER_IDS`) always show, wherever they were uploaded from.
- The traffic dashboard and the anti-cheat controls open.

`OWNER_KEY_HASHES` holds `sha256("nsws-owner:" + token)`, never the token itself. The
plain `sha256(token)` is the public `userId` on every leaderboard entry, so it is
only used to recognise the owner's runs, never as proof of the key. To change the
owner, compute the new hash, put it in `OWNER_KEY_HASHES` and in `OWNER_HASH` in
`mod/nsws_traffic.js`, set `OWNER_USER_IDS` to the new `sha256(token)`, deploy the
Worker, then push the site:

    node -e "console.log(require('crypto').createHash('sha256').update('nsws-owner:' + process.argv[1]).digest('hex'))" <token>

## Site traffic (Race Control)

`mod/nsws_traffic.js` runs on every page. It sends a small "beat" to
`/nsws/beat` when the site opens, every minute while the tab is visible (every
4 minutes in the background), and when the page closes. A beat carries a random
session id, a random visitor id kept in `localStorage` (`nsws_visitor`), the
nickname, what the player is doing, and counts of races, finishes, uploads and
so on. It never carries the account token. The Worker adds a coarse country,
device, system and browser, and stores everything in one SQLite Durable Object,
`TrafficStats` (`proxy/src/traffic.js`). IP addresses are only held in memory to
cap new sessions at 120 per address per hour; they are never stored. The reply to a
beat is `{"online": n}`: how many different visitors have the site open, which the
chat window shows.

`/nsws/stats`, `/nsws/live` and `/nsws/anticheat*` answer only the owner: the request
body must hold the owner key (see "Owner access"). The page checks the same hash
(in `nsws_traffic.js`) before showing the "Race Control" button and loading
`mod/nsws_owner.js`.

On the Workers Free plan each beat is one Worker request and one Durable Object
request, with about two SQLite rows written. That is roughly 1,440 beats a day
for each player who keeps the site open, so the free limits (100,000 requests
and 100,000 rows written a day) cover about 30 players online around the clock.

`proxy/src/worker.js`:

- `ALLOWED_PREFIXES` — only `/v6/` is forwarded, so the Worker cannot be used as
  an open relay to arbitrary hosts.
- `CACHE_TTL` — edge cache for passed-through endpoints (recordings). Leaderboard
  reads are rebuilt per caller and never shared between players; each Worker
  instance keeps the raw boards for 10 seconds.

## Anti-cheat

Every Not So Weekly Shorts board (any request carrying `nswsWeek`) only shows runs
that pass two checks:

- **The run really finishes.** The Worker replays the run's inputs through the
  game's own physics (`proxy/src/sim/`, built from `simulation_worker.bundle.js`,
  the same code Kodub's verifiers run). The car has to pass every checkpoint and
  cross the finish on exactly the frame the run claims. A replay takes about
  0.1-0.3 s.
- **It came through this proxy.** Kodub's API is public, so anyone can upload to
  a track id directly. A run the proxy didn't let through is hidden.

The owner skips both checks (see "Owner access").

How it works (`proxy/src/anticheat.js`):

- **Uploads** are replayed before they are sent on. One that fails gets `422` and
  never reaches Kodub. The game then shows "This run failed the anti-cheat check".
  The same run sent again is refused without replaying it.
- **Runs already on a board** the first time the Worker sees that board after the
  anti-cheat is deployed count as legacy. They stay visible while each one is
  replayed once in the background (a few per second), and any that fail are
  hidden. Everything uploaded later has to come through the proxy.
- Hidden runs are dropped the same way banned players are: ranks close up and the
  player count leaves them out. A player still gets their own entry back, so the
  game doesn't keep uploading it.
- The owner dashboard's **Anti-cheat** tab lists rejected uploads and hidden runs,
  and has an **Allow** button for a run you know is fine.

**Tracks have to be synced.** The Worker can't decrypt the `.track` files, so the
owner's game sends each track's physics data (`window.__nswsTrackCheckData`). That
happens automatically a few seconds after the owner opens the site, for any track
the Worker doesn't have yet. Until a track is synced, its uploads are accepted but
stay hidden until they can be replayed. After changing a track that is already
live, use **Re-send all tracks** on the Anti-cheat tab.

**Rebuilding the physics.** `proxy/src/sim/` is generated; don't edit it by hand. If
the game's simulation ever changes, rebuild it with `node proxy/tools/build-sim.js`.
`init.bin` (the game's physics meshes) only changes with the game's 3D models. To
rebuild it, capture the non-realtime `Init` message the game posts to
`simulation_worker.bundle.js`, save it as JSON (typed arrays as plain arrays), and
pass that file to the build script.

**Why not lock the proxy to one page's path?** The proxy already answers only
`https://brinleyww.github.io` and `https://notweeklyshorts.github.io` (see
`ALLOWED_ORIGINS`), and only their owners can publish pages there. A browser sends
only the site, not the page path, on these requests, so a path check would need the
Referer header. Privacy tools strip that, so real players would be blocked. Nothing
outside a browser has to tell the truth about any header, which is why the checks
above are done on the run itself.

## Chat

`mod/nsws_chat.js` is the universal chat window. It is off until a player turns on
Settings → Chat → "Universal chat" (`_nswsChatEnabled` in `localStorage`). It opens a
WebSocket to `/nsws/chat`, which only the allowed sites can open, and every player shares one
`ChatRoom` Durable Object (`proxy/src/chat.js`, binding `CHAT`, migration `v3`). The room
uses WebSocket hibernation, so idle players cost nothing, and it keeps the last 60 messages.

- **Censoring happens in the Worker** (`proxy/src/chatfilter.js`), on every message and
  nickname, before anything is stored or sent. Swearing is allowed; slurs are replaced with
  `#`. The filter folds text before matching: accents, look-alike letters from other scripts,
  fancy Unicode, leetspeak (`n1gg@`), repeated letters, invisible characters, and letters split
  by spaces or symbols (`n i g g e r`, `f.a.g`). Short words (`coon`, `spic`) only match as
  a word of their own, so `raccoon` and `spice` are left alone. Add words to `STRICT` or `WHOLE`.
- **Limits:** 200 characters, one message a second per player (slow mode; the page holds a
  quick second message and sends it when allowed), no repeats within 20 s, 6 chat connections
  per IP address (only a hash of the address is kept, on the socket).
- **Spam timeouts:** more than 10 messages in 20 s times a player out for 5 s. Each timeout
  after that doubles (10 s, 20 s, ... up to an hour) until they go 10 minutes without one. The
  owner is exempt from slow mode and timeouts.
- **Pings:** `@Name` (after a space or at the start) pings whoever is online under that
  nickname; typing `@` suggests online players. One message pings at most 3 people, a player
  sends at most 6 pings a minute and pings the same person at most once every 15 s. Extra
  `@names` still show but notify nobody, and the sender is told. Only the owner can use
  `@everyone`. A ping never takes focus, opens the window or blocks clicks: the line is
  highlighted, the minimized bar shows a yellow `@` count and glows, a toast that clicks pass
  through appears by the bar, a quiet chime plays (the bell in the title bar turns it off),
  and a background tab's title gets `(@)`. The limits are rebuilt from stored messages when the
  room wakes from hibernation, so waiting doesn't reset them.
- **Who is who:** each player is a hash of their random `nsws_visitor` id, never the account
  token. Anyone can type any nickname, but only the owner's key earns the `OWNER` badge. The
  owner clicks a message to delete it, mute its sender (10 minutes, an hour or a day), or
  delete everything they sent. Name colours come from that hash too (the same for everyone),
  lightened where needed to keep 4.5:1 contrast on the chat background.
- **Emoji:** `:name:` codes (Discord's names, e.g. `:sob:`) are suggested after `:` and two
  letters, and turn into the emoji as you type the closing colon or send. The emoji button
  opens a searchable panel by category. The list is `mod/nsws_emoji.json`, built by
  `proxy/tools/build-emoji.js` from emojibase-data and capped at Emoji 15.0 so phones and PCs
  can draw everything. Windows has no flag emoji, so flags use the bundled
  `mod/TwemojiCountryFlags.woff2` (Twemoji, CC-BY 4.0). The Worker keeps the invisible joiners
  inside emoji like 👨‍💻 but strips them anywhere else.
- **Layout:** messages from one player within 5 minutes share one header (avatar, name, time),
  like Discord; messages of only emoji show large.

## Privacy note

Leaderboard reads for Not So Weekly Shorts tracks, submissions and profile
updates carry a player's `userToken` — an account secret — through this Worker.
Invocation logs are turned off in `wrangler.toml` because they would record
request URLs. Do not enable Logpush with request bodies or query strings for
this Worker, and do not add logging of `request.url`.

## Reverting

`main.bundle.js.bak` is the bundle from before the proxy moved to this Worker.
To go back to the old proxy:

    cp main.bundle.js.bak main.bundle.js

drop the `__nswsApiBase` block from `index.html`, and put back the
`window.__nswsLeaderboardBanlist = [...]` script there — that bundle reads the
ban list from the page. Times are then visible in the network panel again.
