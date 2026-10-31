// Tests for the routes lampa-native uses (GET /home, GET /card). Run: node --test 'proxy/*.test.js'  (Node 22+, no dependencies; fetch is mocked)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './cloudflare-worker.js';

const env = { TMDB_API_KEY: 'eyJ.test.token' };
let asked = []; // every URL the worker fetched
let headers = []; // and the headers it sent with each

function tmdbAnswers(byPath) {
  asked = [];
  headers = [];
  globalThis.fetch = async (url, init) => {
    asked.push(String(url));
    headers.push(new Headers(init?.headers));
    const body = byPath[new URL(url).pathname.replace('/3/', '')];
    return body ? new Response(JSON.stringify(body)) : new Response('down', { status: 500 });
  };
}

test('sends only what a card draws: [id, type, name, year, poster, score, backdrop]', async () => {
  tmdbAnswers({
    'trending/all/day': {
      results: [
        { id: 1, media_type: 'movie', title: 'Film', release_date: '2026-05-01', poster_path: '/p.jpg',
          backdrop_path: '/b.jpg', vote_average: 8.64, overview: 'a long text the stick never needs' },
        { id: 2, media_type: 'tv', name: 'Series', first_air_date: '2021-09-24', poster_path: '/q.jpg', vote_average: 0 },
        { id: 3, media_type: 'person', name: 'Actor', profile_path: '/a.jpg' },
        { id: 4, media_type: 'movie', title: 'No poster', release_date: '2020-01-01', poster_path: null },
      ],
    },
  });
  const res = await worker.fetch(new Request('https://w/home'), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'max-age=3600');
  // the other seven rows failed (500) and are left out instead of blanking the screen
  assert.deepEqual((await res.json()).rows, [
    ['Today in trend', [[1, 'movie', 'Film', '2026', '/p.jpg', 86, '/b.jpg'], [2, 'tv', 'Series', '2021', '/q.jpg', 0, '']]],
  ]);
});

test('asks TMDB for English names and descriptions', async () => {
  tmdbAnswers({});
  await worker.fetch(new Request('https://w/home'), env);
  await worker.fetch(new Request('https://w/card/movie/7'), env);
  const tmdbUrls = asked.filter((u) => u.includes('api.themoviedb.org'));
  assert.equal(tmdbUrls.length, 9);
  for (const u of tmdbUrls) assert.equal(new URL(u).searchParams.get('language'), 'en-US', u);
});

// The stick's org.json (Android's) turns JSON null into the text "null", the tests' one throws: never send null.
test('always sends strings, even when TMDB leaves out the name or the date', async () => {
  tmdbAnswers({ 'movie/popular': { results: [{ id: 5, poster_path: '/p.jpg' }] } });
  const { rows } = await (await worker.fetch(new Request('https://w/home'), env)).json();
  assert.deepEqual(rows, [['Popular films', [[5, 'movie', '', '', '/p.jpg', 0, '']]]]);
});

test('answers 502 when every row fails', async () => {
  tmdbAnswers({});
  assert.equal((await worker.fetch(new Request('https://w/home'), env)).status, 502);
});

const card = async (path) => worker.fetch(new Request('https://w/card/' + path), env);

test('film page: display-ready strings, the verdict first, then TMDB and the MDBList scores', async () => {
  tmdbAnswers({
    'movie/7': {
      title: 'Dune: Part Two', original_title: 'Dune: Part Two', release_date: '2024-02-27', runtime: 166,
      genres: [{ name: 'Science Fiction' }, { name: 'Adventure' }], overview: 'Paul Atreides…', backdrop_path: '/b.jpg',
      vote_average: 8.15, poster_path: '/p.jpg', production_companies: [{ name: 'Legendary' }], imdb_id: 'tt15239678',
      credits: {
        cast: ['Timothée Chalamet', 'Zendaya', 'Rebecca Ferguson', 'Javier Bardem', 'Josh Brolin', 'Austin Butler',
          'Florence Pugh'].map((name) => ({ name, character: 'x' })),
        crew: [{ job: 'Producer', name: 'Mary Parent' }, { job: 'Director', name: 'Denis Villeneuve' }],
      },
    },
    '/tmdb/movie/7': {
      ratings: [
        { source: 'imdb', value: 8.5 }, { source: 'tomatoes', value: 92 }, { source: 'metacritic', value: 79 },
        { source: 'letterboxd', value: 4.4, score: 88 }, { source: 'popcorn', value: 95 }, { source: 'trakt', value: null },
      ],
    },
  });
  const res = await card('movie/7');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'max-age=86400');
  assert.deepEqual(await res.json(), {
    name: 'Dune: Part Two',
    original: '', // same as the name
    line: '2024 · 2h 46m · Science Fiction, Adventure',
    overview: 'Paul Atreides…',
    // verdict = (92×4 + 79×3 + 85×3 + 88×0.5) / 10.5 = 86 → Excellent
    scores: [['Excellent', '86', 86], ['TMDB', '8.2', 82], ['IMDb', '8.5', 85], ['RT', '92%', 92], ['MC', '79', 79],
      ['LB', '4.4', 88]],
    seasons: [],
    imdb: 'tt15239678', // the stick asks /streams with it as soon as the page opens
    episodes: [],
    people: 'Director Denis Villeneuve · Cast Timothée Chalamet, Zendaya, Rebecca Ferguson, Javier Bardem, Josh Brolin, Austin Butler',
    cast: [], // the photos row: only people with a photo (these have none)
    collection: '',
    parts: [],
  });
});

test('film page: the cast row (12 with photos) and the other films of its collection as Home cards, oldest first', async () => {
  const people = Array.from({ length: 15 }, (_, i) => ({ name: `Actor ${i}`, character: `Role ${i}`, profile_path: i === 1 ? null : `/a${i}.jpg` }));
  tmdbAnswers({
    'movie/7': { title: 'Dune: Part Two', credits: { cast: people, crew: [] }, belongs_to_collection: { id: 726871, name: 'Dune Collection' } },
    'collection/726871': {
      name: 'Dune Collection',
      parts: [
        { id: 7, title: 'Dune: Part Two', release_date: '2024-02-27', poster_path: '/2.jpg', vote_average: 8.15, backdrop_path: '/b2.jpg' },
        { id: 3, title: 'Dune: Part Three', release_date: '', poster_path: null, vote_average: 0 }, // not out: no poster
        { id: 6, title: 'Dune', release_date: '2021-09-15', poster_path: '/1.jpg', vote_average: 7.8, backdrop_path: '/b1.jpg' },
      ],
    },
  });
  const film = await (await card('movie/7')).json();
  assert.equal(film.cast.length, 12);
  assert.deepEqual(film.cast.slice(0, 2), [['Actor 0', 'Role 0', '/a0.jpg'], ['Actor 2', 'Role 2', '/a2.jpg']]);
  assert.equal(film.people, '', 'the photos row names the cast: the text line does not repeat it');
  assert.equal(film.collection, 'Dune Collection');
  // not this film (7): its page doesn't offer itself
  assert.deepEqual(film.parts, [[6, 'movie', 'Dune', '2021', '/1.jpg', 78, '/b1.jpg']]);
});

test('a collection with nothing but this film: no collection row', async () => {
  tmdbAnswers({
    'movie/7': { title: 'Dune', belongs_to_collection: { id: 1, name: 'Dune Collection' } },
    'collection/1': { name: 'Dune Collection', parts: [{ id: 7, title: 'Dune', poster_path: '/1.jpg' }] },
  });
  const film = await (await card('movie/7')).json();
  assert.equal(film.collection, '');
  assert.deepEqual(film.parts, []);
});

test('film page without its collection (TMDB failed) still opens', async () => {
  tmdbAnswers({ 'movie/7': { title: 'Dune', belongs_to_collection: { id: 1, name: 'Dune Collection' } } });
  const film = await (await card('movie/7')).json();
  assert.equal(film.collection, '');
  assert.deepEqual(film.parts, []);
});

test('series: original name, seasons with their TMDB scores (no specials, no unrated), creators, MDBList asked as "show"', async () => {
  tmdbAnswers({
    'tv/9': {
      name: 'Squid Game', original_name: '오징어 게임', first_air_date: '2021-09-17', number_of_seasons: 2, genres: [],
      vote_average: 7.9, created_by: [{ name: 'Hwang Dong-hyuk' }], credits: { cast: [] },
      seasons: [{ season_number: 0, vote_average: 7, episode_count: 3 }, { season_number: 1, vote_average: 8.4, episode_count: 9 },
        { season_number: 2, vote_average: 0, episode_count: 7 }],
      external_ids: { imdb_id: 'tt10919420' },
    },
    '/tmdb/show/9': { ratings: [{ source: 'imdb', value: 8 }] },
  });
  const film = await (await card('tv/9')).json();
  assert.equal(film.original, '오징어 게임');
  assert.equal(film.line, '2021 · 2 seasons');
  assert.deepEqual(film.scores, [['TMDB', '7.9', 79], ['IMDb', '8.0', 80]]); // under 3 sources: no verdict
  assert.deepEqual(film.seasons, [['S1', '8.4', 84]]);
  assert.equal(film.people, 'Created by Hwang Dong-hyuk');
  assert.equal(film.imdb, 'tt10919420'); // TV details carry it only in external_ids
  assert.deepEqual(film.episodes, [[1, 9], [2, 7]]); // [season, episodes], no specials
  assert.match(asked.find((u) => u.includes('/3/tv/9')), /append_to_response=credits,external_ids/);
});

test('film page without MDBList still opens; fields TMDB leaves out are empty strings, never null', async () => {
  tmdbAnswers({ 'movie/5': { title: 'Film' } }); // MDBList answers 500
  const res = await card('movie/5');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(),
    { name: 'Film', original: '', line: '', overview: '', scores: [], seasons: [], imdb: '', episodes: [], people: '',
      cast: [], collection: '', parts: [] });
});

test('film page answers TMDB\'s 404 as 404 and other TMDB failures as 502', async () => {
  globalThis.fetch = async () => new Response('{}', { status: 404 });
  assert.equal((await card('movie/1')).status, 404);
  tmdbAnswers({});
  assert.equal((await card('tv/1')).status, 502);
});

// Sources: Torrentio's list filtered by audio language, biggest first; TorBox's cache checked for the first 6 only
// (5 rows fit on the stick's screen, measured), then the rest in a second call.
const streamsEnv = { ...env, TORBOX_API_KEY: 'tb-test-key' };
const hash = (i) => i.toString(16).padStart(40, '0');
const tio = (i, gb, langs = '🇷🇺 / 🇺🇦') => ({
  name: 'Torrentio\n4k DV | HDR',
  title: `Film.${i}.2024.2160p\n👤 ${100 - i} 💾 ${gb} GB ⚙️ Rutracker${langs ? '\n' + langs : ''}`,
  infoHash: hash(i), fileIdx: 0, behaviorHints: { filename: `Film.${i}.mkv` },
});
const streams = async (path, e = streamsEnv) => worker.fetch(new Request('https://w/streams/' + path), e);
// 15 releases, sizes in no order; 0-11 have Russian + Ukrainian audio, 12-13 English only (no flags), 14 Korean
const sizes = [3, 40.5, 7, 12, 60, 1.2, 25, 9, 33, 2, 18, 5, 70, 15, 8];
const fifteen = { '/stream/movie/tt1.json': { streams: sizes.map((gb, i) => tio(i, gb, i < 12 ? undefined : i < 14 ? '' : '🇰🇷')) } };
const bySize = (ids) => [...ids].sort((a, b) => sizes[b] - sizes[a]);
const ruUa = bySize([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

test('sources: RU/UA asked → only those, biggest first; the first 6 with TorBox\'s cached mark, checked for those 6 only', async () => {
  tmdbAnswers({ ...fifteen, '/v1/api/torrents/checkcached': { success: true, data: [{ hash: hash(4) }, { hash: hash(8) }] } });
  const res = await streams('movie/tt1?lang=RU,UA');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'max-age=600');
  const body = await res.json();
  assert.deepEqual(body.streams.map((r) => r[0]), ruUa.slice(0, 6).map(hash));
  assert.equal(body.next, 6); // the rest: from=6
  assert.equal(body.total, 12);
  // every language in the film's list, most releases first: the picker; no flags = English
  assert.deepEqual(body.languages, [['RU', 12], ['UA', 12], ['EN', 2], ['KR', 1]]);
  // [hash, fileIdx, title, badges, size, seeders, tracker, languages, cached: 1 yes / 0 no / -1 unknown]
  assert.deepEqual(body.streams[0], [hash(4), 0, 'Film.4.mkv', ['4K', 'DV', 'HDR'], '60 GB', 96, 'Rutracker', ['RU', 'UA'], 1]);
  assert.deepEqual(body.streams.map((r) => r[8]), [1, 0, 1, 0, 0, 0]); // 60 GB (#4), 40.5, 33 (#8), … by size
  const check = new URL(asked.find((u) => u.includes('checkcached')));
  assert.deepEqual(check.searchParams.get('hash').split(','), ruUa.slice(0, 6).map(hash));
  const i = asked.findIndex((u) => u.includes('checkcached'));
  assert.equal(headers[i].get('Authorization'), 'Bearer tb-test-key');
  assert.ok(!asked[i].includes('tb-test-key')); // the key never goes into a URL
});

test('the rest: from=6 brings the others and says there is no more', async () => {
  tmdbAnswers({ ...fifteen, '/v1/api/torrents/checkcached': { success: true, data: [] } });
  const body = await (await streams('movie/tt1?lang=RU,UA&from=6')).json();
  assert.deepEqual(body.streams.map((r) => r[0]), ruUa.slice(6).map(hash));
  assert.equal(body.next, 0);
});

test('languages: no lang = all of them; a language added to RU/UA brings its releases in', async () => {
  tmdbAnswers(fifteen);
  assert.equal((await (await streams('movie/tt1', env)).json()).total, 15);
  tmdbAnswers(fifteen);
  const body = await (await streams('movie/tt1?lang=RU,UA,KR', env)).json();
  assert.equal(body.total, 13);
  assert.ok(body.streams.some((r) => r[0] === hash(14)) || body.next); // 8 GB: in the first 6 or the rest
});

test('series: Torrentio is asked for the one episode; no file name → the first title line; no flags → English', async () => {
  const s = { name: 'Torrentio\n1080p', title: 'Show S01 1080p\nShow.S01E02.mkv\n👤 5 💾 900 MB ⚙️ 1337x', infoHash: hash(1), fileIdx: 2 };
  tmdbAnswers({ '/stream/series/tt2:1:2.json': { streams: [s] }, '/v1/api/torrents/checkcached': { success: true, data: null } });
  const body = await (await streams('series/tt2/1/2')).json();
  assert.deepEqual(body.streams, [[hash(1), 2, 'Show S01 1080p', ['1080p'], '900 MB', 5, '1337x', ['EN'], 0]]);
});

test('sources without a TorBox key, or with TorBox down, still come: cached unknown (-1)', async () => {
  tmdbAnswers(fifteen); // checkcached answers 500
  assert.deepEqual((await (await streams('movie/tt1')).json()).streams.map((r) => r[8]), Array(6).fill(-1));
  tmdbAnswers(fifteen);
  const body = await (await streams('movie/tt1', env)).json();
  assert.deepEqual(body.streams.map((r) => r[8]), Array(6).fill(-1));
  assert.ok(!asked.some((u) => u.includes('torbox')));
});

test('sources: each torrent once; Torrentio down → 502', async () => {
  tmdbAnswers({ '/stream/movie/tt1.json': { streams: [tio(1, 1), tio(1, 1), tio(2, 2)] } });
  assert.equal((await (await streams('movie/tt1', env)).json()).total, 2);
  tmdbAnswers({});
  assert.equal((await streams('movie/tt1')).status, 502);
});

// Torrentio answers the worker 429 (Cloudflare's IPs are shared and rate-limited); the stick's home IP gets it, so
// the app asks Torrentio itself and posts its answer here: the same filtering, sorting and TorBox check.
test('sources: Torrentio\'s answer posted by the stick is used as Torrentio\'s own, Torrentio not asked', async () => {
  tmdbAnswers({ '/v1/api/torrents/checkcached': { success: true, data: [{ hash: hash(4) }] } });
  const post = (path, body, headers = { 'X-Play-Token': 'stick-token' }) => worker.fetch(
    new Request('https://w/streams/' + path, { method: 'POST', body, headers }), { ...streamsEnv, PLAY_TOKEN: 'stick-token' });
  const body = await (await post('movie/tt1?lang=RU,UA', JSON.stringify(fifteen['/stream/movie/tt1.json']))).json();
  assert.deepEqual(body.streams.map((r) => r[0]), ruUa.slice(0, 6).map(hash));
  assert.deepEqual(body.streams.map((r) => r[8]), [1, 0, 0, 0, 0, 0]);
  assert.ok(!asked.some((u) => u.includes('torrentio')));
  assert.equal((await post('movie/tt1', 'not json')).status, 400);
  assert.equal((await post('movie/tt1', 'x'.repeat(4e6 + 1))).status, 413);
  // only the stick: a posted list spends the TorBox key's checks on any hashes
  assert.equal((await post('movie/tt1', '{"streams":[]}', {})).status, 403);
});

// Badges from Torrentio's quality line, the torrent name and the file name. Real names from Dune: Part Two's list.
test('badges: resolution, Dolby Vision, HDR, REMUX, codec, audio; in that order, each once', async () => {
  const row = (name, title, filename) => ({ name, title: `${title}\n👤 1 💾 1 GB ⚙️ x`, infoHash: hash(1),
    behaviorHints: { filename } });
  const cases = [
    [row('Torrentio\n4k DV | HDR', 'Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX[TGx]',
      'Dune.Part.Two.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-FLUX.mkv'), ['4K', 'DV', 'HDR', 'HEVC', 'Atmos', 'DD+']],
    [row('Torrentio\n4k DV', 'Dune.Part.Two.2024.UHD.BluRay.2160p.TrueHD.Atmos.7.1.DV.HEVC.REMUX-FraMeSToR',
      undefined), ['4K', 'DV', 'REMUX', 'HEVC', 'Atmos', 'TrueHD']],
    [row('Torrentio\n4k DV | HDR10+', 'Dune.Part.Two.2024.MULTI.2160p.4KLight.DV.HDR10Plus.WEBRip.DDP.5.1.x265-ESPER',
      undefined), ['4K', 'DV', 'HDR10+', 'HEVC', 'DD+']],
    [row('Torrentio\n1080p', 'Dune Part Two 2024 1080p BluRay DTS-HD MA 7.1 x264', undefined), ['1080p', 'DTS']],
    [row('Torrentio\n720p', 'Dune.Part.Two.2024.720p.WEBRip.AC3.x264', undefined), ['720p', 'DD']],
    [row('Torrentio\nDVDRip', 'Dune.Part.Two.2024.DVDRip.AV1.EAC3', undefined), ['AV1', 'DD+']], // DVDRip isn't DV
  ];
  tmdbAnswers({ '/stream/movie/tt1.json': { streams: cases.map(([st], i) => ({ ...st, infoHash: hash(i) })) } });
  const body = await (await streams('movie/tt1', env)).json();
  assert.deepEqual(body.streams.map((r) => r[3]), cases.map(([, badges]) => badges)); // equal sizes: Torrentio's order
});

// Play: a TorBox link for one file of a torrent, for DDD. Only with the stick's token: the route adds torrents to
// the TorBox account and hands out its download links.
const playEnv = { ...streamsEnv, PLAY_TOKEN: 'stick-token' };
const H = 'ab'.repeat(20);
function torbox(answers) {
  asked = [];
  headers = [];
  globalThis.fetch = async (url, init) => {
    asked.push(String(url));
    headers.push(new Headers(init?.headers));
    const u = new URL(url);
    const key = u.pathname.replace('/v1/api/torrents/', '') + (u.searchParams.get('id') ? '?id' : '');
    const body = answers[key];
    if (init?.body) asked.push(await new Response(init.body).text());
    return body ? new Response(JSON.stringify(body)) : new Response('down', { status: 500 });
  };
}
const pack = {
  id: 11, hash: H, download_present: true, download_finished: true, progress: 1,
  files: [
    { id: 0, name: 'Show S01/Show.S01E01.mkv', short_name: 'Show.S01E01.mkv', size: 2e9 },
    { id: 1, name: 'Show S01/Show.S01E02.mkv', short_name: 'Show.S01E02.mkv', size: 3e9 },
    { id: 2, name: 'Show S01/Extras.mkv', short_name: 'Extras.mkv', size: 1e9 },
    { id: 3, name: 'Show S01/sample.nfo', short_name: 'sample.nfo', size: 9e9 },
  ],
};
const play = (path, token = 'stick-token') =>
  worker.fetch(new Request('https://w/play/' + path, { headers: token ? { 'X-Play-Token': token } : {} }), playEnv);

test('play: without the stick\'s token nothing is asked of TorBox', async () => {
  torbox({});
  assert.equal((await play(`${H}?file=1`, null)).status, 403);
  assert.equal((await play(`${H}?file=1`, 'stick-tokeN')).status, 403);
  assert.equal((await worker.fetch(new Request(`https://w/play/${H}`, { headers: { 'X-Play-Token': '' } }), streamsEnv)).status, 403); // no secret set
  assert.deepEqual(asked, []);
});

test('play: adds the torrent, picks the file Torrentio meant by its name, answers TorBox\'s link (never cached)', async () => {
  torbox({
    createtorrent: { success: true, data: { torrent_id: 11, hash: H } },
    'mylist?id': { success: true, data: pack },
    requestdl: { success: true, data: 'https://store.torbox.app/dl/xyz' },
  });
  const res = await play(`${H}?file=0&name=Show.S01E02.mkv`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await res.json(), { url: 'https://store.torbox.app/dl/xyz', time: 0, percent: 0 }); // no tl
  assert.ok(asked[1].includes(`magnet:?xt=urn:btih:${H}`), asked[1]); // the createtorrent form
  const dl = new URL(asked.find((u) => u.includes('requestdl')));
  assert.equal(dl.searchParams.get('torrent_id'), '11');
  assert.equal(dl.searchParams.get('file_id'), '1'); // by name, though Torrentio's index said 0
  assert.equal(dl.searchParams.get('token'), 'tb-test-key'); // requestdl takes the key as a parameter only
  for (const h of headers) assert.equal(h.get('Authorization'), 'Bearer tb-test-key');
});

test('play: a torrent already in the account is found in the list; no name match → Torrentio\'s index → the biggest video', async () => {
  torbox({
    createtorrent: { success: false, error: 'DOWNLOAD_EXISTS' },
    mylist: { success: true, data: [{ id: 5, hash: 'cd'.repeat(20) }, { id: 11, hash: H.toUpperCase() }] },
    'mylist?id': { success: true, data: pack },
    requestdl: { success: true, data: 'https://store.torbox.app/dl/xyz' },
  });
  assert.equal((await play(`${H}?file=2&name=Other.mkv`)).status, 200);
  assert.equal(new URL(asked.find((u) => u.includes('requestdl'))).searchParams.get('file_id'), '2');
  await play(`${H}?file=-1&name=`);
  assert.equal(new URL(asked.findLast((u) => u.includes('requestdl'))).searchParams.get('file_id'), '1'); // 3 GB, not the .nfo
});

test('play: still downloading on TorBox → 202 with its progress; TorBox down → 502', async () => {
  torbox({
    createtorrent: { success: true, data: { torrent_id: 11 } },
    'mylist?id': { success: true, data: { ...pack, download_present: false, download_finished: false, progress: 0.423 } },
  });
  const res = await play(`${H}?file=1`);
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { progress: 42 });
  torbox({});
  assert.equal((await play(`${H}?file=1`)).status, 502);
});

// Timeline: one table of resume points (D1) shared by lampa-native and Lampa (through the torbox-en plugin), keyed
// by Lampa's hash of the title; per point the newer one wins. D1 is node:sqlite here, with D1's API around it.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

function d1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('./timeline.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('./titles.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('./shows.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('./fresh.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('./uhd.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('./foryou.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('./marks.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('./segments.sql', import.meta.url), 'utf8'));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => (db.prepare(sql).run(...args), { success: true }),
  });
  return { prepare: (sql) => stmt(sql), raw: db };
}
const ready = {
  createtorrent: { success: true, data: { torrent_id: 11 } },
  'mylist?id': { success: true, data: pack },
  requestdl: { success: true, data: 'https://store.torbox.app/dl/xyz' },
  '/api/users/get': { user: { id: 42 } },
};
const tlEnv = () => ({ ...playEnv, DB: d1(), CUB_ACCOUNTS: '42' });
const stick = { 'X-Play-Token': 'stick-token' };
const lampa = { 'X-Cub-Token': 'cub-token', 'X-Cub-Profile': '7' };
const getTimeline = (e, h = stick) => worker.fetch(new Request('https://w/timeline', { headers: h }), e);
const postTimeline = (e, timelines, h = stick) => worker.fetch(new Request('https://w/timeline', {
  method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify({ timelines }),
}), e);

test('timeline: the stick saves where DDD stopped (stamped now), Lampa reads it, play resumes there', async () => {
  torbox(ready);
  const e = tlEnv();
  assert.equal((await postTimeline(e, [{ hash: '123', time: 3000, duration: 7000, percent: 43, card: 'movie_155' }])).status, 204);
  const { timelines } = await (await getTimeline(e, lampa)).json();
  assert.ok(Math.abs(timelines['123'].updated - Date.now()) < 5000, 'stamped by the worker');
  assert.deepEqual({ ...timelines['123'], updated: 0 }, { time: 3000, duration: 7000, percent: 43, updated: 0, card: 'movie_155' });
  const res = await (await worker.fetch(new Request(`https://w/play/${H}?file=1&tl=123`, { headers: stick }), e)).json();
  assert.deepEqual(res, { url: 'https://store.torbox.app/dl/xyz', time: 3000, percent: 43 });
});

test('timeline: Lampa pushes its own (with its stamps, episodes keep season and episode); per point the newer wins', async () => {
  torbox(ready);
  const e = tlEnv();
  await postTimeline(e, [
    { hash: '1', time: 100, duration: 1000, percent: 10, updated: 2000 },
    { hash: '2', time: 600, duration: 2400, percent: 25, updated: 2000, card: 'tv_1399', season: 1, episode: 5 },
  ], lampa);
  await postTimeline(e, [{ hash: '1', time: 50, duration: 1000, percent: 5, updated: 1000 }], lampa); // older: ignored
  await postTimeline(e, [{ hash: '2', time: 900, duration: 2400, percent: 38, updated: 3000 }], lampa); // newer: wins
  const { timelines } = await (await getTimeline(e)).json();
  assert.deepEqual(timelines['1'], { time: 100, duration: 1000, percent: 10, updated: 2000 });
  assert.deepEqual(timelines['2'], { time: 900, duration: 2400, percent: 38, updated: 3000, card: 'tv_1399', season: 1, episode: 5 });
});

test("timeline: ?hash= gives only those points (one series's episodes, for the stick)", async () => {
  torbox(ready);
  const e = tlEnv();
  await postTimeline(e, ['1', '2', '3'].map((hash) => ({ hash, time: 100, duration: 1000, percent: 10 })));
  const only = (q) => worker.fetch(new Request(`https://w/timeline?hash=${q}`, { headers: stick }), e).then((r) => r.json());
  assert.deepEqual(Object.keys((await only('3,1,9')).timelines).sort(), ['1', '3']);
  assert.deepEqual((await only('9')).timelines, {});
});

test('timeline: only the stick or an allowed CUB account; bad points are refused; no point → play from the start', async () => {
  torbox({ ...ready, '/api/users/get': { user: { id: 9 } } });
  const e = tlEnv();
  assert.equal((await getTimeline(e, {})).status, 403);
  assert.equal((await getTimeline(e, lampa)).status, 403); // CUB account 9 isn't in CUB_ACCOUNTS
  assert.equal((await postTimeline(e, [{ hash: '1', time: 1, duration: 2, percent: 50 }], { 'X-Play-Token': 'nope' })).status, 403);
  assert.equal((await postTimeline(e, [{ hash: 'x1', time: 1, duration: 2, percent: 50 }])).status, 400);
  assert.equal((await postTimeline(e, [{ hash: '1', time: 'x', duration: 2, percent: 50 }])).status, 400);
  assert.equal((await postTimeline(e, Array.from({ length: 2001 }, (_, i) => ({ hash: String(i), time: 1, duration: 2, percent: 50 })))).status, 400);
  assert.equal(e.DB.raw.prepare('select count(*) n from timeline').get().n, 0);
  torbox(ready);
  assert.deepEqual(await (await worker.fetch(new Request(`https://w/play/${H}?file=1&tl=5`, { headers: stick }), e)).json(),
    { url: 'https://store.torbox.app/dl/xyz', time: 0, percent: 0 });
});

test('search: films and series with a poster, as Home cards; the query reaches TMDB whole, Cyrillic too', async () => {
  tmdbAnswers({
    'search/multi': {
      results: [
        { id: 155, media_type: 'movie', title: 'The Dark Knight', release_date: '2008-07-16', poster_path: '/k.jpg',
          vote_average: 8.5, backdrop_path: '/kb.jpg' },
        { id: 3, media_type: 'person', name: 'Christian Bale', profile_path: '/a.jpg' },
        { id: 4, media_type: 'tv', name: 'No poster', poster_path: null },
      ],
    },
  });
  const res = await worker.fetch(new Request('https://w/search?q=' + encodeURIComponent('тёмный рыцарь & co')), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'max-age=3600');
  assert.deepEqual((await res.json()).results, [[155, 'movie', 'The Dark Knight', '2008', '/k.jpg', 85, '/kb.jpg']]);
  const url = new URL(asked[0]);
  assert.equal(url.searchParams.get('query'), 'тёмный рыцарь & co');
  assert.equal(url.searchParams.get('include_adult'), 'false');
});

test('search: an empty query asks nothing', async () => {
  tmdbAnswers({});
  const res = await worker.fetch(new Request('https://w/search?q=%20'), env);
  assert.deepEqual((await res.json()).results, []);
  assert.equal(asked.length, 0);
  assert.equal(res.headers.get('Cache-Control'), 'no-store'); // nothing found isn't kept: the index may fill later
});

// The search index: what the crons store, and what one or two letters find.
const known = {
  'discover/movie': { results: [
    { id: 155, title: 'The Dark Knight', original_title: 'The Dark Knight', release_date: '2008-07-16', poster_path: '/k.jpg',
      vote_average: 8.5, vote_count: 34000, backdrop_path: '/kb.jpg' },
    { id: 157336, title: 'Interstellar', original_title: 'Interstellar', release_date: '2014-11-05', poster_path: '/i.jpg',
      vote_average: 8.4, vote_count: 37000 },
    { id: 9, title: 'No poster', vote_count: 99999, poster_path: null },
  ] },
  'discover/tv': { results: [
    { id: 1396, name: 'Breaking Bad', original_name: 'Breaking Bad', first_air_date: '2008-01-20', poster_path: '/b.jpg',
      vote_average: 8.9, vote_count: 16000 },
    { id: 93405, name: 'Squid Game', original_name: '오징어 게임', first_air_date: '2021-09-17', poster_path: '/s.jpg',
      vote_average: 7.8, vote_count: 15000 },
  ] },
};
const russian = {
  'discover/movie': { results: [{ id: 155, title: 'Тёмный рыцарь', poster_path: '/k.jpg' },
    { id: 777, title: 'Not in the English run', poster_path: '/x.jpg' }] },
  'discover/tv': { results: [{ id: 1396, name: 'Во все тяжкие', poster_path: '/b.jpg' }] },
};
const indexed = async () => {
  const e = { ...env, DB: d1() };
  tmdbAnswers(known);
  await worker.scheduled({ cron: '7 3 * * *' }, e);
  assert.ok(asked.length <= 45, 'the free plan allows 50 calls a run');
  assert.ok(asked.every((u) => new URL(u).searchParams.get('language') === 'en-US'));
  tmdbAnswers(russian);
  await worker.scheduled({ cron: '37 3 * * *' }, e);
  assert.ok(asked.every((u) => new URL(u).searchParams.get('language') === 'ru-RU'));
  return e;
};
const find = async (e, q) => {
  tmdbAnswers({ 'search/multi': { results: [
    { id: 155, media_type: 'movie', title: 'The Dark Knight', poster_path: '/k.jpg', release_date: '2008-07-16', vote_average: 8.5 },
    { id: 5, media_type: 'movie', title: 'Inter Nos', poster_path: '/n.jpg', release_date: '1982-01-01', vote_average: 6 },
  ] } });
  const res = await worker.fetch(new Request('https://w/search?q=' + encodeURIComponent(q)), e);
  return (await res.json()).results.map((c) => c[2]);
};

test('search index: one or two letters find well-known titles by any word, the most voted first, without TMDB', async () => {
  const e = await indexed();
  assert.deepEqual(await find(e, 'i'), ['Interstellar']);
  assert.equal(asked.length, 0, 'too short for TMDB search: the index alone');
  assert.deepEqual(await find(e, 'b'), ['Breaking Bad']);
  assert.deepEqual(await find(e, 'т'), ['The Dark Knight', 'Breaking Bad'], 'Тёмный рыцарь, Во все тяжкие');
  assert.deepEqual(await find(e, 'во'), ['Breaking Bad'], 'Во все тяжкие');
  assert.deepEqual(await find(e, 'ры'), ['The Dark Knight'], 'any word: рыцарь');
  assert.deepEqual(await find(e, '오징'), ['Squid Game'], 'the original title');
  assert.deepEqual(await find(e, 'kn'), ['The Dark Knight']);
  const rows = e.DB.raw.prepare('SELECT id FROM titles ORDER BY id').all().map((r) => r.id);
  assert.deepEqual(rows, [155, 1396, 93405, 157336], 'no poster: left out; the Russian run adds no titles');
});

test('search index: from three letters TMDB search too, after the index, each title once', async () => {
  const e = await indexed();
  assert.deepEqual(await find(e, 'inter'), ['Interstellar', 'The Dark Knight', 'Inter Nos']);
  assert.equal(asked.length, 1);
  assert.deepEqual(await find(e, 'тёмный р'), ['The Dark Knight', 'Inter Nos'], 'ё as е; two words');
});

test('search index: a title off every list for a month leaves it', async () => {
  const e = await indexed();
  e.DB.raw.prepare('UPDATE titles SET seen = 0 WHERE id = 1396').run();
  tmdbAnswers({ 'discover/movie': known['discover/movie'] });
  await worker.scheduled({ cron: '7 3 * * *' }, e);
  assert.deepEqual(e.DB.raw.prepare('SELECT id FROM titles ORDER BY id').all().map((r) => r.id), [155, 93405, 157336]);
});

test('film page: kept at the edge a day, so the stick may ask for it ahead (one MDBList lookup a film a day)', async () => {
  const stored = new Map();
  globalThis.caches = { default: {
    match: async (req) => stored.get(req.url)?.clone(),
    put: async (req, res) => { stored.set(req.url, res); },
  } };
  try {
    tmdbAnswers({ 'movie/7': { title: 'Dune' } });
    const first = await (await worker.fetch(new Request('https://w/card/movie/7?v=3'), env, { waitUntil: (p) => p }))
      .json();
    const calls = asked.length;
    assert.ok(calls > 0);
    const again = await (await worker.fetch(new Request('https://w/card/movie/7?v=3'), env)).json();
    assert.equal(asked.length, calls, 'nothing asked again');
    assert.deepEqual(again, first);
    tmdbAnswers({});
    assert.equal((await worker.fetch(new Request('https://w/card/movie/8?v=3'), env)).status, 502);
    assert.equal(stored.size, 1, 'a failure is not kept');
  } finally {
    delete globalThis.caches;
  }
});

// /mine: Lampa's CUB rows that are yours, from the CUB account the app signed in to. CUB and TMDB answer by path.
const cubDump = (bookmarks) => ({ secuses: true, version: 9, bookmarks });
const bm = (id, type, card_type, time, card) => ({ id, type, card_id: String(card.id), card_type, time, data: JSON.stringify(card) });
function cub(answers) {
  asked = [];
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    asked.push(u.hostname + u.pathname + (init?.body ? ' ' + String(init.body) : ''));
    const body = answers[u.pathname.replace(/^\/(3|api)\//, '')];
    return body ? new Response(JSON.stringify(body)) : new Response('{"error":true,"code":500}', { status: 500 });
  };
}
const mineEnv = () => ({ ...env, DB: d1(), CUB_ACCOUNTS: '42' });
const getMine = (e, h = lampa) => worker.fetch(new Request('https://w/mine', { headers: h }), e);

test('mine: Continue browsing = the history\'s series, newest first, minus Viewed and Thrown, in English', async () => {
  const e = mineEnv();
  const got = {
    'users/get': { user: { id: 42 } },
    'bookmarks/dump': cubDump([
      bm(1, 'history', 'tv', 100, { id: 1399, name: 'Игра престолов', poster_path: '/got-ru.jpg', source: 'tmdb' }),
      bm(2, 'history', 'tv', 300, { id: 83867, name: 'Андор', poster_path: '/andor-ru.jpg', source: 'cub' }),
      bm(3, 'history', 'tv', 200, { id: 5, name: 'Брошенный', source: 'tmdb' }),
      bm(4, 'thrown', 'tv', 210, { id: 5, name: 'Брошенный' }),
      bm(5, 'history', 'movie', 400, { id: 603, title: 'Матрица', original_title: 'The Matrix' }),
      bm(6, 'history', 'tv', 500, { id: 77, name: 'KP only', source: 'kp' }),
      bm(7, 'book', 'tv', 600, { id: 66, name: 'A bookmark' }),
    ]),
    'tv/83867': { id: 83867, name: 'Andor', first_air_date: '2022-09-21', poster_path: '/andor-en.jpg', vote_average: 8.4,
      status: 'Ended' },
    'tv/1399': { id: 1399, name: 'Game of Thrones', first_air_date: '2011-04-17', poster_path: '/got-en.jpg', vote_average: 8.5,
      backdrop_path: '/b.jpg', status: 'Ended' },
    'tv/5': { id: 5, name: 'Thrown away', poster_path: '/t.jpg' },
  };
  cub(got);
  const res = await getMine(e);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'no-store');
  const body = await res.json();
  assert.deepEqual(body.rows[0], ['Continue browsing', [
    [83867, 'tv', 'Andor', '2022', '/andor-en.jpg', 84, ''],
    [1399, 'tv', 'Game of Thrones', '2011', '/got-en.jpg', 85, '/b.jpg'],
  ]]);
  assert.deepEqual(body.rows.map(([t, cards]) => [t, cards.map((c) => c[0])]).slice(1), [['My list', [66]]]);
  assert.deepEqual(body.mylist, ['tv_66']);
  assert.deepEqual(body.marks, { tv_5: 'thrown' });
  assert.ok(!asked.some((u) => u.includes('tv/5')), 'a thrown series isn\'t asked about');
  cub(got);
  await getMine(e);
  assert.ok(!asked.some((u) => /tv\/(1399|83867)/.test(u)), 'the series kept: TMDB not asked again');
});

test('mine: a series whose last aired episode is watched leaves; Finish later = Scheduled, out of Continue', async () => {
  const e = mineEnv();
  e.DB.raw.prepare('INSERT INTO timeline (hash, time, duration, percent, updated) VALUES (?, 3000, 3100, 97, 1)')
    .run(lampaHashOf('18Carrie'));
  cub({
    'users/get': { user: { id: 42 } },
    'bookmarks/dump': cubDump([
      bm(1, 'history', 'tv', 1, { id: 288673, name: 'Кэрри' }),
      bm(2, 'history', 'tv', 2, { id: 196322, name: 'Тёмная материя' }),
      bm(3, 'history', 'tv', 3, { id: 93740, name: 'Основание' }),
      bm(4, 'scheduled', 'tv', 4, { id: 93740, name: 'Основание' }),
    ]),
    'tv/288673': { id: 288673, name: 'Carrie', original_name: 'Carrie', poster_path: '/c.jpg',
      last_episode_to_air: { season_number: 1, episode_number: 8 } },
    'tv/196322': { id: 196322, name: 'Dark Matter', original_name: 'Dark Matter', poster_path: '/d.jpg',
      last_episode_to_air: { season_number: 2, episode_number: 10 } },
    'tv/93740': { id: 93740, name: 'Foundation', original_name: 'Foundation', poster_path: '/f.jpg',
      last_episode_to_air: { season_number: 3, episode_number: 10 } },
  });
  const { rows, marks } = await (await getMine(e)).json();
  assert.deepEqual(rows.map(([t, cards]) => [t, cards.map((c) => c[2])]),
    [['Continue browsing', ['Dark Matter']], ['Finish later', ['Foundation']]]);
  assert.deepEqual(marks, { tv_93740: 'scheduled' });
});

test('mine: films being watched (5 min in) join the series (the timeline, by Lampa\'s hash of the original title)', async () => {
  const e = mineEnv();
  const point = (title, time, percent) => e.DB.raw.prepare(
    'INSERT INTO timeline (hash, time, duration, percent, updated) VALUES (?, ?, 7000, ?, 1)').run(lampaHashOf(title), time, percent);
  point('The Matrix', 3000, 43);
  point('Finished', 6900, 95);
  point('Opened', 5, 0);
  point('Tried', 123, 1); // a release's first two minutes: its picture and sound
  const film = (id, original) => ({ id, title: 'RU ' + original, original_title: original, poster_path: `/${id}.jpg` });
  cub({ 'users/get': { user: { id: 42 } }, 'bookmarks/dump': cubDump([
    bm(1, 'history', 'movie', 1, film(603, 'The Matrix')), bm(2, 'history', 'movie', 2, film(8, 'Finished')),
    bm(3, 'history', 'movie', 3, film(9, 'Opened')), bm(4, 'history', 'movie', 4, film(10, 'Tried')),
  ]) });
  const { rows } = await (await getMine(e)).json();
  assert.deepEqual(rows[0][1].map((c) => c[0]), [603]);
  assert.equal(rows[0][1][0][2], 'RU The Matrix', 'TMDB down: the card CUB kept');
});

test('mine: Rate what you watched = the history played past 70 % (a series: any episode), no grade yet; the grades', async () => {
  const e = mineEnv();
  e.GRADES = { get: async (k) => (k === '42:7' ? { movie_603: { g: 2, t: 1 }, movie_9: { g: null, t: 2 },
    movie_10: { g: 'skip', t: 3 } } : null) };
  const point = (key, percent) => e.DB.raw.prepare(
    'INSERT INTO timeline (hash, time, duration, percent, updated) VALUES (?, 1, 2, ?, 1)').run(lampaHashOf(key), percent);
  point('The Matrix', 95); // graded
  point('Gone Girl', 80);
  point('Ungraded', 75); // its grade removed
  point('Not mine', 90); // "Didn't watch / not mine"
  point('Half', 50);
  point('Thrown', 99); // marks don't matter
  point('29Foundation', 72);
  point('11:1Long', 70); // season 11, episode 1: Lampa's key
  const film = (id, original) => ({ id, title: 'RU ' + original, original_title: original, poster_path: `/${id}.jpg` });
  cub({ 'users/get': { user: { id: 42 } }, 'bookmarks/dump': cubDump([
    bm(1, 'history', 'movie', 1, film(603, 'The Matrix')), bm(2, 'history', 'movie', 2, film(8, 'Gone Girl')),
    bm(3, 'history', 'movie', 3, film(9, 'Ungraded')), bm(4, 'history', 'movie', 4, film(10, 'Not mine')),
    bm(5, 'history', 'movie', 5, film(11, 'Half')), bm(6, 'history', 'movie', 6, film(12, 'Thrown')),
    bm(7, 'thrown', 'movie', 7, film(12, 'Thrown')),
    bm(8, 'history', 'tv', 8, { id: 93740, name: 'Основание', original_name: 'Foundation', number_of_seasons: 3 }),
    bm(9, 'history', 'tv', 9, { id: 1399, name: 'Игра престолов', original_name: 'Game of Thrones', number_of_seasons: 8 }),
    bm(10, 'history', 'tv', 10, { id: 5, name: 'Долгий', original_name: 'Long' }), // no seasons count: 30 scanned
  ]) });
  const { rows, grades } = await (await getMine(e)).json();
  assert.deepEqual(rows.find(([t]) => t === 'Rate what you watched')[1].map((c) => c[0]), [5, 93740, 12, 9, 8]);
  assert.deepEqual(grades, { movie_603: 2, movie_10: 'skip' }, 'removed ones left out');
});

test('mine: a new episode out with RU/UA audio goes first in Continue browsing, named in "new"', async () => {
  const e = mineEnv();
  const ago = (days) => Date.now() - days * 86400e3;
  const day = (days) => new Date(ago(days)).toISOString().slice(0, 10);
  const watched = (key, days) => e.DB.raw.prepare(
    'INSERT INTO timeline (hash, time, duration, percent, updated) VALUES (?, 1, 2, 95, ?)').run(lampaHashOf(key), ago(days));
  watched('34Foundation', 11); // up to date: E5, the last aired, came after
  watched('19Dark Matter', 500); // its season 2 began after
  watched('13Peaky Blinders', 30); // behind: season 2 long out
  watched('11Severance', 30); // up to date: E2 not aired yet
  watched('37Euphoria', 160); // E8 came after, but 150 days ago
  watched("11Widow's Bay", 20); // E2-E10 since: E2's own date unknown
  const show = (id, name, imdb, seasons, last, aired) => ({ id, name, original_name: name, poster_path: `/${id}.jpg`,
    external_ids: { imdb_id: imdb }, seasons: [{ season_number: 0, episode_count: 3, air_date: '2020-01-01' },
      ...seasons.map(([n, count, air]) => ({ season_number: n, episode_count: count, air_date: air }))],
    last_episode_to_air: { season_number: last[0], episode_number: last[1], air_date: aired } });
  const ru = { streams: [{ infoHash: 'a'.repeat(40), title: 'Foundation.S03E05.2160p\n👤 50 💾 5 GB ⚙️ rutor\n🇷🇺 / 🇬🇧' }] };
  const en = { streams: [{ infoHash: 'b'.repeat(40), title: 'Dark.Matter.S02E01.1080p\n👤 900 💾 2 GB ⚙️ TGx' }] };
  const answers = {
    'users/get': { user: { id: 42 } },
    'bookmarks/dump': cubDump([
      bm(1, 'history', 'tv', 1, { id: 93740, name: 'Основание' }), bm(2, 'history', 'tv', 2, { id: 196322, name: 'Тёмная материя' }),
      bm(3, 'history', 'tv', 3, { id: 60574, name: 'Острые козырьки' }), bm(4, 'history', 'tv', 4, { id: 95396, name: 'Разделение' }),
      bm(5, 'history', 'tv', 5, { id: 85552, name: 'Эйфория' }), bm(6, 'history', 'tv', 6, { id: 270476, name: 'Залив вдов' }),
    ]),
    'tv/93740': show(93740, 'Foundation', 'tt0804484', [[1, 10, '2021-09-23'], [2, 10, '2023-07-14'], [3, 10, day(60)]],
      [3, 5], day(7)),
    'tv/196322': show(196322, 'Dark Matter', 'tt12688584', [[1, 9, '2024-05-08'], [2, 10, day(2)]], [2, 1], day(2)),
    'tv/60574': show(60574, 'Peaky Blinders', 'tt2442560', [[1, 6, '2013-09-12'], [2, 6, '2014-10-02']], [2, 6], '2014-11-06'),
    'tv/95396': show(95396, 'Severance', 'tt11280740', [[1, 9, day(40)]], [1, 1], day(40)),
    'tv/85552': show(85552, 'Euphoria', 'tt8772296', [[3, 8, day(200)]], [3, 8], day(150)),
    'tv/270476': show(270476, "Widow's Bay", 'tt1', [[1, 10, day(60)]], [1, 10], day(5)),
    '/stream/series/tt0804484:3:5.json': ru,
    '/stream/series/tt12688584:2:1.json': en,
  };
  cub(answers);
  const first = await (await getMine(e)).json();
  assert.deepEqual(first.rows[0][1].map((c) => c[2]), ["Foundation", "Widow's Bay", 'Euphoria', 'Peaky Blinders',
    'Dark Matter'], 'Severance: watched to its last aired');
  assert.deepEqual(first.new, { tv_93740: 'S3 E5' }, 'Dark Matter S2 E1: English only so far');
  assert.deepEqual(asked.filter((u) => u.includes('torrentio')).sort(),
    ['torrentio.strem.fun/stream/series/tt0804484:3:5.json', 'torrentio.strem.fun/stream/series/tt12688584:2:1.json']);
  cub(answers);
  const again = await (await getMine(e)).json();
  assert.deepEqual(again.new, { tv_93740: 'S3 E5' });
  assert.ok(!asked.some((u) => u.includes('torrentio')), 'out: kept; not out: asked again in 3 hours');
  e.DB.raw.prepare('UPDATE fresh SET t = 0').run();
  cub({ ...answers, '/stream/series/tt12688584:2:1.json': { streams: [{ ...en.streams[0], title: en.streams[0].title + '\n🇺🇦' }] } });
  assert.deepEqual((await (await getMine(e)).json()).new, { tv_93740: 'S3 E5', tv_196322: 'S2 E1' });
  e.DB.raw.prepare('UPDATE fresh SET t = 0, out = NULL').run();
  cub({ ...answers, '/stream/series/tt0804484:3:5.json': undefined });
  assert.deepEqual((await (await getMine(e)).json()).new, {}, 'Torrentio down: no label');
});

test('mine: a new season years later: any series in the history, past its newest 100; not a Not interested one', async () => {
  const e = mineEnv();
  const ago = (days) => Date.now() - days * 86400e3;
  const day = (days) => new Date(ago(days)).toISOString().slice(0, 10);
  e.DB.raw.prepare('INSERT INTO timeline (hash, time, duration, percent, updated) VALUES (?, 1, 2, 100, 0)').run(lampaHashOf('18Severance'));
  e.DB.raw.prepare('INSERT INTO timeline (hash, time, duration, percent, updated) VALUES (?, 1, 2, 100, 0)').run(lampaHashOf('16Gone'));
  const films = Array.from({ length: 120 }, (_, i) => bm(1000 + i, 'history', 'movie', 1000 + i, { id: 5000 + i, title: `F${i}` }));
  const show = (id, name, imdb) => ({ id, name, original_name: name, poster_path: `/${id}.jpg`, status: 'Returning Series',
    external_ids: { imdb_id: imdb }, seasons: [{ season_number: 1, episode_count: 8, air_date: '2022-02-18' },
      { season_number: 2, episode_count: 10, air_date: day(3) }],
    last_episode_to_air: { season_number: 2, episode_number: 1, air_date: day(3) } });
  cub({
    'users/get': { user: { id: 42 } },
    'bookmarks/dump': cubDump([...films, bm(1, 'history', 'tv', 1, { id: 95396, name: 'Разделение' }),
      bm(2, 'history', 'tv', 2, { id: 7, name: 'Ушедший' }), bm(3, 'thrown', 'tv', 3, { id: 7, name: 'Ушедший' })]),
    'tv/95396': show(95396, 'Severance', 'tt11280740'),
    'tv/7': show(7, 'Gone', 'tt7'),
    '/stream/series/tt11280740:2:1.json': { streams: [{ infoHash: 'c'.repeat(40), title: 'Severance.S02E01\n👤 9 💾 3 GB ⚙️ x\n🇷🇺' }] },
  });
  const { rows, new: fresh } = await (await getMine(e)).json();
  assert.deepEqual(fresh, { tv_95396: 'S2 E1' });
  assert.equal(rows[0][1][0][2], 'Severance', 'first in Continue browsing though 120 films came after it');
  assert.ok(!asked.some((u) => u.includes('tv/7')), 'Not interested: not followed');
});

test('shows: TMDB asked again on the next air date, a month after it ended, every 3 days without a date', async () => {
  const e = mineEnv();
  const ago = (days) => Date.now() - days * 86400e3;
  const row = (id, status, nextAir, days) => e.DB.raw.prepare(`INSERT INTO shows (id, original, last, card, t, imdb, seasons,
    aired, status, next_air) VALUES (?, 'x', '1:1', '[1,"tv","x","","",0,""]', ?, 'tt', '[]', null, ?, ?)`).run(id, ago(days), status, nextAir);
  const day = (days) => new Date(ago(days)).toISOString().slice(0, 10);
  row(1, 'Ended', null, 20); // kept
  row(2, 'Ended', null, 31); // asked
  row(3, 'Returning Series', day(-5), 2); // kept: airs in 5 days
  row(4, 'Returning Series', day(0), 0.5); // asked: airs today
  row(5, 'Returning Series', null, 2); // kept
  row(6, 'Returning Series', null, 4); // asked
  cub({ 'users/get': { user: { id: 42 } }, 'bookmarks/dump': cubDump([1, 2, 3, 4, 5, 6].map((id) =>
    bm(id, 'history', 'tv', id, { id, name: `S${id}` }))) });
  await getMine(e);
  assert.deepEqual(asked.filter((u) => u.includes('themoviedb')).map((u) => u.match(/tv\/(\d+)/)[1]).sort(), ['2', '4', '6']);
});

test('mine/book and mine/unbook: My list is CUB\'s Bookmarks (Later too, when removing)', async () => {
  const e = mineEnv();
  const answers = {
    'users/get': { user: { id: 42 } },
    'bookmarks/dump': cubDump([bm(11, 'wath', 'movie', 1, { id: 603, title: 'Матрица' }), bm(12, 'book', 'movie', 2, { id: 603 })]),
    'bookmarks/add': { secuses: true },
    'bookmarks/remove': { secuses: true },
    'movie/603': { id: 603, title: 'The Matrix', poster_path: '/m.jpg' },
    'movie/604': { id: 604, title: 'Reloaded', poster_path: '/r.jpg' },
  };
  cub(answers);
  const post = (path) => worker.fetch(new Request('https://w/mine/' + path, { method: 'POST', headers: lampa }), e);
  assert.equal((await post('book/movie/604')).status, 204);
  const sent = (method) => asked.filter((u) => u.includes(`bookmarks/${method}`)).map((u) => new URLSearchParams(u.split(' ')[1]));
  assert.deepEqual(sent('add').map((f) => [f.get('type'), f.get('card_id'), f.get('id')]), [['book', '604', '0']]);
  cub(answers);
  assert.equal((await post('unbook/movie/603')).status, 204);
  assert.deepEqual(sent('remove').map((f) => [f.get('type'), f.get('id')]).sort(), [['book', '12'], ['wath', '11']]);
  cub(answers);
  const { rows, mylist } = await (await getMine(e)).json();
  assert.deepEqual(mylist, ['movie_603']);
  assert.deepEqual(rows.map(([t]) => t), ['My list']);
});

test('cron at 04 UTC: New in 4K from CUB\'s 4K list, well-known ones, each kept from its first day; /mine shows the unseen', async () => {
  const e = { ...mineEnv(), GRADES: { get: async () => ({ movie_3: { g: 1, t: 1 } }) } };
  const list = { movie: [[1, 500, null], [2, 20, null], [3, 300, 6.1], [4, 10, 7.4], [5, 200, null]], tv: [[9, 150, 7.9]] };
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.hostname === 'tmdb.cub.best') {
      const page = Number(u.searchParams.get('page'));
      const results = page === 1 ? list[u.searchParams.get('cat')].map(([id, votes, imdb]) => ({ id, vote_count: String(votes), imdb_rating: imdb })) : [];
      return new Response(JSON.stringify({ results }));
    }
    const m = u.pathname.match(/\/3\/(movie|tv)\/(\d+)$/);
    return m ? new Response(JSON.stringify({ id: Number(m[2]), title: `T${m[2]}`, name: `T${m[2]}`, poster_path: '/p.jpg' }))
      : new Response('{}', { status: 404 });
  };
  await worker.scheduled({ cron: '23 * * * *', scheduledTime: Date.UTC(2026, 9, 31, 4, 23) }, e);
  const kept = e.DB.raw.prepare('SELECT type, id, pos FROM uhd ORDER BY t DESC, pos').all().map((r) => `${r.type}${r.id}`);
  assert.deepEqual(kept, ['movie1', 'tv9', 'movie3', 'movie4', 'movie5'], '2: 20 votes, IMDb none');
  list.movie.unshift([6, 900, 8]);
  await worker.scheduled({ cron: '23 * * * *', scheduledTime: Date.UTC(2026, 10, 1, 4, 23) }, e);
  cub({ 'users/get': { user: { id: 42 } }, 'bookmarks/dump': cubDump([bm(1, 'history', 'movie', 1, { id: 1, title: 'Played' })]) });
  const { rows } = await (await getMine(e)).json();
  assert.deepEqual(rows.find(([t]) => t === 'New in 4K')[1].map((c) => c[0]), [6, 9, 4, 5], 'newest first; played 1, graded 3 left out');
});

test('cron other hours: For you from TMDB recommendations of graded films, ranked per account; /mine leaves out played', async () => {
  const grades = { '42:7': { movie_1: { g: 2, t: 1 }, movie_2: { g: 1, t: 2 }, movie_3: { g: -1, t: 3 }, movie_4: { g: 0, t: 4 },
    movie_12: { g: 1, t: 5 }, movie_20: { g: 'skip', t: 6 } } };
  const e = { ...mineEnv(), GRADES: { list: async () => ({ keys: [{ name: '42:7' }] }), get: async (k) => grades[k] ?? null } };
  const rec = (id, votes = 500, rating = 7, genres = []) => ({ id, title: `R${id}`, poster_path: '/p.jpg', vote_count: votes,
    vote_average: rating, genre_ids: genres });
  const recs = {
    1: [rec(10), rec(11), rec(12), rec(13, 100), rec(14, 500, 5), rec(15, 500, 7, [16])],
    2: [rec(11), rec(16)],
    3: [rec(16), rec(17)],
  };
  let asks = 0;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const r = u.pathname.match(/\/3\/movie\/(\d+)\/recommendations$/);
    if (r) {
      asks++;
      return new Response(JSON.stringify({ results: recs[r[1]] || [] }));
    }
    const m = u.pathname.match(/\/3\/(movie|tv)\/(\d+)$/);
    return m ? new Response(JSON.stringify({ id: Number(m[2]), title: `R${m[2]}`, poster_path: '/p.jpg' })) : new Response('{}', { status: 404 });
  };
  await worker.scheduled({ cron: '23 * * * *', scheduledTime: Date.UTC(2026, 9, 31, 5, 23) }, e);
  assert.equal(asks, 0, 'New in 4K empty: that first');
  e.DB.raw.prepare("INSERT INTO uhd (type, id, t, pos, card) VALUES ('movie', 99, 1, 0, null)").run();
  await worker.scheduled({ cron: '23 * * * *', scheduledTime: Date.UTC(2026, 9, 31, 5, 23) }, e);
  assert.equal(asks, 4, 'Loved, Good, Good, Bad: OK and skip are no seeds');
  const top = JSON.parse(e.DB.raw.prepare('SELECT cards FROM foryou WHERE who = ?').get('42:7').cards).map((c) => c[0]);
  assert.deepEqual(top, [11, 10], '12 graded; 13 few votes, 14 low, 15 a cartoon, 16 cancelled by Bad, 17 below 0');
  await worker.scheduled({ cron: '23 * * * *', scheduledTime: Date.UTC(2026, 9, 31, 6, 23) }, e);
  assert.equal(asks, 4, 'kept a week');
  cub({ 'users/get': { user: { id: 42 } }, 'bookmarks/dump': cubDump([bm(1, 'history', 'movie', 1, { id: 11, title: 'Seen' })]) });
  e.GRADES.get = async (k) => grades[k] ?? null;
  const { rows } = await (await getMine(e)).json();
  assert.deepEqual(rows.find(([t]) => t === 'For you')[1].map((c) => c[0]), [10]);
});

test('mine: no CUB sign-in, or an account not allowed → 401; CUB down → 502; nothing to continue → no row', async () => {
  const e = mineEnv();
  cub({ 'users/get': { user: { id: 9 } } });
  assert.equal((await getMine(e)).status, 401);
  assert.equal((await getMine(e, {})).status, 401);
  cub({ 'users/get': { user: { id: 42 } } });
  assert.equal((await getMine(e)).status, 502);
  cub({ 'users/get': { user: { id: 42 } }, 'bookmarks/dump': cubDump([]) });
  assert.deepEqual(await (await getMine(e)).json(), { rows: [], marks: {}, grades: {}, new: {}, mylist: [] });
});

test('mine/history: a film played on the stick goes to the front of Lampa\'s history as Lampa\'s card; again: moved', async () => {
  const e = mineEnv();
  const answers = {
    'users/get': { user: { id: 42 } },
    'bookmarks/dump': cubDump([bm(34634269, 'history', 'movie', 1, { id: 603, title: 'Матрица' })]),
    'bookmarks/add': { secuses: true },
    'movie/603': { id: 603, title: 'The Matrix', original_title: 'The Matrix', poster_path: '/m.jpg', genres: [{ id: 28 }],
      release_date: '1999-03-30', vote_average: 8.2, credits: { cast: [] }, homepage: 'x' },
    'tv/1399': { id: 1399, name: 'Game of Thrones', first_air_date: '2011-04-17', number_of_seasons: 8, genres: [] },
  };
  cub(answers);
  const post = (path) => worker.fetch(new Request('https://w/mine/history/' + path, { method: 'POST', headers: lampa }), e);
  assert.equal((await post('movie/603')).status, 204);
  const sent = new URLSearchParams(asked.find((u) => u.includes('bookmarks/add')).split(' ')[1]);
  assert.equal(sent.get('type'), 'history');
  assert.equal(sent.get('card_id'), '603');
  assert.equal(sent.get('id'), '34634269', 'already there: Lampa sends its bookmark id');
  assert.deepEqual(JSON.parse(sent.get('data')), { source: 'tmdb', genre_ids: [28], id: 603, title: 'The Matrix',
    original_title: 'The Matrix', poster_path: '/m.jpg', release_date: '1999-03-30', vote_average: 8.2,
    img: 'https://image.tmdb.org/t/p/w300/m.jpg' });
  cub(answers);
  assert.equal((await post('tv/1399')).status, 204);
  assert.equal(new URLSearchParams(asked.find((u) => u.includes('bookmarks/add')).split(' ')[1]).get('id'), '0');
  cub({ ...answers, 'bookmarks/add': undefined });
  assert.equal((await post('tv/1399')).status, 502, 'CUB refused');
  cub({ 'users/get': { user: { id: 9 } } });
  assert.equal((await post('tv/1399')).status, 401);
});

test('mine/<mark>: kept in D1 per account and profile (CUB\'s marks need Premium); one at a time; none removes it', async () => {
  const e = mineEnv();
  const answers = {
    'users/get': { user: { id: 42 } },
    'bookmarks/dump': cubDump([
      bm(1, 'history', 'tv', 3, { id: 1399, name: 'Игра престолов' }), bm(2, 'history', 'movie', 2, { id: 7340, title: 'Кэрри' }),
      bm(3, 'history', 'tv', 1, { id: 196322, name: 'Тёмная материя' }),
    ]),
    'tv/1399': { id: 1399, name: 'Game of Thrones', poster_path: '/g.jpg' },
    'tv/196322': { id: 196322, name: 'Dark Matter', poster_path: '/d.jpg' },
  };
  const post = (path, h = lampa) => worker.fetch(new Request('https://w/mine/' + path, { method: 'POST', headers: h }), e);
  const titles = async () => { cub(answers); return (await (await getMine(e)).json()); };
  cub(answers);
  assert.equal((await post('scheduled/tv/1399')).status, 204);
  assert.ok(!asked.some((u) => u.includes('bookmarks/')), 'nothing asked of CUB');
  cub(answers);
  assert.equal((await post('thrown/movie/7340')).status, 204);
  let body = await titles();
  assert.deepEqual(body.rows.map(([t, c]) => [t, c.map((x) => x[2])]), [['Continue browsing', ['Dark Matter']], ['Finish later', ['Game of Thrones']]]);
  assert.deepEqual(body.marks, { tv_1399: 'scheduled', movie_7340: 'thrown' });
  cub(answers);
  await post('viewed/tv/1399'); // one at a time
  cub(answers);
  await post('none/movie/7340');
  body = await titles();
  assert.deepEqual(body.marks, { tv_1399: 'viewed' });
  assert.deepEqual(body.rows.map(([t]) => t), ['Continue browsing']);
  cub({ ...answers, 'users/get': { user: { id: 42 } } });
  assert.equal((await post('scheduled/tv/1399', { 'X-Cub-Token': 'other', 'X-Cub-Profile': '8' })).status, 204);
  assert.deepEqual((await titles()).marks, { tv_1399: 'viewed' }, 'another profile\'s marks are its own');
  assert.equal((await post('look/tv/1399')).status, 400, 'not one of the app\'s marks');
});

// Lampa's Utils.hash, as the app's Timeline.key: Java's String.hashCode, positive.
function lampaHashOf(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return String(Math.abs(h));
}
test('Lampa\'s hash: the same keys as Lampa and the app (TimelineTest)', () => {
  assert.equal(lampaHashOf('The Dark Knight'), '13906648'); // TimelineTest's, which matches Lampa's timeline
});

// Series: DDD gets the episode asked for and the ones after it as a playlist of this worker's /stream addresses.
const season = {
  id: 11, hash: H, download_present: true, progress: 1,
  files: [
    { id: 5, name: 'Foundation S01/Foundation.S01E10.mkv', short_name: 'Foundation.S01E10.mkv', size: 3e9 },
    { id: 4, name: 'Foundation S01/Foundation.S01E09.mkv', short_name: 'Foundation.S01E09.mkv', size: 3e9 },
    { id: 3, name: 'Foundation S01/Foundation.S01E08.mkv', short_name: 'Foundation.S01E08.mkv', size: 3e9 },
    { id: 7, name: 'Foundation S01/Foundation.S01E10.sample.mkv', short_name: 'Foundation.S01E10.sample.mkv', size: 1e7 },
    { id: 6, name: 'Foundation S01/Foundation.S02E01.mkv', short_name: 'Foundation.S02E01.mkv', size: 3e9 },
  ],
};
const seasonEnv = () => ({ ...playEnv, DB: d1() });
const series = (e, q) => worker.fetch(new Request(`https://w/play/${H}?${q}`, { headers: stick }), e).then((r) => r.json());

test('play a series\' episode: DDD\'s playlist from it on, in order, Lampa\'s keys, samples left out', async () => {
  torbox({ ...ready, 'mylist?id': { success: true, data: season } });
  const e = seasonEnv();
  const res = await series(e, 'file=1&name=Foundation.S01E09.mkv&tl=1&series=Foundation');
  assert.deepEqual(res.playlist.map(([s, ep, key, name]) => [s, ep, key, name]), [
    [1, 9, lampaHashOf('19Foundation'), 'Foundation.S01E09.mkv'],
    [1, 10, lampaHashOf('110Foundation'), 'Foundation.S01E10.mkv'],
    [2, 1, lampaHashOf('21Foundation'), 'Foundation.S02E01.mkv'],
  ]);
  assert.equal(res.url, res.playlist[0][4], 'DDD starts on the episode asked for');
  assert.ok(res.playlist[1][4].startsWith(`https://w/stream/11/5?tl=${lampaHashOf('110Foundation')}&prev=${lampaHashOf('19Foundation')}&sig=`));
  const again = await series(e, 'file=1&name=Foundation.S01E09.mkv&tl=1&series=Foundation');
  assert.deepEqual(again.playlist, res.playlist, 'the same addresses every time: DDD keeps its resume point per address');
  // a film, or no series asked: one link as before
  assert.equal((await series(e, 'file=1&name=Foundation.S01E09.mkv')).playlist, undefined);
});

test('stream: TorBox\'s link for an address /play made; any other → 403, TorBox asked nothing', async () => {
  torbox({ ...ready, 'mylist?id': { success: true, data: season } });
  const e = seasonEnv();
  const next = (await series(e, 'name=Foundation.S01E09.mkv&series=Foundation')).playlist[1][4];
  torbox(ready);
  const res = await worker.fetch(new Request(next), e);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('Location'), 'https://store.torbox.app/dl/xyz');
  assert.ok(asked.some((u) => u.includes('torrent_id=11&file_id=5')));
  for (const bad of [next.replace('sig=', 'sig=0'), next.replace('/stream/11/5', '/stream/11/6'), next.replace(/tl=\d+/, 'tl=1')]) {
    torbox(ready);
    assert.equal((await worker.fetch(new Request(bad), e)).status, 403, bad);
    assert.deepEqual(asked, []);
  }
});

test('stream: the next episode\'s first ask marks the one streamed before it watched; seeks and cold starts don\'t', async () => {
  const stored = new Map();
  globalThis.caches = { default: {
    match: async (req) => stored.get(req.url)?.clone(),
    put: async (req, res) => { stored.set(req.url, res); },
  } };
  try {
    torbox({ ...ready, 'mylist?id': { success: true, data: season } });
    const e = seasonEnv();
    const list = (await series(e, 'name=Foundation.S01E09.mkv&series=Foundation')).playlist;
    const percent = (key) => e.DB.raw.prepare('SELECT percent FROM timeline WHERE hash = ?').get(key)?.percent;
    torbox(ready);
    const ask = (url, range) => worker.fetch(new Request(url, { headers: range ? { Range: range } : {} }), e);
    await ask(list[0][4]); // S1E9 starts (/play kept its link: no TorBox call)
    assert.deepEqual(asked, []);
    await ask(list[2][4], 'bytes=0-'); // S2E1 by hand: S1E10 never streamed
    assert.equal(percent(list[1][2]), undefined);
    await ask(list[1][4], 'bytes=5000000-'); // a seek into S1E10 isn't its start
    assert.equal(percent(list[0][2]), undefined);
    await ask(list[1][4]); // DDD goes on to S1E10: S1E9 watched
    assert.equal(percent(list[0][2]), 100);
  } finally {
    delete globalThis.caches;
  }
});

// Skip times: IntroDB (IMDb id) and TheIntroDB (TMDB id) merged into DDD's "segments" format, kept in D1.
// Foundation S1 E9 as both answered on 2026-10-31: they differ on the intro's end (84 s / 58.9 s).
let keys = []; // the Authorization each was asked with
function skipAnswers(byHost) {
  asked = [];
  keys = [];
  globalThis.fetch = async (url, init) => {
    asked.push(String(url));
    keys.push(new Headers(init?.headers).get('Authorization'));
    const u = new URL(url);
    const body = byHost[u.hostname]?.(u.searchParams);
    return body === undefined ? new Response('down', { status: 500 })
      : body === null ? new Response('{"error":"Not found"}', { status: 404 }) : new Response(JSON.stringify(body));
  };
}
const foundation = {
  'api.introdb.app': (q) => (q.get('episode') === '9' ? {
    intro: { start_ms: 0, end_ms: 84000 }, recap: null, outro: { start_ms: 3390000, end_ms: 3451000 } } : null),
  'api.theintrodb.org': (q) => (q.get('episode') === '9' ? {
    intro: [{ start_ms: null, end_ms: 58867 }], credits: [{ start_ms: 3395489, end_ms: null }] } : { intro: [] }),
};
const skip = (path, headers = stick) => worker.fetch(new Request(`https://w/segments/${path}`, { headers }), skipEnv);
let skipEnv;

test('segments: the intro that ends first, the credits that start last; episodes with none left out', async () => {
  skipEnv = { ...playEnv, DB: d1() };
  skipAnswers(foundation);
  const res = await skip('tv/93740/tt0804484?e=1:9,1:10');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { '1:9': 'intro:0-58867;credits:3395489-' });
  assert.equal(asked.length, 4);
  assert.ok(asked.includes('https://api.introdb.app/segments?imdb_id=tt0804484&season=1&episode=9'));
  assert.ok(asked.includes('https://api.theintrodb.org/v4/media?tmdb_id=93740&season=1&episode=9'));
  // again: both from D1, the one with none too (a day)
  skipAnswers({});
  assert.deepEqual(await (await skip('tv/93740/tt0804484?e=1:9,1:10')).json(), { '1:9': 'intro:0-58867;credits:3395489-' });
  assert.equal(asked.length, 0);
});

test('segments: a film under "0:0", a recap, an end before the next scene; not kept while one is down', async () => {
  skipEnv = { ...playEnv, DB: d1() };
  skipAnswers({
    'api.introdb.app': () => ({ intro: null, recap: { start_ms: 95000, end_ms: 259000 },
      outro: { start_ms: 10452995, end_ms: 10822200 } }),
  }); // TheIntroDB down
  assert.deepEqual(await (await skip('movie/872585/tt15398776')).json(),
    { '0:0': 'recap:95000-259000;credits:10452995-10822200' });
  assert.equal(asked[0], 'https://api.introdb.app/segments?imdb_id=tt15398776&is_movie=true');
  assert.equal(asked[1], 'https://api.theintrodb.org/v4/media?tmdb_id=872585');
  assert.equal(skipEnv.DB.raw.prepare('select count(*) n from segments').get().n, 0); // asked again next time
  skipAnswers({});
  assert.deepEqual(await (await skip('tv/1/tt1?e=2:1')).json(), {});
  assert.equal(skipEnv.DB.raw.prepare('select count(*) n from segments').get().n, 0);
});

test('segments: the stick only, 6 episodes at most, nonsense ones dropped', async () => {
  skipEnv = { ...playEnv, DB: d1() };
  skipAnswers(foundation);
  assert.equal((await skip('tv/93740/tt0804484?e=1:9', {})).status, 403);
  skipEnv.THEINTRODB_API_KEY = 'tidb-key';
  assert.equal(asked.length, 0);
  await skip('tv/93740/tt0804484?e=1:1,1:2,x,1:3,1:4,1:5,1:6,1:7');
  assert.equal(asked.length, 12);
  assert.equal(keys.filter((k) => k === 'Bearer tidb-key').length, 6); // TheIntroDB's, with the key
});

// Our own intro times (intro-detect.py on the old MacBook) beat the community's, per release; missing ones queue a job.
test('segments: our own intro for the release played wins; episodes without one queue a job', async () => {
  skipEnv = { ...playEnv, DB: d1() };
  skipAnswers(foundation);
  const asks = (q) => skip(`tv/93740/tt0804484?e=1:9,1:10&h=${H}&f=8&n=Foundation.S01E09.mkv&o=Foundation${q}`);
  assert.deepEqual(await (await asks('')).json(), { '1:9': 'intro:0-58867;credits:3395489-' });
  const job = skipEnv.DB.raw.prepare('SELECT key, file, name, series FROM intro_jobs').all();
  assert.deepEqual(job.map((j) => ({ ...j })), [{ key: `${H}/1/9`, file: 8, name: 'Foundation.S01E09.mkv', series: 'Foundation' }]);
  // the detector takes it, finds S1 E9's titles at 31.8-113.9 s and none in E10 (the finale's own opening): 0-0
  const jobs = await (await worker.fetch(new Request('https://w/segments/jobs', { headers: stick }), skipEnv)).json();
  assert.deepEqual(jobs.jobs.map((j) => [j.key, j.have]), [[`${H}/1/9`, []]]);
  const own = (body, token = stick) => worker.fetch(new Request('https://w/segments/own', {
    method: 'POST', headers: { ...token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), skipEnv);
  assert.equal((await own({ intros: [] }, {})).status, 403);
  assert.equal((await own({ intros: [{ hash: H, season: 1, episode: 9, start: 31800, end: 113900, recap: 31800 },
    { hash: H, season: 1, episode: 8, start: 20000, end: 100000, recap: 25000 }, // a recap past the intro: none
    { hash: H, season: 1, episode: 10, start: 0, end: 0 }, { hash: H, season: 1, episode: 1, start: 5, end: 5 },
    { hash: 'x', season: 1, episode: 1, start: 0, end: 1 }],
    done: [`${H}/1/9`] })).status, 204);
  assert.equal(skipEnv.DB.raw.prepare('SELECT count(*) n FROM intro_jobs').get().n, 0);
  skipAnswers(foundation);
  assert.deepEqual(await (await asks('')).json(), { '1:9': 'recap:0-31800;intro:31800-113900;credits:3395489-' });
  assert.equal(skipEnv.DB.raw.prepare('SELECT count(*) n FROM intros').get().n, 3, 'E8, E9 and E10\'s none; not 5-5');
  assert.equal(skipEnv.DB.raw.prepare(`SELECT recap_ms FROM intros WHERE key = '${H}/1/8'`).get().recap_ms, null);
  assert.equal(skipEnv.DB.raw.prepare('SELECT count(*) n FROM intro_jobs').get().n, 0, 'nothing left to find');
  // another release of the same episodes: the community's again
  assert.deepEqual(await (await skip(`tv/93740/tt0804484?e=1:9&h=${'cd'.repeat(20)}`)).json(), { '1:9': 'intro:0-58867;credits:3395489-' });
});

test('play ?probe: links that mark nothing watched, and /stream answers them', async () => {
  torbox({ ...ready, 'mylist?id': { success: true, data: season } });
  const e = seasonEnv();
  const res = await series(e, 'file=1&name=Foundation.S01E09.mkv&series=Foundation&probe=1');
  assert.deepEqual(res.playlist.map(([s, ep]) => [s, ep]).slice(-3), [[1, 9], [1, 10], [2, 1]], 'the whole torrent');
  const e10 = res.playlist.find(([s, ep]) => s === 1 && ep === 10)[4];
  assert.ok(e10.startsWith('https://w/stream/11/5?tl=&prev=&sig='), e10);
  torbox(ready);
  assert.equal((await worker.fetch(new Request(e10), e)).status, 302);
  assert.equal(e.DB.raw.prepare('SELECT count(*) n FROM timeline').get().n, 0);
});
