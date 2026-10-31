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

// lampa-native (~/IdeaProjects/lampa-native): the stick's home screen in one small response; the TMDB key
// stays here (secret TMDB_API_KEY: a 32-hex v3 key or a v4 read access token).
// GET /home -> {"rows": [[title, [[id, "movie"|"tv", name, year, poster_path, score, backdrop_path], ...]], ...]}
// Same rows as Lampa's TMDB home, all in English (TMDB en-US); score = TMDB × 10.
// Only what a card draws is sent, plus the backdrop so a film page loads it together with /card
// (TMDB's lists are ~10× bigger, see X-Raw-Bytes), and the stick's HTTP cache keeps it for an hour.
const HOME_ROWS = [
  ['Watching now', 'movie/now_playing'],
  ['Today in trend', 'trending/all/day'],
  ['Trending for the week', 'trending/all/week'],
  ['Watch in cinemas', 'movie/upcoming'],
  ['Popular films', 'movie/popular'],
  ['Popular TV shows', 'tv/popular'],
  ['Top movies', 'movie/top_rated'],
  ['Top series', 'tv/top_rated'],
];

function tmdb(env, path, query = '') {
  const key = env.TMDB_API_KEY;
  const v3 = /^[0-9a-f]{32}$/.test(key);
  const url = `https://api.themoviedb.org/3/${path}?language=en-US${query}${v3 ? `&api_key=${key}` : ''}`;
  return fetch(url, v3 ? {} : { headers: { Authorization: `Bearer ${key}` } });
}

async function home(request, env) {
  let rawBytes = 0;
  const rows = await Promise.all(HOME_ROWS.map(async ([title, path]) => {
    try {
      const res = await tmdb(env, path);
      if (!res.ok) return null;
      const text = await res.text();
      rawBytes += new TextEncoder().encode(text).length;
      const items = [];
      for (const m of JSON.parse(text).results || []) {
        const type = m.media_type || path.split('/')[0]; // trending mixes in people: skipped below
        if ((type !== 'movie' && type !== 'tv') || !m.poster_path) continue;
        // never null: the stick's org.json turns it into the text "null"
        items.push([m.id, type, m.title || m.name || '', (m.release_date || m.first_air_date || '').slice(0, 4),
          m.poster_path, Math.round((m.vote_average || 0) * 10), m.backdrop_path || '']);
      }
      return [title, items];
    } catch {
      return null; // one failed row shouldn't blank the whole screen
    }
  }));
  const ok = rows.filter(Boolean);
  if (!ok.length) return corsError(request, 'TMDB unavailable.', 502);
  return new Response(JSON.stringify({ rows: ok }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'max-age=3600',
      'X-Raw-Bytes': String(rawBytes),
      ...corsHeaders(request),
    },
  });
}

// GET /card/movie/<tmdb id> or /card/tv/<tmdb id> -> lampa-native's film page, ready to draw (native.test.js):
// {name, original, line, overview, scores: [[label, text, 0-100]], seasons: [[label, text, 0-100]], people}
// The verdict comes first in scores: the same weighted average as ratings-patch.js (keep the two in step).
const NORM = { tomatoes: 1, metacritic: 1, rogerebert: 25, imdb: 10, letterboxd: 20, kp: 10, trakt: 1, tmdb: 1, metacriticuser: 10 };
const WEIGHTS = { tomatoes: 4, metacritic: 3, imdb: 3, kp: 2, rogerebert: 1, trakt: 1, tmdb: 1, metacriticuser: 1, letterboxd: 0.5 };
const VERDICTS = [[80, 'Excellent'], [70, 'Good'], [60, 'Decent'], [50, 'Mixed'], [0, 'Poor']];
const SHOW = [['imdb', 'IMDb', (v) => v.toFixed(1)], ['tomatoes', 'RT', (v) => v + '%'], ['metacritic', 'MC', String],
  ['letterboxd', 'LB', (v) => v.toFixed(1)]];

async function filmCard(request, env, type, id) {
  const mdbType = type === 'tv' ? 'show' : 'movie';
  const [res, r] = await Promise.all([
    tmdb(env, `${type}/${id}`, '&append_to_response=credits'),
    fetch(`https://api.mdblist.com/tmdb/${mdbType}/${id}?apikey=${env.MDBLIST_API_KEY}`)
      .then((x) => (x.ok ? x.json() : {})).then(ratingsOf).catch(() => ({})), // no scores beats no page
  ]);
  if (!res.ok) return corsError(request, `TMDB ${res.status}`, res.status === 404 ? 404 : 502);
  const m = await res.json();

  const scores = [];
  const got = Object.keys(WEIGHTS).filter((k) => r[k] > 0);
  if (got.length >= 3) {
    const sum = (f) => got.reduce((s, k) => s + f(k), 0);
    const v = Math.round(sum((k) => r[k] * NORM[k] * WEIGHTS[k]) / sum((k) => WEIGHTS[k]));
    scores.push([VERDICTS.find(([min]) => v >= min)[1], String(v), v]);
  }
  if (m.vote_average > 0) scores.push(['TMDB', m.vote_average.toFixed(1), Math.round(m.vote_average * 10)]);
  for (const [k, label, f] of SHOW) if (r[k] > 0) scores.push([label, f(r[k]), Math.round(r[k] * NORM[k])]);

  const runtime = m.runtime > 0 ? `${m.runtime >= 60 ? Math.floor(m.runtime / 60) + 'h ' : ''}${m.runtime % 60}m` : '';
  const seasonCount = m.number_of_seasons > 0 ? `${m.number_of_seasons} season${m.number_of_seasons > 1 ? 's' : ''}` : '';
  const names = (list) => (list || []).map((p) => p.name).join(', ');
  const makers = type === 'tv' ? ['Created by', names(m.created_by)]
    : ['Director', names((m.credits?.crew || []).filter((p) => p.job === 'Director'))];
  const cast = names((m.credits?.cast || []).slice(0, 6));
  const name = m.title || m.name || '';
  const original = m.original_title || m.original_name || '';

  return new Response(JSON.stringify({
    name,
    original: original === name ? '' : original,
    line: [(m.release_date || m.first_air_date || '').slice(0, 4), runtime, seasonCount, names(m.genres)]
      .filter(Boolean).join(' · '),
    overview: m.overview || '',
    scores,
    seasons: (m.seasons || []).filter((s) => s.season_number > 0 && s.vote_average > 0)
      .map((s) => [`S${s.season_number}`, s.vote_average.toFixed(1), Math.round(s.vote_average * 10)]),
    people: [makers[1] && `${makers[0]} ${makers[1]}`, cast && `Cast ${cast}`].filter(Boolean).join(' · '),
  }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'max-age=86400', // a day: MDBList allows 1,000 lookups a day
      ...corsHeaders(request),
    },
  });
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
    if (new URL(request.url).pathname === '/home' && request.method === 'GET') return home(request, env);
    const film = new URL(request.url).pathname.match(/^\/card\/(movie|tv)\/(\d+)$/);
    if (film && request.method === 'GET') return filmCard(request, env, film[1], film[2]);

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
