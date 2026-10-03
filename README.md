# lampa-torbox-en

Fork of [slonce70/addon_lampa_torbox](https://github.com/slonce70/addon_lampa_torbox) v51.2.14 that also searches **Torrentio** (English trackers: RARBG, 1337x, TorrentGalaxy, YTS, EZTV…) and merges results with the RU Jacred parsers.

Plugin URL for Lampa:

    https://fedossayenko.github.io/lampa-torbox-en/torbox-lampa-plugin-en.js

Auto-sync: `.github/workflows/sync.yml` runs daily, pulls upstream, re-applies `torrentio-patch.js` via `patch.py`, commits if changed. If upstream moves the anchor line the run fails (GitHub emails you) and the published file stays on the last good version.
