import { spawnSync } from 'node:child_process';
import path from 'node:path';

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
  const added = git(input.codeRoot, ['worktree', 'add', '-b', branch, worktreePath, 'HEAD']);
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
