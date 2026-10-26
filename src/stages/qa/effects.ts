import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { WorkCommand } from '../../config.ts';
import { sha256 } from '../../hash.ts';
import {
  errorReport,
  failedReport,
  passedReport,
  type ValidationCheck,
  type Validator,
} from '../../validation/report.ts';
import {
  collectWorkDiff,
  commandCheck,
  runCommand,
  validationLeaseMs,
} from '../../validation/work.ts';
import type { InputContext, InputResult } from '../effects.ts';
import { acceptanceCriteria, qaPaths, testGaps, testPlan } from './criteria.ts';
import {
  changedFiles,
  qaSettings,
  qaWorkCommands,
  type QaPrepared,
  type QaValidationReport,
} from './definition.ts';

export const QA_VALIDATOR_VERSION = 'qa.v1';

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// The worktree as work left it, per file, and the work checks that passed:
// what QA validation compares against to tell QA's files from the worker's.
type QaBaseline = { files: Record<string, string>; workChecks: Array<ValidationCheck> };

// Each changed file's diff, hashed, by path.
function fileDiffs(diff: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const part of diff.split(/^(?=diff --git )/m)) {
    const [file] = changedFiles(part);
    if (file !== undefined) {
      // Trimmed: the diff joins untracked files' parts with a newline.
      files[file] = sha256(part.trim());
    }
  }
  return files;
}

// The QaBaseline JSON for a worktree with `diff`.
export function qaBaseline(diff: string, workChecks: Array<ValidationCheck>): string {
  return JSON.stringify({ files: fileDiffs(diff), workChecks } satisfies QaBaseline);
}

function parseBaseline(text: string | null): QaBaseline | null {
  try {
    const value: unknown = JSON.parse(text ?? '');
    if (typeof value === 'object' && value !== null && 'files' in value && 'workChecks' in value) {
      return value as QaBaseline;
    }
  } catch {
    // An unreadable baseline is no baseline.
  }
  return null;
}

function escapeRegExp(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

// Whether command output names `file`, relative to the worktree or under it:
// `src/a.ts` is named by `src/a.ts:3` and `/wt/src/a.ts(3,1)`, not by
// `src/a.tsx` or `tests/src/a.ts`.
function names(output: string, file: string, worktree: string): boolean {
  return new RegExp(
    `(?:^|[\\s'"(\\[]|${escapeRegExp(worktree)}/)${escapeRegExp(file)}(?![\\w./-])`,
    'm',
  ).test(output);
}

// Reads the task's acceptance criteria, what the worker changed, and the work
// checks that passed, and makes QA's directory.
export function prepareQaInput({ action, deps, snapshot }: InputContext): InputResult<QaPrepared> {
  const task = snapshot.tasks.find((item) => item.taskId === action.taskId) ?? null;
  if (task === null || snapshot.execution.worktreeStatus !== 'ready') {
    return { kind: 'failed', message: 'The worktree is not ready for this execution.' };
  }
  const file = path.join(snapshot.execution.factoryDir, task.taskFile);
  const text = readText(file);
  if (text === null) {
    return { kind: 'failed', message: `Task file ${file} cannot be read.` };
  }
  const criteria = acceptanceCriteria(text);
  if (criteria.length === 0) {
    return { kind: 'failed', message: `Task ${task.taskId} lists no acceptance criteria.` };
  }
  const paths = qaPaths(snapshot.execution.factoryDir, task.taskId);
  try {
    mkdirSync(paths.screenshots, { recursive: true });
  } catch (error: unknown) {
    return {
      kind: 'failed',
      message: `Cannot create ${paths.dir}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const worktree = snapshot.execution.worktreePath;
  const diff = worktree === null ? { diff: '' } : collectWorkDiff(worktree);
  if ('message' in diff) {
    return { kind: 'failed', message: `Cannot read the worktree diff: ${diff.message}` };
  }
  const passed = deps
    .passedChecks('work')
    .filter((check) => check.taskId === task.taskId && check.kind === 'command')
    .map((check): ValidationCheck => ({
      command: check.command,
      details: 'passed in work validation',
      kind: 'command',
      name: check.name,
      status: 'passed',
    }));
  return {
    input: {
      baseline: qaBaseline(diff.diff, passed),
      changedFiles: changedFiles(diff.diff),
      checks: passed.map((check) => `${check.name}: ${check.status}`),
      criteria,
      dir: paths.dir,
    },
    kind: 'ready',
  };
}

function artifact(
  name: string,
  passed: boolean,
  details: string,
  evidencePath: string | null = null,
): ValidationCheck {
  return { details, evidencePath, kind: 'artifact', name, status: passed ? 'passed' : 'failed' };
}

// Checks QA's own output first: every criterion tested or in the ledger with a
// reason, every screenshot on disk. Then it runs the QA commands itself; a
// failing command means the product misses a criterion. Then it runs the
// work commands again, so QA's files meet work's bar: a failure that names a
// file QA changed this round is QA's to correct, any other goes back to work.
async function validateQa(input: {
  // Null for a round prepared before QA took one: no file counts as QA's.
  baseline: QaBaseline | null;
  commands: ReturnType<typeof qaSettings>['commands'];
  factoryDir: string;
  taskFile: string;
  taskId: string;
  workCommands: Array<WorkCommand>;
  worktree: string;
}): Promise<QaValidationReport> {
  const paths = qaPaths(input.factoryDir, input.taskId);
  const taskText = readText(path.join(input.factoryDir, input.taskFile));
  if (taskText === null) {
    return errorReport(QA_VALIDATOR_VERSION, `Task file ${input.taskFile} cannot be read.`);
  }
  const criteria = acceptanceCriteria(taskText);
  const planText = readText(paths.plan);
  const ledgerText = readText(paths.ledger);
  const checks: Array<ValidationCheck> = [
    artifact(
      'test plan',
      planText !== null,
      planText === null ? `${paths.plan} is missing.` : paths.plan,
    ),
    artifact(
      'test-gap ledger',
      ledgerText !== null,
      ledgerText === null ? `${paths.ledger} is missing.` : paths.ledger,
    ),
  ];
  const plan = testPlan(planText ?? '');
  const gaps = testGaps(ledgerText ?? '');
  for (const criterion of criteria) {
    const tested = plan.find((row) => row.criterion === criterion.id && row.test.length > 0);
    const gap = gaps.get(criterion.id);
    const covered = tested !== undefined || (gap !== undefined && gap.length > 0);
    checks.push({
      details: covered
        ? (tested?.test ?? `ledger: ${gap ?? ''}`)
        : `${criterion.id} (${criterion.text}) has no test in test-plan.md and no reason in ledger.md.`,
      kind: 'schema',
      name: `${criterion.id} covered`,
      status: covered ? 'passed' : 'failed',
    });
  }
  for (const row of plan) {
    for (const screenshot of row.screenshots) {
      const file = path.resolve(paths.dir, screenshot);
      const present = file.startsWith(`${paths.dir}${path.sep}`) && existsSync(file);
      checks.push(
        artifact(
          row.screenshots.length === 1
            ? `screenshot ${row.criterion}`
            : `screenshot ${row.criterion} ${path.basename(screenshot)}`,
          present,
          present
            ? file
            : `Screenshot ${screenshot} for ${row.criterion} is missing from ${paths.dir}.`,
          present ? file : null,
        ),
      );
    }
  }
  const incomplete = checks
    .filter((check) => check.status === 'failed')
    .map((check) => check.details);
  if (incomplete.length > 0) {
    return failedReport(QA_VALIDATOR_VERSION, checks, incomplete, { reason: 'incomplete' });
  }
  const failing: Array<string> = [];
  for (const command of input.commands) {
    const result = await runCommand(command, input.worktree);
    if (result.spawnError !== null) {
      return errorReport(QA_VALIDATOR_VERSION, result.spawnError);
    }
    const check = commandCheck(command, input.worktree, result);
    checks.push(check);
    if (check.status === 'failed') {
      failing.push(
        `${command.name} (${command.argv.join(' ')}) failed: ${check.outputExcerpt?.trim() || check.details}`,
      );
    }
  }
  const qaChecks = [...checks];
  // The next stage is given the worktree as QA left it, tests included.
  const collected = collectWorkDiff(input.worktree);
  if ('message' in collected) {
    return errorReport(QA_VALIDATOR_VERSION, collected.message);
  }
  // The work commands run again even when a QA command failed, so a file
  // QA wrote never reaches the worker unchecked.
  const current = fileDiffs(collected.diff);
  const qaFiles =
    input.baseline === null
      ? []
      : Object.keys(current).filter((file) => current[file] !== input.baseline?.files[file]);
  const again: Array<ValidationCheck> = [];
  const qaFailures: Array<string> = [];
  for (const command of input.workCommands) {
    const result = await runCommand(command, input.worktree);
    if (result.spawnError !== null) {
      return errorReport(QA_VALIDATOR_VERSION, result.spawnError);
    }
    const check = commandCheck(command, input.worktree, result);
    again.push(check);
    if (check.status === 'failed') {
      const output = check.outputExcerpt?.trim() || check.details;
      const owned = qaFiles.filter((file) => names(output, file, input.worktree));
      const name = `${command.name} (${command.argv.join(' ')}) failed after QA`;
      if (owned.length > 0) {
        qaFailures.push(`${name} in ${owned.join(', ')}: ${output}`);
      } else {
        failing.push(`${name}: ${output}`);
      }
    }
  }
  checks.push(...again);
  // QA fixes its own files first; product failures that remain come back after.
  if (qaFailures.length > 0) {
    return failedReport(QA_VALIDATOR_VERSION, checks, qaFailures, { reason: 'incomplete' });
  }
  if (failing.length > 0) {
    return failedReport(QA_VALIDATOR_VERSION, checks, failing, { reason: 'product' });
  }
  const ranAgain = new Set(again.map((check) => check.name));
  return passedReport(QA_VALIDATOR_VERSION, checks, {
    criteria,
    diff: collected.diff,
    gaps: gaps.size,
    qaChecks,
    tested: plan.length,
    workChecks: [
      ...(input.baseline?.workChecks ?? []).filter((check) => !ranAgain.has(check.name)),
      ...again,
    ],
  });
}

export const qaValidator: Validator<'qa'> = {
  leaseMs: (snapshot) =>
    validationLeaseMs([
      ...qaSettings(snapshot.execution.policy).commands,
      ...qaWorkCommands(snapshot.execution.policy),
    ]),
  validate: ({ run, session, snapshot }) => {
    const task = snapshot.tasks.find((item) => item.taskId === session.taskId) ?? null;
    const worktree = snapshot.execution.worktreePath;
    if (task === null || worktree === null) {
      return Promise.resolve(
        errorReport(QA_VALIDATOR_VERSION, 'The QA task or worktree is missing.'),
      );
    }
    // Taken when the round's input was prepared; its corrections keep it.
    const baseline = snapshot.runs.findLast(
      (item) =>
        item.sessionId === session.id &&
        item.semanticRound === run.semanticRound &&
        item.baseline !== null &&
        item.sequence <= run.sequence,
    );
    return validateQa({
      baseline: parseBaseline(baseline?.baseline ?? null),
      commands: qaSettings(snapshot.execution.policy).commands,
      factoryDir: snapshot.execution.factoryDir,
      taskFile: task.taskFile,
      taskId: task.taskId,
      workCommands: qaWorkCommands(snapshot.execution.policy),
      worktree,
    });
  },
  version: QA_VALIDATOR_VERSION,
};
