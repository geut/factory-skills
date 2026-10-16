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
  type Retry,
  type RunId,
  type RunPurpose,
  type RunRecord,
  type SessionRecord,
  type StageName,
  type TaskId,
  type TaskRecord,
  type TerminalOutcome,
  type UsageWrite,
} from '../domain.ts';
import { sha256 } from '../hash.ts';
import { childDescription } from '../runtime/policy.ts';
import type { Handoff, Outcome, StageDefinition, StageView } from '../stages/definition.ts';
import { flow, nextStep, previousTaskStage, type Step } from '../stages/flow.ts';
import { isInputStage, stages, type InputStage, type PreparedInput } from '../stages/index.ts';
import { worktreeSlugFor } from './keys.ts';
import { currentStep, nextAction, progressText } from './progress.ts';

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
  // A reply being prepared keeps its question, which stays the one unresolved
  // question of the execution; a retry then carries the stored answer.
  const kept =
    input.keepReply === true
      ? (snapshot.attention.find((item) => item.status === 'resuming') ?? null)
      : null;
  if (kept === null) {
    snapshot.attention.push({
      id: input.ids.attention(),
      kind: 'policy_limit',
      question: input.question,
      runId: input.runId ?? null,
      status: 'open',
    });
  }
  const attention = kept ?? snapshot.attention.at(-1);
  if (attention === undefined) {
    return;
  }
  const once = kept === null ? attention.id : `${attention.id}:${input.ids.action()}`;
  trackerUpdate(snapshot, input.ids, {
    comment: pausedComment(snapshot, input.question),
    issueStatus: null,
    key: `paused:${once}`,
    update: 'paused',
  });
  snapshot.actions.push({
    attempts: 0,
    attentionReplyId: null,
    attentionRequestId: attention.id,
    id: input.ids.action(),
    idempotencyKey: `notify:${once}`,
    kind: 'notify_attention',
    lastError: null,
    maxAttempts: 1,
    message: input.question,
    retryOfActionId: null,
    runId: null,
    status: 'pending',
  });
}

// Queues a tracker update for a ticket that came from a tracker: a comment and,
// when given, a status. Local files and --text tickets have no issue to update.
export function trackerUpdate(
  snapshot: FactorySnapshot,
  ids: IdSource,
  input: {
    comment: string;
    issueStatus: 'clear' | 'in_progress' | 'in_review' | null;
    key: string;
    update: 'cancelled' | 'handoff' | 'paused' | 'started';
  },
): void {
  if (snapshot.ticket.sourceKind === 'file' || snapshot.ticket.sourceKind === 'text') {
    return;
  }
  snapshot.actions.push({
    attempts: 0,
    attentionReplyId: null,
    attentionRequestId: null,
    comment: input.comment,
    id: ids.action(),
    idempotencyKey: `tracker:${snapshot.execution.id}:${input.key}`,
    issueStatus: input.issueStatus,
    kind: 'update_ticket_source',
    lastError: null,
    maxAttempts: 3,
    retryOfActionId: null,
    runId: null,
    status: 'pending',
    update: input.update,
  });
}

// The comment a pause that needs a person leaves on the issue.
function pausedComment(snapshot: FactorySnapshot, question: string): string {
  return [
    'The factory paused this ticket and needs a person:',
    '',
    question
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n'),
    '',
    `Answer from the dashboard, or in Pi with \`/factory reply ${snapshot.ticket.commandRef} "answer"\`.`,
  ].join('\n');
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
  // The stages before the tasks run in the code root; the worktree exists
  // only once the tasks are known.
  if (
    !flow.ticket.some((stage) => stage === session.stage) &&
    snapshot.execution.worktreePath !== null
  ) {
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

// Asks the stage's agent to fix what its validator failed, within the
// stage's correction budget. At the limit the ticket pauses on the run, so a
// reply resumes that agent with the person's guidance.
function correct(
  snapshot: FactorySnapshot,
  session: SessionRecord,
  parent: RunRecord,
  failures: Array<string>,
  ids: IdSource,
): 'correcting' | 'paused' {
  const stage = stages[session.stage];
  const policy = stage.corrections;
  const count = snapshot.runs.filter(
    (run) =>
      run.sessionId === session.id &&
      run.purpose === 'validation_correction' &&
      (policy.per === 'session' || run.semanticRound === parent.semanticRound),
  ).length;
  const task = session.taskId === null ? null : taskById(snapshot, session.taskId);
  if (policy.limit !== null && count >= snapshot.execution.policy.limits[policy.limit]) {
    if (task !== null) {
      task.status = 'blocked';
    }
    pauseWithNotice(snapshot, {
      code: `${session.stage}_correction_limit`,
      failures,
      ids,
      question: [
        policy.limitNotice,
        ...failures.map((failure) => `- ${failure}`),
        'Reply to resume the agent with what it needs.',
      ].join('\n'),
      retry: null,
      runId: parent.id,
    });
    return 'paused';
  }
  snapshot.execution.status = 'active';
  if (isInputStage(session.stage)) {
    enqueueInput(snapshot, session.stage, {
      failures,
      idempotencyKey: `${session.stage}-input:${parent.id}:correction:${count + 1}`,
      ids,
      purpose: 'validation_correction',
      ...(session.taskId === null ? {} : { taskId: session.taskId }),
    });
    return 'correcting';
  }
  const prompt = stage.turn({ failures, kind: 'correction' });
  const round = policy.per === 'round' ? parent.semanticRound : count + 1;
  const run = addRun(snapshot, session, parent, 'validation_correction', round, ids, prompt);
  run.description = parent.description ?? childDescription(task?.title ?? snapshot.ticket.title);
  launchAction(
    snapshot,
    run,
    prompt,
    session.sessionFile === null ? 'launch' : 'resume',
    ids,
    sessionCwd(snapshot, session),
  );
  return 'correcting';
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
        trackerUpdate(snapshot, ids, {
          comment: pausedComment(snapshot, terminal.question),
          issueStatus: null,
          key: `paused:${attention.id}`,
          update: 'paused',
        });
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
      factoryVersion: event.factoryVersion ?? null,
      generation: event.generation ?? 1,
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
  trackerUpdate(created, ids, {
    comment: 'The factory started working on this issue.',
    issueStatus: 'in_progress',
    key: 'started',
    update: 'started',
  });
  return finish(created, `Planning queued for ${event.ticket.displayRef}.`);
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

function closeTaskSessions(snapshot: FactorySnapshot, task: TaskRecord): void {
  for (const session of snapshot.sessions) {
    if (session.taskId === task.taskId && session.status !== 'abandoned') {
      session.status = 'completed';
    }
  }
}

function latestFinishedRun(
  snapshot: FactorySnapshot,
  stage: StageName,
  taskId: TaskId,
): RunRecord | null {
  const session = sessionOf(snapshot, stage, taskId);
  if (session === null) {
    return null;
  }
  return (
    [...snapshot.runs]
      .reverse()
      .find((item) => item.sessionId === session.id && item.terminalKind === 'subagent_done') ??
    null
  );
}

// Stale runs of this stage earlier in the same round. Each one enqueued a
// validation keyed `validate:<previous stage's run>:stale:<stale run>`.
function staleRuns(snapshot: FactorySnapshot, review: RunRecord): number {
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

// A stage as the driver drives it: each stage's input, prompts, and report
// types pair up only inside that stage, so the driver hands them through.
type LooseStage = StageDefinition<unknown, StageName, unknown> & {
  conclude: (view: StageView, run: RunRecord, report: unknown) => Outcome;
};

function loose(stage: StageName): LooseStage {
  return stages[stage] as unknown as LooseStage;
}

function sessionOf(
  snapshot: FactorySnapshot,
  stage: StageName,
  taskId: TaskId | null,
): SessionRecord | null {
  return snapshot.sessions.find((item) => item.stage === stage && item.taskId === taskId) ?? null;
}

function latestTerminalRun(snapshot: FactorySnapshot, session: SessionRecord): RunRecord | null {
  return (
    [...snapshot.runs]
      .reverse()
      .find((item) => item.sessionId === session.id && item.status === 'terminal') ?? null
  );
}

// The run of a stage's first ask for a task (or ticket). A stage with rounds
// resumes its earlier session for a later round, so its agent can check its
// earlier findings.
function launchStage(
  snapshot: FactorySnapshot,
  stage: StageName,
  task: TaskRecord | null,
  from: { handoff: Handoff | null; prepared: unknown },
  ids: IdSource,
): string {
  const definition = loose(stage);
  if (definition.input === undefined) {
    throw new Error(`The ${stage} stage starts from the ticket, not from the flow.`);
  }
  if (task !== null) {
    enterStage(task, stage);
  }
  snapshot.execution.stage = stage;
  snapshot.execution.status = 'active';
  const previous = sessionOf(snapshot, stage, task?.taskId ?? null);
  const session =
    previous ?? newSession(snapshot.execution.policy, stage, task?.taskId ?? null, ids);
  if (previous === null) {
    snapshot.sessions.push(session);
  }
  const round = definition.rounds ? (task?.summaries[stage]?.round ?? 0) + 1 : 0;
  const prompt = definition.turn({
    input: definition.input({ snapshot, task }, { ...from, round }),
    kind: 'initial',
  });
  const run = addRun(
    snapshot,
    session,
    null,
    previous === null ? 'initial' : 'reentry',
    round,
    ids,
    prompt,
  );
  run.description = childDescription(task?.title ?? snapshot.ticket.title);
  run.baseline = definition.runBaseline?.(from.prepared) ?? null;
  // The stage answers for exactly the diff it was given.
  run.diffHash = from.handoff === null ? null : sha256(from.handoff.diff);
  launchAction(
    snapshot,
    run,
    prompt,
    session.sessionFile === null ? 'launch' : 'resume',
    ids,
    sessionCwd(snapshot, session),
  );
  const what = definition.rounds ? `${definition.label} round ${round}` : definition.label;
  return task === null ? `${what} queued.` : `${what} queued for task ${task.taskId}.`;
}

// Starts what the flow runs next. Input preparation comes first for a stage
// that has it; a per-task stage first needs the worktree.
function begin(
  snapshot: FactorySnapshot,
  step: Step,
  ids: IdSource,
  handoff: Handoff | null,
): string {
  switch (step.kind) {
    case 'handoff':
      throw new Error('Handoff follows the closing stage, not a start.');
    case 'waiting': {
      const waiting = step.taskIds.join(', ');
      pauseWithNotice(snapshot, {
        code: 'no_ready_task',
        failures: [`No remaining task is ready: ${waiting}.`],
        ids,
        question: `No remaining task is ready: ${waiting}.`,
        retry: null,
      });
      return 'No remaining task is ready.';
    }
    case 'stage': {
      const task = step.taskId === null ? null : taskById(snapshot, step.taskId);
      snapshot.execution.stage = step.stage;
      snapshot.execution.status = 'active';
      if (task !== null && snapshot.execution.worktreeStatus !== 'ready') {
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
          slug: worktreeSlugFor(snapshot.execution.factoryDir, snapshot.execution.generation),
          status: 'pending',
        });
        return 'Preparing the worktree.';
      }
      if (isInputStage(step.stage)) {
        // A stage with rounds is entered again after each return to work.
        const entries = snapshot.actions.filter(
          (action) =>
            action.kind === 'prepare_input' &&
            action.stage === step.stage &&
            action.taskId === step.taskId &&
            action.purpose === 'initial',
        ).length;
        const key = `${task === null ? '' : `${task.taskId}:`}initial${entries === 0 ? '' : `:${entries + 1}`}`;
        enqueueInput(snapshot, step.stage, {
          failures: [],
          idempotencyKey: `${step.stage}-input:${snapshot.execution.id}:${key}`,
          ids,
          purpose: 'initial',
          ...(task === null ? {} : { taskId: task.taskId }),
        });
        return task === null
          ? `${stages[step.stage].label} input queued.`
          : `${stages[step.stage].label} input queued for task ${task.taskId}.`;
      }
      return launchStage(snapshot, step.stage, task, { handoff, prepared: null }, ids);
    }
    default: {
      const _exhaustive: never = step;
      return _exhaustive;
    }
  }
}

// The worktree changed after a stage was given its diff. Validate the
// previous stage's latest attempt again so the next run gets a checked diff.
// A second change in the same round pauses: something keeps writing to the
// worktree, and another run would only spend tokens.
function revalidatePrevious(
  snapshot: FactorySnapshot,
  existing: FactorySnapshot,
  task: TaskRecord,
  stage: StageName,
  stale: RunRecord,
  ids: IdSource,
): Reduction {
  const previous = previousTaskStage(snapshot.execution.policy, stage, task);
  const earlier = previous === null ? null : latestFinishedRun(snapshot, previous, task.taskId);
  if (previous === null || earlier === null) {
    return reject(existing, 'No finished run before this stage can be validated again.');
  }
  if (staleRuns(snapshot, stale) >= 1) {
    const worktree = snapshot.execution.worktreePath ?? 'the worktree';
    const label = stages[stage].label.toLowerCase();
    const failure = `The worktree changed again while ${label} round ${stale.semanticRound} of task ${task.taskId} ran.`;
    task.status = 'blocked';
    pauseWithNotice(snapshot, {
      code: `${stage}_diff_changed`,
      failures: [failure],
      ids,
      question: [
        failure,
        `Something keeps writing files the diff includes. Check git status in ${worktree} and ignore generated files.`,
        `Then run /factory retry ${snapshot.ticket.commandRef} to validate the ${previous} again and run ${label} again.`,
      ].join('\n'),
      retry: { kind: 'revalidate', stage: previous, taskId: task.taskId },
      runId: stale.id,
    });
    return finish(snapshot, 'The worktree keeps changing.');
  }
  enterStage(task, previous);
  snapshot.execution.stage = previous;
  snapshot.execution.status = 'active';
  enqueueValidation(snapshot, earlier, `validate:${earlier.id}:stale:${stale.id}`, ids);
  return finish(snapshot, `The worktree changed. Validating the ${previous} again.`);
}

// The closing stage passed: the person takes it from here. Its session stays
// open for reading, next to the diff.
function handOff(
  snapshot: FactorySnapshot,
  session: SessionRecord,
  run: RunRecord,
  notice: string,
  ids: IdSource,
  pullRequestUrl: string | null,
): Reduction {
  const ref = snapshot.ticket.displayRef;
  const definition = stages[session.stage];
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
      name: `${definition.emoji} ${ref}`,
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
  trackerUpdate(snapshot, ids, {
    comment:
      pullRequestUrl === null
        ? 'The factory finished this ticket. Its handoff has the merge commands.'
        : `The factory finished this ticket and opened ${pullRequestUrl} for review.`,
    issueStatus: 'in_review',
    key: `handoff:${run.id}`,
    update: 'handoff',
  });
  resolveOpen(snapshot);
  snapshot.attention.push({
    id: ids.attention(),
    kind: 'manual_approval',
    question: [
      `${ref} is ready for handoff. The ${definition.label.toLowerCase()} session and the diff are open in their own panes.`,
      '',
      notice,
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

// Carries out what a stage concluded about its validated run.
function applyOutcome(
  snapshot: FactorySnapshot,
  existing: FactorySnapshot,
  session: SessionRecord,
  run: RunRecord,
  outcome: Outcome,
  ids: IdSource,
): Reduction {
  const stage = stages[session.stage];
  const task = session.taskId === null ? null : taskById(snapshot, session.taskId);
  if (session.taskId !== null && task === null) {
    return reject(existing, `The ${session.stage} task is missing.`);
  }
  if (task !== null && 'summary' in outcome && outcome.summary !== undefined) {
    task.summaries[session.stage] = outcome.summary;
  }
  switch (outcome.kind) {
    case 'correct':
      return correct(snapshot, session, run, outcome.failures, ids) === 'paused'
        ? finish(snapshot, `${stage.label} correction limit reached.`)
        : finish(snapshot, `${stage.label} validation failed.`);
    case 'pause':
      if (task !== null) {
        task.status = 'blocked';
      }
      pauseWithNotice(snapshot, {
        code: outcome.code,
        failures: outcome.failures,
        ids,
        question: outcome.question,
        retry: null,
        ...(outcome.reply ? { runId: run.id } : {}),
      });
      return finish(snapshot, outcome.message);
    case 'revalidate_previous':
      return task === null
        ? reject(existing, `The ${session.stage} stage runs for a task.`)
        : revalidatePrevious(snapshot, existing, task, session.stage, run, ids);
    case 'return_to_work': {
      if (task === null) {
        return reject(existing, `The ${session.stage} stage runs for a task.`);
      }
      enterStage(task, 'work');
      snapshot.execution.stage = 'work';
      snapshot.execution.status = 'active';
      enqueueInput(snapshot, 'work', {
        failures: outcome.problems,
        idempotencyKey: `work-input:${run.id}:${session.stage}:${outcome.summary.round}`,
        ids,
        origin: session.stage,
        purpose: 'return_to_work',
        taskId: task.taskId,
      });
      return finish(
        snapshot,
        `${stage.label} round ${outcome.summary.round} sent task ${task.taskId} back to work.`,
      );
    }
    case 'accept': {
      if (outcome.plan !== undefined) {
        snapshot.tasks = outcome.plan.tasks.map((planned) => ({
          blockedBy: planned.blockedBy,
          ordinal: planned.ordinal,
          specHash: planned.specHash,
          stage: null,
          status: 'pending',
          // A stage the task file turns off is recorded as skipped.
          summaries: Object.fromEntries(
            planned.skips.map((stage) => [stage, { counts: {}, label: 'skipped', round: 0 }]),
          ),
          taskFile: planned.taskFile,
          taskId: planned.taskId,
          title: planned.title,
        }));
        snapshot.execution.planPath = outcome.plan.path;
      }
      const step = nextStep(snapshot, session.stage, task?.taskId ?? null);
      if (step.kind === 'handoff') {
        return handOff(
          snapshot,
          session,
          run,
          outcome.notice ?? '',
          ids,
          outcome.pullRequestUrl ?? null,
        );
      }
      const sameTask = step.kind === 'stage' && task !== null && step.taskId === task.taskId;
      if (task !== null && !sameTask) {
        // The task's last per-task stage accepted: the task is done.
        task.status = 'done';
        task.stage = null;
        closeTaskSessions(snapshot, task);
        const after = nextStep(snapshot, session.stage, task.taskId);
        return finish(snapshot, `Task ${task.taskId} done. ${begin(snapshot, after, ids, null)}`);
      }
      return finish(
        snapshot,
        begin(snapshot, step, ids, sameTask ? (outcome.handoff ?? null) : null),
      );
    }
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

// A stage's input is ready: start its first run, its correction, its return
// to work, or resume it with a reply. The session and run are created here so
// they exist only for a checked input.
function inputReady(
  snapshot: FactorySnapshot,
  existing: FactorySnapshot,
  action: PrepareInputAction,
  prepared: PreparedInput[InputStage],
  ids: IdSource,
): Reduction {
  const definition = stages[action.stage];
  const task = action.taskId === null ? null : taskById(snapshot, action.taskId);
  const worktree = snapshot.execution.worktreePath;
  if ((action.taskId !== null && task === null) || worktree === null) {
    return reject(existing, `The ${action.stage} input has no task or worktree.`);
  }
  if (snapshot.execution.stage !== action.stage) {
    return reject(existing, `The execution is not in ${action.stage}.`);
  }
  action.status = 'succeeded';
  const session = sessionOf(snapshot, action.stage, action.taskId);
  const title = task?.title ?? snapshot.ticket.title;
  const forTask = task === null ? '' : ` for task ${task.taskId}`;
  if (action.purpose === 'initial') {
    if (session !== null && !definition.rounds) {
      return unchanged(existing, `${definition.label} already started.`);
    }
    return finish(
      snapshot,
      launchStage(snapshot, action.stage, task, { handoff: null, prepared }, ids),
    );
  }
  if (session === null) {
    return reject(existing, `The ${action.stage} session is missing.`);
  }
  const parent = latestTerminalRun(snapshot, session);
  if (action.purpose === 'validation_correction' || action.purpose === 'return_to_work') {
    const returned = action.purpose === 'return_to_work';
    // A return names the round of the stage that sent the task back.
    const returnRound =
      action.origin === null || task === null ? 0 : (task.summaries[action.origin]?.round ?? 0);
    const prompt = returned
      ? definition.turn({
          kind: 'return',
          origin: action.origin === null ? definition.label : stages[action.origin].label,
          problems: action.failures,
          round: returnRound,
        })
      : definition.turn({ failures: action.failures, kind: 'correction' });
    const count = snapshot.runs.filter(
      (item) => item.sessionId === session.id && item.purpose === 'validation_correction',
    ).length;
    const round = returned
      ? returnRound
      : definition.corrections.per === 'round'
        ? (parent?.semanticRound ?? 0)
        : count + 1;
    const run = addRun(snapshot, session, parent, action.purpose, round, ids, prompt);
    run.origin = returned ? action.origin : null;
    run.description = parent?.description ?? childDescription(title);
    launchAction(
      snapshot,
      run,
      prompt,
      session.sessionFile === null ? 'launch' : 'resume',
      ids,
      worktree,
    );
    snapshot.execution.status = 'active';
    const origin = action.origin === null ? definition.label : stages[action.origin].label;
    return finish(
      snapshot,
      returned
        ? `${origin} changes queued${forTask}.`
        : `${definition.label} correction queued${forTask}.`,
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
  const asked = attention.runId === null ? parent : runFor(snapshot, attention.runId);
  const prompt = definition.turn({ answer: reply.answer, kind: 'reply' });
  const run = addRun(
    snapshot,
    session,
    asked,
    'human_reply',
    asked?.semanticRound ?? 0,
    ids,
    prompt,
  );
  run.description = asked?.description ?? childDescription(title);
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

// What the stage concludes from its report. The event carries the report its
// stage's validator wrote, so the stage reads its own report type.
function conclude(
  snapshot: FactorySnapshot,
  session: SessionRecord,
  run: RunRecord,
  report: unknown,
): Outcome {
  const definition = loose(session.stage);
  const task = session.taskId === null ? null : taskById(snapshot, session.taskId);
  return definition.conclude({ snapshot, task }, run, report);
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
      const session = sessionFor(snapshot, run.sessionId);
      if (session === null || session.stage !== event.stage) {
        return reject(existing, 'Validation result does not match a session.');
      }
      action.status = 'succeeded';
      return applyOutcome(
        snapshot,
        existing,
        session,
        run,
        conclude(snapshot, session, run, event.report),
        ids,
      );
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
      const step = nextStep(snapshot, 'plan', null);
      if (step.kind !== 'stage' || step.taskId === null) {
        return reject(existing, 'Plan has no runnable task.');
      }
      return finish(snapshot, begin(snapshot, step, ids, null));
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
      return inputReady(snapshot, existing, action, event.input, ids);
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
    case 'rerun':
      // The store retires the old generation and applies the start itself.
      return reject(existing, 'A rerun is applied as a start.');
    case 'cancel': {
      if (event.ticketId !== snapshot.ticket.id) {
        return reject(existing, 'Cancel does not match the current ticket.');
      }
      if (snapshot.execution.stage === 'done') {
        return unchanged(existing, `${snapshot.ticket.displayRef} is already finished.`);
      }
      for (const run of snapshot.runs) {
        if (run.status !== 'terminal') {
          run.status = 'terminal';
          run.terminalKind = 'cancelled';
          run.endedAt = now;
        }
      }
      for (const action of snapshot.actions) {
        if (action.status === 'pending') {
          action.status = 'cancelled';
        }
      }
      for (const task of snapshot.tasks) {
        if (task.status !== 'done' && task.status !== 'cancelled') {
          task.status = 'cancelled';
          task.stage = null;
        }
      }
      for (const attention of snapshot.attention) {
        if (
          attention.status === 'open' ||
          attention.status === 'answered' ||
          attention.status === 'resuming'
        ) {
          attention.status = 'cancelled';
        }
      }
      for (const session of snapshot.sessions) {
        if (session.status === 'open' || session.status === 'prepared') {
          session.status = 'abandoned';
        }
      }
      snapshot.execution.stage = 'done';
      snapshot.execution.status = 'cancelled';
      snapshot.execution.retry = null;
      snapshot.execution.statusReasonCode = 'cancelled_by_actor';
      snapshot.execution.statusReason = event.reason ?? 'Cancelled by a person.';
      trackerUpdate(snapshot, ids, {
        comment: [
          `The factory stopped working on this issue: cancelled${event.by === null ? '' : ` by ${event.by}`}.`,
          ...(event.reason === null ? [] : ['', `> ${event.reason}`]),
        ].join('\n'),
        issueStatus: 'clear',
        key: 'cancelled',
        update: 'cancelled',
      });
      return finish(snapshot, `${snapshot.ticket.displayRef} was cancelled.`);
    }
    case 'stop': {
      const run = runFor(snapshot, event.runId);
      if (run === null) {
        return reject(existing, 'No such run.');
      }
      if (run.status === 'terminal') {
        return reject(existing, 'That agent already finished.');
      }
      const session = sessionFor(snapshot, run.sessionId);
      const label = session === null ? 'The' : `The ${stages[session.stage].label.toLowerCase()}`;
      run.status = 'terminal';
      // `cancelled` is the terminal kind the schema has for a run ended on purpose.
      run.terminalKind = 'cancelled';
      run.endedAt = now;
      // Like a question, a stop blocks the task until a reply or a retry.
      const task = session?.taskId == null ? null : taskById(snapshot, session.taskId);
      if (task !== null && task.status === 'active') {
        task.status = 'blocked';
      }
      for (const action of snapshot.actions) {
        if (
          action.runId === run.id &&
          (action.kind === 'launch_run' || action.kind === 'resume_run') &&
          action.status === 'pending'
        ) {
          action.status = 'cancelled';
        }
      }
      pauseWithNotice(snapshot, {
        code: 'stopped_by_actor',
        failures: [`${label} agent was stopped.`],
        ids,
        question: `${label} agent was stopped by a person. Reply with what it should do instead to resume it, retry to relaunch it, or cancel the ticket.`,
        retry: { kind: 'relaunch' },
        runId: run.id,
      });
      return finish(snapshot, `${label} agent was stopped. The ticket is paused.`);
    }
    case 'pull_request_closed': {
      if (event.ticketId !== snapshot.ticket.id) {
        return reject(existing, 'The pull request does not match the current ticket.');
      }
      if (snapshot.execution.stage === 'done') {
        return unchanged(existing, `${snapshot.ticket.displayRef} is already finished.`);
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
      snapshot.execution.status = 'cancelled';
      snapshot.execution.statusReasonCode = 'pull_request_closed';
      snapshot.execution.statusReason = `${event.url} was closed without merging.`;
      return finish(
        snapshot,
        `${snapshot.ticket.displayRef} was cancelled: its pull request was closed.`,
      );
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
      // A launch that was in flight when the run was stopped or cancelled.
      if (run.status === 'terminal') {
        return unchanged(existing, 'The run ended before its pane started.');
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
      // that paused the ticket, and a pause no run asked for takes neither. A
      // stopped agent takes either: a reply resumes it with instructions.
      const stopped = snapshot.execution.statusReasonCode === 'stopped_by_actor';
      if (snapshot.execution.retry !== null && !stopped) {
        return reject(existing, `Retry with /factory retry ${snapshot.ticket.commandRef}.`);
      }
      if (stopped) {
        snapshot.execution.retry = null;
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
        actor: event.actor ?? null,
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
      // A stage with input preparation checks its input again before resuming.
      if (isInputStage(session.stage)) {
        enqueueInput(snapshot, session.stage, {
          failures: [],
          idempotencyKey: `${session.stage}-input:${reply.id}`,
          ids,
          purpose: 'human_reply',
          ...(session.taskId === null ? {} : { taskId: session.taskId }),
        });
        snapshot.execution.status = 'resuming';
        return finish(
          snapshot,
          `Reply stored. Checking the ${stages[session.stage].label.toLowerCase()} input.`,
        );
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
          const earlier =
            task === null ? null : latestFinishedRun(snapshot, retry.stage, task.taskId);
          if (task === null || earlier === null) {
            return reject(existing, `No finished ${retry.stage} run can be validated again.`);
          }
          resolveOpen(snapshot);
          enterStage(task, retry.stage);
          snapshot.execution.stage = retry.stage;
          snapshot.execution.status = 'active';
          snapshot.execution.retry = null;
          enqueueValidation(
            snapshot,
            earlier,
            `validate:${earlier.id}:retry:${event.idempotencyKey}`,
            ids,
          );
          return finish(snapshot, `Validating the ${retry.stage} again.`);
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
