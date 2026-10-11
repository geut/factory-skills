import path from 'node:path';
import {
  type ActionRecord,
  type ControllerEvent,
  type ControllerResponse,
  type Policy,
  type ExecutionStatus,
  type FactorySnapshot,
  type IdSource,
  type InputPurpose,
  type Reduction,
  type ReviewResult,
  type Retry,
  type ReviewValidationReport,
  type RunId,
  type RunPurpose,
  type RunRecord,
  type SessionRecord,
  type StageName,
  type TaskId,
  type TaskRecord,
  type TerminalOutcome,
  type UsageWrite,
  type WorkValidationReport,
  type WrapupValidationReport,
} from '../domain.ts';
import { sha256 } from '../hash.ts';
import { childDescription } from '../runtime/policy.ts';
import type { StageDefinition } from '../stages/definition.ts';
import { stages, type InputStage, type PreparedInput } from '../stages/index.ts';
import { formatFinding, parseReview } from '../stages/review/parse.ts';
import { currentStep, nextAction, progressText, runOutput } from './progress.ts';

function reject(snapshot: FactorySnapshot | null, message: string): Reduction {
  return {
    armRunId: null,
    changed: false,
    response: { kind: 'rejected', message },
    snapshot,
    usage: null,
  };
}

export function detail(snapshot: FactorySnapshot, message: string): ControllerResponse {
  const question =
    snapshot.attention.find(
      (item) => item.status === 'open' || item.status === 'answered' || item.status === 'resuming',
    ) ?? null;
  return {
    displayRef: snapshot.ticket.displayRef,
    kind: 'status',
    message,
    next: nextAction(snapshot),
    progress: progressText(snapshot),
    question: question?.question ?? null,
    retryHint:
      snapshot.execution.retry !== null
        ? `Retry with /factory retry ${snapshot.ticket.commandRef}.`
        : null,
    stage: snapshot.execution.stage,
    status: snapshot.execution.status,
    task: currentStep(snapshot),
  };
}

function unchanged(
  snapshot: FactorySnapshot,
  message: string,
  armRunId: RunId | null = null,
): Reduction {
  return { armRunId, changed: false, response: detail(snapshot, message), snapshot, usage: null };
}

function finish(
  snapshot: FactorySnapshot,
  message: string,
  usage: UsageWrite | null = null,
  armRunId: RunId | null = null,
): Reduction {
  snapshot.execution.version += 1;
  snapshot.execution.message = message;
  return { armRunId, changed: true, response: detail(snapshot, message), snapshot, usage };
}

export function describeExisting(snapshot: FactorySnapshot): ControllerResponse {
  return detail(snapshot, repeatMessage(snapshot));
}

function repeatMessage(snapshot: FactorySnapshot): string {
  const ref = snapshot.ticket.commandRef;
  const status: ExecutionStatus = snapshot.execution.status;
  switch (status) {
    case 'queued':
    case 'active':
    case 'resuming':
      return `Ticket ${ref} is ${snapshot.execution.stage}/${status}. Start did not launch another child.`;
    case 'waiting_for_user':
      return `Ticket ${ref} is waiting for user input. Reply with /factory reply ${ref} "answer".`;
    case 'paused':
      return `Ticket ${ref} is paused: ${snapshot.execution.statusReason ?? 'no reason recorded'}.${nextAction(snapshot) === null ? '' : ` Next: ${nextAction(snapshot)}.`}`;
    case 'resume_failed':
    case 'failed':
      return snapshot.execution.retry !== null
        ? `Ticket ${ref} failed: ${snapshot.execution.statusReason ?? 'unknown'}. Retry with /factory retry ${ref}.`
        : `Ticket ${ref} failed and v0 will not start another generation.`;
    case 'ready_for_handoff':
      return `Ticket ${ref} is ready for handoff. Start does not mark it complete.`;
    case 'complete':
    case 'cancelled':
      return `Ticket ${ref} is ${status}. v0 does not reopen it.`;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

function sessionFor(snapshot: FactorySnapshot, id: SessionRecord['id']): SessionRecord | null {
  return snapshot.sessions.find((session) => session.id === id) ?? null;
}

function runFor(snapshot: FactorySnapshot, id: RunId): RunRecord | null {
  return snapshot.runs.find((run) => run.id === id) ?? null;
}

function addRun(
  snapshot: FactorySnapshot,
  session: SessionRecord,
  parent: RunRecord | null,
  purpose: RunPurpose,
  semanticRound: number,
  ids: IdSource,
  prompt: string,
): RunRecord {
  const sequences = snapshot.runs
    .filter((run) => run.sessionId === session.id)
    .map((run) => run.sequence);
  const sequence = Math.max(0, ...sequences) + 1;
  const run: RunRecord = {
    baseline: null,
    description: null,
    // A resumed reviewer still answers for the diff its session was given.
    diffHash: parent !== null && parent.sessionId === session.id ? parent.diffHash : null,
    endedAt: null,
    id: ids.run(),
    inputHash: sha256(prompt),
    origin: null,
    paneId: null,
    paneName: null,
    parentRunId: parent?.id ?? null,
    purpose,
    resultContract: null,
    resultError: null,
    resultHash: null,
    resultJson: null,
    resultStatus: 'pending',
    semanticRound,
    sequence,
    sessionId: session.id,
    startedAt: null,
    status: 'prepared',
    subagentId: null,
    terminalKind: null,
  };
  snapshot.runs.push(run);
  return run;
}

function launchAction(
  snapshot: FactorySnapshot,
  run: RunRecord,
  prompt: string,
  mode: 'launch' | 'resume',
  ids: IdSource,
  cwd: string,
): void {
  const action: ActionRecord = {
    attempts: 0,
    attentionReplyId: null,
    attentionRequestId: null,
    cwd,
    id: ids.action(),
    idempotencyKey: `launch:${run.id}`,
    kind: 'launch_run',
    lastError: null,
    maxAttempts: snapshot.execution.policy.limits.infrastructureRetries,
    mode,
    prompt,
    retryOfActionId: null,
    runId: run.id,
    status: 'pending',
  };
  snapshot.actions.push(action);
}

// `keepReply` leaves a question that is being answered in place, so a
// retry can still find its stored answer.
function resolveOpen(snapshot: FactorySnapshot, keepReply = false): void {
  for (const attention of snapshot.attention) {
    if (keepReply && attention.status === 'resuming') {
      continue;
    }
    if (
      attention.status === 'open' ||
      attention.status === 'answered' ||
      attention.status === 'resuming'
    ) {
      attention.status = 'resolved';
    }
  }
}

function pauseWithNotice(
  snapshot: FactorySnapshot,
  input: {
    code: string;
    failures: Array<string>;
    ids: IdSource;
    keepReply?: boolean;
    question: string;
    retry: Retry | null;
    // A reply to this notice resumes the session that owns this run.
    runId?: RunId;
  },
): void {
  resolveOpen(snapshot, input.keepReply === true);
  snapshot.execution.status = 'paused';
  snapshot.execution.retry = input.retry;
  snapshot.execution.statusReasonCode = input.code;
  snapshot.execution.statusReason = input.failures.join('\n');
  snapshot.attention.push({
    id: input.ids.attention(),
    kind: 'policy_limit',
    question: input.question,
    runId: input.runId ?? null,
    status: 'open',
  });
  const attention = snapshot.attention.at(-1);
  if (attention === undefined) {
    return;
  }
  snapshot.actions.push({
    attempts: 0,
    attentionReplyId: null,
    attentionRequestId: attention.id,
    id: input.ids.action(),
    idempotencyKey: `notify:${attention.id}`,
    kind: 'notify_attention',
    lastError: null,
    maxAttempts: 1,
    message: input.question,
    retryOfActionId: null,
    runId: null,
    status: 'pending',
  });
}

function pauseForLimit(
  snapshot: FactorySnapshot,
  stage: 'plan' | 'work',
  failures: Array<string>,
  ids: IdSource,
): void {
  const label = stage === 'work' ? 'Work' : 'Plan';
  pauseWithNotice(snapshot, {
    code: stage === 'work' ? 'work_correction_limit' : 'plan_correction_limit',
    failures,
    ids,
    question: `${label} validation is still failing after the correction limit:\n${failures.map((failure) => `- ${failure}`).join('\n')}`,
    retry: null,
  });
}

// A prepared session for one stage, launched with that stage's model and thinking.
function newSession(
  policy: Policy,
  stage: StageName,
  taskId: TaskId | null,
  ids: IdSource,
): SessionRecord {
  const definition = stages[stage];
  return {
    id: ids.session(),
    logicalKey: taskId === null ? stage : `${stage}:${taskId}`,
    model: policy.models[definition.model],
    piSessionId: null,
    sessionFile: null,
    stage,
    status: 'prepared',
    taskId,
    thinking: definition.thinking,
  };
}

function sessionCwd(snapshot: FactorySnapshot, session: SessionRecord): string {
  if (session.stage !== 'plan' && snapshot.execution.worktreePath !== null) {
    return snapshot.execution.worktreePath;
  }
  return snapshot.execution.policy.codeRoot;
}

function taskById(snapshot: FactorySnapshot, id: TaskId): TaskRecord | null {
  return snapshot.tasks.find((task) => task.taskId === id) ?? null;
}

function enqueueValidation(
  snapshot: FactorySnapshot,
  run: RunRecord,
  idempotencyKey: string,
  ids: IdSource,
  retryOf: ActionRecord['id'] | null = null,
): void {
  snapshot.actions.push({
    attempts: 0,
    attentionReplyId: null,
    attentionRequestId: null,
    id: ids.action(),
    idempotencyKey,
    kind: 'validate_run',
    lastError: null,
    maxAttempts: snapshot.execution.policy.limits.infrastructureRetries,
    retryOfActionId: retryOf,
    runId: run.id,
    status: 'pending',
  });
}

// A task is active or blocked at exactly one per-task stage at a time.
function enterStage(task: TaskRecord, stage: StageName): void {
  task.status = 'active';
  task.stage = stage;
}

function reviewRound(task: TaskRecord): number {
  return task.summaries.review?.round ?? 0;
}

type PrepareInputAction = Extract<ActionRecord, { kind: 'prepare_input' }>;

function enqueueInput(
  snapshot: FactorySnapshot,
  stage: InputStage,
  input: {
    failures: Array<string>;
    idempotencyKey: string;
    ids: IdSource;
    // For a return to work: the per-task stage that sent the task back.
    origin?: StageName;
    purpose: InputPurpose;
    taskId?: TaskId;
  },
): void {
  snapshot.actions.push({
    attempts: 0,
    attentionReplyId: null,
    attentionRequestId: null,
    failures: input.failures,
    id: input.ids.action(),
    idempotencyKey: input.idempotencyKey,
    kind: 'prepare_input',
    lastError: null,
    maxAttempts: snapshot.execution.policy.limits.infrastructureRetries,
    origin: input.origin ?? null,
    purpose: input.purpose,
    retryOfActionId: null,
    runId: null,
    stage,
    status: 'pending',
    taskId: input.taskId ?? null,
  });
}

function scheduleCorrection(
  snapshot: FactorySnapshot,
  session: SessionRecord,
  parent: RunRecord,
  failures: Array<string>,
  ids: IdSource,
): void {
  const count = snapshot.runs.filter(
    (run) => run.sessionId === session.id && run.purpose === 'validation_correction',
  ).length;
  const limit =
    session.stage === 'work'
      ? snapshot.execution.policy.limits.workCorrections
      : snapshot.execution.policy.limits.planCorrections;
  if (count >= limit) {
    pauseForLimit(snapshot, session.stage === 'work' ? 'work' : 'plan', failures, ids);
    return;
  }
  if (session.stage === 'work' && session.taskId !== null) {
    enqueueInput(snapshot, 'work', {
      failures,
      idempotencyKey: `work-input:${parent.id}:correction:${count + 1}`,
      ids,
      purpose: 'validation_correction',
      taskId: session.taskId,
    });
    snapshot.execution.status = 'active';
    return;
  }
  const prompt = stages[session.stage].turn({ failures, kind: 'correction' });
  const run = addRun(snapshot, session, parent, 'validation_correction', count + 1, ids, prompt);
  run.description = parent.description ?? childDescription(snapshot.ticket.title);
  launchAction(snapshot, run, prompt, 'resume', ids, sessionCwd(snapshot, session));
  snapshot.execution.status = 'active';
}

function scheduleInfrastructure(
  snapshot: FactorySnapshot,
  failed: RunRecord,
  message: string,
  ids: IdSource,
): void {
  const session = sessionFor(snapshot, failed.sessionId);
  if (session === null) {
    return;
  }
  const count = snapshot.runs.filter(
    (run) => run.sessionId === session.id && run.purpose === 'infrastructure_retry',
  ).length;
  const human = failed.purpose === 'human_reply' || snapshot.execution.status === 'resuming';
  if (count >= snapshot.execution.policy.limits.infrastructureRetries) {
    snapshot.execution.status = human ? 'resume_failed' : 'failed';
    snapshot.execution.retry = { kind: human ? 'resume_reply' : 'relaunch' };
    snapshot.execution.statusReasonCode = 'infrastructure_limit';
    snapshot.execution.statusReason = message;
    return;
  }
  const current = snapshot.replies.find((reply) => reply.isCurrent) ?? null;
  const attention =
    snapshot.attention.find((item) => item.status === 'resuming' || item.status === 'answered') ??
    null;
  const prompt =
    human && current !== null
      ? stages[session.stage].turn({ answer: current.answer, kind: 'reply' })
      : [
          `Follow the ${stages[session.stage].skill} skill.`,
          '',
          `The previous launch failed: ${message}`,
          'Continue the same task.',
        ].join('\n');
  const run = addRun(
    snapshot,
    session,
    failed,
    'infrastructure_retry',
    failed.semanticRound,
    ids,
    prompt,
  );
  run.description = failed.description;
  if (human && current !== null && attention !== null) {
    snapshot.actions.push({
      attempts: 0,
      attentionReplyId: current.id,
      attentionRequestId: attention.id,
      cwd: sessionCwd(snapshot, session),
      id: ids.action(),
      idempotencyKey: `resume:${current.id}:${run.id}`,
      kind: 'resume_run',
      lastError: null,
      maxAttempts: snapshot.execution.policy.limits.infrastructureRetries,
      prompt,
      retryOfActionId: null,
      runId: run.id,
      status: 'pending',
    });
    snapshot.execution.status = 'resuming';
    attention.status = 'resuming';
    return;
  }
  launchAction(
    snapshot,
    run,
    prompt,
    session.sessionFile === null ? 'launch' : 'resume',
    ids,
    sessionCwd(snapshot, session),
  );
  snapshot.execution.status = 'active';
}

function usageFor(run: RunRecord, terminal: TerminalOutcome): UsageWrite | null {
  if (terminal.kind !== 'subagent_done' && terminal.kind !== 'caller_ping') {
    return null;
  }
  return { cumulative: terminal.usage, runId: run.id, sessionId: run.sessionId };
}

function recordOutput(
  run: RunRecord,
  stage: { contract: string; parse: StageDefinition['parse'] },
  output: string,
): void {
  const parsed = stage.parse(output, run.semanticRound);
  run.resultJson = parsed.json;
  if (parsed.kind === 'unchecked') {
    return;
  }
  run.resultContract = stage.contract;
  if (parsed.kind === 'valid') {
    run.resultStatus = 'valid';
    run.resultHash = sha256(parsed.json);
  } else {
    run.resultStatus = 'invalid';
    run.resultError = parsed.error;
  }
}

function applyTerminal(
  snapshot: FactorySnapshot,
  run: RunRecord,
  terminal: TerminalOutcome,
  now: string,
  ids: IdSource,
): UsageWrite | null {
  run.status = 'terminal';
  run.terminalKind = terminal.kind;
  run.endedAt = now;
  const session = sessionFor(snapshot, run.sessionId);
  switch (terminal.kind) {
    case 'subagent_done': {
      if (session !== null) {
        recordOutput(run, stages[session.stage], terminal.output);
      }
      if (session !== null) {
        enqueueValidation(snapshot, run, `validate:${run.id}`, ids);
        snapshot.execution.status = 'active';
      }
      return usageFor(run, terminal);
    }
    case 'caller_ping': {
      resolveOpen(snapshot);
      if (session !== null && stages[session.stage].scope === 'task' && session.taskId !== null) {
        const task = taskById(snapshot, session.taskId);
        if (task !== null) {
          task.status = 'blocked';
        }
      }
      snapshot.attention.push({
        id: ids.attention(),
        kind: 'agent_question',
        question: terminal.question,
        runId: run.id,
        status: 'open',
      });
      const attention = snapshot.attention.at(-1);
      snapshot.execution.status = 'waiting_for_user';
      snapshot.execution.retry = null;
      if (attention !== undefined) {
        snapshot.actions.push({
          attempts: 0,
          attentionReplyId: null,
          attentionRequestId: attention.id,
          id: ids.action(),
          idempotencyKey: `notify:${attention.id}`,
          kind: 'notify_attention',
          lastError: null,
          maxAttempts: 1,
          message: terminal.question,
          retryOfActionId: null,
          runId: null,
          status: 'pending',
        });
      }
      return usageFor(run, terminal);
    }
    case 'launch_failed':
    case 'crashed':
    case 'completed_user_exit':
    case 'pane_killed':
    case 'gap_exit':
    case 'cancelled':
      scheduleInfrastructure(snapshot, run, terminal.message, ids);
      return null;
    default: {
      const _exhaustive: never = terminal;
      return _exhaustive;
    }
  }
}

function reduceStart(
  snapshot: FactorySnapshot | null,
  event: Extract<ControllerEvent, { kind: 'start' }>,
  ids: IdSource,
): Reduction {
  if (snapshot !== null) {
    return unchanged(snapshot, repeatMessage(snapshot));
  }
  const prompt = stages.plan.turn({
    input: {
      body: event.ticket.body,
      displayRef: event.ticket.displayRef,
      factoryDir: event.ticket.factoryDir,
      title: event.ticket.title,
    },
    kind: 'initial',
  });
  const executionId = ids.execution();
  const session = newSession(event.policy, 'plan', null, ids);
  const created: FactorySnapshot = {
    actions: [],
    attention: [],
    execution: {
      factoryDir: event.ticket.factoryDir,
      generation: 1,
      id: executionId,
      inputFetchedAt: event.ticket.fetchedAt,
      inputHash: event.ticket.contentHash,
      inputJson: JSON.stringify({
        body: event.ticket.body,
        commandRef: event.ticket.commandRef,
        displayRef: event.ticket.displayRef,
        labels: event.ticket.labels,
        title: event.ticket.title,
      }),
      message: null,
      planPath: null,
      policy: event.policy,
      retry: null,
      stage: 'plan',
      status: 'queued',
      statusReason: null,
      statusReasonCode: null,
      ticketId: event.ticket.id,
      version: 0,
      worktreeBaseBranch: null,
      worktreeBaseSha: null,
      worktreeBranch: null,
      worktreePath: null,
      worktreeStatus: null,
    },
    replies: [],
    runs: [],
    sessions: [session],
    tasks: [],
    ticket: {
      body: event.ticket.body,
      commandRef: event.ticket.commandRef,
      displayRef: event.ticket.displayRef,
      id: event.ticket.id,
      labels: event.ticket.labels,
      sourceHash: event.ticket.contentHash,
      sourceKind: event.ticket.sourceKind,
      sourceRef: event.ticket.sourceRef,
      title: event.ticket.title,
    },
  };
  const run = addRun(created, session, null, 'initial', 0, ids, prompt);
  run.description = childDescription(event.ticket.title);
  launchAction(created, run, prompt, 'launch', ids, event.policy.codeRoot);
  return finish(created, `Planning queued for ${event.ticket.displayRef}.`);
}

function lowestReady(snapshot: FactorySnapshot): FactorySnapshot['tasks'][number] | null {
  const done = new Set(
    snapshot.tasks.filter((task) => task.status === 'done').map((task) => task.taskId),
  );
  const ready = snapshot.tasks
    .filter((task) => task.status === 'pending' && task.blockedBy.every((id) => done.has(id)))
    .sort((left, right) => left.ordinal - right.ordinal);
  return ready[0] ?? null;
}

function retryValidation(
  snapshot: FactorySnapshot,
  run: RunRecord,
  action: Extract<ActionRecord, { kind: 'validate_run' }>,
  message: string,
  ids: IdSource,
): Reduction {
  action.status = 'failed';
  action.lastError = message;
  const failed = snapshot.actions.filter(
    (item) => item.kind === 'validate_run' && item.runId === run.id && item.status === 'failed',
  ).length;
  if (failed >= snapshot.execution.policy.limits.infrastructureRetries) {
    snapshot.execution.status = 'failed';
    snapshot.execution.retry = { kind: 'validate' };
    snapshot.execution.statusReasonCode = 'validator_error';
    snapshot.execution.statusReason = message;
    return finish(snapshot, message);
  }
  enqueueValidation(snapshot, run, `validate:${run.id}:${failed + 1}`, ids, action.id);
  snapshot.execution.status = 'active';
  return finish(snapshot, 'Retrying validation.');
}

function finishWorkValidation(
  snapshot: FactorySnapshot,
  existing: FactorySnapshot,
  run: RunRecord,
  action: Extract<ActionRecord, { kind: 'validate_run' }>,
  report: Exclude<WorkValidationReport, { status: 'error' }>,
  ids: IdSource,
): Reduction {
  const session = sessionFor(snapshot, run.sessionId);
  if (session === null || session.stage !== 'work' || session.taskId === null) {
    return reject(existing, 'Work session is missing.');
  }
  action.status = 'succeeded';
  if (report.status === 'failed') {
    scheduleCorrection(snapshot, session, run, report.failures, ids);
    return finish(snapshot, 'Work validation failed.');
  }
  const task = taskById(snapshot, session.taskId);
  if (task === null || snapshot.execution.worktreePath === null) {
    return reject(existing, 'Work task is missing.');
  }
  enterStage(task, 'review');
  snapshot.execution.stage = 'review';
  snapshot.execution.status = 'active';
  // Later rounds resume the same reviewer so it can check its earlier findings.
  const previous =
    snapshot.sessions.find((item) => item.stage === 'review' && item.taskId === task.taskId) ??
    null;
  const reviewSession =
    previous ?? newSession(snapshot.execution.policy, 'review', task.taskId, ids);
  if (previous === null) {
    snapshot.sessions.push(reviewSession);
  }
  const round = reviewRound(task) + 1;
  const prompt = stages.review.turn({
    input: {
      diff: report.detail.diff,
      displayRef: snapshot.ticket.displayRef,
      planPath: snapshot.execution.planPath ?? '',
      rawOutput: runOutput(run),
      round,
      taskFile: `${snapshot.execution.factoryDir}/${task.taskFile}`,
      taskTitle: task.title,
      validationSummary: report.checks.map((check) => `${check.name}: ${check.status}`).join('\n'),
    },
    kind: 'initial',
  });
  const reviewRun = addRun(
    snapshot,
    reviewSession,
    null,
    previous === null ? 'initial' : 'reentry',
    round,
    ids,
    prompt,
  );
  reviewRun.description = childDescription(task.title);
  reviewRun.diffHash = sha256(report.detail.diff);
  launchAction(
    snapshot,
    reviewRun,
    prompt,
    reviewSession.sessionFile === null ? 'launch' : 'resume',
    ids,
    snapshot.execution.worktreePath,
  );
  return finish(snapshot, `Review round ${round} queued for task ${task.taskId}.`);
}

function closeTaskSessions(snapshot: FactorySnapshot, task: TaskRecord): void {
  for (const session of snapshot.sessions) {
    if (session.taskId === task.taskId && session.status !== 'abandoned') {
      session.status = 'completed';
    }
  }
}

function minorFindings(snapshot: FactorySnapshot): Array<string> {
  const findings: Array<string> = [];
  for (const session of snapshot.sessions) {
    if (session.stage !== 'review') {
      continue;
    }
    const latest = snapshot.runs
      .filter((run) => run.sessionId === session.id && run.resultStatus === 'valid')
      .sort((left, right) => right.sequence - left.sequence)[0];
    if (latest === undefined) {
      continue;
    }
    const parsed = parseReview(runOutput(latest), latest.semanticRound);
    // Finding ids restart in every task's review, so name the task.
    if (parsed.kind === 'valid') {
      findings.push(
        ...parsed.result.findings
          .filter((item) => !item.blocking)
          .map((item) => `Task ${session.taskId ?? '?'} ${formatFinding(item)}`),
      );
    }
  }
  return findings;
}

// Wrap-up starts with a checked input; the session and run are created when
// that input is ready.
function queueWrapup(snapshot: FactorySnapshot, ids: IdSource): void {
  snapshot.execution.stage = 'wrapup';
  snapshot.execution.status = 'active';
  enqueueInput(snapshot, 'wrapup', {
    failures: [],
    idempotencyKey: `wrapup-input:${snapshot.execution.id}:initial`,
    ids,
    purpose: 'initial',
  });
}

// After an approval, either start the next dependency-ready task or, once
// every task is done, hand the ticket to wrap-up.
function advanceAfterApproval(
  snapshot: FactorySnapshot,
  ids: IdSource,
  approved: TaskRecord,
): string {
  const next = lowestReady(snapshot);
  if (next !== null) {
    snapshot.execution.stage = 'work';
    snapshot.execution.status = 'active';
    enqueueInput(snapshot, 'work', {
      failures: [],
      idempotencyKey: `work-input:${snapshot.execution.id}:${next.taskId}:initial`,
      ids,
      purpose: 'initial',
      taskId: next.taskId,
    });
    return `Task ${approved.taskId} approved. Work input queued for task ${next.taskId}.`;
  }
  const open = snapshot.tasks.filter(
    (task) => task.status !== 'done' && task.status !== 'cancelled',
  );
  if (open.length > 0) {
    const waiting = open.map((task) => task.taskId).join(', ');
    pauseWithNotice(snapshot, {
      code: 'no_ready_task',
      failures: [`No remaining task is ready: ${waiting}.`],
      ids,
      question: `Task ${approved.taskId} was approved, but no remaining task is ready: ${waiting}.`,
      retry: null,
    });
    return `Task ${approved.taskId} approved. No remaining task is ready.`;
  }
  queueWrapup(snapshot, ids);
  return `Task ${approved.taskId} approved. Every task is done; wrap-up queued.`;
}

function applyVerdict(
  snapshot: FactorySnapshot,
  task: TaskRecord,
  run: RunRecord,
  result: ReviewResult,
  ids: IdSource,
): Reduction {
  const blocking = result.findings.filter((finding) => finding.blocking);
  task.summaries.review = {
    counts: { blocking: blocking.length, findings: result.findings.length },
    label: result.verdict,
    round: result.round,
  };
  const limit = snapshot.execution.policy.limits.reviewRounds;
  switch (result.verdict) {
    case 'approve': {
      task.status = 'done';
      task.stage = null;
      closeTaskSessions(snapshot, task);
      return finish(snapshot, advanceAfterApproval(snapshot, ids, task));
    }
    case 'changes_requested': {
      const lines = blocking.map((finding) => formatFinding(finding));
      if (result.round >= limit) {
        task.status = 'blocked';
        pauseWithNotice(snapshot, {
          code: 'review_round_limit',
          failures: lines,
          ids,
          question: [
            `Review round ${result.round} of ${limit} for task ${task.taskId} still has blocking findings:`,
            ...lines.map((line) => `- ${line}`),
            'Reply to tell the reviewer how to settle them.',
          ].join('\n'),
          retry: null,
          runId: run.id,
        });
        return finish(snapshot, `Review round limit reached for task ${task.taskId}.`);
      }
      enterStage(task, 'work');
      snapshot.execution.stage = 'work';
      snapshot.execution.status = 'active';
      enqueueInput(snapshot, 'work', {
        failures: lines,
        idempotencyKey: `work-input:${run.id}:review:${result.round}`,
        ids,
        origin: 'review',
        purpose: 'return_to_work',
        taskId: task.taskId,
      });
      return finish(snapshot, `Review round ${result.round} requested changes to ${task.taskId}.`);
    }
    case 'blocked': {
      const lines = result.findings.map((finding) => formatFinding(finding));
      task.status = 'blocked';
      pauseWithNotice(snapshot, {
        code: 'review_blocked',
        failures: [result.summary, ...lines],
        ids,
        question: [
          `The reviewer blocked task ${task.taskId}: ${result.summary}`,
          ...lines.map((line) => `- ${line}`),
          'Reply to resume the reviewer with what it needs.',
        ].join('\n'),
        retry: null,
        runId: run.id,
      });
      return finish(snapshot, `Review blocked task ${task.taskId}.`);
    }
    default: {
      const _exhaustive: never = result.verdict;
      return _exhaustive;
    }
  }
}

function correctReview(
  snapshot: FactorySnapshot,
  session: SessionRecord,
  task: TaskRecord,
  parent: RunRecord,
  failures: Array<string>,
  ids: IdSource,
): Reduction {
  // Malformed results are budgeted per round and never consume the round.
  const count = snapshot.runs.filter(
    (item) =>
      item.sessionId === session.id &&
      item.purpose === 'validation_correction' &&
      item.semanticRound === parent.semanticRound,
  ).length;
  if (count >= snapshot.execution.policy.limits.reviewCorrections) {
    task.status = 'blocked';
    pauseWithNotice(snapshot, {
      code: 'review_correction_limit',
      failures,
      ids,
      question: [
        'The review result is still malformed after the correction limit:',
        ...failures.map((failure) => `- ${failure}`),
        'Reply to resume the reviewer.',
      ].join('\n'),
      retry: null,
      runId: parent.id,
    });
    return finish(snapshot, 'Review correction limit reached.');
  }
  const prompt = stages.review.turn({ failures, kind: 'correction' });
  const run = addRun(
    snapshot,
    session,
    parent,
    'validation_correction',
    parent.semanticRound,
    ids,
    prompt,
  );
  run.description = parent.description ?? childDescription(task.title);
  launchAction(
    snapshot,
    run,
    prompt,
    session.sessionFile === null ? 'launch' : 'resume',
    ids,
    sessionCwd(snapshot, session),
  );
  snapshot.execution.status = 'active';
  return finish(snapshot, 'Review result is malformed. Resuming the reviewer.');
}

function latestWorkRun(snapshot: FactorySnapshot, taskId: TaskId): RunRecord | null {
  const workSession =
    snapshot.sessions.find((item) => item.stage === 'work' && item.taskId === taskId) ?? null;
  if (workSession === null) {
    return null;
  }
  return (
    [...snapshot.runs]
      .reverse()
      .find((item) => item.sessionId === workSession.id && item.terminalKind === 'subagent_done') ??
    null
  );
}

// Stale reviews earlier in this round. Each one enqueued a validation keyed
// `validate:<work run>:stale:<review run>`.
function staleReviews(snapshot: FactorySnapshot, review: RunRecord): number {
  return snapshot.actions.filter((action) => {
    if (action.kind !== 'validate_run') {
      return false;
    }
    const match = /:stale:(.+)$/.exec(action.idempotencyKey);
    const earlier = snapshot.runs.find((run) => run.id === match?.[1]);
    return (
      earlier !== undefined &&
      earlier.sessionId === review.sessionId &&
      earlier.semanticRound === review.semanticRound
    );
  }).length;
}

// The worktree changed after the reviewer received its diff. Validate the
// worker's latest attempt again so the next reviewer gets a checked diff.
// A second change in the same round pauses: something keeps writing to the
// worktree, and another review would only spend tokens.
function revalidateWork(
  snapshot: FactorySnapshot,
  existing: FactorySnapshot,
  task: TaskRecord,
  review: RunRecord,
  ids: IdSource,
): Reduction {
  const workRun = latestWorkRun(snapshot, task.taskId);
  if (workRun === null) {
    return reject(existing, 'No finished work run can be validated again.');
  }
  if (staleReviews(snapshot, review) >= 1) {
    const worktree = snapshot.execution.worktreePath ?? 'the worktree';
    const failure = `The worktree changed again while review round ${review.semanticRound} of task ${task.taskId} ran.`;
    task.status = 'blocked';
    pauseWithNotice(snapshot, {
      code: 'review_diff_changed',
      failures: [failure],
      ids,
      question: [
        failure,
        `Something keeps writing files the diff includes. Check git status in ${worktree} and ignore generated files.`,
        `Then run /factory retry ${snapshot.ticket.commandRef} to validate the work and review it again.`,
      ].join('\n'),
      retry: { kind: 'revalidate', taskId: task.taskId },
      runId: review.id,
    });
    return finish(snapshot, 'The worktree keeps changing during review.');
  }
  enterStage(task, 'work');
  snapshot.execution.stage = 'work';
  snapshot.execution.status = 'active';
  enqueueValidation(snapshot, workRun, `validate:${workRun.id}:stale:${review.id}`, ids);
  return finish(snapshot, 'The worktree changed during review. Validating the work again.');
}

function finishReviewValidation(
  snapshot: FactorySnapshot,
  existing: FactorySnapshot,
  run: RunRecord,
  action: Extract<ActionRecord, { kind: 'validate_run' }>,
  report: Exclude<ReviewValidationReport, { status: 'error' }>,
  ids: IdSource,
): Reduction {
  const session = sessionFor(snapshot, run.sessionId);
  const task =
    session?.taskId === null || session === null ? null : taskById(snapshot, session.taskId);
  if (session === null || session.stage !== 'review' || task === null) {
    return reject(existing, 'Review session is missing.');
  }
  action.status = 'succeeded';
  if (report.status === 'passed') {
    const parsed = parseReview(runOutput(run), run.semanticRound);
    if (parsed.kind === 'invalid') {
      return correctReview(snapshot, session, task, run, parsed.failures, ids);
    }
    return applyVerdict(snapshot, task, run, parsed.result, ids);
  }
  switch (report.detail.reason) {
    case 'unsafe': {
      task.status = 'blocked';
      pauseWithNotice(snapshot, {
        code: 'review_isolation',
        failures: report.failures,
        ids,
        question: [
          'The reviewer was not isolated from the worker:',
          ...report.failures.map((failure) => `- ${failure}`),
        ].join('\n'),
        retry: null,
      });
      return finish(snapshot, 'Review isolation failed.');
    }
    case 'stale':
      return revalidateWork(snapshot, existing, task, run, ids);
    case 'malformed':
      return correctReview(snapshot, session, task, run, report.failures, ids);
    default: {
      const _exhaustive: never = report.detail.reason;
      return _exhaustive;
    }
  }
}

function wrapupSession(snapshot: FactorySnapshot): SessionRecord | null {
  return snapshot.sessions.find((item) => item.stage === 'wrapup') ?? null;
}

function wrapupInputReady(
  snapshot: FactorySnapshot,
  existing: FactorySnapshot,
  action: PrepareInputAction,
  event: PreparedInput['wrapup'],
  ids: IdSource,
): Reduction {
  const worktree = snapshot.execution.worktreePath;
  if (snapshot.execution.stage !== 'wrapup' || worktree === null) {
    return reject(existing, 'The execution is not in wrap-up.');
  }
  action.status = 'succeeded';
  const existingSession = wrapupSession(snapshot);
  if (action.purpose === 'initial') {
    if (existingSession !== null) {
      return unchanged(existing, 'Wrap-up already started.');
    }
    const session = newSession(snapshot.execution.policy, 'wrapup', null, ids);
    snapshot.sessions.push(session);
    const prompt = stages.wrapup.turn({
      input: {
        adrPath: event.adrPath,
        baseBranch: snapshot.execution.worktreeBaseBranch,
        codeRoot: snapshot.execution.policy.codeRoot,
        contextPath: event.contextPath,
        displayRef: snapshot.ticket.displayRef,
        factoryRoot: path.dirname(path.dirname(snapshot.execution.factoryDir)),
        minorFindings: minorFindings(snapshot),
        model: session.model,
        planPath: snapshot.execution.planPath ?? '',
        pullRequests: snapshot.execution.policy.pullRequests,
        tasks: snapshot.tasks.map((task) => ({
          status: task.status,
          taskFile: `${snapshot.execution.factoryDir}/${task.taskFile}`,
          taskId: task.taskId,
          title: task.title,
          verdict: task.summaries.review?.label ?? 'none',
        })),
        usage: event.usage,
        verification: event.verification,
        worktree,
        worktreeBranch: snapshot.execution.worktreeBranch ?? '',
      },
      kind: 'initial',
    });
    const run = addRun(snapshot, session, null, 'initial', 0, ids, prompt);
    run.description = childDescription(snapshot.ticket.title);
    run.baseline = event.baseline;
    launchAction(snapshot, run, prompt, 'launch', ids, worktree);
    snapshot.execution.status = 'active';
    return finish(snapshot, 'Wrap-up queued.');
  }
  if (existingSession === null) {
    return reject(existing, 'Wrap-up session is missing.');
  }
  const parent =
    [...snapshot.runs]
      .reverse()
      .find((item) => item.sessionId === existingSession.id && item.status === 'terminal') ?? null;
  if (action.purpose === 'validation_correction') {
    // Wrap-up corrections are not counted against a limit.
    const prompt = stages.wrapup.turn({ failures: action.failures, kind: 'correction' });
    const count = snapshot.runs.filter(
      (item) => item.sessionId === existingSession.id && item.purpose === 'validation_correction',
    ).length;
    const run = addRun(
      snapshot,
      existingSession,
      parent,
      'validation_correction',
      count + 1,
      ids,
      prompt,
    );
    run.description = parent?.description ?? childDescription(snapshot.ticket.title);
    launchAction(
      snapshot,
      run,
      prompt,
      existingSession.sessionFile === null ? 'launch' : 'resume',
      ids,
      worktree,
    );
    snapshot.execution.status = 'active';
    return finish(snapshot, 'Wrap-up correction queued.');
  }
  const attention =
    snapshot.attention.find((item) => item.status === 'resuming' || item.status === 'answered') ??
    null;
  const reply =
    snapshot.replies.find(
      (item) => item.isCurrent && attention !== null && item.requestId === attention.id,
    ) ?? null;
  if (attention === null || reply === null) {
    return reject(existing, 'Reply was not stored.');
  }
  const asked = attention.runId === null ? parent : runFor(snapshot, attention.runId);
  const prompt = stages.wrapup.turn({ answer: reply.answer, kind: 'reply' });
  const run = addRun(snapshot, existingSession, asked, 'human_reply', 0, ids, prompt);
  run.description = asked?.description ?? childDescription(snapshot.ticket.title);
  snapshot.actions.push({
    attempts: 0,
    attentionReplyId: reply.id,
    attentionRequestId: attention.id,
    cwd: worktree,
    id: ids.action(),
    idempotencyKey: `resume:${reply.id}:${run.id}`,
    kind: 'resume_run',
    lastError: null,
    maxAttempts: snapshot.execution.policy.limits.infrastructureRetries,
    prompt,
    retryOfActionId: null,
    runId: run.id,
    status: 'pending',
  });
  attention.status = 'resuming';
  snapshot.execution.status = 'resuming';
  return finish(snapshot, 'Reply stored. Resuming wrap-up.');
}

function finishWrapupValidation(
  snapshot: FactorySnapshot,
  run: RunRecord,
  action: Extract<ActionRecord, { kind: 'validate_run' }>,
  report: Exclude<WrapupValidationReport, { status: 'error' }>,
  ids: IdSource,
): Reduction {
  action.status = 'succeeded';
  if (report.status === 'failed') {
    enqueueInput(snapshot, 'wrapup', {
      failures: report.failures,
      idempotencyKey: `wrapup-input:${run.id}:correction`,
      ids,
      purpose: 'validation_correction',
    });
    snapshot.execution.status = 'active';
    return finish(snapshot, 'Wrap-up validation failed.');
  }
  // Passed: the human takes it from here. The session stays open for reading.
  const ref = snapshot.ticket.displayRef;
  snapshot.execution.status = 'ready_for_handoff';
  snapshot.execution.retry = null;
  snapshot.execution.statusReasonCode = null;
  snapshot.execution.statusReason = null;
  const worktree = snapshot.execution.worktreePath ?? snapshot.execution.policy.codeRoot;
  const base = {
    attempts: 0,
    attentionReplyId: null,
    attentionRequestId: null,
    lastError: null,
    maxAttempts: snapshot.execution.policy.limits.infrastructureRetries,
    retryOfActionId: null,
    runId: run.id,
    status: 'pending' as const,
  };
  snapshot.actions.push(
    {
      ...base,
      id: ids.action(),
      idempotencyKey: `pane:session:${run.id}`,
      kind: 'open_pane',
      name: `${stages.wrapup.emoji} ${ref}`,
    },
    {
      ...base,
      cwd: worktree,
      id: ids.action(),
      idempotencyKey: `pane:diff:${run.id}`,
      kind: 'open_diff',
      name: `🔀 ${ref}`,
    },
  );
  resolveOpen(snapshot);
  snapshot.attention.push({
    id: ids.attention(),
    kind: 'manual_approval',
    question: [
      `${ref} is ready for handoff. The wrap-up session and the diff are open in their own panes.`,
      '',
      report.detail.usage,
      '',
      `Merge it yourself, then run /factory complete ${snapshot.ticket.commandRef}.`,
    ].join('\n'),
    runId: run.id,
    status: 'open',
  });
  const attention = snapshot.attention.at(-1);
  if (attention !== undefined) {
    snapshot.actions.push({
      attempts: 0,
      attentionReplyId: null,
      attentionRequestId: attention.id,
      id: ids.action(),
      idempotencyKey: `notify:${attention.id}`,
      kind: 'notify_attention',
      lastError: null,
      maxAttempts: 1,
      message: attention.question,
      retryOfActionId: null,
      runId: null,
      status: 'pending',
    });
  }
  return finish(snapshot, `${ref} is ready for handoff.`);
}

// Work starts, corrects, or resumes once its input is checked; the session
// and run are created here so they exist only for a ready input.
function workInputReady(
  snapshot: FactorySnapshot,
  existing: FactorySnapshot,
  action: PrepareInputAction,
  event: PreparedInput['work'],
  ids: IdSource,
): Reduction {
  const task = action.taskId === null ? null : taskById(snapshot, action.taskId);
  const worktree = snapshot.execution.worktreePath;
  if (task === null || worktree === null) {
    return reject(existing, 'Work task is missing.');
  }
  action.status = 'succeeded';
  if (action.purpose === 'initial') {
    enterStage(task, 'work');
    const session = newSession(snapshot.execution.policy, 'work', task.taskId, ids);
    snapshot.sessions.push(session);
    const prompt = stages.work.turn({
      input: {
        adrPath: event.adrPath,
        commands: snapshot.execution.policy.validation.work.commands,
        contextPath: event.contextPath,
        dependencies: task.blockedBy.map((id) => ({
          status: taskById(snapshot, id)?.status ?? 'missing',
          taskId: id,
        })),
        displayRef: snapshot.ticket.displayRef,
        planPath: snapshot.execution.planPath ?? '',
        taskFile: `${snapshot.execution.factoryDir}/${task.taskFile}`,
        taskId: task.taskId,
        taskType: event.taskType,
        title: task.title,
        worktree,
        worktreeBranch: snapshot.execution.worktreeBranch ?? '',
      },
      kind: 'initial',
    });
    const run = addRun(snapshot, session, null, 'initial', 0, ids, prompt);
    run.description = childDescription(task.title);
    launchAction(snapshot, run, prompt, 'launch', ids, worktree);
    return finish(snapshot, `Work queued for task ${task.taskId}.`);
  }
  const session =
    snapshot.sessions.find((item) => item.stage === 'work' && item.taskId === task.taskId) ?? null;
  if (session === null) {
    return reject(existing, 'Work session is missing.');
  }
  if (action.purpose === 'validation_correction' || action.purpose === 'return_to_work') {
    const review = action.purpose === 'return_to_work';
    // A return names the round of the stage that sent the task back.
    const returnRound = action.origin === null ? 0 : (task.summaries[action.origin]?.round ?? 0);
    const prompt = review
      ? stages.work.turn({ kind: 'return', problems: action.failures, round: returnRound })
      : stages.work.turn({ failures: action.failures, kind: 'correction' });
    const parent =
      [...snapshot.runs]
        .reverse()
        .find((item) => item.sessionId === session.id && item.status === 'terminal') ?? null;
    const count = snapshot.runs.filter(
      (item) => item.sessionId === session.id && item.purpose === 'validation_correction',
    ).length;
    const run = addRun(
      snapshot,
      session,
      parent,
      action.purpose,
      review ? returnRound : count + 1,
      ids,
      prompt,
    );
    run.origin = review ? action.origin : null;
    run.description = parent?.description ?? childDescription(task.title);
    launchAction(
      snapshot,
      run,
      prompt,
      session.sessionFile === null ? 'launch' : 'resume',
      ids,
      worktree,
    );
    snapshot.execution.status = 'active';
    return finish(
      snapshot,
      review
        ? `Review changes queued for task ${task.taskId}.`
        : `Work correction queued for task ${task.taskId}.`,
    );
  }
  const attention =
    snapshot.attention.find((item) => item.status === 'resuming' || item.status === 'answered') ??
    null;
  const reply =
    snapshot.replies.find(
      (item) => item.isCurrent && attention !== null && item.requestId === attention.id,
    ) ?? null;
  if (attention === null || reply === null) {
    return reject(existing, 'Reply was not stored.');
  }
  const parent = attention.runId === null ? null : runFor(snapshot, attention.runId);
  const prompt = stages.work.turn({ answer: reply.answer, kind: 'reply' });
  const run = addRun(
    snapshot,
    session,
    parent,
    'human_reply',
    parent?.semanticRound ?? 0,
    ids,
    prompt,
  );
  run.description = parent?.description ?? childDescription(task.title);
  snapshot.actions.push({
    attempts: 0,
    attentionReplyId: reply.id,
    attentionRequestId: attention.id,
    cwd: worktree,
    id: ids.action(),
    idempotencyKey: `resume:${reply.id}:${run.id}`,
    kind: 'resume_run',
    lastError: null,
    maxAttempts: snapshot.execution.policy.limits.infrastructureRetries,
    prompt,
    retryOfActionId: null,
    runId: run.id,
    status: 'pending',
  });
  attention.status = 'resuming';
  snapshot.execution.status = 'resuming';
  return finish(snapshot, 'Reply stored. Resuming the session.');
}

export function reduce(input: {
  event: ControllerEvent;
  ids: IdSource;
  now: string;
  snapshot: FactorySnapshot | null;
}): Reduction {
  if (input.event.kind === 'start') {
    return reduceStart(input.snapshot, input.event, input.ids);
  }
  const { event, ids, now } = input;
  const existing = input.snapshot;
  if (existing === null) {
    return reject(null, 'No factory execution exists for that ticket.');
  }
  const snapshot = structuredClone(existing);

  switch (event.kind) {
    case 'runtime_terminal': {
      const run = runFor(snapshot, event.runId);
      if (run === null) {
        return reject(existing, 'Runtime event does not match a run.');
      }
      if (run.status === 'terminal') {
        return unchanged(existing, 'Duplicate terminal event ignored.');
      }
      const usage = applyTerminal(snapshot, run, event.terminal, now, ids);
      return finish(snapshot, `Run ended with ${event.terminal.kind}.`, usage);
    }
    case 'validation_finished': {
      const run = runFor(snapshot, event.runId);
      const action = snapshot.actions.find((item) => item.id === event.actionId) ?? null;
      if (run === null || action === null || action.kind !== 'validate_run') {
        return reject(existing, 'Validation result does not match a run.');
      }
      if (
        action.status === 'succeeded' ||
        action.status === 'failed' ||
        action.status === 'cancelled'
      ) {
        return unchanged(existing, 'Duplicate validation event ignored.');
      }
      // An error asks nothing of the agent: it retries the validation.
      if (event.report.status === 'error') {
        return retryValidation(snapshot, run, action, event.report.summary, ids);
      }
      if (event.stage === 'work') {
        return finishWorkValidation(snapshot, existing, run, action, event.report, ids);
      }
      if (event.stage === 'review') {
        return finishReviewValidation(snapshot, existing, run, action, event.report, ids);
      }
      if (event.stage === 'wrapup') {
        return finishWrapupValidation(snapshot, run, action, event.report, ids);
      }
      const report = event.report;
      if (run.resultStatus !== 'valid' || run.resultHash === null) {
        return reject(existing, 'Validation requires a valid plan result.');
      }
      action.status = 'succeeded';
      if (report.status === 'failed') {
        const session = sessionFor(snapshot, run.sessionId);
        if (session === null) {
          return reject(existing, 'Plan session is missing.');
        }
        scheduleCorrection(snapshot, session, run, report.failures, ids);
        return finish(snapshot, 'Plan validation failed.');
      }
      snapshot.tasks = report.detail.tasks.map((task) => ({
        blockedBy: task.blockedBy,
        ordinal: task.ordinal,
        specHash: task.specHash,
        stage: null,
        status: 'pending',
        summaries: {},
        taskFile: task.taskFile,
        taskId: task.taskId,
        title: task.title,
      }));
      snapshot.execution.stage = 'work';
      snapshot.execution.status = 'active';
      snapshot.execution.planPath = report.detail.planPath;
      snapshot.actions.push({
        attempts: 0,
        attentionReplyId: null,
        attentionRequestId: null,
        id: ids.action(),
        idempotencyKey: `worktree:${snapshot.execution.id}`,
        kind: 'prepare_worktree',
        lastError: null,
        maxAttempts: 3,
        retryOfActionId: null,
        runId: null,
        slug: snapshot.execution.factoryDir.split('/').at(-1) ?? snapshot.execution.id,
        status: 'pending',
      });
      return finish(snapshot, 'Plan accepted. Preparing the worktree.');
    }
    case 'worktree_ready': {
      const action = snapshot.actions.find((item) => item.id === event.actionId) ?? null;
      if (action === null || action.kind !== 'prepare_worktree') {
        return reject(existing, 'Worktree result does not match an action.');
      }
      action.status = 'succeeded';
      snapshot.execution.worktreePath = event.worktreePath;
      snapshot.execution.worktreeBranch = event.branch;
      snapshot.execution.worktreeBaseBranch = event.baseBranch;
      snapshot.execution.worktreeBaseSha = event.baseSha;
      snapshot.execution.worktreeStatus = 'ready';
      const task = lowestReady(snapshot);
      if (task === null) {
        return reject(existing, 'Plan has no runnable task.');
      }
      enqueueInput(snapshot, 'work', {
        failures: [],
        idempotencyKey: `work-input:${snapshot.execution.id}:${task.taskId}:initial`,
        ids,
        purpose: 'initial',
        taskId: task.taskId,
      });
      return finish(snapshot, `Work input queued for task ${task.taskId}.`);
    }
    case 'worktree_failed': {
      const action = snapshot.actions.find((item) => item.id === event.actionId) ?? null;
      if (action === null || action.kind !== 'prepare_worktree') {
        return reject(existing, 'Worktree failure does not match an action.');
      }
      action.status = 'failed';
      action.lastError = event.message;
      snapshot.execution.status = 'failed';
      snapshot.execution.retry = { kind: 'worktree' };
      snapshot.execution.worktreeStatus = 'failed';
      snapshot.execution.statusReasonCode = 'worktree_failed';
      snapshot.execution.statusReason = event.message;
      return finish(snapshot, event.message);
    }
    case 'input_ready': {
      const action = snapshot.actions.find((item) => item.id === event.actionId) ?? null;
      if (action === null || action.kind !== 'prepare_input' || action.stage !== event.stage) {
        return reject(existing, 'Input result does not match an action.');
      }
      if (action.status === 'succeeded') {
        return unchanged(existing, 'Duplicate input event ignored.');
      }
      return event.stage === 'work'
        ? workInputReady(snapshot, existing, action, event.input, ids)
        : wrapupInputReady(snapshot, existing, action, event.input, ids);
    }
    case 'input_failed': {
      const action = snapshot.actions.find((item) => item.id === event.actionId) ?? null;
      if (action === null || action.kind !== 'prepare_input') {
        return reject(existing, 'Input failure does not match an action.');
      }
      if (action.status === 'failed') {
        return unchanged(existing, 'Duplicate input failure ignored.');
      }
      action.status = 'failed';
      action.lastError = event.message;
      pauseWithNotice(snapshot, {
        code: `${action.stage}_input_invalid`,
        failures: [event.message],
        ids,
        // A failed reply keeps its stored answer, so a retry still carries it.
        keepReply: action.purpose === 'human_reply',
        question: `${stages[action.stage].label} cannot start:\n${event.message}`,
        retry: { kind: 'input' },
      });
      return finish(snapshot, event.message);
    }
    case 'complete': {
      if (event.ticketId !== snapshot.ticket.id) {
        return reject(existing, 'Complete does not match the current ticket.');
      }
      if (snapshot.execution.status === 'complete') {
        return unchanged(existing, `${snapshot.ticket.displayRef} is already complete.`);
      }
      if (snapshot.execution.status !== 'ready_for_handoff') {
        return reject(
          existing,
          `${snapshot.ticket.displayRef} is ${snapshot.execution.stage}/${snapshot.execution.status}, not ready for handoff.`,
        );
      }
      resolveOpen(snapshot);
      for (const session of snapshot.sessions) {
        if (session.status === 'open' || session.status === 'prepared') {
          session.status = 'completed';
        }
      }
      snapshot.execution.stage = 'done';
      snapshot.execution.status = 'complete';
      return finish(snapshot, `${snapshot.ticket.displayRef} is complete.`);
    }
    case 'run_started': {
      const run = runFor(snapshot, event.runId);
      const action = snapshot.actions.find((item) => item.id === event.actionId) ?? null;
      if (run === null || action === null) {
        return reject(existing, 'Launch result does not match a run.');
      }
      if (action.kind !== 'launch_run' && action.kind !== 'resume_run') {
        return reject(existing, 'Launch result does not match a launch action.');
      }
      if (run.status === 'running' && run.paneId === event.paneId) {
        return unchanged(existing, 'Run is already started.', run.id);
      }
      action.status = 'succeeded';
      run.status = 'running';
      run.startedAt ??= now;
      run.paneId = event.paneId;
      run.paneName = event.paneName;
      run.subagentId = event.runId;
      const session = sessionFor(snapshot, run.sessionId);
      if (session !== null) {
        session.status = 'open';
        session.sessionFile = event.sessionFile;
        session.piSessionId = event.piSessionId;
        if (session.taskId !== null) {
          const task = taskById(snapshot, session.taskId);
          if (task !== null && (task.status === 'active' || task.status === 'blocked')) {
            enterStage(task, session.stage);
          }
        }
      }
      if (snapshot.execution.status === 'queued' || snapshot.execution.status === 'resuming') {
        snapshot.execution.status = 'active';
      }
      return finish(snapshot, `Launched ${event.paneName}.`, null, run.id);
    }
    case 'launch_failed': {
      const run = runFor(snapshot, event.runId);
      const action = snapshot.actions.find((item) => item.id === event.actionId) ?? null;
      if (run === null || action === null) {
        return reject(existing, 'Launch failure does not match a run.');
      }
      if (run.status === 'terminal') {
        return unchanged(existing, 'Duplicate launch failure ignored.');
      }
      if (action.status === 'pending' || action.status === 'leased') {
        action.status = 'failed';
        action.lastError = event.message;
      }
      run.status = 'terminal';
      run.terminalKind = 'launch_failed';
      run.endedAt = now;
      scheduleInfrastructure(snapshot, run, event.message, ids);
      return finish(snapshot, event.message);
    }
    case 'reply': {
      if (event.ticketId !== snapshot.ticket.id) {
        return reject(existing, 'Reply does not match the current ticket.');
      }
      if (
        snapshot.execution.status !== 'waiting_for_user' &&
        snapshot.execution.status !== 'paused'
      ) {
        return reject(existing, 'This ticket is not waiting for a reply.');
      }
      // A retryable pause takes only a retry; otherwise a reply resumes the run
      // that paused the ticket, and a pause no run asked for takes neither.
      if (snapshot.execution.retry !== null) {
        return reject(existing, `Retry with /factory retry ${snapshot.ticket.commandRef}.`);
      }
      const attention =
        snapshot.attention.find((item) => item.status === 'open' || item.status === 'answered') ??
        null;
      if (attention === null) {
        return reject(existing, 'There is no open question to answer.');
      }
      if (attention.runId === null) {
        return reject(existing, 'No agent is waiting for a reply to this pause.');
      }
      if (snapshot.replies.some((reply) => reply.idempotencyKey === event.idempotencyKey)) {
        return unchanged(existing, 'Duplicate reply ignored.');
      }
      const answerHash = sha256(event.answer);
      if (snapshot.replies.some((reply) => reply.isCurrent && reply.answerHash === answerHash)) {
        return unchanged(existing, 'That answer is already current.');
      }
      for (const reply of snapshot.replies) {
        if (reply.requestId === attention.id) {
          reply.isCurrent = false;
        }
      }
      const version =
        snapshot.replies.filter((reply) => reply.requestId === attention.id).length + 1;
      snapshot.replies.push({
        answer: event.answer,
        answerHash,
        id: ids.reply(),
        idempotencyKey: event.idempotencyKey,
        isCurrent: true,
        requestId: attention.id,
        version,
      });
      const reply = snapshot.replies.at(-1);
      if (reply === undefined) {
        return reject(existing, 'Reply was not stored.');
      }
      attention.status = 'resuming';
      const parent = attention.runId === null ? null : runFor(snapshot, attention.runId);
      const session = parent === null ? null : sessionFor(snapshot, parent.sessionId);
      if (session === null) {
        return reject(existing, 'No session is available to resume.');
      }
      if (session.stage === 'work' && session.taskId !== null) {
        enqueueInput(snapshot, 'work', {
          failures: [],
          idempotencyKey: `work-input:${reply.id}`,
          ids,
          purpose: 'human_reply',
          taskId: session.taskId,
        });
        snapshot.execution.status = 'resuming';
        return finish(snapshot, 'Reply stored. Checking the work input.');
      }
      if (session.stage === 'wrapup') {
        enqueueInput(snapshot, 'wrapup', {
          failures: [],
          idempotencyKey: `wrapup-input:${reply.id}`,
          ids,
          purpose: 'human_reply',
        });
        snapshot.execution.status = 'resuming';
        return finish(snapshot, 'Reply stored. Checking the wrap-up input.');
      }
      const prompt = stages[session.stage].turn({ answer: event.answer, kind: 'reply' });
      const run = addRun(
        snapshot,
        session,
        parent,
        'human_reply',
        parent?.semanticRound ?? 0,
        ids,
        prompt,
      );
      run.description = parent?.description ?? childDescription(snapshot.ticket.title);
      snapshot.actions.push({
        attempts: 0,
        attentionReplyId: reply.id,
        attentionRequestId: attention.id,
        cwd: sessionCwd(snapshot, session),
        id: ids.action(),
        idempotencyKey: `resume:${reply.id}:${run.id}`,
        kind: 'resume_run',
        lastError: null,
        maxAttempts: snapshot.execution.policy.limits.infrastructureRetries,
        prompt,
        retryOfActionId: null,
        runId: run.id,
        status: 'pending',
      });
      snapshot.execution.status = 'resuming';
      return finish(snapshot, 'Reply stored. Resuming the session.');
    }
    case 'retry': {
      if (event.ticketId !== snapshot.ticket.id) {
        return reject(existing, 'Retry does not match the current ticket.');
      }
      const retry = snapshot.execution.retry;
      if (retry === null) {
        return reject(existing, 'This ticket is not waiting for retry.');
      }
      switch (retry.kind) {
        case 'input': {
          const failed = [...snapshot.actions]
            .reverse()
            .find(
              (item): item is PrepareInputAction =>
                item.kind === 'prepare_input' && item.status === 'failed',
            );
          if (failed === undefined) {
            return reject(existing, 'Nothing failed that can be retried.');
          }
          // A failed reply keeps its stored answer, so the retry still carries it.
          resolveOpen(snapshot, failed.purpose === 'human_reply');
          enqueueInput(snapshot, failed.stage, {
            failures: failed.failures,
            idempotencyKey: `${failed.stage}-input-retry:${event.idempotencyKey}`,
            ids,
            purpose: failed.purpose,
            ...(failed.origin === null ? {} : { origin: failed.origin }),
            ...(failed.taskId === null ? {} : { taskId: failed.taskId }),
          });
          snapshot.execution.status = failed.purpose === 'human_reply' ? 'resuming' : 'active';
          snapshot.execution.retry = null;
          return finish(
            snapshot,
            `Retrying ${stages[failed.stage].label.toLowerCase()} input preparation.`,
          );
        }
        case 'revalidate': {
          const task = taskById(snapshot, retry.taskId);
          const workRun = task === null ? null : latestWorkRun(snapshot, task.taskId);
          if (task === null || workRun === null) {
            return reject(existing, 'No finished work run can be validated again.');
          }
          resolveOpen(snapshot);
          enterStage(task, 'work');
          snapshot.execution.stage = 'work';
          snapshot.execution.status = 'active';
          snapshot.execution.retry = null;
          enqueueValidation(
            snapshot,
            workRun,
            `validate:${workRun.id}:retry:${event.idempotencyKey}`,
            ids,
          );
          return finish(snapshot, 'Validating the work again.');
        }
        case 'validate': {
          const run =
            [...snapshot.runs].reverse().find((item) => item.terminalKind === 'subagent_done') ??
            null;
          if (run === null) {
            return reject(existing, 'Nothing failed that can be retried.');
          }
          snapshot.actions.push({
            attempts: 0,
            attentionReplyId: null,
            attentionRequestId: null,
            id: ids.action(),
            idempotencyKey: `validate-retry:${event.idempotencyKey}`,
            kind: 'validate_run',
            lastError: null,
            maxAttempts: snapshot.execution.policy.limits.infrastructureRetries,
            retryOfActionId: null,
            runId: run.id,
            status: 'pending',
          });
          snapshot.execution.status = 'active';
          snapshot.execution.retry = null;
          return finish(snapshot, 'Retrying validation.');
        }
        case 'resume_reply': {
          const reply = snapshot.replies.find((item) => item.isCurrent) ?? null;
          const attention =
            snapshot.attention.find(
              (item) => item.status === 'answered' || item.status === 'resuming',
            ) ?? null;
          const parent =
            attention?.runId === null || attention === null
              ? null
              : runFor(snapshot, attention.runId);
          const session = parent === null ? null : sessionFor(snapshot, parent.sessionId);
          if (reply === null || attention === null || session === null) {
            return reject(existing, 'Retry needs the stored reply.');
          }
          const prompt = stages[session.stage].turn({ answer: reply.answer, kind: 'reply' });
          const run = addRun(
            snapshot,
            session,
            parent,
            'infrastructure_retry',
            parent?.semanticRound ?? 0,
            ids,
            prompt,
          );
          run.description = parent?.description ?? childDescription(snapshot.ticket.title);
          snapshot.actions.push({
            attempts: 0,
            attentionReplyId: reply.id,
            attentionRequestId: attention.id,
            cwd: sessionCwd(snapshot, session),
            id: ids.action(),
            idempotencyKey: `retry:${event.idempotencyKey}:${run.id}`,
            kind: 'resume_run',
            lastError: null,
            maxAttempts: snapshot.execution.policy.limits.infrastructureRetries,
            prompt,
            retryOfActionId: null,
            runId: run.id,
            status: 'pending',
          });
          attention.status = 'resuming';
          snapshot.execution.status = 'resuming';
          snapshot.execution.retry = null;
          return finish(snapshot, 'Retrying with the stored reply.');
        }
        case 'worktree': {
          const failedWorktree = [...snapshot.actions]
            .reverse()
            .find(
              (item): item is Extract<ActionRecord, { kind: 'prepare_worktree' }> =>
                item.kind === 'prepare_worktree' && item.status === 'failed',
            );
          if (failedWorktree === undefined) {
            return reject(existing, 'Nothing failed that can be retried.');
          }
          snapshot.actions.push({
            attempts: 0,
            attentionReplyId: null,
            attentionRequestId: null,
            id: ids.action(),
            idempotencyKey: `worktree-retry:${event.idempotencyKey}`,
            kind: 'prepare_worktree',
            lastError: null,
            maxAttempts: 3,
            retryOfActionId: failedWorktree.id,
            runId: null,
            slug: failedWorktree.slug,
            status: 'pending',
          });
          snapshot.execution.status = 'active';
          snapshot.execution.retry = null;
          snapshot.execution.worktreeStatus = 'preparing';
          return finish(snapshot, 'Retrying worktree preparation.');
        }
        case 'relaunch': {
          const parent = snapshot.runs.at(-1) ?? null;
          const session = parent === null ? null : sessionFor(snapshot, parent.sessionId);
          if (session === null || parent === null) {
            return reject(existing, 'Nothing failed that can be retried.');
          }
          const prompt = [
            `Follow the ${stages[session.stage].skill} skill.`,
            '',
            `Retry after failure: ${snapshot.execution.statusReason ?? 'unknown'}`,
            'Continue the same task.',
          ].join('\n');
          const run = addRun(
            snapshot,
            session,
            parent,
            'infrastructure_retry',
            parent.semanticRound,
            ids,
            prompt,
          );
          run.description = parent.description ?? childDescription(snapshot.ticket.title);
          launchAction(
            snapshot,
            run,
            prompt,
            session.sessionFile === null ? 'launch' : 'resume',
            ids,
            sessionCwd(snapshot, session),
          );
          snapshot.execution.status = 'active';
          snapshot.execution.retry = null;
          return finish(snapshot, 'Retrying the failed launch.');
        }
        default: {
          const _exhaustive: never = retry;
          return _exhaustive;
        }
      }
    }
    case 'reconciled': {
      const run = runFor(snapshot, event.runId);
      if (run === null) {
        return reject(existing, 'Reconcile does not match a run.');
      }
      if (run.status === 'terminal') {
        return unchanged(existing, 'Terminal run was not relaunched.');
      }
      const observation = event.observation;
      switch (observation.kind) {
        case 'still_running': {
          const action =
            snapshot.actions.find(
              (item) =>
                item.runId === run.id &&
                (item.kind === 'launch_run' || item.kind === 'resume_run') &&
                (item.status === 'pending' || item.status === 'leased'),
            ) ?? null;
          if (action !== null) {
            action.status = 'succeeded';
          }
          run.status = 'running';
          run.paneId = observation.paneId;
          run.subagentId = run.id;
          const session = sessionFor(snapshot, run.sessionId);
          if (session !== null && observation.sessionFile !== null) {
            session.sessionFile = observation.sessionFile;
            session.piSessionId = observation.piSessionId;
            session.status = 'open';
          }
          if (snapshot.execution.status === 'queued') {
            snapshot.execution.status = 'active';
          }
          return finish(snapshot, 'Recovered the running child.', null, run.id);
        }
        case 'missing': {
          const action =
            snapshot.actions.find(
              (item) =>
                item.runId === run.id &&
                (item.kind === 'launch_run' || item.kind === 'resume_run') &&
                item.status === 'leased',
            ) ?? null;
          if (action === null) {
            return unchanged(existing, 'Pending launch will be dispatched.');
          }
          if (action.attempts + 1 > action.maxAttempts) {
            action.status = 'failed';
            action.lastError = 'Expired launch lease could not be reconciled.';
            run.status = 'terminal';
            run.terminalKind = 'launch_failed';
            run.endedAt = now;
            snapshot.execution.status = 'failed';
            snapshot.execution.retry = { kind: 'relaunch' };
            snapshot.execution.statusReason = action.lastError;
            return finish(snapshot, action.lastError);
          }
          action.status = 'pending';
          action.attempts += 1;
          return finish(snapshot, 'Expired launch lease returned to the queue.');
        }
        case 'terminal': {
          const usage = applyTerminal(snapshot, run, observation.terminal, now, ids);
          return finish(
            snapshot,
            `Reconciled a finished child (${observation.terminal.kind}).`,
            usage,
          );
        }
        default: {
          const _exhaustive: never = observation;
          return _exhaustive;
        }
      }
    }
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}
