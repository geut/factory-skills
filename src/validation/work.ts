import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { allowsEmptyDiff, type WorkCommand } from '../config.ts';
import type { CommandReporter } from '../controller/command-progress.ts';
import { factoryRootOf } from '../controller/keys.ts';
import type { RequestedValidation, WorkValidationReport } from '../domain.ts';
import { isOsMetadata } from '../os-metadata.ts';
import { missingReport } from '../runtime/work-report.ts';
import { feedbackRoundOf } from '../stages/feedback.ts';
import { runOutput } from '../stages/output.ts';
import { taskCriteria, type Criterion } from '../stages/qa/criteria.ts';
import { factoryVersion } from '../version.ts';
import { headCheck, roundBase, syncWorktreeRefs, unreadableHistory } from './bases.ts';
import { commandEnv, ensureValidationLogs } from './command-env.ts';
import { workFingerprint } from './fingerprint.ts';
import {
  errorReport,
  failedReport,
  failuresOf,
  passedReport,
  type ValidationCheck,
  type Validator,
} from './report.ts';
import {
  missingTests,
  SELECTION_CHECK,
  SELECTION_ENV,
  SELECTION_FIX,
  taskSelection,
  type ParsedSelection,
  type SelectedTest,
} from './selection.ts';

export const WORK_VALIDATOR_VERSION = 'work.v1';

export const COMMAND_OUTPUT_LIMIT = 16_384;
const VALIDATION_LEASE_MARGIN_MS = 30_000;

export function validationLeaseMs(commands: Array<Pick<WorkCommand, 'timeoutMs'>>): number {
  const budget = commands.reduce((total, command) => total + command.timeoutMs, 0);
  return budget + VALIDATION_LEASE_MARGIN_MS;
}

type GitResult = { code: number; stderr: string; stdout: string };

function git(cwd: string, args: Array<string>): GitResult {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return {
    code: result.status ?? 1,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
  };
}

function gitFailure(result: GitResult): boolean {
  return result.stderr.includes('not a git repository') || result.code === 129;
}

function excerpt(text: string): string {
  return text.length <= COMMAND_OUTPUT_LIMIT ? text : text.slice(0, COMMAND_OUTPUT_LIMIT);
}

function untrackedPaths(cwd: string): Array<string> | { message: string } {
  const listed = git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (listed.code !== 0) {
    return { message: listed.stderr.trim() || 'cannot list untracked files' };
  }
  // An untracked OS metadata file, such as a host Finder's `.DS_Store`, is
  // nobody's change.
  return listed.stdout.split('\0').filter((item) => item.length > 0 && !isOsMetadata(item));
}

// The a/ and b/ prefixes every diff parser reads, whatever diff.noprefix or
// diff.mnemonicPrefix say.
const DIFF_PREFIXES = ['--src-prefix=a/', '--dst-prefix=b/'];

function trackedDiff(cwd: string, base: string): GitResult | { message: string } {
  const diff = git(cwd, ['diff', '--no-ext-diff', ...DIFF_PREFIXES, base]);
  if (gitFailure(diff)) {
    return { message: diff.stderr.trim() || 'cannot read the worktree diff' };
  }
  return diff;
}

function untrackedDiff(cwd: string, file: string): GitResult {
  return git(cwd, ['diff', '--no-index', ...DIFF_PREFIXES, '--', '/dev/null', file]);
}

// The worktree's changes since `base` (uncommitted by default), untracked files
// included.
export function collectWorkDiff(
  cwd: string,
  base = 'HEAD',
): { diff: string } | { message: string } {
  const tracked = trackedDiff(cwd, base);
  if ('message' in tracked) {
    return tracked;
  }
  const untracked = untrackedPaths(cwd);
  if (!Array.isArray(untracked)) {
    return untracked;
  }
  const parts = [tracked.stdout];
  for (const file of untracked) {
    const diff = untrackedDiff(cwd, file);
    if (gitFailure(diff)) {
      return { message: diff.stderr.trim() || `cannot diff untracked file ${file}` };
    }
    parts.push(diff.stdout);
  }
  return { diff: parts.filter((part) => part.trim().length > 0).join('\n') };
}

type CommandResult = {
  durationMs: number;
  exitCode: number | null;
  output: string;
  spawnError: string | null;
  timedOut: boolean;
};

// `env` is the command's own environment, made for it alone; the server's
// when not given.
export function runCommand(
  command: WorkCommand,
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    let timedOut = false;
    const finish = (result: Omit<CommandResult, 'durationMs' | 'output'> & { output?: string }) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        durationMs: Date.now() - started,
        exitCode: result.exitCode,
        output: result.output ?? output,
        spawnError: result.spawnError,
        timedOut: result.timedOut,
      });
    };
    let child;
    try {
      child = spawn(command.argv[0] ?? '', command.argv.slice(1), {
        cwd,
        ...(env === undefined ? {} : { env }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'command failed to start';
      finish({ exitCode: null, spawnError: message, timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, command.timeoutMs);
    const push = (chunk: Buffer): void => {
      if (output.length >= COMMAND_OUTPUT_LIMIT) {
        return;
      }
      output += chunk.toString('utf8').slice(0, COMMAND_OUTPUT_LIMIT - output.length);
    };
    child.stdout?.on('data', push);
    child.stderr?.on('data', push);
    child.on('error', (error) => {
      clearTimeout(timer);
      finish({ exitCode: null, spawnError: error.message, timedOut: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ exitCode: code, spawnError: null, timedOut });
    });
  });
}

export function commandCheck(
  command: WorkCommand,
  cwd: string,
  result: CommandResult,
): ValidationCheck {
  const location = `cwd ${cwd}`;
  if (result.timedOut) {
    const details = `${location}; timed out after ${command.timeoutMs}ms`;
    return {
      command: command.argv.join(' '),
      details,
      durationMs: result.durationMs,
      exitCode: null,
      kind: 'command',
      name: command.name,
      outputExcerpt: excerpt(result.output),
      status: 'failed',
    };
  }
  const passed = result.exitCode === 0;
  return {
    command: command.argv.join(' '),
    details: passed
      ? location
      : `${location}; ${result.output.trim() || `exit ${result.exitCode ?? 'unknown'}`}`,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    kind: 'command',
    name: command.name,
    outputExcerpt: excerpt(result.output),
    status: passed ? 'passed' : 'failed',
  };
}

// The worker's selection as the report shows it: what the commands got, or
// what to fix.
function selectionCheck(input: {
  details: string;
  status: ValidationCheck['status'];
}): ValidationCheck {
  return {
    command: null,
    details: input.details,
    durationMs: null,
    exitCode: null,
    kind: 'policy',
    name: SELECTION_CHECK,
    outputExcerpt: null,
    status: input.status,
  };
}

async function validateWork(input: {
  allowsEmptyDiff: boolean;
  // The commit work leaves its changes uncommitted on: the ticket's base, or
  // the start of the feedback round.
  baseSha: string;
  commands: Array<WorkCommand>;
  criteria: Array<Criterion>;
  cwd: string;
  // Where the commands are told to keep their logs.
  factoryRoot: string;
  // What the commands' inputs hash to now, given the selection; null when
  // they cannot be read, which never reuses a pass.
  fingerprint: (tests: Array<SelectedTest>) => string | null;
  // Why the run ended without a report, or null when it has one.
  missingReport: string | null;
  reportCommand: CommandReporter;
  // The validation the run asked for while it iterated, if any.
  requested: RequestedValidation | null;
  // The tests the worker proposed, for the commands.
  selection: ParsedSelection;
  // The branch the pull request targets, for the worktree's target ref.
  targetBranch: string | null;
}): Promise<WorkValidationReport> {
  // A run without a report has no selection to give the commands, nor
  // answers for review: it is corrected before anything runs.
  if (input.missingReport !== null) {
    const checks: Array<ValidationCheck> = [
      {
        command: null,
        details: [
          input.missingReport,
          'Call subagent_done with your report as its arguments; the controller reads nothing else.',
        ].join('\n'),
        durationMs: null,
        exitCode: null,
        kind: 'schema',
        name: 'work report',
        outputExcerpt: null,
        status: 'failed',
      },
    ];
    return failedReport(WORK_VALIDATOR_VERSION, checks, failuresOf(checks), null);
  }
  // The refs the project's checks compare against, current before they run.
  // A HEAD that left the round's start is the HEAD check's to correct; a
  // history that cannot answer stops here, before any command.
  const synced = syncWorktreeRefs({
    roundBase: input.baseSha,
    targetBranch: input.targetBranch,
    worktree: input.cwd,
  });
  if (synced !== null) {
    return errorReport(WORK_VALIDATOR_VERSION, synced);
  }
  const unreadable = unreadableHistory(input.cwd, input.baseSha);
  if (unreadable !== null) {
    return errorReport(WORK_VALIDATOR_VERSION, unreadable);
  }
  const collected = collectWorkDiff(input.cwd);
  if ('message' in collected) {
    return errorReport(WORK_VALIDATOR_VERSION, collected.message);
  }
  const checks: Array<ValidationCheck> = [];
  if (!input.allowsEmptyDiff) {
    const present = collected.diff.trim().length > 0;
    checks.push({
      command: null,
      details: present ? 'diff present' : 'diff is empty',
      durationMs: null,
      exitCode: null,
      kind: 'diff',
      name: 'diff',
      outputExcerpt: null,
      status: present ? 'passed' : 'failed',
    });
  }
  const commit = headCheck(input.cwd, input.baseSha);
  if ('message' in commit) {
    return errorReport(WORK_VALIDATOR_VERSION, commit.message);
  }
  checks.push(commit);
  // Work leaves its changes uncommitted on the round's start: a commit, a
  // rebase, or a reset is corrected before any command runs on it.
  if (commit.status === 'failed') {
    return failedReport(WORK_VALIDATOR_VERSION, checks, failuresOf(checks), null);
  }
  // A selection the worker got wrong is corrected before the commands run
  // on it.
  const { selection } = input;
  const problems =
    selection.kind === 'invalid'
      ? selection.problems
      : selection.kind === 'listed'
        ? missingTests(selection.tests, input.cwd)
        : [];
  const tests = selection.kind === 'listed' ? selection.tests : [];
  if (problems.length > 0) {
    checks.push(
      selectionCheck({ details: [...problems, SELECTION_FIX].join('\n'), status: 'failed' }),
    );
    return failedReport(WORK_VALIDATOR_VERSION, checks, failuresOf(checks), null);
  }
  if (tests.length > 0) {
    checks.push(
      selectionCheck({
        details: `${SELECTION_ENV} lists ${tests.length} test file${tests.length === 1 ? '' : 's'}: ${tests.map((test) => test.path).join(', ')}`,
        status: 'passed',
      }),
    );
  }
  // A pass the worker asked for in this run, on inputs that are still the
  // same, stands for the commands; anything else runs them.
  const reused = reusablePass({
    fingerprint: input.fingerprint,
    requested: input.requested,
    tests,
  });
  if (reused !== null) {
    checks.push(...reused);
  } else {
    const ran = await runWorkCommands({
      commands: input.commands,
      cwd: input.cwd,
      factoryRoot: input.factoryRoot,
      reportCommand: input.reportCommand,
      tests,
    });
    if ('spawnError' in ran) {
      return errorReport(WORK_VALIDATOR_VERSION, ran.spawnError);
    }
    checks.push(...ran.checks);
  }
  const failures = failuresOf(checks);
  if (failures.length > 0) {
    return failedReport(WORK_VALIDATOR_VERSION, checks, failures, null);
  }
  // Commands can write files (test reports, caches). The reviewer gets the
  // worktree as it stands after them, so review validation compares like
  // with like.
  const final = collectWorkDiff(input.cwd);
  if ('message' in final) {
    return errorReport(WORK_VALIDATOR_VERSION, final.message);
  }
  return passedReport(WORK_VALIDATOR_VERSION, checks, {
    criteria: input.criteria,
    diff: final.diff,
  });
}

// The work commands, run as validation runs them: each in its own
// environment, with the selection, logging where validators log.
export async function runWorkCommands(input: {
  commands: Array<WorkCommand>;
  cwd: string;
  factoryRoot: string;
  reportCommand: CommandReporter;
  tests: Array<SelectedTest>;
}): Promise<{ checks: Array<ValidationCheck> } | { spawnError: string }> {
  ensureValidationLogs(input.factoryRoot);
  const checks: Array<ValidationCheck> = [];
  for (const [index, command] of input.commands.entries()) {
    input.reportCommand({ command: command.name, index: index + 1, total: input.commands.length });
    const result = await runCommand(
      command,
      input.cwd,
      commandEnv({ factoryRoot: input.factoryRoot, tests: input.tests }),
    );
    if (result.spawnError !== null) {
      return { spawnError: result.spawnError };
    }
    checks.push(commandCheck(command, input.cwd, result));
  }
  return { checks };
}

// What the work commands' inputs hash to, given a selection: the one
// fingerprint a requested validation and the submission both take, so they
// cannot drift apart. Null when git cannot read them, which reuses nothing.
export function workInputsFingerprint(input: {
  base: string;
  commands: Array<WorkCommand>;
  executionId: string;
  factoryDir: string;
  worktree: string;
}): (tests: Array<SelectedTest>) => string | null {
  return (tests) => {
    const found = workFingerprint({
      base: input.base,
      commands: input.commands,
      executionId: input.executionId,
      factoryRoot: factoryRootOf(input.factoryDir),
      selection: tests,
      validatorVersion: WORK_VALIDATOR_VERSION,
      version: factoryVersion(),
      worktree: input.worktree,
    });
    return 'fingerprint' in found ? found.fingerprint : null;
  };
}

// The checks of a requested validation that stand for the commands now, each
// marked reused with when it ran and on what; null when it cannot stand: it
// failed, its inputs changed while it ran, or they differ now.
function reusablePass(input: {
  fingerprint: (tests: Array<SelectedTest>) => string | null;
  requested: RequestedValidation | null;
  tests: Array<SelectedTest>;
}): Array<ValidationCheck> | null {
  const { requested } = input;
  if (requested === null || !requested.passed || !requested.reusable) {
    return null;
  }
  const now = input.fingerprint(input.tests);
  if (now === null || now !== requested.fingerprint) {
    return null;
  }
  return requested.checks.map((check) => ({
    ...check,
    details: `reused: ran at ${requested.finishedAt} in this run, on the same inputs (fingerprint ${requested.fingerprint.slice(0, 12)}); ${check.details}`,
  }));
}

export const workValidator: Validator<'work'> = {
  leaseMs: (snapshot) => validationLeaseMs(snapshot.execution.policy.validation.work.commands),
  validate: ({ deps, run, session, snapshot }) => {
    const { factoryDir, policy, worktreeBaseBranch, worktreePath } = snapshot.execution;
    const base = roundBase(snapshot);
    if (worktreePath === null || base === null) {
      return Promise.resolve(errorReport(WORK_VALIDATOR_VERSION, 'Worktree is missing.'));
    }
    const task = snapshot.tasks.find((item) => item.taskId === session.taskId) ?? null;
    const round = task === null ? null : feedbackRoundOf(task);
    return validateWork({
      // A feedback round may decline every item and change nothing; review
      // judges each item either way.
      allowsEmptyDiff: round !== null || allowsEmptyDiff(snapshot.ticket.labels, policy.labels.map),
      baseSha: base,
      commands: policy.validation.work.commands,
      // Read for review; work itself does not check them.
      criteria: task === null ? [] : taskCriteria(path.join(factoryDir, task.taskFile)),
      cwd: worktreePath,
      factoryRoot: factoryRootOf(factoryDir),
      fingerprint: workInputsFingerprint({
        base,
        commands: policy.validation.work.commands,
        executionId: snapshot.execution.id,
        factoryDir,
        worktree: worktreePath,
      }),
      missingReport: missingReport(runOutput(run)),
      reportCommand: deps.reportCommand,
      // Only the run that asked: a later run, or another task's, revalidates.
      requested: run.requestedValidation,
      // The selection as of the run validated: a retry of it gets the same.
      selection: task === null ? { kind: 'absent' } : taskSelection(snapshot, task.taskId, run),
      targetBranch: worktreeBaseBranch,
    });
  },
  version: WORK_VALIDATOR_VERSION,
};
