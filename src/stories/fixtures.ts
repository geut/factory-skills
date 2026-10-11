import { DEFAULT_LIMITS } from '../config.ts';
import {
  actionId,
  attentionId,
  executionId,
  runId,
  sessionId,
  taskId,
  ticketId,
  zeroUsage,
  type FactorySnapshot,
  type ReviewVerdict,
  type RunPurpose,
  type RunRecord,
  type SessionRecord,
  type TaskRecord,
  type TaskStatus,
  type TerminalOutcome,
} from '../domain.ts';
import type { WidgetChild } from '../extension/widget.ts';
import { stages } from '../stages/index.ts';
import { parseReview } from '../stages/review/parse.ts';

// Snapshots for the component gallery. They are built by hand, field by
// field, so every scenario is a plain value that renders without a database.

export const NOW = Date.parse('2026-10-09T15:00:00.000Z');

export function at(minutesAgo: number): string {
  return new Date(NOW - minutesAgo * 60_000).toISOString();
}

const titles = [
  'Read-only v2 connection, schema guard, scratch fixture, and error page',
  'Typed read module over the controller views',
  'Overview page (`/`) on the v2 read module',
  'Ticket detail page (`/tickets/[slug]`) on the v2 read module',
  'Contract: delete the legacy data layer and supersede the fstate ADRs',
  'Regenerate `verify-factory-dashboard` without `fstate seed`',
];

const dependencies: Record<string, Array<string>> = {
  '01': [],
  '02': ['01'],
  '03': ['02'],
  '04': ['02'],
  '05': ['03', '04'],
  '06': ['05'],
};

export function blank(input: { displayRef?: string; title?: string } = {}): FactorySnapshot {
  const displayRef = input.displayRef ?? 'dpaez/factory-dashboard#11';
  return {
    actions: [],
    attention: [],
    execution: {
      factoryDir: '/repo/.factory',
      generation: 1,
      id: executionId('exec-1'),
      inputFetchedAt: at(240),
      inputHash: 'hash',
      inputJson: '{}',
      message: null,
      planPath: '.factory/tickets/dpaez-factory-dashboard-11/plan.md',
      policy: {
        codeRoot: '/repo',
        labels: { map: {} },
        limits: { ...DEFAULT_LIMITS },
        models: { plan: 'qwen3.8-max', review: 'kimi-k3', work: 'qwen3.8-max' },
        pullRequests: false,
        validation: { work: { commands: [] }, wrapup: { generated: [] } },
      },
      retryable: false,
      stage: 'plan',
      status: 'active',
      statusReason: null,
      statusReasonCode: null,
      ticketId: ticketId('ticket-11'),
      version: 1,
      worktreeBaseBranch: 'main',
      worktreeBaseSha: null,
      worktreeBranch: 'factory/dpaez-factory-dashboard-11',
      worktreePath: '/repo/.factory/worktrees/dpaez-factory-dashboard-11',
      worktreeStatus: 'ready',
    },
    replies: [],
    runs: [],
    sessions: [],
    tasks: [],
    ticket: {
      body: '',
      commandRef: displayRef,
      displayRef,
      id: ticketId('ticket-11'),
      labels: [],
      sourceHash: 'hash',
      sourceKind: 'github',
      sourceRef: displayRef,
      title: input.title ?? 'Migrate the dashboard data layer to factory state schema v2',
    },
  };
}

export function addTasks(snapshot: FactorySnapshot, count = 6, longTitles = false): void {
  for (let index = 0; index < count; index += 1) {
    const id = String(index + 1).padStart(2, '0');
    const title = titles[index] ?? `Task ${id}`;
    snapshot.tasks.push({
      blockedBy: (dependencies[id] ?? []).map((item) => taskId(item)),
      blockingCount: null,
      findingCount: null,
      ordinal: index + 1,
      reviewRound: 0,
      reviewVerdict: null,
      specHash: null,
      status: 'pending',
      taskFile: `tickets/dpaez-factory-dashboard-11/${id}-task.md`,
      taskId: taskId(id),
      title: longTitles
        ? `${title}, with a much longer explanation of the acceptance criteria`
        : title,
    });
  }
}

export function task(snapshot: FactorySnapshot, id: string): TaskRecord {
  const found = snapshot.tasks.find((item) => item.taskId === id);
  if (found === undefined) {
    throw new Error(`missing fixture task ${id}`);
  }
  return found;
}

export function setTask(
  snapshot: FactorySnapshot,
  id: string,
  status: TaskStatus,
  review: {
    blocking?: number;
    findings?: number;
    round: number;
    verdict: ReviewVerdict;
  } | null = null,
): void {
  const found = task(snapshot, id);
  found.status = status;
  if (review !== null) {
    found.reviewRound = review.round;
    found.reviewVerdict = review.verdict;
    found.findingCount = review.findings ?? 0;
    found.blockingCount = review.blocking ?? 0;
  }
}

export function session(
  snapshot: FactorySnapshot,
  stage: SessionRecord['stage'],
  forTask: string | null = null,
): SessionRecord {
  const key = forTask === null ? stage : `${stage}:${forTask}`;
  const existing = snapshot.sessions.find((item) => item.logicalKey === key);
  if (existing !== undefined) {
    return existing;
  }
  const created: SessionRecord = {
    id: sessionId(`session-${key}`),
    logicalKey: key,
    model: stage === 'review' ? 'kimi-k3' : 'qwen3.8-max',
    piSessionId: null,
    sessionFile: `/repo/.factory/sessions/${key.replace(':', '-')}.jsonl`,
    stage,
    status: 'open',
    taskId: forTask === null ? null : taskId(forTask),
    thinking: 'medium',
  };
  snapshot.sessions.push(created);
  return created;
}

export type RunInput = {
  minutesAgo?: number;
  output?: string;
  parent?: RunRecord;
  purpose?: RunPurpose;
  round?: number;
  // null leaves the run running.
  terminal?: TerminalOutcome['kind'] | null;
};

export function run(
  snapshot: FactorySnapshot,
  owner: SessionRecord,
  input: RunInput = {},
): RunRecord {
  const sequence = snapshot.runs.filter((item) => item.sessionId === owner.id).length + 1;
  const terminal = input.terminal === undefined ? 'subagent_done' : input.terminal;
  const output = input.output ?? '';
  const round = input.round ?? 0;
  const parsed =
    owner.stage === 'review' && terminal === 'subagent_done' ? parseReview(output, round) : null;
  const created: RunRecord = {
    baseline: null,
    description: null,
    diffHash: null,
    endedAt: terminal === null ? null : at((input.minutesAgo ?? 5) - 4),
    id: runId(`run-${owner.logicalKey}-${sequence}`),
    inputHash: null,
    paneId: `pane-${snapshot.runs.length + 1}`,
    paneName: `${owner.stage} ${snapshot.ticket.displayRef}`,
    parentRunId: input.parent?.id ?? null,
    purpose: input.purpose ?? 'initial',
    resultContract: null,
    resultError: parsed?.kind === 'invalid' ? parsed.failures.join('\n') : null,
    resultHash: null,
    resultJson:
      terminal === 'subagent_done'
        ? JSON.stringify(parsed?.kind === 'valid' ? { output, review: parsed.result } : { output })
        : null,
    resultStatus: parsed === null ? 'pending' : parsed.kind === 'valid' ? 'valid' : 'invalid',
    semanticRound: round,
    sequence,
    sessionId: owner.id,
    startedAt: at(input.minutesAgo ?? 5),
    status: terminal === null ? 'running' : 'terminal',
    subagentId: null,
    terminalKind: terminal,
  };
  snapshot.runs.push(created);
  return created;
}

export function terminalOf(value: RunRecord, question = ''): TerminalOutcome {
  const output = (() => {
    try {
      const parsed: unknown = JSON.parse(value.resultJson ?? '{}');
      return typeof parsed === 'object' &&
        parsed !== null &&
        'output' in parsed &&
        typeof parsed.output === 'string'
        ? parsed.output
        : '';
    } catch {
      return '';
    }
  })();
  switch (value.terminalKind) {
    case 'caller_ping':
      return { kind: 'caller_ping', question, usage: zeroUsage() };
    case 'subagent_done':
    case null:
      return { kind: 'subagent_done', output, usage: zeroUsage() };
    default:
      return { kind: value.terminalKind, message: 'The pane closed before subagent_done.' };
  }
}

export function staleAction(snapshot: FactorySnapshot, work: RunRecord, review: RunRecord): void {
  snapshot.actions.push({
    attempts: 1,
    attentionReplyId: null,
    attentionRequestId: null,
    id: actionId(`action-${snapshot.actions.length + 1}`),
    idempotencyKey: `validate:${work.id}:stale:${review.id}`,
    kind: 'validate_run',
    lastError: null,
    maxAttempts: 3,
    retryOfActionId: null,
    runId: work.id,
    status: 'succeeded',
  });
}

export function pause(
  snapshot: FactorySnapshot,
  input: {
    code: string;
    question: string;
    retryable?: boolean;
    runId?: RunRecord | null;
    waiting?: boolean;
  },
): void {
  snapshot.execution.status = input.waiting === true ? 'waiting_for_user' : 'paused';
  snapshot.execution.statusReasonCode = input.code;
  snapshot.execution.statusReason = input.question;
  snapshot.execution.retryable = input.retryable ?? false;
  snapshot.attention.push({
    id: attentionId(`attention-${snapshot.attention.length + 1}`),
    kind: input.waiting === true ? 'agent_question' : 'policy_limit',
    question: input.question,
    runId: input.runId?.id ?? null,
    status: 'open',
  });
}

export function review(
  verdict: string,
  findings = 'none',
  summary = 'Checked the diff against the task file.',
): string {
  return `## Verdict\n\n${verdict}\n\n## Summary\n\n${summary}\n\n## Findings\n\n${findings}\n`;
}

export const majorFinding = `### 1. [Major] Missing DB_URL bypasses the typed error page

**Location:** src/lib/server/client.ts:36
**Finding:** getDb() throws a plain Error, so SvelteKit shows "Internal Error".
**Evidence:** throwKitError only maps DashboardDatabaseError.
**Suggestion:** Route the missing DB_URL failure through the typed error.`;

export const secondMajor = `### 2. [Critical] The detail lookup can return a ticket with id "undefined"

**Location:** src/lib/server/read.ts:88
**Finding:** db.get can return undefined after a supersede.
**Evidence:** The result is cast without a check.`;

export const minorFinding = `### 3. [Minor] Unclear variable name

**Location:** src/lib/server/read.ts:12
**Finding:** \`r\` hides what it holds.
**Evidence:** It is read in four places.`;

// Plan finished: six tasks, task 01 ready.
export function planned(input: { longTitles?: boolean } = {}): {
  run: RunRecord;
  snapshot: FactorySnapshot;
} {
  const snapshot = blank();
  addTasks(snapshot, 6, input.longTitles === true);
  const plan = run(snapshot, session(snapshot, 'plan'), {
    minutesAgo: 240,
    output: '## Status\n\nplanned\n\n## Ready\n\n01',
  });
  snapshot.execution.stage = 'work';
  return { run: plan, snapshot };
}

// Tasks 01 and 02 approved; 03 is the current task.
export function third(): FactorySnapshot {
  const { snapshot } = planned();
  setTask(snapshot, '01', 'done', { round: 1, verdict: 'approve' });
  setTask(snapshot, '02', 'done', { findings: 1, round: 1, verdict: 'approve' });
  for (const [index, id] of ['01', '02'].entries()) {
    run(snapshot, session(snapshot, 'work', id), {
      minutesAgo: 220 - index * 60,
      output: 'ready_for_review',
    });
    run(snapshot, session(snapshot, 'review', id), {
      minutesAgo: 190 - index * 60,
      output: review('approve'),
      round: 1,
    });
  }
  snapshot.execution.stage = 'work';
  setTask(snapshot, '03', 'working');
  return snapshot;
}

// A running child as the widget and the agents view see it.
export function child(
  snapshot: FactorySnapshot,
  value: RunRecord,
  overrides: Partial<WidgetChild> = {},
): WidgetChild {
  const owner = snapshot.sessions.find((item) => item.id === value.sessionId);
  const forTask =
    owner?.taskId === null || owner === undefined
      ? null
      : (snapshot.tasks.find((item) => item.taskId === owner.taskId) ?? null);
  const glyph = stages[owner?.stage ?? 'plan'].emoji;
  return {
    activity: owner?.stage === 'review' ? 'reading src/lib/server/read.ts…' : 'running npm test…',
    context: '67K/200K ctx (33.5%)',
    description: forTask === null ? snapshot.ticket.title : null,
    model: owner?.model ?? 'qwen3.8-max',
    paneName: `${glyph} ${snapshot.ticket.displayRef}${forTask === null ? '' : ` ${String(forTask.ordinal).padStart(2, '0')}`}`,
    sessionFile: owner?.sessionFile ?? null,
    startedAt: value.startedAt,
    tasksLeft:
      forTask === null ? null : snapshot.tasks.filter((item) => item.status !== 'done').length,
    taskTitle: forTask?.title ?? null,
    toolUses: 12,
    ...overrides,
  };
}

// A bare action, for the run-card checks that look actions up by key.
export function action(
  snapshot: FactorySnapshot,
  idempotencyKey: string,
  kind: 'open_diff' | 'open_pane' | 'prepare_input',
  forRun: RunRecord | null,
  failures: Array<string> = [],
): void {
  const base = {
    attempts: 0,
    attentionReplyId: null,
    attentionRequestId: null,
    id: actionId(`action-${snapshot.actions.length + 1}`),
    idempotencyKey,
    lastError: null,
    maxAttempts: 3,
    retryOfActionId: null,
    status: 'pending' as const,
  };
  if (kind === 'prepare_input') {
    snapshot.actions.push({
      ...base,
      failures,
      kind,
      purpose: 'validation_correction',
      runId: null,
      stage: 'wrapup',
      taskId: null,
    });
    return;
  }
  if (forRun === null) {
    throw new Error('a pane action needs its run');
  }
  if (kind === 'open_pane') {
    snapshot.actions.push({
      ...base,
      kind,
      name: '📦 dpaez/factory-dashboard#11',
      runId: forRun.id,
    });
    return;
  }
  snapshot.actions.push({
    ...base,
    cwd: snapshot.execution.worktreePath ?? '/repo',
    kind,
    name: '🔀 dpaez/factory-dashboard#11',
    runId: forRun.id,
  });
}
