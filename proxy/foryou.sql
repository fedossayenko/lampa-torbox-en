-- lampa-native's For you (the hourly cron, refreshForYou): TMDB recommendations of every graded film, kept a week,
-- and each account's ranked cards. Applied with:
--   npx wrangler@4 d1 execute lampa-timeline --remote --file proxy/foryou.sql
CREATE TABLE IF NOT EXISTS recs (
  key TEXT PRIMARY KEY,  -- "movie_603": a graded film
  list TEXT NOT NULL,    -- TMDB's, best first: [[type, id, votes, rating 0-100, animated 0/1], ...]
  t INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS foryou (
  who TEXT PRIMARY KEY,  -- CUB account:profile, as the grades
  cards TEXT NOT NULL,   -- the top 60 as Home cards
  t INTEGER NOT NULL
);
