# lampa-torbox-en

Fork of [slonce70/addon_lampa_torbox](https://github.com/slonce70/addon_lampa_torbox) v51.2.14 that also searches **Torrentio** (English trackers: RARBG, 1337x, TorrentGalaxy, YTS, EZTV…) and merges results with the RU Jacred parsers.

Plugin URL for Lampa:

    https://fedossayenko.github.io/lampa-torbox-en/torbox-lampa-plugin-en.js

Auto-sync: `.github/workflows/sync.yml` runs daily, pulls upstream, re-applies `torrentio-patch.js` via `patch.py`, commits if changed. If upstream moves the anchor line the run fails (GitHub emails you) and the published file stays on the last good version.

## Languages

Each result shows its detected audio languages (`RU · UK · EN`, `BG`, `BG-SUB`, `ORIG`, `MULTI`…), from ffprobe tags, Torrentio flags and release-title keywords.
The **Audio language** filter defaults to **RU / UK** (Russian or Ukrainian track). Pick **All** to see English-only releases, or any single language (BG included).
Note: Bulgarian trackers (Zamunda, ArenaBG, Zelka) were seized in Jan 2026, so BG matches come only from releases that mention BG audio/subs.

## Seasons

Series cards get a **Сезон / Season** filter (S01, S02, … parsed from release titles, incl. packs like "1-3 сезоны" / S01-S03). Torrentio is queried for the last 5 seasons.
