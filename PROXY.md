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

`PUBLIC_NICKNAMES` has to match `BENCHMARK_NICKNAME` and
`BENCHMARK_NICKNAME_WEEK_OVERRIDES` in `main.bundle.js`, or current-week medals
show "Couldn't check medal".

Vars can also be edited in the Cloudflare dashboard (Worker → Settings →
Variables), but the next `wrangler deploy` puts back what is in the file.

`proxy/src/worker.js`:

- `ALLOWED_PREFIXES` — only `/v6/` is forwarded, so the Worker cannot be used as
  an open relay to arbitrary hosts.
- `CACHE_TTL` — edge cache for passed-through endpoints (recordings). Leaderboard
  reads are rebuilt per caller and never shared between players; each Worker
  instance keeps the raw boards for 10 seconds.

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
