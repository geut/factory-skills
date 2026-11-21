import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { blank } from '../stories/fixtures.ts';
import { cleanUpTicket, needsAttention, outcomeLine } from './cleanup.ts';
import type { ProcessInfo } from './strays.ts';

const roots: Array<string> = [];
after(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
});

function git(cwd: string, args: Array<string>): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
  return result.stdout.trim();
}

const branch = 'factory/proj-1';

// A code root with a remote, and a completed ticket's worktree on its branch:
// clean, with ignored dependencies in it, as a run leaves it.
function completed() {
  const codeRoot = mkdtempSync(path.join(tmpdir(), 'factory-cleanup-'));
  roots.push(codeRoot);
  const remote = `${codeRoot}-remote.git`;
  roots.push(remote);
  git(codeRoot, ['init', '-b', 'main']);
  git(codeRoot, ['config', 'user.email', 'factory@example.com']);
  git(codeRoot, ['config', 'user.name', 'Factory']);
  writeFileSync(path.join(codeRoot, '.gitignore'), 'node_modules/\n.factory/\n');
  writeFileSync(path.join(codeRoot, 'README.md'), '# demo\n');
  git(codeRoot, ['add', '.']);
  git(codeRoot, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'init']);
  git(codeRoot, ['init', '--bare', remote]);
  git(codeRoot, ['remote', 'add', 'origin', remote]);
  const baseSha = git(codeRoot, ['rev-parse', 'HEAD']);
  const factoryRoot = path.join(codeRoot, '.factory');
  const worktree = path.join(factoryRoot, 'worktrees/proj-1');
  git(codeRoot, ['worktree', 'add', '-b', branch, worktree, 'main']);
  mkdirSync(path.join(worktree, 'node_modules/left-pad'), { recursive: true });
  writeFileSync(path.join(worktree, 'node_modules/left-pad/index.js'), 'module.exports = 1;\n');
  // The ticket's commit, handed off.
  writeFileSync(path.join(worktree, 'filter.ts'), 'export const filter = 1;\n');
  git(worktree, ['add', 'filter.ts']);
  git(worktree, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'feat: filter']);
  const snapshot = blank();
  snapshot.execution.factoryDir = path.join(factoryRoot, 'tickets/proj-1');
  snapshot.execution.policy.codeRoot = codeRoot;
  snapshot.execution.stage = 'done';
  snapshot.execution.status = 'complete';
  snapshot.execution.worktreeBaseSha = baseSha;
  snapshot.execution.worktreeBranch = branch;
  snapshot.execution.worktreePath = worktree;
  return { codeRoot, snapshot, worktree };
}

const none = (): Array<ProcessInfo> => [];

function cleanUp(
  value: ReturnType<typeof completed>,
  options: {
    commits?: Array<string>;
    dryRun?: boolean;
    processes?: () => Array<ProcessInfo>;
  } = {},
) {
  return cleanUpTicket({
    dryRun: options.dryRun ?? false,
    processes: options.processes ?? none,
    pullRequestCommits: new Set(options.commits ?? []),
    snapshot: value.snapshot,
  });
}

const hasBranch = (codeRoot: string) =>
  spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: codeRoot })
    .status === 0;

test('a handed-off ticket loses its worktree, dependencies and all, and its local branch; the remote keeps it', async () => {
  const value = completed();
  git(value.worktree, ['push', 'origin', branch]);
  const outcome = await cleanUp(value);
  assert.deepEqual([outcome.worktree.kind, outcome.branch.kind], ['removed', 'removed']);
  assert.equal(existsSync(value.worktree), false);
  assert.equal(hasBranch(value.codeRoot), false);
  assert.equal(git(value.codeRoot, ['ls-remote', 'origin', branch]).length > 0, true);
  assert.equal(needsAttention(outcome), false);
  assert.match(
    outcomeLine(outcome) ?? '',
    /^dpaez\/factory-dashboard#11: removed worktree .*proj-1; removed branch factory\/proj-1\.$/,
  );
  // Running it again finds nothing left.
  const again = await cleanUp(value);
  assert.deepEqual([again.worktree.kind, again.branch.kind], ['gone', 'gone']);
  assert.equal(outcomeLine(again), null);
});

test('a merged pull request whose remote branch is gone still counts as handed off', async () => {
  const value = completed();
  const tip = git(value.worktree, ['rev-parse', 'HEAD']);
  const outcome = await cleanUp(value, { commits: [tip] });
  assert.deepEqual([outcome.worktree.kind, outcome.branch.kind], ['removed', 'removed']);
});

test('commits on no remote and in no merged pull request keep the branch, though the worktree goes', async () => {
  const value = completed();
  const outcome = await cleanUp(value);
  assert.equal(outcome.worktree.kind, 'removed');
  assert.deepEqual(outcome.branch, {
    kind: 'kept',
    reason: '1 commit is on no remote branch and not in a merged pull request',
  });
  assert.equal(hasBranch(value.codeRoot), true);
  assert.equal(needsAttention(outcome), true);
});

test('changes no commit holds keep the worktree and its branch', async () => {
  const value = completed();
  git(value.worktree, ['push', 'origin', branch]);
  writeFileSync(path.join(value.worktree, 'filter.ts'), 'export const filter = 2;\n');
  writeFileSync(path.join(value.worktree, 'notes.md'), 'mine\n');
  const outcome = await cleanUp(value);
  assert.deepEqual(outcome.worktree, {
    kind: 'kept',
    reason: 'it has changes no commit holds: filter.ts, notes.md',
  });
  assert.deepEqual(outcome.branch, { kind: 'kept', reason: 'its worktree is kept' });
  assert.equal(existsSync(path.join(value.worktree, 'notes.md')), true);
  assert.equal(hasBranch(value.codeRoot), true);
});

test('a process still running in the worktree keeps it', async () => {
  const value = completed();
  git(value.worktree, ['push', 'origin', branch]);
  const processes = (): Array<ProcessInfo> => [
    { command: 'node server.js', cwd: value.worktree, factoryWorktree: null, pid: 4242, ppid: 1 },
  ];
  const outcome = await cleanUp(value, { processes });
  assert.deepEqual(outcome.worktree, {
    kind: 'kept',
    reason: 'a process still runs in it: node server.js (pid 4242)',
  });
  assert.equal(existsSync(value.worktree), true);
});

test('a dry run says what would go and changes nothing', async () => {
  const value = completed();
  git(value.worktree, ['push', 'origin', branch]);
  const outcome = await cleanUp(value, { dryRun: true });
  assert.deepEqual([outcome.worktree.kind, outcome.branch.kind], ['would_remove', 'would_remove']);
  assert.equal(existsSync(value.worktree), true);
  assert.equal(hasBranch(value.codeRoot), true);
});

test('a worktree removed by hand frees its branch for the cleanup', async () => {
  const value = completed();
  git(value.worktree, ['push', 'origin', branch]);
  rmSync(value.worktree, { force: true, recursive: true });
  const outcome = await cleanUp(value);
  assert.deepEqual([outcome.worktree.kind, outcome.branch.kind], ['gone', 'removed']);
});

test('only a worktree the factory made, under its worktrees directory, is ever removed', async () => {
  const value = completed();
  const elsewhere = path.join(value.codeRoot, 'elsewhere');
  git(value.codeRoot, ['worktree', 'add', '-b', 'factory/elsewhere', elsewhere, 'main']);
  value.snapshot.execution.worktreePath = elsewhere;
  value.snapshot.execution.worktreeBranch = 'factory/elsewhere';
  const outcome = await cleanUp(value);
  assert.equal(outcome.worktree.kind, 'kept');
  assert.match(outcome.worktree.kind === 'kept' ? outcome.worktree.reason : '', /is outside/);
  assert.equal(existsSync(elsewhere), true);
});
