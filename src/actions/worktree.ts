import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { WorkCommand } from '../config.ts';
import { runCommand } from '../validation/work.ts';
import { archiveLeftoverDir, archivePath } from './leftovers.ts';

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
  // Set on the execution's first attempt: a worktree or branch already there
  // is a forgotten run's, and moves to the archive under this stamp. On a
  // retry it is null, and the worktree the first attempt made is reused.
  leftoverStamp: string | null;
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
  if (input.leftoverStamp !== null) {
    const archived = archiveLeftovers({
      branch,
      codeRoot: input.codeRoot,
      factoryRoot: input.factoryRoot,
      stamp: input.leftoverStamp,
      worktreePath,
    });
    if (archived !== null) {
      return { kind: 'failed', message: archived };
    }
  }
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

// Moves a forgotten run's worktree to the archive, keeping its changes, and
// renames its branch out of the way. Returns an error message, or null.
function archiveLeftovers(input: {
  branch: string;
  codeRoot: string;
  factoryRoot: string;
  stamp: string;
  worktreePath: string;
}): string | null {
  if (existsSync(input.worktreePath)) {
    const destination = archivePath(input.factoryRoot, input.stamp, input.worktreePath);
    mkdirSync(path.dirname(destination), { recursive: true });
    const moved = git(input.codeRoot, ['worktree', 'move', input.worktreePath, destination]);
    if (moved.code !== 0) {
      // Not a registered worktree: a plain directory moves as is.
      try {
        archiveLeftoverDir({
          dir: input.worktreePath,
          factoryRoot: input.factoryRoot,
          stamp: input.stamp,
        });
      } catch (error: unknown) {
        return `Cannot move the leftover worktree ${input.worktreePath} aside: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  }
  const branchExists =
    git(input.codeRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${input.branch}`]).code ===
    0;
  if (branchExists) {
    const renamed = git(input.codeRoot, [
      'branch',
      '-m',
      input.branch,
      `${input.branch}-archived-${input.stamp}`,
    ]);
    if (renamed.code !== 0) {
      return `Cannot rename the leftover branch ${input.branch}: ${renamed.stderr.trim()}`;
    }
  }
  return null;
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
