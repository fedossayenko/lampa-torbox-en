-- Skip times per film and episode (intro, recap, credits) as /segments sends them to the stick, in our DDD fork's
-- "segments" format; '' when neither IntroDB nor TheIntroDB had any. key: "<movie|tv>/<tmdb id>/<season>/<episode>".
-- Applied with:
--   npx wrangler@4 d1 execute lampa-timeline --remote --file proxy/segments.sql
CREATE TABLE IF NOT EXISTS segments (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  t INTEGER NOT NULL
);

-- Our own intro times per release and episode (key "<torrent hash>/<season>/<episode>", ms), found by lampa-native's
-- tools/intro-detect.py on the old MacBook; they beat the community's. recap_ms: a recap from 0 ("Previously on…" in the
-- release's subtitles) ends there. And its queue: a release's episode to start from.
CREATE TABLE IF NOT EXISTS intros (
  key TEXT PRIMARY KEY,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  t INTEGER NOT NULL,
  recap_ms INTEGER
);
-- added 2026-10-31 to the live table with: ALTER TABLE intros ADD COLUMN recap_ms INTEGER
CREATE TABLE IF NOT EXISTS intro_jobs (
  key TEXT PRIMARY KEY,
  file INTEGER NOT NULL,
  name TEXT NOT NULL,
  series TEXT NOT NULL,
  t INTEGER NOT NULL
);
