// Linking an NSWS account to a Discord account (OAuth2), and the DISCORD tag for players in the NSWS
// server. The page asks /start for a sign-in link, Discord sends the player to /callback, and /check
// looks at the server again after they join. Needs DISCORD_CLIENT_ID, DISCORD_GUILD_ID and the
// DISCORD_CLIENT_SECRET secret; without them every route answers 404.

export const DISCORD_PREFIX = "/nsws/discord/";
export const DISCORD_POSTS = ["start", "check", "unlink"].map((p) => DISCORD_PREFIX + p);

const API = "https://discord.com/api/v10";
const AUTHORIZE = "https://discord.com/oauth2/authorize";
const SCOPES = "identify guilds.members.read";
const STATE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
// Discord limits these calls per token, and the page asks again whenever its tab gets focus.
const CHECK_GAP_MS = 5_000;
const EXPIRY_MARGIN_MS = 60_000;
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_BODY = 2000;

export function discordOn(env) {
    return !!(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET && env.DISCORD_GUILD_ID);
}

function apiBase(env) {
    return (env.DISCORD_API || API).replace(/\/$/, "");
}

function redirectUri(env, url) {
    return env.DISCORD_REDIRECT || url.origin + DISCORD_PREFIX + "callback";
}

function randomState() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return Array.from(bytes, (b) => STATE_ALPHABET[b % STATE_ALPHABET.length]).join("");
}

async function tokenCall(env, url, params) {
    const response = await fetch(apiBase(env) + "/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: env.DISCORD_CLIENT_ID, client_secret: env.DISCORD_CLIENT_SECRET, redirect_uri: redirectUri(env, url), ...params }),
    });
    if (!response.ok) return null;
    const t = await response.json().catch(() => null);
    if (typeof t?.access_token !== "string") return null;
    return { access: t.access_token, refresh: typeof t.refresh_token === "string" ? t.refresh_token : null, expires: Date.now() + (Number(t.expires_in) || 0) * 1000 };
}

// true / false, "auth" when the token no longer works, "busy" for anything else.
async function inGuild(env, access) {
    const response = await fetch(apiBase(env) + "/users/@me/guilds/" + env.DISCORD_GUILD_ID + "/member", {
        headers: { Authorization: "Bearer " + access },
    });
    if (response.ok) return true;
    if (response.status === 404) return false;
    if (response.status === 401 || response.status === 403) return "auth";
    return "busy";
}

async function discordUser(env, access) {
    const response = await fetch(apiBase(env) + "/users/@me", { headers: { Authorization: "Bearer " + access } });
    if (!response.ok) return null;
    const user = await response.json().catch(() => null);
    if (!/^\d{1,25}$/.test(user?.id ?? "")) return null;
    return { id: user.id, name: String(user.global_name || user.username || "Discord user").replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, 64) };
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const RESULTS = {
    joined: ["Discord connected", "You're in the NSWS server, so the DISCORD role is yours. Wear it from Garage → Roles."],
    linked: ["One more step", "Join the Not So Weekly Shorts server to get the DISCORD role. Once you're in, go back to NSWS and it shows up by itself."],
    cancelled: ["Not connected", "You didn't let NSWS see your Discord account, so nothing changed."],
    expired: ["Link ran out", "That sign-in link is old or was used already. Go back to NSWS and press Connect Discord again."],
    failed: ["Couldn't connect", "Discord didn't answer properly. Go back to NSWS and try again in a moment."],
};

function resultPage(env, kind, back, name) {
    const [title, text] = RESULTS[kind];
    const site = env.SHARE_SITE || "https://notweeklyshorts.github.io/";
    let backOrigin = "";
    try {
        backOrigin = new URL(back).origin;
    } catch {}
    const invite = env.DISCORD_INVITE || "https://discord.gg/v5xrXSfvtE";
    const who = name ? '<p class="who">Signed in as <b>' + escapeHtml(name) + "</b></p>" : "";
    const join = kind === "linked" ? '<a class="button main" href="' + escapeHtml(invite) + '">Join the NSWS server</a>' : "";
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark"><meta name="robots" content="noindex"><title>${escapeHtml(title)} - Not So Weekly Shorts</title>
<style>
@font-face{font-family:ForcedSquare;src:url(${escapeHtml(site)}forced_square.woff2) format("woff2");}
html{background:#192042;}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:ForcedSquare,Arial,sans-serif;color:#fff;}
.box{width:min(460px,calc(100vw - 32px));padding:22px 24px 24px;box-sizing:border-box;background:#28346a;border-top:4px solid #5865f2;clip-path:polygon(0 0,100% 0,calc(100% - 12px) 100%,0 100%);}
h1{margin:0 0 10px;font-size:30px;font-weight:normal;font-style:italic;}
p{margin:0 0 12px;font-size:17px;line-height:1.4;color:rgba(255,255,255,.8);}
.who{color:rgba(255,255,255,.6);font-size:15px;}
.who b{color:#fff;font-weight:normal;}
.row{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px;}
.button{display:inline-block;padding:8px 16px;background:#112052;color:#fff;font-size:19px;text-decoration:none;border:0;font-family:inherit;cursor:pointer;clip-path:polygon(4px 0,100% 0,calc(100% - 4px) 100%,0 100%);}
.button:hover{background:#334b77;box-shadow:inset 0 -2px #fff;}
.button.main{box-shadow:inset 0 -3px #5865f2;}
</style></head><body><div class="box"><h1>${escapeHtml(title)}</h1>${who}<p>${escapeHtml(text)}</p>
<div class="row">${join}<a class="button" id="back" href="${escapeHtml(back)}">Back to NSWS</a></div></div>
<script>
(function(){var o=${JSON.stringify(backOrigin)};var k=${JSON.stringify(kind)};
var w=null;try{w=window.opener;}catch(e){}
if(w&&o){try{w.postMessage({nswsDiscord:k},o);}catch(e){}
document.getElementById("back").addEventListener("click",function(e){e.preventDefault();try{w.focus();}catch(x){}window.close();});
if(k==="joined"||k==="cancelled")setTimeout(function(){window.close();},2500);}})();
</script></body></html>`;
    return new Response(html, {
        status: 200,
        headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "X-Frame-Options": "DENY",
        },
    });
}

function backUrl(value, cfg, env) {
    try {
        const url = new URL(String(value ?? ""));
        if (cfg.allowedOrigins.includes(url.origin)) return url.origin + url.pathname;
    } catch {}
    return env.SHARE_SITE || "https://notweeklyshorts.github.io/";
}

// h: the Worker's own helpers ({ stub, json, plain, forbidden, corsHeaders, sha256Hex, readSmallBody, chatRetag, fromSite, origin, cfg }).
export async function handleDiscord(request, url, env, h) {
    const path = url.pathname.slice(DISCORD_PREFIX.length);
    const { stub, origin } = h;
    if (path === "callback") {
        if (request.method !== "GET") return h.plain(405, "Method not allowed", null);
        if (!discordOn(env) || !stub) return h.plain(404, "Not found", null);
        const taken = await stub.discordTake(url.searchParams.get("state"));
        const fallback = env.SHARE_SITE || "https://notweeklyshorts.github.io/";
        if (!taken) return resultPage(env, "expired", fallback, null);
        if (url.searchParams.get("error") || !url.searchParams.get("code")) return resultPage(env, "cancelled", taken.back, null);
        const tokens = await tokenCall(env, url, { grant_type: "authorization_code", code: url.searchParams.get("code") });
        const user = tokens && await discordUser(env, tokens.access);
        if (!user) return resultPage(env, "failed", taken.back, null);
        const member = await inGuild(env, tokens.access);
        if (member !== true && member !== false) return resultPage(env, "failed", taken.back, user.name);
        const saved = await stub.discordSave(taken.userId, user.id, user.name, member, tokens);
        for (const retag of saved.retags) await h.chatRetag(env, retag);
        return resultPage(env, member ? "joined" : "linked", taken.back, user.name);
    }

    if (!h.fromSite) return h.forbidden();
    if (!DISCORD_POSTS.includes(url.pathname)) return h.plain(404, "Not found", origin);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: h.corsHeaders(origin) });
    if (request.method !== "POST") return h.plain(405, "Method not allowed", origin);
    if (!discordOn(env) || !stub) return h.plain(404, "Discord linking is off", origin);
    const raw = await h.readSmallBody(request, MAX_BODY);
    let body = null;
    try {
        body = JSON.parse(raw ?? "");
    } catch {}
    if (!HEX64.test(body?.userToken ?? "")) return h.plain(400, "Bad request", origin);
    const userId = await h.sha256Hex(body.userToken);

    if (path === "start") {
        const state = randomState();
        await stub.discordStart(userId, state, backUrl(body.back, h.cfg, env));
        const link = new URL(env.DISCORD_AUTHORIZE || AUTHORIZE);
        link.search = new URLSearchParams({
            client_id: env.DISCORD_CLIENT_ID,
            response_type: "code",
            redirect_uri: redirectUri(env, url),
            scope: SCOPES,
            state,
            prompt: "none",
        }).toString();
        return h.json({ url: link.toString() }, origin);
    }

    if (path === "unlink") {
        const changed = await stub.discordUnlink(userId);
        await h.chatRetag(env, changed.retag);
        return h.json(changed.state, origin);
    }

    const saved = await stub.discordTokens(userId);
    if (!saved) return h.json({ error: "missing" }, origin, 409);
    if (saved.inGuild || Date.now() - saved.checked < CHECK_GAP_MS) return h.json(await stub.tagState(userId), origin);
    let tokens = saved.access ? saved : null;
    let renewed = false;
    const renew = async () => {
        tokens = saved.refresh ? await tokenCall(env, url, { grant_type: "refresh_token", refresh_token: saved.refresh }) : null;
        renewed = !!tokens;
    };
    if (tokens && tokens.expires && tokens.expires < Date.now() + EXPIRY_MARGIN_MS) await renew();
    let member = tokens ? await inGuild(env, tokens.access) : "auth";
    if (member === "auth" && !renewed && saved.refresh) {
        await renew();
        member = tokens ? await inGuild(env, tokens.access) : "auth";
    }
    if (member === "auth") return h.json({ error: "relink" }, origin, 409);
    if (member === "busy") {
        // A refresh token works once, so the new pair must be kept even when the look itself failed.
        if (renewed) await stub.discordChecked(userId, false, tokens);
        return h.json({ error: "busy" }, origin, 502);
    }
    const changed = await stub.discordChecked(userId, member, renewed ? tokens : null);
    await h.chatRetag(env, changed.retag);
    return h.json(changed.state, origin);
}
