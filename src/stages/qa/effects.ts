import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
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
  const checks = deps
    .passedChecks('work')
    .filter((check) => check.taskId === task.taskId && check.kind === 'command')
    .map((check) => `${check.name}: ${check.status}`);
  return {
    input: { changedFiles: changedFiles(diff.diff), checks, criteria, dir: paths.dir },
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
// failing command means the product misses a criterion.
async function validateQa(input: {
  commands: ReturnType<typeof qaSettings>['commands'];
  factoryDir: string;
  taskFile: string;
  taskId: string;
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
  if (failing.length > 0) {
    return failedReport(QA_VALIDATOR_VERSION, checks, failing, { reason: 'product' });
  }
  // The next stage is given the worktree as QA left it, tests included.
  const collected = collectWorkDiff(input.worktree);
  if ('message' in collected) {
    return errorReport(QA_VALIDATOR_VERSION, collected.message);
  }
  return passedReport(QA_VALIDATOR_VERSION, checks, {
    diff: collected.diff,
    gaps: gaps.size,
    tested: plan.length,
  });
}

export const qaValidator: Validator<'qa'> = {
  leaseMs: (snapshot) => validationLeaseMs(qaSettings(snapshot.execution.policy).commands),
  validate: ({ session, snapshot }) => {
    const task = snapshot.tasks.find((item) => item.taskId === session.taskId) ?? null;
    const worktree = snapshot.execution.worktreePath;
    if (task === null || worktree === null) {
      return Promise.resolve(
        errorReport(QA_VALIDATOR_VERSION, 'The QA task or worktree is missing.'),
      );
    }
    return validateQa({
      commands: qaSettings(snapshot.execution.policy).commands,
      factoryDir: snapshot.execution.factoryDir,
      taskFile: task.taskFile,
      taskId: task.taskId,
      worktree,
    });
  },
  version: QA_VALIDATOR_VERSION,
};
