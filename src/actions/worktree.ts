import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { WorkCommand } from '../config.ts';
import { runCommand } from '../validation/work.ts';

export type WorktreeReady = {
  baseBranch: string;
  baseSha: string;
  branch: string;
  kind: 'ready';
  path: string;
};

export type WorktreeFailure = { kind: 'failed'; message: string };

function git(
  codeRoot: string,
  args: Array<string>,
): { code: number; stderr: string; stdout: string } {
  const result = spawnSync('git', args, {
    cwd: codeRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: process.env['GIT_AUTHOR_EMAIL'] ?? 'factory@example.com',
      GIT_AUTHOR_NAME: process.env['GIT_AUTHOR_NAME'] ?? 'Factory',
      GIT_COMMITTER_EMAIL: process.env['GIT_COMMITTER_EMAIL'] ?? 'factory@example.com',
      GIT_COMMITTER_NAME: process.env['GIT_COMMITTER_NAME'] ?? 'Factory',
    },
  });
  return { code: result.status ?? 1, stderr: result.stderr, stdout: result.stdout.trim() };
}

export function prepareWorktree(input: {
  codeRoot: string;
  factoryRoot: string;
  slug: string;
}): WorktreeReady | WorktreeFailure {
  const base = git(input.codeRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (base.code !== 0) {
    return { kind: 'failed', message: base.stderr.trim() || 'cannot read the current branch' };
  }
  const sha = git(input.codeRoot, ['rev-parse', 'HEAD']);
  if (sha.code !== 0) {
    return { kind: 'failed', message: sha.stderr.trim() || 'cannot read HEAD' };
  }
  const branch = `factory/${input.slug}`;
  const worktreePath = path.join(input.factoryRoot, 'worktrees', input.slug);
  // A retry after a failed setup finds the worktree already there.
  const current = existsSync(path.join(worktreePath, '.git'))
    ? git(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD'])
    : null;
  const reused = current !== null && current.code === 0 && current.stdout === branch;
  const added = reused
    ? { code: 0, stderr: '', stdout: '' }
    : git(input.codeRoot, ['worktree', 'add', '-b', branch, worktreePath, 'HEAD']);
  if (added.code !== 0) {
    const existing = git(input.codeRoot, ['worktree', 'add', worktreePath, branch]);
    if (existing.code !== 0) {
      return {
        kind: 'failed',
        message: added.stderr.trim() || existing.stderr.trim() || 'worktree add failed',
      };
    }
  }
  return {
    baseBranch: base.stdout,
    baseSha: sha.stdout,
    branch,
    kind: 'ready',
    path: worktreePath,
  };
}

const SETUP_OUTPUT_TAIL = 1500;

// Runs `worktree.setup` in a new worktree, in order. The first command that
// fails, times out, or cannot start stops the setup with its output.
export async function setUpWorktree(
  commands: Array<WorkCommand>,
  worktree: string,
): Promise<{ kind: 'ready' } | WorktreeFailure> {
  for (const command of commands) {
    const result = await runCommand(command, worktree);
    if (result.spawnError !== null) {
      return {
        kind: 'failed',
        message: `Worktree setup ${command.name} could not start: ${result.spawnError}`,
      };
    }
    if (result.timedOut || result.exitCode !== 0) {
      const why = result.timedOut
        ? `timed out after ${command.timeoutMs} ms`
        : `exited with code ${result.exitCode ?? 'unknown'}`;
      const tail = result.output.trim().slice(-SETUP_OUTPUT_TAIL);
      return {
        kind: 'failed',
        message: `Worktree setup ${command.name} (${command.argv.join(' ')}) ${why}.${tail.length === 0 ? '' : `\n${tail}`}`,
      };
    }
  }
  return { kind: 'ready' };
}
