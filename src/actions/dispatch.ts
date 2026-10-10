import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { allowsEmptyDiff } from '../config.ts';
import { attentionCard } from '../controller/run-card.ts';
import {
  applyControllerEvent,
  claimNextAction,
  executionIsCurrent,
  extendActionLease,
  finishLeasedAction,
  loadSnapshotByExecution,
  loadSnapshotByRun,
  type ApplyResult,
} from '../controller/store.ts';
import type {
  ActionRecord,
  ControllerEvent,
  FactorySnapshot,
  IdSource,
  RunId,
  RunRecord,
  SessionRecord,
  TaskRecord,
  TerminalOutcome,
} from '../domain.ts';
import { childToolList, paneLabel, taskProgressText } from '../runtime/policy.ts';
import type { FactorySubagentRuntime, LaunchSpec } from '../runtime/runtime.ts';
import { inspectPlanDir } from '../validation/plan.ts';
import { recordValidation } from '../validation/record.ts';
import { errorReport } from '../validation/report.ts';
import { REVIEW_VALIDATOR_VERSION, validateReview } from '../validation/review.ts';
import { validateWork, validationLeaseMs, WORK_VALIDATOR_VERSION } from '../validation/work.ts';
import type { PullRequestLookup } from '../validation/wrapup.ts';
import { inspectWorkInput } from './work-input.ts';
import { prepareWorktree } from './worktree.ts';
import { openHandoffPane, prepareWrapupInput, validateWrapupRun } from './wrapup.ts';

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
  if (session.taskId === null || (session.stage !== 'work' && session.stage !== 'review')) {
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
  liveValidations: Set<string>;
  notify: (message: string) => void;
  now: () => string;
  runtime: FactorySubagentRuntime;
}): Promise<void> {
  for (;;) {
    const claimed = claimNextAction(input.db, input.now());
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
      workRun(snapshot, claimed.action.runId) !== null
    ) {
      const action = claimed.action;
      input.liveValidations.add(action.id);
      void runWorkValidation(input, action, snapshot).finally(() => {
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
  },
  action: ActionRecord,
  snapshot: FactorySnapshot,
): Promise<RunId | null> {
  switch (action.kind) {
    case 'launch_run':
    case 'resume_run':
      return launch(input, action, snapshot);
    case 'validate_run': {
      const stage = runStage(snapshot, action.runId);
      if (stage === 'review') {
        return validateReviewRun(input, action, snapshot);
      }
      if (stage === 'wrapup') {
        return validateWrapupRun(input, action, snapshot);
      }
      return validate(input, action, snapshot);
    }
    case 'prepare_work_input':
      return prepareInput(input, action, snapshot);
    case 'prepare_wrapup_input':
      return prepareWrapupInput(input, action, snapshot);
    case 'open_pane':
    case 'open_diff':
      return openHandoffPane(input, action, snapshot);
    case 'prepare_worktree':
      return worktree(input, action, snapshot);
    case 'notify_attention':
      input.notify(attentionCard(snapshot, action.message));
      finishLeasedAction(input.db, action.id, input.now(), 'succeeded', null);
      return null;
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

function apply(
  input: { db: DatabaseSync; ids: IdSource; now: () => string },
  event: ControllerEvent,
  dedupeKey: string,
  source: 'action' | 'validator',
  prepare?: (db: DatabaseSync) => void,
): ApplyResult {
  const base = { dedupeKey, event, ids: input.ids, now: input.now(), source };
  if (prepare === undefined) {
    return applyControllerEvent(input.db, base);
  }
  return applyControllerEvent(input.db, { ...base, prepare });
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
    tools: childToolList(session.stage),
  };
  try {
    const started =
      spec.mode === 'resume' ? await input.runtime.resume(spec) : await input.runtime.launch(spec);
    const applied = apply(
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
      'action',
    );
    return applied.armRunId;
  } catch (error: unknown) {
    apply(
      input,
      { actionId: action.id, kind: 'launch_failed', message: messageOf(error), runId: run.id },
      `launch-failed:${action.id}`,
      'action',
    );
    return null;
  }
}

function validate(
  input: { db: DatabaseSync; ids: IdSource; now: () => string },
  action: Extract<ActionRecord, { kind: 'validate_run' }>,
  snapshot: FactorySnapshot,
): Promise<RunId | null> {
  const run = snapshot.runs.find((item) => item.id === action.runId) ?? null;
  if (run === null || run.resultJson === null || run.resultHash === null) {
    throw new Error('validate action is missing a plan result');
  }
  recordValidation(input, {
    event: {
      actionId: action.id,
      kind: 'validation_finished',
      report: inspectPlanDir({ factoryDir: snapshot.execution.factoryDir }),
      runId: run.id,
      stage: 'plan',
    },
    executionId: snapshot.execution.id,
    resultHash: run.resultHash,
  });
  return Promise.resolve(null);
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
    apply(
      input,
      { actionId: action.id, kind: 'worktree_failed', message: prepared.message },
      `worktree-failed:${action.id}`,
      'action',
    );
    return Promise.resolve(null);
  }
  apply(
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
    'action',
  );
  return Promise.resolve(null);
}

function runStage(snapshot: FactorySnapshot, id: RunId): SessionRecord['stage'] | null {
  const run = snapshot.runs.find((item) => item.id === id) ?? null;
  return run === null ? null : (sessionForRun(snapshot, run)?.stage ?? null);
}

function workRun(snapshot: FactorySnapshot, id: RunId): RunRecord | null {
  return runStage(snapshot, id) === 'work'
    ? (snapshot.runs.find((item) => item.id === id) ?? null)
    : null;
}

function validateReviewRun(
  input: { db: DatabaseSync; ids: IdSource; now: () => string },
  action: Extract<ActionRecord, { kind: 'validate_run' }>,
  snapshot: FactorySnapshot,
): Promise<RunId | null> {
  const run = snapshot.runs.find((item) => item.id === action.runId) ?? null;
  const session = run === null ? null : sessionForRun(snapshot, run);
  if (run === null || session === null) {
    throw new Error('validate action is missing its review run');
  }
  const workSession =
    snapshot.sessions.find((item) => item.stage === 'work' && item.taskId === session.taskId) ??
    null;
  const worktree = snapshot.execution.worktreePath;
  const report =
    worktree === null
      ? errorReport(REVIEW_VALIDATOR_VERSION, 'Worktree is missing.')
      : validateReview({
          cwd: worktree,
          resultError: run.resultError,
          resultStatus: run.resultStatus,
          reviewedDiffHash: run.diffHash,
          reviewModel: session.model,
          tools: childToolList('review'),
          workModel: workSession?.model ?? snapshot.execution.policy.models.work,
        });
  recordValidation(input, {
    event: {
      actionId: action.id,
      kind: 'validation_finished',
      report,
      runId: run.id,
      stage: 'review',
    },
    executionId: snapshot.execution.id,
    resultHash: run.resultHash,
  });
  return Promise.resolve(null);
}

function readyTask(snapshot: FactorySnapshot): TaskRecord | null {
  const done = new Set(
    snapshot.tasks.filter((task) => task.status === 'done').map((task) => task.taskId),
  );
  const ready = snapshot.tasks
    .filter((task) => task.status === 'pending' && task.blockedBy.every((id) => done.has(id)))
    .sort((left, right) => left.ordinal - right.ordinal);
  return ready[0] ?? null;
}

function dependenciesDone(snapshot: FactorySnapshot, task: TaskRecord): boolean {
  return task.blockedBy.every((id) =>
    snapshot.tasks.some((item) => item.taskId === id && item.status === 'done'),
  );
}

async function runWorkValidation(
  input: { db: DatabaseSync; ids: IdSource; now: () => string },
  action: Extract<ActionRecord, { kind: 'validate_run' }>,
  snapshot: FactorySnapshot,
): Promise<void> {
  const commands = snapshot.execution.policy.validation.work.commands;
  extendActionLease(input.db, action.id, input.now(), validationLeaseMs(commands));
  const worktree = snapshot.execution.worktreePath;
  const baseSha = snapshot.execution.worktreeBaseSha;
  const report =
    worktree === null || baseSha === null
      ? errorReport(WORK_VALIDATOR_VERSION, 'Worktree is missing.')
      : await validateWork({
          allowsEmptyDiff: allowsEmptyDiff(
            snapshot.ticket.labels,
            snapshot.execution.policy.labels.map,
          ),
          baseSha,
          commands,
          cwd: worktree,
        });
  const run = snapshot.runs.find((item) => item.id === action.runId) ?? null;
  recordValidation(input, {
    event: {
      actionId: action.id,
      kind: 'validation_finished',
      report,
      runId: action.runId,
      stage: 'work',
    },
    executionId: snapshot.execution.id,
    resultHash: run?.resultHash ?? null,
  });
}

function prepareInput(
  input: { db: DatabaseSync; ids: IdSource; now: () => string },
  action: Extract<ActionRecord, { kind: 'prepare_work_input' }>,
  snapshot: FactorySnapshot,
): Promise<RunId | null> {
  const factoryRoot = path.dirname(path.dirname(snapshot.execution.factoryDir));
  const task = snapshot.tasks.find((item) => item.taskId === action.taskId) ?? null;
  const selected =
    task !== null &&
    (action.purpose === 'initial'
      ? readyTask(snapshot)?.taskId === task.taskId
      : action.purpose === 'validation_correction' || action.purpose === 'review_changes'
        ? task.status === 'working'
        : task.status === 'blocked');
  const inspection =
    task === null ||
    snapshot.execution.worktreePath === null ||
    snapshot.execution.worktreeBranch === null
      ? { failures: ['The worktree is not ready for this execution.'], kind: 'failed' as const }
      : inspectWorkInput({
          activeChild: snapshot.runs.some((run) => run.status !== 'terminal'),
          dependenciesDone: dependenciesDone(snapshot, task),
          executionCurrent: executionIsCurrent(input.db, snapshot.execution.id),
          expectedBranch: snapshot.execution.worktreeBranch,
          factoryDir: snapshot.execution.factoryDir,
          factoryRoot,
          planPath:
            snapshot.execution.planPath ?? path.join(snapshot.execution.factoryDir, 'plan.md'),
          selectedTask: selected,
          taskFile: task.taskFile,
          worktreePath: snapshot.execution.worktreePath,
          worktreeReady: snapshot.execution.worktreeStatus === 'ready',
        });
  if (inspection.kind === 'failed') {
    apply(
      input,
      {
        actionId: action.id,
        kind: 'work_input_failed',
        message: inspection.failures.join('\n'),
      },
      `work-input-failed:${action.id}`,
      'action',
    );
    return Promise.resolve(null);
  }
  apply(
    input,
    {
      actionId: action.id,
      adrPath: inspection.adrPath,
      contextPath: inspection.contextPath,
      kind: 'work_input_ready',
      taskType: inspection.taskType,
    },
    `work-input-ready:${action.id}`,
    'action',
  );
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
