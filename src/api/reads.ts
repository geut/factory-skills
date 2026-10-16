import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { needsUser, runVerdict, ticketProgress } from '../controller/progress.ts';
import { runOutcome } from '../controller/run-card.ts';
import {
  listCurrentTicketRefs,
  loadCurrentByFactoryKey,
  loadGeneration,
  loadCurrentByTicketKey,
  ticketKeyOf,
} from '../controller/store.ts';
import type { ExecutionStatus, FactorySnapshot, RunRecord, StageName } from '../domain.ts';
import { runAssistantText } from '../runtime/session-activity.ts';
import { stages } from '../stages/index.ts';
import { ProblemError } from './problem.ts';
import { defineRoute, type ApiContext } from './route.ts';
import { TicketKey, TicketParams } from './schemas.ts';

// Read routes: what the command center shows. They read the server's own
// database connection and never change it.

const executionStatuses = [
  'queued',
  'active',
  'waiting_for_user',
  'paused',
  'resuming',
  'resume_failed',
  'failed',
  'ready_for_handoff',
  'complete',
  'cancelled',
] as const satisfies ReadonlyArray<ExecutionStatus>;

const stageNames = Object.keys(stages) as [StageName, ...Array<StageName>];
const ticketStages = [...stageNames, 'done'] as const;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
// Activity text is a glimpse of what an agent is doing, not its transcript.
const ACTIVITY_MAX = 2000;

function database(context: ApiContext): DatabaseSync {
  if (context.db === null) {
    throw new ProblemError('internal_error', 'The server has no database.');
  }
  return context.db;
}

// A query value may repeat; a repeated value means OR.
function many<T extends z.ZodType>(item: T) {
  return z
    .union([item, z.array(item)])
    .optional()
    .transform((value): Array<z.output<T>> =>
      value === undefined ? [] : Array.isArray(value) ? value : [value],
    );
}

const Actor = z
  .object({
    client: z.string(),
    onBehalfOf: z.string().nullable().meta({ description: 'As the client sent it. Unverified.' }),
  })
  .meta({ id: 'Actor' });

const Progress = z
  .object({
    current: z
      .object({ label: z.string(), step: z.string() })
      .nullable()
      .meta({ description: 'The task in work or review, such as `03/06 Overview page`.' }),
    done: z.int().nonnegative(),
    next: z.string().nullable().meta({ description: 'The Pi command a person runs next.' }),
    total: z.int().nonnegative(),
  })
  .meta({ id: 'Progress' });

const TicketSummary = z
  .object({
    createdAt: z.string(),
    displayRef: z.string(),
    execution: z.int().positive().meta({ description: 'The generation; it grows with reruns.' }),
    finishedAt: z.string().nullable(),
    id: z.string(),
    key: TicketKey,
    needsUser: z.boolean().meta({
      description: 'Waiting for a reply, paused, failed, or ready for handoff.',
    }),
    progress: Progress,
    pullRequest: z
      .object({
        mergedAt: z.string().nullable(),
        number: z.int().nullable(),
        state: z.enum(['open', 'merged', 'closed']),
        url: z.string(),
      })
      .nullable()
      .meta({ description: "The ticket's pull request, once wrap-up or sync has found it." }),
    sourceRef: z.string(),
    stage: z.enum(ticketStages),
    startedBy: Actor.nullable().meta({ description: 'The API client that started the ticket.' }),
    status: z.enum(executionStatuses),
    statusReason: z.string().nullable(),
    title: z.string(),
    trackerWarnings: z
      .array(z.string())
      .meta({ description: 'Tracker updates that failed. The ticket went on regardless.' }),
    updatedAt: z.string(),
  })
  .meta({ id: 'TicketSummary' });

const TaskSummaryEntry = z.object({
  counts: z.record(z.string(), z.number()),
  label: z.string(),
  round: z.int(),
});

const Task = z
  .object({
    blockedBy: z.array(z.string()),
    id: z.string(),
    ordinal: z.int(),
    stage: z.enum(stageNames).nullable(),
    status: z.enum(['pending', 'active', 'done', 'blocked', 'cancelled']),
    summaries: z
      .record(z.string(), TaskSummaryEntry)
      .meta({ description: 'The latest result of each stage, such as the review round.' }),
    title: z.string(),
  })
  .meta({ id: 'Task' });

const Reply = z
  .object({
    actor: Actor.nullable(),
    answer: z.string(),
    createdAt: z.string(),
    current: z.boolean(),
    version: z.int(),
  })
  .meta({ id: 'AttentionReply' });

const Attention = z
  .object({
    id: z.string(),
    kind: z.enum(['agent_question', 'policy_limit', 'manual_approval']),
    question: z.string(),
    replies: z.array(Reply),
    runId: z.string().nullable(),
    status: z.enum(['open', 'answered', 'resuming', 'resolved', 'cancelled']),
  })
  .meta({ id: 'Attention' });

const Usage = z
  .object({
    costUsd: z.number(),
    tokensCacheRead: z.int(),
    tokensCacheWrite: z.int(),
    tokensInput: z.int(),
    tokensOutput: z.int(),
    tokensTotal: z.int(),
  })
  .meta({ id: 'Usage' });

const TicketDetail = TicketSummary.extend({
  attention: z.array(Attention),
  tasks: z.array(Task),
  usage: Usage,
}).meta({ id: 'TicketDetail' });

const ValidationCheck = z
  .object({
    command: z.string().nullable(),
    durationMs: z.int().nullable(),
    exitCode: z.int().nullable(),
    kind: z.string(),
    name: z.string(),
    status: z.enum(['passed', 'failed', 'error', 'skipped']),
  })
  .meta({ id: 'ValidationCheck' });

const Validation = z
  .object({
    attempt: z.int(),
    checks: z.array(ValidationCheck),
    status: z.enum(['pending', 'running', 'passed', 'failed', 'error']),
    summary: z.string().nullable(),
  })
  .meta({ id: 'Validation' });

const ReviewFinding = z.object({
  blocking: z.boolean(),
  evidence: z.string(),
  finding: z.string(),
  id: z.string(),
  location: z.string().nullable(),
  number: z.int(),
  severity: z.enum(['critical', 'major', 'minor']),
  suggestion: z.string().nullable(),
  title: z.string(),
});

const Review = z
  .object({
    findings: z.array(ReviewFinding),
    round: z.int(),
    summary: z.string(),
    verdict: z.enum(['approve', 'changes_requested', 'blocked']),
  })
  .meta({ id: 'Review' });

const Run = z
  .object({
    activity: z.string().nullable().meta({
      description: "The agent's latest assistant message in this run, from its session file.",
    }),
    endedAt: z.string().nullable(),
    id: z.string(),
    model: z.string(),
    outcome: z.string().meta({ description: 'What the run led to, as the status cards say it.' }),
    purpose: z.string(),
    review: Review.nullable(),
    round: z.int(),
    sequence: z.int(),
    sessionFile: z.string().nullable().meta({
      description: "The Pi session file of the run's session. Open it with `pi --session`.",
    }),
    stage: z.enum(stageNames),
    startedAt: z.string().nullable(),
    status: z.enum(['prepared', 'starting', 'running', 'terminal']),
    task: z.string().nullable(),
    terminalKind: z.string().nullable(),
    thinking: z.string(),
    ticket: TicketKey,
    usage: Usage.nullable(),
    validation: Validation.nullable().meta({ description: 'The latest validation attempt.' }),
  })
  .meta({ id: 'Run' });

const Agent = z
  .object({
    activity: z.string().nullable(),
    model: z.string(),
    paneName: z.string().nullable(),
    runId: z.string(),
    sessionFile: z.string().nullable(),
    stage: z.enum(stageNames),
    startedAt: z.string().nullable(),
    task: z.string().nullable(),
    ticket: TicketKey,
  })
  .meta({ id: 'Agent' });

function page<T extends z.ZodType>(item: T, id: string) {
  return z
    .object({
      items: z.array(item),
      nextCursor: z
        .string()
        .nullable()
        .meta({ description: 'Pass as `cursor` for the next page; null on the last.' }),
    })
    .meta({ id });
}

const PagedQuery = {
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
};

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset })).toString('base64url');
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) {
    return 0;
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'offset' in parsed &&
      Number.isInteger(parsed.offset) &&
      Number(parsed.offset) >= 0
    ) {
      return Number(parsed.offset);
    }
  } catch {
    // Not one of ours.
  }
  throw new ProblemError('validation_error', 'The cursor is not valid.', [
    { message: 'Use the nextCursor of the previous page.', path: 'query.cursor' },
  ]);
}

function executionTimes(
  db: DatabaseSync,
  executionId: string,
): { createdAt: string; finishedAt: string | null; updatedAt: string } {
  const found = db
    .prepare('SELECT created_at, updated_at, finished_at FROM ticket_executions WHERE id = ?')
    .get(executionId);
  return {
    createdAt: String(found?.['created_at'] ?? ''),
    finishedAt: found?.['finished_at'] == null ? null : String(found['finished_at']),
    updatedAt: String(found?.['updated_at'] ?? ''),
  };
}

function startedBy(db: DatabaseSync, executionId: string): z.infer<typeof Actor> | null {
  const found = db
    .prepare(
      `SELECT actor, actor_on_behalf_of FROM events
       WHERE execution_id = ? AND kind = 'start' AND actor IS NOT NULL
       ORDER BY revision LIMIT 1`,
    )
    .get(executionId);
  return found === undefined
    ? null
    : {
        client: String(found['actor']),
        onBehalfOf:
          found['actor_on_behalf_of'] == null ? null : String(found['actor_on_behalf_of']),
      };
}

function pullRequestOf(
  db: DatabaseSync,
  executionId: string,
): z.infer<typeof TicketSummary>['pullRequest'] {
  const found = db
    .prepare('SELECT url, number, state, merged_at FROM pull_requests WHERE execution_id = ?')
    .get(executionId);
  return found === undefined
    ? null
    : {
        mergedAt: found['merged_at'] == null ? null : String(found['merged_at']),
        number: found['number'] == null ? null : Number(found['number']),
        state: String(found['state']) as 'closed' | 'merged' | 'open',
        url: String(found['url']),
      };
}

function summaryOf(db: DatabaseSync, snapshot: FactorySnapshot): z.infer<typeof TicketSummary> {
  const progress = ticketProgress(snapshot);
  const { execution, ticket } = snapshot;
  return {
    ...executionTimes(db, execution.id),
    displayRef: ticket.displayRef,
    execution: execution.generation,
    id: ticket.id,
    key: ticketKeyOf(snapshot),
    needsUser: needsUser(snapshot),
    progress: {
      current: progress.current,
      done: progress.done,
      next: progress.next,
      total: progress.total,
    },
    pullRequest: pullRequestOf(db, execution.id),
    sourceRef: ticket.sourceRef,
    stage: execution.stage,
    startedBy: startedBy(db, execution.id),
    status: execution.status,
    statusReason: execution.statusReason,
    title: ticket.title,
    trackerWarnings: db
      .prepare(
        `SELECT last_error FROM actions
         WHERE execution_id = ? AND kind = 'update_ticket_source' AND status = 'failed'
         ORDER BY created_at`,
      )
      .all(execution.id)
      .map((item) => String(item['last_error'] ?? 'Tracker update failed.')),
  };
}

const noUsage = {
  costUsd: 0,
  tokensCacheRead: 0,
  tokensCacheWrite: 0,
  tokensInput: 0,
  tokensOutput: 0,
  tokensTotal: 0,
};

function usageFrom(
  found: Record<string, unknown> | undefined,
  prefix: string,
): z.infer<typeof Usage> {
  if (found === undefined) {
    return noUsage;
  }
  const number = (key: string) => Number(found[`${prefix}${key}`] ?? 0);
  return {
    costUsd: number('cost_usd_micros') / 1_000_000,
    tokensCacheRead: number('tokens_cache_read'),
    tokensCacheWrite: number('tokens_cache_write'),
    tokensInput: number('tokens_input'),
    tokensOutput: number('tokens_output'),
    tokensTotal: number('tokens_total'),
  };
}

function detailOf(db: DatabaseSync, snapshot: FactorySnapshot): z.infer<typeof TicketDetail> {
  const replyTimes = new Map(
    db
      .prepare(
        `SELECT r.id, r.created_at FROM attention_replies AS r
         JOIN attention_requests AS q ON q.id = r.request_id WHERE q.execution_id = ?`,
      )
      .all(snapshot.execution.id)
      .map((item) => [String(item['id']), String(item['created_at'])]),
  );
  return {
    ...summaryOf(db, snapshot),
    attention: snapshot.attention.map((item) => ({
      id: item.id,
      kind: item.kind,
      question: item.question,
      replies: snapshot.replies
        .filter((reply) => reply.requestId === item.id)
        .map((reply) => ({
          actor: reply.actor,
          answer: reply.answer,
          createdAt: replyTimes.get(reply.id) ?? '',
          current: reply.isCurrent,
          version: reply.version,
        })),
      runId: item.runId,
      status: item.status,
    })),
    tasks: snapshot.tasks.map((task) => ({
      blockedBy: task.blockedBy,
      id: task.taskId,
      ordinal: task.ordinal,
      stage: task.stage,
      status: task.status,
      summaries: task.summaries,
      title: task.title,
    })),
    usage: usageFrom(
      db
        .prepare('SELECT * FROM execution_usage_totals WHERE execution_id = ?')
        .get(snapshot.execution.id),
      '',
    ),
  };
}

function activityOf(sessionFile: string | null, runId: string): string | null {
  if (sessionFile === null) {
    return null;
  }
  let jsonl: string;
  try {
    jsonl = readFileSync(sessionFile, 'utf8');
  } catch {
    return null;
  }
  const text = runAssistantText(jsonl, runId).trim();
  return text.length === 0 ? null : text.slice(-ACTIVITY_MAX);
}

function reviewOf(run: RunRecord): z.infer<typeof Review> | null {
  if (runVerdict(run) === null || run.resultJson === null) {
    return null;
  }
  const parsed: unknown = JSON.parse(run.resultJson);
  const review =
    typeof parsed === 'object' && parsed !== null && 'review' in parsed ? parsed.review : null;
  const checked = Review.safeParse(review);
  return checked.success ? checked.data : null;
}

function validationOf(db: DatabaseSync, runId: string): z.infer<typeof Validation> | null {
  const latest = db
    .prepare(
      'SELECT id, attempt, status, summary FROM validation_runs WHERE run_id = ? ORDER BY attempt DESC LIMIT 1',
    )
    .get(runId);
  if (latest === undefined) {
    return null;
  }
  const checks = db
    .prepare(
      'SELECT name, kind, status, command, exit_code, duration_ms FROM validation_checks WHERE validation_id = ? ORDER BY ordinal',
    )
    .all(String(latest['id']))
    .map((item) => ({
      command: item['command'] == null ? null : String(item['command']),
      durationMs: item['duration_ms'] == null ? null : Number(item['duration_ms']),
      exitCode: item['exit_code'] == null ? null : Number(item['exit_code']),
      kind: String(item['kind']),
      name: String(item['name']),
      status: String(item['status']) as z.infer<typeof ValidationCheck>['status'],
    }));
  return {
    attempt: Number(latest['attempt']),
    checks,
    status: String(latest['status']) as z.infer<typeof Validation>['status'],
    summary: latest['summary'] == null ? null : String(latest['summary']),
  };
}

function runOf(db: DatabaseSync, snapshot: FactorySnapshot, run: RunRecord): z.infer<typeof Run> {
  const session = snapshot.sessions.find((item) => item.id === run.sessionId);
  const usage = db.prepare('SELECT * FROM usage_snapshots WHERE run_id = ?').get(run.id);
  return {
    activity: activityOf(session?.sessionFile ?? null, run.id),
    endedAt: run.endedAt,
    id: run.id,
    model: session?.model ?? '',
    outcome: runOutcome(snapshot, run),
    purpose: run.purpose,
    review: reviewOf(run),
    round: run.semanticRound,
    sequence: run.sequence,
    sessionFile: session?.sessionFile ?? null,
    stage: session?.stage ?? 'plan',
    startedAt: run.startedAt,
    status: run.status,
    task: session?.taskId ?? null,
    terminalKind: run.terminalKind,
    thinking: session?.thinking ?? '',
    ticket: ticketKeyOf(snapshot),
    usage: usage === undefined ? null : usageFrom(usage, 'delta_'),
    validation: validationOf(db, run.id),
  };
}

// The ticket's current generation, or generation `execution` when given.
function ticketByKey(db: DatabaseSync, key: string, execution?: number): FactorySnapshot {
  const snapshot = loadCurrentByFactoryKey(db, key);
  if (snapshot === null) {
    throw new ProblemError('ticket_not_found', `No ticket ${key}.`);
  }
  if (execution === undefined || execution === snapshot.execution.generation) {
    return snapshot;
  }
  const older = loadGeneration(db, snapshot.ticket.id, execution);
  if (older === null) {
    throw new ProblemError('not_found', `Ticket ${key} has no execution ${execution}.`);
  }
  return older;
}

const ExecutionQuery = {
  execution: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .meta({ description: 'A generation of the ticket; the current one by default.' }),
};

const Execution = z
  .object({
    createdAt: z.string(),
    current: z.boolean(),
    finishedAt: z.string().nullable(),
    generation: z.int().positive(),
    stage: z.enum(ticketStages),
    status: z.enum(executionStatuses),
    statusReason: z.string().nullable(),
  })
  .meta({ id: 'Execution' });

function currentTickets(db: DatabaseSync): Array<FactorySnapshot> {
  return listCurrentTicketRefs(db).flatMap((ref) => {
    const snapshot = loadCurrentByTicketKey(db, ref);
    return snapshot === null ? [] : [snapshot];
  });
}

function finished(snapshot: FactorySnapshot): boolean {
  return snapshot.execution.stage === 'done';
}

const listTickets = defineRoute({
  handler: ({ context, query }) => {
    const db = database(context);
    const matches = currentTickets(db)
      .filter((snapshot) =>
        query.status === 'all'
          ? true
          : query.status === 'finished'
            ? finished(snapshot)
            : !finished(snapshot),
      )
      .filter(
        (snapshot) => query.stage.length === 0 || query.stage.includes(snapshot.execution.stage),
      )
      .filter(
        (snapshot) => query.state.length === 0 || query.state.includes(snapshot.execution.status),
      )
      .filter(
        (snapshot) => query.needsUser === undefined || needsUser(snapshot) === query.needsUser,
      )
      .filter(
        (snapshot) =>
          query.ref === undefined ||
          [
            snapshot.ticket.displayRef,
            snapshot.ticket.sourceRef,
            snapshot.ticket.commandRef,
          ].includes(query.ref),
      )
      .map((snapshot) => summaryOf(db, snapshot))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    // Open tickets are few; finished ones grow without bound, so they page.
    if (query.status === 'open') {
      return { body: { items: matches, nextCursor: null }, status: 200 };
    }
    const offset = decodeCursor(query.cursor);
    const items = matches.slice(offset, offset + query.limit);
    const next = offset + query.limit < matches.length ? encodeCursor(offset + query.limit) : null;
    return { body: { items, nextCursor: next }, status: 200 };
  },
  method: 'GET',
  operationId: 'listTickets',
  path: '/v1/tickets',
  request: {
    query: z.object({
      ...PagedQuery,
      needsUser: z
        .enum(['true', 'false'])
        .optional()
        .transform((value) => (value === undefined ? undefined : value === 'true'))
        .meta({ description: 'Only tickets waiting on a person (or not).' }),
      ref: z.string().optional().meta({ description: 'A ticket ref, such as owner/repo#42.' }),
      stage: many(z.enum(ticketStages)).meta({ description: 'Repeat for any of several stages.' }),
      state: many(z.enum(executionStatuses)).meta({
        description: 'Repeat for any of several execution statuses.',
      }),
      status: z
        .enum(['open', 'finished', 'all'])
        .default('open')
        .meta({ description: 'Finished tickets have reached the done stage. They page.' }),
    }),
  },
  responses: {
    200: {
      description: 'Matching tickets, newest change first.',
      schema: page(TicketSummary, 'TicketPage'),
    },
  },
  scope: 'read',
  summary: 'List tickets, filtered by status, stage, state, or whether they need a person',
  tags: ['tickets'],
});

const getTicket = defineRoute({
  handler: ({ context, params, query }) => {
    const db = database(context);
    return { body: detailOf(db, ticketByKey(db, params.key, query.execution)), status: 200 };
  },
  method: 'GET',
  operationId: 'getTicket',
  path: '/v1/tickets/{key}',
  request: { params: TicketParams, query: z.object(ExecutionQuery) },
  responses: {
    200: { description: 'The ticket with its tasks, questions, and usage.', schema: TicketDetail },
  },
  scope: 'read',
  summary: 'Get a ticket',
  tags: ['tickets'],
});

const listRuns = defineRoute({
  handler: ({ context, params, query }) => {
    const db = database(context);
    const snapshot = ticketByKey(db, params.key, query.execution);
    const runs = [...snapshot.runs].sort((left, right) => left.sequence - right.sequence);
    const offset = decodeCursor(query.cursor);
    const items = runs.slice(offset, offset + query.limit).map((run) => runOf(db, snapshot, run));
    const next = offset + query.limit < runs.length ? encodeCursor(offset + query.limit) : null;
    return { body: { items, nextCursor: next }, status: 200 };
  },
  method: 'GET',
  operationId: 'listTicketRuns',
  path: '/v1/tickets/{key}/runs',
  request: { params: TicketParams, query: z.object({ ...PagedQuery, ...ExecutionQuery }) },
  responses: {
    200: { description: "The ticket's runs, oldest first.", schema: page(Run, 'RunPage') },
  },
  scope: 'read',
  summary: "List a ticket's runs",
  tags: ['runs'],
});

const listExecutions = defineRoute({
  handler: ({ context, params }) => {
    const db = database(context);
    const ticket = ticketByKey(db, params.key).ticket;
    const items = db
      .prepare(
        `SELECT generation, stage, status, status_reason, created_at, finished_at, is_current
         FROM ticket_executions WHERE ticket_id = ? ORDER BY generation`,
      )
      .all(ticket.id)
      .map((item) => ({
        createdAt: String(item['created_at']),
        current: Number(item['is_current']) === 1,
        finishedAt: item['finished_at'] == null ? null : String(item['finished_at']),
        generation: Number(item['generation']),
        stage: String(item['stage']) as z.infer<typeof Execution>['stage'],
        status: String(item['status']) as z.infer<typeof Execution>['status'],
        statusReason: item['status_reason'] == null ? null : String(item['status_reason']),
      }));
    return { body: { items }, status: 200 };
  },
  method: 'GET',
  operationId: 'listTicketExecutions',
  path: '/v1/tickets/{key}/executions',
  request: { params: TicketParams },
  responses: {
    200: {
      description: "The ticket's generations, oldest first; reruns add one each.",
      schema: z.object({ items: z.array(Execution) }).meta({ id: 'ExecutionList' }),
    },
  },
  scope: 'read',
  summary: "List a ticket's executions",
  tags: ['tickets'],
});

const getRun = defineRoute({
  handler: ({ context, params }) => {
    const db = database(context);
    const found = db.prepare('SELECT execution_id FROM agent_runs WHERE id = ?').get(params.id);
    const key =
      found === undefined
        ? null
        : currentTickets(db).find((item) => item.execution.id === String(found['execution_id']));
    const run = key?.runs.find((item) => item.id === params.id);
    if (key === undefined || key === null || run === undefined) {
      throw new ProblemError('not_found', `No run ${params.id}.`);
    }
    return { body: runOf(db, key, run), status: 200 };
  },
  method: 'GET',
  operationId: 'getRun',
  path: '/v1/runs/{id}',
  request: { params: z.object({ id: z.string() }) },
  responses: { 200: { description: 'The run.', schema: Run } },
  scope: 'read',
  summary: 'Get a run',
  tags: ['runs'],
});

const listAgents = defineRoute({
  handler: ({ context }) => {
    const db = database(context);
    const agents = currentTickets(db).flatMap((snapshot) =>
      snapshot.runs
        .filter((run) => run.status === 'running' || run.status === 'starting')
        .map((run) => {
          const session = snapshot.sessions.find((item) => item.id === run.sessionId);
          const task = snapshot.tasks.find((item) => item.taskId === session?.taskId);
          return {
            activity: activityOf(session?.sessionFile ?? null, run.id),
            model: session?.model ?? '',
            paneName: run.paneName,
            runId: run.id,
            sessionFile: session?.sessionFile ?? null,
            stage: session?.stage ?? 'plan',
            startedAt: run.startedAt,
            task: task?.title ?? null,
            ticket: ticketKeyOf(snapshot),
          };
        }),
    );
    return { body: { items: agents }, status: 200 };
  },
  method: 'GET',
  operationId: 'listAgents',
  path: '/v1/agents',
  responses: {
    200: {
      description: 'Agents whose runs are starting or running.',
      schema: z.object({ items: z.array(Agent) }).meta({ id: 'AgentList' }),
    },
  },
  scope: 'read',
  summary: 'List running agents',
  tags: ['agents'],
});

export const readRoutes = [listTickets, getTicket, listExecutions, listRuns, getRun, listAgents];
