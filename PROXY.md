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
| `SHARE_SITE`       | Where a shared cup link sends the player (`/c/<code>`)         |

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
`/nsws/beat` when the site opens, every minute while the tab is shown, and when
the page closes; a hidden tab sends nothing. A beat carries a random session id
(one per tab), a random visitor id kept in `localStorage` (`nsws_visitor`, so all
tabs of one browser on one site share it; each site has its own `localStorage`),
an account key (`a`, the first half of `sha256("nsws-online:" + token)`), the
nickname, what the player is doing, and counts
of races, finishes, uploads and so on. It never carries the account token. The
Worker adds a coarse country, device, system and browser, and stores everything in
one SQLite Durable Object, `TrafficStats` (`proxy/src/traffic.js`). IP addresses
are only held in memory to cap new sessions at 120 per address per hour; they are
never stored. The reply to a beat is `{"online": n, "away": m, "nv": s, ...}`; the
chat window shows "n online".

- **Online counts people, not tabs.** `TrafficStats` groups its live sessions by
  visitor id and by account key (`personOf`): all tabs of one browser count as one
  person, and so does one account open in several browsers, on several devices or on
  both sites. Pages from before the account key (an unsynced fork) count per browser.
  A person with a tab
  whose beats come on time is active. A person whose tabs are all hidden past their
  promised beat is away: still online, and counted in `away`, until each tab says
  goodbye on close, however long it stays hidden. A tab that dies without a goodbye
  (a phone closing a frozen tab, a crash) stays until `TrafficStats` restarts, and a
  restart only brings back tabs opened in the last 3 hours (`RESTORE_MS`); older hidden
  ones come back when they are shown again. Race Control's
  "Online now", the last-3-hours chart, the peaks and an announcement's "online when
  sent" use the same count. Its live list has one row per person (the active tab
  that beat last, "N tabs" when there are several, on the site since the earliest
  tab opened); the visitor id and account key never reach the panel.
- **Runtime and the beat budget count tabs.** Every shown tab beats and adds its own
  runtime, and `activeTabs` is per tab. Past 20 shown tabs
  (`BEAT_BUDGET_PER_MIN`), `nv` stretches every tab's gap, to at most 15 minutes
  (`MAX_VISIBLE_GAP_S`), so the whole site stays near 20 beats a minute.
- **The all-time odometer counts people, away ones too.** Each beat credits the time
  since the last one, for the people that beat reported (`onlineCredit`,
  `buckets.online_s`). A restart picks up from `credit_at` and `credit_people` on the
  newest bucket, which the beat writes anyway, so they add no row. A gap with no beats
  credits at most 3 hours (`RESTORE_MS`), so an outage can't add much. Time before
  2026-10-30's fix was mostly lost, because each restart started the count over; it
  isn't restored.
- Once the live sessions are in memory, all of this is worked out there, with no
  extra rows read or written.
- **What a wake costs.** Production drops this object from memory after about 10 idle
  seconds, so at a few beats a minute nearly every beat wakes it. A wake reads one row:
  the newest announcement, the only one that can be live, since a new one stops the one
  before. The first call that needs the counts then reads the sessions that haven't said
  goodbye, opened in the last 3 hours (`restoreLive`, through the partial index
  `sessions_open`), and the odometer's row; alarms and votes never ask. A beat reads one
  more row for the newest minute, and the last-3-hours chart is read only when Race
  Control asks (up to 180 rows per load). `ended` is only set when it changes, because
  setting it rewrites the index entry, which would be one more row written per beat.
  Measured in `workerd` (`cursor.rowsRead`) on the same simulated traffic: 131 -> 20 rows
  read per beat at 2-3 tabs, 95 -> 18 at about 8 tabs, 18 -> 7 at 60 tabs. A beat itself
  still writes the same rows. Opens and goodbyes write one index row more, and the first
  beat in a new bucket can write the previous bucket's row (at most 144 a day).

`/nsws/stats`, `/nsws/live` and `/nsws/anticheat*` answer only the owner: the request
body must hold the owner key (see "Owner access"). The page checks the same hash
(in `nsws_traffic.js`) before showing the "Race Control" button and loading
`mod/nsws_owner.js`.

On the Workers Free plan each beat is one Worker request and one Durable Object
request, with about two SQLite rows written. That is roughly 1,440 beats a day
for each player who keeps the site open, so the free limits (100,000 requests
and 100,000 rows written a day) cover about 30 players online around the clock.
Hours played add one row written per beat (`play_due`), one call to `Accounts` every
5 minutes, and two rows written per active player per call.

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
- **Files, images and GIFs:** the (+) button, pasting or dropping a file attaches it; the GIF
  button opens a picker with Favourites and KLIPY's Trending and search. A message carries
  `media: { f: { id, type, w, h, name?, size? } }` (an upload; only non-images have a name) or
  `media: { g: { url, prev, slug, w, h, title } }` (a KLIPY GIF) and may have no text. Images show
  inline; video and audio get a click-to-play player (`preload="none"`, so nothing loads until
  someone presses play) above a download card; every other file is only a download card.
  Settings → Chat → "Images, GIFs and videos" can hide other players' images, video and audio
  behind a "Show" button. The owner's moderation tools add "Ban this image/GIF/video/audio/file",
  which deletes every message showing it and refuses it for good.
- **Uploads** go to `POST /nsws/chat/upload` (text/plain body: 4-byte header length, header JSON
  `{v, key, name}`, then the file) and are stored in the main `ChatRoom` under the first 32 hex of
  their SHA-256, in 1 MB parts, while a message shows them (or 15 minutes after upload). `GET
  /nsws/chat/file/<id>` serves them with no Origin check, since `<img>` sends none, and answers
  `Range` requests (Safari only plays video that way). The page redraws non-GIF images as WebP (at
  most 1600 px, which also drops photo metadata); GIFs and other files go up as they are. The bytes
  decide what a file is: anything that sniffs as an image takes the checked image path whatever its
  name. Other files (`proxy/src/chatfiles.js`, which the page also loads for a quick answer) are
  refused if their name ends in a program or script extension (exe, bat, msi, apk, ps1, js, html,
  svg, macro Office files, disk images, ...), if their bytes are a program (MZ, ELF, Mach-O, Java
  class, `#!`), or if they are a zip with such a name inside (other archives can't be looked into).
  Names are cleaned and censored. Video and audio are recognised by their bytes and served as
  themselves; everything else as `application/octet-stream` with `Content-Disposition: attachment`.
  All uploads keep `nosniff` and a sandbox CSP. Non-images are not checked by the model, so they
  rely on the owner's delete and ban. Limits: 10 MB per file, 4 MB still images (the page's WebP
  is far smaller), 5 uploads a minute and 40 a day per player, 200 a day per network. Cup chats
  take no uploads.
- **Checking uploads** (`proxy/src/chatmedia.js`, Workers AI binding `AI`): Clef-flash rates
  nudity/sexual content, hate symbols and gore, and Moondream reads out any text, which goes
  through the chat's slur filter (Clef doesn't flag slurs written in an image). A GIF is decoded
  in the Durable Object and 16 evenly spaced frames go to Clef as four 2x2 grids; the middle one
  goes to Moondream. Anything above 0.5 is refused. Verdicts are kept by hash for 30 days, so
  re-posting a file costs no check. The chat runs at most 300 checks a day (about the free
  Workers AI allowance; a Moondream read alone is ~21 neurons) and refuses uploads, not lets them
  through, when the models can't be reached. The owner's uploads skip the check.
- **KLIPY GIFs:** KLIPY's terms say requests must come from the player's browser, not a server,
  and results must not be filtered or reordered by us. So the page calls KLIPY itself with the
  app key in `window.__nswsKlipyKey` (index.html; no key = no search, favourites still work),
  with `content_filter=low` (up to PG-13, the same as the key's Partner Panel setting), and refuses to search terms on its own sexual-word list or the
  chat's slur list (loaded from `proxy/src/chatfilter.js`). The search box must say "Search
  KLIPY". The Worker only accepts KLIPY media URLs (`static*.klipy.com`) and censors the title.
  Extra blocked search terms and keywords can be set per key in KLIPY's Partner Panel.
- **Networks that block KLIPY** (schools often do; the chat itself still gets through on the
  HTTPS fallback): KLIPY's Integration Requirements forbid routing its API or media through our
  servers, or caching it, without their written approval (developers@klipy.com), so the Worker
  can't fetch them instead. The page notices instead: a KLIPY request that fails to connect or
  gets something other than JSON (a firewall's block page), or a KLIPY image that fails to load
  (KLIPY answers removed GIFs with a placeholder image, so a failed load means the network). The
  GIF panel then says KLIPY can't be reached, with an "Upload a GIF" button, opens on Favourites,
  and KLIPY GIFs in messages read "GIF blocked on this network (KLIPY)". Uploaded GIFs are served
  by the Worker, so they show on those networks.
- **Favourites** are in `localStorage` (`_nswsChatGifStars`, up to 100). A starred upload also keeps
  a copy of the file in IndexedDB (`nsws-chat`), since uploads leave the server; sending it uploads
  it again, which the hash makes cheap.

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
- **Polls:** an announcement can carry 2–10 answers (`poll`, 40 characters each). A poll gets its
  own card under any message. It stays until the player closes it with ×, even across reloads
  (`nsws_poll_open` in localStorage), and shows the percentages once they vote. "Players can change
  their vote" (`poll_change`) is set per poll. Voting is open until the owner presses Close voting
  (`/nsws/announce/close-poll`, `poll_closed`) or for 7 days.
- **Votes:** `POST /nsws/poll` (`{v, id, c}`: visitor id, announcement id, answer) is open to the
  site like the beat. The visitor must have sent a beat, and one IP address gets 30 new votes per
  poll. A second vote moves the first only when changes are allowed; the reply always carries the
  vote that stands. Votes are rows in `poll_votes`; the running counts live on the announcement row
  (`votes`), so nothing ever sums the votes table.
- **Live counts:** while a player has a poll card open, each beat sends its id (`pl`) and the reply
  carries `pv` (`{id, votes, open, change}`). That costs no extra request, and recent poll rows are
  cached in memory so it reads no rows. Clicking a poll in Race Control's Recent announcements opens
  its results.
- **Likes:** every announcement and poll card has a heart. `POST /nsws/like` (`{v, id, on}`) is open
  to the site like a vote, with the same beat and per-IP rules (30 new likes per announcement), for
  7 days after sending; `on: false` takes the like back. Likes are rows in `ann_likes`; the count is
  the announcement row's `likes`, which the announcement itself carries (`ann.likes`) and Race
  Control shows. The page remembers its likes in `nsws_ann_liked`.

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
  is renamed or deleted. Clips selected together (same track only) share as
  `?clip=<id>,<id>,...` (up to 20), one id per clip; the visitor gets them all and
  watches them as one replay. The same clip always gets the same id back, so
  sharing it again costs nothing against the hourly limit.
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

- **Referral codes.** Every account has one 8-character code (no `I`, `O`, `0`
  or `1`) that never changes, so a link posted in Discord or a video keeps
  working. Main menu → Referrals shows it with a link (`?ref=CODE`, used on the
  visitor's profile as soon as it exists) and a box to type a friend's code.
  Codes from before codes stopped changing are in `ref_expired`, so they answer
  "expired". The share window's week card carries the same link.
  Each profile can use one code, never its own, and not the code of someone who
  joined with theirs. One address can use 10 codes a day, 3 of them for the same
  player (a whole school shares one address); only a hash of it is stored.
- **Points.** A used code makes the new player `REFERRED` straight away, but the
  referrer's point only counts once that player uploads a run on an NSWS board
  (`Accounts.uploaded`, called from `handleSubmit`), so empty profiles are worth
  nothing. Points = confirmed referrals + the owner's bonus − points spent.
  `refer/me` returns the last 5 confirmed referrals (`recent`); the page shows a
  toast for any it hasn't announced yet (`_nswsTagsSeen:<code>` in localStorage).
- **Hours played.** `TrafficStats` adds up each visitor's focused seconds from the
  beats in its `play_due` table and hands them to `Accounts.creditPlay` in one call
  every 5 minutes (`PLAY_FLUSH_MS`, an alarm), at most 16 minutes per visitor per
  batch (the rest waits for the next one). They can't wait in memory: the object
  leaves memory after a few idle seconds, so nothing reached the accounts and each
  wake pushed the alarm back, until 2026-10-30. `Accounts` maps the visitor to the
  account through `chat_links` and adds to `playtime`. The first flush after that fix
  lifted every account to its sessions' total `focus` (`restorePlay`, `meta` key
  `play_restore` in `TrafficStats`). Hours tags (`FIRST LAPS` 1 h,
  `REGULAR` 5, `GRINDER` 10, `VETERAN` 25, `ROAD WARRIOR` 50, `CENTURION` 100,
  `LIFER` 250) are owned once the hours are there. The page puts a new one on when
  the player wears no tag or a smaller hours tag, and says so.
- **Weekly bingo.** Every NSWS week has one 5x5 card with a free centre, the same
  for everyone. `mod/nsws_bingo.js` makes it from the week's tracks (seeded by the
  week, the round and the track ids): one column per track with an easy, a medium
  and a hard square (one column epic), and activities in the rest. Only finished
  runs count: medal squares judge each run's own time (`nsws-finish` event +
  `__nswsMedalForTime` in main.bundle.js), so restarting or opening menus marks
  nothing. The page sends newly done squares to `/nsws/bingo/mark`
  (`{userToken, week, round, squares}`), which only takes the `CURRENT_WEEK` card
  (or the next one, for the gap between a site push and the Worker deploy) and
  drops marks for another round (marks with no round, from pre-v2 pages, too).
  `Accounts` keeps the marks as a 25-bit mask per account and week (`bingo` table)
  and counts bingos, full rows, columns and diagonals, over every week
  (`bingoLines`). A card with a bingo can be swapped with `/nsws/bingo/reset`
  (`{userToken, week, round}`): its bingos and blackout move into `banked` /
  `banked_full`, the marks clear and `round` goes up. The first cards (v9.50) had
  other squares, so the migration that added those columns banked every old card
  and cleared it. `refer/me`, `bingo/mark` and `bingo/reset` return it as `bingo`
  (`{live, total, blackouts, cards: [{week, round, banked, marks}]}`). Bingo tags (`BINGO` 1, `DAUBER` 5,
  `FULL HOUSE` 15, `JACKPOT` 30, `CARD SHARK` 60) come with the total, and
  `BLACKOUT` with one whole card. Squares are the player's own word, like the
  hours: the tags are for fun, not for the boards. (An earlier weekly streak left
  an unused `played_weeks` table and `meta` key `weeks_backfill`.)
- **NSWS King.** One player at a time wears `NSWS KING`: whoever holds the most
  WRs (first place on a board) over every NSWS week, live week included. When the
  Worker serves the first page of an NSWS board (version 0.6.2, all runs, with the
  anti-cheat reachable), it passes the board's first place, after bans and hidden
  runs, to `Accounts.noteWrs`. Only tracks the anti-cheat has synced count, and
  only under their real week (`AntiCheat.trackWeeks`), so a made-up `nswsWeek`
  on another board counts for nothing. Each Worker instance remembers what it last
  sent per track, and `Accounts` keeps the `wrs` table in memory, so an
  unchanged board costs no rows. A tie keeps the current King; with no King among
  the tied, whoever got there first. The new King has the tag put on by the
  server (the tag they wore is kept in `wr_king.before`), and the old one gets
  that tag back if they were still wearing the crown. The chat stores the King's
  tag with the count (`king:7`), and `refer/me` returns `wrs` (the player's
  own count) and `king` (`{nickname, wrs, since}`). Boards nobody opens would
  never be noted, so the owner's page opens every NSWS board once every 12 hours
  (`sweepWrs` in `mod/nsws_traffic.js`, after the track sync).
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
`/nsws/refer/me`, `/nsws/refer/redeem`, `/nsws/tags/buy`, `/nsws/tags/equip`, `/nsws/bingo/mark`, `/nsws/bingo/reset`.
Owner endpoints (owner key as `token`): `/nsws/tagadmin`,
`/nsws/tagadmin/search` (any part of any name an account has been seen with;
3+ letters also match letters in order), `/nsws/tagadmin/lookup` (by `userId`
or exact `nickname`), `/nsws/tagadmin/grant`, `/nsws/tagadmin/bonus`. Deploy
the Worker before pushing the site; until then the Tags tab and Referrals window
say they aren't switched on yet.

## Competitions (Cuppa)

The main menu's **Competitions** button opens Cuppa, the site's cup mode (source in
`competitions/`, built to `mod/competitions.js`, which only loads when someone opens Competitions
or a cup link). It sits on the game's own multiplayer, and every part of it goes through this Worker:
there is no Kodub matchmaking and nothing peer to peer. `competitions/README.md` covers the page side.

- **Routes** (allowed sites only): `GET /nsws/cup/list` (public cups), `GET /nsws/cup/info?code=`
  (a cup's name, map pool and status, read for the join card; `{cup: null}` if it isn't open), and
  three WebSockets that stand
  in for Kodub's matchmaking server and WebRTC: `/nsws/cup/host` (a new cup code, reserved by
  `LobbyDirectory`, 10 per address per 10 minutes; `?reclaim=CODE` asks for the organizer's own code
  back), `/nsws/cup/join?code=` and `/nsws/cup/mux?code=&token=` (`&resume=1` to resume).
- **Shared cup links** (2026-10-19): `GET /c/<CODE>`, the link the Competitions panel's **Copy
  invite link** hands out, and `GET /c/<CODE>/card.png`, the picture under it. A chat app runs no
  scripts, so a link straight to the site can only ever show the site's own card; this page is
  built per cup instead, with the cup's name as its title, what it is playing and doing and its
  map pool as the description, a stripe colour that follows the phase, and a 1200x630 card drawn
  in `src/cupcard.js`. Whoever clicks it is sent on to `SHARE_SITE` + `?cup=CODE` at once (a meta
  refresh and `location.replace`), so nothing about joining changes. Unlike the rest of the API
  these two take no `Origin` and no key - a chat app sends neither - so they are limited to 40
  page views an address a minute, codes that can't exist never reach a Durable Object, and a cup
  that can't be looked up (daily limits, an old link) reads as one that has ended. They say no
  more than `/cup/info` already tells anyone holding the code. The card is drawn inside the cup's
  `LobbyRoom` (`card()`), because 1200x630 takes more CPU than a Worker request gets on the free
  plan; the room keeps the last one it drew, and the reply is cacheable for 5 minutes.
- **Status:** the organizer's page sends `{type: "nswsStatus", status: {phase, round, racers,
  canRace, format}}` on its matchmaking socket when the cup changes (at most every 2 s). The room
  keeps it on the attachment and puts it in the list row and `/info`, so the list and the join card
  say what a cup is doing and whether a newcomer can still race.
- **Dropped connections:** each mux socket carries a random token. When one closes with anything but
  1000/1005 (a page closing on purpose), its links are parked for 20 s instead of going down: the
  other ends are not told, and frames for the parked end are dropped. The page reconnects with the
  same token and `resume=1&relink=1` and gets `{t: "resumed", ok: true, relink: true}`. It then
  sends one `{t: "rejoin", pairs: [{pair, side, recv}]}` listing every connection it still has, with
  `recv`, the number of records it got from the other end (pairs it doesn't list go down). Each listed
  pair starts over on a new link: the other end gets `{t: "relink", pair}` and answers with its own
  `open` and `recv`, and both get `{t: "up", pair, link, recv}` carrying the other end's count. Each
  page then resends what it sent past that count from its log (`transport.js` keeps the last 1 MB
  per connection), so nothing is lost or doubled, whichever side lost frames. An expired token, or a
  page without `relink=1` (from before re-linking), gets `ok: false` and tears its links down.
- **Deploys:** a Worker deploy restarts every room and drops every socket at once, with no close
  events. A room that comes back knows no tokens, so it accepts any token it never expired, and the
  pages re-link both ends of each pair themselves (`rejoin` from each side, `up` once both are back).
  Link numbers start from the clock in seconds, so a restarted room never reuses one a page still
  holds. Pages keep reconnecting for 60 s. While the organizer's page is cut off (and for 10 s after),
  it doesn't end a round, and a finish that was held up is judged from when the outage began
  (`window.__nswsMuxOutage`, `host.ts #outageFrom`). Tested with `wrangler dev` killed and restarted
  mid-round (`cup-test-tools/cdp/sc_proxyrestart.mjs`): the organizer had its code back about 6 s
  after the kill, and a finish lost in flight was resent and counted.
- **Reclaiming the code:** the organizer's `createInvite` carries a random `reclaim` secret. The room
  stores `{key, code, until, cup}` as soon as the cup opens (the only thing it ever stores), with
  `until: null` while the organizer is connected, so the record is there when a restart drops the
  socket without a close event. If the matchmaking socket drops (not a deliberate close), `until` is
  set 60 s ahead. A room alarm every 10 minutes notices an organizer that is gone without a close
  (after a restart) and starts the same 60 s. Meanwhile the row is hidden from the list but the code
  stays reserved, and `/cup/host?reclaim=CODE` whose `createInvite` has the same secret gets the same
  code, name, pool and status back. When the time is up the alarm deletes the record and frees the
  code; a deliberate close deletes it at once. The page retries every 1.5 s for a minute
  (`Fn.prototype.requestInvite` in `main.bundle.js`), and the organizer sends its status again on
  the new socket (`host.ts #reportStatus`).
- **No official cups** (removed after v9.36): Cup Champion (`cupchamp`) is an ordinary owner grant on
  Race Control -> Tags. The `cup` column on `announcements` and the old `cup_results` table are unused.
- **Set before the room opens** (the host's `createInvite` carries them as `nsws`): the cup's name,
  public or private, room size, the map pool (`{shorts, main: [Summer|Winter|Desert], community:
  [game versions]}`; only the weekly shorts are on by default) and a random secret for the cup chat.
  The room keeps them on the host socket's attachment.
- **Cup chat** is the universal chat (`ChatRoom`, `src/chat.js`) in a room of its own per cup:
  `/nsws/chat?cup=CODE` (WebSocket only) is the Durable Object named `cup:CODE`. Same filter, slow
  mode, spam timeouts and tags as the main chat. The organizer's hello carries the chat secret, which
  the room checks with `LobbyRoom.isHost`; only that socket (or the owner) can send `cupmute`, which
  mutes a player for the cup and broadcasts `{t: "mutes", uids}`. A cup chat room wipes itself a day
  after the last player joined it.
- **The room** (`LobbyRoom` in `proxy/src/lobby.js`, one Durable Object per code) answers the same
  JSON handshake the game speaks to Kodub (`createInvite`, `joinInvite`, `acceptJoin`,
  `declineJoin`, `iceCandidate`, `joinDisconnect`), censoring nicknames and cup names. It then
  relays data channels: each page's mux socket carries frames of records
  `[u32 link][u16 channel][u8 kind][u32 length][bytes]`, and the room forwards each record to the
  other end of its link (one frame per destination). A page that opens its mux socket with `fan=1`
  sends its own car states as kind 2, `[u32 0][f64 car start on the cup clock][game bytes]`;
  the room writes the link the record came in on over the first four bytes, passes it to the organizer
  (kind 1 without the 12-byte prefix if the organizer's page didn't ask for `fan=1`) and also straight
  to every other `fan=1` page, on that page's link, so other cars skip the organizer's page. Pages learn
  whose link is whose only from the organizer (`lk` on each player in the cup state) and drop a copy
  from a link it hasn't named, so a page can't pass its car off as someone else's. Only outgoing messages multiply, which aren't billed. `up` says
  `fan: true` to a page whose socket asked for it and `peerFan: true` when the other end's did; older
  pages never see kind 2. The organizer's game leaves a racer's states out of its batches to a
  `peerFan` page once that racer's states arrive as kind 2. Pages don't count
  these copies among their link's records (`transport.js`). It never reads the game data and stores nothing
  but the reclaim record above; socket attachments hold its state. Bindings `LOBBY`/`LOBBY_DIR`, migration `v5` (the class names
  are kept from the earlier lobbies, so no migration was needed).
- **WebRTC car states** (`competitions/src/rtc.js`): pages also send car states straight to each
  other over WebRTC data channels, through TURN relays only, so other cars can be drawn where they are
  now. The room carries only the handshake on the mux socket: `{t:"rtcIce"}` gets
  `{t:"rtcIce", iceServers}` (null when the Worker has no TURN), only from a socket with a live link
  in the cup (pages ask after their first `up`; v10.53 pages asked before it and stay on the mux), and `{t:"rtc", to, d:{type, sdp, n}}`
  goes to page `to` as `{t:"rtc", from, d}`, where `from`/`to` are a page's own link to the organizer
  (0 = the organizer's page) and `from` is filled in by the room, so a page can't pose as another.
  Every `a=candidate` line that isn't `typ relay` is removed and every `c=` line's address is zeroed;
  pages gather relay candidates only anyway (`iceTransportPolicy: "relay"`), so no player's address
  reaches another player, only Cloudflare's TURN. At most 80 handshake messages per socket per 10 s.
  Credentials: with the secrets `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` (a TURN key from Cloudflare
  Realtime: dashboard -> Realtime -> TURN Server -> Create), the room asks
  `rtc.live.cloudflare.com/v1/turn/keys/<id>/credentials/generate-ice-servers` for 24 h credentials,
  reuses them for 6 h, and drops port-53 and STUN URLs. Without those, a fixed login: `TURN_STATIC_URLS`
  in wrangler.toml (now ExpressTURN's free plan, `free.expressturn.com:3478`, 1,000 GB a month, one
  server in Amsterdam: ~0 ms ghosts in Europe, ~110 ms for US players, Node harness) with the secrets
  `TURN_STATIC_USER` and `TURN_STATIC_PASS`. Every page in a cup gets that login, so a leaked one is
  fixed by "Refresh Username, Password" in the ExpressTURN dashboard and setting both secrets again.
  `TURN_DEV_ICE` (a JSON iceServers list) is for
  local testing (`cup-test-tools/rtc/turn.mjs`, `cdp/sc_rtc_rig.mjs`). Neither set: pages stay on the
  mux exactly as before. The mux still carries every state, so a page whose WebRTC fails only loses
  time. TURN traffic is billed by Cloudflare per GB, not per request (`competitions/README.md`, "Cost
  on Cloudflare").
- **Cost on the free plan:** incoming WebSocket messages bill 20 to a request. A page bundles everything
  it sends into one frame: every 200 ms while its car is moving (the organizer: while anyone's is) and
  every second otherwise; clicks, finishes and phase changes go at once. Pages drop what carries
  nothing (the organizer's empty car batches, repeated car states, most pings between rounds) and
  send nothing from a background tab unless racing or organizing (`competitions/README.md`, "Cost on
  Cloudflare"). Measured: about 3.9 frames a second per driving page and 0.1-0.3 between rounds. An
  8-player cup is about 1.5 requests a second while everyone races and about 0.1 between rounds.
  Spectating and live timing send nothing of their own. The room rejects more than 60 frames a second
  from one socket.
- **Cup PBs go to the owner:** with "Upload leaderboard times" on in a cup's rules, a personal best set
  in a cup is uploaded with `&nswsLobby=<code>` (`window.__nswsLobbyTag`). It goes through the normal
  replay check and is put on hold (`lobby_runs` in the `AntiCheat` Durable Object) before it is sent to
  Kodub, so other players never see it until the owner verifies it; the player still gets their own
  entry back. Race Control -> Anti-cheat -> "Lobby PBs to review" lists them: **Watch** plays the run in
  the game (`window.__nswsWatchRun`), **Verify** puts it on the boards, **Hide** keeps it off (it then
  shows under "Hidden from the boards", where Allow puts it up). The recording is dropped after either.
  **Verify all** (`/nsws/anticheat/lobby/all`, click twice) verifies every PB still waiting, not only
  the ones listed.
  While a held PB waits, the player is missing from the public board (Kodub keeps one run per player).
  A cup with player collisions never saves or uploads a time, so nothing from it reaches this queue.
  Cup finishes are checked on the organizer's page instead: each racer's finish carries its replay,
  which the organizer runs through the game's own physics (`competitions/README.md`).

## HTTPS fallback for sockets

School and work firewalls often block WebSockets but let ordinary HTTPS through (that is why the
leaderboards work there). Everything in a cup is a WebSocket: the matchmaking sockets
(`/nsws/cup/host`, `/nsws/cup/join`), the relay (`/nsws/cup/mux`) and the cup chat
(`/nsws/chat?cup=`). So all of them go through `window.__nswsSocket` (`mod/nsws_socket.js`), which
is a real WebSocket whenever one can open, and otherwise carries on over HTTPS without the page
noticing. The main chat has its own fallback (see "Chat") and doesn't use this.

- **When it switches:** a socket that is refused, or not open within 8 s, reopens over HTTPS. If
  that works, the page remembers it for 12 hours (`_nswsChatHttpAt`, the same key the main chat
  uses) and later sockets go straight to HTTPS. Once a visit the page quietly tries a WebSocket
  again, and if it opens, the next visit uses WebSockets.
- **Sockets that open and then stop:** some filters let the WebSocket open and then hold back or
  cut its traffic without closing it. The relay pings when it has heard nothing for 5 s (the room
  answers "pong" itself) and treats 15 s of silence as a drop; the cup chat does the same with an
  unanswered 30 s ping. Two such breaks (or 1006 drops) within 10 minutes, counted once per 5 s so
  a deploy is one, set `_nswsSockBreakAt`, and the cup's sockets use HTTPS for 12 hours. The
  once-a-visit check doesn't clear it (a socket opening proves nothing there), and the main chat
  doesn't read it. Tested behind a fake firewall that stalls WebSockets after they open: on HTTPS
  about 30 s after the stall, where the old page heard nothing for the rest of the test.
- **The bridge:** `SocketBridge` (`proxy/src/bridge.js`, binding `BRIDGE`, migration `v6`), one per
  cup code. It opens the real WebSockets to `LobbyRoom` and `ChatRoom` on the page's behalf, so
  those rooms see ordinary sockets and needed no changes. `/nsws/sock/open` resolves a socket path
  with the same checks and limits as the WebSocket routes (`cupTarget`, `chatTarget` in
  `worker.js`), so nothing else can be reached through it. `/nsws/sock/down` and `/nsws/sock/up`
  carry the traffic. Site only, `text/plain` or binary POSTs, so there is no CORS preflight.
- **One session per page and cup:** every socket a page has in a cup shares one stream down and one
  stream up, numbered so that nothing is lost or doubled when a request drops and is retried.
  A page that stops calling for 45 s is gone, and its sockets close with 4001, which the rooms treat
  as a dropped connection (the relay parks, the organizer can reclaim the code). Nothing is stored.

**Keeping it inside the free plan.** Each request counts against Workers' 100,000 a day, and
each request to the bridge counts against Durable Objects' 100,000 a day.

- **Down** is one streamed response that stays open for 30 s and gets everything as it comes,
  however busy the cup is: two requests a minute. If the network's proxy holds a response back
  until it ends (the first byte doesn't arrive in 5 s), the page long-polls instead (waits up to
  20 s, or answers after the relay's pace once something arrives) and remembers that for 12 hours.
- **Up** is one streamed request body per 50 s where the browser can stream uploads (Chrome, over
  HTTP/2). If the upload isn't acknowledged within 5 s (HTTP/1.1, or a proxy in the way), the page
  sends one POST per batch instead, never more than one at a time. While it does, the relay batches
  every 300 ms instead of every 200 ms (`window.__nswsMuxMinPace`).
- **Bodies are raw records**, `[u8 kind][u32 seq][u16 ch][u32 length][bytes]`, never JSON or
  base64. The Worker passes `/down` and `/up` straight through without reading them, so a 300 KB
  track transfer costs it no CPU (the free plan allows 10 ms a request).
- **One bridge per cup**, not per player, so the Durable Object time (13,000 GB-s a day free) grows
  with the number of cups using the fallback, not the number of players.
- **Only blocked networks use it.** Everyone else stays on WebSockets, where incoming messages bill
  20 to a request.

Measured locally (`wrangler dev`) with a car-state frame every 200 ms, per racing player:

| Network                                        | Worker requests                          |
| ---------------------------------------------- | ---------------------------------------- |
| WebSockets (normal)                            | ~0.25 a second (20 messages bill as one) |
| Streams both ways (Chrome, where allowed)      | ~4 a **minute**                          |
| Stream down, one POST per batch (Firefox, Safari, HTTP/1.1) | ~3.3 a second while driving, ~2 a minute otherwise |
| Long-poll down, POST up (proxy holds responses back) | ~3.3 POSTs plus up to ~3 polls a second while driving |

Each Worker request to `/sock/down` or `/sock/up` is also one Durable Object request. The bridge's own
sockets to the rooms bill like any WebSocket player's. So a fallback player in Chrome costs less
than a WebSocket player, and one on POSTs can race for about 8 hours a day before the free plan's
100,000 requests run out. If many players at once end up on POSTs, the $5 Workers Paid plan
(10 million requests a month) removes the limit.

## Name moderation

Every name and line players write goes through the chat's filter (`proxy/src/chatfilter.js`:
`cleanText` strips invisible and direction-changing characters and zalgo, `censor` replaces slurs
with `#`; `moderate` is both): chat messages and nicknames, lobby names, lobby nicknames and lobby
chat. Usernames follow the same filter: a profile save (`POST /v6/user`) or a name check whose name
has a slur is refused (`422 {nicknameBlocked}` / `{available: false, blocked: true}`, shown as "That
username isn't allowed"), upload nicknames are censored before they reach Kodub, and every nickname
the leaderboard routes hand out is censored on the way out. Bans and name matching still use the
raw name.

## Bad days (free-plan limits)

On the free plan the Durable Objects have daily limits (100,000 requests, 5M rows read, 100,000
rows written). Once one runs out, every DO call fails until about 00:15 UTC. Each Worker instance
then stops calling DOs for 10 minutes at a time (`doLimited()`), and what still works is:

- **Leaderboards** load, filtered by the anti-cheat's last verdicts. Every 5 minutes a cron asks
  `AntiCheat.saveSnapshot()` to save them to Workers KV (binding `FALLBACK`, only when they
  changed). Per board, the snapshot holds the newest run id seen, the runs to hide, the lobby holds,
  and the valid runs newer than that id. Each board's part is kept in the object (`snap_tracks`) and
  worked out again only when that board changed (`snap_dirty`), so a cron with nothing new reads
  one row. Rebuilding every board on every cron read the whole `runs` table 12 times an hour; with
  week 11's reused track (2,000+ old Kodub runs) that alone used up the 5M daily reads on 10-29.
  While limited, a board uses this instance's own verdicts
  first, then the snapshot. A run newer than both stays hidden until the anti-cheat is back,
  because no upload reaches Kodub through the proxy while it is limited. A board neither has seen
  counts as all legacy, as it would on its first anti-cheat visit.
- **Everything else** that needs a DO answers `503 {error:"busy", retry:600, until}`, where
  `until` is the expected lift (00:15 UTC). This covers uploads to NSWS boards, chat, chat images,
  accounts, poll votes and cups. A beat answers `200 {busy:true, nv, until}`, with no `ann` or
  `pv` keys so the page leaves its announcement alone, and the page keeps that beat's counts for
  the next one.

On a normal day leaderboards read the same snapshot first. A board whose runs the anti-cheat had
all seen when the snapshot was saved (id up to the board's newest, or in its valid list) is
filtered from it, with no Durable Object call. Only a board with a newer run asks
`AntiCheat.classify`. The snapshot also holds each synced track's week and, every 15 minutes, the
WR holders from `Accounts.wrKeys()`. Names go to `Accounts.observeNames` only for runs newer than
the snapshot, and `noteWrs` is skipped when the snapshot already has that holder. So a fresh Worker
instance no longer spends up to 4 DO calls on its first view of each board. A verdict that changes
later (a legacy run found invalid, an owner approval) reaches boards within about 10 minutes
(the 5-minute cron plus each instance's 5-minute copy).

The page side is `mod/nsws_offline.js`. `__nswsBusy` remembers `until` and tells the player once;
any normal reply (a beat, a chat connect, a queued upload) clears it early. A PB whose upload got a
busy, 5xx or no reply goes in a queue (`_nswsUploadQueue`) and is sent through the game's own
`syncRecord` once the server is back. While busy, one queued upload is still tried every 10
minutes. Lobby runs are never queued.

A queued run remembers when it was set (and its time, so a later record on that track never takes the
date) and its upload sends `nswsAchievedAt`. The Worker notes each spell in which it refused uploads
for the limits in KV (`upload-outages`, `{from, to}`), and believes the date only inside one of them
(10 minutes' slack before `from`). The anti-cheat stores it (`runs.achieved`) and gives the run a
`tie_id`: the smallest id among equal times on that board set after it, so the run sorts where it
would have landed. Equal times always go to whoever set theirs first: Kodub orders them by upload id,
and the snapshot's per-board `late` list ([id, tie id, achieved, nickname, frames, week]) moves
backdated runs into place. `GET /nsws/late?week=N` (site origin, ended weeks only) hands that list
out, and the standings page adds the runs set before an ended week's `frozenAt` to its saved file
(only files that carry `runs`, written by the freeze script since this change).

The chat shows its last 40 messages (`_nswsChatLog`) and "paused until …", and looks again every 10
minutes. A busy poll ends the HTTPS session, so the page goes back to WebSockets afterwards
instead of long-polling for 12 hours.

If the Worker itself is out of requests, nothing answers at all. Every board the game loaded is
kept in Cache Storage (`nsws-boards`, the newest 60) and shown with a "saved copy" note;
standings keep nicknames only. Tags and the bingo card show the last account state
(`_nswsAccountState`, up to 7 days).

Testing: copy `proxy/` next to the repo (not under %TEMP%), add a route that sets `doLimitedUntil`,
and run `wrangler dev --test-scheduled` (`/__scheduled` runs the cron). `bad-day-test/` next to the
repo has the scripts.

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
