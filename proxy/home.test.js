// Tests for the worker's GET /home. Run: node --test 'proxy/*.test.js'  (Node 22+, no dependencies; fetch is mocked)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from './cloudflare-worker.js';

const env = { TMDB_API_KEY: 'eyJ.test.token' };

function tmdbAnswers(byPath) {
  globalThis.fetch = async (url) => {
    const body = byPath[new URL(url).pathname.replace('/3/', '')];
    return body ? new Response(JSON.stringify(body)) : new Response('down', { status: 500 });
  };
}

test('sends only what a card draws: [id, type, name, year, poster, score]', async () => {
  tmdbAnswers({
    'trending/all/day': {
      results: [
        { id: 1, media_type: 'movie', title: 'Фильм', release_date: '2026-05-01', poster_path: '/p.jpg',
          backdrop_path: '/b.jpg', vote_average: 8.64, overview: 'a long text the stick never needs' },
        { id: 2, media_type: 'tv', name: 'Сериал', first_air_date: '2021-09-24', poster_path: '/q.jpg', vote_average: 0 },
        { id: 3, media_type: 'person', name: 'Актёр', profile_path: '/a.jpg' },
        { id: 4, media_type: 'movie', title: 'Без постера', release_date: '2020-01-01', poster_path: null },
      ],
    },
  });
  const res = await worker.fetch(new Request('https://w/home'), env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'max-age=3600');
  // the other seven rows failed (500) and are left out instead of blanking the screen
  assert.deepEqual((await res.json()).rows, [
    ['Today in trend', [[1, 'movie', 'Фильм', '2026', '/p.jpg', 86], [2, 'tv', 'Сериал', '2021', '/q.jpg', 0]]],
  ]);
});

test('answers 502 when every row fails', async () => {
  tmdbAnswers({});
  assert.equal((await worker.fetch(new Request('https://w/home'), env)).status, 502);
});
