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

- **Firewalls that block WebSockets** (common on school and work networks) still allow plain
  HTTPS requests like the leaderboard's, so the chat falls back to long-polling over HTTPS.
  If two sockets in a row never get going (refused, or not open within 8 s), the page switches
  to `POST /nsws/chat/poll`, which waits up to 20 s for news, and `POST /nsws/chat/send`, which
  carries anything the page would send on the socket. Both go to the same `ChatRoom`, so the two
  kinds of player see and ping each other, and every limit is the same. Bodies are `text/plain`
  so there is no CORS preflight. Each request carries the `nsws_visitor` id (and the owner key)
  because there is no socket to remember them on. The page remembers the fallback for 12 hours
  (`_nswsChatHttpAt`) and starts on HTTPS next time, while quietly opening a test socket; if that
  opens, the next visit tries WebSockets first again. Polls have the same caps as sockets. Pollers keep the room awake (it can't
  hibernate while a poll is waiting), which costs Durable Object duration and two Worker
  requests per poll, about every 20 s per idle polling player.

- **Censoring happens in the Worker** (`proxy/src/chatfilter.js`), on every message and
  nickname, before anything is stored or sent. Swearing is allowed; slurs are replaced with
  `#`. The filter folds text before matching: accents, look-alike letters from other scripts,
  fancy Unicode, leetspeak (`n1gg@`), repeated letters, invisible characters, and letters split
  by spaces or symbols (`n i g g e r`, `f.a.g`). Short words (`coon`, `spic`) only match as
  a word of their own, so `raccoon` and `spice` are left alone. Add words to `STRICT` or `WHOLE`.
- **Limits:** 200 characters, one message a second per player (slow mode; the page holds a
  quick second message and sends it when allowed), no repeats within 20 s, 6 chat connections
  per player (one per tab) and 100 per IP address, since a whole school shares one address (only
  a hash of the address is kept, on the socket).
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
  `mod/fonts/TwemojiCountryFlags.woff2`. The Worker keeps the invisible joiners inside emoji
  like 👨‍💻 but strips them anywhere else.
- **Fonts:** Settings → Chat → "Chat font" changes only the chat: PolyTrack (the game's font,
  the default), Discord (Figtree, upright like Discord's gg sans, with Twemoji emoji as on
  Discord), Rounded (Nunito) or System (the device's own UI font). The game's stylesheet puts
  ForcedSquare italic on every element, so the chat's elements inherit from the window instead.
  Bundled fonts are in `mod/fonts/` (credits and licenses in `LICENSES.txt`) and only download
  when used.
- **Layout:** messages from one player within 5 minutes share one header (name, tag, time),
  like Discord, with a thin bar in the player's colour down the group's left edge; messages of
  only emoji show large.
- **Reactions:** hovering a message (tapping, on a phone) shows its time, three quick reactions
  (recently used, else 👍 😂 🔥), the reaction picker and, for the owner, the moderation tools.
  Clicking a reaction under a message adds or removes yours. The Worker accepts only a single
  emoji (`\p{RGI_Emoji}`), stores one spelling of each, allows 12 new reactions per player per
  15 s and 20 different emoji per message, and drops a message's reactions with it.
- **Replies:** work like Discord's. The hover bar's Reply button shows "Replying to Name" above
  the box with an "@ ON / OFF" toggle (ping them or not) and a cancel button (or Escape). A reply
  starts its own header and shows a quote line above it: "@Name" if it pinged them, then the
  start of their message; clicking it scrolls to the original. The Worker stores a copy of the
  first 100 characters (`reply_to`), so the quote outlives the original, which then reads
  "Original message was deleted". A reply ping goes through the same limits as an `@name`.
- **Editing and deleting:** your own messages get Edit and Delete in the hover bar (Up in an empty
  box edits your last one). Editing happens in place ("escape to cancel • enter to save") and
  adds "(edited)"; saving it empty asks to delete instead. Delete asks first, like Discord, unless
  Shift is held. The Worker lets players edit and delete only their own messages (the owner can
  delete anyone's), censors edits like new messages, keeps the original pings so an edit can't
  notify anyone, and allows 8 edits per player per 20 s. Reply quotes show the original's
  current text while it is still in the chat.

## Announcements

The owner writes one on Race Control's Announce tab. It shows at the top middle of every
player's screen like a chat message from the owner (their chat name colour, in each player's
chat font), stays for 6–30 s and fades out. `mod/nsws_announce.js` draws it.

- **Storage:** the `announcements` table in `TrafficStats` (created in `migrate()`). One is
  live at a time; sending a new one ends the old one. Owner endpoints (owner key in the body):
  `POST /nsws/announce`, `/nsws/announce/stop` and `/nsws/announce/list`.
- **Delivery:** every beat reply carries the live announcement (`ann`, or null), so every
  player gets it within a minute. Players with the chat open get it at once: the Worker also
  broadcasts `{t:"ann"}` / `{t:"ann-stop"}` through the `ChatRoom`. "Who gets it" sets how long
  it stays live for people who open the site later (5 minutes, an hour or a day).
- **Once per browser:** the page remembers ids it has shown (`nsws_ann_seen`) and holds one back
  while the tab is hidden. The next beat reports it as seen (`an`), which the "Seen by" count
  sums once per session. A null in a beat reply ends the one on screen, which is how Stop
  reaches players without the chat.

## Accounts (names and clips)

`src/accounts.js`, the `Accounts` Durable Object (one instance, `"global"`). An
account is a profile's userId, the SHA-256 of its private token; the token is
never stored.

- **Names.** Each nickname belongs to one account. Names compare without case,
  width variants or spaces, and `Anonymous` (the game's empty-name fallback) is
  shared. A profile save (`POST /v6/user`) that takes someone else's name gets
  409, unless Kodub already had that player under the name (they keep it). Names
  read off NSWS boards, profile reads and uploads are registered to whoever was
  seen with them first, so existing players keep theirs. Renaming through the
  site gives up the account's other names. The page checks a name before the
  profile screen accepts it, and a new profile's random name is claimed (rolled
  again while taken) by `mod/nsws_accounts.js`.
- **Clips.** `/nsws/clips/*` keep each account's clips (up to 1000, 300 KB of
  clip code each). The page saves a new clip to the device first and moves it to
  the account once the proxy has it, which is also how clips saved on a device
  before v9.5 reached the account.
- **Clip links.** `/nsws/clips/share` stores a copy of a clip under a 10-character
  id (30 new links per account per hour); `?clip=<id>` on the site adds it to
  the visitor's clips and starts playing it. A link keeps working after its clip
  is renamed or deleted.
- **Views.** `/nsws/clips/view` counts a watch against the run itself (the clip's
  key), so every copy of a shared clip adds to one count; a repeat within 30 s
  from the same account doesn't count. The clip list reports views and distinct
  viewers, leaving out the account's own watches.

Only the site may call these (the same Origin check as the chat). The Worker
must be deployed before a site push that uses them; until then the page shows
the device's clips and keeps them.

## Referrals and tags

Tags are name tags shown next to a player's name in the chat. They live in the
same `Accounts` Durable Object (new tables, created in its constructor), so they
belong to the account, not the device. `mod/nsws_tags.js` draws them; `TAGS` in
`src/accounts.js` and in that file must list the same ids, costs and counts.

- **Referral codes.** Every account has an 8-character code (no `I`, `O`, `0`
  or `1`) that changes every 10 minutes (`REF_CODE_MS`). Main menu → Referrals
  shows it with a countdown and a link (`?ref=CODE`, used on the visitor's
  profile as soon as it exists), and fetches the new code when the timer runs
  out. A code still works for 30 s after that (`REF_GRACE_MS`), and old codes are
  remembered for a day (`ref_expired`) so a late friend is told it expired. There
  is also a box to type a friend's code.
  Each profile can use one code, never its own, and not the code of someone who
  joined with theirs. One address can use 10 codes a day, 3 of them for the same
  player (a whole school shares one address); only a hash of it is stored.
- **Points.** A used code makes the new player `REFERRED` straight away, but the
  referrer's point only counts once that player uploads a run on an NSWS board
  (`confirmReferral`, called from `handleSubmit`), so empty profiles are worth
  nothing. Points = confirmed referrals + the owner's bonus − points spent.
- **Kinds of tag.** Shop tags are bought with points and kept for good. Reward
  tags (`RECRUITER`, `AMBASSADOR`, `HYPE TRAIN`) come free at 5, 15 and 30
  confirmed referrals. Discord tags (`NSWS WINNER`, `CLEAN SWEEP`,
  `MAPPO BUILDER`, `YOUTUBER`, `AUTHOR TIME`, `OG`) only the owner gives, on Race
  Control's Tags tab, by nickname; that tab can also add or take bonus points.
  Nothing syncs with Discord itself.
- **Wearing one.** Garage → Tags lists every tag with what it needs and previews
  it on a nameplate and a chat line. One tag at a time; buying puts it on.
- **The chat.** The chat only knows a player by the hash of their visitor id.
  `/nsws/refer/me` (sent on every visit with the visitor id) links that hash to
  the account, so the `ChatRoom` asks `Accounts.chatTag(uid)` without ever seeing
  a token. Each message stores the tag it was sent with (`tag` column); putting a
  tag on or losing one tells the room at once (`ChatRoom.retag`), so the next
  message shows it.

Player endpoints (`userToken` in a `text/plain` JSON body, site only):
`/nsws/refer/me`, `/nsws/refer/redeem`, `/nsws/tags/buy`, `/nsws/tags/equip`.
Owner endpoints (owner key as `token`): `/nsws/tagadmin`,
`/nsws/tagadmin/search` (any part of any name an account has been seen with;
3+ letters also match letters in order), `/nsws/tagadmin/lookup` (by `userId`
or exact `nickname`), `/nsws/tagadmin/grant`, `/nsws/tagadmin/bonus`. Deploy
the Worker before pushing the site; until then the Tags tab and Referrals window
say they aren't switched on yet.

## Competitions (PolyCup)

The main menu's **Competitions** button runs PolyCup by Kiki (used with permission; source in
`polycup/`, built to `mod/polycup.js`, which only loads when someone opens Competitions or a cup
link). PolyCup sits on the game's own multiplayer, and every part of it goes through this Worker:
there is no Kodub matchmaking and nothing peer to peer. `polycup/README.md` covers the page side.

- **Routes** (allowed sites only): `GET /nsws/cup/list` (public cups), and three WebSockets that
  stand in for Kodub's matchmaking server and WebRTC: `/nsws/cup/host` (a new cup code, reserved by
  `LobbyDirectory`, 10 per address per 10 minutes), `/nsws/cup/join?code=` and `/nsws/cup/mux?code=`.
- **The room** (`LobbyRoom` in `proxy/src/lobby.js`, one Durable Object per code) answers the same
  JSON handshake the game speaks to Kodub (`createInvite`, `joinInvite`, `acceptJoin`,
  `declineJoin`, `iceCandidate`, `joinDisconnect`), censoring nicknames and cup names. It then
  relays data channels: each page's mux socket carries frames of records
  `[u32 link][u16 channel][u8 kind][u32 length][bytes]`, and the room forwards each record to the
  other end of its link (one frame per destination). It never reads the game data and stores nothing;
  socket attachments hold its state. Bindings `LOBBY`/`LOBBY_DIR`, migration `v5` (the class names
  are kept from the earlier lobbies, so no migration was needed).
- **Cost on the free plan:** incoming WebSocket messages bill 20 to a request. A page bundles everything
  it sends into at most one frame every 200 ms (measured 3-5 a second per page in a live round), so an
  8-player cup is about 2 requests a second, roughly 7,000 an hour. The room rejects more than 60
  frames a second from one socket.
- **Cup PBs go to the owner:** with "Upload leaderboard times" on in a cup's rules, a personal best set
  in a cup is uploaded with `&nswsLobby=<code>` (`window.__nswsLobbyTag`). It goes through the normal
  replay check and is put on hold (`lobby_runs` in the `AntiCheat` Durable Object) before it is sent to
  Kodub, so other players never see it until the owner verifies it; the player still gets their own
  entry back. Race Control -> Anti-cheat -> "Lobby PBs to review" lists them: **Watch** plays the run in
  the game (`window.__nswsWatchRun`), **Verify** puts it on the boards, **Hide** keeps it off (it then
  shows under "Hidden from the boards", where Allow puts it up). The recording is dropped after either.
  While a held PB waits, the player is missing from the public board (Kodub keeps one run per player).
  Cup results themselves are not replayed.

## Name moderation

Every name and line players write goes through the chat's filter (`proxy/src/chatfilter.js`:
`cleanText` strips invisible and direction-changing characters and zalgo, `censor` replaces slurs
with `#`; `moderate` is both): chat messages and nicknames, lobby names, lobby nicknames and lobby
chat. Usernames follow the same filter: a profile save (`POST /v6/user`) or a name check whose name
has a slur is refused (`422 {nicknameBlocked}` / `{available: false, blocked: true}`, shown as "That
username isn't allowed"), upload nicknames are censored before they reach Kodub, and every nickname
the leaderboard routes hand out is censored on the way out. Bans and name matching still use the
raw name.

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
