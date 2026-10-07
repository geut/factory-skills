import { mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  applyControllerEvent,
  claimNextAction,
  finishLeasedAction,
  loadSnapshotByExecution,
  loadSnapshotByRun,
  type ApplyResult,
} from "../controller/store.ts";
import type { ActionRecord, ControllerEvent, FactorySnapshot, IdSource, RunId, RunRecord, SessionRecord, TerminalOutcome } from "../domain.ts";
import { childToolList, paneLabel } from "../runtime/policy.ts";
import type { FactorySubagentRuntime, LaunchSpec } from "../runtime/runtime.ts";
import { inspectPlanDir, planChecks } from "../validation/plan.ts";
import { writePlanValidation } from "../validation/record.ts";
import { prepareWorktree } from "./worktree.ts";

function messageOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return "action failed";
}

function sessionForRun(snapshot: FactorySnapshot, run: RunRecord): SessionRecord | null {
  return snapshot.sessions.find((session) => session.id === run.sessionId) ?? null;
}

function paneName(snapshot: FactorySnapshot, session: SessionRecord): string {
  return paneLabel(session.stage, snapshot.ticket.displayRef, session.taskId);
}

export async function dispatchPending(input: {
  arm: (runId: RunId) => void;
  db: DatabaseSync;
  factoryRoot: string;
  ids: IdSource;
  notify: (message: string) => void;
  now: () => string;
  runtime: FactorySubagentRuntime;
}): Promise<void> {
  for (;;) {
    const claimed = claimNextAction(input.db, input.now());
    if (claimed === null) {return;}
    const snapshot = loadSnapshotByExecution(input.db, claimed.executionId);
    if (snapshot === null) {
      finishLeasedAction(input.db, claimed.action.id, input.now(), "failed", "execution missing");
      continue;
    }
    try {
      const armed = await perform(input, claimed.action, snapshot);
      if (armed !== null) {input.arm(armed);}
    } catch (error: unknown) {
      finishLeasedAction(input.db, claimed.action.id, input.now(), "failed", messageOf(error));
    }
  }
}

async function perform(
  input: {
    db: DatabaseSync;
    factoryRoot: string;
    ids: IdSource;
    notify: (message: string) => void;
    now: () => string;
    runtime: FactorySubagentRuntime;
  },
  action: ActionRecord,
  snapshot: FactorySnapshot,
): Promise<RunId | null> {
  switch (action.kind) {
    case "launch_run":
    case "resume_run":
      return launch(input, action, snapshot);
    case "validate_run":
      return validate(input, action, snapshot);
    case "prepare_worktree":
      return worktree(input, action, snapshot);
    case "notify_attention":
      input.notify(action.message);
      finishLeasedAction(input.db, action.id, input.now(), "succeeded", null);
      return null;
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

function apply(
  input: { db: DatabaseSync; ids: IdSource; now: () => string; },
  event: ControllerEvent,
  dedupeKey: string,
  source: "action" | "validator",
  prepare?: (db: DatabaseSync) => void,
): ApplyResult {
  const base = { dedupeKey, event, ids: input.ids, now: input.now(), source };
  if (prepare === undefined) {return applyControllerEvent(input.db, base);}
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
  action: Extract<ActionRecord, { kind: "launch_run" | "resume_run" }>,
  snapshot: FactorySnapshot,
): Promise<RunId | null> {
  const run = snapshot.runs.find((item) => item.id === action.runId) ?? null;
  if (run === null) {throw new Error("launch action is missing its run");}
  const session = sessionForRun(snapshot, run);
  if (session === null) {throw new Error("launch action is missing its session");}
  if (session.stage !== "plan" && session.stage !== "work") {throw new Error(`cannot launch stage ${session.stage} in this slice`);}
  mkdirSync(path.dirname(snapshot.execution.factoryDir), { recursive: true });
  mkdirSync(snapshot.execution.factoryDir, { recursive: true });
  const sessionFile = session.sessionFile ?? path.join(input.factoryRoot, "sessions", `${session.id}.jsonl`);
  const spec: LaunchSpec = {
    cwd: action.cwd,
    mode: action.kind === "resume_run" ? "resume" : action.mode,
    model: session.model,
    paneName: paneName(snapshot, session),
    prompt: action.prompt,
    runId: run.id,
    sessionFile,
    sessionId: session.id,
    stage: session.stage,
    thinking: session.thinking,
    tools: childToolList(session.stage),
  };
  try {
    const started = spec.mode === "resume" ? await input.runtime.resume(spec) : await input.runtime.launch(spec);
    const applied = apply(
      input,
      {
        actionId: action.id,
        kind: "run_started",
        paneId: started.paneId,
        paneName: started.paneName,
        piSessionId: started.piSessionId,
        runId: run.id,
        sessionFile: started.sessionFile,
      },
      `run-started:${run.id}`,
      "action",
    );
    return applied.armRunId;
  } catch (error: unknown) {
    apply(
      input,
      { actionId: action.id, kind: "launch_failed", message: messageOf(error), runId: run.id },
      `launch-failed:${action.id}`,
      "action",
    );
    return null;
  }
}

function validate(
  input: { db: DatabaseSync; ids: IdSource; now: () => string; },
  action: Extract<ActionRecord, { kind: "validate_run" }>,
  snapshot: FactorySnapshot,
): Promise<RunId | null> {
  const run = snapshot.runs.find((item) => item.id === action.runId) ?? null;
  if (run === null || run.resultJson === null || run.resultHash === null) {throw new Error("validate action is missing a plan result");}
  const outcome = inspectPlanDir({ factoryDir: snapshot.execution.factoryDir });
  const checks = planChecks(outcome);
  const resultHash = run.resultHash;
  const executionId = snapshot.execution.id;
  const runId = run.id;
  const validationId = input.ids.event();
  const now = input.now();
  apply(
    input,
    { actionId: action.id, kind: "validation_finished", outcome, runId },
    `validation:${run.id}:${resultHash}:${outcome.kind}`,
    "validator",
    (db) => {
      writePlanValidation(db, {
        checks,
        executionId,
        id: validationId,
        now,
        passed: outcome.kind === "passed",
        resultHash,
        runId,
      });
    },
  );
  return Promise.resolve(null);
}

function worktree(
  input: { db: DatabaseSync; ids: IdSource; now: () => string; },
  action: Extract<ActionRecord, { kind: "prepare_worktree" }>,
  snapshot: FactorySnapshot,
): Promise<RunId | null> {
  const factoryRoot = path.dirname(path.dirname(snapshot.execution.factoryDir));
  const prepared = prepareWorktree({
    codeRoot: snapshot.execution.policy.codeRoot,
    factoryRoot,
    slug: action.slug,
  });
  if (prepared.kind === "failed") {
    apply(
      input,
      { actionId: action.id, kind: "worktree_failed", message: prepared.message },
      `worktree-failed:${action.id}`,
      "action",
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
      kind: "worktree_ready",
      worktreePath: prepared.path,
    },
    `worktree-ready:${action.id}`,
    "action",
  );
  return Promise.resolve(null);
}

export function watchRun(input: { db: DatabaseSync; onTerminal: (runId: RunId, terminal: TerminalOutcome) => void; runId: RunId; runtime: FactorySubagentRuntime; }): void {
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
