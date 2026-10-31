// The plugin's timeline sync (the block itself, cut out of grades-patch.js) against a fake Lampa and a
// fake worker. Run: node --test test-timeline.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./grades-patch.js', import.meta.url), 'utf8');
const block = src.slice(src.indexOf('  // Resume points shared with lampa-native'), src.indexOf('  // `more`: extra menu items'));

async function run(mine, theirs) {
  const applied = [];
  const posted = [];
  const listeners = [];
  const Lampa = {
    Storage: { get: (name, d) => (name === 'account' ? { token: 't', profile: { id: 7 } } : name === 'file_view_7' ? mine : d) },
    Timeline: {
      filename: () => 'file_view_7',
      listener: { follow: (name, fn) => listeners.push(fn) },
      update(p) { // Lampa stores it and fires its update event, received or not
        applied.push(p);
        listeners.forEach((fn) => fn({ data: { hash: p.hash, road: { ...p } } }));
      },
    },
  };
  const fetch = async (url, init = {}) => {
    if (init.method === 'POST') posted.push(...JSON.parse(init.body).timelines);
    return { ok: true, json: async () => ({ timelines: theirs }) };
  };
  const document = { hidden: false, addEventListener: () => {} };
  new Function('Lampa', 'fetch', 'document', block)(Lampa, fetch, document);
  await new Promise((r) => setTimeout(r, 10));
  return { applied, posted, Lampa };
}

test('first sync: all of Lampa\'s points go up; ones from before Lampa stamped them count as oldest; bare numbers stay', async () => {
  const { applied, posted } = await run({
    1: { time: 100, duration: 1000, percent: 10, updated: 5000 },
    2: { time: 300, duration: 1200, percent: 25, card: 'tv_1399', season: 1, episode: 5 },
    3: 40, // a legacy percent only
  }, {});
  assert.deepEqual(applied, []);
  assert.deepEqual(posted, [
    { hash: '1', time: 100, duration: 1000, percent: 10, updated: 5000 },
    { hash: '2', time: 300, duration: 1200, percent: 25, updated: 1, card: 'tv_1399', season: 1, episode: 5 },
  ]);
});

test('per point the newer wins: newer from the server go into Lampa (received, not sent back), newer in Lampa go up', async () => {
  const { applied, posted } = await run({
    a: { time: 10, duration: 100, percent: 10, updated: 1000 },
    b: { time: 90, duration: 100, percent: 90, updated: 3000 },
  }, {
    a: { time: 50, duration: 100, percent: 50, updated: 2000 }, // newer: into Lampa
    b: { time: 20, duration: 100, percent: 20, updated: 2000 }, // older: Lampa's goes up
    c: { time: 30, duration: 100, percent: 30, updated: 2000, card: 'movie_1' }, // new to Lampa
  });
  assert.deepEqual(applied.map((p) => [p.hash, p.time, p.received]), [['a', 50, true], ['c', 30, true]]);
  assert.deepEqual(posted.map((p) => [p.hash, p.time]), [['b', 90]]);
});

test('Lampa\'s own change afterwards goes up at once', async () => {
  const { posted, Lampa } = await run({}, {});
  Lampa.Timeline.update({ hash: 'z', time: 5, duration: 50, percent: 10, updated: 9000 });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(posted, [{ hash: 'z', time: 5, duration: 50, percent: 10, updated: 9000 }]);
});
