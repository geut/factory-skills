// Forward-only steps from one schema version to the next, keyed by the version
// they upgrade from. Each step is additive. The opener runs every step a
// database needs in one transaction, then publishes the new version. A new
// schema version adds its step here and the same tables to schema.sql, so a new
// database and an upgraded one end up with the same schema.
export const OLDEST_UPGRADABLE_VERSION = 3;

export const upgrades: Record<number, string> = {
  // Schema 4: the factory server's owner lease (ADR-003). schema_meta is rebuilt
  // because schema 3 pinned its version with a CHECK.
  3: `
CREATE TABLE schema_meta_next (
  singleton      INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
INSERT INTO schema_meta_next (singleton, schema_version, created_at)
  SELECT singleton, schema_version, created_at FROM schema_meta;
DROP TABLE schema_meta;
ALTER TABLE schema_meta_next RENAME TO schema_meta;

CREATE TABLE server_lease (
  singleton    INTEGER PRIMARY KEY CHECK (singleton = 1),
  instance_id  TEXT NOT NULL CHECK (length(trim(instance_id)) > 0),
  url          TEXT NOT NULL CHECK (length(trim(url)) > 0),
  pid          INTEGER NOT NULL CHECK (pid > 0),
  started_at   TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
) STRICT;
`,
  // Schema 5: API clients and the actor behind each command.
  4: `
CREATE TABLE api_clients (
  name         TEXT PRIMARY KEY CHECK (name GLOB '[a-z0-9]*' AND length(name) <= 64),
  scope        TEXT NOT NULL CHECK (scope IN ('read', 'act')),
  token_hash   TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
) STRICT;

ALTER TABLE events ADD COLUMN actor TEXT;
ALTER TABLE events ADD COLUMN actor_on_behalf_of TEXT;
ALTER TABLE attention_replies ADD COLUMN actor TEXT;
ALTER TABLE attention_replies ADD COLUMN actor_on_behalf_of TEXT;
`,
  // Schema 6: facts for factory stats.
  5: `
ALTER TABLE ticket_executions ADD COLUMN factory_version TEXT;

-- This factory's identity, so its stats can be told apart from another
-- factory's after an export. The display name lives in FACTORY.json.
CREATE TABLE factory_identity (
  singleton  INTEGER PRIMARY KEY CHECK (singleton = 1),
  factory_id TEXT NOT NULL CHECK (length(factory_id) = 36),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

INSERT INTO factory_identity (singleton, factory_id) VALUES (1, lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))));

-- Every stage and status an execution or a task has been in, and when. The
-- open interval has no ended_at. Stats measure stage, waiting, and factory
-- time from it.
CREATE TABLE status_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id TEXT NOT NULL REFERENCES ticket_executions(id) ON DELETE CASCADE,
  -- Null for the execution itself.
  task_id      TEXT,
  stage        TEXT,
  status       TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  ended_at     TEXT
) STRICT;

CREATE INDEX status_history_open
ON status_history(execution_id, task_id, ended_at);

-- A ticket's pull request, recorded at handoff or found by its branch, and
-- what happened to it since. Sync and webhooks upsert these by GitHub id.
CREATE TABLE pull_requests (
  execution_id   TEXT PRIMARY KEY REFERENCES ticket_executions(id) ON DELETE CASCADE,
  url            TEXT NOT NULL CHECK (length(trim(url)) > 0),
  number         INTEGER,
  head_branch    TEXT,
  author         TEXT,
  state          TEXT NOT NULL CHECK (state IN ('open', 'merged', 'closed')),
  opened_at      TEXT,
  merged_at      TEXT,
  closed_at      TEXT,
  recorded_at    TEXT NOT NULL,
  last_synced_at TEXT
) STRICT;

CREATE TABLE pull_request_reviews (
  review_id    TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES pull_requests(execution_id) ON DELETE CASCADE,
  author       TEXT NOT NULL,
  author_type  TEXT NOT NULL CHECK (author_type IN ('human', 'bot')),
  state        TEXT NOT NULL CHECK (
    state IN ('approved', 'changes_requested', 'commented', 'dismissed', 'pending')
  ),
  -- A comment counts toward an external review round only with a body.
  has_body     INTEGER NOT NULL CHECK (has_body IN (0, 1)),
  commit_sha   TEXT,
  submitted_at TEXT
) STRICT;

CREATE TABLE pull_request_commits (
  execution_id TEXT NOT NULL REFERENCES pull_requests(execution_id) ON DELETE CASCADE,
  sha          TEXT NOT NULL,
  committed_at TEXT,
  PRIMARY KEY (execution_id, sha)
) STRICT;
`,
  // Schema 7: a feedback round's items, kept on its task.
  6: `
ALTER TABLE tasks ADD COLUMN feedback_json TEXT CHECK (feedback_json IS NULL OR json_valid(feedback_json));
`,
  // Schema 8: the outbox can write to the code host (update_pull_request).
  // SQLite cannot change a CHECK, so actions is rebuilt: the old table is
  // renamed aside without rewriting what refers to it, the new one takes its
  // name, and its indexes and triggers come back. The upgrade runs with
  // foreign keys off and checks them before it commits.
  7: `
PRAGMA legacy_alter_table = ON;
ALTER TABLE actions RENAME TO actions_before_8;
PRAGMA legacy_alter_table = OFF;

CREATE TABLE actions (
  id                   TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  execution_id         TEXT NOT NULL REFERENCES ticket_executions(id) ON DELETE CASCADE,
  run_id               TEXT,
  attention_request_id TEXT,
  attention_reply_id   TEXT,
  retry_of_action_id   TEXT,
  kind                 TEXT NOT NULL CHECK (
    kind IN (
      'fetch_ticket', 'prepare_worktree', 'prepare_input', 'launch_run', 'resume_run',
      'interrupt_run', 'validate_run', 'notify_attention',
      'publish_projection', 'update_ticket_source', 'open_diff', 'open_pane',
      'update_pull_request'
    )
  ),
  status               TEXT NOT NULL CHECK (
    status IN ('pending', 'leased', 'succeeded', 'failed', 'cancelled')
  ),
  idempotency_key      TEXT NOT NULL UNIQUE,
  payload_json         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  attempts             INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts         INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  available_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  lease_owner          TEXT,
  lease_token          TEXT UNIQUE,
  lease_expires_at     TEXT,
  last_error           TEXT,
  result_json          TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at         TEXT,

  UNIQUE (execution_id, id),
  FOREIGN KEY (execution_id, run_id)
    REFERENCES agent_runs(execution_id, id),
  FOREIGN KEY (execution_id, attention_request_id)
    REFERENCES attention_requests(execution_id, id),
  FOREIGN KEY (attention_request_id, attention_reply_id)
    REFERENCES attention_replies(request_id, id),
  FOREIGN KEY (execution_id, retry_of_action_id)
    REFERENCES actions(execution_id, id),
  CHECK (
    (status = 'leased' AND lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL) OR
    (status <> 'leased' AND lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK (
    (status IN ('succeeded', 'failed', 'cancelled') AND completed_at IS NOT NULL) OR
    (status IN ('pending', 'leased') AND completed_at IS NULL)
  ),
  CHECK (attempts <= max_attempts),
  CHECK (attention_reply_id IS NULL OR attention_request_id IS NOT NULL),
  CHECK (
    kind NOT IN ('launch_run', 'resume_run', 'interrupt_run', 'validate_run') OR
    run_id IS NOT NULL
  ),
  CHECK (
    kind <> 'resume_run' OR
    (attention_request_id IS NOT NULL AND attention_reply_id IS NOT NULL)
  ),
  CHECK (kind <> 'notify_attention' OR attention_request_id IS NOT NULL)
) STRICT;

INSERT INTO actions SELECT * FROM actions_before_8;
DROP TABLE actions_before_8;

CREATE INDEX dispatchable_actions
ON actions(status, available_at, lease_expires_at);

CREATE UNIQUE INDEX one_active_validation_per_execution
ON actions(execution_id)
WHERE kind = 'validate_run' AND status IN ('pending', 'leased');

CREATE UNIQUE INDEX one_start_action_per_run
ON actions(run_id)
WHERE run_id IS NOT NULL
  AND kind IN ('launch_run', 'resume_run');

CREATE TRIGGER terminal_action_is_immutable
BEFORE UPDATE ON actions
WHEN OLD.status IN ('succeeded', 'failed', 'cancelled')
BEGIN
  SELECT RAISE(ABORT, 'terminal action is immutable');
END;

CREATE TRIGGER terminal_action_cannot_be_deleted
BEFORE DELETE ON actions
WHEN OLD.status IN ('succeeded', 'failed', 'cancelled')
BEGIN
  SELECT RAISE(ABORT, 'terminal action is immutable');
END;

CREATE TRIGGER active_action_requires_current_execution_on_insert
BEFORE INSERT ON actions
WHEN NEW.status IN ('pending', 'leased')
  AND NOT EXISTS (
    SELECT 1 FROM ticket_executions AS e
    WHERE e.id = NEW.execution_id AND e.is_current = 1
  )
BEGIN
  SELECT RAISE(ABORT, 'active action requires the current execution');
END;

CREATE TRIGGER active_action_requires_current_execution_on_update
BEFORE UPDATE OF status ON actions
WHEN NEW.status IN ('pending', 'leased')
  AND NOT EXISTS (
    SELECT 1 FROM ticket_executions AS e
    WHERE e.id = NEW.execution_id AND e.is_current = 1
  )
BEGIN
  SELECT RAISE(ABORT, 'active action requires the current execution');
END;
`,
};
