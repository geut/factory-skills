import { randomUUID } from 'node:crypto';
import type { InternalLabel, WorkCommand } from './config.ts';

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

export type Stage = 'plan' | 'work' | 'review' | 'wrapup' | 'done';
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
export type TaskStatus =
  | 'pending'
  | 'working'
  | 'ready_for_review'
  | 'reviewing'
  | 'done'
  | 'blocked'
  | 'cancelled';
export type SessionStatus = 'prepared' | 'open' | 'completed' | 'abandoned';
export type RunStatus = 'prepared' | 'starting' | 'running' | 'terminal';
export type RunPurpose =
  | 'initial'
  | 'validation_correction'
  | 'human_reply'
  | 'review_changes'
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

export type WorkInputPurpose = 'initial' | 'validation_correction' | 'human_reply';

export type Policy = {
  codeRoot: string;
  labels: { map: Record<string, InternalLabel> };
  limits: { infrastructureRetries: number; planCorrections: number; workCorrections: number };
  models: { plan: string; review: string; work: string };
  validation: { work: { commands: Array<WorkCommand> } };
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
  sourceKind: 'github' | 'file' | 'text';
  sourceRef: string;
  title: string;
};

export type PlannedTask = {
  blockedBy: Array<TaskId>;
  ordinal: number;
  specHash: string;
  taskFile: string;
  taskId: TaskId;
  title: string;
};

export type PlanValidationOutcome =
  | { kind: 'passed'; planPath: string; tasks: Array<PlannedTask> }
  | { failures: Array<string>; kind: 'failed' };

export type WorkCheck = {
  command: string | null;
  details: string;
  durationMs: number | null;
  exitCode: number | null;
  kind: 'diff' | 'command' | 'policy';
  name: string;
  outputExcerpt: string | null;
  status: 'passed' | 'failed';
};

export type WorkValidationOutcome =
  | { checks: Array<WorkCheck>; diff: string; kind: 'passed' }
  | { checks: Array<WorkCheck>; failures: Array<string>; kind: 'failed' }
  | { kind: 'error'; message: string };

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
  | {
      actionId: ActionId;
      kind: 'validation_finished';
      outcome: PlanValidationOutcome;
      runId: RunId;
      stage: 'plan';
    }
  | {
      actionId: ActionId;
      kind: 'validation_finished';
      outcome: WorkValidationOutcome;
      runId: RunId;
      stage: 'work';
    }
  | {
      actionId: ActionId;
      adrPath: string | null;
      contextPath: string | null;
      kind: 'work_input_ready';
      taskType: string | null;
    }
  | { actionId: ActionId; kind: 'work_input_failed'; message: string }
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
  | { answer: string; idempotencyKey: string; kind: 'reply'; ticketId: TicketId }
  | { idempotencyKey: string; kind: 'retry'; ticketId: TicketId }
  | { kind: 'reconciled'; observation: ReconcileObservation; runId: RunId };

export type ControllerResponse =
  | {
      displayRef: string;
      kind: 'status';
      message: string;
      question: string | null;
      retryHint: string | null;
      stage: Stage;
      status: ExecutionStatus;
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
  retryable: boolean;
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

export type TaskRecord = {
  blockedBy: Array<TaskId>;
  ordinal: number;
  specHash: string | null;
  status: TaskStatus;
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
  stage: 'plan' | 'work' | 'review' | 'wrapup';
  status: SessionStatus;
  taskId: TaskId | null;
  thinking: string;
};

export type RunRecord = {
  description: string | null;
  endedAt: string | null;
  id: RunId;
  inputHash: string | null;
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

export type ReplyRecord = {
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
      failures: Array<string>;
      kind: 'prepare_work_input';
      purpose: WorkInputPurpose;
      runId: null;
      taskId: TaskId;
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
