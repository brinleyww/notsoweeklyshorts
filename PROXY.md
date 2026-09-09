# Leaderboard proxy

`vps.kodub.com` only answers requests whose `Origin` header is one of Kodub's
own sites, and it never returns CORS headers, so the browser cannot call it
directly. `proxy/src/worker.js` sits in front of it: it forwards the request
with an accepted `Origin` and returns the response with CORS headers attached.

This replaces the third-party `ptproxy.cwcinc.dev`, which did exactly the same
thing — responses through this Worker are byte-identical to that proxy's.

## Why it is a separate Worker

The site is served by **GitHub Pages**, which serves static files only and
cannot run a Worker. So the proxy deploys on its own Cloudflare hostname and the
site calls it cross-origin. Nothing about the site's own hosting changes.

    brinleyww.github.io/notsoweeklyshorts/   ->  static site (GitHub Pages)
    <worker>.workers.dev/v6/*               ->  this proxy  ->  vps.kodub.com

## Deploy

    cd proxy
    npx wrangler login      # your Cloudflare account
    npx wrangler deploy

Wrangler prints the deployed URL. Put it in `index.html`, **with a trailing
slash** — that is the only place the hostname appears:

    window.__nswsApiBase = "https://nsws-leaderboard-proxy.<subdomain>.workers.dev/";

Then commit and push; GitHub Pages redeploys the site.

Only `/v6/*` requests hit the Worker, so the free plan's 100k requests/day is
the relevant limit. The standings screen fetches one leaderboard per track, so
a page view costs several requests — the cache below takes the repeat views.

## Configuration

`proxy/wrangler.toml`, under `[vars]`:

| Var               | Default                    | Purpose                                 |
| ----------------- | -------------------------- | --------------------------------------- |
| `UPSTREAM`        | `https://vps.kodub.com`    | Where requests are forwarded            |
| `UPSTREAM_ORIGIN` | `https://www.kodub.com`    | The `Origin` value upstream will accept |

`proxy/src/worker.js`:

- `ALLOWED_PREFIXES` — only `/v6/` is forwarded, so the Worker cannot be used as
  an open relay to arbitrary hosts.
- `ALLOWED_ORIGINS` — empty, so any site may call the proxy. This matches what
  ptproxy.cwcinc.dev does today. To stop other sites putting your Worker on your
  bill, list your own origins instead:

      const ALLOWED_ORIGINS = ["https://brinleyww.github.io"];

- `CACHE_TTL` — per-endpoint edge cache, in seconds. Keeps request volume off
  Kodub's server and makes repeat leaderboard views instant. Endpoints that
  carry a raw `userToken` are deliberately absent and are never cached.

## Privacy note

Submissions and profile updates send a player's `userToken` — an account secret
— through this Worker. That is not new (it went through a stranger's Worker
before), but it does mean: do not enable Logpush with request bodies or query
strings for this Worker, and do not add logging of `request.url` on POST paths.

## Reverting

`main.bundle.js.bak` is the pre-change bundle. To go back to the old proxy:

    cp main.bundle.js.bak main.bundle.js

and drop the `__nswsApiBase` block from `index.html`.
