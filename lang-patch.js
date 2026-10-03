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

