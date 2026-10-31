-- Skip times per film and episode (intro, recap, credits) as /segments sends them to the stick, in our DDD fork's
-- "segments" format; '' when neither IntroDB nor TheIntroDB had any. key: "<movie|tv>/<tmdb id>/<season>/<episode>".
-- Applied with:
--   npx wrangler@4 d1 execute lampa-timeline --remote --file proxy/segments.sql
CREATE TABLE IF NOT EXISTS segments (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  t INTEGER NOT NULL
);
