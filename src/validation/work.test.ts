import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { COMMAND_OUTPUT_LIMIT, validateWork, validationLeaseMs } from './work.ts';

const roots: Array<string> = [];
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_EMAIL: 'factory@example.com',
  GIT_AUTHOR_NAME: 'Factory',
  GIT_COMMITTER_EMAIL: 'factory@example.com',
  GIT_COMMITTER_NAME: 'Factory',
};

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) {
      rmSync(root, { force: true, recursive: true });
    }
  }
});

function git(cwd: string, args: Array<string>): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
  return (result.stdout ?? '').trim();
}

function repo(): { baseSha: string; cwd: string } {
  const cwd = mkdtempSync(path.join(process.cwd(), '.scratch-work-validation-'));
  roots.push(cwd);
  git(cwd, ['init', '-b', 'main']);
  writeFileSync(path.join(cwd, 'README.md'), '# demo\n');
  git(cwd, ['add', 'README.md']);
  git(cwd, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'init']);
  return { baseSha: git(cwd, ['rev-parse', 'HEAD']), cwd };
}

test('validation lease covers every command timeout plus the inspection margin', () => {
  assert.equal(validationLeaseMs([{ timeoutMs: 60_000 }, { timeoutMs: 300_000 }]), 390_000);
});

test('work validation records the real diff and configured commands', async () => {
  const { baseSha, cwd } = repo();
  writeFileSync(path.join(cwd, 'README.md'), '# demo\nchanged\n');
  const passed = await validateWork({
    allowsEmptyDiff: false,
    baseSha,
    commands: [{ argv: ['node', '-e', 'process.exit(0)'], name: 'tests', timeoutMs: 5000 }],
    cwd,
  });
  assert.equal(passed.kind, 'passed');
  if (passed.kind !== 'passed') {
    return;
  }
  assert.match(passed.diff, /changed/);
  assert.equal(
    passed.checks.every((check) => check.status === 'passed'),
    true,
  );

  const staged = repo();
  writeFileSync(path.join(staged.cwd, 'staged.txt'), 'staged\n');
  git(staged.cwd, ['add', 'staged.txt']);
  const stagedResult = await validateWork({
    allowsEmptyDiff: false,
    baseSha: staged.baseSha,
    commands: [],
    cwd: staged.cwd,
  });
  assert.equal(stagedResult.kind, 'passed');

  const deleted = repo();
  rmSync(path.join(deleted.cwd, 'README.md'));
  const deletedResult = await validateWork({
    allowsEmptyDiff: false,
    baseSha: deleted.baseSha,
    commands: [],
    cwd: deleted.cwd,
  });
  assert.equal(deletedResult.kind, 'passed');
  if (deletedResult.kind === 'passed') {
    assert.match(deletedResult.diff, /README.md/);
  }

  const untracked = repo();
  writeFileSync(path.join(untracked.cwd, 'new.txt'), 'new\n');
  const untrackedResult = await validateWork({
    allowsEmptyDiff: false,
    baseSha: untracked.baseSha,
    commands: [],
    cwd: untracked.cwd,
  });
  assert.equal(untrackedResult.kind, 'passed');
  if (untrackedResult.kind === 'passed') {
    assert.match(untrackedResult.diff, /new.txt/);
  }

  // The returned diff is the worktree after the commands, so files they
  // write are part of what the reviewer sees.
  const written = repo();
  writeFileSync(path.join(written.cwd, 'README.md'), '# demo\nchanged\n');
  const writtenResult = await validateWork({
    allowsEmptyDiff: false,
    baseSha: written.baseSha,
    commands: [
      {
        argv: ['node', '-e', "require('node:fs').writeFileSync('report.json', '{}')"],
        name: 'tests',
        timeoutMs: 5000,
      },
    ],
    cwd: written.cwd,
  });
  assert.equal(writtenResult.kind, 'passed');
  if (writtenResult.kind === 'passed') {
    assert.match(writtenResult.diff, /report.json/);
  }
});

test('empty diffs, whitespace, commits, timeouts, and command results are checks', async () => {
  const empty = repo();
  const emptyResult = await validateWork({
    allowsEmptyDiff: false,
    baseSha: empty.baseSha,
    commands: [],
    cwd: empty.cwd,
  });
  assert.equal(emptyResult.kind, 'failed');
  if (emptyResult.kind === 'failed') {
    assert.match(emptyResult.failures.join('\n'), /diff is empty/);
  }

  const investigation = await validateWork({
    allowsEmptyDiff: true,
    baseSha: empty.baseSha,
    commands: [],
    cwd: empty.cwd,
  });
  assert.equal(investigation.kind, 'passed');
  if (investigation.kind === 'passed') {
    assert.equal(
      investigation.checks.some((check) => check.name === 'diff'),
      false,
    );
  }

  const dirty = repo();
  writeFileSync(path.join(dirty.cwd, 'README.md'), '# demo \n');
  const whitespace = await validateWork({
    allowsEmptyDiff: false,
    baseSha: dirty.baseSha,
    commands: [],
    cwd: dirty.cwd,
  });
  assert.equal(whitespace.kind, 'failed');
  if (whitespace.kind === 'failed') {
    assert.match(whitespace.failures.join('\n'), /git diff --check/);
  }

  const committed = repo();
  writeFileSync(path.join(committed.cwd, 'README.md'), '# committed\n');
  git(committed.cwd, ['add', 'README.md']);
  git(committed.cwd, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'worker commit']);
  const commit = await validateWork({
    allowsEmptyDiff: false,
    baseSha: committed.baseSha,
    commands: [],
    cwd: committed.cwd,
  });
  assert.equal(commit.kind, 'failed');
  if (commit.kind === 'failed') {
    assert.match(commit.failures.join('\n'), /unexpected commit/);
  }

  const failing = repo();
  writeFileSync(path.join(failing.cwd, 'README.md'), '# demo\nchanged\n');
  const failedCommand = await validateWork({
    allowsEmptyDiff: false,
    baseSha: failing.baseSha,
    commands: [{ argv: ['node', '-e', 'process.exit(2)'], name: 'tests', timeoutMs: 5000 }],
    cwd: failing.cwd,
  });
  assert.equal(failedCommand.kind, 'failed');
  if (failedCommand.kind === 'failed') {
    assert.match(failedCommand.failures.join('\n'), /tests/);
  }

  const timed = await validateWork({
    allowsEmptyDiff: false,
    baseSha: failing.baseSha,
    commands: [{ argv: ['sleep', '2'], name: 'slow', timeoutMs: 200 }],
    cwd: failing.cwd,
  });
  assert.equal(timed.kind, 'failed');
  if (timed.kind === 'failed') {
    assert.match(timed.failures.join('\n'), /timed out after 200ms/);
  }

  const allowed = await validateWork({
    allowsEmptyDiff: false,
    baseSha: failing.baseSha,
    commands: [{ argv: ['sleep', '0.2'], name: 'pause', timeoutMs: 5000 }],
    cwd: failing.cwd,
  });
  assert.equal(allowed.kind, 'passed');

  const noisy = await validateWork({
    allowsEmptyDiff: false,
    baseSha: failing.baseSha,
    commands: [
      {
        argv: ['node', '-e', 'process.stdout.write("x".repeat(100000))'],
        name: 'noise',
        timeoutMs: 5000,
      },
    ],
    cwd: failing.cwd,
  });
  assert.equal(noisy.kind, 'passed');
  if (noisy.kind === 'passed') {
    const output = noisy.checks.find((check) => check.name === 'noise')?.outputExcerpt ?? '';
    assert.ok(output.length <= COMMAND_OUTPUT_LIMIT);
    assert.ok(output.length > 0);
  }

  const crashed = await validateWork({
    allowsEmptyDiff: false,
    baseSha: failing.baseSha,
    commands: [{ argv: ['factory-missing-binary'], name: 'missing', timeoutMs: 5000 }],
    cwd: failing.cwd,
  });
  assert.equal(crashed.kind, 'error');
});
