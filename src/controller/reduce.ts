import {
  type ActionRecord,
  type ControllerEvent,
  type ControllerResponse,
  type ExecutionStatus,
  type FactorySnapshot,
  type IdSource,
  type Reduction,
  type RunId,
  type RunPurpose,
  type RunRecord,
  type SessionRecord,
  type TaskId,
  type TaskRecord,
  type TerminalOutcome,
  type UsageWrite,
  type WorkInputPurpose,
  type WorkValidationOutcome,
} from '../domain.ts';
import { sha256 } from '../hash.ts';
import {
  childDescription,
  correctionPrompt,
  planPrompt,
  replyPrompt,
  reviewPrompt,
  stageLaunchPolicy,
  workCorrectionPrompt,
  workPrompt,
} from '../runtime/policy.ts';

function reject(snapshot: FactorySnapshot | null, message: string): Reduction {
  return {
    armRunId: null,
    changed: false,
    response: { kind: 'rejected', message },
    snapshot,
    usage: null,
  };
}

function detail(snapshot: FactorySnapshot, message: string): ControllerResponse {
  const question =
    snapshot.attention.find(
      (item) => item.status === 'open' || item.status === 'answered' || item.status === 'resuming',
    ) ?? null;
  return {
    displayRef: snapshot.ticket.displayRef,
    kind: 'status',
    message,
    question: question?.question ?? null,
    retryHint: snapshot.execution.retryable
      ? `Retry with /factory retry ${snapshot.ticket.commandRef}.`
      : null,
    stage: snapshot.execution.stage,
    status: snapshot.execution.status,
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
      return `Ticket ${ref} is paused: ${snapshot.execution.statusReason ?? 'no reason recorded'}. Reply with /factory reply ${ref} "answer".`;
    case 'resume_failed':
    case 'failed':
      return snapshot.execution.retryable
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
    description: null,
    endedAt: null,
    id: ids.run(),
    inputHash: sha256(prompt),
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

function resolveOpen(snapshot: FactorySnapshot): void {
  for (const attention of snapshot.attention) {
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
    question: string;
    retryable: boolean;
  },
): void {
  resolveOpen(snapshot);
  snapshot.execution.status = 'paused';
  snapshot.execution.retryable = input.retryable;
  snapshot.execution.statusReasonCode = input.code;
  snapshot.execution.statusReason = input.failures.join('\n');
  snapshot.attention.push({
    id: input.ids.attention(),
    kind: 'policy_limit',
    question: input.question,
    runId: null,
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
    retryable: false,
  });
}

function sessionCwd(snapshot: FactorySnapshot, session: SessionRecord): string {
  if (
    (session.stage === 'work' || session.stage === 'review') &&
    snapshot.execution.worktreePath !== null
  ) {
    return snapshot.execution.worktreePath;
  }
  return snapshot.execution.policy.codeRoot;
}

function taskById(snapshot: FactorySnapshot, id: TaskId): TaskRecord | null {
  return snapshot.tasks.find((task) => task.taskId === id) ?? null;
}

function enqueueWorkInput(
  snapshot: FactorySnapshot,
  input: {
    failures: Array<string>;
    idempotencyKey: string;
    ids: IdSource;
    purpose: WorkInputPurpose;
    taskId: TaskId;
  },
): void {
  snapshot.actions.push({
    attempts: 0,
    attentionReplyId: null,
    attentionRequestId: null,
    failures: input.failures,
    id: input.ids.action(),
    idempotencyKey: input.idempotencyKey,
    kind: 'prepare_work_input',
    lastError: null,
    maxAttempts: snapshot.execution.policy.limits.infrastructureRetries,
    purpose: input.purpose,
    retryOfActionId: null,
    runId: null,
    status: 'pending',
    taskId: input.taskId,
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
    enqueueWorkInput(snapshot, {
      failures,
      idempotencyKey: `work-input:${parent.id}:correction:${count + 1}`,
      ids,
      purpose: 'validation_correction',
      taskId: session.taskId,
    });
    snapshot.execution.status = 'active';
    return;
  }
  const prompt = correctionPrompt(failures);
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
    snapshot.execution.retryable = true;
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
      ? replyPrompt(session.stage, current.answer)
      : [
          `Follow the ${stageLaunchPolicy[session.stage].skill} skill.`,
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
      if (session?.stage === 'plan') {
        const marker = JSON.stringify({ contract: 'factory.plan.v3', source: 'files' });
        run.resultStatus = 'valid';
        run.resultContract = 'factory.plan.v3';
        run.resultJson = marker;
        run.resultHash = sha256(marker);
        snapshot.actions.push({
          attempts: 0,
          attentionReplyId: null,
          attentionRequestId: null,
          id: ids.action(),
          idempotencyKey: `validate:${run.id}`,
          kind: 'validate_run',
          lastError: null,
          maxAttempts: snapshot.execution.policy.limits.infrastructureRetries,
          retryOfActionId: null,
          runId: run.id,
          status: 'pending',
        });
        snapshot.execution.status = 'active';
      }
      if (session?.stage === 'work') {
        run.resultJson = JSON.stringify({ output: terminal.output });
        snapshot.actions.push({
          attempts: 0,
          attentionReplyId: null,
          attentionRequestId: null,
          id: ids.action(),
          idempotencyKey: `validate:${run.id}`,
          kind: 'validate_run',
          lastError: null,
          maxAttempts: snapshot.execution.policy.limits.infrastructureRetries,
          retryOfActionId: null,
          runId: run.id,
          status: 'pending',
        });
        snapshot.execution.status = 'active';
      }
      return usageFor(run, terminal);
    }
    case 'caller_ping': {
      resolveOpen(snapshot);
      if (session?.stage === 'work' && session.taskId !== null) {
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
      snapshot.execution.retryable = false;
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
  const prompt = planPrompt({
    body: event.ticket.body,
    displayRef: event.ticket.displayRef,
    factoryDir: event.ticket.factoryDir,
    title: event.ticket.title,
  });
  const executionId = ids.execution();
  const session: SessionRecord = {
    id: ids.session(),
    logicalKey: 'plan',
    model: event.policy.models.plan,
    piSessionId: null,
    sessionFile: null,
    stage: 'plan',
    status: 'prepared',
    taskId: null,
    thinking: 'medium',
  };
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
      retryable: false,
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

function rawOutput(run: RunRecord): string {
  if (run.resultJson === null) {
    return '';
  }
  try {
    const parsed: unknown = JSON.parse(run.resultJson);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'output' in parsed &&
      typeof parsed.output === 'string'
    ) {
      return parsed.output;
    }
  } catch {
    return run.resultJson;
  }
  return run.resultJson;
}

function finishWorkValidation(
  snapshot: FactorySnapshot,
  existing: FactorySnapshot,
  run: RunRecord,
  action: Extract<ActionRecord, { kind: 'validate_run' }>,
  outcome: WorkValidationOutcome,
  ids: IdSource,
): Reduction {
  const session = sessionFor(snapshot, run.sessionId);
  if (session === null || session.stage !== 'work' || session.taskId === null) {
    return reject(existing, 'Work session is missing.');
  }
  if (outcome.kind === 'error') {
    action.status = 'failed';
    action.lastError = outcome.message;
    const failed = snapshot.actions.filter(
      (item) => item.kind === 'validate_run' && item.runId === run.id && item.status === 'failed',
    ).length;
    if (failed >= snapshot.execution.policy.limits.infrastructureRetries) {
      snapshot.execution.status = 'failed';
      snapshot.execution.retryable = true;
      snapshot.execution.statusReasonCode = 'validator_error';
      snapshot.execution.statusReason = outcome.message;
      return finish(snapshot, outcome.message);
    }
    snapshot.actions.push({
      attempts: 0,
      attentionReplyId: null,
      attentionRequestId: null,
      id: ids.action(),
      idempotencyKey: `validate:${run.id}:${failed + 1}`,
      kind: 'validate_run',
      lastError: null,
      maxAttempts: snapshot.execution.policy.limits.infrastructureRetries,
      retryOfActionId: action.id,
      runId: run.id,
      status: 'pending',
    });
    snapshot.execution.status = 'active';
    return finish(snapshot, 'Retrying work validation.');
  }
  action.status = 'succeeded';
  if (outcome.kind === 'failed') {
    scheduleCorrection(snapshot, session, run, outcome.failures, ids);
    return finish(snapshot, 'Work validation failed.');
  }
  const task = taskById(snapshot, session.taskId);
  if (task === null || snapshot.execution.worktreePath === null) {
    return reject(existing, 'Work task is missing.');
  }
  task.status = 'ready_for_review';
  snapshot.execution.stage = 'review';
  snapshot.execution.status = 'active';
  const reviewSession: SessionRecord = {
    id: ids.session(),
    logicalKey: `review:${task.taskId}`,
    model: snapshot.execution.policy.models.review,
    piSessionId: null,
    sessionFile: null,
    stage: 'review',
    status: 'prepared',
    taskId: task.taskId,
    thinking: stageLaunchPolicy.review.thinking,
  };
  snapshot.sessions.push(reviewSession);
  const prompt = reviewPrompt({
    diff: outcome.diff,
    displayRef: snapshot.ticket.displayRef,
    planPath: snapshot.execution.planPath ?? '',
    rawOutput: rawOutput(run),
    taskTitle: task.title,
    validationSummary: outcome.checks.map((check) => `${check.name}: ${check.status}`).join('\n'),
  });
  const reviewRun = addRun(snapshot, reviewSession, null, 'initial', 1, ids, prompt);
  reviewRun.description = childDescription(task.title);
  launchAction(snapshot, reviewRun, prompt, 'launch', ids, snapshot.execution.worktreePath);
  return finish(snapshot, `Review queued for task ${task.taskId}.`);
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
      if (event.stage === 'work') {
        return finishWorkValidation(snapshot, existing, run, action, event.outcome, ids);
      }
      if (run.resultStatus !== 'valid' || run.resultHash === null) {
        return reject(existing, 'Validation requires a valid plan result.');
      }
      action.status = 'succeeded';
      if (event.outcome.kind === 'failed') {
        const session = sessionFor(snapshot, run.sessionId);
        if (session === null) {
          return reject(existing, 'Plan session is missing.');
        }
        scheduleCorrection(snapshot, session, run, event.outcome.failures, ids);
        return finish(snapshot, 'Plan validation failed.');
      }
      snapshot.tasks = event.outcome.tasks.map((task) => ({
        blockedBy: task.blockedBy,
        ordinal: task.ordinal,
        specHash: task.specHash,
        status: 'pending',
        taskFile: task.taskFile,
        taskId: task.taskId,
        title: task.title,
      }));
      snapshot.execution.stage = 'work';
      snapshot.execution.status = 'active';
      snapshot.execution.planPath = event.outcome.planPath;
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
      enqueueWorkInput(snapshot, {
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
      snapshot.execution.retryable = true;
      snapshot.execution.worktreeStatus = 'failed';
      snapshot.execution.statusReasonCode = 'worktree_failed';
      snapshot.execution.statusReason = event.message;
      return finish(snapshot, event.message);
    }
    case 'work_input_ready': {
      const action = snapshot.actions.find((item) => item.id === event.actionId) ?? null;
      if (action === null || action.kind !== 'prepare_work_input') {
        return reject(existing, 'Work input result does not match an action.');
      }
      if (action.status === 'succeeded') {
        return unchanged(existing, 'Duplicate work input event ignored.');
      }
      const task = taskById(snapshot, action.taskId);
      const worktree = snapshot.execution.worktreePath;
      if (task === null || worktree === null) {
        return reject(existing, 'Work task is missing.');
      }
      action.status = 'succeeded';
      if (action.purpose === 'initial') {
        task.status = 'working';
        const session: SessionRecord = {
          id: ids.session(),
          logicalKey: `work:${task.taskId}`,
          model: snapshot.execution.policy.models.work,
          piSessionId: null,
          sessionFile: null,
          stage: 'work',
          status: 'prepared',
          taskId: task.taskId,
          thinking: 'medium',
        };
        snapshot.sessions.push(session);
        const prompt = workPrompt({
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
        });
        const run = addRun(snapshot, session, null, 'initial', 0, ids, prompt);
        run.description = childDescription(task.title);
        launchAction(snapshot, run, prompt, 'launch', ids, worktree);
        return finish(snapshot, `Work queued for task ${task.taskId}.`);
      }
      const session =
        snapshot.sessions.find((item) => item.stage === 'work' && item.taskId === task.taskId) ??
        null;
      if (session === null) {
        return reject(existing, 'Work session is missing.');
      }
      if (action.purpose === 'validation_correction') {
        const prompt = workCorrectionPrompt(action.failures);
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
          'validation_correction',
          count + 1,
          ids,
          prompt,
        );
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
        return finish(snapshot, `Work correction queued for task ${task.taskId}.`);
      }
      const attention =
        snapshot.attention.find(
          (item) => item.status === 'resuming' || item.status === 'answered',
        ) ?? null;
      const reply =
        snapshot.replies.find(
          (item) => item.isCurrent && attention !== null && item.requestId === attention.id,
        ) ?? null;
      if (attention === null || reply === null) {
        return reject(existing, 'Reply was not stored.');
      }
      const parent = attention.runId === null ? null : runFor(snapshot, attention.runId);
      const prompt = replyPrompt('work', reply.answer);
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
    case 'work_input_failed': {
      const action = snapshot.actions.find((item) => item.id === event.actionId) ?? null;
      if (action === null || action.kind !== 'prepare_work_input') {
        return reject(existing, 'Work input failure does not match an action.');
      }
      if (action.status === 'failed') {
        return unchanged(existing, 'Duplicate work input failure ignored.');
      }
      action.status = 'failed';
      action.lastError = event.message;
      pauseWithNotice(snapshot, {
        code: 'work_input_invalid',
        failures: [event.message],
        ids,
        question: event.message,
        retryable: true,
      });
      return finish(snapshot, event.message);
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
          if (task !== null && session.stage === 'review') {
            task.status = 'reviewing';
          }
          if (task !== null && session.stage === 'work' && task.status === 'blocked') {
            task.status = 'working';
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
      if (snapshot.execution.statusReasonCode === 'work_input_invalid') {
        return reject(existing, `Retry with /factory retry ${snapshot.ticket.commandRef}.`);
      }
      const attention =
        snapshot.attention.find((item) => item.status === 'open' || item.status === 'answered') ??
        null;
      if (attention === null) {
        return reject(existing, 'There is no open question to answer.');
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
        enqueueWorkInput(snapshot, {
          failures: [],
          idempotencyKey: `work-input:${reply.id}`,
          ids,
          purpose: 'human_reply',
          taskId: session.taskId,
        });
        snapshot.execution.status = 'resuming';
        return finish(snapshot, 'Reply stored. Checking the work input.');
      }
      const prompt = replyPrompt(session.stage, event.answer);
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
      if (
        snapshot.execution.status === 'paused' &&
        snapshot.execution.statusReasonCode === 'work_input_invalid'
      ) {
        const failed = [...snapshot.actions]
          .reverse()
          .find(
            (item): item is Extract<ActionRecord, { kind: 'prepare_work_input' }> =>
              item.kind === 'prepare_work_input' && item.status === 'failed',
          );
        if (failed === undefined) {
          return reject(existing, 'Nothing failed that can be retried.');
        }
        resolveOpen(snapshot);
        enqueueWorkInput(snapshot, {
          failures: failed.failures,
          idempotencyKey: `work-input-retry:${event.idempotencyKey}`,
          ids,
          purpose: failed.purpose,
          taskId: failed.taskId,
        });
        snapshot.execution.status = failed.purpose === 'human_reply' ? 'resuming' : 'active';
        snapshot.execution.retryable = false;
        return finish(snapshot, 'Retrying work input preparation.');
      }
      if (
        snapshot.execution.status === 'failed' &&
        snapshot.execution.retryable &&
        snapshot.execution.statusReasonCode === 'validator_error'
      ) {
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
        snapshot.execution.retryable = false;
        return finish(snapshot, 'Retrying work validation.');
      }
      if (snapshot.execution.status === 'resume_failed') {
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
        const prompt = replyPrompt(session.stage, reply.answer);
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
        snapshot.execution.retryable = false;
        return finish(snapshot, 'Retrying with the stored reply.');
      }
      if (snapshot.execution.status === 'failed' && snapshot.execution.retryable) {
        const failedWorktree = snapshot.actions.find(
          (item): item is Extract<ActionRecord, { kind: 'prepare_worktree' }> =>
            item.kind === 'prepare_worktree' && item.status === 'failed',
        );
        if (
          failedWorktree !== undefined &&
          snapshot.execution.stage === 'work' &&
          snapshot.execution.planPath !== null
        ) {
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
          snapshot.execution.retryable = false;
          snapshot.execution.worktreeStatus = 'preparing';
          return finish(snapshot, 'Retrying worktree preparation.');
        }
        const session = snapshot.sessions.at(-1) ?? null;
        const parent = snapshot.runs.at(-1) ?? null;
        if (session === null || parent === null) {
          return reject(existing, 'Nothing failed that can be retried.');
        }
        const prompt = [
          `Follow the ${stageLaunchPolicy[session.stage].skill} skill.`,
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
        snapshot.execution.retryable = false;
        return finish(snapshot, 'Retrying the failed launch.');
      }
      return reject(existing, 'This ticket is not waiting for retry.');
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
            snapshot.execution.retryable = true;
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
