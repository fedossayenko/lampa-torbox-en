-- lampa-native's What's new (user 2026-11-02, canvas board Bell): news kept per CUB account and profile ("<user id>:
-- <profile>"): films the people you follow announced (refreshFollows). New episodes out in your audio come from fresh.sql
-- with /mine. Applied with:
--   npx wrangler@4 d1 execute lampa-timeline --remote --file proxy/news.sql
CREATE TABLE IF NOT EXISTS news (
  who TEXT NOT NULL,
  key TEXT NOT NULL,  -- "film:<TMDB id>": once each
  t INTEGER NOT NULL, -- when it was found (ms)
  card TEXT NOT NULL, -- the Home card it opens
  head TEXT NOT NULL, -- "Denis Villeneuve"
  line TEXT NOT NULL, -- "New film: Dune: Part Three · 18 Dec 2026"
  PRIMARY KEY (who, key)
);
