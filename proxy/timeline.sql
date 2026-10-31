-- Resume points shared by lampa-native and Lampa (torbox-en plugin), keyed by Lampa's hash of the title
-- (+ season and episode). Times in seconds, updated in ms (the newer one wins). Applied with:
--   npx wrangler@4 d1 execute lampa-timeline --remote --file proxy/timeline.sql
CREATE TABLE IF NOT EXISTS timeline (
  hash TEXT PRIMARY KEY,
  time INTEGER NOT NULL,
  duration INTEGER NOT NULL,
  percent INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  card TEXT,
  season INTEGER,
  episode INTEGER
);
