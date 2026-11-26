import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  cleanUpTicket,
  CLEANUP_WAIT,
  needsAttention,
  outcomeLine,
  pullRequestCommits,
} from '../actions/cleanup.ts';
import { dispatchPending, watchRun } from '../actions/dispatch.ts';
import {
  type FeedbackChoice,
  type FeedbackRefusal,
  listFeedback,
  prepareFeedbackRound,
  writeFeedbackTask,
} from '../actions/feedback-round.ts';
import { archiveLeftoverDir, archiveStamp } from '../actions/leftovers.ts';
import { readRebased, rebasedPreview } from '../actions/rebased-retry.ts';
import { listProcesses } from '../actions/strays.ts';
import { pullRequestLookup } from '../actions/wrapup.ts';
import { pullRequestsAllowed, readFactoryConfig } from '../config.ts';
import {
  randomIds,
  runId as runIdOf,
  ticketId as ticketIdOf,
  type Actor,
  type ControllerEvent,
  type ExecutionId,
  type FactorySnapshot,
  type IdSource,
  type Policy,
  type RequestedValidation,
  type RunId,
  type TerminalOutcome,
} from '../domain.ts';
import { sha256 } from '../hash.ts';
import {
  codeHostRepo,
  createGithubCodeHost,
  type CodeHost,
  type PullRequestInfo,
  type PullRequestOutcome,
} from '../ports/code-host.ts';
import { githubCliClient, type GithubClient } from '../ports/github.ts';
import type { IssueLink } from '../ports/tracker.ts';
import {
  createTracker,
  linearFromEnv,
  trackerKindOf,
  type ConfiguredTracker,
  type TrackerClients,
} from '../ports/trackers.ts';
import { createPiHerdrRuntime } from '../runtime/pi-herdr.ts';
import type { FactorySubagentRuntime } from '../runtime/runtime.ts';
import { stages } from '../stages/index.ts';
import { runReview } from '../stages/review/parse.ts';
import { openStateDatabase } from '../state/database.ts';
import { resolveTicket, type TicketSource } from '../tickets.ts';
import { roundBase, roundStart } from '../validation/bases.ts';
import { workFingerprint } from '../validation/fingerprint.ts';
import { missingTests, type SelectedTest } from '../validation/selection.ts';
import { isTicketToken, ticketTokenSecret } from '../validation/ticket-token.ts';
import { runWorkCommands, WORK_VALIDATOR_VERSION } from '../validation/work.ts';
import type { PullRequestLookup } from '../validation/wrapup.ts';
import { factoryVersion } from '../version.ts';
import { createCommandBoard, type CommandProgress } from './command-progress.ts';
import {
  markPullRequestSynced,
  pullRequestUrlOf,
  recordCommit,
  recordPullRequest,
  recordReview,
} from './facts.ts';
import { factoryRootOf, generationDir, keyOfFactoryDir, ticketDirOf } from './keys.ts';
import { parseFactoryCommand, type ParsedCommand } from './parse.ts';

type FeedbackCommand = Extract<ParsedCommand, { kind: 'feedback' }>;
import type { TicketProgress } from './progress.ts';
import { describeExisting } from './reduce.ts';
import {
  attentionCard,
  correctsRun,
  feedbackRoundCard,
  pendingFeedbackCard,
  finishedRunCard,
  firstSummaryLine,
  runOutcome,
  runStage,
} from './run-card.ts';
import {
  applyControllerEvent,
  formatStatus,
  listActiveRuns,
  latestRevision,
  recordedRevision,
  listRunningChildren,
  loadCurrentByFactoryKey,
  loadCurrentByTicketKey,
  loadSnapshotByExecution,
  loadSnapshotByRun,
  recordCard,
  recordCarriedPass,
  recordRequestedValidation,
  requeueOrphanedPanes,
  requeueOrphanedTrackerUpdates,
  requeueOrphanedWorktrees,
  requeueOrphanedValidations,
  ticketKeyOf,
  type ApplyResult,
  type RunningChildRow,
} from './store.ts';
import { progressOf, statusOf, ticketDetailFor, type TicketDetail } from './view.ts';

export type { TicketDetail, TicketRunRow } from './view.ts';

// Why the API refused a command, before anything changed.
export type CommandRefusal =
  | 'code_host_unavailable'
  | 'factory_config'
  | 'invalid_ref'
  | 'invalid_state'
  | 'not_waiting_for_reply'
  | 'run_not_found'
  | 'ticket_not_found'
  | 'tracker_unavailable'
  | 'umbrella_issue';

// An API command's actor, and the client's Idempotency-Key, if it sent one.
export type CommandOptions = { actor: Actor | null; idempotencyKey: string | null };

export type CommandOutcome =
  | { kind: 'accepted'; message: string; revision: number; ticket: string }
  | { kind: 'refused'; message: string; reason: CommandRefusal };

type Committed =
  | { applied: ApplyResult; displayRef: string; kind: 'committed' }
  | { kind: 'refused'; message: string; reason: CommandRefusal };

// The commands the API calls. Each returns once the command is committed; agent
// launches and validations follow in the background.
export type FactoryCommands = {
  // Ends a ticket for good; its worktree, branch, and pull request stay.
  cancel: (key: string, reason: string | null, options: CommandOptions) => CommandOutcome;
  complete: (key: string, options: CommandOptions) => CommandOutcome;
  // Takes the open pull request's pending feedback, or the part `request`
  // picks, back through work, review, and wrap-up on the same branch, as task
  // F<n>.
  feedback: (
    key: string,
    request: FeedbackRequest,
    options: CommandOptions,
  ) => Promise<CommandOutcome>;
  // The pull request's pending feedback, for picking a round's comments.
  // Reads GitHub; changes nothing.
  pendingFeedback: (key: string) => Promise<PendingFeedbackOutcome>;
  reply: (key: string, answer: string, options: CommandOptions) => CommandOutcome;
  // Runs the work validation commands for the ticket's running work run, on
  // its worktree as it stands, when its agent asks with the ticket's token;
  // the run's submission reuses the result while nothing it depends on
  // changed.
  requestWorkValidation: (
    key: string,
    token: string,
    tests: Array<SelectedTest>,
  ) => Promise<WorkValidationOutcome>;
  // Starts generation N+1 of a finished ticket from a fresh copy of its issue.
  rerun: (key: string, options: CommandOptions) => Promise<CommandOutcome>;
  retry: (key: string, options: CommandOptions) => CommandOutcome;
  // Carries a paused wrap-up pass over to a branch a person rebased, then
  // validates again.
  retryRebased: (key: string, options: CommandOptions) => CommandOutcome;
  // What retryRebased would do; changes nothing but the worktree's refs.
  retryRebasedPreview: (key: string) => RebasedPreviewOutcome;
  start: (source: TicketSource, options: CommandOptions) => Promise<CommandOutcome>;
  // Stops one running agent by its run id; the ticket pauses.
  stopRun: (runId: string, options: CommandOptions) => CommandOutcome;
};

// A feedback round's note and which pending comments it takes.
export type FeedbackRequest = FeedbackChoice & { note: string | null };

export type PendingFeedbackOutcome =
  | ({ kind: 'listed'; ticket: string } & Exclude<
      Awaited<ReturnType<typeof listFeedback>>,
      FeedbackRefusal
    >)
  | { kind: 'refused'; message: string; reason: CommandRefusal };

// What a validation a work agent asked for came to.
export type WorkValidationOutcome =
  | {
      // Whether it was kept on the run: false when the run ended meanwhile.
      attached: boolean;
      evidence: RequestedValidation;
      kind: 'validated';
    }
  | {
      kind: 'refused';
      message: string;
      reason: 'invalid_state' | 'ticket_not_found' | 'unauthorized';
    };

export type RebasedPreviewOutcome =
  | { kind: 'preview'; preview: string; ticket: string }
  | { kind: 'refused'; message: string; reason: CommandRefusal };

const piCommand: CommandOptions = { actor: null, idempotencyKey: null };

// Who finishes a ticket when the code host reports its pull request merged or closed.
const CODE_HOST_ACTOR: Actor = { client: 'code-host', onBehalfOf: null };

// A client's Idempotency-Key replaces the command's own dedupe key, scoped to
// the client so two clients cannot collide.
function dedupe(options: CommandOptions, own: string): string {
  return options.idempotencyKey === null
    ? own
    : `api:${options.actor?.client ?? ''}:${options.idempotencyKey}`;
}

function committed(applied: ApplyResult, displayRef: string, refusal: CommandRefusal): Committed {
  if (applied.response.kind === 'rejected') {
    return { kind: 'refused', message: applied.response.message, reason: refusal };
  }
  return { applied, displayRef, kind: 'committed' };
}

// An open tracker issue that is not a ticket yet, with what stands in its way.
export type BacklogItem = {
  author: string | null;
  blockedBy: Array<IssueLink>;
  body: string;
  children: Array<IssueLink>;
  createdAt: string | null;
  displayRef: string;
  id: string;
  labels: Array<string>;
  title: string;
  updatedAt: string | null;
  url: string;
};

export type BacklogResult =
  | { fetchedAt: string; items: Array<BacklogItem>; kind: 'ok' }
  | { kind: 'error'; message: string };

// How long a fetched backlog is served before the tracker is asked again.
export const BACKLOG_CACHE_MS = 60_000;

// The agent a ticket is running now, if any.
function runningRun(snapshot: FactorySnapshot): RunId | null {
  const running = snapshot.runs.filter(
    (run) => run.status === 'running' || run.status === 'starting',
  );
  return running.at(-1)?.id ?? null;
}

export type FactoryService = {
  // The backlog, from a short cache unless `refresh`.
  backlog: (refresh: boolean) => Promise<BacklogResult>;
  command: (args: string) => Promise<string>;
  // The command an action is running, while it runs one.
  commandProgress: (actionId: string) => CommandProgress | null;
  commands: FactoryCommands;
  // Progress of every current ticket that is not finished.
  progress: () => Array<TicketProgress>;
  // The code host reported a pull request changed: refresh the ticket that
  // has it and return the ticket's key, or null when none does.
  pullRequestChanged: (pullRequest: PullRequestInfo) => Promise<string | null>;
  // Records what the code host says about a ticket's pull request, then
  // finishes the ticket on a merge or a close.
  recordPullRequestOutcome: (executionId: string, outcome: PullRequestOutcome) => void;
  recover: () => Promise<void>;
  runningChildren: () => Array<RunningChildRow>;
  status: (ref: string) => string;
  // Stops dispatching and waits for the action in progress. Agent panes keep
  // running; the next host adopts them with recover().
  stop: () => Promise<void>;
  // Checks the pull request of every ticket in handoff.
  syncPullRequests: () => Promise<{ errors: Array<string>; synced: number }>;
  ticketDetail: (ref: string | null) => TicketDetail | string;
};

export function createFactoryService(input: {
  // The code host, from FACTORY.json by default. Tests pass a stand-in.
  codeHost?: () => CodeHost;
  codeRoot: string;
  db?: DatabaseSync;
  factoryRoot: string;
  // Looks up a pull request by URL during wrap-up validation; the code host by default.
  findPullRequest?: PullRequestLookup;
  github?: GithubClient;
  ids?: IdSource;
  // Recorded on every action this service claims; see claimNextAction.
  leaseOwner?: string;
  // Linear for a Linear tracker; the SDK with the key from the environment by default.
  linear?: TrackerClients['linear'];
  // The pauses between retries of a linked-issues read; tests shorten them.
  linksRetryDelaysMs?: Array<number>;
  // A line for the server log; nothing by default.
  log?: (line: string) => void;
  notify?: (message: string) => void;
  now?: () => string;
  onActivity?: () => void;
  runtime?: FactorySubagentRuntime;
  // Where this server answers, for agents to ask it for controller work with
  // their ticket's token; without it, agents get no such access.
  serverUrl?: string;
}): FactoryService {
  const db = input.db ?? openStateDatabase(input.factoryRoot, { create: true });
  const runtime = input.runtime ?? createPiHerdrRuntime();
  const clients: TrackerClients = {
    github: input.github ?? githubCliClient(),
    linear: input.linear ?? linearFromEnv(process.env),
  };
  const post = input.notify ?? (() => undefined);
  const log = input.log ?? (() => undefined);
  // Every card is also kept as an event, for clients that read the history.
  const notify = (message: string): void => {
    recordCard(db, message, now());
    post(message);
  };
  const onActivity = input.onActivity ?? (() => undefined);
  const now = input.now ?? (() => new Date().toISOString());
  const ids = input.ids ?? randomIds();
  const liveActions = new Set<string>();
  let dispatching = false;
  let rerun = false;
  let stopped = false;

  const apply = (
    event: ControllerEvent,
    dedupeKey: string,
    source: 'command' | 'runtime' | 'controller',
    actor: Actor | null = null,
  ): ApplyResult => {
    const applied = applyControllerEvent(db, { actor, dedupeKey, event, ids, now: now(), source });
    if (applied.response.kind === 'status' && applied.response.stage === 'done') {
      closeFinishedTab(event);
    }
    return applied;
  };

  // A finished ticket's tab closes; the session and diff panes go with it.
  function closeFinishedTab(event: ControllerEvent): void {
    if (
      event.kind !== 'complete' &&
      event.kind !== 'pull_request_closed' &&
      event.kind !== 'cancel'
    ) {
      return;
    }
    const snapshot = loadCurrentByTicketKey(db, event.ticketId);
    if (snapshot === null) {
      return;
    }
    const closed =
      runtime.closeTab === undefined
        ? Promise.resolve()
        : runtime.closeTab(ticketKeyOf(snapshot)).catch(() => undefined);
    // A completed ticket's worktree is cleaned up once its panes are gone.
    if (event.kind === 'complete') {
      void closed.then(() => cleanUpCompleted(snapshot.execution.id));
    }
  }

  const arm = (runId: RunId): void => {
    watchRun({
      db,
      onTerminal: (id, terminal) => {
        void onTerminal(id, terminal);
      },
      runId,
      runtime,
    });
  };

  // The code host is read from FACTORY.json each time, like the policy.
  const codeHost =
    input.codeHost ??
    (() => {
      const config = readFactoryConfig(input.factoryRoot);
      return createGithubCodeHost(config.kind === 'ok' ? config.config.codeHost : null);
    });
  const findPullRequest: PullRequestLookup = (url) => pullRequestLookup(codeHost())(url);
  // The commands long actions are running, for their controller steps.
  const commandBoard = createCommandBoard(now);
  const trackerFor = (): ConfiguredTracker | null => {
    const config = readFactoryConfig(input.factoryRoot);
    return config.kind === 'ok' && config.config.tracker !== null
      ? {
          tracker: createTracker(config.config.tracker, clients),
          updates: config.config.tracker.updates,
        }
      : null;
  };

  function recordPullRequestOutcome(executionId: string, outcome: PullRequestOutcome): void {
    const at = now();
    recordPullRequest(db, { ...outcome.pullRequest, executionId }, at);
    for (const review of outcome.reviews) {
      recordReview(db, {
        author: review.author,
        authorType: review.authorType,
        commitSha: review.commitSha,
        executionId,
        hasBody: review.hasBody,
        reviewId: review.id,
        state: review.state,
        submittedAt: review.submittedAt,
      });
    }
    for (const commit of outcome.commits) {
      recordCommit(db, { committedAt: commit.committedAt, executionId, sha: commit.sha });
    }
    markPullRequestSynced(db, executionId, at);
    const ticket = db
      .prepare('SELECT ticket_id FROM ticket_executions WHERE id = ?')
      .get(executionId)?.['ticket_id'];
    if (ticket === undefined) {
      return;
    }
    const ticketId = ticketIdOf(String(ticket));
    if (outcome.pullRequest.state === 'merged') {
      apply(
        { idempotencyKey: `complete:${ticketId}`, kind: 'complete', ticketId },
        `code-host:merged:${executionId}`,
        'controller',
        CODE_HOST_ACTOR,
      );
    } else if (outcome.pullRequest.state === 'closed') {
      apply(
        {
          idempotencyKey: `pull-request-closed:${executionId}`,
          kind: 'pull_request_closed',
          ticketId,
          url: outcome.pullRequest.url,
        },
        `code-host:closed:${executionId}`,
        'controller',
        CODE_HOST_ACTOR,
      );
    }
  }

  async function pullRequestChanged(pullRequest: PullRequestInfo): Promise<string | null> {
    const found = db
      .prepare(
        `SELECT e.id, e.factory_dir
         FROM ticket_executions AS e
         LEFT JOIN pull_requests AS pr ON pr.execution_id = e.id
         WHERE e.is_current = 1 AND (pr.url = ? OR e.worktree_branch = ?)
         LIMIT 1`,
      )
      .get(pullRequest.url, pullRequest.headBranch);
    if (found === undefined) {
      return null;
    }
    recordPullRequestOutcome(String(found['id']), await codeHost().pullRequestOutcome(pullRequest));
    void drain();
    return keyOfFactoryDir(String(found['factory_dir']));
  }

  let backlogCache: { at: number; fetchedAt: string; items: Array<BacklogItem> } | null = null;

  async function backlog(refresh: boolean): Promise<BacklogResult> {
    const config = readFactoryConfig(input.factoryRoot);
    if (config.kind === 'error') {
      return { kind: 'error', message: config.message };
    }
    if (config.config.tracker === null) {
      return { kind: 'error', message: 'FACTORY.json has no tracker, so there is no backlog.' };
    }
    if (refresh || backlogCache === null || Date.now() - backlogCache.at > BACKLOG_CACHE_MS) {
      const tracker = createTracker(config.config.tracker, clients);
      try {
        const issues = await tracker.listBacklog();
        const items: Array<BacklogItem> = [];
        // Links the backlog read already come with the issue; otherwise the
        // tracker is asked one issue at a time, in order.
        for (const issue of issues) {
          const links = issue.links ?? {
            blockedBy: tracker.capabilities.has('blockedBy') ? await tracker.blockedBy(issue) : [],
            children: await tracker.children(issue),
          };
          items.push({
            author: issue.author,
            blockedBy: links.blockedBy,
            body: issue.body,
            children: links.children,
            createdAt: issue.createdAt,
            displayRef: issue.displayRef,
            id: issue.id,
            labels: issue.labels,
            title: issue.title,
            updatedAt: issue.updatedAt,
            url: issue.url,
          });
        }
        backlogCache = { at: Date.now(), fetchedAt: now(), items };
      } catch (error: unknown) {
        return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
      }
    }
    // Issues started since the fetch drop out at once.
    const started = new Set(
      db
        .prepare('SELECT id FROM tickets')
        .all()
        .map((item) => String(item['id'])),
    );
    return {
      fetchedAt: backlogCache.fetchedAt,
      items: backlogCache.items.filter((item) => !started.has(item.id)),
      kind: 'ok',
    };
  }

  // Tickets waiting at handoff, with the pull request recorded for them, if any.
  async function syncPullRequests(): Promise<{ errors: Array<string>; synced: number }> {
    const waiting = db
      .prepare(
        `SELECT e.id, e.worktree_branch, pr.url
         FROM ticket_executions AS e
         LEFT JOIN pull_requests AS pr ON pr.execution_id = e.id
         WHERE e.is_current = 1 AND e.status = 'ready_for_handoff'`,
      )
      .all();
    const errors: Array<string> = [];
    let synced = 0;
    for (const item of waiting) {
      const executionId = String(item['id']);
      try {
        const host = codeHost();
        const recorded = item['url'] == null ? null : String(item['url']);
        const branch = item['worktree_branch'] == null ? null : String(item['worktree_branch']);
        const pullRequest =
          recorded !== null
            ? await host.pullRequest(recorded)
            : branch !== null
              ? await host.findPullRequest(branch)
              : null;
        if (pullRequest === null) {
          continue;
        }
        recordPullRequestOutcome(executionId, await host.pullRequestOutcome(pullRequest));
        synced += 1;
      } catch (error: unknown) {
        errors.push(`${executionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await drain();
    return { errors, synced };
  }

  async function drain(): Promise<void> {
    if (stopped) {
      return;
    }
    if (dispatching) {
      rerun = true;
      return;
    }
    dispatching = true;
    try {
      do {
        rerun = false;
        await dispatchPending({
          afterDetached: () => {
            void drain();
          },
          arm,
          commands: commandBoard,
          db,
          factoryRoot: input.factoryRoot,
          findPullRequest: input.findPullRequest ?? findPullRequest,
          ids,
          leaseOwner: input.leaseOwner ?? 'factory-controller',
          ...(input.linksRetryDelaysMs === undefined
            ? {}
            : { linksRetryDelaysMs: input.linksRetryDelaysMs }),
          liveActions,
          log,
          notify,
          now,
          runtime,
          serverUrl: input.serverUrl ?? null,
          stopped: () => stopped,
          tracker: trackerFor,
          updatePullRequest: (url, change) =>
            change.kind === 'body'
              ? codeHost().setPullRequestBody(url, change.body)
              : codeHost().commentOnPullRequest(url, change.key, change.markdown),
        });
      } while (rerun && !stopped);
    } finally {
      dispatching = false;
      if (rerun && !stopped) {
        void drain();
      } else {
        onActivity();
      }
    }
  }

  async function onTerminal(runId: RunId, terminal: TerminalOutcome): Promise<void> {
    const applied = apply(
      { kind: 'runtime_terminal', runId, terminal },
      `runtime:${runId}:terminal`,
      'runtime',
    );
    if (applied.response.kind === 'rejected' || applied.response.message.startsWith('Duplicate')) {
      return;
    }
    await drain();
    const snapshot = await whenRunSettled(runId);
    const run = snapshot?.runs.find((item) => item.id === runId) ?? null;
    if (snapshot === null || run === null) {
      return;
    }
    notify(finishedRunCard(snapshot, run, terminalSummary(snapshot, run.id, terminal)));
  }

  async function whenRunSettled(runId: RunId): Promise<FactorySnapshot | null> {
    for (;;) {
      const snapshot = loadSnapshotByRun(db, runId);
      if (snapshot === null || !runValidationOpen(snapshot, runId)) {
        return snapshot;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  function runValidationOpen(snapshot: FactorySnapshot, runId: RunId): boolean {
    return snapshot.actions.some((action) => {
      if (action.kind !== 'validate_run' || action.runId !== runId) {
        return false;
      }
      if (action.status === 'pending') {
        return true;
      }
      return action.status === 'leased' && liveActions.has(action.id);
    });
  }

  async function recover(): Promise<void> {
    const active = listActiveRuns(db);
    const observations = await runtime.reconcile(
      active.map((run) => ({ paneId: run.paneId, runId: run.runId, sessionFile: run.sessionFile })),
    );
    for (const item of observations) {
      const label =
        item.observation.kind === 'terminal'
          ? item.observation.terminal.kind
          : item.observation.kind;
      const applied = apply(
        { kind: 'reconciled', observation: item.observation, runId: item.runId },
        `reconcile:${item.runId}:${label}`,
        'controller',
      );
      if (applied.armRunId !== null) {
        arm(applied.armRunId);
      }
    }
    requeueOrphanedValidations(db, now(), liveActions);
    requeueOrphanedPanes(db, now());
    requeueOrphanedTrackerUpdates(db, now());
    requeueOrphanedWorktrees(db, now());
    await drain();
    for (const run of listActiveRuns(db)) {
      if (run.paneId !== null) {
        arm(run.runId);
      }
    }
  }

  async function stop(): Promise<void> {
    stopped = true;
    while (dispatching) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  function requireSnapshot(ref: string): FactorySnapshot | string {
    const snapshot = loadCurrentByTicketKey(db, ref);
    if (snapshot === null) {
      return `No factory execution matches ${ref}.`;
    }
    return snapshot;
  }

  function policyFromConfig(): Policy | string {
    const config = readFactoryConfig(input.factoryRoot);
    if (config.kind === 'error') {
      return config.message;
    }
    return {
      codeHostRepo: config.config.codeHost === null ? null : codeHostRepo(config.config.codeHost),
      codeRoot: input.codeRoot,
      communication: config.config.communication,
      labels: config.config.labels,
      limits: config.config.limits,
      models: config.config.models,
      pullRequests: pullRequestsAllowed(config.config),
      pullRequestTitle: config.config.codeHost?.pullRequestTitle ?? null,
      stages: config.config.stages,
      validation: config.config.validation,
      worktreeSetup: config.config.worktree.setup,
    };
  }

  // Each command's committing part: it resolves, applies, and commits, and
  // leaves dispatch to the caller. Pi waits for the dispatch; the API answers
  // as soon as the command is committed. Start and rerun ask the tracker first,
  // so they are async.
  async function startCommitted(source: TicketSource, options: CommandOptions): Promise<Committed> {
    const policy = policyFromConfig();
    if (typeof policy === 'string') {
      return { kind: 'refused', message: policy, reason: 'factory_config' };
    }
    const config = readFactoryConfig(input.factoryRoot);
    if (config.kind === 'error') {
      return { kind: 'refused', message: config.message, reason: 'factory_config' };
    }
    const resolved = await resolveTicket({
      codeRoot: input.codeRoot,
      factoryRoot: input.factoryRoot,
      fetchedAt: now(),
      source,
      tracker: createTracker(config.config.tracker, clients),
    });
    if (resolved.kind === 'error') {
      return {
        kind: 'refused',
        message: resolved.message,
        reason: resolved.reason ?? 'invalid_ref',
      };
    }
    // The database knows no run of this ticket, so files at its directory
    // are a forgotten run's.
    if (loadCurrentByTicketKey(db, resolved.ticket.id) === null) {
      archiveLeftoverDir({
        dir: resolved.ticket.factoryDir,
        factoryRoot: input.factoryRoot,
        stamp: archiveStamp(now()),
      });
    }
    mkdirSync(resolved.ticket.factoryDir, { recursive: true });
    const applied = apply(
      { factoryVersion: factoryVersion(), kind: 'start', policy, ticket: resolved.ticket },
      dedupe(options, `command:start:${resolved.ticket.id}`),
      'command',
      options.actor,
    );
    return committed(applied, resolved.ticket.displayRef, 'invalid_state');
  }

  function replyCommitted(
    snapshot: FactorySnapshot,
    answer: string,
    options: CommandOptions,
  ): Committed {
    // An answer to the question asked: the same words may answer the next
    // question, or the same one in a rerun's generation.
    // The question still being handled: a resend of the same answer, after it
    // moved the question on to resuming, is the same reply.
    const question =
      snapshot.attention.findLast(
        (item) =>
          item.status === 'open' || item.status === 'answered' || item.status === 'resuming',
      )?.id ?? 'no-question';
    const key = dedupe(options, `reply:${snapshot.execution.id}:${question}:${sha256(answer)}`);
    const applied = apply(
      {
        ...(options.actor === null ? {} : { actor: options.actor }),
        answer,
        idempotencyKey: key,
        kind: 'reply',
        ticketId: snapshot.ticket.id,
      },
      key,
      'command',
      options.actor,
    );
    const waiting = snapshot.attention.some(
      (item) => item.status === 'open' && item.runId !== null,
    );
    return committed(
      applied,
      snapshot.ticket.displayRef,
      waiting ? 'invalid_state' : 'not_waiting_for_reply',
    );
  }

  // Deduped by the generation and its version: a ticket and its rerun can
  // wait for a retry at the same version. The reducer makes the keys of the
  // actions a retry creates unique.
  function retryCommitted(snapshot: FactorySnapshot, options: CommandOptions): Committed {
    const applied = apply(
      {
        idempotencyKey: `retry:${snapshot.execution.version}`,
        kind: 'retry',
        ticketId: snapshot.ticket.id,
      },
      dedupe(options, `retry:${snapshot.execution.id}:${snapshot.execution.version}`),
      'command',
      options.actor,
    );
    return committed(applied, snapshot.ticket.displayRef, 'invalid_state');
  }

  function rebasedCommitted(snapshot: FactorySnapshot, options: CommandOptions): Committed {
    const read = readRebased(snapshot, true);
    if (read.kind === 'refused') {
      return { kind: 'refused', message: read.message, reason: 'invalid_state' };
    }
    const { pass, previousBaseline } = read;
    const key = `retry-rebased:${snapshot.execution.version}`;
    const applied = apply(
      {
        ...(options.actor === null ? {} : { actor: options.actor }),
        baseline: JSON.stringify(pass.baseline),
        carried: {
          compareBase: pass.baseline.compareBase ?? '',
          dropped: pass.dropped.length,
          head: pass.baseline.head,
          kept: pass.kept.length,
          previousCompareBase: previousBaseline.compareBase,
          previousHead: previousBaseline.head,
          previousRoundStart: roundStart(snapshot),
          roundStart: pass.roundStart,
        },
        idempotencyKey: key,
        kind: 'retry_rebased',
        previousBaseline: read.previous,
        runId: read.runId,
        ticketId: snapshot.ticket.id,
      },
      dedupe(options, `${key}:${snapshot.execution.id}`),
      'command',
      options.actor,
    );
    if (applied.response.kind !== 'rejected' && !applied.response.message.startsWith('Duplicate')) {
      recordCarriedPass(db, {
        actor: options.actor,
        carried: {
          compareBase: pass.baseline.compareBase ?? '',
          dropped: pass.dropped.length,
          head: pass.baseline.head,
          kept: pass.kept.length,
          previousCompareBase: previousBaseline.compareBase,
          previousHead: previousBaseline.head,
          previousRoundStart: roundStart(snapshot),
          roundStart: pass.roundStart,
        },
        executionId: snapshot.execution.id,
        now: new Date().toISOString(),
        previousBaseline: read.previous,
        runId: read.runId,
      });
    }
    return committed(applied, snapshot.ticket.displayRef, 'invalid_state');
  }

  // A requested validation runs at most once at a time per run, so two cannot
  // race to attach their result to it.
  const requestedRuns = new Set<string>();

  async function requestWorkValidation(
    key: string,
    token: string,
    tests: Array<SelectedTest>,
  ): Promise<WorkValidationOutcome> {
    const snapshot = loadCurrentByFactoryKey(db, key);
    if (snapshot === null) {
      return { kind: 'refused', message: `No ticket ${key}.`, reason: 'ticket_not_found' };
    }
    const { execution } = snapshot;
    if (!isTicketToken(ticketTokenSecret(input.factoryRoot), execution.id, token)) {
      return {
        kind: 'refused',
        message: `The ticket token is not ${snapshot.ticket.displayRef}'s.`,
        reason: 'unauthorized',
      };
    }
    const running = snapshot.runs.filter(
      (run) =>
        (run.status === 'running' || run.status === 'starting') &&
        snapshot.sessions.find((item) => item.id === run.sessionId)?.stage === 'work',
    );
    const run = running.length === 1 ? running[0] : undefined;
    const base = roundBase(snapshot);
    if (run === undefined || execution.worktreePath === null || base === null) {
      return {
        kind: 'refused',
        message: `${snapshot.ticket.displayRef} has no work run running; a validation is asked for while one works.`,
        reason: 'invalid_state',
      };
    }
    const missing = missingTests(tests, execution.worktreePath);
    if (missing.length > 0) {
      return { kind: 'refused', message: missing.join('\n'), reason: 'invalid_state' };
    }
    if (requestedRuns.has(run.id)) {
      return {
        kind: 'refused',
        message: 'A validation this run asked for is already running; wait for its result.',
        reason: 'invalid_state',
      };
    }
    requestedRuns.add(run.id);
    try {
      const commands = execution.policy.validation.work.commands;
      const fingerprint = () => {
        const found = workFingerprint({
          base,
          commands,
          executionId: execution.id,
          factoryRoot: factoryRootOf(execution.factoryDir),
          selection: tests,
          validatorVersion: WORK_VALIDATOR_VERSION,
          version: factoryVersion(),
          worktree: execution.worktreePath ?? '',
        });
        return 'fingerprint' in found ? found.fingerprint : null;
      };
      const startedAt = now();
      const before = fingerprint();
      const ran = await runWorkCommands({
        commands,
        cwd: execution.worktreePath,
        factoryRoot: factoryRootOf(execution.factoryDir),
        reportCommand: () => undefined,
        tests,
      });
      const after = fingerprint();
      const checks =
        'spawnError' in ran
          ? [
              {
                command: null,
                details: ran.spawnError,
                durationMs: null,
                exitCode: null,
                kind: 'command' as const,
                name: 'validation',
                outputExcerpt: null,
                status: 'error' as const,
              },
            ]
          : ran.checks;
      // A change while the commands ran, by a formatter or by the agent, or
      // inputs git could not read, leave nothing to reuse.
      const evidence: RequestedValidation = {
        checks,
        fingerprint: after ?? '',
        finishedAt: now(),
        passed: checks.every((check) => check.status === 'passed'),
        reusable: before !== null && before === after,
        startedAt,
      };
      const applied = apply(
        { evidence, kind: 'work_validation_requested', runId: run.id },
        `requested-validation:${run.id}:${startedAt}`,
        'runtime',
      );
      const attached = applied.response.kind !== 'rejected';
      recordRequestedValidation(db, {
        attached,
        evidence,
        executionId: execution.id,
        runId: run.id,
      });
      return { attached, evidence, kind: 'validated' };
    } finally {
      requestedRuns.delete(run.id);
    }
  }

  // The human marks a ready-for-handoff ticket done. Repeating it is a no-op.
  function completeCommitted(snapshot: FactorySnapshot, options: CommandOptions): Committed {
    const applied = apply(
      {
        idempotencyKey: `complete:${snapshot.ticket.id}`,
        kind: 'complete',
        ticketId: snapshot.ticket.id,
      },
      // A rerun's generation completes on its own, whatever its version.
      dedupe(options, `complete:${snapshot.execution.id}:${snapshot.execution.version}`),
      'command',
      options.actor,
    );
    return committed(applied, snapshot.ticket.displayRef, 'invalid_state');
  }

  // Once a ticket is complete, its worktree and local branch go, as far as
  // that is safe, off the caller's path: removing a worktree full of
  // dependencies takes a while. It runs after the ticket's tab closed, so the
  // handoff panes' processes have left the worktree. Cleaning up is
  // idempotent: a request while one runs joins it, a later one finds what is
  // already gone, and a card goes out only when the outcome changed.
  const cleanups = new Map<string, Promise<void>>();
  const reported = new Map<string, string>();
  function cleanUpCompleted(id: ExecutionId): Promise<void> {
    const running = cleanups.get(id);
    if (running !== undefined) {
      return running;
    }
    const snapshot = loadSnapshotByExecution(db, id);
    if (snapshot === null || snapshot.execution.status !== 'complete') {
      return Promise.resolve();
    }
    const cleanup = cleanUpTicket({
      dryRun: false,
      processes: listProcesses,
      pullRequestCommits: pullRequestCommits(db, id),
      snapshot,
      wait: CLEANUP_WAIT,
    })
      .then((outcome) => {
        const line = outcomeLine(outcome);
        if (line !== null) {
          log(`Cleanup: ${line}`);
        }
        if (line === null || reported.get(id) === line) {
          return;
        }
        reported.set(id, line);
        if (needsAttention(outcome) && !stopped) {
          notify(
            attentionCard(
              snapshot,
              `${line} Resolve it, then run \`factory cleanup\` to clean up what is left.`,
            ),
          );
        }
      })
      .catch((error: unknown) => {
        log(
          `Cleanup of ${snapshot.ticket.displayRef} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        cleanups.delete(id);
      });
    cleanups.set(id, cleanup);
    return cleanup;
  }

  async function feedbackCommitted(
    snapshot: FactorySnapshot,
    request: FeedbackRequest,
    options: CommandOptions,
  ): Promise<Committed> {
    // A client retrying with the same Idempotency-Key gets the round it started,
    // before the ticket's new state or GitHub could refuse it.
    if (options.idempotencyKey !== null) {
      const revision = recordedRevision(db, dedupe(options, ''));
      if (revision !== null) {
        return {
          applied: { armRunId: null, response: describeExisting(snapshot), revision },
          displayRef: snapshot.ticket.displayRef,
          kind: 'committed',
        };
      }
    }
    const prepared = await prepareFeedbackRound({
      choice: { only: request.only, skip: request.skip },
      codeHost: codeHost(),
      note: request.note,
      pullRequestUrl: pullRequestUrlOf(db, snapshot.execution.id),
      snapshot,
    });
    if ('reason' in prepared) {
      return { kind: 'refused', message: prepared.message, reason: prepared.reason };
    }
    // Per execution: a rerun's round 1 is a new round, not a repeat.
    const key = `feedback:${snapshot.execution.id}:${prepared.round}`;
    const applied = apply(
      {
        feedback: prepared.feedback,
        idempotencyKey: key,
        kind: 'feedback',
        round: prepared.round,
        startHead: prepared.startHead,
        taskFile: prepared.taskFile,
        ticketId: snapshot.ticket.id,
        title: prepared.title,
      },
      dedupe(options, key),
      'command',
      options.actor,
    );
    // Written once the round is accepted, before any agent can read it: this
    // runs synchronously after the commit, and agents launch on drain.
    if (applied.response.kind !== 'rejected') {
      writeFeedbackTask(snapshot.execution.factoryDir, prepared);
      // Every Pi session, and /v1/events, sees what the round is about.
      const started = loadCurrentByFactoryKey(db, ticketKeyOf(snapshot));
      const posted = started === null ? '' : feedbackRoundCard(started);
      if (posted.length > 0) {
        notify(posted);
      }
      if (prepared.fetchFailure !== null) {
        notify(
          `${snapshot.ticket.displayRef}: ${prepared.fetchFailure}. The round's checks compare against the target as last fetched.`,
        );
      }
    }
    return committed(applied, snapshot.ticket.displayRef, 'invalid_state');
  }

  async function pendingFeedbackOf(snapshot: FactorySnapshot): Promise<PendingFeedbackOutcome> {
    const listed = await listFeedback({
      codeHost: codeHost(),
      pullRequestUrl: pullRequestUrlOf(db, snapshot.execution.id),
      snapshot,
    });
    return 'reason' in listed
      ? { kind: 'refused', message: listed.message, reason: listed.reason }
      : { ...listed, kind: 'listed', ticket: ticketKeyOf(snapshot) };
  }

  async function feedback(ref: string, parsed: FeedbackCommand): Promise<string> {
    const snapshot = requireSnapshot(ref);
    if (typeof snapshot === 'string') {
      return snapshot;
    }
    if (parsed.list) {
      const listed = await pendingFeedbackOf(snapshot);
      return listed.kind === 'refused' ? listed.message : pendingFeedbackCard(snapshot, listed);
    }
    const result = await feedbackCommitted(snapshot, parsed, piCommand);
    if (result.kind === 'refused') {
      return result.message;
    }
    await drain();
    return report(result.applied, ref);
  }

  async function start(source: TicketSource): Promise<string> {
    const result = await startCommitted(source, piCommand);
    if (result.kind === 'refused') {
      return result.message;
    }
    await drain();
    return startReply(result.applied, result.displayRef);
  }

  async function reply(ref: string, answer: string): Promise<string> {
    const snapshot = requireSnapshot(ref);
    if (typeof snapshot === 'string') {
      return snapshot;
    }
    const result = replyCommitted(snapshot, answer, piCommand);
    if (result.kind === 'refused') {
      return result.message;
    }
    await drain();
    return report(result.applied, ref);
  }

  async function retry(ref: string): Promise<string> {
    const snapshot = requireSnapshot(ref);
    if (typeof snapshot === 'string') {
      return snapshot;
    }
    const result = retryCommitted(snapshot, piCommand);
    if (result.kind === 'refused') {
      return result.message;
    }
    await drain();
    return report(result.applied, ref);
  }

  async function retryRebased(ref: string, dryRun: boolean): Promise<string> {
    const snapshot = requireSnapshot(ref);
    if (typeof snapshot === 'string') {
      return snapshot;
    }
    if (dryRun) {
      const preview = rebasedPreview(snapshot);
      return preview.kind === 'preview' ? preview.text : preview.message;
    }
    const result = rebasedCommitted(snapshot, piCommand);
    if (result.kind === 'refused') {
      return result.message;
    }
    await drain();
    return report(result.applied, ref);
  }

  async function complete(ref: string): Promise<string> {
    const snapshot = requireSnapshot(ref);
    if (typeof snapshot === 'string') {
      return snapshot;
    }
    const result = completeCommitted(snapshot, piCommand);
    if (result.kind === 'refused') {
      return result.message;
    }
    await drain();
    return formatStatus(result.applied.response);
  }

  // The API's commands name a ticket by its key and return once committed.
  function accepted(result: Committed): CommandOutcome {
    if (result.kind === 'refused') {
      return result;
    }
    void drain();
    const snapshot = loadCurrentByTicketKey(db, result.displayRef);
    return {
      kind: 'accepted',
      message: result.applied.response.message,
      revision: result.applied.revision ?? latestRevision(db),
      ticket: snapshot === null ? '' : ticketKeyOf(snapshot),
    };
  }

  function byKey(key: string, run: (snapshot: FactorySnapshot) => Committed): CommandOutcome {
    const snapshot = loadCurrentByFactoryKey(db, key);
    if (snapshot === null) {
      return { kind: 'refused', message: `No ticket ${key}.`, reason: 'ticket_not_found' };
    }
    return accepted(run(snapshot));
  }

  // A stop commits first, then closes the agent's pane. A pane that will not
  // close leaves a run the controller already ended; its exit is ignored.
  function stopCommitted(
    snapshot: FactorySnapshot,
    runId: RunId,
    options: CommandOptions,
  ): Committed {
    const run = snapshot.runs.find((item) => item.id === runId) ?? null;
    const applied = apply(
      { idempotencyKey: `stop:${runId}`, kind: 'stop', runId },
      dedupe(options, `stop:${runId}`),
      'command',
      options.actor,
    );
    if (applied.response.kind !== 'rejected' && run?.paneId != null) {
      void runtime.interrupt({ paneId: run.paneId, runId }).catch(() => undefined);
    }
    return committed(applied, snapshot.ticket.displayRef, 'invalid_state');
  }

  // A rerun fetches the ticket's source again and starts generation N+1 in
  // `<ticket dir>/r<N>`, on its own worktree and branch.
  async function rerunCommitted(
    snapshot: FactorySnapshot,
    options: CommandOptions,
  ): Promise<Committed> {
    const policy = policyFromConfig();
    if (typeof policy === 'string') {
      return { kind: 'refused', message: policy, reason: 'factory_config' };
    }
    const config = readFactoryConfig(input.factoryRoot);
    if (config.kind === 'error') {
      return { kind: 'refused', message: config.message, reason: 'factory_config' };
    }
    const { ticket } = snapshot;
    // A ticket from a tracker FACTORY.json no longer names cannot be fetched again.
    const trackerKind = trackerKindOf(config.config.tracker);
    if (
      ticket.sourceKind !== 'file' &&
      ticket.sourceKind !== 'text' &&
      ticket.sourceKind !== trackerKind
    ) {
      return {
        kind: 'refused',
        message: `${ticket.displayRef} came from ${ticket.sourceKind}; the configured tracker is ${trackerKind}, so it cannot be fetched again.`,
        reason: 'invalid_state',
      };
    }
    const source: TicketSource =
      ticket.sourceKind === 'text'
        ? { body: ticket.body, id: ticket.commandRef, kind: 'text' }
        : { kind: 'ref', value: ticket.commandRef };
    const resolved = await resolveTicket({
      codeRoot: input.codeRoot,
      factoryRoot: input.factoryRoot,
      fetchedAt: now(),
      source,
      tracker: createTracker(config.config.tracker, clients),
    });
    if (resolved.kind === 'error') {
      return {
        kind: 'refused',
        message: resolved.message,
        reason: resolved.reason ?? 'invalid_ref',
      };
    }
    const generation = snapshot.execution.generation + 1;
    const factoryDir = generationDir(ticketDirOf(snapshot.execution.factoryDir), generation);
    // No earlier generation wrote here; files at it are a forgotten run's.
    archiveLeftoverDir({
      dir: factoryDir,
      factoryRoot: input.factoryRoot,
      stamp: archiveStamp(now()),
    });
    mkdirSync(factoryDir, { recursive: true });
    const applied = apply(
      {
        kind: 'rerun',
        previous: snapshot.execution.id,
        start: {
          factoryVersion: factoryVersion(),
          generation,
          kind: 'start',
          policy,
          ticket: { ...resolved.ticket, factoryDir },
        },
      },
      dedupe(options, `rerun:${snapshot.execution.id}`),
      'command',
      options.actor,
    );
    return committed(applied, ticket.displayRef, 'invalid_state');
  }

  async function rerunTicket(ref: string): Promise<string> {
    const snapshot = requireSnapshot(ref);
    if (typeof snapshot === 'string') {
      return snapshot;
    }
    const result = await rerunCommitted(snapshot, piCommand);
    if (result.kind === 'refused') {
      return result.message;
    }
    await drain();
    return report(result.applied, ref);
  }

  // Cancel commits first, then closes every agent pane the ticket still had.
  function cancelCommitted(
    snapshot: FactorySnapshot,
    reason: string | null,
    options: CommandOptions,
  ): Committed {
    const panes = snapshot.runs.flatMap((run) =>
      run.status !== 'terminal' && run.paneId !== null
        ? [{ paneId: run.paneId, runId: run.id }]
        : [],
    );
    const by = options.actor === null ? null : (options.actor.onBehalfOf ?? options.actor.client);
    const applied = apply(
      {
        by,
        idempotencyKey: `cancel:${snapshot.execution.id}`,
        kind: 'cancel',
        reason,
        ticketId: snapshot.ticket.id,
      },
      dedupe(options, `cancel:${snapshot.execution.id}`),
      'command',
      options.actor,
    );
    if (applied.response.kind !== 'rejected') {
      for (const pane of panes) {
        void runtime.interrupt(pane).catch(() => undefined);
      }
    }
    return committed(applied, snapshot.ticket.displayRef, 'invalid_state');
  }

  async function cancelTicket(ref: string, reason: string | null): Promise<string> {
    const snapshot = requireSnapshot(ref);
    if (typeof snapshot === 'string') {
      return snapshot;
    }
    const result = cancelCommitted(snapshot, reason, piCommand);
    if (result.kind === 'refused') {
      return result.message;
    }
    await drain();
    return formatStatus(result.applied.response);
  }

  async function stopAgent(ref: string): Promise<string> {
    const snapshot = requireSnapshot(ref);
    if (typeof snapshot === 'string') {
      return snapshot;
    }
    const runId = runningRun(snapshot);
    if (runId === null) {
      return `No agent is running for ${ref}.`;
    }
    const result = stopCommitted(snapshot, runId, piCommand);
    if (result.kind === 'refused') {
      return result.message;
    }
    await drain();
    return report(result.applied, ref);
  }

  const commands: FactoryCommands = {
    cancel: (key, reason, options) =>
      byKey(key, (snapshot) => cancelCommitted(snapshot, reason, options)),
    complete: (key, options) => byKey(key, (snapshot) => completeCommitted(snapshot, options)),
    feedback: async (key, request, options) => {
      const snapshot = loadCurrentByFactoryKey(db, key);
      if (snapshot === null) {
        return { kind: 'refused', message: `No ticket ${key}.`, reason: 'ticket_not_found' };
      }
      return accepted(await feedbackCommitted(snapshot, request, options));
    },
    pendingFeedback: async (key) => {
      const snapshot = loadCurrentByFactoryKey(db, key);
      return snapshot === null
        ? { kind: 'refused', message: `No ticket ${key}.`, reason: 'ticket_not_found' }
        : pendingFeedbackOf(snapshot);
    },
    reply: (key, answer, options) =>
      byKey(key, (snapshot) => replyCommitted(snapshot, answer, options)),
    requestWorkValidation,
    rerun: async (key, options) => {
      const snapshot = loadCurrentByFactoryKey(db, key);
      if (snapshot === null) {
        return { kind: 'refused', message: `No ticket ${key}.`, reason: 'ticket_not_found' };
      }
      return accepted(await rerunCommitted(snapshot, options));
    },
    retry: (key, options) => byKey(key, (snapshot) => retryCommitted(snapshot, options)),
    retryRebased: (key, options) => byKey(key, (snapshot) => rebasedCommitted(snapshot, options)),
    retryRebasedPreview: (key) => {
      const snapshot = loadCurrentByFactoryKey(db, key);
      if (snapshot === null) {
        return { kind: 'refused', message: `No ticket ${key}.`, reason: 'ticket_not_found' };
      }
      const preview = rebasedPreview(snapshot);
      return preview.kind === 'preview'
        ? { kind: 'preview', preview: preview.text, ticket: snapshot.ticket.displayRef }
        : { kind: 'refused', message: preview.message, reason: 'invalid_state' };
    },
    start: async (source, options) => accepted(await startCommitted(source, options)),
    stopRun: (id, options) => {
      const snapshot = loadSnapshotByRun(db, runIdOf(id));
      if (snapshot === null) {
        return { kind: 'refused', message: `No run ${id}.`, reason: 'run_not_found' };
      }
      return accepted(stopCommitted(snapshot, runIdOf(id), options));
    },
  };

  function startReply(applied: ApplyResult, ref: string): string {
    if (applied.response.kind === 'rejected') {
      return applied.response.message;
    }
    if (!applied.response.message.startsWith('Preparing the worktree for')) {
      return applied.response.message;
    }
    const current = status(ref);
    if (current.includes('failed') || current.includes('/factory retry')) {
      return current;
    }
    return `Started ${ref}.`;
  }

  function report(applied: ApplyResult, ref: string): string {
    if (applied.response.kind === 'rejected') {
      return applied.response.message;
    }
    return status(ref);
  }

  function ticketDetail(ref: string | null): TicketDetail | string {
    return ticketDetailFor(db, ref);
  }

  function status(ref: string): string {
    return statusOf(db, ref);
  }

  return {
    backlog,
    command: async (args) => {
      const parsed = parseFactoryCommand(args);
      switch (parsed.kind) {
        case 'invalid':
          return parsed.message;
        case 'start':
          return start(parsed.source);
        case 'reply':
          return reply(parsed.ref, parsed.answer);
        case 'retry':
          return parsed.mode === 'retry'
            ? retry(parsed.ref)
            : retryRebased(parsed.ref, parsed.mode === 'rebased_dry_run');
        case 'complete':
          return complete(parsed.ref);
        case 'feedback':
          return feedback(parsed.ref, parsed);
        case 'stop':
          return stopAgent(parsed.ref);
        case 'cancel':
          return cancelTicket(parsed.ref, parsed.reason);
        case 'rerun':
          return rerunTicket(parsed.ref);
        case 'status':
          return status(parsed.ref);
        case 'agents':
          return 'Opened the factory agents view.';
        case 'ticket':
          return 'Opened the factory ticket view.';
        case 'update':
          return 'Updates go through the factory server: `factory update --check`.';
        default: {
          const _exhaustive: never = parsed;
          return _exhaustive;
        }
      }
    },
    commandProgress: commandBoard.get,
    commands,
    progress: () => progressOf(db),
    pullRequestChanged,
    recordPullRequestOutcome,
    recover,
    runningChildren: () => listRunningChildren(db),
    status,
    stop,
    syncPullRequests,
    ticketDetail,
  };
}

export function terminalSummary(
  snapshot: FactorySnapshot,
  runId: RunId,
  terminal: TerminalOutcome,
): string {
  const run = snapshot.runs.find((item) => item.id === runId) ?? null;
  if (run === null) {
    return '';
  }
  if (terminal.kind === 'caller_ping') {
    return terminal.question;
  }
  if (terminal.kind === 'subagent_done' && runStage(snapshot, run) === 'review') {
    const parsed = runReview(run, terminal.output);
    if (parsed.kind === 'valid') {
      return parsed.result.summary;
    }
    return run.resultError?.split('\n')[0] ?? 'The review result is malformed.';
  }
  const outcome = runOutcome(snapshot, run);
  if (outcome === 'correcting' || outcome === 'paused') {
    const queued = snapshot.actions.find((action) => correctsRun(action, runId));
    const failure = queued?.kind === 'prepare_input' ? queued.failures[0] : undefined;
    if (failure !== undefined && failure.length > 0) {
      return failure;
    }
    const reason = snapshot.execution.statusReason?.split('\n').find((line) => line.length > 0);
    if (reason !== undefined) {
      return reason.replace(/^- /, '');
    }
    return runStageMessage(snapshot, runId);
  }
  if (terminal.kind === 'subagent_done') {
    return firstSummaryLine(terminal.output);
  }
  return terminal.message;
}

function runStageMessage(snapshot: FactorySnapshot, runId: RunId): string {
  const run = snapshot.runs.find((item) => item.id === runId) ?? null;
  const stage =
    run === null
      ? null
      : (snapshot.sessions.find((session) => session.id === run.sessionId)?.stage ?? null);
  return `${stages[stage ?? 'plan'].label} validation failed.`;
}

export function factoryPaths(cwd: string): { codeRoot: string; factoryRoot: string } {
  const codeRoot = cwd;
  const override = process.env['FACTORY_ROOT'];
  return {
    codeRoot,
    factoryRoot:
      override !== undefined && path.isAbsolute(override) ? override : path.join(cwd, '.factory'),
  };
}
