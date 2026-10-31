-- lampa-native's search predictions (see /search): ~1000 well-known films and series with their words
-- normalized (lower case, ё → е, letters and digits only, a space on each side) in English with the original
-- title (en cron) and in Russian (ru cron), so one or two letters already find them. Refreshed daily by the
-- worker's crons. Applied with:
--   npx wrangler@4 d1 execute lampa-timeline --remote --file proxy/titles.sql
CREATE TABLE IF NOT EXISTS titles (
  type TEXT NOT NULL,
  id INTEGER NOT NULL,
  card TEXT NOT NULL,
  votes INTEGER NOT NULL,
  seen INTEGER NOT NULL,
  en TEXT NOT NULL DEFAULT '',
  ru TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (type, id)
);
