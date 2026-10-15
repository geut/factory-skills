import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { recordPullRequest } from '../controller/facts.ts';
import { attentionCard } from '../controller/run-card.ts';
import {
  claimNextAction,
  executionIsCurrent,
  extendActionLease,
  finishLeasedAction,
  loadSnapshotByExecution,
  loadSnapshotByRun,
  passedChecks,
} from '../controller/store.ts';
import { usageTable } from '../controller/usage.ts';
import type {
  ActionRecord,
  FactorySnapshot,
  IdSource,
  InputReady,
  RunId,
  RunRecord,
  SessionRecord,
  TerminalOutcome,
  WrapupValidationDetail,
} from '../domain.ts';
import type { Tracker, TrackerIssue } from '../ports/tracker.ts';
import { paneLabel, taskProgressText } from '../runtime/policy.ts';
import type { FactorySubagentRuntime, LaunchSpec } from '../runtime/runtime.ts';
import { effects } from '../stages/effects.ts';
import { stages, stageTools } from '../stages/index.ts';
import { recordValidation } from '../validation/record.ts';
import type { PullRequestLookup } from '../validation/wrapup.ts';
import { applyActionEvent } from './apply.ts';
import { prepareWorktree } from './worktree.ts';
import { openHandoffPane } from './wrapup.ts';

function messageOf(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message;
  }
  return 'action failed';
}

function sessionForRun(snapshot: FactorySnapshot, run: RunRecord): SessionRecord | null {
  return snapshot.sessions.find((session) => session.id === run.sessionId) ?? null;
}

function paneName(snapshot: FactorySnapshot, session: SessionRecord): string {
  return paneLabel(session.stage, snapshot.ticket.displayRef, session.taskId);
}

function previousPaneId(snapshot: FactorySnapshot, run: RunRecord): string | null {
  let paneId: string | null = null;
  for (const item of snapshot.runs) {
    if (item.sessionId === run.sessionId && item.id !== run.id && item.paneId !== null) {
      paneId = item.paneId;
    }
  }
  return paneId;
}

function taskLabel(snapshot: FactorySnapshot, session: SessionRecord): string | null {
  if (session.taskId === null || stages[session.stage].scope !== 'task') {
    return null;
  }
  const task = snapshot.tasks.find((item) => item.taskId === session.taskId) ?? null;
  if (task === null || task.title.trim().length === 0) {
    return null;
  }
  const tasksLeft = snapshot.tasks.filter((item) => item.status !== 'done').length;
  return taskProgressText(task.title, tasksLeft);
}

export async function dispatchPending(input: {
  afterValidation: () => void;
  arm: (runId: RunId) => void;
  db: DatabaseSync;
  factoryRoot: string;
  findPullRequest: PullRequestLookup;
  ids: IdSource;
  leaseOwner: string;
  liveValidations: Set<string>;
  notify: (message: string) => void;
  now: () => string;
  runtime: FactorySubagentRuntime;
  // True once the host is shutting down: leave the remaining actions pending.
  stopped: () => boolean;
  // The tracker for tracker updates, or null when FACTORY.json has none.
  tracker: () => Tracker | null;
}): Promise<void> {
  for (;;) {
    if (input.stopped()) {
      return;
    }
    const claimed = claimNextAction(input.db, input.now(), input.leaseOwner);
    if (claimed === null) {
      return;
    }
    const snapshot = loadSnapshotByExecution(input.db, claimed.executionId);
    if (snapshot === null) {
      finishLeasedAction(input.db, claimed.action.id, input.now(), 'failed', 'execution missing');
      continue;
    }
    if (
      claimed.action.kind === 'validate_run' &&
      validatorFor(snapshot, claimed.action.runId)?.leaseMs !== undefined
    ) {
      const action = claimed.action;
      input.liveValidations.add(action.id);
      void runValidation(input, action, snapshot)
        .catch((error: unknown) => {
          finishLeasedAction(input.db, action.id, input.now(), 'failed', messageOf(error));
        })
        .finally(() => {
          input.liveValidations.delete(action.id);
          input.afterValidation();
        });
      continue;
    }
    try {
      const armed = await perform(input, claimed.action, snapshot);
      if (armed !== null) {
        input.arm(armed);
      }
    } catch (error: unknown) {
      finishLeasedAction(input.db, claimed.action.id, input.now(), 'failed', messageOf(error));
    }
  }
}

async function perform(
  input: {
    db: DatabaseSync;
    factoryRoot: string;
    findPullRequest: PullRequestLookup;
    ids: IdSource;
    notify: (message: string) => void;
    now: () => string;
    runtime: FactorySubagentRuntime;
    tracker: () => Tracker | null;
  },
  action: ActionRecord,
  snapshot: FactorySnapshot,
): Promise<RunId | null> {
  switch (action.kind) {
    case 'launch_run':
    case 'resume_run':
      return launch(input, action, snapshot);
    case 'validate_run':
      return runValidation(input, action, snapshot);
    case 'prepare_input':
      return prepareInput(input, action, snapshot);
    case 'open_pane':
    case 'open_diff':
      return openHandoffPane(input, action, snapshot);
    case 'prepare_worktree':
      return worktree(input, action, snapshot);
    case 'notify_attention':
      input.notify(attentionCard(snapshot, action.message));
      finishLeasedAction(input.db, action.id, input.now(), 'succeeded', null);
      return null;
    case 'update_ticket_source':
      return updateTicketSource(input, action, snapshot);
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

async function launch(
  input: {
    db: DatabaseSync;
    factoryRoot: string;
    ids: IdSource;
    now: () => string;
    runtime: FactorySubagentRuntime;
  },
  action: Extract<ActionRecord, { kind: 'launch_run' | 'resume_run' }>,
  snapshot: FactorySnapshot,
): Promise<RunId | null> {
  const run = snapshot.runs.find((item) => item.id === action.runId) ?? null;
  if (run === null) {
    throw new Error('launch action is missing its run');
  }
  const session = sessionForRun(snapshot, run);
  if (session === null) {
    throw new Error('launch action is missing its session');
  }
  mkdirSync(path.dirname(snapshot.execution.factoryDir), { recursive: true });
  mkdirSync(snapshot.execution.factoryDir, { recursive: true });
  const sessionFile =
    session.sessionFile ?? path.join(input.factoryRoot, 'sessions', `${session.id}.jsonl`);
  const mode = action.kind === 'resume_run' ? 'resume' : action.mode;
  const spec: LaunchSpec = {
    cwd: action.cwd,
    mode,
    model: session.model,
    paneName: paneName(snapshot, session),
    previousPaneId: mode === 'resume' ? previousPaneId(snapshot, run) : null,
    prompt: action.prompt,
    purpose: run.purpose,
    runId: run.id,
    sessionFile,
    sessionId: session.id,
    stage: session.stage,
    taskLabel: taskLabel(snapshot, session),
    thinking: session.thinking,
    tools: stageTools(session.stage),
  };
  try {
    const started =
      spec.mode === 'resume' ? await input.runtime.resume(spec) : await input.runtime.launch(spec);
    const applied = applyActionEvent(
      input,
      {
        actionId: action.id,
        kind: 'run_started',
        paneId: started.paneId,
        paneName: started.paneName,
        piSessionId: started.piSessionId,
        runId: run.id,
        sessionFile: started.sessionFile,
      },
      `run-started:${run.id}`,
    );
    return applied.armRunId;
  } catch (error: unknown) {
    applyActionEvent(
      input,
      { actionId: action.id, kind: 'launch_failed', message: messageOf(error), runId: run.id },
      `launch-failed:${action.id}`,
    );
    return null;
  }
}

function worktree(
  input: { db: DatabaseSync; ids: IdSource; now: () => string },
  action: Extract<ActionRecord, { kind: 'prepare_worktree' }>,
  snapshot: FactorySnapshot,
): Promise<RunId | null> {
  const factoryRoot = path.dirname(path.dirname(snapshot.execution.factoryDir));
  const prepared = prepareWorktree({
    codeRoot: snapshot.execution.policy.codeRoot,
    factoryRoot,
    slug: action.slug,
  });
  if (prepared.kind === 'failed') {
    applyActionEvent(
      input,
      { actionId: action.id, kind: 'worktree_failed', message: prepared.message },
      `worktree-failed:${action.id}`,
    );
    return Promise.resolve(null);
  }
  applyActionEvent(
    input,
    {
      actionId: action.id,
      baseBranch: prepared.baseBranch,
      baseSha: prepared.baseSha,
      branch: prepared.branch,
      kind: 'worktree_ready',
      worktreePath: prepared.path,
    },
    `worktree-ready:${action.id}`,
  );
  return Promise.resolve(null);
}

function validatorFor(snapshot: FactorySnapshot, runId: RunId) {
  const run = snapshot.runs.find((item) => item.id === runId) ?? null;
  const stage = run === null ? null : (sessionForRun(snapshot, run)?.stage ?? null);
  return stage === null ? null : effects[stage].validator;
}

// Runs the validator for the run's stage and records its report. A
// long-running validator holds its action lease for as long as it declares.
// Writes a tracker update. A tracker that keeps failing leaves the action
// failed, which the API shows as a warning; the ticket goes on either way.
async function updateTicketSource(
  input: { db: DatabaseSync; now: () => string; tracker: () => Tracker | null },
  action: Extract<ActionRecord, { kind: 'update_ticket_source' }>,
  snapshot: FactorySnapshot,
): Promise<RunId | null> {
  const tracker = input.tracker();
  if (tracker === null) {
    finishLeasedAction(input.db, action.id, input.now(), 'failed', 'FACTORY.json has no tracker.');
    return null;
  }
  const issue: TrackerIssue = {
    body: snapshot.ticket.body,
    displayRef: snapshot.ticket.displayRef,
    id: snapshot.ticket.id,
    labels: snapshot.ticket.labels,
    ref: snapshot.ticket.commandRef,
    title: snapshot.ticket.title,
    url: snapshot.ticket.sourceRef,
  };
  // The marker makes a retried comment a no-op, even after a crash.
  const marker = `<!-- factory:${action.idempotencyKey} -->`;
  let failure = '';
  for (let attempt = 1; attempt <= action.maxAttempts; attempt += 1) {
    try {
      if (tracker.capabilities.has('comment')) {
        tracker.comment(issue, action.comment, marker);
      }
      if (action.issueStatus !== null && tracker.capabilities.has('status')) {
        tracker.setStatus(issue, action.issueStatus);
      }
      finishLeasedAction(input.db, action.id, input.now(), 'succeeded', null);
      return null;
    } catch (error: unknown) {
      failure = messageOf(error);
      if (attempt < action.maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }
  }
  finishLeasedAction(
    input.db,
    action.id,
    input.now(),
    'failed',
    `Tracker update failed: ${failure}`,
  );
  return null;
}

async function runValidation(
  input: { db: DatabaseSync; findPullRequest: PullRequestLookup; ids: IdSource; now: () => string },
  action: Extract<ActionRecord, { kind: 'validate_run' }>,
  snapshot: FactorySnapshot,
): Promise<RunId | null> {
  const run = snapshot.runs.find((item) => item.id === action.runId) ?? null;
  const session = run === null ? null : sessionForRun(snapshot, run);
  if (run === null || session === null) {
    throw new Error('validate action is missing its run');
  }
  const stage = session.stage;
  const validator = effects[stage].validator;
  const leaseMs = validator.leaseMs?.(snapshot);
  if (leaseMs !== undefined) {
    extendActionLease(input.db, action.id, input.now(), leaseMs);
  }
  const executionId = snapshot.execution.id;
  const report = await validator.validate({
    deps: {
      findPullRequest: input.findPullRequest,
      usage: () => usageTable(input.db, executionId, { includeWrapup: true }),
    },
    run,
    session,
    snapshot,
  });
  // The pull request a passing wrap-up checked becomes the ticket's.
  if (stage === 'wrapup' && report.status === 'passed') {
    const pullRequest = (report.detail as WrapupValidationDetail).pullRequest;
    if (pullRequest !== null) {
      recordPullRequest(input.db, { ...pullRequest, executionId }, input.now());
    }
  }
  recordValidation(input, {
    actionId: action.id,
    executionId,
    report,
    resultHash: run.resultHash,
    runId: run.id,
    stage,
  });
  return null;
}

// Prepares a stage's input outside the controller transaction and hands the
// reducer what it found, or why the stage cannot start.
function prepareInput(
  input: { db: DatabaseSync; ids: IdSource; now: () => string },
  action: Extract<ActionRecord, { kind: 'prepare_input' }>,
  snapshot: FactorySnapshot,
): Promise<RunId | null> {
  const executionId = snapshot.execution.id;
  const result = effects[action.stage].prepareInput({
    action,
    deps: {
      executionCurrent: executionIsCurrent(input.db, executionId),
      passedChecks: (stage) =>
        passedChecks(input.db, executionId, stage, effects[stage].validator.version),
      usage: () => usageTable(input.db, executionId, { includeWrapup: false }),
    },
    snapshot,
  });
  if (result.kind === 'failed') {
    applyActionEvent(
      input,
      { actionId: action.id, kind: 'input_failed', message: result.message },
      `input-failed:${action.id}`,
    );
  } else {
    applyActionEvent(
      input,
      {
        actionId: action.id,
        input: result.input,
        kind: 'input_ready',
        stage: action.stage,
      } as InputReady,
      `input-ready:${action.id}`,
    );
  }
  return Promise.resolve(null);
}

export function watchRun(input: {
  db: DatabaseSync;
  onTerminal: (runId: RunId, terminal: TerminalOutcome) => void;
  runId: RunId;
  runtime: FactorySubagentRuntime;
}): void {
  const snapshot = loadSnapshotByRun(input.db, input.runId);
  const run = snapshot?.runs.find((item) => item.id === input.runId) ?? null;
  const session = snapshot === null || run === null ? null : sessionForRun(snapshot, run);
  input.runtime.observe(
    { paneId: run?.paneId ?? null, runId: input.runId, sessionFile: session?.sessionFile ?? null },
    (terminal) => {
      input.onTerminal(input.runId, terminal);
    },
  );
}
