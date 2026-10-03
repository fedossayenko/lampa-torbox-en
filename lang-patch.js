  // ───────────────────────────── Audio language detection (-en fork) ─────────────────────────────
  // Two-letter codes from ffprobe tags, Torrentio flags and release-title keywords.
  // ponytail: keyword heuristics; a title that hides its dub language is reported as its tracker's default.
  const LangDetect = (() => {
    const ISO3 = { rus: 'RU', ukr: 'UK', eng: 'EN', bul: 'BG', pol: 'PL', ger: 'DE', deu: 'DE', fre: 'FR', fra: 'FR', spa: 'ES', ita: 'IT', por: 'PT', jpn: 'JA', kor: 'KO', chi: 'ZH', zho: 'ZH', swe: 'SV', heb: 'HE', hin: 'HI', tur: 'TR', cze: 'CS', ces: 'CS' };
    const COUNTRY = { GB: 'EN', US: 'EN', UA: 'UK', IL: 'HE', JP: 'JA', KR: 'KO', CN: 'ZH', BR: 'PT', MX: 'ES', IN: 'HI', SE: 'SV', DK: 'DA', GR: 'EL', CZ: 'CS', RS: 'SR' };
    const flags = (str) =>
      Array.from(String(str).matchAll(/([\u{1F1E6}-\u{1F1FF}])([\u{1F1E6}-\u{1F1FF}])/gu)).map((m) => {
        const cc = String.fromCharCode(m[1].codePointAt(0) - 0x1f1e6 + 65, m[2].codePointAt(0) - 0x1f1e6 + 65);
        return COUNTRY[cc] || cc;
      });
    const RU_TRACKERS = /rutracker|rutor|kinozal|nnmclub|megapeer|korsars|bitru|baibako|lostfilm|toloka|ultradox|selezen|anilibria/i;
    function detect(raw = {}) {
      const out = new Set();
      const title = String(raw.Title || '');
      const tracker = String(raw.Tracker || '');
      (Array.isArray(raw.ffprobe) ? raw.ffprobe : [])
        .filter((s) => s?.codec_type === 'audio')
        .forEach((s) => {
          const l = String(s?.tags?.language || s?.tags?.LANGUAGE || '').toLowerCase();
          if (l) out.add(ISO3[l] || l.slice(0, 2).toUpperCase());
        });
      flags(raw.TorrentioLangs || '').forEach((l) => out.add(l));
      if (/\bukr\b|укр|ukrainian|\bua\b|toloka/i.test(title + ' ' + tracker)) out.add('UK');
      if (/\bbg[\s._-]?(audio|dub)|бг[\s._-]?аудио|bulgarian|\bbul\b|[\[(]bg[\])]/i.test(title)) out.add('BG');
      if (/\bbg[\s._-]?subs?\b|бг[\s._-]?суб|bgsub/i.test(title)) out.add('BG-SUB');
      if (/\brus\b|russian|\bdub\b|\bmvo\b|\bavo\b|дубляж|(^|[^а-яё])(пм|пд|дб|мво|ммо)([^а-яё]|$)/i.test(title)) out.add('RU');
      if (/\beng\b|english/i.test(title)) out.add('EN');
      if (/original|оригинал/i.test(title)) out.add('ORIG');
      // Russian-tracker releases carry a Russian track unless they say "original only".
      if (!out.has('RU') && (/[а-яё]/i.test(title) || RU_TRACKERS.test(tracker)) && !/^\s*[^/]*\[оригинал\]/i.test(title)) out.add('RU');
      // Torrentio convention: no language line on an international release means English.
      if (!out.size && /^torrentio:/i.test(tracker) && !raw.TorrentioLangs) out.add('EN');
      if (/multi[\s._-]?audio|\bmulti\b/i.test(raw.TorrentioLangs || title)) out.add('MULTI');
      return Array.from(out);
    }
    const matches = (langs, filterValue) => {
      if (filterValue === 'all') return true;
      const want = filterValue === 'RU/UK' ? ['RU', 'UK'] : [filterValue];
      return (langs || []).some((l) => want.includes(l));
    };
    return { detect, matches };
  })();

  // ───────────────────────────── Movie-card result matching (-en fork) ─────────────────────────────
  // Checked on 20 films / 2436 tracker results: hides only series and other same-name films.
  const MovieMatch = (() => {
    const SERIES = /сезон|серии|серия|выпуск|\bs\d{1,2}(e\d+)?\b|season|\[\d+(-\d+)?\s*(из|of)\s*\d+\]|\d+\/\d+\]/i;
    const YEAR = /(?<!\d)(19[2-9]\d|20[0-3]\d)(?!\d)/g;
    // years: Set of allowed years, or null to skip the year check.
    const keep = (title, years) => {
      const t = String(title || '');
      if (SERIES.test(t)) return false;
      if (!years) return true;
      const ys = (t.match(YEAR) || []).map(Number);
      return !ys.length || ys.some((y) => years.has(y));
    };
    // First release year ±1 plus the card's own year (TMDB moves release_date to re-releases).
    const allowedYears = (releaseYears, cardYear) => {
      const ys = (releaseYears || []).filter(Boolean);
      if (!ys.length) return null;
      const y0 = Math.min(...ys);
      return new Set([y0 - 1, y0, y0 + 1, Number(cardYear) || y0]);
    };
    return { keep, allowedYears };
  })();

  // ───────────────────────────── Season detection (-en fork) ─────────────────────────────
  // "2 сезон", "Сезон: 2", "1-3 сезоны", "S02", "S01-S03", "S02E05", "[02x01-05", "Season 2" -> ['S02', ...]
  const SeasonDetect = (title) => {
    const t = String(title || '');
    const out = new Set();
    const add = (a, b = a) => {
      a = Number(a); b = Number(b);
      if (a > 0 && b >= a && b - a < 40) for (let i = a; i <= b; i++) out.add('S' + String(i).padStart(2, '0'));
    };
    const RES = [
      /(\d{1,2})\s*-\s*(\d{1,2})\s*сезон/gi,
      /(?<![\d\s])\s*сезон[ыи]?\s*:\s*(\d{1,2})(?:\s*-\s*(\d{1,2}))?/gi,
      /(?<!-\s?)(?<!\d)(\d{1,2})\s*сезон/gi,
      /\bs(\d{1,2})\s*-\s*s(\d{1,2})\b/gi,
      /\bs(\d{1,2})(?=e\d|\b)/gi,
      /\[(\d{1,2})[xх]\d/gi,
      /season\s*(\d{1,2})(?:\s*-\s*(\d{1,2}))?/gi,
    ];
    RES.forEach((re) => {
      let m;
      while ((m = re.exec(t))) add(m[1], m[2] || m[1]);
    });
    return Array.from(out).sort();
  };

