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

// Quality labels: numeric info.quality must land in the same tier as the title-based label.
const qa = src.indexOf('    getQualityLabel('), qb = src.indexOf('    naturalEpisodeSort(');
const { getQualityLabel } = new Function('return {' + src.slice(qa, qb) + '}')();
for (const [q, want] of [[2160, '4K'], ['2160p', '4K'], [1080, 'FHD'], [720, 'HD'], [480, 'SD'], ['UHD', '4K']])
  assert.equal(getQualityLabel('', { info: { quality: q } }), want, `quality ${q}`);
assert.equal(getQualityLabel('Hamilton.2020.2160p.WEB'), '4K');
console.log('quality ok');

// Movie-card matching (series + other same-name films).
const ma = src.indexOf('  const MovieMatch'), mb = src.indexOf('  // ───────────────────────────── Search helpers');
const { keep, allowedYears } = new Function(src.slice(ma, mb) + '; return MovieMatch;')();
const ham = allowedYears([2020, 2020, 2025], 2025);
assert.ok(keep('Гамильтон / Hamilton (2020) WEB-DL [H.265/2160p] [4K, HDR, 10-bit] [EN / RU, EN Sub]', ham));
assert.ok(keep('Hamilton.2025.UHD.BluRay.2160p', ham));                       // re-release year = card year
assert.ok(!keep('Гамильтон / Hamilton / 1998 / ЛО / DVDRip', ham));            // other film
assert.ok(!keep('Гамильтон /Hamilton /s01e01-09 /HD1080p WEBRip', ham));      // series
assert.ok(!keep('Гамильтон (1 сезон: 1-10 серии из 10) / Hamilton / 2020', ham));
assert.ok(!keep('Нечто / Item [32/32] [2019, драма]', null));
assert.ok(keep('Унесенные призраками / Sen to Chihiro no Kamikakushi (Spirited Away) / 2001 / ДБ, СТ / BDRip (1080p)', allowedYears([2001, 2003], 2001)));
assert.ok(keep('Гамильтон без года', ham) && keep('Anything 1998', null)); // no year / unknown years -> keep
assert.equal(allowedYears([], 2025), null);
console.log('movie match ok');

// Season detection from release titles.
const sa = src.indexOf('  const SeasonDetect'), sb = src.indexOf('  // ───────────────────────────── Search helpers');
const SeasonDetect = new Function(src.slice(sa, sb) + '; return SeasonDetect;')();
for (const [t, want] of [
  ['Темная материя (2 сезон: 1-6 серии из 10) / Dark Matter / 2026', ['S02']],
  ['Темная материя / Dark Matter / Сезон: 1 / Серии: 1-9 из 9', ['S01']],
  ['Темная материя / Dark Matter [02х01-05 из 10] (2026)', ['S02']],
  ['Аватар (1-3 сезоны: 1-27 выпуски из 27)', ['S01', 'S02', 'S03']],
  ['Dark.Matter.2024.S02E01.ITA.ENG.2160p', ['S02']],
  ['Гамильтон /Hamilton /s01e01-09 /HD1080p', ['S01']],
  ['Hamilton.2020.2160p.WEB', []],
]) assert.deepEqual(SeasonDetect(t), want, t);
console.log('season ok');

// Film verdict (ratings-patch.js): weighted average, RT heaviest, 3+ sources.
const win = {};
new Function('window', 'Lampa', src.slice(src.indexOf('// -en fork: film scores on the card'), src.indexOf('// -en fork: your own grades')))(win, { Listener: { follow() {} } });
const { verdict } = win.torbox_en_ratings;
// Top Gun: Maverick from MDBList (popcorn ignored): 1253 / 14.5 -> 86.
assert.deepEqual(verdict({ imdb: 8.2, metacritic: 78, metacriticuser: 8.4, trakt: 84, tomatoes: 96, popcorn: 99, tmdb: 81, letterboxd: 4, rogerebert: 4 }), { score: 86, word: 'Excellent' });
assert.equal(verdict({ imdb: 7, tmdb: 70 }), null); // too few sources
assert.deepEqual(verdict({ imdb: 4.5, tmdb: 40, kp: 5 }), { score: 46, word: 'Poor' }); // (45*3+40+50*2)/6
assert.equal(verdict({ tomatoes: 90, imdb: 6, tmdb: 60 }).score, 75); // RT x4: (360+180+60)/8
assert.equal(verdict({ imdb: 7, tmdb: 70, trakt: 70, letterboxd: 1 }).score, 65); // LB x0.5: (210+70+70+10)/5.5
assert.equal(verdict({ imdb: 6, tmdb: 60, trakt: 60, tomatoes: 0, metacritic: null }).score, 60); // 0 and null are "no data"
console.log('verdict ok');

// "For you" ranking (grades-patch.js): summed seed weights, Bad seeds subtract, graded/watched and obscure films out.
const stub = { Listener: { follow() {} }, Storage: { get: () => ({}) }, ContentRows: { add() {} } };
new Function('window', 'Lampa', '$', src.slice(src.indexOf('// -en fork: your own grades')))(win, stub, () => ({}));
const { rank } = win.torbox_en_grades;
const f = (id, extra = {}) => ({ id, title: 'f' + id, vote_count: 1000, vote_average: 7, ...extra });
const ranked = rank([
  [2, [f(1), f(2), f(3)]],              // Loved seed
  [1, [f(2), f(4), f(5, { vote_count: 20 })]], // Good seed; f5 too obscure
  [-1, [f(3), f(6)]],                   // Bad seed pushes f3 down and f6 out
], new Set(['movie_4']));               // f4 already graded
assert.deepEqual(ranked.map((c) => c.id), [2, 1, 3]);
assert.equal(rank([[2, [f(7, { name: 'show' })]]], new Set(['movie_7'])).length, 1); // series key differs from film key
console.log('for you ok');
