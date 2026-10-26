/**
 * TorBox CORS proxy — Cloudflare Worker.
 *
 * Locked down to the hosts the TorBox Lampa plugin actually needs:
 *  - api.torbox.app — TorBox API (Authorization is attached server-side)
 *  - public parser gateways — search only, no credentials forwarded
 *
 * The client sends the TorBox API key in the `X-Api-Key` header; the worker
 * converts it to `Authorization: Bearer <key>` ONLY for api.torbox.app, so the
 * key can never leak to a parser or any other host.
 *
 * Deploy: npx wrangler deploy (from this directory).
 */

const TORBOX_HOST = 'api.torbox.app';

// Add your custom parser domains here if you use any (plugin setting
// `torbox_custom_parsers`) — requests to hosts outside this list are rejected.
const ALLOWED_HOSTS = new Set([
  TORBOX_HOST,
  'jr.maxvol.pro',
  'jacred.xyz',
]);

const ALLOWED_METHODS = new Set(['GET', 'POST', 'HEAD']);

// Only these request headers are forwarded to the target — cookies and
// anything else the client attaches stay on the worker boundary.
const FORWARDED_HEADERS = ['accept', 'content-type', 'range'];

function corsHeaders(request) {
  const requested = request.headers.get('Access-Control-Request-Headers');
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': requested || 'Authorization, Content-Type, X-Api-Key',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

// Every response — including errors — must carry CORS headers, otherwise the
// browser hides the status/body from the plugin and it reports a generic
// network error instead of the real cause.
function corsError(request, message, status) {
  return new Response(message, { status, headers: corsHeaders(request) });
}

// -en fork: film scores from MDBList, the key stays here (secret MDBLIST_API_KEY).
// GET /mdblist/movie/<tmdb id> or /mdblist/show/<tmdb id> -> { "tomatoes": 96, "metacritic": 78, ... }
// POST /mdblist/movie or /mdblist/show with {"ids": [<tmdb id>, ...]} (up to 200) -> { "<id>": { ratings }, ... }
// X-RateLimit-Remaining is passed on so the plugin can stop poster lookups before the daily limit.
// Letterboxd `value` is 0-5 in a single answer but 0-10 in a batch answer; its `score` (0-100) is the same in both.
function ratingsOf(media) {
  const ratings = {};
  for (const r of media.ratings || []) {
    if (r.value != null) ratings[r.source] = r.source === 'letterboxd' && r.score != null ? r.score / 20 : r.value;
  }
  return ratings;
}

async function mdblist(request, env, type, id) {
  let res;
  if (id) {
    res = await fetch(`https://api.mdblist.com/tmdb/${type}/${id}?apikey=${env.MDBLIST_API_KEY}`);
  } else {
    let ids;
    try {
      ids = (await request.json()).ids;
    } catch {}
    if (!Array.isArray(ids) || !ids.length || ids.length > 200 || !ids.every((x) => /^\d+$/.test(String(x)))) {
      return corsError(request, 'Bad request: "ids" must be 1-200 TMDB ids.', 400);
    }
    res = await fetch(`https://api.mdblist.com/tmdb/${type}?apikey=${env.MDBLIST_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ids.map(String) }),
    });
  }
  if (!res.ok) return corsError(request, `MDBList ${res.status}`, res.status);
  const json = await res.json();
  let body = {};
  if (id) body = ratingsOf(json);
  else for (const m of Array.isArray(json) ? json : []) if (m.ids && m.ids.tmdb) body[m.ids.tmdb] = ratingsOf(m);
  return new Response(JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json',
      'X-RateLimit-Remaining': res.headers.get('X-RateLimit-Remaining') || '',
      'Access-Control-Expose-Headers': 'X-RateLimit-Remaining',
      ...corsHeaders(request),
    },
  });
}

// -en fork: film grades shared by every Lampa signed in to the same CUB account + profile (KV GRADES).
// The client sends its CUB sign-in (X-Cub-Token, X-Cub-Profile); we only ask CUB who it is, never store it.
// Only accounts listed in the CUB_ACCOUNTS secret may use it, so this worker isn't free storage for others.
const CUB_DOMAINS = ['cub.best', 'cub.black', 'cubnotrip.top'];
async function cubUser(request, env) {
  const token = request.headers.get('X-Cub-Token');
  const profile = request.headers.get('X-Cub-Profile') || '';
  if (!token || !/^\d*$/.test(profile)) return null;
  for (const domain of CUB_DOMAINS) {
    let json;
    try {
      json = await (await fetch(`https://${domain}/api/users/get`, { headers: { token, profile } })).json();
    } catch {
      continue; // mirror down, try the next
    }
    const id = json && json.user && json.user.id;
    if (!id || !String(env.CUB_ACCOUNTS || '').split(',').includes(String(id))) return null;
    return `${id}:${profile}`;
  }
  return null;
}

// POST /grades {"grades": {"movie_603": {g, t, card}, ...}} -> all grades of this account, merged:
// per film the newer `t` wins; g null = grade removed (kept so the removal reaches other devices).
async function grades(request, env) {
  const who = await cubUser(request, env);
  if (!who) return corsError(request, 'CUB sign-in required.', 401);
  let mine;
  try {
    mine = (await request.json()).grades;
  } catch {}
  if (!mine || typeof mine !== 'object' || Array.isArray(mine)) return corsError(request, 'Bad request: "grades" object expected.', 400);
  const all = (await env.GRADES.get(who, 'json')) || {};
  let changed = false;
  for (const [k, v] of Object.entries(mine)) {
    if (!/^(movie|tv)_\d+$/.test(k) || !v || typeof v.t !== 'number' || (all[k] && all[k].t >= v.t)) continue;
    all[k] = v;
    changed = true;
  }
  if (changed) await env.GRADES.put(who, JSON.stringify(all)); // KV free tier: 1,000 writes a day
  return new Response(JSON.stringify(all), { headers: { 'Content-Type': 'application/json', ...corsHeaders(request) } });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (!ALLOWED_METHODS.has(request.method)) {
      return corsError(request, 'Method not allowed.', 405);
    }

    if (new URL(request.url).pathname === '/grades' && request.method === 'POST') return grades(request, env);

    const scores = new URL(request.url).pathname.match(/^\/mdblist\/(movie|show)(?:\/(\d+))?$/);
    if (scores && (scores[2] || request.method === 'POST')) return mdblist(request, env, scores[1], scores[2]);

    const target = new URL(request.url).searchParams.get('url');
    if (!target) {
      return corsError(request, 'Bad request: "url" parameter is missing.', 400);
    }

    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch {
      return corsError(request, 'Bad request: "url" is not a valid URL.', 400);
    }

    if (targetUrl.protocol !== 'https:' && targetUrl.protocol !== 'http:') {
      return corsError(request, 'Bad request: only http(s) targets are allowed.', 400);
    }

    if (!ALLOWED_HOSTS.has(targetUrl.hostname)) {
      return corsError(request, `Forbidden: host "${targetUrl.hostname}" is not allowed.`, 403);
    }

    const headers = new Headers();
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }

    const apiKey = request.headers.get('X-Api-Key');
    if (apiKey && targetUrl.hostname === TORBOX_HOST) {
      headers.set('Authorization', `Bearer ${apiKey}`);
    }

    let response;
    try {
      response = await fetch(targetUrl.toString(), {
        method: request.method,
        headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
        redirect: 'follow',
      });
    } catch (e) {
      return corsError(request, e && e.message ? e.message : 'Upstream fetch failed.', 502);
    }

    const responseHeaders = new Headers(response.headers);
    for (const [key, value] of Object.entries(corsHeaders(request))) {
      responseHeaders.set(key, value);
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  },
};
