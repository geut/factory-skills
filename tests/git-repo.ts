import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

export const gitEnv = {
  ...process.env,
  GIT_AUTHOR_EMAIL: 'factory@example.com',
  GIT_AUTHOR_NAME: 'Factory',
  GIT_COMMITTER_EMAIL: 'factory@example.com',
  GIT_COMMITTER_NAME: 'Factory',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'commit.gpgsign',
  GIT_CONFIG_VALUE_0: 'false',
};

export function git(cwd: string, args: Array<string>): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
  return result.stdout.trim();
}

// A ticket starts in a worktree, so its code root is a repository with one
// commit on main.
export function initRepo(codeRoot: string): void {
  git(codeRoot, ['init', '-b', 'main']);
  writeFileSync(path.join(codeRoot, 'README.md'), '# demo\n');
  git(codeRoot, ['add', 'README.md']);
  git(codeRoot, ['commit', '-m', 'init']);
}
