import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  applyControllerEvent,
  executionIsCurrent,
  finishLeasedAction,
  passedWorkChecks,
} from '../controller/store.ts';
import { usageTable } from '../controller/usage.ts';
import type { ActionRecord, ControllerEvent, FactorySnapshot, IdSource, RunId } from '../domain.ts';
import type { FactorySubagentRuntime } from '../runtime/runtime.ts';
import { writeValidation } from '../validation/record.ts';
import { collectWorkDiff } from '../validation/work.ts';
import {
  captureWrapupState,
  parseBaseline,
  validateWrapup,
  type PullRequestLookup,
} from '../validation/wrapup.ts';
import { inspectWrapupInput } from './wrapup-input.ts';

type Context = { db: DatabaseSync; ids: IdSource; now: () => string };

function apply(
  input: Context,
  event: ControllerEvent,
  dedupeKey: string,
  source: 'action' | 'validator',
  prepare?: (db: DatabaseSync) => void,
): void {
  const base = { dedupeKey, event, ids: input.ids, now: input.now(), source };
  applyControllerEvent(input.db, prepare === undefined ? base : { ...base, prepare });
}

function factoryRootOf(snapshot: FactorySnapshot): string {
  return path.dirname(path.dirname(snapshot.execution.factoryDir));
}

function wrapupRuns(snapshot: FactorySnapshot) {
  const session = snapshot.sessions.find((item) => item.stage === 'wrapup') ?? null;
  return session === null ? [] : snapshot.runs.filter((run) => run.sessionId === session.id);
}

// Checks the wrap-up input outside the controller transaction, then hands
// the reducer what it needs to create the run atomically.
export function prepareWrapupInput(
  input: Context,
  action: Extract<ActionRecord, { kind: 'prepare_wrapup_input' }>,
  snapshot: FactorySnapshot,
): Promise<RunId | null> {
  const factoryRoot = factoryRootOf(snapshot);
  const inspection = inspectWrapupInput({
    activeChild: snapshot.runs.some((run) => run.status !== 'terminal'),
    executionCurrent: executionIsCurrent(input.db, snapshot.execution.id),
    factoryRoot,
    snapshot,
  });
  const fail = (message: string) =>
    apply(
      input,
      { actionId: action.id, kind: 'wrapup_input_failed', message },
      `wrapup-input-failed:${action.id}`,
      'action',
    );
  if (inspection.kind === 'failed') {
    fail(inspection.failures.join('\n'));
    return Promise.resolve(null);
  }
  // Corrections and replies compare against the state before the first run.
  let baseline = wrapupRuns(snapshot).find((run) => run.baseline !== null)?.baseline ?? null;
  if (baseline === null) {
    const { worktreeBaseSha, worktreeBranch, worktreePath } = snapshot.execution;
    if (worktreeBaseSha === null || worktreeBranch === null || worktreePath === null) {
      fail('The worktree is not ready for this execution.');
      return Promise.resolve(null);
    }
    try {
      baseline = JSON.stringify(
        captureWrapupState({
          baseBranch: snapshot.execution.worktreeBaseBranch,
          baseSha: worktreeBaseSha,
          branch: worktreeBranch,
          codeRoot: snapshot.execution.policy.codeRoot,
          factoryRoot,
          worktree: worktreePath,
        }),
      );
    } catch (error: unknown) {
      fail(`Cannot read the worktree: ${error instanceof Error ? error.message : String(error)}`);
      return Promise.resolve(null);
    }
  }
  apply(
    input,
    {
      actionId: action.id,
      adrPath: inspection.adrPath,
      baseline,
      contextPath: inspection.contextPath,
      kind: 'wrapup_input_ready',
      usage: usageTable(input.db, snapshot.execution.id, { includeWrapup: false }),
      verification: passedWorkChecks(input.db, snapshot.execution.id),
    },
    `wrapup-input-ready:${action.id}`,
    'action',
  );
  return Promise.resolve(null);
}

// `gh pr view` for the URL in the handoff. A missing pull request is a
// validation failure; any other gh error is an infrastructure error.
export const ghPullRequest: PullRequestLookup = (url) => {
  const result = spawnSync('gh', ['pr', 'view', url, '--json', 'headRefName,state'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || 'gh failed').trim();
    if (/no pull requests? found|could not resolve|not found/i.test(message)) {
      return { missing: true };
    }
    throw new Error(message);
  }
  const parsed: unknown = JSON.parse(result.stdout);
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'headRefName' in parsed &&
    typeof parsed.headRefName === 'string' &&
    'state' in parsed &&
    typeof parsed.state === 'string'
  ) {
    return { headRefName: parsed.headRefName, state: parsed.state };
  }
  throw new Error('gh pr view returned an unexpected shape');
};

export function validateWrapupRun(
  input: Context & { findPullRequest: PullRequestLookup },
  action: Extract<ActionRecord, { kind: 'validate_run' }>,
  snapshot: FactorySnapshot,
): Promise<RunId | null> {
  const run = snapshot.runs.find((item) => item.id === action.runId) ?? null;
  if (run === null) {
    throw new Error('validate action is missing its wrap-up run');
  }
  const baselineText =
    wrapupRuns(snapshot).find((item) => item.baseline !== null)?.baseline ?? null;
  const baseline = baselineText === null ? null : parseBaseline(baselineText);
  const { worktreeBaseSha, worktreeBranch, worktreePath } = snapshot.execution;
  const output = (() => {
    try {
      const parsed: unknown = JSON.parse(run.resultJson ?? '{}');
      return typeof parsed === 'object' &&
        parsed !== null &&
        'output' in parsed &&
        typeof parsed.output === 'string'
        ? parsed.output
        : '';
    } catch {
      return '';
    }
  })();
  const outcome =
    baseline === null ||
    worktreeBaseSha === null ||
    worktreeBranch === null ||
    worktreePath === null
      ? { kind: 'error' as const, message: 'The wrap-up baseline or worktree is missing.' }
      : validateWrapup({
          baseBranch: snapshot.execution.worktreeBaseBranch,
          baseline,
          baseSha: worktreeBaseSha,
          branch: worktreeBranch,
          codeRoot: snapshot.execution.policy.codeRoot,
          commands: snapshot.execution.policy.validation.work.commands,
          factoryRoot: factoryRootOf(snapshot),
          findPullRequest: input.findPullRequest,
          generated: snapshot.execution.policy.validation.wrapup.generated,
          output,
          pullRequests: snapshot.execution.policy.pullRequests,
          worktree: worktreePath,
        });
  const checks = outcome.kind === 'error' ? [] : outcome.checks;
  const status = outcome.kind === 'error' ? 'error' : outcome.kind;
  const summary =
    outcome.kind === 'error'
      ? outcome.message
      : outcome.kind === 'failed'
        ? outcome.failures.join('\n')
        : 'passed';
  const executionId = snapshot.execution.id;
  const validationId = input.ids.event();
  const now = input.now();
  apply(
    input,
    {
      actionId: action.id,
      kind: 'validation_finished',
      outcome,
      runId: run.id,
      stage: 'wrapup',
      usage: usageTable(input.db, executionId, { includeWrapup: true }),
    },
    `validation:${action.id}`,
    'validator',
    (db) => {
      writeValidation(db, {
        checks,
        executionId,
        id: validationId,
        now,
        resultHash: null,
        runId: run.id,
        status,
        summary,
        validatorVersion: 'wrapup.v1',
      });
    },
  );
  return Promise.resolve(null);
}

// Opens a handoff pane. A failure retries here and never fails the handoff.
export async function openHandoffPane(
  input: Context & { runtime: FactorySubagentRuntime },
  action: Extract<ActionRecord, { kind: 'open_diff' | 'open_pane' }>,
  snapshot: FactorySnapshot,
): Promise<RunId | null> {
  const run = snapshot.runs.find((item) => item.id === action.runId) ?? null;
  const session =
    run === null ? null : (snapshot.sessions.find((item) => item.id === run.sessionId) ?? null);
  const sessionFile = session?.sessionFile ?? null;
  if (sessionFile === null) {
    finishLeasedAction(
      input.db,
      action.id,
      input.now(),
      'failed',
      'The wrap-up session file is missing.',
    );
    return null;
  }
  const worktree = snapshot.execution.worktreePath ?? snapshot.execution.policy.codeRoot;
  let lastError = 'herdr pane open failed';
  for (let attempt = 1; attempt <= action.maxAttempts; attempt += 1) {
    try {
      if (action.kind === 'open_diff') {
        const collected = collectWorkDiff(action.cwd);
        const file = `${sessionFile}.diff`;
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, 'diff' in collected ? collected.diff : `# ${collected.message}\n`);
        await input.runtime.openPane({
          cwd: action.cwd,
          name: action.name,
          scriptFile: `${sessionFile}.diff.sh`,
          target: { file, kind: 'diff' },
        });
      } else {
        await input.runtime.openPane({
          cwd: worktree,
          name: action.name,
          scriptFile: `${sessionFile}.inspect.sh`,
          target: { kind: 'session', sessionFile },
        });
      }
      finishLeasedAction(input.db, action.id, input.now(), 'succeeded', null);
      return null;
    } catch (error: unknown) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
  finishLeasedAction(input.db, action.id, input.now(), 'failed', lastError);
  return null;
}
