
// -en fork: your own grades and suggestions from them. Four grades, Netflix-style plus "OK":
// Loved (+2) and Good (+1) pull in similar films, Bad (-1) pushes them away, OK (0) only marks it watched.
// Grades live in Lampa's storage on this device (torbox_grades). The main screen gets two rows:
// "For you" (TMDB recommendations of graded films) and "Rate what you watched" (played past 70%, no grade yet);
// the left menu gets a "Rate films" page with every played film.
(function () {
  if (window.torbox_en_grades) return;
  const GRADES = [[2, 'Loved', '#21d07a'], [1, 'Good', '#c8d531'], [0, 'OK', '#f0a030'], [-1, 'Bad', '#e8455a']];
  const SKIP = 'skip'; // "Didn't watch / not mine" (tests, kids' films): off the rate row, no effect on suggestions
  const TTL = 7 * 24 * 3600 * 1000;
  const ICON = '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor"><path d="M12 2l3 6.9 7.5.6-5.7 4.9 1.8 7.3L12 17.8 5.4 21.7l1.8-7.3L1.5 9.5 9 8.9z"/></svg>';

  const typeOf = (card) => (card.name || card.first_air_date || card.number_of_seasons ? 'tv' : 'movie');
  const keyOf = (card) => typeOf(card) + '_' + card.id;
  // Cards from other sources (e.g. KP) don't carry a TMDB id.
  const usable = (card) => card && card.id && (!card.source || /^(tmdb|cub)$/i.test(card.source));
  const grades = Lampa.Storage.get('torbox_grades', {}) || {}; // this device is the only writer
  const gradeOf = (card) => grades[keyOf(card)];
  // What a poster needs, not the whole TMDB answer.
  function slim(c) {
    const o = {};
    ['id', 'title', 'name', 'original_title', 'original_name', 'poster_path', 'backdrop_path', 'release_date',
      'first_air_date', 'vote_average', 'vote_count', 'genre_ids', 'source'].forEach((k) => { if (c[k] != null) o[k] = c[k]; });
    return o;
  }
  function setGrade(card, g) {
    if (g === undefined) delete grades[keyOf(card)];
    else grades[keyOf(card)] = { g, t: Date.now(), card: slim(card) };
    Lampa.Storage.set('torbox_grades', grades);
  }

  // `more`: extra menu items {title, action} after the grades.
  function ask(card, done, more) {
    const cur = gradeOf(card);
    const back = Lampa.Controller.enabled().name;
    Lampa.Select.show({
      title: card.title || card.name,
      items: GRADES.map(([g, word]) => ({ title: word, g, selected: !!cur && cur.g === g }))
        .concat([{ title: "Didn't watch / not mine", g: SKIP, selected: !!cur && cur.g === SKIP }])
        .concat(cur ? [{ title: 'Remove grade', remove: true }] : [])
        .concat(more || []),
      onSelect: (a) => {
        Lampa.Controller.toggle(back);
        if (a.action) return a.action();
        setGrade(card, a.remove ? undefined : a.g);
        if (done) done();
      },
      onBack: () => Lampa.Controller.toggle(back),
    });
  }

  // Grade badge in the poster's top-left corner.
  function badge(html, card) {
    const cur = gradeOf(card);
    const g = cur && GRADES.find(([v]) => v === cur.g);
    const view = $(html).find('.card__view').first();
    view.find('.card__grade').remove();
    if (g) {
      view.append(`<div class="card__grade" style="position:absolute;left:.3em;top:.3em;padding:.1em .45em;border-radius:.3em;` +
        `font-size:.8em;font-weight:600;background:${g[2]};color:#000">${g[1]}</div>`);
    }
  }
  const cardMap = Lampa.Maker && Lampa.Maker.map && Lampa.Maker.map('Card');
  if (cardMap && cardMap.Card && cardMap.Card.onVisible) {
    const onVisible = cardMap.Card.onVisible;
    cardMap.Card.onVisible = function () {
      onVisible.apply(this, arguments);
      if (usable(this.data) && gradeOf(this.data)) badge(this.html, this.data);
    };
  }

  // Film card: a Grade button that shows the current grade.
  Lampa.Listener.follow('full', (e) => {
    if (e.type !== 'complite' || !e.data || !usable(e.data.movie)) return;
    const card = e.data.movie;
    const root = e.object && e.object.activity && e.object.activity.render && e.object.activity.render();
    if (!root || !root.length || root.find('.button--grade').length) return;
    const btn = $(`<div class="full-start__button selector button--grade">${ICON}<span></span></div>`);
    const label = () => {
      const cur = gradeOf(card);
      const g = cur && GRADES.find(([v]) => v === cur.g);
      btn.find('span').text(g ? g[1] : cur ? 'Not mine' : 'Grade');
      btn.find('svg').css('color', g ? g[2] : '');
    };
    label();
    btn.on('hover:enter', () => ask(card, label));
    const opts = root.find('.full-start-new__buttons .button--options');
    opts.length ? opts.before(btn) : root.find('.full-start-new__buttons, .full-start__buttons').first().append(btn);
  });

  // Played %, series: the best episode. ponytail: seasons 1-30 x episodes 1-30 scanned, longer seasons missed.
  function progress(card) {
    if (typeOf(card) === 'movie') return Lampa.Timeline.watched(card) || 0;
    let max = 0;
    for (let s = 1; s <= Math.min(card.number_of_seasons || 30, 30); s++) {
      for (let e = 1; e <= 30; e++) {
        const p = Lampa.Timeline.watchedEpisode(card, s, e) || 0;
        if (p >= 70) return p;
        max = Math.max(max, p);
      }
    }
    return max;
  }
  // History with progress, newest first. Several callers per screen (series scan ~40 ms on a Mac, more on the
  // stick): computed once.
  let seen = { t: 0, list: [] };
  function history() {
    if (Date.now() - seen.t > 10000) {
      seen = { t: Date.now(), list: Lampa.Favorite.get({ type: 'history' }).filter(usable).map((c) => [c, progress(c)]) };
    }
    return seen.list;
  }
  const watchedCards = () => history().filter(([, p]) => p >= 70).map(([c]) => c);

  // OK on a poster: the grade menu straight away, the film page is its last item. Graded posters dim, the cursor stays.
  function gradeHere(card) {
    return function () {
      const html = this.html;
      ask(card, () => {
        badge(html, card);
        $(html).css('opacity', 0.4);
      }, [{ title: 'Open film page', action: () => Lampa.Router.call('full', card) }]);
    };
  }

  // "Rate films" page (left menu): not graded yet (played past 70% first, then partly played), then graded ones
  // to change, newest first. Films only opened (0%) are left out: mostly tests.
  function pageList() {
    const full = {};
    history().forEach(([c]) => { full[keyOf(c)] = c; });
    const todo = history().filter(([c, p]) => p > 0 && !grades[keyOf(c)]);
    return todo.filter(([, p]) => p >= 70).concat(todo.filter(([, p]) => p < 70)).map(([c]) => c)
      .concat(Object.keys(grades).filter((k) => grades[k].g !== SKIP).sort((a, b) => grades[b].t - grades[a].t)
        .map((k) => full[k] || grades[k].card));
  }
  function RatePage(object) {
    const comp = Lampa.Maker.make('Category', object);
    const list = pageList();
    let page = 1;
    const part = () => ({ results: list.slice((page - 1) * 40, page * 40), page, total_pages: Math.ceil(list.length / 40) });
    comp.use({
      onCreate() {
        list.length ? this.build(part()) : this.empty();
      },
      onNext(resolve, reject) {
        if (page * 40 >= list.length) return reject();
        page++;
        resolve(part());
      },
      onInstance(item, card) {
        item.use({ onlyEnter: gradeHere(card), onFocus: () => Lampa.Background.change(Lampa.Utils.cardImgBackground(card)) });
      },
    });
    return comp;
  }
  Lampa.Component.add('torbox_rate', RatePage);
  const openPage = () => Lampa.Activity.push({ url: '', title: 'Rate films', component: 'torbox_rate', page: 1 });
  const addMenu = () => Lampa.Menu.addButton(ICON, 'Rate films', openPage);
  if (window.appready) addMenu();
  else Lampa.Listener.follow('app', (e) => { if (e.type === 'ready') addMenu(); });

  // lists: [[weight, [card, ...]], ...] -> cards by summed weight (higher in a list counts more), minus `skip` keys.
  function rank(lists, skip) {
    const score = {};
    const cards = {};
    lists.forEach(([w, list]) => list.forEach((c, i) => {
      const k = keyOf(c);
      score[k] = (score[k] || 0) + w * (1 - i / 40);
      cards[k] = c;
    }));
    return Object.keys(score)
      .filter((k) => score[k] > 0 && !skip.has(k) && (cards[k].vote_count || 0) >= 200)
      .sort((a, b) => score[b] - score[a] || cards[b].vote_average - cards[a].vote_average)
      .map((k) => cards[k]);
  }

  // TMDB recommendations of one film, cached 7 days.
  function recs(type, id) {
    const key = `torbox_recs_${type}_${id}`;
    try {
      const c = JSON.parse(localStorage.getItem(key));
      if (c && Date.now() - c.t < TTL) return Promise.resolve(c.r);
    } catch (_) {}
    return new Promise((resolve) => {
      const url = Lampa.TMDB.api(`${type}/${id}/recommendations?api_key=${Lampa.TMDB.key()}&language=${Lampa.Storage.get('language', 'en')}`);
      new Lampa.Reguest().silent(url, (json) => {
        const r = ((json && json.results) || []).map(slim);
        try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), r })); } catch (_) {}
        resolve(r);
      }, () => resolve([]));
    });
  }
  try {
    Object.keys(localStorage).forEach((k) => {
      if (!k.startsWith('torbox_recs_')) return;
      const c = JSON.parse(localStorage.getItem(k));
      if (!c || Date.now() - c.t >= TTL) localStorage.removeItem(k);
    });
  } catch (_) {}

  // Our verdict (ratings-patch.js, one MDBList batch per type, cached) keeps Decent (60+) or better;
  // films MDBList can't score need TMDB 6.5+.
  function decent(list) {
    const R = window.torbox_en_ratings;
    if (!R || !R.scores) return Promise.resolve(list);
    const ids = (type) => list.filter((c) => typeOf(c) === type).map((c) => c.id);
    return Promise.all([R.scores('movie', ids('movie')), R.scores('show', ids('tv'))]).then(([movies, shows]) =>
      list.filter((c) => {
        const r = (typeOf(c) === 'movie' ? movies : shows)[c.id];
        const v = r && R.verdict({ kp: c.kp_rating, ...r });
        return v ? v.score >= 60 : c.vote_average >= 6.5;
      }));
  }

  const WEIGHT = { 2: 2, 1: 1, '-1': -1 };
  Lampa.ContentRows.add({
    name: 'torbox_for_you',
    title: 'For you',
    index: 1,
    screen: ['main'],
    call: () => {
      const seeds = Object.keys(grades).filter((k) => WEIGHT[grades[k].g]);
      if (!seeds.some((k) => grades[k].g > 0)) return;
      return (call) => {
        Promise.all(seeds.map((k) => recs(...k.split('_')).then((r) => [WEIGHT[grades[k].g], r])))
          .then((lists) => decent(rank(lists, new Set(Object.keys(grades).concat(watchedCards().map(keyOf)))).slice(0, 80)))
          .then((results) => call(results.length ? { title: 'For you', results: results.slice(0, 40) } : undefined))
          .catch(() => call());
      };
    },
  });
  // "More" on this row opens the Rate films page.
  Lampa.ContentRows.add({
    name: 'torbox_rate',
    title: 'Rate what you watched',
    index: 2,
    screen: ['main'],
    call: () => {
      const results = watchedCards().filter((c) => !grades[keyOf(c)]).slice(0, 40)
        .map((c) => ({ ...c, params: { emit: { onlyEnter: gradeHere(c) } } }));
      if (!results.length) return;
      // total_pages 2: Lampa shows "More" only on rows with more than one page.
      return (call) => call({ title: 'Rate what you watched', results, total_pages: 2, params: { emit: { onlyMore: openPage } } });
    },
  });

  window.torbox_en_grades = { rank, ask }; // load guard + self-check hook (node test-lang.mjs)
})();
