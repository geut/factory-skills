import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { WrapupBaseline } from '../domain.ts';
import { carryPassOver } from './rebased.ts';
import { captureWrapupState } from './wrapup.ts';

const dirs: Array<string> = [];
after(() => {
  for (const dir of dirs) {
    rmSync(dir, { force: true, recursive: true });
  }
});

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_EMAIL: 'factory@example.com',
  GIT_AUTHOR_NAME: 'Factory',
  GIT_COMMITTER_EMAIL: 'factory@example.com',
  GIT_COMMITTER_NAME: 'Factory',
};

function git(cwd: string, args: Array<string>): string {
  const result = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: gitEnv,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')}: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function write(cwd: string, file: string, text: string): void {
  mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  writeFileSync(path.join(cwd, file), text);
}

const lines = (count: number, changed: Record<number, string> = {}) =>
  Array.from({ length: count }, (_, index) => changed[index] ?? `line ${index}`).join('\n') + '\n';

// A code root that is its own origin, and a ticket worktree whose work an
// earlier pass committed.
function ticket() {
  const root = mkdtempSync(path.join(tmpdir(), 'factory-rebased-'));
  dirs.push(root);
  const codeRoot = path.join(root, 'code');
  mkdirSync(codeRoot);
  git(codeRoot, ['init', '-qb', 'main']);
  write(codeRoot, 'src/a.ts', lines(20));
  write(codeRoot, 'README.md', '# demo\n');
  git(codeRoot, ['add', '.']);
  git(codeRoot, ['commit', '-qm', 'init']);
  git(codeRoot, ['remote', 'add', 'origin', codeRoot]);
  git(codeRoot, ['fetch', '-q', 'origin']);
  const branched = git(codeRoot, ['rev-parse', 'HEAD']);
  const worktree = path.join(root, 'wt');
  git(codeRoot, ['worktree', 'add', '-qb', 'factory/t', worktree, branched]);
  write(worktree, 'src/a.ts', lines(20, { 2: 'ticket' }));
  write(worktree, 'src/b.ts', 'export const b = 1;\n');
  git(worktree, ['add', '.']);
  git(worktree, ['commit', '-qm', 'Ticket work']);
  return { branched, codeRoot, root, worktree };
}

// The target moves on: `files` new files, and `edit` lines of src/a.ts.
function upstream(codeRoot: string, files: number, edit: Record<number, string> = {}): void {
  for (let index = 0; index < files; index += 1) {
    write(codeRoot, `upstream/file${index}.ts`, `${index}\n`);
  }
  if (Object.keys(edit).length > 0) {
    write(codeRoot, 'src/a.ts', lines(20, edit));
  }
  git(codeRoot, ['add', '.']);
  git(codeRoot, ['commit', '-qm', 'upstream']);
  git(codeRoot, ['fetch', '-q', 'origin']);
}

function capture(value: ReturnType<typeof ticket>, baseSha: string): WrapupBaseline {
  return {
    boxes: [],
    ...captureWrapupState({
      baseBranch: 'main',
      baseSha,
      branch: 'factory/t',
      codeRoot: value.codeRoot,
      factoryRoot: path.join(value.root, 'factory'),
      ticketDir: path.join(value.root, 'factory/tickets/t'),
      worktree: value.worktree,
    }),
    compareBase: null,
  };
}

function carry(value: ReturnType<typeof ticket>, baseline: WrapupBaseline) {
  return carryPassOver({
    baseBranch: 'main',
    baseline,
    branched: value.branched,
    codeRoot: value.codeRoot,
    roundStart: null,
    worktree: value.worktree,
  });
}

test('a pass that started after the rebase drops the target’s paths, keeps its start, and still sees product edits', () => {
  const value = ticket();
  upstream(value.codeRoot, 30);
  git(value.worktree, ['rebase', '-q', 'origin/main']);
  // The pass started after the rebase, against where the ticket branched.
  const legacy = capture(value, value.branched);
  assert.equal(Object.keys(legacy.worktree).length, 32);
  const result = carry(value, legacy);
  assert.equal(result.kind, 'carried');
  if (result.kind !== 'carried') {
    return;
  }
  assert.equal(result.pass.dropped.length, 30);
  assert.deepEqual(result.pass.kept, ['src/a.ts', 'src/b.ts']);
  assert.equal(result.pass.baseline.head, legacy.head);
  assert.equal(result.pass.baseline.compareBase, git(value.codeRoot, ['rev-parse', 'HEAD']));
  // Validation's own capture, against the carried base, matches the pass.
  const current = capture(value, result.pass.baseline.compareBase ?? '');
  assert.deepEqual(current.worktree, result.pass.baseline.worktree);
  // A product edit wrap-up makes still shows against it.
  write(value.worktree, 'src/a.ts', lines(20, { 2: 'ticket', 9: 'wrap-up' }));
  assert.notEqual(
    capture(value, result.pass.baseline.compareBase ?? '').worktree['src/a.ts'],
    result.pass.baseline.worktree['src/a.ts'],
  );
});

test('a pass that started before a clean rebase maps its start onto the rebased commit', () => {
  const value = ticket();
  const before = capture(value, value.branched);
  // The target edits another line of the same file; the rebase merges both.
  upstream(value.codeRoot, 5, { 15: 'upstream' });
  git(value.worktree, ['rebase', '-q', 'origin/main']);
  const result = carry(value, before);
  assert.equal(result.kind, 'carried');
  if (result.kind !== 'carried') {
    return;
  }
  const rebased = git(value.worktree, ['rev-parse', 'HEAD']);
  assert.equal(result.pass.baseline.head, rebased);
  assert.notEqual(result.pass.baseline.head, before.head);
  // The file carries the target's hunk now, and that is not wrap-up's edit.
  const current = capture(value, result.pass.baseline.compareBase ?? '');
  assert.deepEqual(current.worktree, result.pass.baseline.worktree);
});

test('a rebase whose conflict resolution changed a ticket commit is refused, naming it', () => {
  const value = ticket();
  const before = capture(value, value.branched);
  // The target edits the line the ticket edits.
  upstream(value.codeRoot, 1, { 2: 'upstream' });
  spawnSync('git', ['-c', 'commit.gpgsign=false', 'rebase', '-q', 'origin/main'], {
    cwd: value.worktree,
    env: gitEnv,
  });
  write(value.worktree, 'src/a.ts', lines(20, { 2: 'ticket and upstream' }));
  git(value.worktree, ['add', 'src/a.ts']);
  spawnSync(
    'git',
    ['-c', 'commit.gpgsign=false', '-c', 'core.editor=true', 'rebase', '--continue'],
    {
      cwd: value.worktree,
      env: gitEnv,
    },
  );
  const result = carry(value, before);
  assert.equal(result.kind, 'refused');
  assert.match(
    result.kind === 'refused' ? result.message : '',
    /^The rebase changed [0-9a-f]{12} "Ticket work": no commit on the rebased branch makes the same change, so a conflict resolution changed it\./,
  );
});

test('a rebase that changed only a commit’s indentation, which can change what Python does, is refused', () => {
  const value = ticket();
  write(value.worktree, 'calc.py', 'def f(x):\n    if x:\n        y = 1\n    return 2\n');
  git(value.worktree, ['add', 'calc.py']);
  git(value.worktree, ['commit', '-qm', 'Return the result']);
  const before = capture(value, value.branched);
  upstream(value.codeRoot, 3);
  git(value.worktree, ['rebase', '-q', 'origin/main']);
  // The rebase's resolution indented the return: f(False) is None now.
  write(value.worktree, 'calc.py', 'def f(x):\n    if x:\n        y = 1\n        return 2\n');
  git(value.worktree, ['commit', '-q', '--amend', '-a', '--no-edit']);
  const result = carry(value, before);
  assert.equal(result.kind, 'refused');
  assert.match(
    result.kind === 'refused' ? result.message : '',
    /^The rebase changed [0-9a-f]{12} "Return the result": no commit on the rebased branch makes the same change/,
  );
});

test('a feedback round’s start moves with the rebase, so the round’s diff holds only the round’s change', () => {
  const value = ticket();
  // The round started at the pull request's head, and changed one file.
  const roundStart = git(value.worktree, ['rev-parse', 'HEAD']);
  write(value.worktree, 'src/b.ts', 'export const b = 2;\n');
  git(value.worktree, ['commit', '-qam', 'Round 1']);
  const before = capture(value, value.branched);
  upstream(value.codeRoot, 5);
  git(value.worktree, ['rebase', '-q', 'origin/main']);
  // Against the old start, the target's files show up as the round's.
  assert.match(
    git(value.worktree, ['diff', '--name-only', roundStart, 'HEAD']),
    /upstream\/file0\.ts/,
  );
  const result = carryPassOver({
    baseBranch: 'main',
    baseline: before,
    branched: value.branched,
    codeRoot: value.codeRoot,
    roundStart,
    worktree: value.worktree,
  });
  assert.equal(result.kind, 'carried');
  const moved = result.kind === 'carried' ? (result.pass.roundStart ?? '') : '';
  assert.notEqual(moved, roundStart);
  assert.equal(git(value.worktree, ['diff', '--name-only', moved, 'HEAD']), 'src/b.ts');
  // The worktree's round-base ref follows it.
  assert.equal(git(value.worktree, ['rev-parse', 'refs/worktree/factory/round-base']), moved);
});
