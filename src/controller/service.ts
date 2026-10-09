import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { dispatchPending, watchRun } from '../actions/dispatch.ts';
import { readFactoryConfig } from '../config.ts';
import {
  randomIds,
  type ControllerEvent,
  type FactorySnapshot,
  type IdSource,
  type Policy,
  type RunId,
  type TerminalOutcome,
} from '../domain.ts';
import { sha256 } from '../hash.ts';
import { createPiHerdrRuntime } from '../runtime/pi-herdr.ts';
import type { FactorySubagentRuntime } from '../runtime/runtime.ts';
import { openStateDatabase } from '../state/database.ts';
import {
  githubCliClient,
  resolveTicket,
  type GithubClient,
  type TicketSource,
} from '../tickets.ts';
import { parseReview } from '../validation/review.ts';
import { parseFactoryCommand } from './parse.ts';
import {
  finishedRunCard,
  firstSummaryLine,
  runListLabel,
  runOutcome,
  runsInStartOrder,
  runStage,
  type RunOutcome,
} from './run-card.ts';
import {
  applyControllerEvent,
  formatStatus,
  listActiveRuns,
  listCurrentTicketRefs,
  listRunningChildren,
  loadCurrentByTicketKey,
  loadSnapshotByRun,
  requeueOrphanedValidations,
  type ApplyResult,
  type RunningChildRow,
} from './store.ts';

export type TicketRunRow = {
  label: string;
  outcome: RunOutcome;
  runId: RunId;
  sessionFile: string | null;
};

export type TicketDetail = {
  displayRef: string;
  runs: Array<TicketRunRow>;
};

export type FactoryService = {
  command: (args: string) => Promise<string>;
  recover: () => Promise<void>;
  runningChildren: () => Array<RunningChildRow>;
  status: (ref: string) => string;
  ticketDetail: (ref: string | null) => TicketDetail | string;
};

export function createFactoryService(input: {
  codeRoot: string;
  db?: DatabaseSync;
  factoryRoot: string;
  github?: GithubClient;
  ids?: IdSource;
  notify?: (message: string) => void;
  now?: () => string;
  onActivity?: () => void;
  runtime?: FactorySubagentRuntime;
}): FactoryService {
  const db = input.db ?? openStateDatabase(input.factoryRoot, { create: true });
  const runtime = input.runtime ?? createPiHerdrRuntime();
  const github = input.github ?? githubCliClient();
  const notify = input.notify ?? (() => undefined);
  const onActivity = input.onActivity ?? (() => undefined);
  const now = input.now ?? (() => new Date().toISOString());
  const ids = input.ids ?? randomIds();
  const liveValidations = new Set<string>();
  let dispatching = false;
  let rerun = false;

  const apply = (
    event: ControllerEvent,
    dedupeKey: string,
    source: 'command' | 'runtime' | 'controller',
  ): ApplyResult => applyControllerEvent(db, { dedupeKey, event, ids, now: now(), source });

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

  async function drain(): Promise<void> {
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
          ids,
          liveValidations,
          notify,
          now,
          runtime,
        });
      } while (rerun);
    } finally {
      dispatching = false;
      if (rerun) {
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
    await drain();
    for (const run of listActiveRuns(db)) {
      if (run.paneId !== null) {
        arm(run.runId);
      }
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
      validation: config.config.validation,
    };
  }

  async function start(source: TicketSource): Promise<string> {
    const policy = policyFromConfig();
    if (typeof policy === 'string') {
      return policy;
    }
    const config = readFactoryConfig(input.factoryRoot);
    if (config.kind === 'error') {
      return config.message;
    }
    const resolved = resolveTicket({
      codeRoot: input.codeRoot,
      config: config.config,
      factoryRoot: input.factoryRoot,
      fetchedAt: now(),
      github,
      source,
    });
    if (resolved.kind === 'error') {
      return resolved.message;
    }
    mkdirSync(resolved.ticket.factoryDir, { recursive: true });
    const applied = apply(
      { kind: 'start', policy, ticket: resolved.ticket },
      `command:start:${resolved.ticket.id}`,
      'command',
    );
    await drain();
    return startReply(applied, resolved.ticket.displayRef);
  }

  async function reply(ref: string, answer: string): Promise<string> {
    const snapshot = requireSnapshot(ref);
    if (typeof snapshot === 'string') {
      return snapshot;
    }
    const applied = apply(
      {
        answer,
        idempotencyKey: `reply:${snapshot.ticket.id}:${sha256(answer)}`,
        kind: 'reply',
        ticketId: snapshot.ticket.id,
      },
      `reply:${snapshot.ticket.id}:${sha256(answer)}`,
      'command',
    );
    await drain();
    return report(applied, ref);
  }

  async function retry(ref: string): Promise<string> {
    const snapshot = requireSnapshot(ref);
    if (typeof snapshot === 'string') {
      return snapshot;
    }
    const applied = apply(
      {
        idempotencyKey: `retry:${snapshot.execution.version}`,
        kind: 'retry',
        ticketId: snapshot.ticket.id,
      },
      `retry:${snapshot.ticket.id}:${snapshot.execution.version}`,
      'command',
    );
    await drain();
    return report(applied, ref);
  }

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
    let key = ref ?? '';
    if (key.length === 0) {
      const refs = listCurrentTicketRefs(db);
      if (refs.length === 0) {
        return 'No factory ticket is in progress.';
      }
      if (refs.length > 1) {
        return `Name a ticket: ${refs.join(', ')}`;
      }
      key = refs[0] ?? '';
    }
    const snapshot = loadCurrentByTicketKey(db, key);
    if (snapshot === null) {
      return `No factory execution matches ${key}.`;
    }
    const runs = runsInStartOrder(snapshot.runs);
    return {
      displayRef: snapshot.ticket.displayRef,
      runs: runs.map((run) => {
        const session = snapshot.sessions.find((item) => item.id === run.sessionId) ?? null;
        return {
          label: runListLabel(snapshot, run),
          outcome: runOutcome(snapshot, run),
          runId: run.id,
          sessionFile: session?.sessionFile ?? null,
        };
      }),
    };
  }

  function status(ref: string): string {
    const snapshot = requireSnapshot(ref);
    if (typeof snapshot === 'string') {
      return snapshot;
    }
    return formatStatus({
      displayRef: snapshot.ticket.displayRef,
      kind: 'status',
      message:
        snapshot.execution.message ?? `${snapshot.execution.stage}/${snapshot.execution.status}`,
      question:
        snapshot.attention.find(
          (item) =>
            item.status === 'open' || item.status === 'answered' || item.status === 'resuming',
        )?.question ?? null,
      retryHint: snapshot.execution.retryable
        ? `Retry with /factory retry ${snapshot.ticket.commandRef}.`
        : null,
      stage: snapshot.execution.stage,
      status: snapshot.execution.status,
    });
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
    recover,
    runningChildren: () => listRunningChildren(db),
    status,
    ticketDetail,
  };
}

function terminalSummary(
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
      return `${parsed.result.verdict}: ${parsed.result.summary}`;
    }
    return run.resultError?.split('\n')[0] ?? 'The review result is malformed.';
  }
  if (runOutcome(snapshot, run) === 'checks failed') {
    const prefix = `work-input:${runId}:correction:`;
    const queued = snapshot.actions.find(
      (action) => action.kind === 'prepare_work_input' && action.idempotencyKey.startsWith(prefix),
    );
    const failure = queued?.kind === 'prepare_work_input' ? queued.failures[0] : undefined;
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
  return stage === 'work' ? 'Work validation failed.' : 'Plan validation failed.';
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
