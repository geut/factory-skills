import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  actionId,
  attentionId,
  executionId,
  replyId,
  runId,
  sessionId,
  taskId,
  ticketId,
  type ActionId,
  type ActionRecord,
  type AttentionRecord,
  type ControllerEvent,
  type ControllerResponse,
  type ExecutionId,
  type ExecutionRecord,
  type FactorySnapshot,
  type IdSource,
  type Policy,
  type ReplyRecord,
  type RunId,
  type RunRecord,
  type SessionRecord,
  type Stage,
  type TaskRecord,
  type TicketRecord,
  type UsageTotals,
  type UsageWrite,
  type WorktreeStatus,
} from '../domain.ts';
import { FactoryDatabaseError, immediateTransaction } from '../state/database.ts';
import { describeExisting, reduce } from './reduce.ts';

type ApplySource = 'command' | 'runtime' | 'action' | 'validator' | 'controller';

export type ApplyResult = {
  armRunId: RunId | null;
  response: ControllerResponse;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function row(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new FactoryDatabaseError('expected a database row');
  }
  return value;
}

function text(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new FactoryDatabaseError(`${key} must be text`);
  }
  return value;
}

function nullableText(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new FactoryDatabaseError(`${key} must be text`);
  }
  return value;
}

function integer(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new FactoryDatabaseError(`${key} must be an integer`);
  }
  return value;
}

function flag(record: Record<string, unknown>, key: string): boolean {
  return integer(record, key) === 1;
}

function jsonText(value: unknown): string {
  return JSON.stringify(value);
}

function parsePolicy(raw: string): Policy {
  const value: unknown = JSON.parse(raw);
  if (
    !isRecord(value) ||
    typeof value['codeRoot'] !== 'string' ||
    !isRecord(value['models']) ||
    !isRecord(value['limits'])
  ) {
    throw new FactoryDatabaseError('execution policy is invalid');
  }
  const models = value['models'];
  const limits = value['limits'];
  if (
    typeof models['plan'] !== 'string' ||
    typeof models['work'] !== 'string' ||
    typeof models['review'] !== 'string' ||
    typeof limits['planCorrections'] !== 'number' ||
    typeof limits['infrastructureRetries'] !== 'number'
  ) {
    throw new FactoryDatabaseError('execution policy is invalid');
  }
  return {
    codeRoot: value['codeRoot'],
    limits: {
      infrastructureRetries: limits['infrastructureRetries'],
      planCorrections: limits['planCorrections'],
    },
    models: { plan: models['plan'], review: models['review'], work: models['work'] },
  };
}

function parseTicketPayload(
  raw: string,
  fallbackTitle: string,
): { body: string; commandRef: string; displayRef: string } {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)) {
    throw new FactoryDatabaseError('ticket payload is invalid');
  }
  return {
    body: typeof value['body'] === 'string' ? value['body'] : '',
    commandRef: typeof value['commandRef'] === 'string' ? value['commandRef'] : fallbackTitle,
    displayRef: typeof value['displayRef'] === 'string' ? value['displayRef'] : fallbackTitle,
  };
}

function oneOf<T extends string>(value: string, allowed: ReadonlyArray<T>, label: string): T {
  for (const item of allowed) {
    if (item === value) {
      return item;
    }
  }
  throw new FactoryDatabaseError(`unknown ${label} ${value}`);
}

function optionalOneOf<T extends string>(
  value: string | null,
  allowed: ReadonlyArray<T>,
  label: string,
): T | null {
  if (value === null) {
    return null;
  }
  return oneOf(value, allowed, label);
}

const taskStatuses = [
  'pending',
  'working',
  'ready_for_review',
  'reviewing',
  'done',
  'blocked',
  'cancelled',
] as const;
const sessionStatuses = ['prepared', 'open', 'completed', 'abandoned'] as const;
const runPurposes = [
  'initial',
  'validation_correction',
  'human_reply',
  'review_changes',
  'manual_continue',
  'infrastructure_retry',
] as const;
const resultStatuses = ['pending', 'valid', 'invalid'] as const;
const runStatuses = ['prepared', 'starting', 'running', 'terminal'] as const;
const terminalKinds = [
  'subagent_done',
  'caller_ping',
  'launch_failed',
  'crashed',
  'completed_user_exit',
  'pane_killed',
  'gap_exit',
  'cancelled',
] as const;
const attentionKinds = ['agent_question', 'policy_limit', 'manual_approval'] as const;
const attentionStatuses = ['open', 'answered', 'resuming', 'resolved', 'cancelled'] as const;
const actionStatuses = ['pending', 'leased', 'succeeded', 'failed', 'cancelled'] as const;

function stage(value: string): Stage {
  if (
    value === 'plan' ||
    value === 'work' ||
    value === 'review' ||
    value === 'wrapup' ||
    value === 'done'
  ) {
    return value;
  }
  throw new FactoryDatabaseError(`unknown stage ${value}`);
}

function worktreeStatus(value: string | null): WorktreeStatus | null {
  if (value === null) {
    return null;
  }
  if (value === 'preparing' || value === 'ready' || value === 'removed' || value === 'failed') {
    return value;
  }
  throw new FactoryDatabaseError(`unknown worktree status ${value}`);
}

function loadExecutionRow(db: DatabaseSync, execution: ExecutionId): FactorySnapshot | null {
  const executionRow = db
    .prepare('SELECT * FROM ticket_executions WHERE id = ? AND is_current = 1')
    .get(execution);
  if (executionRow === undefined) {
    return null;
  }
  const executionRecord = row(executionRow);
  const ticketRow = db
    .prepare('SELECT * FROM tickets WHERE id = ?')
    .get(text(executionRecord, 'ticket_id'));
  if (ticketRow === undefined) {
    return null;
  }
  return hydrate(db, row(ticketRow), executionRecord);
}

export function loadCurrentByTicketKey(db: DatabaseSync, key: string): FactorySnapshot | null {
  const found = db
    .prepare(
      `SELECT t.id AS id
       FROM tickets AS t
       WHERE t.id = ?
          OR t.source_ref = ?
          OR json_extract(t.source_payload, '$.displayRef') = ?
          OR json_extract(t.source_payload, '$.commandRef') = ?
       LIMIT 1`,
    )
    .get(key, key, key, key);
  if (found === undefined) {
    return null;
  }
  const ticket = text(row(found), 'id');
  const executionRow = db
    .prepare('SELECT id FROM ticket_executions WHERE ticket_id = ? AND is_current = 1')
    .get(ticket);
  if (executionRow === undefined) {
    return null;
  }
  return loadExecutionRow(db, executionId(text(row(executionRow), 'id')));
}

function hydrate(
  db: DatabaseSync,
  ticketRow: Record<string, unknown>,
  executionRow: Record<string, unknown>,
): FactorySnapshot {
  const payload = parseTicketPayload(text(ticketRow, 'source_payload'), text(ticketRow, 'id'));
  const execution = executionId(text(executionRow, 'id'));
  const ticket: TicketRecord = {
    body: payload.body,
    commandRef: payload.commandRef,
    displayRef: payload.displayRef,
    id: ticketId(text(ticketRow, 'id')),
    sourceHash: nullableText(ticketRow, 'source_hash') ?? '',
    sourceKind: text(ticketRow, 'source_kind'),
    sourceRef: nullableText(ticketRow, 'source_ref') ?? '',
    title: nullableText(ticketRow, 'title') ?? payload.displayRef,
  };
  const executionRecord: ExecutionRecord = {
    factoryDir: text(executionRow, 'factory_dir'),
    generation: integer(executionRow, 'generation'),
    id: execution,
    inputFetchedAt: nullableText(executionRow, 'input_fetched_at') ?? '',
    inputHash: nullableText(executionRow, 'input_hash') ?? '',
    inputJson: nullableText(executionRow, 'input_json') ?? '{}',
    message: nullableText(executionRow, 'message'),
    planPath: nullableText(executionRow, 'plan_path'),
    policy: parsePolicy(text(executionRow, 'policy_json')),
    retryable: flag(executionRow, 'retryable'),
    stage: stage(text(executionRow, 'stage')),
    status: executionStatus(text(executionRow, 'status')),
    statusReason: nullableText(executionRow, 'status_reason'),
    statusReasonCode: nullableText(executionRow, 'status_reason_code'),
    ticketId: ticket.id,
    version: integer(executionRow, 'version'),
    worktreeBaseBranch: nullableText(executionRow, 'worktree_base_branch'),
    worktreeBaseSha: nullableText(executionRow, 'worktree_base_sha'),
    worktreeBranch: nullableText(executionRow, 'worktree_branch'),
    worktreePath: nullableText(executionRow, 'worktree_path'),
    worktreeStatus: worktreeStatus(nullableText(executionRow, 'worktree_status')),
  };
  return {
    actions: loadActions(db, execution),
    attention: loadAttention(db, execution),
    execution: executionRecord,
    replies: loadReplies(db, execution),
    runs: loadRuns(db, execution),
    sessions: loadSessions(db, execution),
    tasks: loadTasks(db, execution),
    ticket,
  };
}

function executionStatus(value: string): ExecutionRecord['status'] {
  switch (value) {
    case 'queued':
    case 'active':
    case 'waiting_for_user':
    case 'paused':
    case 'resuming':
    case 'resume_failed':
    case 'failed':
    case 'ready_for_handoff':
    case 'complete':
    case 'cancelled':
      return value;
    default:
      throw new FactoryDatabaseError(`unknown execution status ${value}`);
  }
}

function loadTasks(db: DatabaseSync, execution: ExecutionId): Array<TaskRecord> {
  const rows = db
    .prepare('SELECT * FROM tasks WHERE execution_id = ? ORDER BY ordinal')
    .all(execution);
  return rows.map((item) => {
    const record = row(item);
    const id = taskId(text(record, 'task_id'));
    const deps = db
      .prepare(
        'SELECT depends_on_task_id FROM task_dependencies WHERE execution_id = ? AND task_id = ? ORDER BY depends_on_task_id',
      )
      .all(execution, id);
    return {
      blockedBy: deps.map((dep) => taskId(text(row(dep), 'depends_on_task_id'))),
      ordinal: integer(record, 'ordinal'),
      specHash: nullableText(record, 'spec_hash'),
      status: oneOf(text(record, 'status'), taskStatuses, 'task status'),
      taskFile: text(record, 'task_file'),
      taskId: id,
      title: nullableText(record, 'title') ?? id,
    };
  });
}

function loadSessions(db: DatabaseSync, execution: ExecutionId): Array<SessionRecord> {
  return db
    .prepare('SELECT * FROM agent_sessions WHERE execution_id = ? ORDER BY created_at')
    .all(execution)
    .map((item) => {
      const record = row(item);
      const task = nullableText(record, 'task_id');
      const stageName = text(record, 'stage');
      if (
        stageName !== 'plan' &&
        stageName !== 'work' &&
        stageName !== 'review' &&
        stageName !== 'wrapup'
      ) {
        throw new FactoryDatabaseError(`unknown session stage ${stageName}`);
      }
      return {
        id: sessionId(text(record, 'id')),
        logicalKey: text(record, 'logical_key'),
        model: text(record, 'model'),
        piSessionId: nullableText(record, 'pi_session_id'),
        sessionFile: nullableText(record, 'session_file'),
        stage: stageName,
        status: oneOf(text(record, 'status'), sessionStatuses, 'session status'),
        taskId: task === null ? null : taskId(task),
        thinking: nullableText(record, 'thinking') ?? 'medium',
      };
    });
}

function loadRuns(db: DatabaseSync, execution: ExecutionId): Array<RunRecord> {
  return db
    .prepare('SELECT * FROM agent_runs WHERE execution_id = ? ORDER BY created_at')
    .all(execution)
    .map((item) => {
      const record = row(item);
      const parent = nullableText(record, 'parent_run_id');
      return {
        description: descriptionFromLifecycle(nullableText(record, 'lifecycle_json')),
        endedAt: nullableText(record, 'ended_at'),
        id: runId(text(record, 'id')),
        inputHash: nullableText(record, 'input_hash'),
        paneId: nullableText(record, 'pane_id'),
        paneName: nullableText(record, 'pane_name'),
        parentRunId: parent === null ? null : runId(parent),
        purpose: oneOf(text(record, 'purpose'), runPurposes, 'run purpose'),
        resultContract: nullableText(record, 'result_contract'),
        resultError: nullableText(record, 'result_error'),
        resultHash: nullableText(record, 'result_hash'),
        resultJson: nullableText(record, 'result_json'),
        resultStatus: oneOf(text(record, 'result_status'), resultStatuses, 'result status'),
        semanticRound: integer(record, 'semantic_round'),
        sequence: integer(record, 'sequence'),
        sessionId: sessionId(text(record, 'session_id')),
        startedAt: nullableText(record, 'started_at'),
        status: oneOf(text(record, 'status'), runStatuses, 'run status'),
        subagentId: nullableText(record, 'subagent_id'),
        terminalKind: optionalOneOf(
          nullableText(record, 'terminal_kind'),
          terminalKinds,
          'terminal kind',
        ),
      };
    });
}

function loadAttention(db: DatabaseSync, execution: ExecutionId): Array<AttentionRecord> {
  return db
    .prepare('SELECT * FROM attention_requests WHERE execution_id = ? ORDER BY created_at')
    .all(execution)
    .map((item) => {
      const record = row(item);
      const run = nullableText(record, 'run_id');
      return {
        id: attentionId(text(record, 'id')),
        kind: oneOf(text(record, 'kind'), attentionKinds, 'attention kind'),
        question: text(record, 'question'),
        runId: run === null ? null : runId(run),
        status: oneOf(text(record, 'status'), attentionStatuses, 'attention status'),
      };
    });
}

function loadReplies(db: DatabaseSync, execution: ExecutionId): Array<ReplyRecord> {
  return db
    .prepare(
      `SELECT r.*
       FROM attention_replies AS r
       JOIN attention_requests AS q ON q.id = r.request_id
       WHERE q.execution_id = ?
       ORDER BY r.created_at`,
    )
    .all(execution)
    .map((item) => {
      const record = row(item);
      return {
        answer: text(record, 'answer'),
        answerHash: text(record, 'answer_hash'),
        id: replyId(text(record, 'id')),
        idempotencyKey: text(record, 'idempotency_key'),
        isCurrent: flag(record, 'is_current'),
        requestId: attentionId(text(record, 'request_id')),
        version: integer(record, 'version'),
      };
    });
}

function loadActions(db: DatabaseSync, execution: ExecutionId): Array<ActionRecord> {
  return db
    .prepare('SELECT * FROM actions WHERE execution_id = ? ORDER BY created_at')
    .all(execution)
    .map((item) => actionFromRow(row(item)));
}

function actionFromRow(record: Record<string, unknown>): ActionRecord {
  const payload: unknown = JSON.parse(text(record, 'payload_json'));
  if (!isRecord(payload)) {
    throw new FactoryDatabaseError('action payload is invalid');
  }
  const base = {
    attempts: integer(record, 'attempts'),
    id: actionId(text(record, 'id')),
    idempotencyKey: text(record, 'idempotency_key'),
    lastError: nullableText(record, 'last_error'),
    maxAttempts: integer(record, 'max_attempts'),
    retryOfActionId:
      nullableText(record, 'retry_of_action_id') === null
        ? null
        : actionId(text(record, 'retry_of_action_id')),
    status: oneOf(text(record, 'status'), actionStatuses, 'action status'),
  };
  const kind = text(record, 'kind');
  const run = nullableText(record, 'run_id');
  const attention = nullableText(record, 'attention_request_id');
  const reply = nullableText(record, 'attention_reply_id');
  if (
    kind === 'launch_run' &&
    run !== null &&
    typeof payload['prompt'] === 'string' &&
    typeof payload['cwd'] === 'string'
  ) {
    const mode = payload['mode'];
    if (mode !== 'launch' && mode !== 'resume') {
      throw new FactoryDatabaseError('launch mode is invalid');
    }
    return {
      ...base,
      attentionReplyId: null,
      attentionRequestId: null,
      cwd: payload['cwd'],
      kind,
      mode,
      prompt: payload['prompt'],
      runId: runId(run),
    };
  }
  if (
    kind === 'resume_run' &&
    run !== null &&
    attention !== null &&
    reply !== null &&
    typeof payload['prompt'] === 'string' &&
    typeof payload['cwd'] === 'string'
  ) {
    return {
      ...base,
      attentionReplyId: replyId(reply),
      attentionRequestId: attentionId(attention),
      cwd: payload['cwd'],
      kind,
      prompt: payload['prompt'],
      runId: runId(run),
    };
  }
  if (kind === 'validate_run' && run !== null) {
    return { ...base, attentionReplyId: null, attentionRequestId: null, kind, runId: runId(run) };
  }
  if (kind === 'prepare_worktree' && typeof payload['slug'] === 'string') {
    return {
      ...base,
      attentionReplyId: null,
      attentionRequestId: null,
      kind,
      runId: null,
      slug: payload['slug'],
    };
  }
  if (kind === 'notify_attention' && attention !== null && typeof payload['message'] === 'string') {
    return {
      ...base,
      attentionReplyId: null,
      attentionRequestId: attentionId(attention),
      kind,
      message: payload['message'],
      runId: null,
    };
  }
  throw new FactoryDatabaseError(`unsupported action ${kind}`);
}

function payloadJson(action: ActionRecord): string {
  switch (action.kind) {
    case 'launch_run':
      return jsonText({ cwd: action.cwd, mode: action.mode, prompt: action.prompt });
    case 'resume_run':
      return jsonText({ cwd: action.cwd, prompt: action.prompt });
    case 'validate_run':
      return '{}';
    case 'prepare_worktree':
      return jsonText({ slug: action.slug });
    case 'notify_attention':
      return jsonText({ message: action.message });
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function insertTicket(db: DatabaseSync, snapshot: FactorySnapshot, now: string): void {
  db.prepare(
    `INSERT INTO tickets
      (id, title, source_kind, source_ref, source_payload, source_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    snapshot.ticket.id,
    snapshot.ticket.title,
    snapshot.ticket.sourceKind,
    snapshot.ticket.sourceRef,
    jsonText({
      body: snapshot.ticket.body,
      commandRef: snapshot.ticket.commandRef,
      displayRef: snapshot.ticket.displayRef,
      title: snapshot.ticket.title,
    }),
    snapshot.ticket.sourceHash,
    now,
    now,
  );
}

function insertExecution(db: DatabaseSync, snapshot: FactorySnapshot, now: string): void {
  const execution = snapshot.execution;
  db.prepare(
    `INSERT INTO ticket_executions
      (id, ticket_id, generation, stage, status, version, status_reason_code, status_reason,
       retryable, policy_json, input_json, input_hash, input_fetched_at, factory_dir, plan_path,
       worktree_path, worktree_branch, worktree_base_branch, worktree_status, worktree_base_sha,
       message, message_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    execution.id,
    execution.ticketId,
    execution.generation,
    execution.stage,
    execution.status,
    execution.version,
    execution.statusReasonCode,
    execution.statusReason,
    execution.retryable ? 1 : 0,
    jsonText(execution.policy),
    execution.inputJson,
    execution.inputHash,
    execution.inputFetchedAt,
    execution.factoryDir,
    execution.planPath,
    execution.worktreePath,
    execution.worktreeBranch,
    execution.worktreeBaseBranch,
    execution.worktreeStatus,
    execution.worktreeBaseSha,
    execution.message,
    now,
    now,
    now,
  );
}

function updateExecution(
  db: DatabaseSync,
  before: ExecutionRecord,
  after: ExecutionRecord,
  now: string,
): void {
  const result = db
    .prepare(
      `UPDATE ticket_executions
       SET stage = ?, status = ?, version = ?, status_reason_code = ?, status_reason = ?,
           retryable = ?, plan_path = ?, worktree_path = ?, worktree_branch = ?,
           worktree_base_branch = ?, worktree_status = ?, worktree_base_sha = ?,
           message = ?, message_at = ?, updated_at = ?
       WHERE id = ? AND version = ?`,
    )
    .run(
      after.stage,
      after.status,
      after.version,
      after.statusReasonCode,
      after.statusReason,
      after.retryable ? 1 : 0,
      after.planPath,
      after.worktreePath,
      after.worktreeBranch,
      after.worktreeBaseBranch,
      after.worktreeStatus,
      after.worktreeBaseSha,
      after.message,
      now,
      now,
      after.id,
      before.version,
    );
  if (result.changes !== 1) {
    throw new FactoryDatabaseError('execution version conflict');
  }
}

function insertTask(db: DatabaseSync, execution: ExecutionId, task: TaskRecord, now: string): void {
  db.prepare(
    `INSERT INTO tasks
      (execution_id, task_id, ordinal, title, task_file, spec_hash, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    execution,
    task.taskId,
    task.ordinal,
    task.title,
    task.taskFile,
    task.specHash,
    task.status,
    now,
    now,
  );
  for (const dep of task.blockedBy) {
    db.prepare(
      `INSERT INTO task_dependencies (execution_id, task_id, depends_on_task_id) VALUES (?, ?, ?)`,
    ).run(execution, task.taskId, dep);
  }
}

function insertSession(
  db: DatabaseSync,
  execution: ExecutionId,
  session: SessionRecord,
  now: string,
): void {
  db.prepare(
    `INSERT INTO agent_sessions
      (id, execution_id, logical_key, stage, task_id, model, thinking, pi_session_id, session_file, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    session.id,
    execution,
    session.logicalKey,
    session.stage,
    session.taskId,
    session.model,
    session.thinking,
    session.piSessionId,
    session.sessionFile,
    session.status,
    now,
    now,
  );
}

function lifecycleJson(description: string | null): string | null {
  if (description === null) {
    return null;
  }
  return JSON.stringify({ description });
}

function descriptionFromLifecycle(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && typeof parsed['description'] === 'string') {
      return parsed['description'];
    }
  } catch {
    return null;
  }
  return null;
}

function insertRun(db: DatabaseSync, execution: ExecutionId, run: RunRecord, now: string): void {
  db.prepare(
    `INSERT INTO agent_runs
      (id, execution_id, session_id, sequence, parent_run_id, purpose, semantic_round, status,
       terminal_kind, subagent_id, pane_id, pane_name, input_hash, result_contract, result_status,
       result_json, result_hash, result_error, lifecycle_json, created_at, started_at, updated_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    run.id,
    execution,
    run.sessionId,
    run.sequence,
    run.parentRunId,
    run.purpose,
    run.semanticRound,
    run.status,
    run.terminalKind,
    run.subagentId,
    run.paneId,
    run.paneName,
    run.inputHash,
    run.resultContract,
    run.resultStatus,
    run.resultJson,
    run.resultHash,
    run.resultError,
    lifecycleJson(run.description),
    now,
    run.startedAt,
    now,
    run.endedAt,
  );
}

function updateRun(db: DatabaseSync, run: RunRecord, now: string): void {
  db.prepare(
    `UPDATE agent_runs
     SET status = ?, terminal_kind = ?, ended_at = ?, pane_id = ?, pane_name = ?, subagent_id = ?,
         result_contract = ?, result_status = ?, result_json = ?, result_hash = ?, result_error = ?,
         lifecycle_json = ?, started_at = ?, updated_at = ?
     WHERE id = ? AND status <> 'terminal'`,
  ).run(
    run.status,
    run.terminalKind,
    run.endedAt,
    run.paneId,
    run.paneName,
    run.subagentId,
    run.resultContract,
    run.resultStatus,
    run.resultJson,
    run.resultHash,
    run.resultError,
    lifecycleJson(run.description),
    run.startedAt,
    now,
    run.id,
  );
}

function insertAttention(
  db: DatabaseSync,
  execution: ExecutionId,
  attention: AttentionRecord,
  now: string,
): void {
  db.prepare(
    `INSERT INTO attention_requests
      (id, execution_id, run_id, kind, status, question, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    attention.id,
    execution,
    attention.runId,
    attention.kind,
    attention.status,
    attention.question,
    now,
  );
}

function updateAttention(db: DatabaseSync, attention: AttentionRecord, now: string): void {
  db.prepare(
    `UPDATE attention_requests
     SET status = ?,
         answered_at = CASE WHEN ? = 'resuming' AND answered_at IS NULL THEN ? ELSE answered_at END,
         resolved_at = CASE WHEN ? = 'resolved' AND resolved_at IS NULL THEN ? ELSE resolved_at END
     WHERE id = ?`,
  ).run(attention.status, attention.status, now, attention.status, now, attention.id);
}

function insertReply(db: DatabaseSync, reply: ReplyRecord, now: string): void {
  db.prepare(
    `INSERT INTO attention_replies
      (id, request_id, version, answer, answer_hash, idempotency_key, is_current, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    reply.id,
    reply.requestId,
    reply.version,
    reply.answer,
    reply.answerHash,
    reply.idempotencyKey,
    reply.isCurrent ? 1 : 0,
    now,
  );
}

function insertAction(
  db: DatabaseSync,
  execution: ExecutionId,
  action: ActionRecord,
  now: string,
): void {
  db.prepare(
    `INSERT INTO actions
      (id, execution_id, run_id, attention_request_id, attention_reply_id, retry_of_action_id,
       kind, status, idempotency_key, payload_json, attempts, max_attempts, last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    action.id,
    execution,
    action.runId,
    action.attentionRequestId,
    action.attentionReplyId,
    action.retryOfActionId,
    action.kind,
    action.status,
    action.idempotencyKey,
    payloadJson(action),
    action.attempts,
    action.maxAttempts,
    action.lastError,
    now,
    now,
  );
}

function updateAction(db: DatabaseSync, action: ActionRecord, now: string): void {
  const terminal =
    action.status === 'succeeded' || action.status === 'failed' || action.status === 'cancelled';
  db.prepare(
    `UPDATE actions
     SET status = ?, attempts = ?, last_error = ?,
         lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
         completed_at = ?, updated_at = ?
     WHERE id = ? AND status IN ('pending', 'leased')`,
  ).run(action.status, action.attempts, action.lastError, terminal ? now : null, now, action.id);
}

function insertUsage(db: DatabaseSync, usage: UsageWrite, now: string): void {
  const previous = db
    .prepare(
      `SELECT u.cumulative_tokens_input AS input,
              u.cumulative_tokens_output AS output,
              u.cumulative_tokens_cache_read AS cache_read,
              u.cumulative_tokens_cache_write AS cache_write,
              u.cumulative_tokens_total AS total,
              u.cumulative_cost_usd_micros AS cost
       FROM usage_snapshots AS u
       JOIN agent_runs AS r ON r.id = u.run_id
       WHERE r.session_id = ?
       ORDER BY r.sequence DESC
       LIMIT 1`,
    )
    .get(usage.sessionId);
  const prior = previous === undefined ? null : row(previous);
  const delta = (current: number, key: string): number => {
    const before = prior === null ? 0 : integer(prior, key);
    return Math.max(0, current - before);
  };
  const cumulative: UsageTotals = usage.cumulative;
  db.prepare(
    `INSERT INTO usage_snapshots
      (session_id, run_id, snapshot_key,
       cumulative_tokens_input, cumulative_tokens_output, cumulative_tokens_cache_read,
       cumulative_tokens_cache_write, cumulative_tokens_total, cumulative_cost_usd_micros,
       delta_tokens_input, delta_tokens_output, delta_tokens_cache_read, delta_tokens_cache_write,
       delta_tokens_total, delta_cost_usd_micros, context_tokens, context_window, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    usage.sessionId,
    usage.runId,
    usage.runId,
    cumulative.inputTokens,
    cumulative.outputTokens,
    cumulative.cacheReadTokens,
    cumulative.cacheWriteTokens,
    cumulative.totalTokens,
    cumulative.costUsdMicros,
    delta(cumulative.inputTokens, 'input'),
    delta(cumulative.outputTokens, 'output'),
    delta(cumulative.cacheReadTokens, 'cache_read'),
    delta(cumulative.cacheWriteTokens, 'cache_write'),
    delta(cumulative.totalTokens, 'total'),
    delta(cumulative.costUsdMicros, 'cost'),
    cumulative.contextTokens,
    cumulative.contextWindow,
    now,
  );
}

function persist(
  db: DatabaseSync,
  before: FactorySnapshot | null,
  after: FactorySnapshot,
  usage: UsageWrite | null,
  now: string,
): void {
  if (before === null) {
    insertTicket(db, after, now);
  }
  if (before === null) {
    insertExecution(db, after, now);
  } else if (!same(before.execution, after.execution)) {
    updateExecution(db, before.execution, after.execution, now);
  }

  for (const task of after.tasks) {
    const previous = before?.tasks.find((item) => item.taskId === task.taskId) ?? null;
    if (previous === null) {
      insertTask(db, after.execution.id, task, now);
    } else if (previous.status !== task.status) {
      db.prepare(
        'UPDATE tasks SET status = ?, updated_at = ? WHERE execution_id = ? AND task_id = ?',
      ).run(task.status, now, after.execution.id, task.taskId);
    }
  }
  for (const session of after.sessions) {
    const previous = before?.sessions.find((item) => item.id === session.id) ?? null;
    if (previous === null) {
      insertSession(db, after.execution.id, session, now);
    } else if (!same(previous, session)) {
      db.prepare(
        `UPDATE agent_sessions
         SET status = ?, pi_session_id = ?, session_file = ?, updated_at = ?
         WHERE id = ?`,
      ).run(session.status, session.piSessionId, session.sessionFile, now, session.id);
    }
  }
  for (const run of after.runs) {
    const previous = before?.runs.find((item) => item.id === run.id) ?? null;
    if (previous === null) {
      insertRun(db, after.execution.id, run, now);
    } else if (!same(previous, run)) {
      updateRun(db, run, now);
    }
  }
  for (const attention of after.attention) {
    const previous = before?.attention.find((item) => item.id === attention.id) ?? null;
    if (previous === null) {
      insertAttention(db, after.execution.id, attention, now);
    } else if (!same(previous, attention)) {
      updateAttention(db, attention, now);
    }
  }
  for (const reply of after.replies) {
    const previous = before?.replies.find((item) => item.id === reply.id) ?? null;
    if (previous !== null && previous.isCurrent !== reply.isCurrent) {
      db.prepare('UPDATE attention_replies SET is_current = ? WHERE id = ?').run(
        reply.isCurrent ? 1 : 0,
        reply.id,
      );
    }
  }
  for (const reply of after.replies) {
    if (before?.replies.some((item) => item.id === reply.id)) {
      continue;
    }
    insertReply(db, reply, now);
  }
  for (const action of after.actions) {
    const previous = before?.actions.find((item) => item.id === action.id) ?? null;
    if (previous === null) {
      insertAction(db, after.execution.id, action, now);
    } else if (!same(previous, action)) {
      updateAction(db, action, now);
    }
  }
  if (usage !== null) {
    insertUsage(db, usage, now);
  }
}

function snapshotForEvent(db: DatabaseSync, event: ControllerEvent): FactorySnapshot | null {
  switch (event.kind) {
    case 'start':
      return loadCurrentByTicketKey(db, event.ticket.id);
    case 'reply':
    case 'retry':
      return loadCurrentByTicketKey(db, event.ticketId);
    case 'runtime_terminal':
    case 'validation_finished':
    case 'run_started':
    case 'launch_failed':
    case 'reconciled':
      return loadByRun(db, event.runId);
    case 'worktree_ready':
    case 'worktree_failed':
      return loadByAction(db, event.actionId);
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

function loadByRun(db: DatabaseSync, id: RunId): FactorySnapshot | null {
  const found = db.prepare('SELECT execution_id FROM agent_runs WHERE id = ?').get(id);
  if (found === undefined) {
    return null;
  }
  return loadExecutionRow(db, executionId(text(row(found), 'execution_id')));
}

function loadByAction(db: DatabaseSync, id: ActionId): FactorySnapshot | null {
  const found = db.prepare('SELECT execution_id FROM actions WHERE id = ?').get(id);
  if (found === undefined) {
    return null;
  }
  return loadExecutionRow(db, executionId(text(row(found), 'execution_id')));
}

function eventRunId(event: ControllerEvent): string | null {
  switch (event.kind) {
    case 'runtime_terminal':
    case 'validation_finished':
    case 'run_started':
    case 'launch_failed':
    case 'reconciled':
      return event.runId;
    case 'start':
    case 'reply':
    case 'retry':
    case 'worktree_ready':
    case 'worktree_failed':
      return null;
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

function insertInputEvent(
  db: DatabaseSync,
  input: {
    dedupeKey: string;
    executionId: ExecutionId | null;
    failed: boolean;
    id: string;
    kind: string;
    now: string;
    runId: string | null;
    source: ApplySource;
  },
): void {
  db.prepare(
    `INSERT INTO events
      (id, execution_id, run_id, direction, source, kind, dedupe_key, payload_json, processing_status, processed_at)
     VALUES (?, ?, ?, 'input', ?, ?, ?, '{}', ?, ?)`,
  ).run(
    input.id,
    input.executionId,
    input.runId,
    input.source,
    input.kind,
    input.dedupeKey,
    input.failed ? 'failed' : 'processed',
    input.now,
  );
}

export function applyControllerEvent(
  db: DatabaseSync,
  input: {
    dedupeKey: string;
    event: ControllerEvent;
    ids: IdSource;
    now: string;
    prepare?: (database: DatabaseSync) => void;
    source: ApplySource;
  },
): ApplyResult {
  return immediateTransaction(db, () => {
    const duplicate = db.prepare('SELECT 1 FROM events WHERE dedupe_key = ?').get(input.dedupeKey);
    const current = snapshotForEvent(db, input.event);
    if (duplicate !== undefined) {
      if (current === null) {
        return {
          armRunId: null,
          response: { kind: 'rejected', message: 'Duplicate event has no execution.' },
        };
      }
      return { armRunId: null, response: describeExisting(current) };
    }
    input.prepare?.(db);
    const reduction = reduce({
      event: input.event,
      ids: input.ids,
      now: input.now,
      snapshot: current,
    });
    if (reduction.changed && reduction.snapshot !== null) {
      persist(db, current, reduction.snapshot, reduction.usage, input.now);
    }
    if (reduction.response.kind === 'status') {
      insertInputEvent(db, {
        dedupeKey: input.dedupeKey,
        executionId: reduction.snapshot?.execution.id ?? current?.execution.id ?? null,
        failed: false,
        id: input.ids.event(),
        kind: input.event.kind,
        now: input.now,
        runId: eventRunId(input.event),
        source: input.source,
      });
    }
    return { armRunId: reduction.armRunId, response: reduction.response };
  });
}

export type ActiveRun = {
  paneId: string | null;
  runId: RunId;
  sessionFile: string | null;
  startedAt: string | null;
};

export type RunningChildRow = {
  description: string | null;
  model: string;
  paneName: string | null;
  sessionFile: string | null;
  startedAt: string | null;
};

export function listRunningChildren(db: DatabaseSync): Array<RunningChildRow> {
  return db
    .prepare(
      `SELECT r.pane_name AS pane_name, r.lifecycle_json AS lifecycle_json, r.started_at AS started_at,
              s.session_file AS session_file, s.model AS model
       FROM agent_runs AS r
       JOIN agent_sessions AS s ON s.id = r.session_id
       WHERE r.status IN ('prepared', 'starting', 'running')
       ORDER BY r.started_at`,
    )
    .all()
    .map((item) => {
      const record = row(item);
      return {
        description: descriptionFromLifecycle(nullableText(record, 'lifecycle_json')),
        model: text(record, 'model'),
        paneName: nullableText(record, 'pane_name'),
        sessionFile: nullableText(record, 'session_file'),
        startedAt: nullableText(record, 'started_at'),
      };
    });
}

export function listActiveRuns(db: DatabaseSync): Array<ActiveRun> {
  return db
    .prepare(
      `SELECT r.id AS id, r.pane_id AS pane_id, s.session_file AS session_file, r.started_at AS started_at
       FROM agent_runs AS r
       JOIN agent_sessions AS s ON s.id = r.session_id
       WHERE r.status IN ('prepared', 'starting', 'running')`,
    )
    .all()
    .map((item) => {
      const record = row(item);
      return {
        paneId: nullableText(record, 'pane_id'),
        runId: runId(text(record, 'id')),
        sessionFile: nullableText(record, 'session_file'),
        startedAt: nullableText(record, 'started_at'),
      };
    });
}

export function claimNextAction(
  db: DatabaseSync,
  now: string,
): { action: ActionRecord; executionId: ExecutionId } | null {
  return immediateTransaction(db, () => {
    const found = db
      .prepare(
        "SELECT id, execution_id FROM actions WHERE status = 'pending' ORDER BY created_at LIMIT 1",
      )
      .get();
    if (found === undefined) {
      return null;
    }
    const record = row(found);
    const id = text(record, 'id');
    const expires = new Date(Date.parse(now) + 30_000).toISOString();
    const claimed = db
      .prepare(
        `UPDATE actions
         SET status = 'leased', lease_owner = 'factory-controller', lease_token = ?, lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(randomUUID(), expires, now, id);
    if (claimed.changes !== 1) {
      return null;
    }
    const actionRow = db.prepare('SELECT * FROM actions WHERE id = ?').get(id);
    if (actionRow === undefined) {
      return null;
    }
    return {
      action: actionFromRow(row(actionRow)),
      executionId: executionId(text(record, 'execution_id')),
    };
  });
}

export function finishLeasedAction(
  db: DatabaseSync,
  action: ActionId,
  now: string,
  outcome: 'succeeded' | 'failed',
  error: string | null,
): void {
  immediateTransaction(db, () => {
    db.prepare(
      `UPDATE actions
       SET status = ?, last_error = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
           completed_at = ?, updated_at = ?
       WHERE id = ? AND status = 'leased'`,
    ).run(outcome, error, now, now, action);
  });
}

export function loadSnapshotByRun(db: DatabaseSync, id: RunId): FactorySnapshot | null {
  return loadByRun(db, id);
}

export function loadSnapshotByExecution(db: DatabaseSync, id: ExecutionId): FactorySnapshot | null {
  return loadExecutionRow(db, id);
}

export function formatStatus(response: ControllerResponse): string {
  if (response.kind === 'rejected') {
    return response.message;
  }
  const lines = [
    response.displayRef,
    `stage: ${response.stage}`,
    `status: ${response.status}`,
    response.message,
  ];
  if (response.question !== null) {
    lines.push(
      `question: ${response.question}`,
      `Reply with: /factory reply ${response.displayRef} "answer"`,
    );
  }
  if (response.retryHint !== null) {
    lines.push(response.retryHint);
  }
  return lines.join('\n');
}
