import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { CommandBoard } from '../controller/command-progress.ts';
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
  ticketKeyOf,
  ticketTab,
} from '../controller/store.ts';
import { usageTable } from '../controller/usage.ts';
import type {
  ActionRecord,
  FactorySnapshot,
  IdSource,
  InputReady,
  PullRequestChange,
  RunId,
  RunRecord,
  SessionRecord,
  StageName,
  TerminalOutcome,
  WrapupValidationDetail,
} from '../domain.ts';
import type { ConfiguredTracker } from '../ports/trackers.ts';
import { paneLabel, taskProgressText } from '../runtime/policy.ts';
import type { FactorySubagentRuntime, LaunchSpec, ProjectConfig } from '../runtime/runtime.ts';
import { effects } from '../stages/effects.ts';
import { stages, stageTools } from '../stages/index.ts';
import { contextGaps } from '../stages/plan/context.ts';
import { readPlanLinks, type PlanLinks } from '../stages/plan/links.ts';
import { roundBase, syncWorktreeRefs } from '../validation/bases.ts';
import { recordValidation } from '../validation/record.ts';
import { errorReport } from '../validation/report.ts';
import { ticketToken, ticketTokenSecret } from '../validation/ticket-token.ts';
import type { PullRequestLookup } from '../validation/wrapup.ts';
import { applyActionEvent } from './apply.ts';
import { archiveStamp } from './leftovers.ts';
import { piAgentDir, writeReviewRules } from './review-rules.ts';
import {
  listProcesses,
  processAlive,
  strayProcesses,
  sweepStrays,
  type SweepOutcome,
} from './strays.ts';
import { applyTicketUpdate, trackerIssueOf } from './ticket-source.ts';
import { prepareWorktree, setUpWorktree } from './worktree.ts';
import { closeHandoffPanes, openHandoffPane } from './wrapup.ts';

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
  afterDetached: () => void;
  arm: (runId: RunId) => void;
  // The commands long actions are running, for their controller steps.
  commands: CommandBoard;
  db: DatabaseSync;
  factoryRoot: string;
  findPullRequest: PullRequestLookup;
  ids: IdSource;
  leaseOwner: string;
  // The pauses between retries of a linked-issues read; tests shorten them.
  linksRetryDelaysMs?: Array<number>;
  liveActions: Set<string>;
  // A line for the server log, for what fails without stopping a ticket.
  log: (line: string) => void;
  notify: (message: string) => void;
  now: () => string;
  runtime: FactorySubagentRuntime;
  // Where the server answers agents asking with their ticket's token.
  serverUrl: string | null;
  // True once the host is shutting down: leave the remaining actions pending.
  stopped: () => boolean;
  // The tracker for tracker updates, or null when FACTORY.json has none.
  tracker: () => ConfiguredTracker | null;
  // Writes a change to a pull request on the code host.
  updatePullRequest: (url: string, change: PullRequestChange) => Promise<void>;
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
      input.liveActions.add(action.id);
      void runValidation(input, action, snapshot)
        .catch((error: unknown) => {
          finishLeasedAction(input.db, action.id, input.now(), 'failed', messageOf(error));
        })
        .finally(() => {
          input.liveActions.delete(action.id);
          input.afterDetached();
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
    afterDetached: () => void;
    commands: CommandBoard;
    db: DatabaseSync;
    factoryRoot: string;
    findPullRequest: PullRequestLookup;
    ids: IdSource;
    linksRetryDelaysMs?: Array<number>;
    liveActions: Set<string>;
    log: (line: string) => void;
    notify: (message: string) => void;
    now: () => string;
    runtime: FactorySubagentRuntime;
    serverUrl: string | null;
    stopped: () => boolean;
    tracker: () => ConfiguredTracker | null;
    updatePullRequest: (url: string, change: PullRequestChange) => Promise<void>;
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
    case 'update_pull_request':
      return updatePullRequest(input, action);
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
    processes: await listProcesses(),
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

// A stage that takes its rules from the base commit gets them written beside
// its session file, and none of the worktree's own configuration.
function launchProjectConfig(
  snapshot: FactorySnapshot,
  stage: StageName,
  cwd: string,
  sessionFile: string,
): ProjectConfig {
  const definition = stages[stage];
  if (definition.projectRules === 'worktree') {
    return { kind: 'worktree', skill: definition.skill };
  }
  const { execution } = snapshot;
  if (execution.worktreeBaseSha === null) {
    throw new Error(`The ${stage} stage needs the ticket's base commit to read the project rules.`);
  }
  return {
    ...writeReviewRules({
      agentDir: piAgentDir(process.env),
      baseBranch: execution.worktreeBaseBranch,
      baseSha: execution.worktreeBaseSha,
      codeRoot: execution.policy.codeRoot,
      prefix: sessionFile,
      worktree: cwd,
    }),
    kind: 'base',
    skill: definition.skill,
  };
}

async function launch(
  input: {
    db: DatabaseSync;
    factoryRoot: string;
    ids: IdSource;
    notify: (message: string) => void;
    now: () => string;
    runtime: FactorySubagentRuntime;
    serverUrl: string | null;
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
  // A feedback round reopens the wrap-up session later; until then, the earlier
  // handoff's panes would show a stale session and diff, and keep the session
  // file open beside the round's agents.
  const roundTask = snapshot.tasks.find((item) => item.taskId === session.taskId) ?? null;
  if (roundTask?.feedback !== null && roundTask?.feedback !== undefined) {
    await closeHandoffPanes(input, snapshot.execution.id, ['open_pane', 'open_diff']);
  }
  if (session.stage === 'work' || session.stage === 'qa') {
    // Cleanup never holds up the run: a sweep that fails is only reported.
    await sweepStrayProcesses(input, snapshot, run).catch((error: unknown) => {
      input.notify(
        `${snapshot.ticket.displayRef}: the stray process sweep failed: ${messageOf(error)}`,
      );
    });
  }
  // The refs a check the agent runs compares against, current before it
  // starts. A failure to write them never holds up the run.
  const base = roundBase(snapshot);
  if (snapshot.execution.worktreePath !== null && base !== null) {
    const synced = syncWorktreeRefs({
      roundBase: base,
      targetBranch: snapshot.execution.worktreeBaseBranch,
      worktree: snapshot.execution.worktreePath,
    });
    if (synced !== null) {
      input.notify(`${snapshot.ticket.displayRef}: ${synced}`);
    }
  }
  let projectConfig: ProjectConfig;
  try {
    projectConfig = launchProjectConfig(snapshot, session.stage, action.cwd, sessionFile);
  } catch (error: unknown) {
    applyActionEvent(
      input,
      {
        actionId: action.id,
        code: 'project_rules',
        kind: 'launch_failed',
        message: messageOf(error),
        runId: run.id,
      },
      `launch-failed:${action.id}`,
    );
    return null;
  }
  // Every agent of the ticket can ask the server for controller work with its
  // ticket's token; each route checks what the ticket is doing.
  const ticketAccess =
    input.serverUrl === null
      ? null
      : {
          key: ticketKeyOf(snapshot),
          token: ticketToken(ticketTokenSecret(input.factoryRoot), snapshot.execution.id),
          url: input.serverUrl,
        };
  const spec: LaunchSpec = {
    cwd: action.cwd,
    mode,
    model: session.model,
    paneName: paneName(snapshot, session),
    previousPaneId: mode === 'resume' ? previousPaneId(snapshot, run) : null,
    projectConfig,
    prompt: action.prompt,
    purpose: run.purpose,
    // Work reports as subagent_done's arguments, answering a feedback round's
    // items when the task is one.
    report:
      session.stage === 'work'
        ? { feedbackItems: roundTask?.feedback?.items.map((item) => item.id) ?? [] }
        : null,
    runId: run.id,
    sessionFile,
    sessionId: session.id,
    stage: session.stage,
    tab: ticketTab(snapshot),
    taskLabel: taskLabel(snapshot, session),
    thinking: session.thinking,
    ticketAccess,
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
  input: {
    afterDetached: () => void;
    commands: CommandBoard;
    db: DatabaseSync;
    ids: IdSource;
    linksRetryDelaysMs?: Array<number>;
    liveActions: Set<string>;
    log: (line: string) => void;
    now: () => string;
    stopped: () => boolean;
    tracker: () => ConfiguredTracker | null;
  },
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
  const reportCommand = input.commands.reporter(action.id);
  const ready =
    prepared.kind === 'ready'
      ? await setUpWorktree(setup, prepared.path, reportCommand).finally(() => {
          reportCommand(null);
        })
      : prepared;
  if (prepared.kind === 'failed' || ready.kind === 'failed') {
    const message = ready.kind === 'failed' ? ready.message : 'worktree preparation failed';
    applyActionEvent(
      input,
      { actionId: action.id, kind: 'worktree_failed', message },
      `worktree-failed:${action.id}`,
    );
    return null;
  }
  const recordReady = (links: PlanLinks): void => {
    applyActionEvent(
      input,
      {
        actionId: action.id,
        baseBranch: prepared.baseBranch,
        baseSha: prepared.baseSha,
        branch: prepared.branch,
        context: contextGaps(factoryRoot),
        kind: 'worktree_ready',
        links,
        worktreePath: prepared.path,
      },
      `worktree-ready:${action.id}`,
    );
  };
  // Only the plan reads the linked issues, once: a worktree prepared again
  // after the plan, as on a retry, needs none.
  if (snapshot.execution.planPath !== null) {
    recordReady({ kind: 'none' });
    return null;
  }
  // The tracker may be slow and the read retries, so it runs off the
  // dispatch loop: other tickets' actions go on, and this one stays leased
  // until the links are in. A restart requeues it.
  const configured = input.tracker();
  input.liveActions.add(action.id);
  void readPlanLinks({
    issue: trackerIssueOf(snapshot.ticket),
    limit: snapshot.execution.policy.limits.linkedIssues,
    log: input.log,
    ...(input.linksRetryDelaysMs === undefined ? {} : { retryDelaysMs: input.linksRetryDelaysMs }),
    tracker:
      configured === null || trackerMismatch(snapshot, configured.tracker.kind) !== null
        ? null
        : configured.tracker,
  })
    .then((links) => {
      if (!input.stopped()) {
        recordReady(links);
      }
    })
    .catch((error: unknown) => {
      if (!input.stopped()) {
        finishLeasedAction(input.db, action.id, input.now(), 'failed', messageOf(error));
      }
    })
    .finally(() => {
      input.liveActions.delete(action.id);
      input.afterDetached();
    });
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
  input: { db: DatabaseSync; now: () => string; tracker: () => ConfiguredTracker | null },
  action: Extract<ActionRecord, { kind: 'update_ticket_source' }>,
  snapshot: FactorySnapshot,
): Promise<RunId | null> {
  const configured = input.tracker();
  if (configured === null) {
    finishLeasedAction(input.db, action.id, input.now(), 'failed', 'FACTORY.json has no tracker.');
    return null;
  }
  const { tracker, updates } = configured;
  // An update for an issue in another tracker would go to the wrong place.
  const mismatch = trackerMismatch(snapshot, tracker.kind);
  if (mismatch !== null) {
    finishLeasedAction(input.db, action.id, input.now(), 'failed', `Skipped: ${mismatch}`);
    return null;
  }
  const issue = trackerIssueOf(snapshot.ticket);
  let failure = '';
  for (let attempt = 1; attempt <= action.maxAttempts; attempt += 1) {
    try {
      const { conflicts, statusNote } = await applyTicketUpdate(tracker, issue, action, updates);
      // A box someone changed stays unticked, and a status the issue's
      // tracker cannot show stays unshown: a warning, never a retry.
      const warnings = [
        ...(conflicts.length === 0
          ? []
          : [
              `Left unticked, because the item changed on the issue: ${conflicts.map((text) => `"${text}"`).join(', ')}.`,
            ]),
        ...(statusNote === null ? [] : [statusNote]),
      ];
      finishLeasedAction(
        input.db,
        action.id,
        input.now(),
        warnings.length === 0 ? 'succeeded' : 'failed',
        warnings.length === 0 ? null : warnings.join(' '),
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

// Writes the pull request's body or a comment on it. A code host that keeps
// failing leaves the action failed, which the API shows as a warning; the
// ticket stays ready for handoff either way.
async function updatePullRequest(
  input: {
    db: DatabaseSync;
    now: () => string;
    updatePullRequest: (url: string, change: PullRequestChange) => Promise<void>;
  },
  action: Extract<ActionRecord, { kind: 'update_pull_request' }>,
): Promise<RunId | null> {
  let failure = '';
  for (let attempt = 1; attempt <= action.maxAttempts; attempt += 1) {
    try {
      await input.updatePullRequest(action.pullRequestUrl, action.change);
      finishLeasedAction(input.db, action.id, input.now(), 'succeeded', null);
      return null;
    } catch (error: unknown) {
      failure = messageOf(error);
      if (attempt < action.maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }
  }
  const what =
    action.change.kind === 'body' ? 'Pull request body not set' : 'Pull request comment not posted';
  finishLeasedAction(input.db, action.id, input.now(), 'failed', `${what}: ${failure}`);
  return null;
}

async function runValidation(
  input: {
    commands: CommandBoard;
    db: DatabaseSync;
    findPullRequest: PullRequestLookup;
    ids: IdSource;
    now: () => string;
  },
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
  const reportCommand = input.commands.reporter(action.id);
  try {
    const report = await validator.validate({
      deps: {
        findPullRequest: input.findPullRequest,
        reportCommand,
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
  } finally {
    reportCommand(null);
  }
  return null;
}

// Prepares a stage's input outside the controller transaction and hands the
// reducer what it found, or why the stage cannot start.
async function prepareInput(
  input: {
    db: DatabaseSync;
    ids: IdSource;
    now: () => string;
    tracker: () => ConfiguredTracker | null;
  },
  action: Extract<ActionRecord, { kind: 'prepare_input' }>,
  snapshot: FactorySnapshot,
): Promise<RunId | null> {
  const executionId = snapshot.execution.id;
  const result = await effects[action.stage].prepareInput({
    action,
    deps: {
      // Null when the ticket has no issue or its tracker keeps no checklist.
      checklistItems: async () => {
        const tracker = input.tracker()?.tracker ?? null;
        const { ticket } = snapshot;
        if (
          tracker === null ||
          ticket.sourceKind === 'file' ||
          ticket.sourceKind === 'text' ||
          !tracker.capabilities.has('checklist')
        ) {
          return null;
        }
        const mismatch = trackerMismatch(snapshot, tracker.kind);
        if (mismatch !== null) {
          throw new Error(mismatch);
        }
        return tracker.checklistItems(trackerIssueOf(ticket));
      },
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
  return null;
}

// Why a ticket's issue is out of reach of the configured tracker, or null when
// it is not: the ticket came from another tracker, and FACTORY.json has since
// switched.
function trackerMismatch(snapshot: FactorySnapshot, trackerKind: string): string | null {
  const { displayRef, sourceKind } = snapshot.ticket;
  return sourceKind === trackerKind
    ? null
    : `${displayRef} came from ${sourceKind}; the configured tracker is ${trackerKind}.`;
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
