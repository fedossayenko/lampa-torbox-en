-- lampa-native's marks for leaving Continue browsing (user, 2026-10-31): Finish later (scheduled), Not interested
-- (thrown), Watched it (viewed), per CUB account and profile ("<user id>:<profile>", as the grades). Lampa's own
-- marks would be CUB's, but CUB keeps those for Premium accounts only (error 555). Applied with:
--   npx wrangler@4 d1 execute lampa-timeline --remote --file proxy/marks.sql
CREATE TABLE IF NOT EXISTS marks (
  who TEXT NOT NULL,
  card TEXT NOT NULL,
  mark TEXT NOT NULL,
  t INTEGER NOT NULL,
  PRIMARY KEY (who, card)
);
