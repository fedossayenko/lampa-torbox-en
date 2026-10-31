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
  });
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
    { name: 'Film', original: '', line: '', overview: '', scores: [], seasons: [], imdb: '', episodes: [], people: '' });
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
