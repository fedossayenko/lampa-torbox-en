-- lampa-native's /mine: new episodes of the series you follow, out with Russian or Ukrainian audio (Torrentio asked
-- at most every 3 hours per episode until it is). Applied with:
--   npx wrangler@4 d1 execute lampa-timeline --remote --file proxy/fresh.sql
CREATE TABLE IF NOT EXISTS fresh (
  key TEXT PRIMARY KEY, -- "<TMDB id>/<season>/<episode>"
  out INTEGER,          -- when a release with that audio was first seen (ms); null: not yet
  t INTEGER NOT NULL    -- last asked (ms)
);
