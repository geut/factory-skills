CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO meta(key, value) VALUES
  ('schemaVersion', '3'),
  ('storageVersion', '1'),
  ('revision', '0'),
  ('updatedAt', '');

CREATE TABLE IF NOT EXISTS tickets (
  id                     TEXT PRIMARY KEY,
  title                  TEXT,
  type                   TEXT,
  source_kind            TEXT,
  source_ref             TEXT,
  stage                  TEXT NOT NULL CHECK (stage IN ('plan','work','review','wrapup','done')),
  status                 TEXT NOT NULL CHECK (status IN ('active','waiting_for_user','blocked','failed','complete')),
  current_task           TEXT,
  message                TEXT,
  message_at             TEXT,
  created_at             TEXT,
  updated_at             TEXT,
  worktree_path          TEXT,
  worktree_branch        TEXT,
  worktree_base_branch   TEXT,
  worktree_workspace_id  TEXT
);

CREATE TABLE IF NOT EXISTS blockers (
  ticket_id TEXT PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
  reason    TEXT NOT NULL,
  since     TEXT NOT NULL,
  owner     TEXT NOT NULL CHECK (owner IN ('user','agent','external')),
  task      TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  ticket_id             TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  task_id               TEXT NOT NULL,
  status                TEXT CHECK (status IS NULL OR status IN ('pending','in_progress','ready_for_review','done','blocked')),
  review_round          INTEGER,
  review_verdict        TEXT CHECK (review_verdict IS NULL OR review_verdict IN ('approve','changes_requested','blocked')),
  review_finding_count  INTEGER,
  review_blocking_count INTEGER,
  review_updated_at     TEXT,
  updated_at            TEXT,
  PRIMARY KEY (ticket_id, task_id)
);

CREATE TABLE IF NOT EXISTS task_blocked_by (
  ticket_id          TEXT NOT NULL,
  task_id            TEXT NOT NULL,
  blocked_by_task_id TEXT NOT NULL,
  PRIMARY KEY (ticket_id, task_id, blocked_by_task_id),
  FOREIGN KEY (ticket_id, task_id) REFERENCES tasks(ticket_id, task_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sessions (
  ticket_id       TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  session_id      TEXT NOT NULL,
  stage           TEXT NOT NULL CHECK (stage IN ('plan','work','review','wrapup','done')),
  task            TEXT,
  round           INTEGER,
  model           TEXT,
  pane_id         TEXT,
  pane_name       TEXT,
  session_file    TEXT,
  status          TEXT NOT NULL CHECK (status IN ('starting','running','waiting_for_user','completed','failed','closed')),
  context_tokens  INTEGER,
  context_window  INTEGER,
  context_percent REAL,
  started_at      TEXT,
  updated_at      TEXT,
  PRIMARY KEY (ticket_id, session_id)
);

CREATE TABLE IF NOT EXISTS usage (
  ticket_id          TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  session_id         TEXT NOT NULL,
  stage              TEXT NOT NULL CHECK (stage IN ('plan','work','review','wrapup','done')),
  task               TEXT,
  round              INTEGER,
  model              TEXT,
  through_entry_id   TEXT,
  tokens_input       INTEGER NOT NULL DEFAULT 0,
  tokens_output      INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read  INTEGER NOT NULL DEFAULT 0,
  tokens_cache_write INTEGER NOT NULL DEFAULT 0,
  tokens_total       INTEGER NOT NULL DEFAULT 0,
  cost_usd           REAL NOT NULL DEFAULT 0,
  recorded_at        TEXT,
  PRIMARY KEY (ticket_id, session_id)
);

CREATE TABLE IF NOT EXISTS events (
  revision  INTEGER PRIMARY KEY,
  at        TEXT NOT NULL,
  op        TEXT NOT NULL,
  ticket_id TEXT,
  task_id   TEXT,
  payload   TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS tickets_status ON tickets(status, stage);
CREATE INDEX IF NOT EXISTS events_ticket ON events(ticket_id, revision);
