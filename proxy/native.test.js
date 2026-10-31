// Tests for the routes lampa-native uses (GET /home, GET /card). Run: node --test 'proxy/*.test.js'  (Node 22+, no dependencies; fetch is mocked)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './cloudflare-worker.js';

const env = { TMDB_API_KEY: 'eyJ.test.token' };
let asked = []; // every URL the worker fetched

function tmdbAnswers(byPath) {
  asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
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
      vote_average: 8.15, poster_path: '/p.jpg', production_companies: [{ name: 'Legendary' }],
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
    people: 'Director Denis Villeneuve · Cast Timothée Chalamet, Zendaya, Rebecca Ferguson, Javier Bardem, Josh Brolin, Austin Butler',
  });
});

test('series: original name, seasons with their TMDB scores (no specials, no unrated), creators, MDBList asked as "show"', async () => {
  tmdbAnswers({
    'tv/9': {
      name: 'Squid Game', original_name: '오징어 게임', first_air_date: '2021-09-17', number_of_seasons: 2, genres: [],
      vote_average: 7.9, created_by: [{ name: 'Hwang Dong-hyuk' }], credits: { cast: [] },
      seasons: [{ season_number: 0, vote_average: 7 }, { season_number: 1, vote_average: 8.4 },
        { season_number: 2, vote_average: 0 }],
    },
    '/tmdb/show/9': { ratings: [{ source: 'imdb', value: 8 }] },
  });
  const film = await (await card('tv/9')).json();
  assert.equal(film.original, '오징어 게임');
  assert.equal(film.line, '2021 · 2 seasons');
  assert.deepEqual(film.scores, [['TMDB', '7.9', 79], ['IMDb', '8.0', 80]]); // under 3 sources: no verdict
  assert.deepEqual(film.seasons, [['S1', '8.4', 84]]);
  assert.equal(film.people, 'Created by Hwang Dong-hyuk');
});

test('film page without MDBList still opens; fields TMDB leaves out are empty strings, never null', async () => {
  tmdbAnswers({ 'movie/5': { title: 'Film' } }); // MDBList answers 500
  const res = await card('movie/5');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(),
    { name: 'Film', original: '', line: '', overview: '', scores: [], seasons: [], people: '' });
});

test('film page answers TMDB\'s 404 as 404 and other TMDB failures as 502', async () => {
  globalThis.fetch = async () => new Response('{}', { status: 404 });
  assert.equal((await card('movie/1')).status, 404);
  tmdbAnswers({});
  assert.equal((await card('tv/1')).status, 502);
});
