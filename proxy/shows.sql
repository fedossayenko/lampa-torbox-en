-- lampa-native's /mine: each series' last aired episode ("season:episode") with its original name (Lampa's timeline
-- keys) and its English Home card, from TMDB, kept a day: a series leaves Continue browsing once that episode is
-- watched, and comes back when a new one airs. Applied with:
--   npx wrangler@4 d1 execute lampa-timeline --remote --file proxy/shows.sql
CREATE TABLE IF NOT EXISTS shows (
  id INTEGER PRIMARY KEY,
  original TEXT NOT NULL,
  last TEXT NOT NULL,
  card TEXT NOT NULL,
  t INTEGER NOT NULL,
  -- for new episodes (fresh.sql), added 2026-10-31 to the live table with ALTER TABLE shows ADD COLUMN imdb TEXT
  -- (and seasons TEXT, aired TEXT): the IMDb id (Torrentio's), [[season, episodes, its air date], ...] without
  -- specials, the last aired episode's air date (YYYY-MM-DD)
  imdb TEXT,
  seasons TEXT,
  aired TEXT,
  -- when to ask TMDB again (showStale), added 2026-10-31 likewise: TMDB's status (Ended, Canceled, Returning
  -- Series...) and the next episode's air date
  status TEXT,
  next_air TEXT
);
