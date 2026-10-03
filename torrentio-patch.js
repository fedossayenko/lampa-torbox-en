    // English source: Torrentio (CORS *, keyed by IMDb id). Merged with the RU parsers.
    // ponytail: series queries S<season|1>E1 only (season packs + that episode); per-episode lookup if needed.
    async function searchTorrentio(movie, signal) {
      const isTv = !!(movie.name || movie.first_air_date || movie.number_of_seasons);
      let imdb = movie.imdb_id;
      if (!imdb && movie.id) {
        // TMDB tv details carry no imdb_id; ask external_ids via Lampa's TMDB proxy.
        try {
          const url = Lampa.TMDB.api(`${isTv ? 'tv' : 'movie'}/${movie.id}/external_ids?api_key=${Lampa.TMDB.key()}`);
          imdb = (await (await fetch(url, { signal })).json())?.imdb_id;
        } catch (_) {}
      }
      if (!imdb) return new Map();
      const path = isTv ? `series/${imdb}:${movie.season_number || movie.season || 1}:1` : `movie/${imdb}`;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const onAbort = () => ctrl.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const res = await fetch(`https://torrentio.strem.fun/stream/${path}.json`, { signal: ctrl.signal });
        const json = await res.json();
        const map = new Map();
        (json?.streams || []).forEach((st) => {
          const hash = String(st.infoHash || '').toLowerCase();
          if (!Utils.isHex40(hash) || map.has(hash)) return;
          const lines = String(st.title || '').split('\n');
          const meta = String(st.title || '');
          const sz = meta.match(/💾\s*([\d.]+)\s*(TB|GB|MB|KB)/i);
          const mult = { TB: 1e12, GB: 1e9, MB: 1e6, KB: 1e3 };
          map.set(hash, {
            Title: lines[0] || st.behaviorHints?.filename || hash,
            InfoHash: hash,
            MagnetUri: `magnet:?xt=urn:btih:${hash}`,
            Size: sz ? Math.round(parseFloat(sz[1]) * mult[sz[2].toUpperCase()]) : 0,
            Seeders: Number((meta.match(/👤\s*(\d+)/) || [])[1]) || 0,
            Tracker: 'torrentio:' + ((meta.match(/⚙️\s*(.+)/) || [])[1] || '').trim(),
            TorrentioLangs: (meta.match(/⚙️[^\n]*\n([^\n]+)/) || [])[1] || '',
          });
        });
        return map;
      } catch (e) {
        LOG('Torrentio failed:', e?.message || e);
        return new Map();
      } finally {
        clearTimeout(t);
        signal?.removeEventListener('abort', onAbort);
      }
    }

    // RU parsers, made stricter for movie cards: TV-only categories (5xxx) are dropped, and if nothing is
    // left the search is retried without the year (TMDB moves release_date to re-releases, e.g. Hamilton 2020 -> 2025).
    // ponytail: no year match on the retry; a same-name film from another year can still show (its title has the year).
    async function searchRu(movie, signal) {
      const isMovie = !(movie.name || movie.first_air_date || movie.number_of_seasons);
      const tvOnly = (r) => {
        const cats = [].concat(r?.Category || []).map(Number).filter(Boolean);
        return cats.length > 0 && cats.every((n) => n >= 5000 && n < 6000);
      };
      const pick = (res) => {
        if (isMovie) res.entriesByHash.forEach((v, k) => { if (tvOnly(v)) res.entriesByHash.delete(k); });
        return res;
      };
      const first = await searchPublicTrackers(movie, signal).then(pick, (e) => ({ error: e }));
      if (first.entriesByHash?.size) return first;
      if (!(movie.year || movie.release_date || movie.first_air_date)) {
        if (first.error) throw first.error;
        throw { type: 'api', message: translate('torbox_error_public_parsers_empty') };
      }
      const retry = pick(await searchPublicTrackers({ ...movie, year: '', release_date: '', first_air_date: '' }, signal));
      if (!retry.entriesByHash.size) throw { type: 'api', message: translate('torbox_error_public_parsers_empty') };
      return retry;
    }

    async function searchAll(movie, signal) {
      const [ru, en] = await Promise.allSettled([searchRu(movie, signal), searchTorrentio(movie, signal)]);
      const enMap = en.status === 'fulfilled' ? en.value : new Map();
      if (ru.status === 'rejected') {
        if (!enMap.size) throw ru.reason;
        return { parser: { name: 'Torrentio' }, entriesByHash: enMap, diagnostics: [] };
      }
      enMap.forEach((v, k) => { if (!ru.value.entriesByHash.has(k)) ru.value.entriesByHash.set(k, v); });
      return ru.value;
    }

