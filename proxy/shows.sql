-- lampa-native's /mine: each series' last aired episode ("season:episode") with its original name (Lampa's timeline
-- keys) and its English Home card, from TMDB, kept a day: a series leaves Continue browsing once that episode is
-- watched, and comes back when a new one airs. Applied with:
--   npx wrangler@4 d1 execute lampa-timeline --remote --file proxy/shows.sql
CREATE TABLE IF NOT EXISTS shows (
  id INTEGER PRIMARY KEY,
  original TEXT NOT NULL,
  last TEXT NOT NULL,
  card TEXT NOT NULL,
  t INTEGER NOT NULL
);
