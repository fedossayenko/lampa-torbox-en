
// -en fork: RT critics, Metacritic and Letterboxd next to IMDb/KP on the film card.
// Scores come from MDBList through our worker (proxy/, the key stays there); cached 7 days per film.
(function () {
  if (window.torbox_en_ratings) return;
  window.torbox_en_ratings = true;
  const API = 'https://torbox-proxy.sayenkofedor.workers.dev/mdblist/';
  const TTL = 7 * 24 * 3600 * 1000;
  const SHOW = [
    ['tomatoes', 'RT', (v) => v + '%'],
    ['metacritic', 'MC', (v) => String(v)],
    ['letterboxd', 'LB', (v) => v.toFixed(1)],
  ];

  function draw(render, r) {
    const line = render.find('.full-start-new__rate-line, .full-start__rate-line').first();
    if (!line.length || line.find('.rate--mdb').length) return;
    const html = SHOW.filter(([k]) => Number.isFinite(Number(r[k])))
      .map(([k, name, f]) => `<div class="full-start__rate rate--mdb"><div>${f(Number(r[k]))}</div><div class="source--name">${name}</div></div>`)
      .join('');
    const kp = line.find('.rate--kp');
    kp.length ? kp.after(html) : line.append(html);
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
})();
