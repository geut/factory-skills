import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { WorkCommand } from '../config.ts';
import type { SelectedTest } from './selection.ts';

// What work validation's commands depend on, as one hash: a pass the worker
// asked for while it iterated counts at submission only when the inputs are
// the same. It covers what git can see in the worktree, the factory root's
// `scripts/` (where a project keeps its own validation scripts), and how the
// commands are run. Ignored files, such as installed dependencies, are not
// covered; a pass is only reused within the run that asked for it.

// The factory root's directory of a project's own validation scripts.
export const SCRIPTS_DIR = 'scripts';

export type FingerprintInput = {
  // Where the worktree's changes begin for this round: they are compared
  // with it.
  base: string;
  commands: Array<WorkCommand>;
  executionId: string;
  factoryRoot: string;
  // The worker's focused tests, as the commands get them.
  selection: Array<SelectedTest>;
  validatorVersion: string;
  version: string;
  worktree: string;
};

type Git = { code: number; stderr: string; stdout: Buffer };

function git(cwd: string, args: Array<string>): Git {
  const result = spawnSync('git', args, { cwd, maxBuffer: 1024 * 1024 * 1024 });
  return {
    code: result.status ?? 1,
    stderr: result.stderr?.toString('utf8').trim() || result.error?.message || '',
    stdout: result.stdout ?? Buffer.alloc(0),
  };
}

function fileHash(file: string): string {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return 'unreadable';
  }
}

// Every file under `dir`, as `relative path → content hash`, sorted.
function treeHashes(dir: string): Array<string> {
  const out: Array<string> = [];
  const walk = (current: string, prefix: string) => {
    let entries: Array<string>;
    try {
      entries = readdirSync(current).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      const full = path.join(current, name);
      const relative = prefix === '' ? name : `${prefix}/${name}`;
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full, relative);
      } else if (stat.isFile()) {
        out.push(`${relative} ${fileHash(full)} ${stat.mode & 0o777}`);
      }
    }
  };
  walk(dir, '');
  return out;
}

// The inputs' hash, or why git could not read them: never a guess.
export function workFingerprint(
  input: FingerprintInput,
): { fingerprint: string } | { error: string } {
  const { worktree } = input;
  const head = git(worktree, ['rev-parse', 'HEAD']);
  if (head.code !== 0) {
    return { error: `Cannot read HEAD: ${head.stderr}` };
  }
  // Staged and unstaged changes, deletions included, as the files stand.
  const diff = git(worktree, ['diff', '--binary', '--no-color', '--no-ext-diff', 'HEAD']);
  if (diff.code !== 0) {
    return { error: `Cannot read the worktree's changes: ${diff.stderr}` };
  }
  const untracked = git(worktree, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (untracked.code !== 0) {
    return { error: `Cannot list untracked files: ${untracked.stderr}` };
  }
  const hash = createHash('sha256');
  const part = (name: string, value: string | Buffer) => {
    hash.update(`${name}\0`);
    hash.update(value);
    hash.update('\0');
  };
  part('execution', input.executionId);
  part('worktree', path.resolve(worktree));
  part('head', head.stdout.toString('utf8').trim());
  part('base', input.base);
  part('diff', diff.stdout);
  for (const file of untracked.stdout
    .toString('utf8')
    .split('\0')
    .filter((name) => name.length > 0)
    .sort()) {
    part('untracked', `${file} ${fileHash(path.join(worktree, file))}`);
  }
  for (const entry of treeHashes(path.join(input.factoryRoot, SCRIPTS_DIR))) {
    part('script', entry);
  }
  part('commands', JSON.stringify(input.commands));
  part('selection', JSON.stringify(input.selection));
  part('validator', input.validatorVersion);
  part('version', input.version);
  return { fingerprint: hash.digest('hex') };
}
