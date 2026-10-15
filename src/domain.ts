import { randomUUID } from 'node:crypto';
import type { InternalLabel, Limits, Validation } from './config.ts';
import type { StageSettings } from './stages/definition.ts';
import type { InputStage, PreparedInput, StageReports } from './stages/index.ts';
import type { ValidationReport } from './validation/report.ts';

export type TicketId = string & { readonly __brand: 'TicketId' };
export type ExecutionId = string & { readonly __brand: 'ExecutionId' };
export type SessionId = string & { readonly __brand: 'SessionId' };
export type RunId = string & { readonly __brand: 'RunId' };
export type ActionId = string & { readonly __brand: 'ActionId' };
export type AttentionId = string & { readonly __brand: 'AttentionId' };
export type ReplyId = string & { readonly __brand: 'ReplyId' };
export type TaskId = string & { readonly __brand: 'TaskId' };

function brand<B extends string>(value: string): string & { readonly __brand: B } {
  return value as string & { readonly __brand: B };
}

function nonEmpty(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${label} is empty`);
  }
  return trimmed;
}

export function ticketId(value: string): TicketId {
  return brand(nonEmpty(value, 'ticket id'));
}

export function executionId(value: string): ExecutionId {
  return brand(nonEmpty(value, 'execution id'));
}

export function sessionId(value: string): SessionId {
  return brand(nonEmpty(value, 'session id'));
}

export function runId(value: string): RunId {
  return brand(nonEmpty(value, 'run id'));
}

export function actionId(value: string): ActionId {
  return brand(nonEmpty(value, 'action id'));
}

export function attentionId(value: string): AttentionId {
  return brand(nonEmpty(value, 'attention id'));
}

export function replyId(value: string): ReplyId {
  return brand(nonEmpty(value, 'reply id'));
}

export function taskId(value: string): TaskId {
  return brand(nonEmpty(value, 'task id'));
}

export type IdSource = {
  action: () => ActionId;
  attention: () => AttentionId;
  event: () => string;
  execution: () => ExecutionId;
  reply: () => ReplyId;
  run: () => RunId;
  session: () => SessionId;
};

export function randomIds(): IdSource {
  return {
    action: () => actionId(randomUUID()),
    attention: () => attentionId(randomUUID()),
    event: () => randomUUID(),
    execution: () => executionId(randomUUID()),
    reply: () => replyId(randomUUID()),
    run: () => runId(randomUUID()),
    session: () => sessionId(randomUUID()),
  };
}

export function sequentialIds(prefix: string): IdSource {
  const counters = new Map<string, number>();
  const next = (label: string): string => {
    const value = (counters.get(label) ?? 0) + 1;
    counters.set(label, value);
    return `${prefix}-${label}-${value}`;
  };
  return {
    action: () => actionId(next('action')),
    attention: () => attentionId(next('attention')),
    event: () => next('event'),
    execution: () => executionId(next('execution')),
    reply: () => replyId(next('reply')),
    run: () => runId(next('run')),
    session: () => sessionId(next('session')),
  };
}

// A validator's report on a run, typed by the stage whose validator wrote it.
export type ValidationFinished = {
  [S in StageName]: {
    actionId: ActionId;
    kind: 'validation_finished';
    report: StageReports[S];
    runId: RunId;
    stage: S;
  };
}[StageName];

// One check of a passed validation, as a later stage reads it back.
export type PassedCheck = {
  command: string | null;
  evidencePath: string | null;
  kind: string;
  name: string;
  status: string;
  taskId: TaskId | null;
};

// A prepared input, typed by the stage that asked for it.
export type InputReady = {
  [S in InputStage]: { actionId: ActionId; input: PreparedInput[S]; kind: 'input_ready'; stage: S };
}[InputStage];

export type Stage = StageName | 'done';
// A stage an agent runs; `done` is only an execution's position after the last one.
export type StageName = 'plan' | 'work' | 'qa' | 'review' | 'wrapup';
export type ExecutionStatus =
  | 'queued'
  | 'active'
  | 'waiting_for_user'
  | 'paused'
  | 'resuming'
  | 'resume_failed'
  | 'failed'
  | 'ready_for_handoff'
  | 'complete'
  | 'cancelled';
export type TaskStatus = 'pending' | 'active' | 'done' | 'blocked' | 'cancelled';
export type SessionStatus = 'prepared' | 'open' | 'completed' | 'abandoned';
export type RunStatus = 'prepared' | 'starting' | 'running' | 'terminal';
export type RunPurpose =
  | 'initial'
  | 'validation_correction'
  | 'human_reply'
  // Work fixing what a later stage found; `origin` names that stage.
  | 'return_to_work'
  // A later stage running again on a task whose work was returned.
  | 'reentry'
  | 'manual_continue'
  | 'infrastructure_retry';
export type TerminalKind =
  | 'subagent_done'
  | 'caller_ping'
  | 'launch_failed'
  | 'crashed'
  | 'completed_user_exit'
  | 'pane_killed'
  | 'gap_exit'
  | 'cancelled';
export type ActionStatus = 'pending' | 'leased' | 'succeeded' | 'failed' | 'cancelled';
export type AttentionKind = 'agent_question' | 'policy_limit' | 'manual_approval';
export type AttentionStatus = 'open' | 'answered' | 'resuming' | 'resolved' | 'cancelled';
export type WorktreeStatus = 'preparing' | 'ready' | 'removed' | 'failed';

// Why a stage's input is being prepared: the run it is for.
export type InputPurpose = 'initial' | 'validation_correction' | 'human_reply' | 'return_to_work';
export type ReviewVerdict = 'approve' | 'changes_requested' | 'blocked';
export type ReviewSeverity = 'critical' | 'major' | 'minor';

export type Policy = {
  codeRoot: string;
  labels: { map: Record<string, InternalLabel> };
  limits: Limits;
  models: { plan: string; review: string; work: string };
  // `codeHost.pullRequests`: wrap-up may push the branch and open a pull request.
  pullRequests: boolean;
  // Optional stages' settings, by stage name; a stage absent here is off.
  stages: Record<string, StageSettings>;
  validation: Validation;
};

export type UsageTotals = {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  contextTokens: number | null;
  contextWindow: number | null;
  costUsdMicros: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type TerminalOutcome =
  | { kind: 'subagent_done'; output: string; usage: UsageTotals }
  | { kind: 'caller_ping'; question: string; usage: UsageTotals }
  | { kind: 'launch_failed'; message: string }
  | { kind: 'crashed'; message: string }
  | { kind: 'completed_user_exit'; message: string }
  | { kind: 'pane_killed'; message: string }
  | { kind: 'gap_exit'; message: string }
  | { kind: 'cancelled'; message: string };

export type ResolvedTicket = {
  body: string;
  commandRef: string;
  contentHash: string;
  displayRef: string;
  factoryDir: string;
  fetchedAt: string;
  id: TicketId;
  labels: Array<string>;
  // `file`, `text`, or the tracker's kind, such as `github`.
  sourceKind: string;
  sourceRef: string;
  title: string;
};

export type PlannedTask = {
  blockedBy: Array<TaskId>;
  ordinal: number;
  // Optional per-task stages the task file turns off, such as `QA: none`.
  skips: Array<StageName>;
  specHash: string;
  taskFile: string;
  taskId: TaskId;
  title: string;
};

export type PlanValidationReport = ValidationReport<{
  planPath: string;
  tasks: Array<PlannedTask>;
}>;

// The diff is the worktree after the validation commands ran.
export type WorkValidationReport = ValidationReport<{ diff: string }>;

export type ReviewFinding = {
  blocking: boolean;
  evidence: string;
  finding: string;
  id: string;
  location: string | null;
  number: number;
  severity: ReviewSeverity;
  suggestion: string | null;
  title: string;
};

export type ReviewResult = {
  findings: Array<ReviewFinding>;
  round: number;
  summary: string;
  verdict: ReviewVerdict;
};

// `malformed` resumes the reviewer, `stale` re-validates the worker's diff,
// and `unsafe` pauses: the reviewer was not isolated from the worker.
export type ReviewValidationReport = ValidationReport<
  null,
  { reason: 'malformed' | 'stale' | 'unsafe' }
>;

// The all-stage usage table, including the finished wrap-up run.
export type WrapupValidationReport = ValidationReport<{ usage: string }, { usage: string }>;

// What wrap-up validation compares against: taken when the first wrap-up
// input is prepared, before the agent runs.
export type WrapupBaseline = {
  baseHead: string | null;
  branch: string;
  factory: Record<string, string>;
  head: string;
  remotes: Record<string, string>;
  worktree: Record<string, string>;
};

export type ReconcileObservation =
  | {
      kind: 'still_running';
      paneId: string;
      piSessionId: string | null;
      sessionFile: string | null;
    }
  | { kind: 'missing' }
  | { kind: 'terminal'; terminal: TerminalOutcome };

export type ControllerEvent =
  | { kind: 'start'; policy: Policy; ticket: ResolvedTicket }
  | { kind: 'runtime_terminal'; runId: RunId; terminal: TerminalOutcome }
  | ValidationFinished
  | InputReady
  | { actionId: ActionId; kind: 'input_failed'; message: string }
  | { idempotencyKey: string; kind: 'complete'; ticketId: TicketId }
  | {
      actionId: ActionId;
      baseBranch: string;
      baseSha: string;
      branch: string;
      kind: 'worktree_ready';
      worktreePath: string;
    }
  | { actionId: ActionId; kind: 'worktree_failed'; message: string }
  | {
      actionId: ActionId;
      kind: 'run_started';
      paneId: string;
      paneName: string;
      piSessionId: string;
      runId: RunId;
      sessionFile: string;
    }
  | { actionId: ActionId; kind: 'launch_failed'; message: string; runId: RunId }
  | {
      actor?: Actor;
      answer: string;
      idempotencyKey: string;
      kind: 'reply';
      ticketId: TicketId;
    }
  | { idempotencyKey: string; kind: 'retry'; ticketId: TicketId }
  | { kind: 'reconciled'; observation: ReconcileObservation; runId: RunId };

export type ControllerResponse =
  | {
      displayRef: string;
      kind: 'status';
      message: string;
      // The command the user is expected to run next, if any.
      next: string | null;
      progress: string | null;
      question: string | null;
      retryHint: string | null;
      stage: Stage;
      status: ExecutionStatus;
      // The current task, as `03/06 Title` plus its step (`review r1`).
      task: string | null;
    }
  | { kind: 'rejected'; message: string };

export type TicketRecord = {
  body: string;
  commandRef: string;
  displayRef: string;
  id: TicketId;
  labels: Array<string>;
  sourceHash: string;
  sourceKind: string;
  sourceRef: string;
  title: string;
};

// What `/factory retry` redoes for a paused or failed execution. An
// execution with no retry target cannot be retried.
export type Retry =
  // The failed input preparation, with the same stage, task, and purpose.
  | { kind: 'input' }
  // The latest validation of `stage` for the task, then the stages after it.
  | { kind: 'revalidate'; stage: StageName; taskId: TaskId }
  // The latest finished run's validation.
  | { kind: 'validate' }
  // The failed worktree preparation.
  | { kind: 'worktree' }
  // A new launch of the latest run's session.
  | { kind: 'relaunch' }
  // A new resume carrying the stored reply.
  | { kind: 'resume_reply' };

export type ExecutionRecord = {
  factoryDir: string;
  generation: number;
  id: ExecutionId;
  inputFetchedAt: string;
  inputHash: string;
  inputJson: string;
  message: string | null;
  planPath: string | null;
  policy: Policy;
  retry: Retry | null;
  stage: Stage;
  status: ExecutionStatus;
  statusReason: string | null;
  statusReasonCode: string | null;
  ticketId: TicketId;
  version: number;
  worktreeBaseBranch: string | null;
  worktreeBaseSha: string | null;
  worktreeBranch: string | null;
  worktreePath: string | null;
  worktreeStatus: WorktreeStatus | null;
};

// What one per-task stage last concluded about a task, for display and for
// later stages: the round it reached, a short label, and counts behind it.
export type TaskSummary = { counts: Record<string, number>; label: string; round: number };

export type TaskRecord = {
  blockedBy: Array<TaskId>;
  ordinal: number;
  specHash: string | null;
  // The per-task stage the task is at; set exactly while active or blocked.
  stage: StageName | null;
  status: TaskStatus;
  summaries: Partial<Record<StageName, TaskSummary>>;
  taskFile: string;
  taskId: TaskId;
  title: string;
};

export type SessionRecord = {
  id: SessionId;
  logicalKey: string;
  model: string;
  piSessionId: string | null;
  sessionFile: string | null;
  stage: StageName;
  status: SessionStatus;
  taskId: TaskId | null;
  thinking: string;
};

export type RunRecord = {
  // Wrap-up runs: the state before wrap-up started (WrapupBaseline JSON).
  baseline: string | null;
  description: string | null;
  diffHash: string | null;
  endedAt: string | null;
  id: RunId;
  inputHash: string | null;
  // For a return_to_work run: the per-task stage that sent the task back.
  origin: StageName | null;
  paneId: string | null;
  paneName: string | null;
  parentRunId: RunId | null;
  purpose: RunPurpose;
  resultContract: string | null;
  resultError: string | null;
  resultHash: string | null;
  resultJson: string | null;
  resultStatus: 'pending' | 'valid' | 'invalid';
  semanticRound: number;
  sequence: number;
  sessionId: SessionId;
  startedAt: string | null;
  status: RunStatus;
  subagentId: string | null;
  terminalKind: TerminalKind | null;
};

export type AttentionRecord = {
  id: AttentionId;
  kind: AttentionKind;
  question: string;
  runId: RunId | null;
  status: AttentionStatus;
};

// The API client that sent a command, and who it said it acted for. The second
// is the client's own claim: shown, never trusted for access.
export type Actor = { client: string; onBehalfOf: string | null };

export type ReplyRecord = {
  actor: Actor | null;
  answer: string;
  answerHash: string;
  id: ReplyId;
  idempotencyKey: string;
  isCurrent: boolean;
  requestId: AttentionId;
  version: number;
};

type ActionBase = {
  attempts: number;
  id: ActionId;
  idempotencyKey: string;
  lastError: string | null;
  maxAttempts: number;
  retryOfActionId: ActionId | null;
  status: ActionStatus;
};

export type ActionRecord =
  | (ActionBase & {
      attentionReplyId: null;
      attentionRequestId: null;
      cwd: string;
      kind: 'launch_run';
      mode: 'launch' | 'resume';
      prompt: string;
      runId: RunId;
    })
  | (ActionBase & {
      attentionReplyId: ReplyId;
      attentionRequestId: AttentionId;
      cwd: string;
      kind: 'resume_run';
      prompt: string;
      runId: RunId;
    })
  | (ActionBase & {
      attentionReplyId: null;
      attentionRequestId: null;
      kind: 'validate_run';
      runId: RunId;
    })
  | (ActionBase & {
      attentionReplyId: null;
      attentionRequestId: null;
      // What the run this input is for must fix, when it is a correction.
      failures: Array<string>;
      kind: 'prepare_input';
      // For a return to work: the per-task stage that sent the task back.
      origin: StageName | null;
      purpose: InputPurpose;
      runId: null;
      stage: InputStage;
      // Set exactly when the stage runs per task.
      taskId: TaskId | null;
    })
  | (ActionBase & {
      attentionReplyId: null;
      attentionRequestId: null;
      // Reopens the finished wrap-up session for the human, without a model turn.
      kind: 'open_pane';
      name: string;
      runId: RunId;
    })
  | (ActionBase & {
      attentionReplyId: null;
      attentionRequestId: null;
      cwd: string;
      kind: 'open_diff';
      name: string;
      runId: RunId;
    })
  | (ActionBase & {
      attentionReplyId: null;
      attentionRequestId: null;
      kind: 'prepare_worktree';
      runId: null;
      slug: string;
    })
  | (ActionBase & {
      attentionReplyId: null;
      attentionRequestId: AttentionId;
      kind: 'notify_attention';
      message: string;
      runId: null;
    });

export type FactorySnapshot = {
  actions: Array<ActionRecord>;
  attention: Array<AttentionRecord>;
  execution: ExecutionRecord;
  replies: Array<ReplyRecord>;
  runs: Array<RunRecord>;
  sessions: Array<SessionRecord>;
  tasks: Array<TaskRecord>;
  ticket: TicketRecord;
};

export type UsageWrite = {
  cumulative: UsageTotals;
  runId: RunId;
  sessionId: SessionId;
};

export type Reduction = {
  armRunId: RunId | null;
  changed: boolean;
  response: ControllerResponse;
  snapshot: FactorySnapshot | null;
  usage: UsageWrite | null;
};

export function zeroUsage(): UsageTotals {
  return {
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    contextTokens: null,
    contextWindow: null,
    costUsdMicros: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
}
