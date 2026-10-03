    // English source: Torrentio (CORS *, keyed by IMDb id). Merged with the RU parsers.
    // ponytail: series ask SxxE01 for each of the last 5 seasons (season packs + first episodes); per-episode lookup if needed.
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
      const lastSeason = Number(movie.number_of_seasons) || Number(movie.season_number || movie.season) || 1;
      const paths = isTv
        ? Array.from({ length: Math.min(lastSeason, 5) }, (_, i) => `series/${imdb}:${lastSeason - i}:1`)
        : [`movie/${imdb}`];
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const onAbort = () => ctrl.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const lists = await Promise.all(
          paths.map((path) =>
            fetch(`https://torrentio.strem.fun/stream/${path}.json`, { signal: ctrl.signal })
              .then((r) => r.json())
              .then((j) => j?.streams || [], () => [])
          )
        );
        const map = new Map();
        lists.flat().forEach((st) => {
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

    // RU parsers, stricter on movie cards: series and other same-name films (by first-release year) are dropped,
    // and if nothing is left the search is retried without the year (TMDB moves release_date to re-releases).
    async function movieYears(movie, signal) {
      try {
        if (movie.source && !/^(tmdb|cub)$/i.test(movie.source)) return null; // id is not a TMDB id
        const url = Lampa.TMDB.api(`movie/${movie.id}/release_dates?api_key=${Lampa.TMDB.key()}`);
        const json = await (await fetch(url, { signal })).json();
        const ys = (json?.results || []).flatMap((c) => (c.release_dates || []).map((r) => parseInt(String(r.release_date).slice(0, 4), 10)));
        const cardYear = parseInt(String(movie.release_date || movie.year || '').slice(0, 4), 10);
        return MovieMatch.allowedYears(ys, cardYear);
      } catch (_) {
        return null; // unknown -> no year filtering
      }
    }

    async function searchRu(movie, signal) {
      const isMovie = !(movie.name || movie.first_air_date || movie.number_of_seasons);
      const yearsP = isMovie && movie.id ? movieYears(movie, signal) : Promise.resolve(null);
      const pick = async (res) => {
        if (!isMovie) return res;
        const years = await yearsP;
        res.entriesByHash.forEach((v, k) => { if (!MovieMatch.keep(v?.Title, years)) res.entriesByHash.delete(k); });
        return res;
      };
      const first = await searchPublicTrackers(movie, signal).then(pick, (e) => ({ error: e }));
      if (first.entriesByHash?.size) return first;
      // Retry only when the parsers answered (results filtered away, or "nothing found"), never after timeouts/outages.
      const answered = !first.error || DebugTelemetry.parserAttempts.some((a) => a.status === 'empty');
      if (!answered) throw first.error;
      if (!(movie.year || movie.release_date || movie.first_air_date)) {
        throw first.error || { type: 'api', message: translate('torbox_error_public_parsers_empty') };
      }
      const retry = await pick(await searchPublicTrackers({ ...movie, year: '', release_date: '', first_air_date: '' }, signal));
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

