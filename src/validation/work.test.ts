import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import type { WorkCommand } from '../config.ts';
import { validationContext } from './fixture.ts';
import { COMMAND_OUTPUT_LIMIT, workValidator } from './work.ts';

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

function validate(input: {
  allowsEmptyDiff: boolean;
  baseSha: string;
  commands: Array<WorkCommand>;
  cwd: string;
}) {
  return workValidator.validate(
    validationContext('work', (snapshot) => {
      snapshot.execution.worktreePath = input.cwd;
      snapshot.execution.worktreeBaseSha = input.baseSha;
      snapshot.execution.policy.validation.work.commands = input.commands;
      // An investigation ticket may end with no diff.
      snapshot.ticket.labels = input.allowsEmptyDiff ? ['investigation'] : [];
    }),
  );
}

test('validation lease covers every command timeout plus the inspection margin', () => {
  const { snapshot } = validationContext('work', (value) => {
    value.execution.policy.validation.work.commands = [
      { argv: ['true'], name: 'lint', timeoutMs: 60_000 },
      { argv: ['true'], name: 'test', timeoutMs: 300_000 },
    ];
  });
  assert.equal(workValidator.leaseMs?.(snapshot), 390_000);
});

test('a work run without a ready worktree is a validator error', async () => {
  const report = await workValidator.validate(
    validationContext('work', (snapshot) => {
      snapshot.execution.worktreeBaseSha = null;
    }),
  );
  assert.equal(report.status, 'error');
  assert.equal(report.summary, 'Worktree is missing.');
});

test('work validation records the real diff and configured commands', async () => {
  const { baseSha, cwd } = repo();
  writeFileSync(path.join(cwd, 'README.md'), '# demo\nchanged\n');
  const passed = await validate({
    allowsEmptyDiff: false,
    baseSha,
    commands: [{ argv: ['node', '-e', 'process.exit(0)'], name: 'tests', timeoutMs: 5000 }],
    cwd,
  });
  assert.equal(passed.status, 'passed');
  if (passed.status !== 'passed') {
    return;
  }
  assert.match(passed.detail.diff, /changed/);
  assert.equal(
    passed.checks.every((check) => check.status === 'passed'),
    true,
  );

  const staged = repo();
  writeFileSync(path.join(staged.cwd, 'staged.txt'), 'staged\n');
  git(staged.cwd, ['add', 'staged.txt']);
  const stagedResult = await validate({
    allowsEmptyDiff: false,
    baseSha: staged.baseSha,
    commands: [],
    cwd: staged.cwd,
  });
  assert.equal(stagedResult.status, 'passed');

  const deleted = repo();
  rmSync(path.join(deleted.cwd, 'README.md'));
  const deletedResult = await validate({
    allowsEmptyDiff: false,
    baseSha: deleted.baseSha,
    commands: [],
    cwd: deleted.cwd,
  });
  assert.equal(deletedResult.status, 'passed');
  if (deletedResult.status === 'passed') {
    assert.match(deletedResult.detail.diff, /README.md/);
  }

  const untracked = repo();
  writeFileSync(path.join(untracked.cwd, 'new.txt'), 'new\n');
  const untrackedResult = await validate({
    allowsEmptyDiff: false,
    baseSha: untracked.baseSha,
    commands: [],
    cwd: untracked.cwd,
  });
  assert.equal(untrackedResult.status, 'passed');
  if (untrackedResult.status === 'passed') {
    assert.match(untrackedResult.detail.diff, /new.txt/);
  }

  // The returned diff is the worktree after the commands, so files they
  // write are part of what the reviewer sees.
  const written = repo();
  writeFileSync(path.join(written.cwd, 'README.md'), '# demo\nchanged\n');
  const writtenResult = await validate({
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
  assert.equal(writtenResult.status, 'passed');
  if (writtenResult.status === 'passed') {
    assert.match(writtenResult.detail.diff, /report.json/);
  }
});

test('empty diffs, whitespace, commits, timeouts, and command results are checks', async () => {
  const empty = repo();
  const emptyResult = await validate({
    allowsEmptyDiff: false,
    baseSha: empty.baseSha,
    commands: [],
    cwd: empty.cwd,
  });
  assert.equal(emptyResult.status, 'failed');
  if (emptyResult.status === 'failed') {
    assert.match(emptyResult.failures.join('\n'), /diff is empty/);
  }

  const investigation = await validate({
    allowsEmptyDiff: true,
    baseSha: empty.baseSha,
    commands: [],
    cwd: empty.cwd,
  });
  assert.equal(investigation.status, 'passed');
  if (investigation.status === 'passed') {
    assert.equal(
      investigation.checks.some((check) => check.name === 'diff'),
      false,
    );
  }

  const dirty = repo();
  writeFileSync(path.join(dirty.cwd, 'README.md'), '# demo \n');
  const whitespace = await validate({
    allowsEmptyDiff: false,
    baseSha: dirty.baseSha,
    commands: [],
    cwd: dirty.cwd,
  });
  assert.equal(whitespace.status, 'failed');
  if (whitespace.status === 'failed') {
    assert.match(whitespace.failures.join('\n'), /git diff --check/);
  }

  const committed = repo();
  writeFileSync(path.join(committed.cwd, 'README.md'), '# committed\n');
  git(committed.cwd, ['add', 'README.md']);
  git(committed.cwd, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'worker commit']);
  const commit = await validate({
    allowsEmptyDiff: false,
    baseSha: committed.baseSha,
    commands: [],
    cwd: committed.cwd,
  });
  assert.equal(commit.status, 'failed');
  if (commit.status === 'failed') {
    assert.match(commit.failures.join('\n'), /unexpected commit/);
  }

  const failing = repo();
  writeFileSync(path.join(failing.cwd, 'README.md'), '# demo\nchanged\n');
  const failedCommand = await validate({
    allowsEmptyDiff: false,
    baseSha: failing.baseSha,
    commands: [{ argv: ['node', '-e', 'process.exit(2)'], name: 'tests', timeoutMs: 5000 }],
    cwd: failing.cwd,
  });
  assert.equal(failedCommand.status, 'failed');
  if (failedCommand.status === 'failed') {
    assert.match(failedCommand.failures.join('\n'), /tests/);
  }

  const timed = await validate({
    allowsEmptyDiff: false,
    baseSha: failing.baseSha,
    commands: [{ argv: ['sleep', '2'], name: 'slow', timeoutMs: 200 }],
    cwd: failing.cwd,
  });
  assert.equal(timed.status, 'failed');
  if (timed.status === 'failed') {
    assert.match(timed.failures.join('\n'), /timed out after 200ms/);
  }

  const allowed = await validate({
    allowsEmptyDiff: false,
    baseSha: failing.baseSha,
    commands: [{ argv: ['sleep', '0.2'], name: 'pause', timeoutMs: 5000 }],
    cwd: failing.cwd,
  });
  assert.equal(allowed.status, 'passed');

  const noisy = await validate({
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
  assert.equal(noisy.status, 'passed');
  if (noisy.status === 'passed') {
    const output = noisy.checks.find((check) => check.name === 'noise')?.outputExcerpt ?? '';
    assert.ok(output.length <= COMMAND_OUTPUT_LIMIT);
    assert.ok(output.length > 0);
  }

  const crashed = await validate({
    allowsEmptyDiff: false,
    baseSha: failing.baseSha,
    commands: [{ argv: ['factory-missing-binary'], name: 'missing', timeoutMs: 5000 }],
    cwd: failing.cwd,
  });
  assert.equal(crashed.status, 'error');
});
