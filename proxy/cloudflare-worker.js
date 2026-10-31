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
// CUB's API with the client's sign-in: the first mirror that answers JSON (its errors too: {error, code}), or null.
// form: a POST as Lampa sends it.
async function cubApi(request, path, form) {
  const token = request.headers.get('X-Cub-Token');
  const profile = request.headers.get('X-Cub-Profile') || '';
  if (!token || !/^\d*$/.test(profile)) return null;
  for (const domain of CUB_DOMAINS) {
    try {
      return await (await fetch(`https://${domain}/api/${path}`, form
        ? { method: 'POST', headers: { token, profile }, body: new URLSearchParams(form) }
        : { headers: { token, profile } })).json();
    } catch {
      // mirror down, try the next
    }
  }
  return null;
}

async function cubUser(request, env) {
  const json = await cubApi(request, 'users/get');
  const id = json && json.user && json.user.id;
  if (!id || !String(env.CUB_ACCOUNTS || '').split(',').includes(String(id))) return null;
  return `${id}:${request.headers.get('X-Cub-Profile') || ''}`;
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

function tmdb(env, path, query = '', language = 'en-US') {
  const key = env.TMDB_API_KEY;
  const v3 = /^[0-9a-f]{32}$/.test(key);
  const url = `https://api.themoviedb.org/3/${path}?language=${language}${query}${v3 ? `&api_key=${key}` : ''}`;
  return fetch(url, v3 ? {} : { headers: { Authorization: `Bearer ${key}` } });
}

// A Home card: [id, type, name, year, poster_path, score, backdrop_path]. Never null: the stick's org.json turns it
// into the text "null".
function cardOf(m, type) {
  return [m.id, type, m.title || m.name || '', (m.release_date || m.first_air_date || '').slice(0, 4),
    m.poster_path, Math.round((m.vote_average || 0) * 10), m.backdrop_path || ''];
}

// A GET answer kept at this Cloudflare location for its max-age (Cache API): asked again, nothing is fetched. The
// stick asks for a film's /card ahead, while focus rests on its card: a film costs one MDBList lookup a day.
async function edgeCached(request, ctx, make) {
  if (typeof caches === 'undefined') return make(); // node tests without it
  const hit = await caches.default.match(request);
  if (hit) return hit;
  const res = await make();
  if (res.ok) {
    const put = caches.default.put(request, res.clone());
    if (ctx) ctx.waitUntil(put);
    else await put;
  }
  return res;
}

// lampa-native's search predictions (titles.sql): ~1000 well-known films and series, refreshed daily by two crons
// because the free plan allows 50 calls a run: English names with the original titles, then the Russian names.
const TITLE_CRONS = { '7 3 * * *': 'en-US', '37 3 * * *': 'ru-RU' };
const TITLE_LISTS = [ // [path, query, pages]: 45 calls
  ['discover/movie', '&sort_by=vote_count.desc', 20], ['discover/tv', '&sort_by=vote_count.desc', 10],
  ['movie/popular', '', 5], ['tv/popular', '', 5],
  ['discover/movie', '&sort_by=vote_count.desc&with_original_language=ru', 3],
  ['discover/tv', '&sort_by=vote_count.desc&with_original_language=ru', 2],
];

// Search words: lower case, ё as е, letters and digits only, a space on each side: LIKE '% word%' = a word's start.
const words = (s) => ` ${String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;

async function refreshTitles(env, language) {
  const calls = TITLE_LISTS.flatMap(([path, query, pages]) =>
    Array.from({ length: pages }, (_, i) => [path, `${query}&page=${i + 1}`]));
  const found = new Map();
  await Promise.all(calls.map(async ([path, query]) => {
    try {
      const res = await tmdb(env, path, query, language);
      if (!res.ok) return;
      const type = path.includes('tv') ? 'tv' : 'movie';
      for (const m of (await res.json()).results || []) if (m.poster_path) found.set(`${type}:${m.id}`, { type, m });
    } catch {
      // one page less until tomorrow
    }
  }));
  const rows = [...found.values()];
  if (language === 'ru-RU') { // Russian names for the titles the English run stored; it adds none
    await env.DB.prepare(`UPDATE titles SET ru = j.value->>'ru' FROM json_each(?) AS j
      WHERE titles.type = j.value->>'type' AND titles.id = j.value->>'id'`)
      .bind(JSON.stringify(rows.map(({ type, m }) => ({ type, id: m.id, ru: words(m.title || m.name) })))).run();
    return;
  }
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO titles (type, id, card, votes, seen, en)
      SELECT value->>'type', value->>'id', value->>'card', value->>'votes', ?2, value->>'en' FROM json_each(?1) WHERE true
      ON CONFLICT (type, id) DO UPDATE SET card = excluded.card, votes = excluded.votes, seen = excluded.seen,
        en = excluded.en`)
    .bind(JSON.stringify(rows.map(({ type, m }) => ({ type, id: m.id, card: JSON.stringify(cardOf(m, type)),
      votes: m.vote_count || 0, en: words(`${m.title || m.name} ${m.original_title || m.original_name || ''}`) }))), now)
    .run();
  await env.DB.prepare('DELETE FROM titles WHERE seen < ?').bind(now - 30 * 86400e3).run(); // off every list a month
}

// GET /search?q=<text> -> lampa-native's search, as Home cards: well-known titles with a word starting so (the
// index above, most voted first: one letter is enough), then from three letters TMDB's own search, each title once.
// A Cyrillic query finds the Russian names. An hour in caches (TMDB may have failed); nothing found isn't kept.
async function search(request, env) {
  const q = (new URL(request.url).searchParams.get('q') || '').trim().slice(0, 100);
  const w = words(q).trim();
  const [known, found] = !w ? [[], []] : await Promise.all([
    env.DB ? env.DB.prepare(`SELECT card FROM titles WHERE en || ru LIKE ? ORDER BY votes DESC LIMIT ?`)
      .bind(`% ${w}%`, w.length >= 3 ? 10 : 20).all().then((r) => r.results.map((x) => JSON.parse(x.card)))
      .catch(() => []) : [],
    w.length < 3 ? [] : tmdb(env, 'search/multi', `&include_adult=false&query=${encodeURIComponent(q)}`)
      .then((res) => (res.ok ? res.json() : {})).then((o) => (o.results || [])
        .filter((m) => (m.media_type === 'movie' || m.media_type === 'tv') && m.poster_path)
        .map((m) => cardOf(m, m.media_type))).catch(() => []),
  ]);
  const seen = new Set();
  const results = [...known, ...found].filter((c) => !seen.has(`${c[1]}:${c[0]}`) && seen.add(`${c[1]}:${c[0]}`))
    .slice(0, 20);
  return new Response(JSON.stringify({ results }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': results.length ? 'max-age=3600' : 'no-store', ...corsHeaders(request) },
  });
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
        if ((type === 'movie' || type === 'tv') && m.poster_path) items.push(cardOf(m, type));
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
// {name, original, line, overview, scores: [[label, text, 0-100]], seasons: [[label, text, 0-100]], imdb,
//  episodes: [[season, count]], people, cast: [[name, character, profile_path]], collection, parts: [Home card]}
// cast: the first 12 with a photo. parts: the other films of its collection (TMDB, one more call), oldest first;
// a film not out yet without a poster is left out.
// The verdict comes first in scores: the same weighted average as ratings-patch.js (keep the two in step).
const NORM = { tomatoes: 1, metacritic: 1, rogerebert: 25, imdb: 10, letterboxd: 20, kp: 10, trakt: 1, tmdb: 1, metacriticuser: 10 };
const WEIGHTS = { tomatoes: 4, metacritic: 3, imdb: 3, kp: 2, rogerebert: 1, trakt: 1, tmdb: 1, metacriticuser: 1, letterboxd: 0.5 };
const VERDICTS = [[80, 'Excellent'], [70, 'Good'], [60, 'Decent'], [50, 'Mixed'], [0, 'Poor']];
const SHOW = [['imdb', 'IMDb', (v) => v.toFixed(1)], ['tomatoes', 'RT', (v) => v + '%'], ['metacritic', 'MC', String],
  ['letterboxd', 'LB', (v) => v.toFixed(1)]];

async function filmCard(request, env, type, id) {
  const mdbType = type === 'tv' ? 'show' : 'movie';
  const [res, r] = await Promise.all([
    tmdb(env, `${type}/${id}`, '&append_to_response=credits,external_ids'),
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
  const set = m.belongs_to_collection;
  const collection = set ? await tmdb(env, `collection/${set.id}`).then((x) => (x.ok ? x.json() : {})).catch(() => ({})) : {};
  const parts = (collection.parts || []).filter((p) => p.poster_path && p.id !== Number(id))
    .sort((a, b) => (a.release_date || '9').localeCompare(b.release_date || '9')).map((p) => cardOf(p, 'movie'));

  const photos = (m.credits?.cast || []).filter((p) => p.profile_path).slice(0, 12)
    .map((p) => [p.name || '', p.character || '', p.profile_path]);
  return new Response(JSON.stringify({
    name,
    original: original === name ? '' : original,
    line: [(m.release_date || m.first_air_date || '').slice(0, 4), runtime, seasonCount, names(m.genres)]
      .filter(Boolean).join(' · '),
    overview: m.overview || '',
    scores,
    seasons: (m.seasons || []).filter((s) => s.season_number > 0 && s.vote_average > 0)
      .map((s) => [`S${s.season_number}`, s.vote_average.toFixed(1), Math.round(s.vote_average * 10)]),
    imdb: m.imdb_id || m.external_ids?.imdb_id || '', // for /streams; TV details carry it only in external_ids
    episodes: type === 'tv' ? (m.seasons || []).filter((s) => s.season_number > 0 && s.episode_count > 0)
      .map((s) => [s.season_number, s.episode_count]) : [],
    // the cast's names only when no one has a photo: else the photos row names them
    people: [makers[1] && `${makers[0]} ${makers[1]}`, !photos.length && cast && `Cast ${cast}`].filter(Boolean)
      .join(' · '),
    cast: photos,
    collection: parts.length ? collection.name || '' : '',
    parts,
  }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'max-age=86400', // a day: MDBList allows 1,000 lookups a day
      ...corsHeaders(request),
    },
  });
}

// GET /segments/movie/<tmdb id>/<imdb id> or /segments/tv/<tmdb id>/<imdb id>?e=1:9,1:10 (6 at most) -> what DDD can
// skip, in our DDD fork's "segments" format: {"1:9": "intro:0-58867;credits:3395489-"} (ms; no end: to the end of the
// video; a film's under "0:0"; none: left out). From IntroDB (introdb.app, by IMDb id) and TheIntroDB (theintrodb.org,
// by TMDB id): community timings, often one person's. Where they differ, the intro (recap) that ends first and the
// credits that start last: a wrong one leaves a few seconds of intro, never cuts the story. Kept in D1 (segments.sql)
// a week, a day when neither has any (they fill in); not when one was down. TheIntroDB without a key allows 5000
// asks a day per address, and Cloudflare's are shared (429): THEINTRODB_API_KEY (wrangler secret) lifts that. For the
// stick (X-Play-Token).
const SEGMENTS_MAX = 6;
const SEGMENTS_KEEP = 7 * 86400e3;
const SEGMENTS_NONE_KEEP = 86400e3;

// IntroDB's {intro, recap, outro: {start_ms, end_ms}} and TheIntroDB's {intro, recap, credits: [{start_ms, end_ms}]}
// (start null: from 0; end null: to the end) -> "intro:0-58867;credits:3395489-" ('' when none)
function mergeSegments(introdb, theintrodb) {
  const out = [];
  for (const kind of ['intro', 'recap', 'credits']) {
    const a = introdb?.[kind === 'credits' ? 'outro' : kind];
    const all = [...(a && typeof a === 'object' ? [a] : []), ...(Array.isArray(theintrodb?.[kind]) ? theintrodb[kind] : [])]
      .map((x) => [Math.round(Number(x.start_ms) || 0), x.end_ms == null ? null : Math.round(Number(x.end_ms))])
      .filter(([s, e]) => (kind === 'credits' ? s > 0 && (e === null || e > s) : e !== null && e > s));
    if (!all.length) continue;
    const [s, e] = all.reduce((m, x) => (kind === 'credits' ? (x[0] > m[0] ? x : m) : (x[1] < m[1] ? x : m)));
    out.push(`${kind}:${s}-${e ?? ''}`);
  }
  return out.join(';');
}

// One film's or episode's from both: {value, ok} (ok: both answered, 404 included: worth keeping)
async function fetchSegments(env, tmdb, imdb, season, episode) {
  const ask = (url, headers = {}) => fetch(url, { headers, signal: AbortSignal.timeout(4000) })
    .then((r) => (r.ok ? r.json() : r.status === 404 ? {} : (console.log('segments', r.status, url), null)))
    .catch((e) => (console.log('segments', String(e), url), null));
  const ep = `&season=${season}&episode=${episode}`;
  const [a, b] = await Promise.all([
    ask(`https://api.introdb.app/segments?imdb_id=${imdb}${season ? ep : '&is_movie=true'}`),
    ask(`https://api.theintrodb.org/v4/media?tmdb_id=${tmdb}${season ? ep : ''}`,
      env.THEINTRODB_API_KEY ? { Authorization: `Bearer ${env.THEINTRODB_API_KEY}` } : {}),
  ]);
  return { value: mergeSegments(a, b), ok: a !== null && b !== null };
}

async function segments(request, env, type, tmdb, imdb) {
  if (!sameSecret(request.headers.get('X-Play-Token'), env.PLAY_TOKEN)) return corsError(request, 'Forbidden.', 403);
  const eps = type === 'movie' ? [[0, 0]] : (new URL(request.url).searchParams.get('e') || '').split(',')
    .map((x) => x.match(/^(\d{1,2}):(\d{1,3})$/)).filter(Boolean).map((m) => [Number(m[1]), Number(m[2])])
    .slice(0, SEGMENTS_MAX);
  const key = ([s, e]) => `${type}/${tmdb}/${s}/${e}`;
  const now = Date.now();
  const kept = new Map();
  if (env.DB && eps.length) {
    try {
      const rows = (await env.DB.prepare('SELECT key, value, t FROM segments WHERE key IN (SELECT value FROM json_each(?))')
        .bind(JSON.stringify(eps.map(key))).all()).results;
      for (const r of rows) if (r.t > now - (r.value ? SEGMENTS_KEEP : SEGMENTS_NONE_KEEP)) kept.set(r.key, r.value);
    } catch { /* no cache beats no answer */ }
  }
  const got = await Promise.all(eps.filter((x) => !kept.has(key(x)))
    .map(async (x) => ({ k: key(x), ...(await fetchSegments(env, tmdb, imdb, x[0], x[1])) })));
  const fresh = got.filter((g) => g.ok);
  if (env.DB && fresh.length) {
    await env.DB.prepare(`INSERT INTO segments (key, value, t) SELECT j.value->>'k', j.value->>'v', ?
      FROM json_each(?) AS j WHERE true ON CONFLICT (key) DO UPDATE SET value = excluded.value, t = excluded.t`)
      .bind(now, JSON.stringify(fresh.map((g) => ({ k: g.k, v: g.value })))).run().catch(() => {});
  }
  for (const g of got) kept.set(g.k, g.value);
  const body = {};
  for (const x of eps) if (kept.get(key(x))) body[`${x[0]}:${x[1]}`] = kept.get(key(x));
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(request) },
  });
}

// GET /streams/movie/<imdb id> or /streams/series/<imdb id>/<season>/<episode>[?lang=RU,UA][&from=6] -> lampa-native's
// sources: {streams: [[hash, fileIdx, title, badges, size, seeders, tracker, languages, cached]], next, total,
// languages: [[code, releases]]}. Torrentio's list (Cloudflare caches it: 3-8 ms from here), each torrent once,
// only the asked audio languages (none = all), biggest first. TorBox's cache is checked for the first FIRST only
// (5 rows fit on the stick's screen, measured; +1 half seen) so they come fast; the app asks from=FIRST for the rest.
// cached: 1 yes, 0 no, -1 unknown (no TORBOX_API_KEY secret, or TorBox down).
// POST, the same path: Torrentio's answer in the body, from the stick. Torrentio answers here 429 at times
// (Cloudflare's IPs are shared and rate-limited) while the stick's home IP gets it: the app then asks Torrentio
// itself and posts that here (≤ 4 MB; the stick's X-Play-Token only: a list spends TorBox checks on any hashes).
const FIRST = 6;
const MAX = 100;
// One badge per group, the first that matches: resolution, Dolby Vision, HDR, REMUX, codec, audio.
const BADGES = [
  [['4K', /\b(2160p|4k|uhd)\b/i], ['1080p', /\b1080p\b/i], ['720p', /\b720p\b/i]],
  [['DV', /\b(dv|dovi|dolby[ .]?vision)\b/i]],
  [['HDR10+', /hdr10(\+|plus)/i], ['HDR', /\bhdr(10)?\b/i]],
  [['REMUX', /remux/i]],
  [['HEVC', /\b(hevc|[xh]\.?265)\b/i], ['AV1', /\bav1\b/i]],
  [['Atmos', /atmos/i]],
  [['TrueHD', /truehd/i]],
  [['DTS', /\bdts/i]],
  [['DD+', /\b(ddp|dd\+|e-?ac-?3)/i], ['DD', /\b(ac-?3|dd[ .]?[257]\.[01])\b/i]],
];
const UNIT = { K: 1e3, M: 1e6, G: 1e9, T: 1e12 };

// Torrentio marks audio languages with country flags (🇬🇧 for English); no flags = an English release.
function languagesOf(line) {
  const codes = new Set();
  for (const [, a, b] of line.matchAll(/([\u{1F1E6}-\u{1F1FF}])([\u{1F1E6}-\u{1F1FF}])/gu)) {
    const code = String.fromCharCode(a.codePointAt(0) - 0x1f1a5, b.codePointAt(0) - 0x1f1a5);
    codes.add(code === 'GB' ? 'EN' : code);
  }
  return codes.size ? [...codes] : ['EN'];
}

async function cachedOnTorBox(env, hashes) {
  if (!env.TORBOX_API_KEY || !hashes.length) return null;
  try {
    const res = await fetch(`https://${TORBOX_HOST}/v1/api/torrents/checkcached?hash=${hashes.join(',')}` +
      '&format=list&list_files=false', { headers: { Authorization: `Bearer ${env.TORBOX_API_KEY}` } }); // not in the URL
    if (!res.ok) return null;
    return new Set(((await res.json()).data || []).map((t) => String(t.hash).toLowerCase()));
  } catch {
    return null;
  }
}

async function sources(request, env, kind, imdb, season, episode) {
  let list;
  if (request.method === 'POST') {
    if (!sameSecret(request.headers.get('X-Play-Token'), env.PLAY_TOKEN)) return corsError(request, 'Forbidden.', 403);
    const text = await request.text();
    if (text.length > 4e6) return corsError(request, 'Too big.', 413);
    try {
      list = JSON.parse(text).streams;
    } catch {
      // not JSON: refused below
    }
    if (!Array.isArray(list)) return corsError(request, 'Not Torrentio\'s answer.', 400);
  } else {
    try {
      const id = kind === 'series' ? `${imdb}:${season}:${episode}` : imdb;
      const res = await fetch(`https://torrentio.strem.fun/stream/${kind}/${id}.json`);
      if (!res.ok) throw new Error(String(res.status));
      list = (await res.json()).streams || [];
    } catch (e) {
      console.log('Torrentio', kind, String(e)); // wrangler tail: its status (429: rate-limited) or the parse error
      return corsError(request, 'Torrentio unavailable.', 502);
    }
  }
  const seen = new Set();
  const all = [];
  for (const st of list) {
    const hash = String(st.infoHash || '').toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(hash) || seen.has(hash)) continue;
    seen.add(hash);
    // title: "<torrent name>\n[<file in it>\n]👤 <seeders> 💾 <size> ⚙️ <tracker>[\n<language flags>]"
    const lines = String(st.title || '').split('\n');
    const at = lines.findIndex((l) => l.includes('👤'));
    const stats = at >= 0 ? lines[at] : '';
    const size = (stats.match(/💾\s*([\d.]+\s*[KMGT]B)/) || [])[1] || '';
    const filename = st.behaviorHints?.filename;
    const text = `${st.name || ''} ${lines[0]} ${filename || ''}`;
    const badges = BADGES.map((group) => group.find(([, re]) => re.test(text))?.[0]).filter(Boolean);
    all.push({
      bytes: parseFloat(size) * (UNIT[(size.match(/([KMGT])B/) || [])[1]] || 0) || 0,
      row: [hash, st.fileIdx ?? -1, filename || lines[0], badges, size, Number((stats.match(/👤\s*(\d+)/) || [])[1]) || 0,
        ((stats.match(/⚙️\s*(.+)/) || [])[1] || '').trim(), languagesOf((at >= 0 && lines[at + 1]) || '')],
    });
  }
  const languages = new Map();
  for (const { row } of all) for (const code of row[7]) languages.set(code, (languages.get(code) || 0) + 1);
  const params = new URL(request.url).searchParams;
  const wanted = new Set((params.get('lang') || '').split(',').filter(Boolean));
  const shown = all.filter(({ row }) => !wanted.size || row[7].some((code) => wanted.has(code)))
    .sort((a, b) => b.bytes - a.bytes).slice(0, MAX); // stable: equal sizes keep Torrentio's order
  const from = Number(params.get('from')) || 0;
  const batch = shown.slice(from, from ? MAX : FIRST).map(({ row }) => row);
  const cached = await cachedOnTorBox(env, batch.map(([hash]) => hash));
  for (const row of batch) row.push(cached ? Number(cached.has(row[0])) : -1);
  return new Response(JSON.stringify({
    streams: batch,
    next: !from && shown.length > FIRST ? FIRST : 0,
    total: shown.length,
    languages: [...languages].sort((a, b) => b[1] - a[1]),
  }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'max-age=600', // what TorBox has cached changes slowly
      ...corsHeaders(request),
    },
  });
}

// GET /play/<info hash>?file=<Torrentio's fileIdx>&name=<its file name>&tl=<Lampa timeline hash> with header
// X-Play-Token -> {url, time, percent} for DDD (time: the resume point in seconds from /timeline, 0 = none), or
// 202 {progress} while TorBox is still downloading it. Adds the torrent to the TorBox account (one already there
// is found in the list), picks the file Torrentio meant (by name, else its index, else the biggest video) and asks
// for its link. Only for the stick: the route spends the account, so it needs the secret PLAY_TOKEN, which the app
// keeps in its private storage (lampa-native/set-play-token.sh). Links expire: never cached.
// &series=<original name> (an episode): also {playlist: [[season, episode, key, file name, link], ...]} from it on,
// and url is the first one's link (episodesFrom).
const TORBOX_API = 'https://api.torbox.app/v1/api/torrents/';
const VIDEO = /\.(mkv|mp4|m4v|avi|mov|webm|ts|m2ts|wmv)$/i;

function sameSecret(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i); // no early exit: constant time
  return diff === 0;
}

async function torboxApi(env, path, init = {}) {
  const res = await fetch(TORBOX_API + path, { ...init, headers: { Authorization: `Bearer ${env.TORBOX_API_KEY}` } });
  if (!res.ok && res.status >= 500) throw new Error(`TorBox ${res.status}`);
  return res.json();
}

async function resumePoint(env, tl) {
  if (!tl || !env.DB) return { time: 0, percent: 0 };
  try {
    const t = await env.DB.prepare('SELECT time, percent FROM timeline WHERE hash = ?').bind(tl).first();
    return { time: t?.time ?? 0, percent: t?.percent ?? 0 };
  } catch {
    return { time: 0, percent: 0 }; // no resume point beats no film
  }
}

async function play(request, env, ctx, hash) {
  if (!sameSecret(request.headers.get('X-Play-Token'), env.PLAY_TOKEN)) return corsError(request, 'Forbidden.', 403);
  const q = new URL(request.url).searchParams;
  const fileIdx = Number(q.get('file') ?? -1);
  const name = q.get('name') || '';
  const resume = resumePoint(env, q.get('tl')); // alongside TorBox's three calls
  try {
    const form = new FormData();
    form.append('magnet', `magnet:?xt=urn:btih:${hash}`);
    const added = await torboxApi(env, 'createtorrent', { method: 'POST', body: form });
    let id = added?.data?.torrent_id ?? added?.data?.id;
    if (id === undefined) { // already in the account (or refused): look for it there
      const all = await torboxApi(env, 'mylist?bypass_cache=true');
      id = (all?.data || []).find((t) => String(t.hash).toLowerCase() === hash)?.id;
    }
    if (id === undefined) return corsError(request, added?.detail || added?.error || 'TorBox refused it.', 502);
    const t = (await torboxApi(env, `mylist?id=${id}&bypass_cache=true`))?.data;
    if (!t) return corsError(request, 'TorBox lost it.', 502);
    if (!t.download_present) {
      return new Response(JSON.stringify({ progress: Math.round((t.progress || 0) * 100) }), {
        status: 202, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(request) },
      });
    }
    const files = t.files || [];
    const file = (name && files.find((f) => f.short_name === name || String(f.name).split('/').pop() === name))
      || files.find((f) => f.id === fileIdx && VIDEO.test(f.name))
      || files.filter((f) => VIDEO.test(f.name)).sort((a, b) => b.size - a.size)[0];
    if (!file) return corsError(request, 'No video in it.', 404);
    // requestdl takes the key as a parameter (it is built for browser redirects); server to server only
    const dl = await torboxApi(env, `requestdl?token=${encodeURIComponent(env.TORBOX_API_KEY)}&torrent_id=${id}&file_id=${file.id}`);
    if (typeof dl?.data !== 'string') return corsError(request, dl?.detail || 'No link.', 502);
    const playlist = q.has('series') ? await episodesFrom(request, env, ctx, id, files, file, q.get('series'), dl.data) : [];
    return new Response(JSON.stringify(playlist.length
      ? { url: playlist[0][4], ...(await resume), playlist } : { url: dl.data, ...(await resume) }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(request) },
    });
  } catch {
    return corsError(request, 'TorBox unavailable.', 502);
  }
}

// A series' episode in a file name: S01E09 (S1.E9, S01 E09) or 1x09; null when it says none.
function episodeOf(name) {
  const m = String(name).match(/S(\d{1,2})[ ._-]?E(\d{1,3})(?!\d)/i) || String(name).match(/(?:^|[^\d])(\d{1,2})x(\d{2,3})(?!\d)/i);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

// Lampa's timeline key of an episode (as the app's Timeline.key): season, ':' after season 10, episode, original name.
const episodeKey = ([s, e], original) => lampaHash(`${s}${s > 10 ? ':' : ''}${e}${original}`);

// A series played from a torrent with more episodes (a season's, a series'): the episode asked for and the ones after
// it in the torrent, in order, for DDD's playlist: DDD goes on to the next by itself (user, 2026-10-31). Each as
// [season, episode, Lampa's key, file name, link]: the link is this worker's /stream address of that file, the same
// every time (DDD keeps its own resume point per address), which gets TorBox's link when DDD asks for it (TorBox's
// links don't live for a whole night of episodes). 30 at most; none when the file names say no episode.
async function episodesFrom(request, env, ctx, torrent, files, file, original, link) {
  if (!episodeOf(file.short_name || file.name)) return [];
  const all = files.filter((f) => VIDEO.test(f.name) && !/\bsample\b/i.test(f.name))
    .map((f) => ({ f, at: episodeOf(f.short_name || f.name) })).filter((x) => x.at)
    .sort((a, b) => a.at[0] - b.at[0] || a.at[1] - b.at[1] || b.f.size - a.f.size)
    .filter((x, i, a) => !i || x.at[0] !== a[i - 1].at[0] || x.at[1] !== a[i - 1].at[1]); // two of one: the bigger
  const from = all.findIndex((x) => x.f.id === file.id);
  if (from < 0) return [];
  const origin = new URL(request.url).origin;
  await keepLink(ctx, origin, torrent, file.id, link); // DDD's first ask for it costs no TorBox call
  return Promise.all(all.slice(from, from + 30).map(async (x, i) => {
    const key = episodeKey(x.at, original);
    const prev = from + i > 0 ? episodeKey(all[from + i - 1].at, original) : '';
    const sig = await signed(env, `${torrent}/${x.f.id}/${key}/${prev}`);
    return [x.at[0], x.at[1], key, x.f.short_name || String(x.f.name).split('/').pop(),
      `${origin}/stream/${torrent}/${x.f.id}?tl=${key}&prev=${prev}&sig=${sig}`];
  }));
}

// HMAC-SHA-256 of a /stream address with PLAY_TOKEN, 32 hex: only addresses /play made are answered.
async function signed(env, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.PLAY_TOKEN), { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)));
  return [...mac.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// TorBox's link of a file kept at this Cloudflare location for half an hour (seeks ask /stream again), and a mark
// that the episode was streamed, for 3 hours (the next one's first ask then marks it watched).
const LINK_S = 1800;
const SEEN_S = 3 * 3600;
const cacheKey = (origin, what) => new Request(`${origin}/__cache/${what}`);
async function keepLink(ctx, origin, torrent, fileId, link, key) {
  if (typeof caches === 'undefined') return;
  const puts = [caches.default.put(cacheKey(origin, `link/${torrent}/${fileId}`),
    new Response(link, { headers: { 'Cache-Control': `max-age=${LINK_S}` } }))];
  if (key) puts.push(caches.default.put(cacheKey(origin, `seen/${key}`), new Response('1', { headers: { 'Cache-Control': `max-age=${SEEN_S}` } })));
  const all = Promise.all(puts);
  if (ctx) ctx.waitUntil(all);
  else await all;
}
const cached = async (origin, what) => (typeof caches === 'undefined' ? null
  : caches.default.match(cacheKey(origin, what)).then((r) => (r ? r.text() : null)));

// GET /stream/<TorBox torrent id>/<file id>?tl=<Lampa key>&prev=<the previous episode's key>&sig=… (from /play) ->
// 302 to TorBox's link. The episode's first ask (no Range, or from byte 0) while the previous one was streamed in
// the last 3 hours means DDD went on from it (it asks for the next file only once the current one is all loaded,
// its last minutes) or the user went on by hand: the previous one is marked watched, so Continue goes on even when
// DDD never answers the app (the TV turned off, the app killed).
// ponytail: stopping episode 5 half way and starting 6 by hand within 3 hours marks 5 watched too
async function stream(request, env, ctx, torrent, fileId) {
  const q = new URL(request.url).searchParams;
  const tl = q.get('tl') || '';
  const prev = q.get('prev') || '';
  if (!/^\d{1,10}$/.test(tl) || !/^\d{0,10}$/.test(prev)
    || !sameSecret(q.get('sig') || '', await signed(env, `${torrent}/${fileId}/${tl}/${prev}`))) {
    return corsError(request, 'Forbidden.', 403);
  }
  const origin = new URL(request.url).origin;
  let link = await cached(origin, `link/${torrent}/${fileId}`);
  const first = !/^bytes=[1-9]/.test(request.headers.get('Range') || '');
  if (!link || first) {
    if (!link) {
      try {
        const dl = await torboxApi(env, `requestdl?token=${encodeURIComponent(env.TORBOX_API_KEY)}&torrent_id=${torrent}&file_id=${fileId}`);
        if (typeof dl?.data !== 'string') return corsError(request, dl?.detail || 'No link.', 502);
        link = dl.data;
      } catch {
        return corsError(request, 'TorBox unavailable.', 502);
      }
    }
    await keepLink(ctx, origin, torrent, fileId, link, tl);
  }
  if (first && prev && env.DB && await cached(origin, `seen/${prev}`)) {
    await env.DB.prepare(`INSERT INTO timeline (hash, time, duration, percent, updated) VALUES (?1, 0, 0, 100, ?2)
      ON CONFLICT (hash) DO UPDATE SET time = timeline.duration, percent = 100, updated = excluded.updated
      WHERE timeline.percent < 90`).bind(prev, Date.now()).run().catch(() => {}); // no mark beats no film
  }
  return new Response(null, { status: 302, headers: { Location: link, 'Cache-Control': 'no-store' } });
}

// GET /timeline[?hash=<hash>,…] -> {timelines: {hash: {time, duration, percent, updated[, card, season, episode]}}}
// POST /timeline {timelines: [{hash, time, duration, percent[, updated, card, season, episode]}]} -> 204
// Resume points shared by lampa-native and Lampa (the torbox-en plugin pulls them into Lampa's timeline and pushes
// its own), in D1 (proxy/timeline.sql), keyed by Lampa's hash of the title (+ season and episode); times in
// seconds. Per point the newer one wins (updated, ms; stamped here when missing, as from the stick). For the
// stick (X-Play-Token) and the CUB accounts in CUB_ACCOUNTS (checked with CUB, as /grades): one household's.
async function timelineAllowed(request, env) {
  return sameSecret(request.headers.get('X-Play-Token'), env.PLAY_TOKEN) || Boolean(await cubUser(request, env));
}

async function timeline(request, env) {
  if (!(await timelineAllowed(request, env))) return corsError(request, 'Forbidden.', 403);
  const json = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(request) };
  if (request.method === 'GET') {
    const only = new URL(request.url).searchParams.get('hash'); // a series' episodes: lampa-native's marks
    const { results } = await (only
      ? env.DB.prepare('SELECT * FROM timeline WHERE hash IN (SELECT value FROM json_each(?))')
        .bind(JSON.stringify(only.split(',').slice(0, 2000)))
      : env.DB.prepare('SELECT * FROM timeline')).all();
    const timelines = {};
    for (const { hash, card, season, episode, ...t } of results) {
      timelines[hash] = card ? { ...t, card, ...(season ? { season, episode } : {}) } : t;
    }
    return new Response(JSON.stringify({ timelines }), { headers: json });
  }
  const list = (await request.json().catch(() => ({}))).timelines;
  const ok = (t) => /^\d{1,10}$/.test(String(t?.hash)) && ['time', 'duration', 'percent'].every((k) => Number.isFinite(t[k]))
    && (t.updated === undefined || Number.isFinite(t.updated));
  if (!Array.isArray(list) || list.length > 2000 || !list.every(ok)) return corsError(request, 'Bad timeline.', 400);
  const now = Date.now();
  const int = (v) => (Number.isInteger(v) && v > 0 ? v : null);
  const rows = list.map((t) => ({
    hash: String(t.hash), time: Math.round(t.time), duration: Math.round(t.duration), percent: Math.round(t.percent),
    updated: Math.round(t.updated ?? now), card: /^(movie|tv)_\d+$/.test(t.card) ? t.card : null,
    season: int(t.season), episode: int(t.episode),
  }));
  // One query for any number of points (D1's free plan allows 50 queries per request): the rows as one JSON.
  await env.DB.prepare(`INSERT INTO timeline (hash, time, duration, percent, updated, card, season, episode)
    SELECT value->>'hash', value->>'time', value->>'duration', value->>'percent', value->>'updated', value->>'card',
      value->>'season', value->>'episode' FROM json_each(?) WHERE true
    ON CONFLICT (hash) DO UPDATE SET time = excluded.time, duration = excluded.duration, percent = excluded.percent,
      updated = excluded.updated, card = COALESCE(excluded.card, card), season = COALESCE(excluded.season, season),
      episode = COALESCE(excluded.episode, episode)
    WHERE excluded.updated > timeline.updated`).bind(JSON.stringify(rows)).run();
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

// Lampa's Utils.hash: Java's String.hashCode as a positive decimal. Its timeline keys a film by its original title.
function lampaHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return String(Math.abs(h));
}

// Home cards in English for CUB's cards (CUB keeps Lampa's card as it was shown: Russian names and posters from CUB's
// own lists): the search index's (titles), else TMDB's en-US, which then go into the index. [type, id] pairs in;
// a card for each, in order (TMDB failed or more than `fetchMax` missing: the card CUB kept).
async function englishCards(env, wanted, fallback, fetchMax = 20) {
  const pairs = JSON.stringify(wanted.map(([type, id]) => ({ type, id })));
  const known = new Map(env.DB ? (await env.DB.prepare(`SELECT t.type, t.id, t.card FROM titles t
      JOIN json_each(?) j ON t.type = j.value->>'type' AND t.id = j.value->>'id'`).bind(pairs).all()
    .then((r) => r.results).catch(() => [])).map((r) => [`${r.type}:${r.id}`, JSON.parse(r.card)]) : []);
  const missing = wanted.filter(([type, id]) => !known.has(`${type}:${id}`)).slice(0, fetchMax);
  const fetched = (await Promise.all(missing.map(([type, id]) => tmdb(env, `${type}/${id}`)
    .then((res) => (res.ok ? res.json() : null)).then((m) => (m && m.poster_path ? { type, m } : null))
    .catch(() => null)))).filter(Boolean);
  for (const { type, m } of fetched) known.set(`${type}:${m.id}`, cardOf(m, type));
  if (fetched.length && env.DB) {
    await env.DB.prepare(`INSERT INTO titles (type, id, card, votes, seen, en)
        SELECT value->>'type', value->>'id', value->>'card', value->>'votes', ?2, value->>'en' FROM json_each(?1) WHERE true
        ON CONFLICT (type, id) DO NOTHING`)
      .bind(JSON.stringify(fetched.map(({ type, m }) => ({ type, id: m.id, card: JSON.stringify(cardOf(m, type)),
        votes: m.vote_count || 0, en: words(`${m.title || m.name} ${m.original_title || m.original_name || ''}`) }))),
      Date.now()).run().catch(() => {}); // next time from TMDB again
  }
  return wanted.map(([type, id], i) => known.get(`${type}:${id}`) || fallback[i]);
}

// Series' last aired episode ("season:episode"), original name (Lampa's keys) and English card, from TMDB, kept a
// day in D1 (shows.sql): a series leaves Continue browsing once that episode is watched (Carrie, user 2026-10-31)
// and comes back when a new one airs. At most SHOW_FETCH asked of TMDB a request (the free plan's 50 subrequests);
// the others on the next asks. ids in, id → {original, last, card} out.
const SHOW_TTL = 86400e3;
const SHOW_FETCH = 15;
async function shows(env, ids) {
  const now = Date.now();
  const have = new Map(env.DB && ids.length ? (await env.DB.prepare(
    'SELECT id, original, last, card, t FROM shows WHERE id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(ids)).all().then((r) => r.results).catch(() => [])).map((r) => [r.id, r]) : []);
  const stale = ids.filter((id) => !have.has(id) || now - have.get(id).t > SHOW_TTL).slice(0, SHOW_FETCH);
  const got = (await Promise.all(stale.map((id) => tmdb(env, `tv/${id}`).then((res) => (res.ok ? res.json() : null))
    .catch(() => null)))).filter((m) => m && m.id && m.poster_path);
  const rows = got.map((m) => {
    const l = m.last_episode_to_air;
    return { id: m.id, original: m.original_name || m.name || '', last: l ? `${l.season_number}:${l.episode_number}` : '',
      card: JSON.stringify(cardOf(m, 'tv')), t: now };
  });
  for (const r of rows) have.set(r.id, r);
  if (rows.length && env.DB) {
    await env.DB.prepare(`INSERT INTO shows (id, original, last, card, t)
        SELECT value->>'id', value->>'original', value->>'last', value->>'card', value->>'t' FROM json_each(?) WHERE true
        ON CONFLICT (id) DO UPDATE SET original = excluded.original, last = excluded.last, card = excluded.card, t = excluded.t`)
      .bind(JSON.stringify(rows)).run().catch(() => {}); // asked again next time
  }
  return have;
}

// Lampa's marks (favorite.js; one at a time): Looking, Viewed, Scheduled, To be continued, Thrown. The app's Finish
// later is Scheduled, Not interested is Thrown, Watched it is Viewed: all three leave Continue browsing. CUB keeps
// marks for Premium accounts only (error 555 "Нет премиум доступа"), so the app's go to D1 (marks.sql), per account
// and profile like the grades; a Premium account's own CUB marks count too.
const MARKS = ['look', 'viewed', 'scheduled', 'continued', 'thrown'];
const FILM_STARTED_S = 300; // a film in Continue browsing: watched 5 min
const AWAY = new Set(['viewed', 'scheduled', 'thrown']);

// GET /mine with the app's CUB sign-in (X-Cub-Token, X-Cub-Profile; accounts in CUB_ACCOUNTS only, as /grades) ->
// {"rows": [...] as /home, "marks": {"tv_93740": "scheduled", ...}}: the rows of Lampa's CUB home that are yours,
// for the top of lampa-native's Home, and every film's mark (the film page's Mark button shows it).
// Continue browsing: Lampa's (favorite.js continues): the series in the history, newest first, 19 at most; here
// also the films being watched (5 min in, under 90 %: the timeline; shorter is a try of a release, its sound or a
// test: user 2026-10-31; their film page still resumes from 10 s), which Lampa's main screen leaves out. Out of it:
// Viewed, Thrown and Scheduled, and series whose last aired episode is watched. Finish later: the Scheduled ones.
// Never cached: it changes with every film played.
// CUB's dump (2026-10-31): {bookmarks: [{id, type, card_id, card_type: movie|tv, time (ms), data: Lampa's card as
// JSON text, …}]}, oldest first: ~320 KB for 365 history entries. Only the newest 100 history cards are parsed (the
// free plan's 10 ms of CPU a request; Lampa keeps 100 in its own history).
async function mine(request, env) {
  const who = await cubUser(request, env);
  if (!who) return corsError(request, 'CUB sign-in required.', 401);
  const [dump, ours] = await Promise.all([cubApi(request, 'bookmarks/dump'), env.DB
    ? env.DB.prepare('SELECT card, mark FROM marks WHERE who = ?').bind(who).all().then((r) => r.results).catch(() => [])
    : []]);
  if (!dump || !Array.isArray(dump.bookmarks)) return corsError(request, 'CUB unavailable.', 502);
  const marks = {};
  for (const b of dump.bookmarks) if (MARKS.includes(b.type) && /^(movie|tv)$/.test(b.card_type)) marks[`${b.card_type}_${b.card_id}`] = b.type;
  for (const m of ours) marks[m.card] = m.mark;
  const parsed = (b) => {
    try {
      const card = typeof b.data === 'string' ? JSON.parse(b.data) : b.data;
      return card && card.id && (!card.source || /^(tmdb|cub)$/i.test(card.source)) ? { type: b.card_type, card } : null; // others: no TMDB id
    } catch {
      return null;
    }
  };
  const newest = (type) => dump.bookmarks.filter((b) => b.type === type && /^(movie|tv)$/.test(b.card_type))
    .sort((a, b) => (Number(b.time) || 0) - (Number(a.time) || 0));
  const markOf = (b) => marks[`${b.card_type}_${b.card_id}`];
  const all = newest('history');
  const history = all.filter((b) => !AWAY.has(markOf(b))).slice(0, 100).map(parsed).filter(Boolean);
  const laterIds = new Set();
  const later = [...all.filter((b) => markOf(b) === 'scheduled'), ...newest('scheduled')]
    .filter((b) => !laterIds.has(`${b.card_type}_${b.card_id}`) && laterIds.add(`${b.card_type}_${b.card_id}`))
    .slice(0, 40).map(parsed).filter(Boolean);
  const series = history.filter((h) => h.type === 'tv').slice(0, 30);
  const info = await shows(env, [...new Set([...series, ...later.filter((h) => h.type === 'tv')].map((h) => Number(h.card.id)))]);
  const hash = (c) => lampaHash(c.original_title || c.title || '');
  const lastKey = (h) => {
    const s = info.get(Number(h.card.id));
    return s && s.last ? episodeKey(s.last.split(':').map(Number), s.original) : null;
  };
  const keys = [...history.filter((h) => h.type === 'movie').map((h) => hash(h.card)), ...series.map(lastKey).filter(Boolean)];
  const points = new Map(keys.length && env.DB ? (await env.DB.prepare(
    'SELECT hash, time, percent FROM timeline WHERE hash IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(keys)).all().then((r) => r.results).catch(() => [])).map((p) => [p.hash, p]) : []);
  const going = (h) => {
    if (h.type === 'tv') return series.includes(h) && !(points.get(lastKey(h))?.percent >= 90);
    const p = points.get(hash(h.card));
    return p && p.time >= FILM_STARTED_S && p.percent < 90;
  };
  const rows = [];
  for (const [title, list] of [['Continue browsing', history.filter(going).slice(0, 19)], ['Finish later', later]]) {
    // English: a series' from shows, the others from the search index or TMDB
    const rest = list.filter((h) => !(h.type === 'tv' && info.has(Number(h.card.id))));
    const english = await englishCards(env, rest.map((h) => [h.type, Number(h.card.id)]), rest.map((h) => cardOf(h.card, h.type)), 10);
    const cards = list.map((h) => (h.type === 'tv' && info.has(Number(h.card.id))
      ? JSON.parse(info.get(Number(h.card.id)).card) : english[rest.indexOf(h)]));
    if (cards.length) rows.push([title, cards]);
  }
  return new Response(JSON.stringify({ rows, marks }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders(request) },
  });
}

// POST /mine/<list>/movie/<tmdb id> or /mine/<list>/tv/<tmdb id> (the same sign-in) -> 204. history: a film played
// here goes to the front of Lampa's history, as Lampa puts one there when its torrents open (torrent.js): Lampa's
// recommendations and Continue browsing come from it; one already there is moved (its bookmark id, as Lampa sends
// it). The card as Lampa keeps one (Utils.clearCard's fields, TMDB en-US). scheduled, thrown, viewed: the film's
// mark (one at a time, as Lampa's), none: no mark; in D1 (CUB's marks need Premium).
const LAMPA_FIELDS = ['poster_path', 'overview', 'release_date', 'id', 'original_title', 'original_language', 'title',
  'backdrop_path', 'popularity', 'vote_count', 'vote_average', 'imdb_id', 'original_name', 'name', 'first_air_date',
  'origin_country', 'status', 'number_of_seasons', 'number_of_episodes'];
async function bookmark(request, env, list, type, id) {
  const who = await cubUser(request, env);
  if (!who) return corsError(request, 'CUB sign-in required.', 401);
  if (list !== 'history') {
    if (!env.DB) return corsError(request, 'No database.', 502);
    await (list === 'none'
      ? env.DB.prepare('DELETE FROM marks WHERE who = ? AND card = ?').bind(who, `${type}_${id}`)
      : env.DB.prepare(`INSERT INTO marks (who, card, mark, t) VALUES (?1, ?2, ?3, ?4)
          ON CONFLICT (who, card) DO UPDATE SET mark = excluded.mark, t = excluded.t`).bind(who, `${type}_${id}`, list, Date.now())
    ).run();
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  const [res, dump] = await Promise.all([tmdb(env, `${type}/${id}`), cubApi(request, 'bookmarks/dump')]);
  if (!res.ok || !dump || !Array.isArray(dump.bookmarks)) return corsError(request, 'TMDB or CUB unavailable.', 502);
  const m = await res.json();
  const card = { source: 'tmdb', genre_ids: (m.genres || []).map((g) => g.id) };
  for (const k of LAMPA_FIELDS) if (m[k] != null) card[k] = m[k];
  if (card.poster_path) card.img = `https://image.tmdb.org/t/p/w300${card.poster_path}`;
  const data = JSON.stringify(card);
  const mine = dump.bookmarks.filter((b) => String(b.card_id) === String(id) && b.card_type === type);
  const send = async (method, kind, bookmarkId) => {
    const json = await cubApi(request, `bookmarks/${method}`, { type: kind, data, card_id: String(id), id: String(bookmarkId) });
    if (!json || json.error) throw new Error(`CUB refused ${method} ${kind}${json ? ` (${json.code})` : ''}`);
  };
  try {
    await send('add', 'history', mine.find((b) => b.type === 'history')?.id ?? 0);
  } catch (e) {
    return corsError(request, `${e.message}.`, 502);
  }
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export default {
  scheduled(event, env) {
    return TITLE_CRONS[event.cron] && env.DB ? refreshTitles(env, TITLE_CRONS[event.cron]) : undefined;
  },

  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (!ALLOWED_METHODS.has(request.method)) {
      return corsError(request, 'Method not allowed.', 405);
    }

    if (new URL(request.url).pathname === '/grades' && request.method === 'POST') return grades(request, env);
    if (new URL(request.url).pathname === '/home' && request.method === 'GET') return home(request, env);
    if (new URL(request.url).pathname === '/search' && request.method === 'GET') return search(request, env);
    const film = new URL(request.url).pathname.match(/^\/card\/(movie|tv)\/(\d+)$/);
    if (film && request.method === 'GET') {
      return edgeCached(request, ctx, () => filmCard(request, env, film[1], film[2]));
    }
    const src = new URL(request.url).pathname.match(/^\/streams\/(movie|series)\/(tt\d+)(?:\/(\d+)\/(\d+))?$/);
    if (src && /^(GET|POST)$/.test(request.method) && (src[1] === 'series') === Boolean(src[3])) {
      return sources(request, env, src[1], src[2], src[3], src[4]);
    }

    const skip = new URL(request.url).pathname.match(/^\/segments\/(movie|tv)\/(\d+)\/(tt\d+)$/);
    if (skip && request.method === 'GET') return segments(request, env, skip[1], skip[2], skip[3]);
    const link = new URL(request.url).pathname.match(/^\/play\/([0-9a-f]{40})$/);
    if (link && request.method === 'GET') return play(request, env, ctx, link[1]);
    const file = new URL(request.url).pathname.match(/^\/stream\/(\d+)\/(\d+)$/);
    if (file && /^(GET|HEAD)$/.test(request.method)) return stream(request, env, ctx, file[1], file[2]);
    if (new URL(request.url).pathname === '/timeline') return timeline(request, env);
    if (new URL(request.url).pathname === '/mine' && request.method === 'GET') return mine(request, env);
    const listed = new URL(request.url).pathname
      .match(/^\/mine\/(history|viewed|scheduled|thrown|none)\/(movie|tv)\/(\d+)$/);
    if (listed && request.method === 'POST') return bookmark(request, env, listed[1], listed[2], listed[3]);

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
