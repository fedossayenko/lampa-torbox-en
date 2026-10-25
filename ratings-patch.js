
// -en fork: film scores on the card. RT critics, Metacritic and Letterboxd next to IMDb/KP, every score coloured,
// plus a combined verdict first in the row. Scores come from MDBList through our worker (proxy/, the key stays
// there); cached 7 days per film.
(function () {
  if (window.torbox_en_ratings) return;
  const API = 'https://torbox-proxy.sayenkofedor.workers.dev/mdblist/';
  const TTL = 7 * 24 * 3600 * 1000;
  const SHOW = [
    ['tomatoes', 'RT', (v) => v + '%'],
    ['metacritic', 'MC', (v) => String(v)],
    ['letterboxd', 'LB', (v) => v.toFixed(1)],
  ];
  // Everything on a 0-100 scale.
  const NORM = {
    tomatoes: 1, metacritic: 1, rogerebert: 25, // critics
    imdb: 10, letterboxd: 20, kp: 10, trakt: 1, tmdb: 1, metacriticuser: 10, // audience
  };
  const CRITICS = ['tomatoes', 'metacritic', 'rogerebert'];
  // ponytail: hand-picked weights; RT audience (popcorn) left out: inflated and close to IMDb.
  const AUDIENCE = { imdb: 3, letterboxd: 2.5, kp: 2, trakt: 1.5, tmdb: 1, metacriticuser: 1 };
  const VERDICTS = [[80, 'Excellent'], [70, 'Good'], [60, 'Decent'], [50, 'Mixed'], [0, 'Poor']];

  function color(score) {
    return score >= 75 ? '#21d07a' : score >= 60 ? '#c8d531' : score >= 45 ? '#f0a030' : '#e8455a';
  }

  // Half critics, half audience (whichever side exists); needs 3+ sources.
  function verdict(r) {
    const n = (k) => (Number.isFinite(Number(r[k])) && Number(r[k]) > 0 ? Number(r[k]) * NORM[k] : null);
    const crit = CRITICS.map(n).filter((v) => v != null);
    const aud = Object.keys(AUDIENCE).map((k) => [n(k), AUDIENCE[k]]).filter(([v]) => v != null);
    if (crit.length + aud.length < 3) return null;
    const c = crit.length ? crit.reduce((a, b) => a + b, 0) / crit.length : null;
    const a = aud.length ? aud.reduce((s, [v, w]) => s + v * w, 0) / aud.reduce((s, [, w]) => s + w, 0) : null;
    const score = Math.round(c != null && a != null ? (c + a) / 2 : c != null ? c : a);
    return { score, word: VERDICTS.find(([min]) => score >= min)[1] };
  }

  function draw(render, r) {
    const line = render.find('.full-start-new__rate-line, .full-start__rate-line').first();
    if (!line.length || line.find('.rate--mdb, .rate--verdict').length) return;
    const html = SHOW.filter(([k]) => Number.isFinite(Number(r[k])))
      .map(([k, name, f]) => {
        const v = Number(r[k]);
        return `<div class="full-start__rate rate--mdb"><div style="color:${color(v * NORM[k])}">${f(v)}</div><div class="source--name">${name}</div></div>`;
      })
      .join('');
    const kp = line.find('.rate--kp');
    kp.length ? kp.after(html) : line.append(html);

    // Colour Lampa's own TMDB/IMDb/KP numbers (0-10) and read KP for the verdict.
    line.find('.rate--tmdb, .rate--imdb, .rate--kp').each(function () {
      const v = parseFloat($(this).children().first().text());
      if (v > 0) $(this).children().first().css('color', color(v * 10));
    });
    const kpValue = parseFloat(line.find('.rate--kp').not('.hide').children().first().text());
    const v = verdict(kpValue > 0 ? { ...r, kp: kpValue } : r);
    if (v) {
      line.prepend(
        `<div class="full-start__rate rate--verdict" style="border:1px solid ${color(v.score)}">` +
          `<div style="color:${color(v.score)}">${v.score}</div><div class="source--name">${v.word}</div></div>`
      );
    }
  }

  Lampa.Listener.follow('full', (e) => {
    if (e.type !== 'complite') return;
    const card = e.data && e.data.movie;
    const render = e.object && e.object.activity && e.object.activity.render && e.object.activity.render();
    if (!card || !card.id || !render || !render.length) return;
    if (card.source && !/^(tmdb|cub)$/i.test(card.source)) return; // id is not a TMDB id
    const type = card.name || card.first_air_date ? 'show' : 'movie';
    const key = `torbox_mdb_${type}_${card.id}`;
    let cached = null;
    try { cached = JSON.parse(localStorage.getItem(key)); } catch (_) {}
    if (cached && Date.now() - cached.t < TTL) return draw(render, cached.r);
    fetch(API + type + '/' + card.id)
      .then((res) => (res.ok ? res.json() : {})) // 404 = no scores for this film, cached as empty
      .then((r) => {
        try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), r })); } catch (_) {}
        draw(render, r);
      })
      .catch(() => {});
  });

  window.torbox_en_ratings = { verdict }; // load guard + self-check hook (node test-lang.mjs)
})();
