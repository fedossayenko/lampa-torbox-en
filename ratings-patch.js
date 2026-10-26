
// -en fork: film scores on the card. RT critics, Metacritic and Letterboxd next to IMDb/KP, every score coloured,
// plus a combined verdict first in the row, TMDB per-season scores under it for series, and the verdict on posters.
// Scores come from MDBList through our worker (proxy/, the key stays there); cached 7 days per film.
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
  // ponytail: hand-picked weights. RT counts most, then Metacritic and IMDb; Letterboxd barely (small cinephile
  // crowd, harsh on blockbusters). RT audience (popcorn) left out: inflated and close to IMDb.
  const WEIGHTS = { tomatoes: 4, metacritic: 3, imdb: 3, kp: 2, rogerebert: 1, trakt: 1, tmdb: 1, metacriticuser: 1, letterboxd: 0.5 };
  const VERDICTS = [[80, 'Excellent'], [70, 'Good'], [60, 'Decent'], [50, 'Mixed'], [0, 'Poor']];

  function color(score) {
    return score >= 75 ? '#21d07a' : score >= 60 ? '#c8d531' : score >= 45 ? '#f0a030' : '#e8455a';
  }

  // Weighted average of the scores the film has (0 / missing = no data); needs 3+ sources.
  function verdict(r) {
    const got = Object.keys(WEIGHTS).filter((k) => Number(r[k]) > 0);
    if (got.length < 3) return null;
    const sum = (f) => got.reduce((s, k) => s + f(k), 0);
    const score = Math.round(sum((k) => Number(r[k]) * NORM[k] * WEIGHTS[k]) / sum((k) => WEIGHTS[k]));
    return { score, word: VERDICTS.find(([min]) => score >= min)[1] };
  }

  // Cards from other sources (e.g. KP) don't carry a TMDB id.
  const tmdbId = (card) => (card.id && (!card.source || /^(tmdb|cub)$/i.test(card.source)) ? card.id : null);
  const typeOf = (card) => (card.name || card.first_air_date ? 'show' : 'movie');

  // localStorage, shared by the card and the posters.
  function cached(type, id) {
    try {
      const c = JSON.parse(localStorage.getItem(`torbox_mdb_${type}_${id}`));
      return c && Date.now() - c.t < TTL ? c.r : null;
    } catch (_) {
      return null;
    }
  }
  function save(type, id, r) {
    try { localStorage.setItem(`torbox_mdb_${type}_${id}`, JSON.stringify({ t: Date.now(), r })); } catch (_) {}
  }
  // Expired entries go at start, so posters seen once don't pile up next to Lampa's own storage.
  try {
    Object.keys(localStorage).forEach((k) => {
      const [, , type, id] = k.split('_');
      if (k.startsWith('torbox_mdb_') && !cached(type, id)) localStorage.removeItem(k);
    });
  } catch (_) {}

  // Returns the KP score read from the card, so it can be kept for the poster verdict.
  function draw(render, r) {
    const line = render.find('.full-start-new__rate-line, .full-start__rate-line').first();
    if (!line.length || line.find('.rate--mdb, .rate--verdict').length) return null;
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
    return kpValue;
  }

  // Series: TMDB score of each season (already in the card data, no request), specials and unrated left out.
  function drawSeasons(render, card) {
    const seasons = (card.seasons || []).filter((s) => s.season_number > 0 && s.vote_average > 0);
    const line = render.find('.full-start-new__rate-line, .full-start__rate-line').first();
    if (seasons.length < 2 || !line.length || render.find('.rate-line--seasons').length) return;
    line.after(
      `<div class="${line.attr('class')} rate-line--seasons" style="flex-wrap:wrap">` +
        seasons.map((s) => `<div class="full-start__rate"><div style="color:${color(s.vote_average * 10)}">` +
          `${s.vote_average.toFixed(1)}</div><div class="source--name">S${s.season_number}</div></div>`).join('') +
        '</div>'
    );
  }

  Lampa.Listener.follow('full', (e) => {
    if (e.type !== 'complite') return;
    const card = e.data && e.data.movie;
    const render = e.object && e.object.activity && e.object.activity.render && e.object.activity.render();
    if (!card || !render || !render.length) return;
    drawSeasons(render, card);
    const id = tmdbId(card);
    if (!id) return;
    const type = typeOf(card);
    const done = (r) => {
      const kp = draw(render, r);
      if (kp > 0 && r.kp !== kp) save(type, id, { ...r, kp });
    };
    const r = cached(type, id);
    if (r) return done(r);
    fetch(API + type + '/' + id)
      .then((res) => (res.ok ? res.json() : {})) // 404 = no scores for this film, cached as empty
      .then((r) => {
        save(type, id, r);
        done(r);
      })
      .catch(() => {});
  });

  // Posters: the verdict replaces Lampa's TMDB number in the corner. Cards that come into view within
  // half a second go to MDBList in one batch (up to 200 films = 1 of the 1,000 daily requests).
  function drawPoster(html, r, card) {
    const v = verdict({ kp: card.kp_rating, ...r });
    if (!v) return;
    const view = $(html).find('.card__view').first();
    let vote = view.find('.card__vote');
    if (!vote.length) vote = $('<div class="card__vote"></div>').appendTo(view);
    vote.text(v.score).css('color', color(v.score));
  }

  let postersOffUntil = 0;
  // One MDBList batch (up to 200 films = 1 request) -> { id: ratings }; films not on MDBList are cached as empty.
  function batch(type, ids) {
    return fetch(API + type, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) })
      .then((res) => {
        // Keep the last 100 daily requests for opened cards.
        if (Number(res.headers.get('X-RateLimit-Remaining') || Infinity) < 100) postersOffUntil = Date.now() + 3600 * 1000;
        return res.ok ? res.json() : null;
      })
      .then((all) => {
        const out = {};
        if (all) ids.forEach((id) => save(type, id, (out[id] = all[id] || {})));
        return out;
      })
      .catch(() => ({}));
  }
  // Cached scores plus one batch per 200 of the rest (used by "For you" in grades-patch.js).
  function scores(type, ids) {
    const out = {};
    const missing = ids.filter((id) => !(out[id] = cached(type, id)));
    if (!missing.length || Date.now() < postersOffUntil) return Promise.resolve(out);
    const chunks = [];
    for (let i = 0; i < missing.length; i += 200) chunks.push(missing.slice(i, i + 200));
    return Promise.all(chunks.map((c) => batch(type, c))).then((rs) => Object.assign(out, ...rs));
  }

  const queue = { movie: new Map(), show: new Map() }; // id -> [[html, card], ...]
  let timer = null;
  function flush() {
    timer = null;
    for (const type of ['movie', 'show']) {
      const ids = [...queue[type].keys()].slice(0, 200);
      const waiting = ids.map((id) => [id, queue[type].get(id)]);
      ids.forEach((id) => queue[type].delete(id));
      if (!ids.length) continue;
      batch(type, ids).then((all) => {
        for (const [id, cards] of waiting) if (all[id]) cards.forEach(([html, card]) => drawPoster(html, all[id], card));
      });
    }
    if (queue.movie.size || queue.show.size) timer = setTimeout(flush, 0);
  }

  const cardMap = Lampa.Maker && Lampa.Maker.map && Lampa.Maker.map('Card');
  if (cardMap && cardMap.Card && cardMap.Card.onVisible) {
    const onVisible = cardMap.Card.onVisible;
    cardMap.Card.onVisible = function () {
      onVisible.apply(this, arguments);
      const card = this.data || {};
      const id = tmdbId(card);
      if (!id || this.torbox_rated) return;
      this.torbox_rated = true;
      const type = typeOf(card);
      const r = cached(type, id);
      if (r) return drawPoster(this.html, r, card);
      if (Date.now() < postersOffUntil) return;
      queue[type].set(id, (queue[type].get(id) || []).concat([[this.html, card]]));
      timer = timer || setTimeout(flush, 500);
    };
  }

  window.torbox_en_ratings = { verdict, scores }; // load guard, self-check hook (node test-lang.mjs), grades-patch.js
})();
