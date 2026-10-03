# Builds torbox-lampa-plugin-en.js from upstream + the -en fork edits.
# Every anchor must match exactly once, otherwise we fail loudly and keep the last good file.
import re, sys, urllib.request
UP = 'https://slonce70.github.io/addon_lampa_torbox/torbox-lampa-plugin.js'
src = urllib.request.urlopen(UP, timeout=30).read().decode()

api_ret = '    return { searchPublicTrackers, checkCached, addMagnet, myList, requestDl };'
EDITS = [
    # English source: Torrentio, merged with the RU parsers.
    (api_ret, open('torrentio-patch.js').read() + api_ret.replace('searchPublicTrackers,', 'searchPublicTrackers: searchAll,')),
    # Language detection module.
    ('  // ───────────────────────────── Search helpers ─────────────────────────────',
     open('lang-patch.js').read() + '  // ───────────────────────────── Search helpers ─────────────────────────────'),
    # audio_langs from all signals (was ffprobe-only, 3-letter codes that never matched the RU,EN,UK preference).
    ("        audio_langs: [...new Set(a.map((s) => s?.tags?.language || s?.tags?.LANGUAGE).filter(Boolean))].map((x) => String(x).toUpperCase()),",
     "        audio_langs: LangDetect.detect(raw),"),
    # Language badge on every row.
    ("      if (tech.has_dv) html += tag('Dolby Vision', 'dv');",
     "      if (tech.has_dv) html += tag('Dolby Vision', 'dv');\n      if (tech.audio_langs && tech.audio_langs.length) html += tag(Utils.escapeHtml(tech.audio_langs.join(' · ')), 'lang');"),
    # Default language filter = Russian or Ukrainian; "all" shows everything.
    ("      lang: 'all',", "      lang: 'RU/UK',"),
    ("        (t) => state.filters.lang === 'all' || (Array.isArray(t.audio_langs) && t.audio_langs.includes(state.filters.lang)),",
     "        (t) => LangDetect.matches(t.audio_langs, state.filters.lang),"),
    # 'RU/UK' option at the top of the language menu, plus BG always offered.
    ("        buildOne('lang', 'torbox_filter_audio_lang', state.all_torrents.map((t) => t.audio_langs || [])),",
     "        (() => {\n"
     "          const one = buildOne('lang', 'torbox_filter_audio_lang', [...state.all_torrents.map((t) => t.audio_langs || []), 'BG']);\n"
     "          one.items.splice(1, 0, { title: 'RU / UK', value: 'RU/UK', selected: state.filters.lang === 'RU/UK' });\n"
     "          return one;\n"
     "        })(),"),
    # New storage key so the RU/UK default applies once over previously saved filters.
    ("torbox_filters_v2", "torbox_filters_v3"),
]

for anchor, repl in EDITS:
    n = src.count(anchor)
    if n == 0 or (n != 1 and anchor != 'torbox_filters_v2'):
        sys.exit(f'anchor matched {n}x, patch needs a manual update: {anchor[:80]!r}')
    src = src.replace(anchor, repl)
src = re.sub(r"const VERSION = '([^']+)';", r"const VERSION = '\1-en';", src, count=1)
open('torbox-lampa-plugin-en.js', 'w').write(src)
