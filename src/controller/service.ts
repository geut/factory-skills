import { mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { dispatchPending, watchRun } from "../actions/dispatch.ts";
import { readFactoryConfig } from "../config.ts";
import {
  randomIds,
  type ControllerEvent,
  type FactorySnapshot,
  type IdSource,
  type Policy,
  type RunId,
  type TerminalOutcome,
} from "../domain.ts";
import { sha256 } from "../hash.ts";
import { createPiHerdrRuntime } from "../runtime/pi-herdr.ts";
import { childReplyExcerpt } from "../runtime/session-activity.ts";
import type { FactorySubagentRuntime } from "../runtime/runtime.ts";
import { openStateDatabase } from "../state/database.ts";
import { githubCliClient, resolveTicket, type GithubClient, type TicketSource } from "../tickets.ts";
import { parseFactoryCommand } from "./parse.ts";
import {
  applyControllerEvent,
  formatStatus,
  listActiveRuns,
  listRunningChildren,
  loadCurrentByTicketKey,
  loadSnapshotByRun,
  type ApplyResult,
  type RunningChildRow,
} from "./store.ts";

export type FactoryService = {
  command: (args: string) => Promise<string>;
  recover: () => Promise<void>;
  runningChildren: () => Array<RunningChildRow>;
  status: (ref: string) => string;
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
  let dispatching = false;

  const apply = (event: ControllerEvent, dedupeKey: string, source: "command" | "runtime" | "controller"): ApplyResult =>
    applyControllerEvent(db, { dedupeKey, event, ids, now: now(), source });

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
    if (dispatching) {return;}
    dispatching = true;
    try {
      await dispatchPending({ arm, db, factoryRoot: input.factoryRoot, ids, notify, now, runtime });
    } finally {
      dispatching = false;
      onActivity();
    }
  }

  async function onTerminal(runId: RunId, terminal: TerminalOutcome): Promise<void> {
    apply({ kind: "runtime_terminal", runId, terminal }, `runtime:${runId}:terminal`, "runtime");
    await drain();
    const snapshot = loadSnapshotByRun(db, runId);
    if (snapshot !== null) {
      const statusText = formatStatus({
        displayRef: snapshot.ticket.displayRef,
        kind: "status",
        message: snapshot.execution.message ?? `${snapshot.execution.stage}/${snapshot.execution.status}`,
        question: snapshot.attention.find((item) => item.status === "open" || item.status === "answered" || item.status === "resuming")?.question ?? null,
        retryHint: snapshot.execution.retryable ? `Retry with /factory retry ${snapshot.ticket.commandRef}.` : null,
        stage: snapshot.execution.stage,
        status: snapshot.execution.status,
      });
      const reply = terminal.kind === "subagent_done" ? childReplyExcerpt(terminal.output) : null;
      notify(reply === null ? statusText : `${statusText}\n${reply}`);
    }
  }

  async function recover(): Promise<void> {
    const active = listActiveRuns(db);
    const observations = await runtime.reconcile(
      active.map((run) => ({ paneId: run.paneId, runId: run.runId, sessionFile: run.sessionFile })),
    );
    for (const item of observations) {
      const label = item.observation.kind === "terminal" ? item.observation.terminal.kind : item.observation.kind;
      const applied = apply(
        { kind: "reconciled", observation: item.observation, runId: item.runId },
        `reconcile:${item.runId}:${label}`,
        "controller",
      );
      if (applied.armRunId !== null) {arm(applied.armRunId);}
    }
    await drain();
    for (const run of listActiveRuns(db)) {
      if (run.paneId !== null) {arm(run.runId);}
    }
  }

  function requireSnapshot(ref: string): FactorySnapshot | string {
    const snapshot = loadCurrentByTicketKey(db, ref);
    if (snapshot === null) {return `No factory execution matches ${ref}.`;}
    return snapshot;
  }

  function policyFromConfig(): Policy | string {
    const config = readFactoryConfig(input.factoryRoot);
    if (config.kind === "error") {return config.message;}
    return {
      codeRoot: input.codeRoot,
      limits: config.config.limits,
      models: config.config.models,
    };
  }

  async function start(source: TicketSource): Promise<string> {
    const policy = policyFromConfig();
    if (typeof policy === "string") {return policy;}
    const config = readFactoryConfig(input.factoryRoot);
    if (config.kind === "error") {return config.message;}
    const resolved = resolveTicket({
      codeRoot: input.codeRoot,
      config: config.config,
      factoryRoot: input.factoryRoot,
      fetchedAt: now(),
      github,
      source,
    });
    if (resolved.kind === "error") {return resolved.message;}
    mkdirSync(resolved.ticket.factoryDir, { recursive: true });
    const applied = apply(
      { kind: "start", policy, ticket: resolved.ticket },
      `command:start:${resolved.ticket.id}`,
      "command",
    );
    await drain();
    return report(applied, resolved.ticket.displayRef);
  }

  async function reply(ref: string, answer: string): Promise<string> {
    const snapshot = requireSnapshot(ref);
    if (typeof snapshot === "string") {return snapshot;}
    const applied = apply(
      { answer, idempotencyKey: `reply:${snapshot.ticket.id}:${sha256(answer)}`, kind: "reply", ticketId: snapshot.ticket.id },
      `reply:${snapshot.ticket.id}:${sha256(answer)}`,
      "command",
    );
    await drain();
    return report(applied, ref);
  }

  async function retry(ref: string): Promise<string> {
    const snapshot = requireSnapshot(ref);
    if (typeof snapshot === "string") {return snapshot;}
    const applied = apply(
      { idempotencyKey: `retry:${snapshot.execution.version}`, kind: "retry", ticketId: snapshot.ticket.id },
      `retry:${snapshot.ticket.id}:${snapshot.execution.version}`,
      "command",
    );
    await drain();
    return report(applied, ref);
  }

  function report(applied: ApplyResult, ref: string): string {
    if (applied.response.kind === "rejected") {return applied.response.message;}
    const current = status(ref);
    const started = formatStatus(applied.response);
    return started === current ? started : `${started}\n${current}`;
  }

  function status(ref: string): string {
    const snapshot = requireSnapshot(ref);
    if (typeof snapshot === "string") {return snapshot;}
    return formatStatus({
      displayRef: snapshot.ticket.displayRef,
      kind: "status",
      message: snapshot.execution.message ?? `${snapshot.execution.stage}/${snapshot.execution.status}`,
      question:
        snapshot.attention.find((item) => item.status === "open" || item.status === "answered" || item.status === "resuming")
          ?.question ?? null,
      retryHint: snapshot.execution.retryable ? `Retry with /factory retry ${snapshot.ticket.commandRef}.` : null,
      stage: snapshot.execution.stage,
      status: snapshot.execution.status,
    });
  }

  return {
    command: async (args) => {
      const parsed = parseFactoryCommand(args);
      switch (parsed.kind) {
        case "invalid":
          return parsed.message;
        case "start":
          return start(parsed.source);
        case "reply":
          return reply(parsed.ref, parsed.answer);
        case "retry":
          return retry(parsed.ref);
        case "status":
          return status(parsed.ref);
        case "agents":
          return "Opened the factory agents view.";
        default: {
          const _exhaustive: never = parsed;
          return _exhaustive;
        }
      }
    },
    recover,
    runningChildren: () => listRunningChildren(db),
    status,
  };
}

export function factoryPaths(cwd: string): { codeRoot: string; factoryRoot: string } {
  const codeRoot = cwd;
  const override = process.env["FACTORY_ROOT"];
  return { codeRoot, factoryRoot: override !== undefined && path.isAbsolute(override) ? override : path.join(cwd, ".factory") };
}
