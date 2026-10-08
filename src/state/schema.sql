BEGIN IMMEDIATE;

CREATE TABLE schema_meta (
  singleton      INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 2),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

INSERT INTO schema_meta (singleton, schema_version) VALUES (1, 2);

-- A ticket is the stable external identity. Starting the same ticket again
-- finds this row; rerunning it creates a new ticket_execution generation.
CREATE TABLE tickets (
  id               TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  title            TEXT,
  type             TEXT,
  source_kind      TEXT NOT NULL CHECK (length(trim(source_kind)) > 0),
  source_ref       TEXT,
  source_payload   TEXT,
  source_hash      TEXT,
  parent_ticket_id TEXT REFERENCES tickets(id),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- An execution is one immutable generation of work for a ticket. The row's
-- state is mutable while that generation is current; older generations stay
-- queryable after an explicit rerun.
CREATE TABLE ticket_executions (
  id                    TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  ticket_id             TEXT NOT NULL REFERENCES tickets(id),
  generation            INTEGER NOT NULL CHECK (generation > 0),
  is_current            INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
  stage                 TEXT NOT NULL CHECK (
    stage IN ('plan', 'work', 'review', 'wrapup', 'done')
  ),
  status                TEXT NOT NULL CHECK (
    status IN (
      'queued', 'active', 'waiting_for_user', 'paused', 'resuming',
      'resume_failed', 'failed', 'ready_for_handoff', 'complete', 'cancelled'
    )
  ),
  version               INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  status_reason_code    TEXT,
  status_reason         TEXT,
  status_details_json   TEXT CHECK (
    status_details_json IS NULL OR json_valid(status_details_json)
  ),
  retryable             INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1)),
  policy_json           TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(policy_json)),
  input_json            TEXT CHECK (input_json IS NULL OR json_valid(input_json)),
  input_hash            TEXT,
  input_fetched_at      TEXT,
  factory_dir           TEXT NOT NULL CHECK (length(trim(factory_dir)) > 0),
  plan_path             TEXT,
  adr_path              TEXT,
  worktree_path         TEXT,
  worktree_branch       TEXT,
  worktree_base_branch  TEXT,
  worktree_workspace_id TEXT,
  worktree_status       TEXT CHECK (
    worktree_status IS NULL OR
    worktree_status IN ('preparing', 'ready', 'removed', 'failed')
  ),
  worktree_base_sha     TEXT,
  worktree_head_sha     TEXT,
  message               TEXT,
  message_at            TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at           TEXT,

  UNIQUE (ticket_id, generation),
  CHECK (status <> 'complete' OR stage = 'done'),
  CHECK (status <> 'ready_for_handoff' OR stage = 'wrapup'),
  CHECK (stage <> 'done' OR status IN ('complete', 'cancelled')),
  CHECK (
    (status IN ('complete', 'cancelled') AND finished_at IS NOT NULL) OR
    (status NOT IN ('complete', 'cancelled') AND finished_at IS NULL)
  )
) STRICT;

CREATE UNIQUE INDEX one_current_execution_per_ticket
ON ticket_executions(ticket_id)
WHERE is_current = 1;

CREATE INDEX execution_board
ON ticket_executions(is_current, status, stage, updated_at);

CREATE TABLE tasks (
  execution_id    TEXT NOT NULL REFERENCES ticket_executions(id) ON DELETE CASCADE,
  task_id         TEXT NOT NULL CHECK (length(trim(task_id)) > 0),
  ordinal         INTEGER NOT NULL CHECK (ordinal > 0),
  title           TEXT,
  task_file       TEXT NOT NULL CHECK (length(trim(task_file)) > 0),
  spec_hash       TEXT,
  status          TEXT NOT NULL CHECK (
    status IN (
      'pending', 'working', 'ready_for_review', 'reviewing',
      'done', 'blocked', 'cancelled'
    )
  ),
  review_round    INTEGER NOT NULL DEFAULT 0 CHECK (review_round >= 0),
  review_verdict  TEXT CHECK (
    review_verdict IS NULL OR
    review_verdict IN ('approve', 'changes_requested', 'blocked')
  ),
  finding_count   INTEGER CHECK (finding_count IS NULL OR finding_count >= 0),
  blocking_count  INTEGER CHECK (blocking_count IS NULL OR blocking_count >= 0),
  version         INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  PRIMARY KEY (execution_id, task_id),
  UNIQUE (execution_id, ordinal),
  CHECK (
    (review_verdict IS NULL AND finding_count IS NULL AND blocking_count IS NULL) OR
    (review_verdict IS NOT NULL AND finding_count IS NOT NULL AND blocking_count IS NOT NULL)
  ),
  CHECK (blocking_count IS NULL OR blocking_count <= finding_count)
) STRICT;

-- v0 deliberately runs one task per ticket execution at a time.
CREATE UNIQUE INDEX one_current_task_per_execution
ON tasks(execution_id)
WHERE status IN ('working', 'ready_for_review', 'reviewing', 'blocked');

CREATE INDEX task_frontier
ON tasks(execution_id, status, ordinal);

CREATE TABLE task_dependencies (
  execution_id       TEXT NOT NULL,
  task_id            TEXT NOT NULL,
  depends_on_task_id TEXT NOT NULL,

  PRIMARY KEY (execution_id, task_id, depends_on_task_id),
  FOREIGN KEY (execution_id, task_id)
    REFERENCES tasks(execution_id, task_id) ON DELETE CASCADE,
  FOREIGN KEY (execution_id, depends_on_task_id)
    REFERENCES tasks(execution_id, task_id) ON DELETE CASCADE,
  CHECK (task_id <> depends_on_task_id)
) STRICT;

-- A session is a logical Pi conversation. Resuming a child reuses this row.
CREATE TABLE agent_sessions (
  id              TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  execution_id    TEXT NOT NULL REFERENCES ticket_executions(id) ON DELETE CASCADE,
  logical_key     TEXT NOT NULL CHECK (length(trim(logical_key)) > 0),
  stage           TEXT NOT NULL CHECK (stage IN ('plan', 'work', 'review', 'wrapup')),
  task_id         TEXT,
  model           TEXT NOT NULL CHECK (length(trim(model)) > 0),
  thinking        TEXT,
  pi_session_id   TEXT UNIQUE,
  session_file    TEXT UNIQUE,
  status          TEXT NOT NULL CHECK (status IN ('prepared', 'open', 'completed', 'abandoned')),
  context_tokens  INTEGER CHECK (context_tokens IS NULL OR context_tokens >= 0),
  context_window  INTEGER CHECK (context_window IS NULL OR context_window > 0),
  context_percent REAL CHECK (
    context_percent IS NULL OR (context_percent >= 0 AND context_percent <= 100)
  ),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  UNIQUE (execution_id, logical_key),
  UNIQUE (execution_id, id),
  FOREIGN KEY (execution_id, task_id)
    REFERENCES tasks(execution_id, task_id),
  CHECK (
    (stage IN ('plan', 'wrapup') AND task_id IS NULL) OR
    (stage IN ('work', 'review') AND task_id IS NOT NULL)
  )
) STRICT;

-- A run is one pane/process launch. Every resume or retry gets a new run while
-- keeping the same agent_session and Pi conversation.
CREATE TABLE agent_runs (
  id                 TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  execution_id       TEXT NOT NULL,
  session_id         TEXT NOT NULL,
  sequence           INTEGER NOT NULL CHECK (sequence > 0),
  parent_run_id      TEXT,
  purpose            TEXT NOT NULL CHECK (
    purpose IN (
      'initial', 'validation_correction', 'human_reply', 'review_changes',
      'manual_continue', 'infrastructure_retry'
    )
  ),
  semantic_round     INTEGER NOT NULL DEFAULT 0 CHECK (semantic_round >= 0),
  status             TEXT NOT NULL CHECK (
    status IN ('prepared', 'starting', 'running', 'terminal')
  ),
  terminal_kind      TEXT CHECK (
    terminal_kind IS NULL OR terminal_kind IN (
      'subagent_done', 'caller_ping', 'launch_failed', 'crashed',
      'completed_user_exit', 'pane_killed', 'gap_exit', 'cancelled'
    )
  ),
  subagent_id        TEXT UNIQUE,
  pane_id            TEXT,
  pane_name          TEXT,
  launch_script_file TEXT,
  watch_armed_at     TEXT,
  input_hash         TEXT,
  diff_hash          TEXT,
  result_contract    TEXT,
  result_status      TEXT NOT NULL DEFAULT 'pending' CHECK (
    result_status IN ('pending', 'valid', 'invalid')
  ),
  result_json        TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  result_hash        TEXT,
  result_error       TEXT,
  lifecycle_json     TEXT CHECK (lifecycle_json IS NULL OR json_valid(lifecycle_json)),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at         TEXT,
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ended_at           TEXT,

  UNIQUE (session_id, sequence),
  UNIQUE (session_id, id),
  UNIQUE (execution_id, id),
  FOREIGN KEY (execution_id, session_id)
    REFERENCES agent_sessions(execution_id, id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, parent_run_id)
    REFERENCES agent_runs(session_id, id),
  CHECK (
    (status = 'terminal' AND terminal_kind IS NOT NULL AND ended_at IS NOT NULL) OR
    (status <> 'terminal' AND terminal_kind IS NULL AND ended_at IS NULL)
  ),
  CHECK (
    result_status <> 'valid' OR
    (
      result_json IS NOT NULL AND result_hash IS NOT NULL AND
      status = 'terminal' AND terminal_kind = 'subagent_done'
    )
  )
) STRICT;

-- The hard v0 guardrail against two children changing one ticket concurrently.
CREATE UNIQUE INDEX one_active_run_per_execution
ON agent_runs(execution_id)
WHERE status IN ('prepared', 'starting', 'running');

CREATE INDEX runs_by_session
ON agent_runs(session_id, sequence);

CREATE TRIGGER terminal_agent_run_lifecycle_is_immutable
BEFORE UPDATE OF execution_id, session_id, sequence, parent_run_id, purpose,
  semantic_round, status, terminal_kind, subagent_id, pane_id, ended_at
ON agent_runs
WHEN OLD.status = 'terminal'
BEGIN
  SELECT RAISE(ABORT, 'terminal agent run lifecycle is immutable');
END;

CREATE TABLE attention_requests (
  id             TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  execution_id   TEXT NOT NULL REFERENCES ticket_executions(id) ON DELETE CASCADE,
  run_id         TEXT,
  kind           TEXT NOT NULL CHECK (
    kind IN ('agent_question', 'policy_limit', 'manual_approval')
  ),
  status         TEXT NOT NULL CHECK (
    status IN ('open', 'answered', 'resuming', 'resolved', 'cancelled')
  ),
  question       TEXT NOT NULL CHECK (length(trim(question)) > 0),
  context_json   TEXT CHECK (context_json IS NULL OR json_valid(context_json)),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  answered_at    TEXT,
  resolved_at    TEXT,
  cancelled_at   TEXT,

  UNIQUE (execution_id, id),
  FOREIGN KEY (execution_id, run_id)
    REFERENCES agent_runs(execution_id, id),
  CHECK (kind <> 'agent_question' OR run_id IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX one_ping_request_per_run
ON attention_requests(run_id)
WHERE kind = 'agent_question';

CREATE UNIQUE INDEX one_unresolved_attention_per_execution
ON attention_requests(execution_id)
WHERE status IN ('open', 'answered', 'resuming');

CREATE TABLE attention_replies (
  id              TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  request_id      TEXT NOT NULL REFERENCES attention_requests(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL CHECK (version > 0),
  answer          TEXT NOT NULL CHECK (length(trim(answer)) > 0),
  answer_hash     TEXT NOT NULL CHECK (length(trim(answer_hash)) > 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  is_current      INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  UNIQUE (request_id, version),
  UNIQUE (request_id, answer_hash),
  UNIQUE (request_id, id)
) STRICT;

CREATE UNIQUE INDEX one_current_reply_per_request
ON attention_replies(request_id)
WHERE is_current = 1;

-- Durable outbox. State changes and the action they require are committed in
-- the same transaction; workers claim actions with a lease before side effects.
CREATE TABLE actions (
  id                   TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  execution_id         TEXT NOT NULL REFERENCES ticket_executions(id) ON DELETE CASCADE,
  run_id               TEXT,
  attention_request_id TEXT,
  attention_reply_id   TEXT,
  retry_of_action_id   TEXT,
  kind                 TEXT NOT NULL CHECK (
    kind IN (
      'fetch_ticket', 'prepare_worktree', 'prepare_work_input', 'launch_run', 'resume_run',
      'interrupt_run', 'validate_run', 'notify_attention',
      'publish_projection', 'update_ticket_source', 'open_diff'
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

-- Runtime/command inputs and controller-emitted domain events share a monotonic
-- observation cursor. The cursor is for dashboards, not write concurrency.
CREATE TABLE events (
  revision          INTEGER PRIMARY KEY AUTOINCREMENT,
  id                TEXT NOT NULL UNIQUE,
  execution_id      TEXT REFERENCES ticket_executions(id),
  task_id           TEXT,
  run_id            TEXT,
  action_id         TEXT,
  direction         TEXT NOT NULL CHECK (direction IN ('input', 'domain')),
  source            TEXT NOT NULL CHECK (
    source IN ('command', 'runtime', 'action', 'validator', 'controller', 'user')
  ),
  kind              TEXT NOT NULL CHECK (length(trim(kind)) > 0),
  dedupe_key        TEXT NOT NULL UNIQUE,
  payload_json      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
  processing_status TEXT NOT NULL CHECK (
    processing_status IN ('pending', 'processed', 'ignored', 'failed')
  ),
  received_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  processed_at      TEXT,
  processing_error  TEXT,

  FOREIGN KEY (execution_id, task_id)
    REFERENCES tasks(execution_id, task_id),
  FOREIGN KEY (execution_id, run_id)
    REFERENCES agent_runs(execution_id, id),
  FOREIGN KEY (execution_id, action_id)
    REFERENCES actions(execution_id, id),
  CHECK (task_id IS NULL OR execution_id IS NOT NULL),
  CHECK (run_id IS NULL OR execution_id IS NOT NULL),
  CHECK (action_id IS NULL OR execution_id IS NOT NULL),
  CHECK (source <> 'runtime' OR run_id IS NOT NULL),
  CHECK (
    (processing_status = 'pending' AND processed_at IS NULL) OR
    (processing_status <> 'pending' AND processed_at IS NOT NULL)
  )
) STRICT;

CREATE INDEX pending_events
ON events(processing_status, revision);

CREATE INDEX dashboard_events
ON events(direction, revision);

CREATE UNIQUE INDEX one_terminal_runtime_event_per_run
ON events(run_id)
WHERE run_id IS NOT NULL
  AND direction = 'input'
  AND source = 'runtime'
  AND kind IN (
    'subagent_done', 'caller_ping', 'launch_failed', 'crashed',
    'completed_user_exit', 'pane_killed', 'gap_exit', 'cancelled'
  );

CREATE TABLE validation_runs (
  id                TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  execution_id      TEXT NOT NULL REFERENCES ticket_executions(id) ON DELETE CASCADE,
  run_id            TEXT NOT NULL,
  attempt           INTEGER NOT NULL CHECK (attempt > 0),
  validator_version TEXT NOT NULL CHECK (length(trim(validator_version)) > 0),
  input_hash        TEXT CHECK (input_hash IS NULL OR length(trim(input_hash)) > 0),
  status            TEXT NOT NULL CHECK (
    status IN ('pending', 'running', 'passed', 'failed', 'error')
  ),
  summary           TEXT,
  started_at        TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at      TEXT,

  UNIQUE (run_id, attempt),
  FOREIGN KEY (execution_id, run_id)
    REFERENCES agent_runs(execution_id, id),
  CHECK (
    (status IN ('passed', 'failed', 'error') AND completed_at IS NOT NULL) OR
    (status IN ('pending', 'running') AND completed_at IS NULL)
  )
) STRICT;

CREATE TABLE validation_checks (
  validation_id  TEXT NOT NULL REFERENCES validation_runs(id) ON DELETE CASCADE,
  ordinal        INTEGER NOT NULL CHECK (ordinal > 0),
  name           TEXT NOT NULL CHECK (length(trim(name)) > 0),
  kind           TEXT NOT NULL CHECK (
    kind IN ('artifact', 'schema', 'command', 'policy', 'diff')
  ),
  status         TEXT NOT NULL CHECK (
    status IN ('passed', 'failed', 'error', 'skipped')
  ),
  command        TEXT,
  exit_code      INTEGER,
  duration_ms    INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  evidence_path  TEXT,
  output_excerpt TEXT,
  details_json   TEXT CHECK (details_json IS NULL OR json_valid(details_json)),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  PRIMARY KEY (validation_id, ordinal)
) STRICT;

CREATE TRIGGER validation_must_start_unfinished
BEFORE INSERT ON validation_runs
WHEN NEW.status IN ('passed', 'failed', 'error')
BEGIN
  SELECT RAISE(ABORT, 'validation must start pending or running');
END;

-- A pass requires a finished subagent_done run and only passing checks.
-- Plan and work acceptance live in those checks. The guard does not require
-- a parsed result or a matching result hash.
CREATE TRIGGER validation_pass_guard
BEFORE UPDATE OF status ON validation_runs
WHEN NEW.status = 'passed'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM agent_runs AS r
    WHERE r.id = NEW.run_id
      AND r.execution_id = NEW.execution_id
      AND r.status = 'terminal'
      AND r.terminal_kind = 'subagent_done'
  ) THEN RAISE(ABORT, 'validation subject does not match a subagent_done run') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM validation_checks AS c
    WHERE c.validation_id = NEW.id AND c.status = 'passed'
  ) THEN RAISE(ABORT, 'passed validation requires at least one passed check') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM validation_checks AS c
    WHERE c.validation_id = NEW.id
      AND c.status IN ('failed', 'error', 'skipped')
  ) THEN RAISE(ABORT, 'passed validation contains a failing check') END;
END;

CREATE TRIGGER terminal_validation_is_immutable
BEFORE UPDATE ON validation_runs
WHEN OLD.status IN ('passed', 'failed', 'error')
BEGIN
  SELECT RAISE(ABORT, 'terminal validation is immutable');
END;

CREATE TRIGGER terminal_validation_cannot_be_deleted
BEFORE DELETE ON validation_runs
WHEN OLD.status IN ('passed', 'failed', 'error')
BEGIN
  SELECT RAISE(ABORT, 'terminal validation is immutable');
END;

CREATE TRIGGER terminal_validation_rejects_new_checks
BEFORE INSERT ON validation_checks
WHEN EXISTS (
  SELECT 1
  FROM validation_runs AS v
  WHERE v.id = NEW.validation_id
    AND v.status IN ('passed', 'failed', 'error')
)
BEGIN
  SELECT RAISE(ABORT, 'terminal validation checks are immutable');
END;

CREATE TRIGGER terminal_validation_rejects_changed_checks
BEFORE UPDATE ON validation_checks
WHEN EXISTS (
  SELECT 1
  FROM validation_runs AS v
  WHERE v.id = OLD.validation_id
    AND v.status IN ('passed', 'failed', 'error')
)
BEGIN
  SELECT RAISE(ABORT, 'terminal validation checks are immutable');
END;

CREATE TRIGGER terminal_validation_rejects_deleted_checks
BEFORE DELETE ON validation_checks
WHEN EXISTS (
  SELECT 1
  FROM validation_runs AS v
  WHERE v.id = OLD.validation_id
    AND v.status IN ('passed', 'failed', 'error')
)
BEGIN
  SELECT RAISE(ABORT, 'terminal validation checks are immutable');
END;

CREATE TRIGGER validated_agent_result_is_immutable
BEFORE UPDATE OF result_contract, result_status, result_json, result_hash, result_error
ON agent_runs
WHEN EXISTS (
  SELECT 1
  FROM validation_runs AS v
  WHERE v.run_id = OLD.id AND v.status = 'passed'
)
BEGIN
  SELECT RAISE(ABORT, 'validated agent result is immutable');
END;

-- Pi reports cumulative usage for a session. Each terminal run stores that raw
-- cumulative snapshot and its computed delta, so either aggregation is safe.
CREATE TABLE usage_snapshots (
  id                           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id                   TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  run_id                       TEXT NOT NULL UNIQUE,
  snapshot_key                 TEXT NOT NULL,
  through_entry_id             TEXT,
  cumulative_tokens_input      INTEGER NOT NULL CHECK (cumulative_tokens_input >= 0),
  cumulative_tokens_output     INTEGER NOT NULL CHECK (cumulative_tokens_output >= 0),
  cumulative_tokens_cache_read INTEGER NOT NULL CHECK (cumulative_tokens_cache_read >= 0),
  cumulative_tokens_cache_write INTEGER NOT NULL CHECK (cumulative_tokens_cache_write >= 0),
  cumulative_tokens_total      INTEGER NOT NULL CHECK (cumulative_tokens_total >= 0),
  cumulative_cost_usd_micros   INTEGER NOT NULL CHECK (cumulative_cost_usd_micros >= 0),
  delta_tokens_input           INTEGER NOT NULL CHECK (delta_tokens_input >= 0),
  delta_tokens_output          INTEGER NOT NULL CHECK (delta_tokens_output >= 0),
  delta_tokens_cache_read      INTEGER NOT NULL CHECK (delta_tokens_cache_read >= 0),
  delta_tokens_cache_write     INTEGER NOT NULL CHECK (delta_tokens_cache_write >= 0),
  delta_tokens_total           INTEGER NOT NULL CHECK (delta_tokens_total >= 0),
  delta_cost_usd_micros        INTEGER NOT NULL CHECK (delta_cost_usd_micros >= 0),
  context_tokens               INTEGER CHECK (context_tokens IS NULL OR context_tokens >= 0),
  context_window               INTEGER CHECK (context_window IS NULL OR context_window > 0),
  raw_json                     TEXT CHECK (raw_json IS NULL OR json_valid(raw_json)),
  recorded_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  UNIQUE (session_id, snapshot_key),
  FOREIGN KEY (session_id, run_id)
    REFERENCES agent_runs(session_id, id)
) STRICT;

CREATE INDEX latest_usage_per_session
ON usage_snapshots(session_id, id DESC);

CREATE VIEW current_ticket_executions AS
SELECT
  e.*,
  t.title AS ticket_title,
  t.type AS ticket_type,
  t.source_kind,
  t.source_ref
FROM tickets AS t
JOIN ticket_executions AS e ON e.ticket_id = t.id
WHERE e.is_current = 1;

CREATE VIEW ready_task_frontier AS
SELECT t.*
FROM tasks AS t
WHERE t.status = 'pending'
  AND EXISTS (
    SELECT 1
    FROM ticket_executions AS e
    WHERE e.id = t.execution_id
      AND e.is_current = 1
      AND e.stage = 'work'
      AND e.status = 'active'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM task_dependencies AS d
    JOIN tasks AS prerequisite
      ON prerequisite.execution_id = d.execution_id
     AND prerequisite.task_id = d.depends_on_task_id
    WHERE d.execution_id = t.execution_id
      AND d.task_id = t.task_id
      AND prerequisite.status <> 'done'
  );

CREATE VIEW open_attention AS
SELECT *
FROM attention_requests
WHERE status IN ('open', 'answered', 'resuming');

CREATE VIEW latest_usage_by_session AS
SELECT u.*
FROM usage_snapshots AS u
WHERE u.run_id = (
  SELECT r.id
  FROM agent_runs AS r
  JOIN usage_snapshots AS u2 ON u2.run_id = r.id
  WHERE r.session_id = u.session_id
  ORDER BY r.sequence DESC
  LIMIT 1
);

CREATE VIEW execution_usage_totals AS
SELECT
  s.execution_id,
  SUM(u.cumulative_tokens_input) AS tokens_input,
  SUM(u.cumulative_tokens_output) AS tokens_output,
  SUM(u.cumulative_tokens_cache_read) AS tokens_cache_read,
  SUM(u.cumulative_tokens_cache_write) AS tokens_cache_write,
  SUM(u.cumulative_tokens_total) AS tokens_total,
  SUM(u.cumulative_cost_usd_micros) AS cost_usd_micros
FROM latest_usage_by_session AS u
JOIN agent_sessions AS s ON s.id = u.session_id
GROUP BY s.execution_id;

CREATE VIEW execution_usage_by_stage AS
SELECT
  r.execution_id,
  s.stage,
  SUM(u.delta_tokens_input) AS tokens_input,
  SUM(u.delta_tokens_output) AS tokens_output,
  SUM(u.delta_tokens_cache_read) AS tokens_cache_read,
  SUM(u.delta_tokens_cache_write) AS tokens_cache_write,
  SUM(u.delta_tokens_total) AS tokens_total,
  SUM(u.delta_cost_usd_micros) AS cost_usd_micros
FROM usage_snapshots AS u
JOIN agent_runs AS r ON r.id = u.run_id
JOIN agent_sessions AS s ON s.id = u.session_id
GROUP BY r.execution_id, s.stage;

-- Superseding a generation is legal only after its work has been quiesced.
-- This keeps an explicit rerun from leaving an old child or outbox action live.
CREATE TRIGGER retire_execution_requires_quiescence
BEFORE UPDATE OF is_current ON ticket_executions
WHEN OLD.is_current = 1 AND NEW.is_current = 0
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM agent_runs AS r
    WHERE r.execution_id = OLD.id
      AND r.status IN ('prepared', 'starting', 'running')
  ) THEN RAISE(ABORT, 'cannot supersede an execution with an active agent run') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM actions AS a
    WHERE a.execution_id = OLD.id
      AND a.status IN ('pending', 'leased')
  ) THEN RAISE(ABORT, 'cannot supersede an execution with an active action') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM tasks AS t
    WHERE t.execution_id = OLD.id
      AND t.status IN ('working', 'ready_for_review', 'reviewing', 'blocked')
  ) THEN RAISE(ABORT, 'cannot supersede an execution with an active task') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM agent_sessions AS s
    WHERE s.execution_id = OLD.id
      AND s.status IN ('prepared', 'open')
  ) THEN RAISE(ABORT, 'cannot supersede an execution with an open agent session') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM attention_requests AS q
    WHERE q.execution_id = OLD.id
      AND q.status IN ('open', 'answered', 'resuming')
  ) THEN RAISE(ABORT, 'cannot supersede an execution with unresolved attention') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM validation_runs AS v
    WHERE v.execution_id = OLD.id
      AND v.status IN ('pending', 'running')
  ) THEN RAISE(ABORT, 'cannot supersede an execution with a running validation') END;

  SELECT CASE WHEN EXISTS (
    SELECT 1
    FROM events AS e
    WHERE e.execution_id = OLD.id
      AND e.processing_status = 'pending'
  ) THEN RAISE(ABORT, 'cannot supersede an execution with a pending event') END;
END;

CREATE TRIGGER active_run_requires_current_execution_on_insert
BEFORE INSERT ON agent_runs
WHEN NEW.status IN ('prepared', 'starting', 'running')
  AND NOT EXISTS (
    SELECT 1 FROM ticket_executions AS e
    WHERE e.id = NEW.execution_id AND e.is_current = 1
  )
BEGIN
  SELECT RAISE(ABORT, 'active agent run requires the current execution');
END;

CREATE TRIGGER active_run_requires_current_execution_on_update
BEFORE UPDATE OF status ON agent_runs
WHEN NEW.status IN ('prepared', 'starting', 'running')
  AND NOT EXISTS (
    SELECT 1 FROM ticket_executions AS e
    WHERE e.id = NEW.execution_id AND e.is_current = 1
  )
BEGIN
  SELECT RAISE(ABORT, 'active agent run requires the current execution');
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

CREATE TRIGGER active_task_requires_current_execution_on_insert
BEFORE INSERT ON tasks
WHEN NEW.status IN ('working', 'ready_for_review', 'reviewing', 'blocked')
  AND NOT EXISTS (
    SELECT 1 FROM ticket_executions AS e
    WHERE e.id = NEW.execution_id AND e.is_current = 1
  )
BEGIN
  SELECT RAISE(ABORT, 'active task requires the current execution');
END;

CREATE TRIGGER active_task_requires_current_execution_on_update
BEFORE UPDATE OF status ON tasks
WHEN NEW.status IN ('working', 'ready_for_review', 'reviewing', 'blocked')
  AND NOT EXISTS (
    SELECT 1 FROM ticket_executions AS e
    WHERE e.id = NEW.execution_id AND e.is_current = 1
  )
BEGIN
  SELECT RAISE(ABORT, 'active task requires the current execution');
END;

CREATE TRIGGER open_session_requires_current_execution_on_insert
BEFORE INSERT ON agent_sessions
WHEN NEW.status IN ('prepared', 'open')
  AND NOT EXISTS (
    SELECT 1 FROM ticket_executions AS e
    WHERE e.id = NEW.execution_id AND e.is_current = 1
  )
BEGIN
  SELECT RAISE(ABORT, 'open agent session requires the current execution');
END;

CREATE TRIGGER open_session_requires_current_execution_on_update
BEFORE UPDATE OF status ON agent_sessions
WHEN NEW.status IN ('prepared', 'open')
  AND NOT EXISTS (
    SELECT 1 FROM ticket_executions AS e
    WHERE e.id = NEW.execution_id AND e.is_current = 1
  )
BEGIN
  SELECT RAISE(ABORT, 'open agent session requires the current execution');
END;

CREATE TRIGGER unresolved_attention_requires_current_execution_on_insert
BEFORE INSERT ON attention_requests
WHEN NEW.status IN ('open', 'answered', 'resuming')
  AND NOT EXISTS (
    SELECT 1 FROM ticket_executions AS e
    WHERE e.id = NEW.execution_id AND e.is_current = 1
  )
BEGIN
  SELECT RAISE(ABORT, 'unresolved attention requires the current execution');
END;

CREATE TRIGGER unresolved_attention_requires_current_execution_on_update
BEFORE UPDATE OF status ON attention_requests
WHEN NEW.status IN ('open', 'answered', 'resuming')
  AND NOT EXISTS (
    SELECT 1 FROM ticket_executions AS e
    WHERE e.id = NEW.execution_id AND e.is_current = 1
  )
BEGIN
  SELECT RAISE(ABORT, 'unresolved attention requires the current execution');
END;

CREATE TRIGGER running_validation_requires_current_execution_on_insert
BEFORE INSERT ON validation_runs
WHEN NEW.status IN ('pending', 'running')
  AND NOT EXISTS (
    SELECT 1 FROM ticket_executions AS e
    WHERE e.id = NEW.execution_id AND e.is_current = 1
  )
BEGIN
  SELECT RAISE(ABORT, 'running validation requires the current execution');
END;

CREATE TRIGGER running_validation_requires_current_execution_on_update
BEFORE UPDATE OF status ON validation_runs
WHEN NEW.status IN ('pending', 'running')
  AND NOT EXISTS (
    SELECT 1 FROM ticket_executions AS e
    WHERE e.id = NEW.execution_id AND e.is_current = 1
  )
BEGIN
  SELECT RAISE(ABORT, 'running validation requires the current execution');
END;

-- Publish the identity only when the complete schema is ready to commit.
PRAGMA application_id = 1178682196; -- "FACT"
PRAGMA user_version = 2;

COMMIT;
