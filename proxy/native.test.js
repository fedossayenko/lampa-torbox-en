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
