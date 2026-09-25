-- Anonymous "Ask Jake" question log. One row per answered (or failed) question.
-- No IP addresses, names, or device details. `convo` is a random id the page
-- makes per chat so follow-ups can be read together; it resets on "New chat".
CREATE TABLE IF NOT EXISTS questions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT    NOT NULL,          -- ISO timestamp, UTC
  convo       TEXT,                      -- random per-chat id, or null
  turn        INTEGER NOT NULL,          -- 1 = first question in the chat
  question    TEXT    NOT NULL,
  answer      TEXT,                      -- what the guest saw
  searches    INTEGER NOT NULL DEFAULT 0,
  model       TEXT,
  in_tokens   INTEGER,                   -- uncached input
  cache_read  INTEGER,
  cache_write INTEGER,
  out_tokens  INTEGER,
  stop        TEXT,                      -- final stop reason
  error       TEXT                       -- set when the answer failed
);
CREATE INDEX IF NOT EXISTS questions_at ON questions (at);
