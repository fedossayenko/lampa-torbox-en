// Self-check for LangDetect in the built plugin: node test-lang.mjs
import fs from 'fs';
import assert from 'assert/strict';
const src = fs.readFileSync(new URL('./torbox-lampa-plugin-en.js', import.meta.url), 'utf8');
const a = src.indexOf('  const LangDetect'), b = src.indexOf('  // ───────────────────────────── Search helpers');
const { detect, matches } = new Function(src.slice(a, b) + '; return LangDetect;')();
const d = (Title, Tracker = 'x', extra = {}) => detect({ Title, Tracker, ...extra });

assert.deepEqual(d('Гамильтон / Hamilton (2020) / ПМ (SDI Media) / WEB-DL', 'kinozal'), ['RU']);
assert.deepEqual(d('Гамильтон (1 сезон) [Оригинал] [1080p]', 'ultradox'), ['ORIG']);
assert.deepEqual(d('Hamilton.2020.2160p.WEB.H265', 'torrentio:1337x'), ['EN']);
assert.deepEqual(d('Темная материя', 'torrentio:Rutracker', { TorrentioLangs: '🇬🇧 / 🇷🇺 / 🇺🇦' }), ['EN', 'RU', 'UK']);
assert.deepEqual(d('Dark.Matter.S01.PL.Ai.1080p', 'torrentio:BestTorrents', { TorrentioLangs: '🇵🇱' }), ['PL']);
assert.deepEqual(d('Frozen.2013.BGAudio.1080p'), ['BG']);
assert.deepEqual(d('Film.2021.1080p.BG.Subs'), ['BG-SUB']);
assert.deepEqual(d('x', 'rutor', { ffprobe: [{ codec_type: 'audio', tags: { language: 'ukr' } }, { codec_type: 'audio', tags: { language: 'swe' } }] }), ['UK', 'SV', 'RU']);
assert.ok(matches(['EN', 'UK'], 'RU/UK') && !matches(['EN'], 'RU/UK') && matches(['EN'], 'all') && matches(['BG'], 'BG'));
console.log('lang ok');
