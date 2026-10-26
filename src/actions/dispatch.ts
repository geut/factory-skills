import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { recordPullRequest } from '../controller/facts.ts';
import { factoryRootOf } from '../controller/keys.ts';
import { attentionCard } from '../controller/run-card.ts';
import {
  activeWorktrees,
  claimNextAction,
  executionIsCurrent,
  extendActionLease,
  finishLeasedAction,
  loadSnapshotByExecution,
  loadSnapshotByRun,
  passedChecks,
  recordStrayProcess,
  ticketTab,
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
import { contextGaps } from '../stages/plan/context.ts';
import { recordValidation } from '../validation/record.ts';
import { errorReport } from '../validation/report.ts';
import type { PullRequestLookup } from '../validation/wrapup.ts';
import { applyActionEvent } from './apply.ts';
import { archiveStamp } from './leftovers.ts';
import {
  listProcesses,
  processAlive,
  strayProcesses,
  sweepStrays,
  type SweepOutcome,
} from './strays.ts';
import { applyTicketUpdate } from './ticket-source.ts';
import { prepareWorktree, setUpWorktree } from './worktree.ts';
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

// Where a new session is written: grouped by ticket (and rerun generation),
// named for its stage and task, so a person can find a stage's session by
// browsing `.factory/sessions/`.
export function newSessionFile(
  factoryRoot: string,
  snapshot: FactorySnapshot,
  session: SessionRecord,
): string {
  const ticket = path.relative(path.join(factoryRoot, 'tickets'), snapshot.execution.factoryDir);
  const folder = ticket.length === 0 || ticket.startsWith('..') ? [] : ticket.split(path.sep);
  const task =
    session.taskId === null ? '' : `-${session.taskId.replaceAll(/[^A-Za-z0-9._-]/g, '_')}`;
  return path.join(
    factoryRoot,
    'sessions',
    ...folder,
    `${session.stage}${task}-${session.id}.jsonl`,
  );
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

// How long a stray server gets to exit on SIGTERM before SIGKILL.
const STRAY_GRACE_MS = 3000;

function strayCard(snapshot: FactorySnapshot, outcomes: Array<SweepOutcome>): string {
  const lines = outcomes.map(
    (outcome) =>
      `- ${outcome.kind === 'stray_process_stopped' ? 'stopped' : 'could not stop'} pid ${outcome.pid} (${outcome.command.slice(0, 80)}) from ${path.basename(outcome.worktree)}: ${outcome.detail}`,
  );
  return [
    `${snapshot.ticket.displayRef}: stray processes from inactive worktrees, before this run:`,
    ...lines,
  ].join('\n');
}

// Servers an earlier ticket's agents left running would collide with, or be
// reused by, this run's test harness. Work and QA runs start without them.
async function sweepStrayProcesses(
  input: { db: DatabaseSync; notify: (message: string) => void; now: () => string },
  snapshot: FactorySnapshot,
  run: RunRecord,
): Promise<void> {
  const worktreesDir = path.join(factoryRootOf(snapshot.execution.factoryDir), 'worktrees');
  if (!existsSync(worktreesDir)) {
    return;
  }
  const strays = strayProcesses({
    activeWorktrees: activeWorktrees(input.db),
    exists: existsSync,
    processes: listProcesses(),
    protectedPids: new Set([process.pid, process.ppid]),
    realWorktreesDir: realpathSync(worktreesDir),
    worktreesDir,
  });
  if (strays.length === 0) {
    return;
  }
  const outcomes = await sweepStrays({
    alive: processAlive,
    graceMs: STRAY_GRACE_MS,
    record: (outcome) =>
      recordStrayProcess(input.db, {
        ...outcome,
        executionId: snapshot.execution.id,
        now: input.now(),
        runId: run.id,
      }),
    signal: (pid, signal) => process.kill(pid, signal),
    strays,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  input.notify(strayCard(snapshot, outcomes));
}

async function launch(
  input: {
    db: DatabaseSync;
    factoryRoot: string;
    ids: IdSource;
    notify: (message: string) => void;
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
  const sessionFile = session.sessionFile ?? newSessionFile(input.factoryRoot, snapshot, session);
  const mode = action.kind === 'resume_run' ? 'resume' : action.mode;
  if (session.stage === 'work' || session.stage === 'qa') {
    // Cleanup never holds up the run: a sweep that fails is only reported.
    await sweepStrayProcesses(input, snapshot, run).catch((error: unknown) => {
      input.notify(
        `${snapshot.ticket.displayRef}: the stray process sweep failed: ${messageOf(error)}`,
      );
    });
  }
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
    tab: ticketTab(snapshot),
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

async function worktree(
  input: { db: DatabaseSync; ids: IdSource; now: () => string },
  action: Extract<ActionRecord, { kind: 'prepare_worktree' }>,
  snapshot: FactorySnapshot,
): Promise<RunId | null> {
  const factoryRoot = factoryRootOf(snapshot.execution.factoryDir);
  // Only a retry reuses a worktree already at the path.
  const retry = snapshot.actions.some(
    (item) => item.kind === 'prepare_worktree' && item.id !== action.id,
  );
  const prepared = prepareWorktree({
    codeRoot: snapshot.execution.policy.codeRoot,
    factoryRoot,
    leftoverStamp: retry ? null : archiveStamp(input.now()),
    slug: action.slug,
  });
  const setup = snapshot.execution.policy.worktreeSetup;
  if (prepared.kind === 'ready' && setup.length > 0) {
    // An install can outlast the default lease; hold it for the commands' timeouts.
    extendActionLease(
      input.db,
      action.id,
      input.now(),
      setup.reduce((sum, command) => sum + command.timeoutMs, 0) + 30_000,
    );
  }
  const ready = prepared.kind === 'ready' ? await setUpWorktree(setup, prepared.path) : prepared;
  if (prepared.kind === 'failed' || ready.kind === 'failed') {
    const message = ready.kind === 'failed' ? ready.message : 'worktree preparation failed';
    applyActionEvent(
      input,
      { actionId: action.id, kind: 'worktree_failed', message },
      `worktree-failed:${action.id}`,
    );
    return null;
  }
  applyActionEvent(
    input,
    {
      actionId: action.id,
      baseBranch: prepared.baseBranch,
      baseSha: prepared.baseSha,
      branch: prepared.branch,
      context: contextGaps(factoryRoot),
      kind: 'worktree_ready',
      worktreePath: prepared.path,
    },
    `worktree-ready:${action.id}`,
  );
  return null;
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
    author: null,
    body: snapshot.ticket.body,
    createdAt: null,
    displayRef: snapshot.ticket.displayRef,
    id: snapshot.ticket.id,
    labels: snapshot.ticket.labels,
    ref: snapshot.ticket.commandRef,
    title: snapshot.ticket.title,
    updatedAt: null,
    url: snapshot.ticket.sourceRef,
  };
  let failure = '';
  for (let attempt = 1; attempt <= action.maxAttempts; attempt += 1) {
    try {
      const { conflicts } = applyTicketUpdate(tracker, issue, action);
      // A box someone changed stays unticked: a warning, never a retry.
      finishLeasedAction(
        input.db,
        action.id,
        input.now(),
        conflicts.length === 0 ? 'succeeded' : 'failed',
        conflicts.length === 0
          ? null
          : `Left unticked, because the box changed on the issue: ${conflicts.map((text) => `"${text}"`).join(', ')}.`,
      );
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
  const record = (report: Parameters<typeof recordValidation>[1]['report']): void => {
    recordValidation(input, {
      actionId: action.id,
      executionId,
      report,
      resultHash: run.resultHash,
      runId: run.id,
      stage,
    });
  };
  try {
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
    record(report);
  } catch (error: unknown) {
    // A validator that throws, or a result the controller cannot store, is a
    // validator error: it retries, then fails the ticket where retry finds it.
    // Failing only the action would leave the ticket active with nothing queued.
    record(errorReport(validator.version, messageOf(error)));
  }
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
