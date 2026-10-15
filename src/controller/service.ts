import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { dispatchPending, watchRun } from '../actions/dispatch.ts';
import { pullRequestLookup } from '../actions/wrapup.ts';
import { pullRequestsAllowed, readFactoryConfig } from '../config.ts';
import {
  randomIds,
  ticketId as ticketIdOf,
  type Actor,
  type ControllerEvent,
  type FactorySnapshot,
  type IdSource,
  type Policy,
  type RunId,
  type TerminalOutcome,
} from '../domain.ts';
import { sha256 } from '../hash.ts';
import {
  createGithubCodeHost,
  type CodeHost,
  type PullRequestOutcome,
} from '../ports/code-host.ts';
import { createGithubTracker, githubCliClient, type GithubClient } from '../ports/github.ts';
import { createPiHerdrRuntime } from '../runtime/pi-herdr.ts';
import type { FactorySubagentRuntime } from '../runtime/runtime.ts';
import { stages } from '../stages/index.ts';
import { parseReview } from '../stages/review/parse.ts';
import { openStateDatabase } from '../state/database.ts';
import { resolveTicket, type TicketSource } from '../tickets.ts';
import type { PullRequestLookup } from '../validation/wrapup.ts';
import { factoryVersion } from '../version.ts';
import { markPullRequestSynced, recordCommit, recordPullRequest, recordReview } from './facts.ts';
import { parseFactoryCommand } from './parse.ts';
import type { TicketProgress } from './progress.ts';
import {
  finishedRunCard,
  firstSummaryLine,
  runOutcome,
  correctsRun,
  runStage,
} from './run-card.ts';
import {
  applyControllerEvent,
  formatStatus,
  listActiveRuns,
  latestRevision,
  listRunningChildren,
  loadCurrentByFactoryKey,
  loadCurrentByTicketKey,
  loadSnapshotByRun,
  recordCard,
  requeueOrphanedPanes,
  requeueOrphanedValidations,
  ticketKeyOf,
  type ApplyResult,
  type RunningChildRow,
} from './store.ts';
import { progressOf, statusOf, ticketDetailFor, type TicketDetail } from './view.ts';

export type { TicketDetail, TicketRunRow } from './view.ts';

// Why the API refused a command, before anything changed.
export type CommandRefusal =
  | 'factory_config'
  | 'invalid_ref'
  | 'invalid_state'
  | 'not_waiting_for_reply'
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
  complete: (key: string, options: CommandOptions) => CommandOutcome;
  reply: (key: string, answer: string, options: CommandOptions) => CommandOutcome;
  retry: (key: string, options: CommandOptions) => CommandOutcome;
  start: (source: TicketSource, options: CommandOptions) => CommandOutcome;
};

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

export type FactoryService = {
  command: (args: string) => Promise<string>;
  commands: FactoryCommands;
  // Progress of every current ticket that is not finished.
  progress: () => Array<TicketProgress>;
  recover: () => Promise<void>;
  runningChildren: () => Array<RunningChildRow>;
  status: (ref: string) => string;
  // Stops dispatching and waits for the action in progress. Agent panes keep
  // running; the next host adopts them with recover().
  stop: () => Promise<void>;
  // Records what the code host says about a ticket's pull request, then
  // finishes the ticket on a merge or a close.
  recordPullRequestOutcome: (executionId: string, outcome: PullRequestOutcome) => void;
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
  notify?: (message: string) => void;
  now?: () => string;
  onActivity?: () => void;
  runtime?: FactorySubagentRuntime;
}): FactoryService {
  const db = input.db ?? openStateDatabase(input.factoryRoot, { create: true });
  const runtime = input.runtime ?? createPiHerdrRuntime();
  const github = input.github ?? githubCliClient();
  const post = input.notify ?? (() => undefined);
  // Every card is also kept as an event, for clients that read the history.
  const notify = (message: string): void => {
    recordCard(db, message, now());
    post(message);
  };
  const onActivity = input.onActivity ?? (() => undefined);
  const now = input.now ?? (() => new Date().toISOString());
  const ids = input.ids ?? randomIds();
  const liveValidations = new Set<string>();
  let dispatching = false;
  let rerun = false;
  let stopped = false;

  const apply = (
    event: ControllerEvent,
    dedupeKey: string,
    source: 'command' | 'runtime' | 'controller',
    actor: Actor | null = null,
  ): ApplyResult => applyControllerEvent(db, { actor, dedupeKey, event, ids, now: now(), source });

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
            ? host.pullRequest(recorded)
            : branch !== null
              ? host.findPullRequest(branch)
              : null;
        if (pullRequest === null) {
          continue;
        }
        recordPullRequestOutcome(executionId, host.pullRequestOutcome(pullRequest));
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
          afterValidation: () => {
            void drain();
          },
          arm,
          db,
          factoryRoot: input.factoryRoot,
          findPullRequest: input.findPullRequest ?? findPullRequest,
          ids,
          leaseOwner: input.leaseOwner ?? 'factory-controller',
          liveValidations,
          notify,
          now,
          runtime,
          stopped: () => stopped,
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
      return action.status === 'leased' && liveValidations.has(action.id);
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
    requeueOrphanedValidations(db, now(), liveValidations);
    requeueOrphanedPanes(db, now());
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
      codeRoot: input.codeRoot,
      labels: config.config.labels,
      limits: config.config.limits,
      models: config.config.models,
      pullRequests: pullRequestsAllowed(config.config),
      stages: config.config.stages,
      validation: config.config.validation,
    };
  }

  // Each command's synchronous part: it resolves, applies, and commits, and
  // leaves dispatch to the caller. Pi waits for the dispatch; the API answers
  // as soon as the command is committed.
  function startCommitted(source: TicketSource, options: CommandOptions): Committed {
    const policy = policyFromConfig();
    if (typeof policy === 'string') {
      return { kind: 'refused', message: policy, reason: 'factory_config' };
    }
    const config = readFactoryConfig(input.factoryRoot);
    if (config.kind === 'error') {
      return { kind: 'refused', message: config.message, reason: 'factory_config' };
    }
    const resolved = resolveTicket({
      codeRoot: input.codeRoot,
      factoryRoot: input.factoryRoot,
      fetchedAt: now(),
      source,
      tracker: createGithubTracker(config.config.tracker, github),
    });
    if (resolved.kind === 'error') {
      return {
        kind: 'refused',
        message: resolved.message,
        reason: resolved.reason ?? 'invalid_ref',
      };
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
    const key = dedupe(options, `reply:${snapshot.ticket.id}:${sha256(answer)}`);
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

  function retryCommitted(snapshot: FactorySnapshot, options: CommandOptions): Committed {
    const applied = apply(
      {
        idempotencyKey: `retry:${snapshot.execution.version}`,
        kind: 'retry',
        ticketId: snapshot.ticket.id,
      },
      dedupe(options, `retry:${snapshot.ticket.id}:${snapshot.execution.version}`),
      'command',
      options.actor,
    );
    return committed(applied, snapshot.ticket.displayRef, 'invalid_state');
  }

  // The human marks a ready-for-handoff ticket done. Repeating it is a no-op.
  function completeCommitted(snapshot: FactorySnapshot, options: CommandOptions): Committed {
    const applied = apply(
      {
        idempotencyKey: `complete:${snapshot.ticket.id}`,
        kind: 'complete',
        ticketId: snapshot.ticket.id,
      },
      dedupe(options, `complete:${snapshot.ticket.id}:${snapshot.execution.version}`),
      'command',
      options.actor,
    );
    return committed(applied, snapshot.ticket.displayRef, 'invalid_state');
  }

  async function start(source: TicketSource): Promise<string> {
    const result = startCommitted(source, piCommand);
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

  const commands: FactoryCommands = {
    complete: (key, options) => byKey(key, (snapshot) => completeCommitted(snapshot, options)),
    reply: (key, answer, options) =>
      byKey(key, (snapshot) => replyCommitted(snapshot, answer, options)),
    retry: (key, options) => byKey(key, (snapshot) => retryCommitted(snapshot, options)),
    start: (source, options) => accepted(startCommitted(source, options)),
  };

  function startReply(applied: ApplyResult, ref: string): string {
    if (applied.response.kind === 'rejected') {
      return applied.response.message;
    }
    if (!applied.response.message.startsWith('Planning queued')) {
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
          return retry(parsed.ref);
        case 'complete':
          return complete(parsed.ref);
        case 'status':
          return status(parsed.ref);
        case 'agents':
          return 'Opened the factory agents view.';
        case 'ticket':
          return 'Opened the factory ticket view.';
        default: {
          const _exhaustive: never = parsed;
          return _exhaustive;
        }
      }
    },
    commands,
    progress: () => progressOf(db),
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
    const parsed = parseReview(terminal.output, run.semanticRound);
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
