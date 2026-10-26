import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_LIMITS, readStageSettings, type InternalLabel, type Limits } from '../config.ts';
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
  type Actor,
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
  type InputPurpose,
  type PassedCheck,
  type Retry,
  type Stage,
  type StageName,
  type TaskRecord,
  type TicketRecord,
  type UsageTotals,
  type UsageWrite,
  type WorktreeStatus,
  type TicketId,
} from '../domain.ts';
import { isInputStage, stages, type InputStage } from '../stages/index.ts';
import { FactoryDatabaseError, immediateTransaction } from '../state/database.ts';
import { card, encodeCard } from './card.ts';
import { keyOfFactoryDir } from './keys.ts';
import { describeExisting, reduce } from './reduce.ts';

type ApplySource = 'command' | 'runtime' | 'action' | 'validator' | 'controller';

export type ApplyResult = {
  armRunId: RunId | null;
  response: ControllerResponse;
  // The events.revision that recorded this input, or that recorded it the
  // first time for a duplicate. Null when nothing was recorded.
  revision: number | null;
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

function parseLabelMap(value: unknown): Policy['labels'] {
  if (!isRecord(value)) {
    throw new FactoryDatabaseError('execution policy is invalid');
  }
  const map: Record<string, InternalLabel> = {};
  for (const [projectLabel, internal] of Object.entries(value)) {
    if (internal !== 'investigation') {
      throw new FactoryDatabaseError('execution policy is invalid');
    }
    map[projectLabel] = 'investigation';
  }
  return { map };
}

function parseGenerated(value: unknown): Array<string> {
  // Executions started before wrap-up validation have no generated paths.
  if (!isRecord(value) || !Array.isArray(value['generated'])) {
    return [];
  }
  return value['generated'].filter((item): item is string => typeof item === 'string');
}

function parseCommands(value: unknown): Policy['validation']['work']['commands'] {
  if (!Array.isArray(value)) {
    throw new FactoryDatabaseError('execution policy is invalid');
  }
  const commands: Policy['validation']['work']['commands'] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item['name'] !== 'string' ||
      typeof item['timeoutMs'] !== 'number' ||
      !Array.isArray(item['argv']) ||
      item['argv'].some((arg) => typeof arg !== 'string')
    ) {
      throw new FactoryDatabaseError('execution policy is invalid');
    }
    commands.push({
      argv: item['argv'],
      name: item['name'],
      timeoutMs: item['timeoutMs'],
    });
  }
  return commands;
}

function parsePolicy(raw: string): Policy {
  const value: unknown = JSON.parse(raw);
  if (
    !isRecord(value) ||
    typeof value['codeRoot'] !== 'string' ||
    !isRecord(value['models']) ||
    !isRecord(value['limits']) ||
    !isRecord(value['labels']) ||
    !isRecord(value['validation'])
  ) {
    throw new FactoryDatabaseError('execution policy is invalid');
  }
  const models = value['models'];
  const limits = value['limits'];
  const labels = value['labels'];
  const validation = value['validation'];
  if (
    typeof models['plan'] !== 'string' ||
    typeof models['work'] !== 'string' ||
    typeof models['review'] !== 'string' ||
    typeof limits['infrastructureRetries'] !== 'number' ||
    !isRecord(labels['map']) ||
    !isRecord(validation['work'])
  ) {
    throw new FactoryDatabaseError('execution policy is invalid');
  }
  return {
    codeRoot: value['codeRoot'],
    labels: parseLabelMap(labels['map']),
    // A limit the execution's policy does not name keeps its default.
    limits: Object.fromEntries(
      Object.entries(DEFAULT_LIMITS).map(([key, fallback]) => {
        const stored = limits[key];
        return [key, typeof stored === 'number' ? stored : fallback];
      }),
    ) as Limits,
    models: { plan: models['plan'], review: models['review'], work: models['work'] },
    pullRequests: value['pullRequests'] === true,
    stages: storedStageSettings(value['stages']),
    validation: {
      // Executions started before validation.qa run the work commands again.
      qa: {
        commands: parseCommands(
          isRecord(validation['qa'])
            ? validation['qa']['commands']
            : validation['work']['commands'],
        ),
      },
      work: { commands: parseCommands(validation['work']['commands']) },
      wrapup: { generated: parseGenerated(validation['wrapup']) },
    },
    // Executions started before worktree setup existed have none.
    worktreeSetup: parseCommands(value['worktreeSetup'] ?? []),
  };
}

// Settings snapshotted at start are read again by their stages.
function storedStageSettings(value: unknown): Policy['stages'] {
  const read = readStageSettings(value);
  if (read.kind === 'error') {
    throw new FactoryDatabaseError(`execution policy is invalid: ${read.message}`);
  }
  return read.stages;
}

function stringList(value: unknown): Array<string> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function parseTicketPayload(
  raw: string,
  fallbackTitle: string,
): { body: string; commandRef: string; displayRef: string; labels: Array<string> } {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)) {
    throw new FactoryDatabaseError('ticket payload is invalid');
  }
  return {
    body: typeof value['body'] === 'string' ? value['body'] : '',
    commandRef: typeof value['commandRef'] === 'string' ? value['commandRef'] : fallbackTitle,
    displayRef: typeof value['displayRef'] === 'string' ? value['displayRef'] : fallbackTitle,
    labels: stringList(value['labels']),
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

const taskStatuses = ['pending', 'active', 'done', 'blocked', 'cancelled'] as const;
const sessionStatuses = ['prepared', 'open', 'completed', 'abandoned'] as const;
const runPurposes = [
  'initial',
  'validation_correction',
  'human_reply',
  'return_to_work',
  'reentry',
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

// Stage names are checked against the registry, not the schema (ADR-002).
function stageName(value: string): StageName {
  if (Object.hasOwn(stages, value)) {
    return value as StageName;
  }
  throw new FactoryDatabaseError(`unknown stage ${value}`);
}

function stage(value: string): Stage {
  return value === 'done' ? value : stageName(value);
}

function inputStage(value: string): InputStage {
  const stage = stageName(value);
  if (!isInputStage(stage)) {
    throw new FactoryDatabaseError(`the ${stage} stage prepares no input`);
  }
  return stage;
}

// A stage a task can be at: one that runs per task.
function taskStage(value: string): StageName {
  const stage = stageName(value);
  if (stages[stage].scope !== 'task') {
    throw new FactoryDatabaseError(`the ${stage} stage does not run per task`);
  }
  return stage;
}

function taskSummaries(json: string): TaskRecord['summaries'] {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed)) {
    throw new FactoryDatabaseError('task summaries must be an object');
  }
  const summaries: TaskRecord['summaries'] = {};
  for (const [stage, value] of Object.entries(parsed)) {
    if (
      !isRecord(value) ||
      typeof value['label'] !== 'string' ||
      typeof value['round'] !== 'number' ||
      !isRecord(value['counts']) ||
      !Object.values(value['counts']).every((count) => typeof count === 'number')
    ) {
      throw new FactoryDatabaseError(`the ${stage} task summary is malformed`);
    }
    summaries[taskStage(stage)] = {
      counts: value['counts'] as Record<string, number>,
      label: value['label'],
      round: value['round'],
    };
  }
  return summaries;
}

const retryKinds = ['input', 'validate', 'worktree', 'relaunch', 'resume_reply'] as const;

// The execution's retry target lives in status_details_json as {"retry": ...}.
function retryOf(json: string | null): Retry | null {
  const details: unknown = json === null ? {} : JSON.parse(json);
  const retry = isRecord(details) ? details['retry'] : undefined;
  if (retry === undefined || retry === null) {
    return null;
  }
  if (
    isRecord(retry) &&
    retry['kind'] === 'revalidate' &&
    typeof retry['stage'] === 'string' &&
    typeof retry['taskId'] === 'string'
  ) {
    return {
      kind: 'revalidate',
      stage: taskStage(retry['stage']),
      taskId: taskId(retry['taskId']),
    };
  }
  if (isRecord(retry) && typeof retry['kind'] === 'string') {
    return { kind: oneOf(retry['kind'], retryKinds, 'retry kind') };
  }
  throw new FactoryDatabaseError('the execution retry target is malformed');
}

function statusDetails(retry: Retry | null): string | null {
  return retry === null ? null : jsonText({ retry });
}

// A per-task stage's session belongs to a task; a per-ticket one does not.
function assertSessionScope(stage: StageName, task: string | null): void {
  const scope = stages[stage].scope;
  if ((scope === 'task') !== (task !== null)) {
    throw new FactoryDatabaseError(
      scope === 'task'
        ? `a ${stage} session needs a task`
        : `a ${stage} session cannot belong to a task`,
    );
  }
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

function loadExecutionRow(
  db: DatabaseSync,
  execution: ExecutionId,
  currentOnly = true,
): FactorySnapshot | null {
  const executionRow = db
    .prepare(
      currentOnly
        ? 'SELECT * FROM ticket_executions WHERE id = ? AND is_current = 1'
        : 'SELECT * FROM ticket_executions WHERE id = ?',
    )
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

export function listCurrentTicketRefs(db: DatabaseSync): Array<string> {
  const rows = db
    .prepare(
      `SELECT json_extract(t.source_payload, '$.displayRef') AS display_ref
       FROM ticket_executions AS e
       JOIN tickets AS t ON t.id = e.ticket_id
       WHERE e.is_current = 1
       ORDER BY e.updated_at`,
    )
    .all();
  const refs: Array<string> = [];
  for (const entry of rows) {
    if (typeof entry !== 'object' || entry === null || !('display_ref' in entry)) {
      continue;
    }
    const ref = entry.display_ref;
    if (typeof ref === 'string' && ref.length > 0) {
      refs.push(ref);
    }
  }
  return refs;
}

// A status card the controller posted, kept as a domain event so clients that
// did not see it live (Pi, the event stream) can render it after their cursor.
export function recordCard(db: DatabaseSync, card: string, now: string): number {
  const id = randomUUID();
  const inserted = db
    .prepare(
      `INSERT INTO events
        (id, direction, source, kind, dedupe_key, payload_json, processing_status, received_at,
         processed_at)
       VALUES (?, 'domain', 'controller', 'card', ?, ?, 'processed', ?, ?)`,
    )
    .run(id, `card:${id}`, JSON.stringify({ card }), now, now);
  return Number(inserted.lastInsertRowid);
}

// A process the stray sweep stopped, or failed to stop, before one of this
// execution's runs: kept as a domain event on the ticket for audit.
export function recordStrayProcess(
  db: DatabaseSync,
  input: {
    command: string;
    detail: string;
    executionId: ExecutionId;
    kind: 'stray_process_stopped' | 'stray_process_stop_failed';
    now: string;
    pid: number;
    runId: RunId;
    worktree: string;
  },
): void {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO events
      (id, execution_id, run_id, direction, source, kind, dedupe_key, payload_json,
       processing_status, received_at, processed_at)
     VALUES (?, ?, ?, 'domain', 'controller', ?, ?, ?, 'processed', ?, ?)`,
  ).run(
    id,
    input.executionId,
    input.runId,
    input.kind,
    `stray:${id}`,
    JSON.stringify({
      command: input.command,
      detail: input.detail,
      pid: input.pid,
      worktree: input.worktree,
    }),
    input.now,
    input.now,
  );
}

// The worktrees of current executions that are not finished. A paused or
// failed ticket keeps its worktree: retry may still use it.
export function activeWorktrees(db: DatabaseSync): Set<string> {
  return new Set(
    db
      .prepare(
        `SELECT worktree_path FROM ticket_executions
         WHERE is_current = 1 AND status NOT IN ('complete', 'cancelled')
           AND worktree_path IS NOT NULL`,
      )
      .all()
      .map((item) => text(row(item), 'worktree_path')),
  );
}

export function cardsSince(
  db: DatabaseSync,
  revision: number,
): Array<{ card: string; revision: number }> {
  return db
    .prepare(
      `SELECT revision, payload_json FROM events
       WHERE direction = 'domain' AND kind = 'card' AND revision > ?
       ORDER BY revision`,
    )
    .all(revision)
    .map((item) => {
      const record = row(item);
      const payload: unknown = JSON.parse(text(record, 'payload_json'));
      return {
        card: isRecord(payload) && typeof payload['card'] === 'string' ? payload['card'] : '',
        revision: integer(record, 'revision'),
      };
    });
}

// One generation of a ticket, current or retired, for reading.
export function loadGeneration(
  db: DatabaseSync,
  ticket: TicketId,
  generation: number,
): FactorySnapshot | null {
  const found = db
    .prepare('SELECT id FROM ticket_executions WHERE ticket_id = ? AND generation = ?')
    .get(ticket, generation);
  return found === undefined
    ? null
    : loadExecutionRow(db, executionId(text(row(found), 'id')), false);
}

// The change cursor: the newest events.revision, or 0 before any event.
export function latestRevision(db: DatabaseSync): number {
  return integer(
    row(db.prepare('SELECT coalesce(max(revision), 0) AS revision FROM events').get()),
    'revision',
  );
}

// The Herdr tab a ticket's panes open in.
export function ticketTab(snapshot: FactorySnapshot): { key: string; label: string } {
  return { key: ticketKeyOf(snapshot), label: snapshot.ticket.displayRef };
}

// The API names a ticket by its factory directory's name, `<slug>-<hash8>`.
export function ticketKeyOf(snapshot: FactorySnapshot): string {
  return keyOfFactoryDir(snapshot.execution.factoryDir);
}

export function loadCurrentByFactoryKey(db: DatabaseSync, key: string): FactorySnapshot | null {
  const found = db
    .prepare('SELECT id, factory_dir FROM ticket_executions WHERE is_current = 1')
    .all()
    .map(row)
    .find((record) => keyOfFactoryDir(text(record, 'factory_dir')) === key);
  return found === undefined ? null : loadExecutionRow(db, executionId(text(found, 'id')));
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
    labels: payload.labels,
    sourceHash: nullableText(ticketRow, 'source_hash') ?? '',
    sourceKind: text(ticketRow, 'source_kind'),
    sourceRef: nullableText(ticketRow, 'source_ref') ?? '',
    title: nullableText(ticketRow, 'title') ?? payload.displayRef,
  };
  const executionRecord: ExecutionRecord = {
    factoryDir: text(executionRow, 'factory_dir'),
    factoryVersion: nullableText(executionRow, 'factory_version'),
    generation: integer(executionRow, 'generation'),
    id: execution,
    inputFetchedAt: nullableText(executionRow, 'input_fetched_at') ?? '',
    inputHash: nullableText(executionRow, 'input_hash') ?? '',
    inputJson: nullableText(executionRow, 'input_json') ?? '{}',
    message: nullableText(executionRow, 'message'),
    planPath: nullableText(executionRow, 'plan_path'),
    policy: parsePolicy(text(executionRow, 'policy_json')),
    retry: retryOf(nullableText(executionRow, 'status_details_json')),
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
    const stage = nullableText(record, 'stage');
    return {
      blockedBy: deps.map((dep) => taskId(text(row(dep), 'depends_on_task_id'))),
      ordinal: integer(record, 'ordinal'),
      specHash: nullableText(record, 'spec_hash'),
      stage: stage === null ? null : taskStage(stage),
      status: oneOf(text(record, 'status'), taskStatuses, 'task status'),
      summaries: taskSummaries(text(record, 'summaries_json')),
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
      const sessionStage = stageName(text(record, 'stage'));
      assertSessionScope(sessionStage, task);
      return {
        id: sessionId(text(record, 'id')),
        logicalKey: text(record, 'logical_key'),
        model: text(record, 'model'),
        piSessionId: nullableText(record, 'pi_session_id'),
        sessionFile: nullableText(record, 'session_file'),
        stage: sessionStage,
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
      const origin = nullableText(record, 'origin');
      return {
        baseline: baselineFromLifecycle(nullableText(record, 'lifecycle_json')),
        description: descriptionFromLifecycle(nullableText(record, 'lifecycle_json')),
        diffHash: nullableText(record, 'diff_hash'),
        endedAt: nullableText(record, 'ended_at'),
        id: runId(text(record, 'id')),
        inputHash: nullableText(record, 'input_hash'),
        origin: origin === null ? null : taskStage(origin),
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
      const client = nullableText(record, 'actor');
      return {
        actor:
          client === null
            ? null
            : { client, onBehalfOf: nullableText(record, 'actor_on_behalf_of') },
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
  if (
    kind === 'prepare_input' &&
    typeof payload['stage'] === 'string' &&
    (payload['taskId'] === null || typeof payload['taskId'] === 'string') &&
    (payload['origin'] === null || typeof payload['origin'] === 'string') &&
    (payload['purpose'] === 'initial' ||
      payload['purpose'] === 'validation_correction' ||
      payload['purpose'] === 'human_reply' ||
      payload['purpose'] === 'return_to_work') &&
    Array.isArray(payload['failures']) &&
    payload['failures'].every((item) => typeof item === 'string')
  ) {
    const stage = inputStage(payload['stage']);
    const purpose: InputPurpose = payload['purpose'];
    const task = payload['taskId'] === null ? null : taskId(payload['taskId']);
    assertSessionScope(stage, task);
    return {
      ...base,
      attentionReplyId: null,
      attentionRequestId: null,
      failures: payload['failures'],
      kind,
      origin: payload['origin'] === null ? null : taskStage(payload['origin']),
      purpose,
      runId: null,
      stage,
      taskId: task,
    };
  }
  if (kind === 'open_pane' && run !== null && typeof payload['name'] === 'string') {
    return {
      ...base,
      attentionReplyId: null,
      attentionRequestId: null,
      kind,
      name: payload['name'],
      runId: runId(run),
    };
  }
  if (
    kind === 'open_diff' &&
    run !== null &&
    typeof payload['name'] === 'string' &&
    typeof payload['cwd'] === 'string'
  ) {
    return {
      ...base,
      attentionReplyId: null,
      attentionRequestId: null,
      cwd: payload['cwd'],
      kind,
      name: payload['name'],
      runId: runId(run),
    };
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
  if (kind === 'update_ticket_source' && typeof payload['comment'] === 'string') {
    const issueStatus = payload['issueStatus'];
    const update = payload['update'];
    return {
      ...base,
      attentionReplyId: null,
      attentionRequestId: null,
      checklist: Array.isArray(payload['checklist'])
        ? payload['checklist'].flatMap((item: unknown) =>
            isRecord(item) && typeof item['key'] === 'string' && typeof item['text'] === 'string'
              ? [{ key: item['key'], text: item['text'] }]
              : [],
          )
        : [],
      comment: payload['comment'],
      commentKey: typeof payload['commentKey'] === 'string' ? payload['commentKey'] : null,
      issueStatus:
        issueStatus === 'clear' || issueStatus === 'in_progress' || issueStatus === 'in_review'
          ? issueStatus
          : null,
      kind,
      runId: null,
      update:
        update === 'cancelled' || update === 'handoff' || update === 'paused' ? update : 'started',
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
    case 'prepare_input':
      return jsonText({
        failures: action.failures,
        origin: action.origin,
        purpose: action.purpose,
        stage: action.stage,
        taskId: action.taskId,
      });
    case 'open_pane':
      return jsonText({ name: action.name });
    case 'open_diff':
      return jsonText({ cwd: action.cwd, name: action.name });
    case 'prepare_worktree':
      return jsonText({ slug: action.slug });
    case 'notify_attention':
      return jsonText({ message: action.message });
    case 'update_ticket_source':
      return jsonText({
        checklist: action.checklist,
        comment: action.comment,
        commentKey: action.commentKey,
        issueStatus: action.issueStatus,
        update: action.update,
      });
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
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       title = excluded.title, source_kind = excluded.source_kind, source_ref = excluded.source_ref,
       source_payload = excluded.source_payload, source_hash = excluded.source_hash,
       updated_at = excluded.updated_at`,
  ).run(
    snapshot.ticket.id,
    snapshot.ticket.title,
    snapshot.ticket.sourceKind,
    snapshot.ticket.sourceRef,
    jsonText({
      body: snapshot.ticket.body,
      commandRef: snapshot.ticket.commandRef,
      displayRef: snapshot.ticket.displayRef,
      labels: snapshot.ticket.labels,
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
       retryable, status_details_json, policy_json, input_json, input_hash, input_fetched_at, factory_dir, plan_path,
       worktree_path, worktree_branch, worktree_base_branch, worktree_status, worktree_base_sha,
       message, message_at, created_at, updated_at, factory_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    execution.id,
    execution.ticketId,
    execution.generation,
    execution.stage,
    execution.status,
    execution.version,
    execution.statusReasonCode,
    execution.statusReason,
    execution.retry === null ? 0 : 1,
    statusDetails(execution.retry),
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
    execution.factoryVersion,
  );
}

// Opens a new interval in status_history when an execution or a task enters a
// different stage or status, closing the one it leaves.
function recordStatus(
  db: DatabaseSync,
  input: {
    executionId: string;
    now: string;
    stage: string | null;
    status: string;
    taskId: string | null;
  },
): void {
  const open = db
    .prepare(
      `SELECT id, stage, status FROM status_history
       WHERE execution_id = ? AND task_id IS ? AND ended_at IS NULL
       ORDER BY id DESC LIMIT 1`,
    )
    .get(input.executionId, input.taskId);
  if (open !== undefined && open['stage'] === input.stage && open['status'] === input.status) {
    return;
  }
  if (open !== undefined) {
    db.prepare('UPDATE status_history SET ended_at = ? WHERE id = ?').run(
      input.now,
      Number(open['id']),
    );
  }
  db.prepare(
    `INSERT INTO status_history (execution_id, task_id, stage, status, started_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(input.executionId, input.taskId, input.stage, input.status, input.now);
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
           retryable = ?, status_details_json = ?, plan_path = ?, worktree_path = ?, worktree_branch = ?,
           worktree_base_branch = ?, worktree_status = ?, worktree_base_sha = ?,
           message = ?, message_at = ?, updated_at = ?,
           finished_at = CASE
             WHEN ? IN ('complete', 'cancelled') THEN coalesce(finished_at, ?)
             ELSE NULL
           END
       WHERE id = ? AND version = ?`,
    )
    .run(
      after.stage,
      after.status,
      after.version,
      after.statusReasonCode,
      after.statusReason,
      after.retry === null ? 0 : 1,
      statusDetails(after.retry),
      after.planPath,
      after.worktreePath,
      after.worktreeBranch,
      after.worktreeBaseBranch,
      after.worktreeStatus,
      after.worktreeBaseSha,
      after.message,
      now,
      now,
      after.status,
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
      (execution_id, task_id, ordinal, title, task_file, spec_hash, status, stage, summaries_json,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    execution,
    task.taskId,
    task.ordinal,
    task.title,
    task.taskFile,
    task.specHash,
    task.status,
    task.stage,
    jsonText(task.summaries),
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
  assertSessionScope(session.stage, session.taskId);
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

function lifecycleJson(run: Pick<RunRecord, 'baseline' | 'description'>): string | null {
  if (run.description === null && run.baseline === null) {
    return null;
  }
  return JSON.stringify({ baseline: run.baseline, description: run.description });
}

function baselineFromLifecycle(raw: string | null): string | null {
  if (raw === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && typeof parsed['baseline'] === 'string') {
      return parsed['baseline'];
    }
  } catch {
    return null;
  }
  return null;
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
      (id, execution_id, session_id, sequence, parent_run_id, purpose, origin, semantic_round,
       status, terminal_kind, subagent_id, pane_id, pane_name, input_hash, diff_hash,
       result_contract, result_status, result_json, result_hash, result_error, lifecycle_json,
       created_at, started_at, updated_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    run.id,
    execution,
    run.sessionId,
    run.sequence,
    run.parentRunId,
    run.purpose,
    run.origin,
    run.semanticRound,
    run.status,
    run.terminalKind,
    run.subagentId,
    run.paneId,
    run.paneName,
    run.inputHash,
    run.diffHash,
    run.resultContract,
    run.resultStatus,
    run.resultJson,
    run.resultHash,
    run.resultError,
    lifecycleJson(run),
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
    lifecycleJson(run),
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
      (id, request_id, version, answer, answer_hash, idempotency_key, is_current, created_at,
       actor, actor_on_behalf_of)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    reply.id,
    reply.requestId,
    reply.version,
    reply.answer,
    reply.answerHash,
    reply.idempotencyKey,
    reply.isCurrent ? 1 : 0,
    now,
    reply.actor?.client ?? null,
    reply.actor?.onBehalfOf ?? null,
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
  recordStatus(db, {
    executionId: after.execution.id,
    now,
    stage: after.execution.stage,
    status: after.execution.status,
    taskId: null,
  });

  for (const task of after.tasks) {
    const previous = before?.tasks.find((item) => item.taskId === task.taskId) ?? null;
    if (previous === null) {
      insertTask(db, after.execution.id, task, now);
    } else if (!same(previous, task)) {
      db.prepare(
        `UPDATE tasks
         SET status = ?, stage = ?, summaries_json = ?, version = version + 1, updated_at = ?
         WHERE execution_id = ? AND task_id = ?`,
      ).run(
        task.status,
        task.stage,
        jsonText(task.summaries),
        now,
        after.execution.id,
        task.taskId,
      );
    }
    recordStatus(db, {
      executionId: after.execution.id,
      now,
      stage: task.stage,
      status: task.status,
      taskId: task.taskId,
    });
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
    case 'complete':
    case 'pull_request_closed':
    case 'cancel':
      return loadCurrentByTicketKey(db, event.ticketId);
    case 'rerun':
      // Only a repeated rerun gets here; it answers with the new generation.
      return loadCurrentByTicketKey(db, event.start.ticket.id);
    case 'runtime_terminal':
    case 'validation_finished':
    case 'run_started':
    case 'launch_failed':
    case 'reconciled':
    case 'stop':
      return loadByRun(db, event.runId);
    case 'worktree_ready':
    case 'worktree_failed':
    case 'input_ready':
    case 'input_failed':
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
    case 'stop':
      return event.runId;
    case 'start':
    case 'reply':
    case 'retry':
    case 'worktree_ready':
    case 'worktree_failed':
    case 'input_ready':
    case 'input_failed':
    case 'complete':
    case 'pull_request_closed':
    case 'cancel':
    case 'rerun':
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
    actor: Actor | null;
    dedupeKey: string;
    executionId: ExecutionId | null;
    failed: boolean;
    id: string;
    kind: string;
    now: string;
    runId: string | null;
    source: ApplySource;
  },
): number {
  const inserted = db
    .prepare(
      `INSERT INTO events
      (id, execution_id, run_id, direction, source, kind, dedupe_key, payload_json, processing_status,
       processed_at, actor, actor_on_behalf_of)
     VALUES (?, ?, ?, 'input', ?, ?, ?, '{}', ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.executionId,
      input.runId,
      input.source,
      input.kind,
      input.dedupeKey,
      input.failed ? 'failed' : 'processed',
      input.now,
      input.actor?.client ?? null,
      input.actor?.onBehalfOf ?? null,
    );
  return Number(inserted.lastInsertRowid);
}

export function applyControllerEvent(
  db: DatabaseSync,
  input: {
    // The API client behind a command; null for the runtime, validators, and Pi.
    actor?: Actor | null;
    dedupeKey: string;
    event: ControllerEvent;
    ids: IdSource;
    now: string;
    prepare?: (database: DatabaseSync) => void;
    source: ApplySource;
  },
): ApplyResult {
  return immediateTransaction(db, () => {
    const duplicate = db
      .prepare('SELECT revision FROM events WHERE dedupe_key = ?')
      .get(input.dedupeKey);
    if (input.event.kind === 'rerun' && duplicate === undefined) {
      return applyRerun(db, { ...input, event: input.event });
    }
    const current = snapshotForEvent(db, input.event);
    if (duplicate !== undefined) {
      if (current === null) {
        return {
          armRunId: null,
          response: { kind: 'rejected', message: 'Duplicate event has no execution.' },
          revision: null,
        };
      }
      return {
        armRunId: null,
        response: describeExisting(current),
        revision: integer(row(duplicate), 'revision'),
      };
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
    let revision: number | null = null;
    if (reduction.response.kind === 'status') {
      revision = insertInputEvent(db, {
        actor: input.actor ?? null,
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
    return { armRunId: reduction.armRunId, response: reduction.response, revision };
  });
}

// Statuses a ticket can be rerun from: it finished, or it failed for good.
const RERUNNABLE = new Set(['complete', 'cancelled', 'failed']);

// Quiesces what is left of a generation, then retires it. The schema's
// retire_execution_requires_quiescence trigger checks the result.
function retireExecution(db: DatabaseSync, execution: string, now: string): void {
  db.prepare(
    `UPDATE actions SET status = 'cancelled', lease_owner = NULL, lease_token = NULL,
       lease_expires_at = NULL, completed_at = ?, updated_at = ?
     WHERE execution_id = ? AND status IN ('pending', 'leased')`,
  ).run(now, now, execution);
  db.prepare(
    `UPDATE agent_runs SET status = 'terminal', terminal_kind = 'cancelled', ended_at = ?
     WHERE execution_id = ? AND status IN ('prepared', 'starting', 'running')`,
  ).run(now, execution);
  db.prepare(
    `UPDATE tasks SET status = 'cancelled', stage = NULL, updated_at = ?
     WHERE execution_id = ? AND status IN ('pending', 'active', 'blocked')`,
  ).run(now, execution);
  db.prepare(
    `UPDATE agent_sessions SET status = 'abandoned', updated_at = ?
     WHERE execution_id = ? AND status IN ('prepared', 'open')`,
  ).run(now, execution);
  db.prepare(
    `UPDATE attention_requests SET status = 'cancelled', cancelled_at = ?
     WHERE execution_id = ? AND status IN ('open', 'answered', 'resuming')`,
  ).run(now, execution);
  db.prepare(
    `UPDATE validation_runs SET status = 'error', completed_at = ?
     WHERE execution_id = ? AND status IN ('pending', 'running')`,
  ).run(now, execution);
  db.prepare(
    `UPDATE events SET processing_status = 'ignored', processed_at = ?
     WHERE execution_id = ? AND processing_status = 'pending'`,
  ).run(now, execution);
  db.prepare('UPDATE ticket_executions SET is_current = 0, updated_at = ? WHERE id = ?').run(
    now,
    execution,
  );
}

// A rerun retires the current generation and starts generation N+1, all in
// the caller's transaction (ADR-001's rerun guardrail).
function applyRerun(
  db: DatabaseSync,
  input: {
    actor?: Actor | null;
    dedupeKey: string;
    event: Extract<ControllerEvent, { kind: 'rerun' }>;
    ids: IdSource;
    now: string;
    source: ApplySource;
  },
): ApplyResult {
  const current = loadExecutionRow(db, input.event.previous);
  if (current === null) {
    return {
      armRunId: null,
      response: { kind: 'rejected', message: 'That generation is no longer current.' },
      revision: null,
    };
  }
  if (!RERUNNABLE.has(current.execution.status)) {
    return {
      armRunId: null,
      response: {
        kind: 'rejected',
        message: `${current.ticket.displayRef} is ${current.execution.stage}/${current.execution.status}; only a complete, cancelled, or failed ticket can be rerun.`,
      },
      revision: null,
    };
  }
  retireExecution(db, current.execution.id, input.now);
  const reduction = reduce({
    event: input.event.start,
    ids: input.ids,
    now: input.now,
    snapshot: null,
  });
  if (!reduction.changed || reduction.snapshot === null) {
    throw new FactoryDatabaseError('a rerun did not create a generation');
  }
  persist(db, null, reduction.snapshot, reduction.usage, input.now);
  const revision = insertInputEvent(db, {
    actor: input.actor ?? null,
    dedupeKey: input.dedupeKey,
    executionId: reduction.snapshot.execution.id,
    failed: false,
    id: input.ids.event(),
    kind: 'rerun',
    now: input.now,
    runId: null,
    source: input.source,
  });
  return { armRunId: reduction.armRunId, response: reduction.response, revision };
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
  tasksLeft: number | null;
  taskTitle: string | null;
};

export function listRunningChildren(db: DatabaseSync): Array<RunningChildRow> {
  return db
    .prepare(
      `SELECT r.pane_name AS pane_name, r.lifecycle_json AS lifecycle_json, r.started_at AS started_at,
              s.session_file AS session_file, s.model AS model, s.stage AS stage,
              t.title AS task_title,
              (
                SELECT COUNT(*)
                FROM tasks AS open_tasks
                WHERE open_tasks.execution_id = s.execution_id
                  AND open_tasks.status != 'done'
              ) AS tasks_left
       FROM agent_runs AS r
       JOIN agent_sessions AS s ON s.id = r.session_id
       LEFT JOIN tasks AS t
         ON t.execution_id = s.execution_id
        AND t.task_id = s.task_id
       WHERE r.status IN ('prepared', 'starting', 'running')
       ORDER BY r.started_at`,
    )
    .all()
    .map((item) => {
      const record = row(item);
      const stage = text(record, 'stage');
      const title = nullableText(record, 'task_title');
      const taskTitle =
        Object.hasOwn(stages, stage) &&
        stages[stage as StageName].scope === 'task' &&
        title !== null &&
        title.trim().length > 0
          ? title
          : null;
      return {
        description: descriptionFromLifecycle(nullableText(record, 'lifecycle_json')),
        model: text(record, 'model'),
        paneName: nullableText(record, 'pane_name'),
        sessionFile: nullableText(record, 'session_file'),
        startedAt: nullableText(record, 'started_at'),
        tasksLeft: taskTitle === null ? null : integer(record, 'tasks_left'),
        taskTitle,
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

export function executionIsCurrent(db: DatabaseSync, id: ExecutionId): boolean {
  const found = db.prepare('SELECT is_current FROM ticket_executions WHERE id = ?').get(id);
  return found !== undefined && integer(row(found), 'is_current') === 1;
}

export function extendActionLease(
  db: DatabaseSync,
  action: ActionId,
  now: string,
  ttlMs: number,
): void {
  const expires = new Date(Date.parse(now) + ttlMs).toISOString();
  immediateTransaction(db, () => {
    db.prepare(
      `UPDATE actions
       SET lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND status = 'leased'`,
    ).run(expires, now, action);
  });
}

export function requeueOrphanedValidations(
  db: DatabaseSync,
  now: string,
  liveActionIds: ReadonlySet<string>,
): void {
  immediateTransaction(db, () => {
    const rows = db
      .prepare(
        `SELECT id, attempts, max_attempts, execution_id
         FROM actions
         WHERE kind = 'validate_run' AND status = 'leased'`,
      )
      .all();
    for (const item of rows) {
      const record = row(item);
      const id = text(record, 'id');
      if (liveActionIds.has(id)) {
        continue;
      }
      const attempts = integer(record, 'attempts');
      const maxAttempts = integer(record, 'max_attempts');
      if (attempts + 1 > maxAttempts) {
        db.prepare(
          `UPDATE actions
           SET status = 'failed', last_error = ?, lease_owner = NULL, lease_token = NULL,
               lease_expires_at = NULL, completed_at = ?, updated_at = ?
           WHERE id = ? AND status = 'leased'`,
        ).run('Validation lease expired.', now, now, id);
        db.prepare(
          `UPDATE ticket_executions
           SET status = 'failed', retryable = 1, status_details_json = '{"retry":{"kind":"validate"}}',
               status_reason_code = 'validator_error',
               status_reason = ?, version = version + 1, message = ?, updated_at = ?
           WHERE id = ?`,
        ).run(
          'Validation lease expired.',
          'Validation lease expired.',
          now,
          text(record, 'execution_id'),
        );
        const failed = db
          .prepare('SELECT stage FROM ticket_executions WHERE id = ?')
          .get(text(record, 'execution_id'));
        recordStatus(db, {
          executionId: text(record, 'execution_id'),
          now,
          stage: failed === undefined ? null : String(failed['stage']),
          status: 'failed',
          taskId: null,
        });
        continue;
      }
      db.prepare(
        `UPDATE actions
         SET status = 'pending', attempts = ?, lease_owner = NULL, lease_token = NULL,
             lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'leased'`,
      ).run(attempts + 1, now, id);
    }
  });
}

// `owner` names the process holding the lease: the factory server's instance
// id, or the Pi-hosted controller's fixed name.
export function claimNextAction(
  db: DatabaseSync,
  now: string,
  owner = 'factory-controller',
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
         SET status = 'leased', lease_owner = ?, lease_token = ?, lease_expires_at = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(owner, randomUUID(), expires, now, id);
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

// Tracker updates a previous server leased and never finished go back to
// pending. Their comment marker keeps a second attempt from posting twice.
export function requeueOrphanedTrackerUpdates(db: DatabaseSync, now: string): void {
  db.prepare(
    `UPDATE actions
     SET status = 'pending', lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
         updated_at = ?
     WHERE kind = 'update_ticket_source' AND status = 'leased'`,
  ).run(now);
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
  const waiting =
    response.status === 'waiting_for_user' ||
    response.status === 'paused' ||
    response.status === 'resume_failed';
  const body = [response.message];
  if (response.question !== null && response.question !== response.message) {
    body.push(response.question);
  }
  if (response.next === null && response.retryHint !== null) {
    body.push(response.retryHint);
  }
  return encodeCard(
    card({
      body: body.join('\n'),
      displayRef: response.displayRef,
      next: response.next,
      outcome: response.status,
      progress: response.progress,
      stage: response.stage,
      task: response.task,
      tone: response.status === 'failed' ? 'failed' : waiting ? 'attention' : 'progress',
    }),
  );
}

// Each task's latest passing work validation, one line per check:
// `Task 01 · test: passed (npm test)`.
// The checks of each task's latest passed validation by a stage's validator.
export function passedChecks(
  db: DatabaseSync,
  execution: ExecutionId,
  stage: StageName,
  validatorVersion: string,
): Array<PassedCheck> {
  return db
    .prepare(
      `SELECT s.task_id AS task_id, c.name AS name, c.kind AS kind, c.status AS status,
              c.command AS command, c.evidence_path AS evidence_path
       FROM agent_sessions AS s
       JOIN validation_runs AS v ON v.id = (
         SELECT v2.id
         FROM validation_runs AS v2
         JOIN agent_runs AS r2 ON r2.id = v2.run_id
         WHERE r2.session_id = s.id AND v2.validator_version = ? AND v2.status = 'passed'
         ORDER BY v2.completed_at DESC, v2.rowid DESC
         LIMIT 1
       )
       JOIN validation_checks AS c ON c.validation_id = v.id
       WHERE s.execution_id = ? AND s.stage = ?
       ORDER BY s.task_id, c.ordinal`,
    )
    .all(validatorVersion, execution, stage)
    .map((item) => {
      const record = row(item);
      const task = nullableText(record, 'task_id');
      return {
        command: nullableText(record, 'command'),
        evidencePath: nullableText(record, 'evidence_path'),
        kind: text(record, 'kind'),
        name: text(record, 'name'),
        status: text(record, 'status'),
        taskId: task === null ? null : taskId(task),
      };
    });
}

// A pane action leased by a controller that died never ran to the end. On
// restart it goes back to pending; the pane might open twice, never zero times.
export function requeueOrphanedPanes(db: DatabaseSync, now: string): void {
  immediateTransaction(db, () => {
    db.prepare(
      `UPDATE actions
       SET status = CASE WHEN attempts + 1 > max_attempts THEN 'failed' ELSE 'pending' END,
           attempts = min(attempts + 1, max_attempts),
           last_error = CASE WHEN attempts + 1 > max_attempts THEN 'Pane lease expired.' ELSE last_error END,
           completed_at = CASE WHEN attempts + 1 > max_attempts THEN ? ELSE NULL END,
           lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE kind IN ('open_pane', 'open_diff') AND status = 'leased'`,
    ).run(now, now);
  });
}
