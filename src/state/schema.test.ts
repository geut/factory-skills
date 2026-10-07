import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  APPLICATION_ID,
  IncompatibleFactoryDatabaseError,
  SCHEMA_VERSION,
  immediateTransaction,
  openStateDatabase,
  stateDatabasePath,
} from './database.ts';

const roots: Array<string> = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) {
      rmSync(root, { force: true, recursive: true });
    }
  }
});

function factoryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'factory-state-'));
  roots.push(root);
  return root;
}

function scalar(db: DatabaseSync, sql: string, ...params: Array<SQLInputValue>): unknown {
  const row = db.prepare(sql).get(...params);
  if (row === undefined) {
    return undefined;
  }
  return Object.values(row)[0];
}

function isIncompatibleDatabase(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'IncompatibleFactoryDatabaseError'
  );
}

function initializeInChild(root: string): Promise<void> {
  const databaseUrl = pathToFileURL(path.join(import.meta.dirname, 'database.ts')).href;
  const source = `
    import { openStateDatabase } from ${JSON.stringify(databaseUrl)};
    const db = openStateDatabase(process.argv.at(-1), { create: true });
    db.close();
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, root]);
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`initializer exited ${code}: ${stderr}`));
      }
    });
  });
}

function addTicket(db: DatabaseSync, id = 'PROJ-1'): void {
  db.prepare(
    "INSERT INTO tickets (id, title, type, source_kind, source_ref) VALUES (?, ?, 'feature', 'text', ?)",
  ).run(id, `Ticket ${id}`, `input:${id}`);
}

function addExecution(
  db: DatabaseSync,
  {
    generation = 1,
    id = 'exec-1',
    ticket = 'PROJ-1',
  }: { generation?: number; id?: string; ticket?: string } = {},
): void {
  db.prepare(
    `INSERT INTO ticket_executions
      (id, ticket_id, generation, stage, status, factory_dir)
     VALUES (?, ?, ?, 'plan', 'queued', ?)`,
  ).run(id, ticket, generation, `/tmp/.factory/tickets/${ticket}`);
}

function addTask(
  db: DatabaseSync,
  {
    execution = 'exec-1',
    id = '01',
    ordinal = 1,
    status = 'pending',
  }: { execution?: string; id?: string; ordinal?: number; status?: string } = {},
): void {
  db.prepare(
    `INSERT INTO tasks (execution_id, task_id, ordinal, task_file, status)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(execution, id, ordinal, `${id}-task.md`, status);
}

function addSession(
  db: DatabaseSync,
  {
    execution = 'exec-1',
    id = 'session-1',
    key = 'plan',
    stage = 'plan',
    task = null,
  }: {
    execution?: string;
    id?: string;
    key?: string;
    stage?: string;
    task?: string | null;
  } = {},
): void {
  db.prepare(
    `INSERT INTO agent_sessions
      (id, execution_id, logical_key, stage, task_id, model, status)
     VALUES (?, ?, ?, ?, ?, 'provider/model', 'open')`,
  ).run(id, execution, key, stage, task);
}

function addRun(
  db: DatabaseSync,
  {
    endedAt = null,
    execution = 'exec-1',
    id = 'run-1',
    parent = null,
    purpose = 'initial',
    semanticRound = 0,
    sequence = 1,
    session = 'session-1',
    status = 'prepared',
    terminalKind = null,
  }: {
    endedAt?: string | null;
    execution?: string;
    id?: string;
    parent?: string | null;
    purpose?: string;
    semanticRound?: number;
    sequence?: number;
    session?: string;
    status?: string;
    terminalKind?: string | null;
  } = {},
): void {
  db.prepare(
    `INSERT INTO agent_runs
      (id, execution_id, session_id, sequence, purpose, parent_run_id,
       semantic_round, status, terminal_kind, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    execution,
    session,
    sequence,
    purpose,
    parent,
    semanticRound,
    status,
    terminalKind,
    endedAt,
  );
}

test('initializes a fresh controller database and reopens it', () => {
  const root = factoryRoot();
  const db = openStateDatabase(root, { create: true });

  assert.equal(scalar(db, 'PRAGMA application_id'), APPLICATION_ID);
  assert.equal(scalar(db, 'PRAGMA user_version'), SCHEMA_VERSION);
  assert.equal(scalar(db, 'PRAGMA foreign_keys'), 1);
  assert.equal(String(scalar(db, 'PRAGMA journal_mode')).toLowerCase(), 'wal');
  assert.equal(scalar(db, 'SELECT schema_version FROM schema_meta'), SCHEMA_VERSION);
  assert.equal(
    scalar(db, "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'actions'"),
    1,
  );
  db.close();

  const reopened = openStateDatabase(root, { readOnly: true });
  assert.equal(scalar(reopened, 'SELECT count(*) FROM tickets'), 0);
  assert.throws(
    () =>
      reopened.prepare("INSERT INTO tickets (id, source_kind) VALUES ('READ-ONLY', 'text')").run(),
    /read-only|readonly/i,
  );
  reopened.close();
});

test('concurrent initialization converges on one complete database', async () => {
  const root = factoryRoot();
  await Promise.all(Array.from({ length: 6 }, () => initializeInChild(root)));
  const db = openStateDatabase(root);
  assert.equal(scalar(db, 'SELECT schema_version FROM schema_meta'), SCHEMA_VERSION);
  assert.equal(scalar(db, 'PRAGMA integrity_check'), 'ok');
  db.close();
});

test('rejects the legacy fstate database without modifying it', () => {
  const root = factoryRoot();
  const databasePath = stateDatabasePath(root);
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const legacy = new DatabaseSync(databasePath);
  legacy.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  legacy.prepare("INSERT INTO meta VALUES ('schemaVersion', '4')").run();
  legacy.close();

  assert.throws(
    () => openStateDatabase(root, { create: true }),
    (error: unknown) =>
      isIncompatibleDatabase(error) &&
      typeof error === 'object' &&
      error !== null &&
      'message' in error &&
      typeof error.message === 'string' &&
      /legacy fstate database/.test(error.message),
  );

  const unchanged = new DatabaseSync(databasePath);
  assert.equal(scalar(unchanged, 'PRAGMA application_id'), 0);
  assert.equal(scalar(unchanged, "SELECT value FROM meta WHERE key = 'schemaVersion'"), '4');
  unchanged.close();
});

test('does not stamp an unrelated SQLite database as factory state', () => {
  const root = factoryRoot();
  const databasePath = stateDatabasePath(root);
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const unrelated = new DatabaseSync(databasePath);
  unrelated.exec('CREATE TABLE product_data (id INTEGER PRIMARY KEY, value TEXT)');
  unrelated.prepare("INSERT INTO product_data (value) VALUES ('keep me')").run();
  unrelated.close();

  assert.throws(() => openStateDatabase(root, { create: true }), IncompatibleFactoryDatabaseError);

  const unchanged = new DatabaseSync(databasePath);
  assert.equal(scalar(unchanged, 'PRAGMA application_id'), 0);
  assert.equal(scalar(unchanged, 'SELECT value FROM product_data'), 'keep me');
  assert.equal(
    scalar(unchanged, "SELECT count(*) FROM sqlite_master WHERE name = 'schema_meta'"),
    0,
  );
  unchanged.close();
});

test('does not adopt an unrelated view-only SQLite database', () => {
  const root = factoryRoot();
  const databasePath = stateDatabasePath(root);
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const unrelated = new DatabaseSync(databasePath);
  unrelated.exec('CREATE VIEW product_summary AS SELECT 42 AS value');
  unrelated.close();

  assert.throws(() => openStateDatabase(root, { create: true }), IncompatibleFactoryDatabaseError);

  const unchanged = new DatabaseSync(databasePath);
  assert.equal(scalar(unchanged, 'SELECT value FROM product_summary'), 42);
  assert.equal(scalar(unchanged, 'PRAGMA application_id'), 0);
  unchanged.close();
});

test('keeps one current generation per ticket while parallel tickets stay independent', () => {
  const root = factoryRoot();
  const db = openStateDatabase(root, { create: true });
  addTicket(db);
  addExecution(db);

  assert.throws(
    () => addExecution(db, { generation: 2, id: 'exec-2' }),
    /UNIQUE constraint failed/,
  );

  immediateTransaction(db, () => {
    db.prepare("UPDATE ticket_executions SET is_current = 0 WHERE id = 'exec-1'").run();
    addExecution(db, { generation: 2, id: 'exec-2' });
  });

  addTicket(db, 'PROJ-2');
  addExecution(db, { id: 'other-exec', ticket: 'PROJ-2' });
  assert.equal(scalar(db, 'SELECT count(*) FROM current_ticket_executions'), 2);
  assert.equal(
    scalar(db, "SELECT generation FROM current_ticket_executions WHERE ticket_id = 'PROJ-1'"),
    2,
  );

  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO ticket_executions
            (id, ticket_id, generation, is_current, stage, status, factory_dir)
           VALUES ('bad', 'PROJ-1', 3, 0, 'plan', 'ready_for_handoff', '/tmp/bad')`,
        )
        .run(),
    /CHECK constraint failed/,
  );
  db.close();
});

test('derives the ready task frontier and prevents parallel active tasks', () => {
  const root = factoryRoot();
  const db = openStateDatabase(root, { create: true });
  addTicket(db);
  addExecution(db);
  addTask(db);
  addTask(db, { id: '02', ordinal: 2 });
  db.prepare(
    "UPDATE ticket_executions SET stage = 'work', status = 'active' WHERE id = 'exec-1'",
  ).run();
  db.prepare(
    "INSERT INTO task_dependencies (execution_id, task_id, depends_on_task_id) VALUES ('exec-1', '02', '01')",
  ).run();

  assert.deepEqual(
    db
      .prepare('SELECT task_id FROM ready_task_frontier ORDER BY ordinal')
      .all()
      .map((row) => ({ ...row })),
    [{ task_id: '01' }],
  );
  db.prepare(
    "UPDATE tasks SET status = 'done' WHERE execution_id = 'exec-1' AND task_id = '01'",
  ).run();
  assert.deepEqual(
    db
      .prepare('SELECT task_id FROM ready_task_frontier')
      .all()
      .map((row) => ({ ...row })),
    [{ task_id: '02' }],
  );

  db.prepare(
    "UPDATE tasks SET status = 'working' WHERE execution_id = 'exec-1' AND task_id = '01'",
  ).run();
  assert.throws(
    () =>
      db
        .prepare(
          "UPDATE tasks SET status = 'working' WHERE execution_id = 'exec-1' AND task_id = '02'",
        )
        .run(),
    /UNIQUE constraint failed/,
  );
  assert.throws(
    () =>
      db
        .prepare(
          "INSERT INTO task_dependencies (execution_id, task_id, depends_on_task_id) VALUES ('exec-1', '01', '01')",
        )
        .run(),
    /CHECK constraint failed/,
  );
  db.close();
});

test('separates a Pi session from pane runs and permits only one active child', () => {
  const root = factoryRoot();
  const db = openStateDatabase(root, { create: true });
  addTicket(db);
  addExecution(db);
  addTask(db);
  addSession(db);
  addSession(db, { id: 'work-session', key: 'work:01', stage: 'work', task: '01' });
  addRun(db);

  assert.throws(
    () =>
      addRun(db, {
        id: 'run-2',
        sequence: 1,
        session: 'work-session',
      }),
    /UNIQUE constraint failed/,
  );

  db.prepare(
    `UPDATE agent_runs
     SET status = 'terminal', terminal_kind = 'caller_ping', ended_at = '2026-01-01T00:00:00Z'
     WHERE id = 'run-1'`,
  ).run();
  addRun(db, {
    id: 'run-2',
    purpose: 'human_reply',
    sequence: 2,
  });
  assert.equal(scalar(db, "SELECT count(*) FROM agent_runs WHERE session_id = 'session-1'"), 2);

  assert.throws(
    () =>
      addSession(db, {
        id: 'invalid-work-session',
        key: 'invalid',
        stage: 'work',
        task: null,
      }),
    /CHECK constraint failed/,
  );
  db.close();
});

test('cannot supersede an execution until tasks, runs, and actions are quiescent', () => {
  const root = factoryRoot();
  const db = openStateDatabase(root, { create: true });
  addTicket(db);
  addExecution(db);
  addTask(db, { status: 'working' });
  addSession(db, { id: 'work-session', key: 'work:01', stage: 'work', task: '01' });
  addRun(db, { session: 'work-session' });

  assert.throws(
    () => db.prepare("UPDATE ticket_executions SET is_current = 0 WHERE id = 'exec-1'").run(),
    /active agent run/,
  );
  db.prepare(
    `UPDATE agent_runs
     SET status = 'terminal', terminal_kind = 'cancelled', ended_at = '2026-01-01T00:00:00Z'
     WHERE id = 'run-1'`,
  ).run();
  assert.throws(
    () => db.prepare("UPDATE ticket_executions SET is_current = 0 WHERE id = 'exec-1'").run(),
    /active task/,
  );
  db.prepare("UPDATE tasks SET status = 'cancelled' WHERE execution_id = 'exec-1'").run();
  db.prepare(
    `INSERT INTO actions
      (id, execution_id, kind, status, idempotency_key)
     VALUES ('projection-1', 'exec-1', 'publish_projection', 'pending', 'projection:exec-1')`,
  ).run();
  assert.throws(
    () => db.prepare("UPDATE ticket_executions SET is_current = 0 WHERE id = 'exec-1'").run(),
    /active action/,
  );
  db.prepare(
    `UPDATE actions
     SET status = 'cancelled', completed_at = '2026-01-01T00:00:01Z'
     WHERE id = 'projection-1'`,
  ).run();
  assert.throws(
    () => db.prepare("UPDATE ticket_executions SET is_current = 0 WHERE id = 'exec-1'").run(),
    /open agent session/,
  );
  db.prepare("UPDATE agent_sessions SET status = 'completed' WHERE id = 'work-session'").run();
  db.prepare("UPDATE ticket_executions SET is_current = 0 WHERE id = 'exec-1'").run();
  assert.equal(scalar(db, "SELECT is_current FROM ticket_executions WHERE id = 'exec-1'"), 0);
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO actions
            (id, execution_id, kind, status, idempotency_key)
           VALUES ('late-action', 'exec-1', 'publish_projection', 'pending', 'late:action')`,
        )
        .run(),
    /active action requires the current execution/,
  );
  assert.throws(
    () =>
      addRun(db, {
        id: 'late-run',
        sequence: 2,
        session: 'work-session',
      }),
    /active agent run requires the current execution/,
  );
  db.close();
});

test('persists an attention reply and reuses it after a failed resume', () => {
  const root = factoryRoot();
  const db = openStateDatabase(root, { create: true });
  addTicket(db);
  addExecution(db);
  addSession(db);
  addRun(db, {
    endedAt: '2026-01-01T00:00:00Z',
    status: 'terminal',
    terminalKind: 'caller_ping',
  });
  db.prepare(
    `INSERT INTO attention_requests (id, execution_id, run_id, kind, status, question)
     VALUES ('question-1', 'exec-1', 'run-1', 'agent_question', 'open', 'Which behavior?')`,
  ).run();
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO events
            (id, execution_id, direction, source, kind, dedupe_key,
             processing_status, processed_at)
           VALUES
            ('bad-runtime-event', 'exec-1', 'input', 'runtime', 'crashed',
             'runtime:missing-run', 'ignored', '2026-01-01T00:00:02Z')`,
        )
        .run(),
    /CHECK constraint failed/,
  );
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO actions
            (id, execution_id, kind, status, idempotency_key)
           VALUES ('bad-launch', 'exec-1', 'launch_run', 'pending', 'bad:launch')`,
        )
        .run(),
    /CHECK constraint failed/,
  );
  immediateTransaction(db, () => {
    db.prepare(
      `INSERT INTO attention_replies
        (id, request_id, version, answer, answer_hash, idempotency_key)
       VALUES ('reply-1', 'question-1', 1, 'Use A', 'sha-a', 'reply:question-1:sha-a')`,
    ).run();
    db.prepare(
      `UPDATE attention_requests
       SET status = 'resuming', answered_at = '2026-01-01T00:00:10Z'
       WHERE id = 'question-1'`,
    ).run();
    db.prepare(
      `UPDATE ticket_executions
       SET status = 'resuming', version = version + 1
       WHERE id = 'exec-1'`,
    ).run();
    addRun(db, {
      id: 'run-2',
      parent: 'run-1',
      purpose: 'human_reply',
      sequence: 2,
    });
    db.prepare(
      `INSERT INTO actions
        (id, execution_id, run_id, attention_request_id, attention_reply_id,
         kind, status, idempotency_key)
       VALUES
        ('resume-1', 'exec-1', 'run-2', 'question-1', 'reply-1',
         'resume_run', 'pending', 'resume:question-1:reply-1:run-2')`,
    ).run();
  });

  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO attention_replies
            (id, request_id, version, answer, answer_hash, idempotency_key)
           VALUES ('reply-2', 'question-1', 2, 'Use B', 'sha-b', 'reply:question-1:sha-b')`,
        )
        .run(),
    /UNIQUE constraint failed/,
  );

  const claim = db
    .prepare(
      `UPDATE actions
     SET status = 'leased', lease_owner = 'worker-1', lease_token = 'lease-1',
         lease_expires_at = '2026-01-01T00:01:00Z'
     WHERE id = 'resume-1' AND status = 'pending'`,
    )
    .run();
  const losingClaim = db
    .prepare(
      `UPDATE actions
     SET status = 'leased', lease_owner = 'worker-2', lease_token = 'lease-2',
         lease_expires_at = '2026-01-01T00:01:00Z'
     WHERE id = 'resume-1' AND status = 'pending'`,
    )
    .run();
  assert.equal(claim.changes, 1);
  assert.equal(losingClaim.changes, 0);
  assert.equal(scalar(db, 'SELECT answer FROM attention_replies WHERE is_current = 1'), 'Use A');
  assert.equal(scalar(db, "SELECT status FROM actions WHERE id = 'resume-1'"), 'leased');
  assert.equal(scalar(db, "SELECT parent_run_id FROM agent_runs WHERE id = 'run-2'"), 'run-1');

  immediateTransaction(db, () => {
    db.prepare(
      `UPDATE actions
       SET status = 'failed', lease_owner = NULL, lease_token = NULL,
           lease_expires_at = NULL, completed_at = '2026-01-01T00:00:20Z',
           last_error = 'Herdr launch failed'
       WHERE id = 'resume-1'`,
    ).run();
    db.prepare(
      `UPDATE agent_runs
       SET status = 'terminal', terminal_kind = 'launch_failed',
           ended_at = '2026-01-01T00:00:20Z'
       WHERE id = 'run-2'`,
    ).run();
    db.prepare(
      `UPDATE ticket_executions
       SET status = 'resume_failed', retryable = 1, version = version + 1
       WHERE id = 'exec-1'`,
    ).run();
    db.prepare("UPDATE attention_requests SET status = 'answered' WHERE id = 'question-1'").run();
  });
  assert.equal(
    scalar(db, "SELECT status FROM ticket_executions WHERE id = 'exec-1'"),
    'resume_failed',
  );
  assert.equal(scalar(db, "SELECT answer FROM attention_replies WHERE id = 'reply-1'"), 'Use A');
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO actions
            (id, execution_id, run_id, attention_request_id, attention_reply_id,
             kind, status, idempotency_key)
           VALUES
            ('duplicate-resume', 'exec-1', 'run-2', 'question-1', 'reply-1',
             'resume_run', 'pending', 'duplicate:run-2')`,
        )
        .run(),
    /UNIQUE constraint failed/,
  );

  immediateTransaction(db, () => {
    db.prepare(
      `UPDATE ticket_executions
       SET status = 'resuming', version = version + 1
       WHERE id = 'exec-1'`,
    ).run();
    db.prepare("UPDATE attention_requests SET status = 'resuming' WHERE id = 'question-1'").run();
    addRun(db, {
      id: 'run-3',
      parent: 'run-2',
      purpose: 'infrastructure_retry',
      sequence: 3,
    });
    db.prepare(
      `INSERT INTO actions
        (id, execution_id, run_id, attention_request_id, attention_reply_id,
         retry_of_action_id, kind, status, idempotency_key)
       VALUES
        ('resume-2', 'exec-1', 'run-3', 'question-1', 'reply-1',
         'resume-1', 'resume_run', 'pending', 'retry:resume-1:run-3')`,
    ).run();
  });

  assert.equal(
    scalar(db, "SELECT attention_reply_id FROM actions WHERE id = 'resume-2'"),
    'reply-1',
  );
  assert.equal(scalar(db, "SELECT answer FROM attention_replies WHERE id = 'reply-1'"), 'Use A');
  assert.equal(scalar(db, "SELECT status FROM ticket_executions WHERE id = 'exec-1'"), 'resuming');
  db.close();
});

test('deduplicates terminal events and aggregates resumed-session usage once', () => {
  const root = factoryRoot();
  const db = openStateDatabase(root, { create: true });
  addTicket(db);
  addExecution(db);
  addSession(db);
  addRun(db, {
    endedAt: '2026-01-01T00:00:00Z',
    status: 'terminal',
    terminalKind: 'subagent_done',
  });
  addRun(db, {
    endedAt: '2026-01-01T00:02:00Z',
    id: 'run-2',
    purpose: 'validation_correction',
    sequence: 2,
    status: 'terminal',
    terminalKind: 'subagent_done',
  });

  db.prepare(
    `INSERT INTO events
      (id, execution_id, run_id, direction, source, kind, dedupe_key,
       processing_status, processed_at)
     VALUES
      ('event-1', 'exec-1', 'run-1', 'input', 'runtime', 'subagent_done',
       'runtime:run-1:terminal', 'processed', '2026-01-01T00:00:01Z')`,
  ).run();
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO events
            (id, execution_id, run_id, direction, source, kind, dedupe_key,
             processing_status, processed_at)
           VALUES
            ('event-2', 'exec-1', 'run-1', 'input', 'runtime', 'crashed',
             'runtime:run-1:other', 'ignored', '2026-01-01T00:00:02Z')`,
        )
        .run(),
    /UNIQUE constraint failed/,
  );

  const usage = db.prepare(
    `INSERT INTO usage_snapshots
      (session_id, run_id, snapshot_key,
       cumulative_tokens_input, cumulative_tokens_output,
       cumulative_tokens_cache_read, cumulative_tokens_cache_write,
       cumulative_tokens_total, cumulative_cost_usd_micros,
       delta_tokens_input, delta_tokens_output,
       delta_tokens_cache_read, delta_tokens_cache_write,
       delta_tokens_total, delta_cost_usd_micros)
     VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, 0, 0, ?, ?)`,
  );
  usage.run('session-1', 'run-2', 'through-2', 90, 60, 150, 140_000, 30, 20, 50, 40_000);
  // A delayed collector writes the older run after the newer one. Latest is
  // selected by run sequence, not insertion order.
  usage.run('session-1', 'run-1', 'through-1', 60, 40, 100, 100_000, 60, 40, 100, 100_000);

  assert.deepEqual(
    { ...db.prepare('SELECT tokens_total, cost_usd_micros FROM execution_usage_totals').get() },
    { cost_usd_micros: 140_000, tokens_total: 150 },
  );
  assert.deepEqual(
    {
      ...db
        .prepare('SELECT stage, tokens_total, cost_usd_micros FROM execution_usage_by_stage')
        .get(),
    },
    { cost_usd_micros: 140_000, stage: 'plan', tokens_total: 150 },
  );
  db.close();
});

test('a passed validation matches the exact valid result and has no failing checks', () => {
  const root = factoryRoot();
  const db = openStateDatabase(root, { create: true });
  addTicket(db);
  addExecution(db);
  addSession(db);
  addRun(db, {
    endedAt: '2026-01-01T00:00:00Z',
    status: 'terminal',
    terminalKind: 'subagent_done',
  });
  db.prepare(
    `UPDATE agent_runs
     SET result_status = 'valid', result_json = '{"status":"ready"}', result_hash = 'sha-result'
     WHERE id = 'run-1'`,
  ).run();
  db.prepare(
    `INSERT INTO validation_runs
      (id, execution_id, run_id, attempt, validator_version, input_hash, status)
     VALUES ('validation-1', 'exec-1', 'run-1', 1, 'v1', 'sha-result', 'running')`,
  ).run();
  db.prepare(
    `INSERT INTO validation_checks
      (validation_id, ordinal, name, kind, status)
     VALUES ('validation-1', 1, 'output contract', 'schema', 'passed')`,
  ).run();
  db.prepare(
    `UPDATE validation_runs
     SET status = 'passed', completed_at = '2026-01-01T00:00:01Z'
     WHERE id = 'validation-1'`,
  ).run();
  assert.equal(
    scalar(db, "SELECT status FROM validation_runs WHERE id = 'validation-1'"),
    'passed',
  );
  assert.throws(
    () =>
      db
        .prepare(
          "UPDATE validation_checks SET status = 'failed' WHERE validation_id = 'validation-1'",
        )
        .run(),
    /terminal validation checks are immutable/,
  );
  assert.throws(
    () => db.prepare("UPDATE agent_runs SET result_hash = 'changed' WHERE id = 'run-1'").run(),
    /validated agent result is immutable/,
  );
  assert.throws(
    () =>
      db.prepare("UPDATE validation_runs SET summary = 'changed' WHERE id = 'validation-1'").run(),
    /terminal validation is immutable/,
  );

  db.prepare(
    `INSERT INTO validation_runs
      (id, execution_id, run_id, attempt, validator_version, input_hash, status)
     VALUES ('validation-2', 'exec-1', 'run-1', 2, 'v1', 'stale-hash', 'running')`,
  ).run();
  db.prepare(
    `INSERT INTO validation_checks
      (validation_id, ordinal, name, kind, status)
     VALUES ('validation-2', 1, 'output contract', 'schema', 'passed')`,
  ).run();
  assert.throws(
    () =>
      db
        .prepare(
          `UPDATE validation_runs
           SET status = 'passed', completed_at = '2026-01-01T00:00:02Z'
           WHERE id = 'validation-2'`,
        )
        .run(),
    /validation subject does not match/,
  );
  db.close();
});

test('rolls back a failed controller transaction', () => {
  const root = factoryRoot();
  const db = openStateDatabase(root, { create: true });
  assert.throws(
    () =>
      immediateTransaction(db, () => {
        addTicket(db);
        throw new Error('stop');
      }),
    /stop/,
  );
  assert.equal(scalar(db, 'SELECT count(*) FROM tickets'), 0);
  assert.throws(() => immediateTransaction(db, async () => 42), /must be synchronous/);
  db.close();
});
