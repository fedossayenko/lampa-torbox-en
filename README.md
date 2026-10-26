# lampa-torbox-en

Fork of [slonce70/addon_lampa_torbox](https://github.com/slonce70/addon_lampa_torbox) v51.2.14 that also searches **Torrentio** (English trackers: RARBG, 1337x, TorrentGalaxy, YTS, EZTV…) and merges results with the RU Jacred parsers.

Plugin URL for Lampa:

    https://fedossayenko.github.io/lampa-torbox-en/torbox-lampa-plugin-en.js

Proxy: TorBox blocks browser (CORS) calls, so the plugin goes through `proxy/`, upstream's locked-down Cloudflare Worker deployed as `https://torbox-proxy.sayenkofedor.workers.dev` (`cd proxy && npx wrangler@4 deploy`). It forwards the API key only to api.torbox.app.

Auto-sync: `.github/workflows/sync.yml` runs daily, pulls upstream, re-applies `torrentio-patch.js` via `patch.py`, commits if changed. If upstream moves the anchor line the run fails (GitHub emails you) and the published file stays on the last good version.

## Languages

Each result shows its detected audio languages (`RU · UK · EN`, `BG`, `BG-SUB`, `ORIG`, `MULTI`…), from ffprobe tags, Torrentio flags and release-title keywords.
The **Audio language** filter defaults to **RU / UK** (Russian or Ukrainian track). Pick **All** to see English-only releases, or any single language (BG included).
Note: Bulgarian trackers (Zamunda, ArenaBG, Zelka) were seized in Jan 2026, so BG matches come only from releases that mention BG audio/subs.

## Seasons

Series cards get a **Сезон / Season** filter (S01, S02, … parsed from release titles, incl. packs like "1-3 сезоны" / S01-S03). Torrentio is queried for the last 5 seasons.

## Grades and "For you"

Every film card gets a ★ button: **Loved / Good / OK / Bad**, or "Didn't watch / not mine". Graded posters show a corner badge.
The main screen gets two rows (`grades-patch.js`):
- **Rate what you watched**: films played past 70% (series: any episode) that have no grade yet. OK on a poster opens the grade menu.
- **Rate films** (left menu, or **More** on that row): a full page of every played film. Unrated ones come first (past 70%, then partly played), graded ones after so you can change them. Films that were only opened are left out. OK on a poster grades it in place: OK, OK = Loved.
- **For you**: TMDB recommendations of graded films (Loved ×2, Good ×1, Bad −1). Graded and watched films are left out, as are obscure ones (under 200 TMDB votes) and anything below Mixed (50) on the verdict (97% of the films graded Good/Loved score 50+).
- **For you** page (left menu, or **More** on that row): *Top picks for you*, then a *Because you loved / liked …* row for each Loved/Good film (up to 12). Animated films are suggested only from animated films.
Grades are kept in Lampa's storage (`torbox_grades`) and synced through the worker (`POST /grades`, Cloudflare KV) between every Lampa signed in to the same CUB account and profile (TV, Lampa in a browser): at start and 5 s after a grade, newer grade wins per film. The worker checks the CUB sign-in with CUB, doesn't store it, and only serves accounts in its `CUB_ACCOUNTS` secret. Not signed in to CUB = grades stay on that device.
