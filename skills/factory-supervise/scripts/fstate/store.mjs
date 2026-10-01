import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CliError, EXIT_INVALID, EXIT_IO, EXIT_NOT_FOUND } from "./errors.mjs";

const SCHEMA_SQL = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
const BUSY_TIMEOUT_MS = 5000;

export function stateDbPath(factoryRoot) {
  return path.join(factoryRoot, "db", "state.sqlite");
}

export function jsonStatePath(factoryRoot) {
  return path.join(factoryRoot, "FACTORY-STATE.json");
}

function nowUtc() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function emptyReview(round = null) {
  return {
    round,
    verdict: null,
    findingCount: null,
    blockingCount: null,
    updatedAt: null,
  };
}

function migrateTicket(ticket) {
  if (!ticket || typeof ticket !== "object" || Array.isArray(ticket)) {
    throw new CliError("ticket must be an object", EXIT_INVALID);
  }
  for (const key of [
    "title",
    "type",
    "source",
    "currentTask",
    "message",
    "messageAt",
    "blocker",
    "createdAt",
    "updatedAt",
    "worktree",
  ]) {
    if (!(key in ticket)) {
      ticket[key] = null;
    }
  }
  if (!ticket.tasks || typeof ticket.tasks !== "object" || Array.isArray(ticket.tasks)) {
    ticket.tasks = {};
  }
  if (!ticket.sessions || typeof ticket.sessions !== "object" || Array.isArray(ticket.sessions)) {
    ticket.sessions = {};
  }
  if (!ticket.usage || typeof ticket.usage !== "object" || Array.isArray(ticket.usage)) {
    ticket.usage = {};
  }
  for (const task of Object.values(ticket.tasks)) {
    if (!task || typeof task !== "object") {
      continue;
    }
    const oldRound = task.reviewRound;
    if ("reviewRound" in task) {
      delete task.reviewRound;
    }
    if (!task.review || typeof task.review !== "object") {
      task.review = emptyReview(typeof oldRound === "number" ? oldRound : null);
    }
    if (!("blockedBy" in task)) {
      task.blockedBy = [];
    }
    if (!("updatedAt" in task)) {
      task.updatedAt = null;
    }
    if (!("status" in task)) {
      task.status = null;
    }
    for (const key of ["artifact", "sourceRef", "verificationProfile", "evidencePath"]) {
      if (!(key in task)) {
        task[key] = null;
      }
    }
  }
  if (!Array.isArray(ticket.dependsOn)) {
    ticket.dependsOn = [];
  }
  if (!("parent" in ticket)) {
    ticket.parent = null;
  }
  if (!("kind" in ticket)) {
    ticket.kind = null;
  }
  for (const session of Object.values(ticket.sessions)) {
    if (!session || typeof session !== "object") {
      continue;
    }
    for (const key of ["round", "paneName", "context", "startedAt", "updatedAt", "task", "paneId", "model", "subagentId"]) {
      if (!(key in session)) {
        session[key] = null;
      }
    }
  }
  for (const usage of Object.values(ticket.usage)) {
    if (!usage || typeof usage !== "object") {
      continue;
    }
    for (const key of ["round", "recordedAt", "task"]) {
      if (!(key in usage)) {
        usage[key] = null;
      }
    }
  }
}

export function migrateJsonState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new CliError("state must be an object", EXIT_INVALID);
  }
  const version = state.schemaVersion;
  if (version !== 2 && version !== 3 && version !== 4) {
    throw new CliError(`unsupported schemaVersion ${version}`, EXIT_INVALID);
  }
  if (typeof state.revision !== "number" || !Number.isInteger(state.revision)) {
    throw new CliError("revision must be an integer", EXIT_INVALID);
  }
  if (!state.tickets || typeof state.tickets !== "object" || Array.isArray(state.tickets)) {
    throw new CliError("tickets must be an object", EXIT_INVALID);
  }
  if (version === 2 || version === 3) {
    state.schemaVersion = 4;
    if (!("updatedAt" in state)) {
      state.updatedAt = null;
    }
    for (const ticket of Object.values(state.tickets)) {
      migrateTicket(ticket);
    }
  }
  return state;
}

function configure(db, { readOnly = false } = {}) {
  if (!readOnly) {
    db.exec("PRAGMA journal_mode = WAL");
  }
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
}

function hasMetaTable(db) {
  return Boolean(
    db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get(),
  );
}

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function addColumn(db, table, column, ddl) {
  if (!tableColumns(db, table).has(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

function migrateSqlite(db) {
  if (!hasMetaTable(db)) {
    return;
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS ticket_depends (
      ticket_id            TEXT NOT NULL,
      depends_on_ticket_id TEXT NOT NULL,
      PRIMARY KEY (ticket_id, depends_on_ticket_id)
    );
    CREATE TABLE IF NOT EXISTS hook_runs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      revision    INTEGER,
      ticket_id   TEXT,
      task_id     TEXT,
      phase       TEXT NOT NULL CHECK (phase IN ('before','after')),
      event       TEXT NOT NULL,
      command     TEXT NOT NULL,
      exit_code   INTEGER,
      duration_ms INTEGER,
      artifact    TEXT,
      output      TEXT,
      at          TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS hook_runs_ticket ON hook_runs(ticket_id, id);
  `);
  if (tableColumns(db, "tickets").size > 0) {
    addColumn(db, "tickets", "parent_id", "parent_id TEXT");
    addColumn(db, "tickets", "kind", "kind TEXT");
  }
  if (tableColumns(db, "sessions").size > 0) {
    addColumn(db, "sessions", "subagent_id", "subagent_id TEXT");
  }
  const taskSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'").get();
  if (taskSql && !String(taskSql.sql).includes("in_review")) {
    const blocked = db.prepare("SELECT ticket_id, task_id, blocked_by_task_id FROM task_blocked_by").all();
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec(`
      CREATE TABLE tasks_v4 (
        ticket_id             TEXT NOT NULL,
        task_id               TEXT NOT NULL,
        status                TEXT CHECK (status IS NULL OR status IN ('pending','in_progress','ready_for_review','in_review','done','blocked')),
        review_round          INTEGER,
        review_verdict        TEXT CHECK (review_verdict IS NULL OR review_verdict IN ('approve','changes_requested','blocked')),
        review_finding_count  INTEGER,
        review_blocking_count INTEGER,
        review_updated_at     TEXT,
        updated_at            TEXT,
        artifact              TEXT,
        source_ref            TEXT,
        verification_profile  TEXT,
        evidence_path         TEXT,
        PRIMARY KEY (ticket_id, task_id),
        FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
      );
      INSERT INTO tasks_v4 (
        ticket_id, task_id, status, review_round, review_verdict,
        review_finding_count, review_blocking_count, review_updated_at, updated_at
      )
      SELECT
        ticket_id, task_id, status, review_round, review_verdict,
        review_finding_count, review_blocking_count, review_updated_at, updated_at
      FROM tasks;
      DROP TABLE task_blocked_by;
      DROP TABLE tasks;
      ALTER TABLE tasks_v4 RENAME TO tasks;
      CREATE TABLE task_blocked_by (
        ticket_id          TEXT NOT NULL,
        task_id            TEXT NOT NULL,
        blocked_by_task_id TEXT NOT NULL,
        PRIMARY KEY (ticket_id, task_id, blocked_by_task_id),
        FOREIGN KEY (ticket_id, task_id) REFERENCES tasks(ticket_id, task_id) ON DELETE CASCADE
      );
    `);
    const insertBlocked = db.prepare(
      "INSERT INTO task_blocked_by (ticket_id, task_id, blocked_by_task_id) VALUES (?, ?, ?)",
    );
    for (const row of blocked) {
      insertBlocked.run(row.ticket_id, row.task_id, row.blocked_by_task_id);
    }
    db.exec("PRAGMA foreign_keys = ON");
  } else if (tableColumns(db, "tasks").size > 0) {
    addColumn(db, "tasks", "artifact", "artifact TEXT");
    addColumn(db, "tasks", "source_ref", "source_ref TEXT");
    addColumn(db, "tasks", "verification_profile", "verification_profile TEXT");
    addColumn(db, "tasks", "evidence_path", "evidence_path TEXT");
  }
  setMeta(db, "schemaVersion", "4");
}

function openDatabase(dbFile, { readOnly = false, create = false } = {}) {
  if (create) {
    mkdirSync(path.dirname(dbFile), { recursive: true });
  }
  let db;
  try {
    db = new DatabaseSync(dbFile, { readOnly, timeout: BUSY_TIMEOUT_MS });
  } catch (err) {
    throw new CliError(`cannot open ${dbFile}: ${err.message}`, EXIT_IO);
  }
  try {
    configure(db, { readOnly });
    if (!readOnly && !hasMetaTable(db)) {
      db.exec(SCHEMA_SQL);
    }
    if (!readOnly) {
      migrateSqlite(db);
    }
  } catch (err) {
    db.close();
    if (err instanceof CliError) {
      throw err;
    }
    throw new CliError(`cannot initialize ${dbFile}: ${err.message}`, EXIT_IO);
  }
  return db;
}

function getMeta(db, key) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? row.value : null;
}

function setMeta(db, key, value) {
  db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value,
  );
}

function allNull(values) {
  return values.every((value) => value == null);
}

function ticketFromRow(row) {
  const source = allNull([row.source_kind, row.source_ref])
    ? null
    : { kind: row.source_kind ?? null, ref: row.source_ref ?? null };
  const worktree = allNull([
    row.worktree_path,
    row.worktree_branch,
    row.worktree_base_branch,
    row.worktree_workspace_id,
  ])
    ? null
    : {
        path: row.worktree_path ?? null,
        branch: row.worktree_branch ?? null,
        baseBranch: row.worktree_base_branch ?? null,
        workspaceId: row.worktree_workspace_id ?? null,
      };
  return {
    title: row.title ?? null,
    type: row.type ?? null,
    source,
    stage: row.stage,
    status: row.status,
    currentTask: row.current_task ?? null,
    message: row.message ?? null,
    messageAt: row.message_at ?? null,
    blocker: null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
    worktree,
    parent: row.parent_id ?? null,
    kind: row.kind ?? null,
    dependsOn: [],
    hooks: [],
    tasks: {},
    sessions: {},
    usage: {},
  };
}

function sessionFromRow(row) {
  const context = allNull([row.context_tokens, row.context_window, row.context_percent])
    ? null
    : {
        tokens: row.context_tokens ?? null,
        window: row.context_window ?? null,
        percent: row.context_percent ?? null,
      };
  return {
    stage: row.stage,
    task: row.task ?? null,
    round: row.round ?? null,
    model: row.model ?? null,
    paneId: row.pane_id ?? null,
    paneName: row.pane_name ?? null,
    sessionFile: row.session_file ?? null,
    status: row.status,
    context,
    startedAt: row.started_at ?? null,
    updatedAt: row.updated_at ?? null,
    subagentId: row.subagent_id ?? null,
  };
}

function usageFromRow(row) {
  return {
    stage: row.stage,
    task: row.task ?? null,
    round: row.round ?? null,
    model: row.model ?? null,
    throughEntryId: row.through_entry_id ?? null,
    tokens: {
      input: Number(row.tokens_input) || 0,
      output: Number(row.tokens_output) || 0,
      cacheRead: Number(row.tokens_cache_read) || 0,
      cacheWrite: Number(row.tokens_cache_write) || 0,
      total: Number(row.tokens_total) || 0,
    },
    costUsd: Number(row.cost_usd) || 0,
    recordedAt: row.recorded_at ?? null,
  };
}

export function loadSnapshot(db) {
  const schemaVersion = Number(getMeta(db, "schemaVersion") || 4);
  const revision = Number(getMeta(db, "revision") || 0);
  const updatedRaw = getMeta(db, "updatedAt");
  const updatedAt = updatedRaw ? updatedRaw : null;
  const tickets = {};
  for (const row of db.prepare("SELECT * FROM tickets").all()) {
    tickets[row.id] = ticketFromRow(row);
  }
  for (const row of db.prepare("SELECT * FROM blockers").all()) {
    const ticket = tickets[row.ticket_id];
    if (!ticket) {
      continue;
    }
    ticket.blocker = {
      reason: row.reason,
      since: row.since,
      owner: row.owner,
      ...(row.task ? { task: row.task } : {}),
    };
  }
  for (const row of db.prepare("SELECT * FROM tasks").all()) {
    const ticket = tickets[row.ticket_id];
    if (!ticket) {
      continue;
    }
    ticket.tasks[row.task_id] = {
      status: row.status ?? null,
      blockedBy: [],
      review: {
        round: row.review_round ?? null,
        verdict: row.review_verdict ?? null,
        findingCount: row.review_finding_count ?? null,
        blockingCount: row.review_blocking_count ?? null,
        updatedAt: row.review_updated_at ?? null,
      },
      updatedAt: row.updated_at ?? null,
      artifact: row.artifact ?? null,
      sourceRef: row.source_ref ?? null,
      verificationProfile: row.verification_profile ?? null,
      evidencePath: row.evidence_path ?? null,
    };
  }
  for (const row of db.prepare("SELECT * FROM task_blocked_by").all()) {
    const task = tickets[row.ticket_id]?.tasks[row.task_id];
    if (task) {
      task.blockedBy.push(row.blocked_by_task_id);
    }
  }
  for (const row of db.prepare("SELECT * FROM sessions").all()) {
    const ticket = tickets[row.ticket_id];
    if (!ticket) {
      continue;
    }
    ticket.sessions[row.session_id] = sessionFromRow(row);
  }
  for (const row of db.prepare("SELECT * FROM usage").all()) {
    const ticket = tickets[row.ticket_id];
    if (!ticket) {
      continue;
    }
    ticket.usage[row.session_id] = usageFromRow(row);
  }
  if (tableColumns(db, "ticket_depends").size > 0) {
    for (const row of db.prepare("SELECT * FROM ticket_depends").all()) {
      const ticket = tickets[row.ticket_id];
      if (ticket) {
        ticket.dependsOn.push(row.depends_on_ticket_id);
      }
    }
  }
  if (tableColumns(db, "hook_runs").size > 0) {
    for (const row of db.prepare("SELECT * FROM hook_runs ORDER BY id").all()) {
      const ticket = tickets[row.ticket_id];
      if (!ticket) {
        continue;
      }
      ticket.hooks.push({
        phase: row.phase,
        event: row.event,
        command: row.command,
        exitCode: row.exit_code ?? null,
        durationMs: row.duration_ms ?? null,
        artifact: row.artifact ?? null,
        output: row.output ?? null,
        at: row.at,
        task: row.task_id ?? null,
        revision: row.revision ?? null,
      });
    }
  }
  return { schemaVersion, revision, updatedAt, tickets };
}

function persistSnapshot(db, state) {
  db.exec("DELETE FROM tickets");
  db.exec("DELETE FROM ticket_depends");
  const insertTicket = db.prepare(`
    INSERT INTO tickets (
      id, title, type, source_kind, source_ref, stage, status, current_task,
      message, message_at, created_at, updated_at,
      worktree_path, worktree_branch, worktree_base_branch, worktree_workspace_id,
      parent_id, kind
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertTask = db.prepare(`
    INSERT INTO tasks (
      ticket_id, task_id, status, review_round, review_verdict,
      review_finding_count, review_blocking_count, review_updated_at, updated_at,
      artifact, source_ref, verification_profile, evidence_path
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertDepends = db.prepare(
    "INSERT INTO ticket_depends (ticket_id, depends_on_ticket_id) VALUES (?, ?)",
  );
  const insertBlockedBy = db.prepare(
    "INSERT INTO task_blocked_by (ticket_id, task_id, blocked_by_task_id) VALUES (?, ?, ?)",
  );
  const insertBlocker = db.prepare(
    "INSERT INTO blockers (ticket_id, reason, since, owner, task) VALUES (?, ?, ?, ?, ?)",
  );
  const insertSession = db.prepare(`
    INSERT INTO sessions (
      ticket_id, session_id, stage, task, round, model, pane_id, pane_name,
      session_file, status, context_tokens, context_window, context_percent,
      started_at, updated_at, subagent_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertUsage = db.prepare(`
    INSERT INTO usage (
      ticket_id, session_id, stage, task, round, model, through_entry_id,
      tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, tokens_total,
      cost_usd, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const [id, ticket] of Object.entries(state.tickets || {})) {
    const source = ticket.source && typeof ticket.source === "object" ? ticket.source : {};
    const worktree = ticket.worktree && typeof ticket.worktree === "object" ? ticket.worktree : {};
    insertTicket.run(
      id,
      ticket.title ?? null,
      ticket.type ?? null,
      ticket.source ? (source.kind ?? null) : null,
      ticket.source ? (source.ref ?? null) : null,
      ticket.stage,
      ticket.status,
      ticket.currentTask ?? null,
      ticket.message ?? null,
      ticket.messageAt ?? null,
      ticket.createdAt ?? null,
      ticket.updatedAt ?? null,
      ticket.worktree ? (worktree.path ?? null) : null,
      ticket.worktree ? (worktree.branch ?? null) : null,
      ticket.worktree ? (worktree.baseBranch ?? null) : null,
      ticket.worktree ? (worktree.workspaceId ?? null) : null,
      ticket.parent ?? null,
      ticket.kind ?? null,
    );
    for (const dep of Array.isArray(ticket.dependsOn) ? ticket.dependsOn : []) {
      insertDepends.run(id, dep);
    }
    if (ticket.blocker && typeof ticket.blocker === "object") {
      insertBlocker.run(
        id,
        ticket.blocker.reason,
        ticket.blocker.since,
        ticket.blocker.owner,
        ticket.blocker.task ?? null,
      );
    }
    const tasks = ticket.tasks && typeof ticket.tasks === "object" ? ticket.tasks : {};
    for (const [taskId, task] of Object.entries(tasks)) {
      if (!task || typeof task !== "object") {
        continue;
      }
      const review = task.review && typeof task.review === "object" ? task.review : {};
      insertTask.run(
        id,
        taskId,
        task.status ?? null,
        review.round ?? null,
        review.verdict ?? null,
        review.findingCount ?? null,
        review.blockingCount ?? null,
        review.updatedAt ?? null,
        task.updatedAt ?? null,
        task.artifact ?? null,
        task.sourceRef ?? null,
        task.verificationProfile ?? null,
        task.evidencePath ?? null,
      );
      for (const dep of Array.isArray(task.blockedBy) ? task.blockedBy : []) {
        insertBlockedBy.run(id, taskId, dep);
      }
    }
    const sessions = ticket.sessions && typeof ticket.sessions === "object" ? ticket.sessions : {};
    for (const [sessionId, session] of Object.entries(sessions)) {
      if (!session || typeof session !== "object") {
        continue;
      }
      const context = session.context && typeof session.context === "object" ? session.context : {};
      insertSession.run(
        id,
        sessionId,
        session.stage,
        session.task ?? null,
        session.round ?? null,
        session.model ?? null,
        session.paneId ?? null,
        session.paneName ?? null,
        session.sessionFile ?? null,
        session.status,
        session.context ? (context.tokens ?? null) : null,
        session.context ? (context.window ?? null) : null,
        session.context ? (context.percent ?? null) : null,
        session.startedAt ?? null,
        session.updatedAt ?? null,
        session.subagentId ?? null,
      );
    }
    const usage = ticket.usage && typeof ticket.usage === "object" ? ticket.usage : {};
    for (const [sessionId, record] of Object.entries(usage)) {
      if (!record || typeof record !== "object") {
        continue;
      }
      const tokens = record.tokens && typeof record.tokens === "object" ? record.tokens : {};
      insertUsage.run(
        id,
        sessionId,
        record.stage,
        record.task ?? null,
        record.round ?? null,
        record.model ?? null,
        record.throughEntryId ?? null,
        Number(tokens.input) || 0,
        Number(tokens.output) || 0,
        Number(tokens.cacheRead) || 0,
        Number(tokens.cacheWrite) || 0,
        Number(tokens.total) || 0,
        Number(record.costUsd) || 0,
        record.recordedAt ?? null,
      );
    }
  }
  setMeta(db, "schemaVersion", "4");
  setMeta(db, "storageVersion", "1");
  setMeta(db, "revision", String(state.revision));
  setMeta(db, "updatedAt", state.updatedAt ?? "");
}

function insertEvent(db, { revision, at, op, ticketId, taskId, payload }) {
  db.prepare(
    "INSERT INTO events (revision, at, op, ticket_id, task_id, payload) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(revision, at, op, ticketId ?? null, taskId ?? null, JSON.stringify(payload ?? {}));
}

function payloadFrom(extra) {
  const payload = { ...extra };
  delete payload.ticket;
  delete payload.task;
  delete payload.ok;
  delete payload.hookRuns;
  return payload;
}

function readLegacyJson(factoryRoot) {
  const dest = jsonStatePath(factoryRoot);
  let raw;
  try {
    raw = readFileSync(dest, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      return null;
    }
    throw new CliError(`cannot read ${dest}: ${err.message}`, EXIT_IO);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new CliError(`invalid JSON in ${dest}: ${err.message}`, EXIT_INVALID);
  }
}

function removeDbFiles(dbFile) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${dbFile}${suffix}`, { force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

function importJson(factoryRoot) {
  const parsed = readLegacyJson(factoryRoot);
  if (parsed === null) {
    throw new CliError("factory state not found", EXIT_NOT_FOUND);
  }
  const state = migrateJsonState(parsed);
  const dbFile = stateDbPath(factoryRoot);
  removeDbFiles(dbFile);
  const db = openDatabase(dbFile, { create: true });
  try {
    db.exec("BEGIN IMMEDIATE");
    persistSnapshot(db, state);
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore
    }
    db.close();
    removeDbFiles(dbFile);
    if (err instanceof CliError) {
      throw err;
    }
    throw new CliError(`cannot import FACTORY-STATE.json: ${err.message}`, EXIT_IO);
  }
  db.close();
}

export function openStore(factoryRoot, { create = false, readOnly = false } = {}) {
  const dbFile = stateDbPath(factoryRoot);
  if (!existsSync(dbFile)) {
    if (existsSync(jsonStatePath(factoryRoot))) {
      if (readOnly) {
        throw new CliError("factory state db not found; import FACTORY-STATE.json with fstate first", EXIT_NOT_FOUND);
      }
      importJson(factoryRoot);
    } else if (create && !readOnly) {
      return openDatabase(dbFile, { create: true });
    } else {
      return null;
    }
  }
  return openDatabase(dbFile, { readOnly, create: false });
}

export function loadState(factoryRoot) {
  const db = openStore(factoryRoot, { create: false });
  if (!db) {
    throw new CliError("factory state not found", EXIT_NOT_FOUND);
  }
  try {
    return loadSnapshot(db);
  } finally {
    db.close();
  }
}

export function mutate(factoryRoot, expectedRevision, op, fn) {
  const db = openStore(factoryRoot, { create: true });
  if (!db) {
    throw new CliError("factory state not found", EXIT_NOT_FOUND);
  }
  let began = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    began = true;
    const state = loadSnapshot(db);
    if (state.revision !== expectedRevision) {
      throw new CliError(
        `revision mismatch: expected ${expectedRevision}, current ${state.revision}`,
        EXIT_INVALID,
      );
    }
    const ts = nowUtc();
    const extra = fn(state, ts) || {};
    state.revision += 1;
    state.updatedAt = ts;
    persistSnapshot(db, state);
    insertEvent(db, {
      revision: state.revision,
      at: ts,
      op,
      ticketId: extra.ticket ?? null,
      taskId: extra.task ?? null,
      payload: payloadFrom(extra),
    });
    if (Array.isArray(extra.hookRuns)) {
      const insertHook = db.prepare(`
        INSERT INTO hook_runs (
          revision, ticket_id, task_id, phase, event, command, exit_code,
          duration_ms, artifact, output, at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const run of extra.hookRuns) {
        insertHook.run(
          state.revision,
          extra.ticket ?? null,
          extra.task ?? run.task ?? null,
          run.phase,
          run.event,
          run.command,
          run.exitCode ?? null,
          run.durationMs ?? null,
          run.artifact ?? null,
          run.output ?? null,
          run.at ?? ts,
        );
      }
    }
    db.exec("COMMIT");
    began = false;
    return { ok: true, revision: state.revision, ...extra };
  } catch (err) {
    if (began) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // ignore
      }
    }
    throw err;
  } finally {
    db.close();
  }
}

export function listEvents(db, afterRevision) {
  return db.prepare(
    "SELECT revision, at, op, ticket_id, task_id, payload FROM events WHERE revision > ? ORDER BY revision",
  ).all(afterRevision);
}

export function readMeta(db) {
  return {
    schemaVersion: Number(getMeta(db, "schemaVersion") || 4),
    revision: Number(getMeta(db, "revision") || 0),
    updatedAt: getMeta(db, "updatedAt") || null,
    storageVersion: Number(getMeta(db, "storageVersion") || 1),
  };
}
