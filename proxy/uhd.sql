-- lampa-native's New in 4K: CUB's list of the latest 4K releases, each title's first day in it (the hourly cron at
-- 04 UTC, refreshUhd). Applied with:
--   npx wrangler@4 d1 execute lampa-timeline --remote --file proxy/uhd.sql
CREATE TABLE IF NOT EXISTS uhd (
  type TEXT NOT NULL,    -- movie or tv
  id INTEGER NOT NULL,   -- TMDB's
  t INTEGER NOT NULL,    -- first seen in the list (ms)
  pos INTEGER NOT NULL,  -- its place in it then (orders a day's)
  card TEXT,             -- the English Home card; null: not made yet (TMDB's budget), next day
  PRIMARY KEY (type, id)
);
