-- lampa-native's follows (user 2026-11-02, canvas board Follow): people whose new films reach Coming up (and What's
-- new), per CUB account and profile ("<user id>:<profile>", as the marks). Lampa's own Subscribe on a person is CUB
-- Premium. Applied with:
--   npx wrangler@4 d1 execute lampa-timeline --remote --file proxy/follows.sql
CREATE TABLE IF NOT EXISTS follows (
  who TEXT NOT NULL,
  person INTEGER NOT NULL,
  name TEXT NOT NULL,
  coming TEXT NOT NULL DEFAULT '[]', -- [[date, card, how], ...]: their films dated after today (directed, or a lead)
  known TEXT NOT NULL DEFAULT '[]',  -- those films' ids already seen: one not among them is news
  t INTEGER NOT NULL,                -- last asked of TMDB (ms)
  PRIMARY KEY (who, person)
);
