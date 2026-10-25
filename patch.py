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
    # Season filter (series cards): seasons parsed from release titles.
    ("        audio_langs: tech.audio_langs,", "        audio_langs: tech.audio_langs,\n        seasons: SeasonDetect(raw?.Title),"),
    ("      audio_codec: 'all',\n    };", "      audio_codec: 'all',\n      season: 'all',\n    };"),
    ("        (t) => LangDetect.matches(t.audio_langs, state.filters.lang),",
     "        (t) => LangDetect.matches(t.audio_langs, state.filters.lang),\n"
     "        (t) => !state.filters.season || state.filters.season === 'all' || (t.seasons || []).includes(state.filters.season),"),
    ("        buildOne('quality', 'torbox_filter_quality', state.all_torrents.map((t) => t.quality)),",
     "        ...(state.all_torrents.some((t) => t.seasons && t.seasons.length)\n"
     "          ? [Object.assign(buildOne('season', 'torbox_filter_quality', state.all_torrents.map((t) => t.seasons || [])), {\n"
     "              title: Lampa.Storage.get('language', 'ru') === 'en' ? 'Season' : 'Сезон',\n"
     "            })]\n"
     "          : []),\n"
     "        buildOne('quality', 'torbox_filter_quality', state.all_torrents.map((t) => t.quality)),"),
    # One quality label per tier: numeric 2160/1080/720 used to show as 2160P/1080P/720P next to 4K/FHD/HD.
    ("          if (/^\\d{3,4}P$/.test(normalized)) return normalized;\n          if (/^\\d{3,4}$/.test(normalized)) return `${normalized}P`;",
     "          const px = /^(\\d{3,4})P?$/.test(normalized) ? parseInt(normalized, 10) : 0;\n          if (px) return px >= 2160 ? '4K' : px >= 1080 ? 'FHD' : px >= 720 ? 'HD' : 'SD';"),
    # Parsers go through the CORS proxy (+1-4 s); 5 s cut off large answers (59 results for Spirited Away).
    ("    PUBLIC_PARSER_TIMEOUT_MS: 5 * 1000, // 5 seconds", "    PUBLIC_PARSER_TIMEOUT_MS: 15 * 1000, // 15 seconds (-en fork: proxy latency)"),
    # Saved filters missing a newer key (e.g. season) must fall back to defaults instead of crashing the menu.
    ("        return JSON.parse(Store.get('torbox_filters_v2', JSON.stringify(defaultFilters)));",
     "        return { ...defaultFilters, ...JSON.parse(Store.get('torbox_filters_v2', JSON.stringify(defaultFilters))) };"),
    # Own Cloudflare Worker (proxy/ in this repo) instead of upstream's, which saw every API key.
    ("  const DEFAULT_PROXY_URL = 'https://my-torbox-proxy.slonce70.workers.dev';",
     "  const DEFAULT_PROXY_URL = 'https://torbox-proxy.sayenkofedor.workers.dev';"),
    # A degraded TorBox answers in 15-45 s (Oct 2026); at 20 s every pick timed out.
    ("    TORBOX_API_TIMEOUT_MS: 20 * 1000, // 20 seconds",
     "    TORBOX_API_TIMEOUT_MS: 60 * 1000, // 60 seconds (-en fork: TorBox answers in 15-45 s when degraded)"),
    # jacred.xyz is dead (HTTP/2 errors) and on Lampa's own plugin blacklist; a MaxVol miss waited 15 s on it.
    ("    { name: 'Jacred', url: 'jacred.xyz', key: '' },\n", ""),
    # Cache check: 100-hash chunks in parallel, not one after another (~170 hashes = 2 sequential slow calls).
    ("      for (let i = 0; i < hashes.length; i += 100) {\n"
     "        if (signal?.aborted) break; // stop issuing chunk requests once cancelled\n"
     "        const chunk = hashes.slice(i, i + 100);",
     "      const starts = [];\n"
     "      for (let i = 0; i < hashes.length; i += 100) starts.push(i);\n"
     "      await Promise.all(starts.map(async (i) => {\n"
     "        const chunk = hashes.slice(i, i + 100);"),
    ("          LOG('checkCached error:', e.message || e);\n        }\n      }\n      return acc;",
     "          LOG('checkCached error:', e.message || e);\n        }\n      }));\n      return acc;"),
    # TorBox becomes Lampa's priority source once: Lampa puts it first on every card (after plugins such as
    # MODS's add theirs), no long-press needed. Long-press the button to undo; the flag keeps it undone.
    ("        btn.on('hover:enter', () => launchTorBox(e.data.movie || {}));",
     "        btn.on('hover:enter', () => launchTorBox(e.data.movie || {}));\n"
     "        if (!Lampa.Storage.get('torbox_priority_set', false)) {\n"
     "          Lampa.Storage.set('full_btn_priority', Lampa.Utils.hash(btn.prop('outerHTML')));\n"
     "          Lampa.Storage.set('torbox_priority_set', true);\n"
     "        }"),
    # Start the card with the cursor on that TorBox button. MODS's grabs the cursor when its own loading ends,
    # so for the first 10 s keep putting it back on TorBox; any key press by the user stops this.
    ("      Lampa.Listener.follow('full', fullListener);",
     "      Lampa.Listener.follow('full', fullListener);\n"
     "      Lampa.Listener.follow('full', (e) => {\n"
     "        if (e.type !== 'complite') return;\n"
     "        const root = e.object?.activity?.render?.();\n"
     "        if (!root?.length) return;\n"
     "        const until = Date.now() + 10000;\n"
     "        let pressed = false;\n"
     "        const onKey = () => { pressed = true; };\n"
     "        document.addEventListener('keydown', onKey, true);\n"
     "        const tick = () => {\n"
     "          if (pressed || Date.now() > until || !document.body.contains(root[0])) {\n"
     "            document.removeEventListener('keydown', onKey, true);\n"
     "            return;\n"
     "          }\n"
     "          const pri = root.find('.button--priority.view--torbox');\n"
     "          if (pri.length && pri[0].offsetParent && !pri.hasClass('focus') && Lampa.Controller.enabled().name === 'full_start') {\n"
     "            Lampa.Controller.collectionFocus(pri[0], root);\n"
     "          }\n"
     "          setTimeout(tick, 250);\n"
     "        };\n"
     "        setTimeout(tick, 0);\n"
     "      });"),
    # New storage key so RU/UK default + merged quality labels apply over previously saved filters.
    ("torbox_filters_v2", "torbox_filters_v4"),
]

for anchor, repl in EDITS:
    n = src.count(anchor)
    if n == 0 or (n != 1 and anchor != 'torbox_filters_v2'):
        sys.exit(f'anchor matched {n}x, patch needs a manual update: {anchor[:80]!r}')
    src = src.replace(anchor, repl)
src = re.sub(r"const VERSION = '([^']+)';", r"const VERSION = '\1-en';", src, count=1)
src += open('ratings-patch.js').read()  # film scores on the card, independent of the TorBox code
src += open('grades-patch.js').read()  # your grades + "For you" row, uses ratings-patch.js for the quality filter
open('torbox-lampa-plugin-en.js', 'w').write(src)
