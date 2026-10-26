import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { allowsEmptyDiff, type WorkCommand } from '../config.ts';
import type { WorkValidationReport } from '../domain.ts';
import { taskCriteria, type Criterion } from '../stages/qa/criteria.ts';
import {
  errorReport,
  failedReport,
  failuresOf,
  passedReport,
  type ValidationCheck,
  type Validator,
} from './report.ts';

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
  return listed.stdout.split('\0').filter((item) => item.length > 0);
}

function trackedDiff(cwd: string, base: string): GitResult | { message: string } {
  const diff = git(cwd, ['diff', '--no-ext-diff', base]);
  if (gitFailure(diff)) {
    return { message: diff.stderr.trim() || 'cannot read the worktree diff' };
  }
  return diff;
}

function untrackedDiff(cwd: string, file: string): GitResult {
  return git(cwd, ['diff', '--no-index', '--', '/dev/null', file]);
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

function commitCheck(cwd: string, baseSha: string): ValidationCheck | { message: string } {
  const head = git(cwd, ['rev-parse', 'HEAD']);
  if (head.code !== 0) {
    return { message: head.stderr.trim() || 'cannot read HEAD' };
  }
  const sha = head.stdout.trim();
  const committed = sha !== baseSha;
  return {
    command: null,
    details: committed ? `unexpected commit ${sha}` : `HEAD matches ${baseSha}`,
    durationMs: null,
    exitCode: null,
    kind: 'policy',
    name: 'uncommitted',
    outputExcerpt: null,
    status: committed ? 'failed' : 'passed',
  };
}

type CommandResult = {
  durationMs: number;
  exitCode: number | null;
  output: string;
  spawnError: string | null;
  timedOut: boolean;
};

export function runCommand(command: WorkCommand, cwd: string): Promise<CommandResult> {
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

async function validateWork(input: {
  allowsEmptyDiff: boolean;
  baseSha: string;
  commands: Array<WorkCommand>;
  criteria: Array<Criterion>;
  cwd: string;
}): Promise<WorkValidationReport> {
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
  const commit = commitCheck(input.cwd, input.baseSha);
  if ('message' in commit) {
    return errorReport(WORK_VALIDATOR_VERSION, commit.message);
  }
  checks.push(commit);
  for (const command of input.commands) {
    const result = await runCommand(command, input.cwd);
    if (result.spawnError !== null) {
      return errorReport(WORK_VALIDATOR_VERSION, result.spawnError);
    }
    checks.push(commandCheck(command, input.cwd, result));
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

export const workValidator: Validator<'work'> = {
  leaseMs: (snapshot) => validationLeaseMs(snapshot.execution.policy.validation.work.commands),
  validate: ({ session, snapshot }) => {
    const { factoryDir, policy, worktreeBaseSha, worktreePath } = snapshot.execution;
    if (worktreePath === null || worktreeBaseSha === null) {
      return Promise.resolve(errorReport(WORK_VALIDATOR_VERSION, 'Worktree is missing.'));
    }
    const task = snapshot.tasks.find((item) => item.taskId === session.taskId) ?? null;
    return validateWork({
      allowsEmptyDiff: allowsEmptyDiff(snapshot.ticket.labels, policy.labels.map),
      baseSha: worktreeBaseSha,
      commands: policy.validation.work.commands,
      // Read for review; work itself does not check them.
      criteria: task === null ? [] : taskCriteria(path.join(factoryDir, task.taskFile)),
      cwd: worktreePath,
    });
  },
  version: WORK_VALIDATOR_VERSION,
};
