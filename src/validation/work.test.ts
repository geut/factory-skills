import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import type { WorkCommand } from '../config.ts';
import { taskId } from '../domain.ts';
import { validationContext } from './fixture.ts';
import { collectWorkDiff, COMMAND_OUTPUT_LIMIT, workValidator } from './work.ts';

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

test('empty diffs, commits, timeouts, and command results are checks, and whitespace is not', async () => {
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
  // Whitespace is the ticket's business, not a factory rule.
  assert.equal(whitespace.status, 'passed');
  assert.equal(
    whitespace.checks.some((check) => check.name === 'git diff --check'),
    false,
  );

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

test('an untracked OS metadata file is not part of the work diff, and a tracked one is', () => {
  const { cwd } = repo();
  writeFileSync(path.join(cwd, 'notes.md'), 'new\n');
  writeFileSync(path.join(cwd, '.DS_Store'), 'finder');
  writeFileSync(path.join(cwd, '._notes.md'), 'apple double');
  const untracked = collectWorkDiff(cwd);
  const diff = 'diff' in untracked ? untracked.diff : '';
  assert.match(diff, /notes\.md/);
  assert.doesNotMatch(diff, /DS_Store|\._notes/);
  git(cwd, ['add', '.DS_Store']);
  const tracked = collectWorkDiff(cwd);
  assert.match('diff' in tracked ? tracked.diff : '', /\.DS_Store/);
});

test('a feedback round works on top of the round start, and its reply answers every item', async () => {
  const { baseSha, cwd } = repo();
  // Wrap-up committed the first pass; the round starts from that commit.
  writeFileSync(path.join(cwd, 'README.md'), '# demo\nfirst pass\n');
  git(cwd, ['-c', 'commit.gpgsign=false', 'commit', '-qam', 'first pass']);
  const roundBase = git(cwd, ['rev-parse', 'HEAD']);
  writeFileSync(path.join(cwd, 'README.md'), '# demo\nfirst pass\nround one\n');
  mkdirSync(path.join(cwd, '.ticket', 'feedback', '1'), { recursive: true });
  writeFileSync(
    path.join(cwd, '.ticket', 'feedback', '1', 'task.md'),
    "# Feedback round 1\n\n## Acceptance criteria\n\n- [ ] F1: comment (alice): Rename it.\n- [ ] F2: the operator's note: Explain it.\n",
  );
  const round = (output: string, roundBaseSha: string | null) =>
    workValidator.validate(
      validationContext('work', (snapshot, finished, owner) => {
        snapshot.execution.worktreePath = cwd;
        snapshot.execution.worktreeBaseSha = baseSha;
        snapshot.execution.roundBaseSha = roundBaseSha;
        snapshot.execution.factoryDir = path.join(cwd, '.ticket');
        owner.taskId = taskId('F1');
        snapshot.tasks.push({
          blockedBy: [],
          feedback: null,
          ordinal: 2,
          specHash: null,
          stage: 'work',
          status: 'active',
          summaries: {},
          taskFile: 'feedback/1/task.md',
          taskId: taskId('F1'),
          title: 'Feedback round 1',
        });
        finished.resultJson = JSON.stringify({ output });
      }),
    );
  const answered =
    '## Feedback responses\n\n- F1: addressed — renamed it\n- F2: declined — the docs already say so\n';
  const passed = await round(answered, roundBase);
  assert.equal(passed.status, 'passed', passed.status === 'failed' ? passed.summary : '');
  assert.ok(passed.checks.some((check) => check.name === 'feedback responses'));
  // Without the round start, the first pass's commit is one work made.
  const committed = await round(answered, null);
  assert.match(committed.status === 'failed' ? committed.summary : '', /unexpected commit/);
  const unanswered = await round(
    '## Feedback responses\n\n- F1: addressed — renamed it\n',
    roundBase,
  );
  assert.match(
    unanswered.status === 'failed' ? unanswered.summary : '',
    /## Feedback responses has no line for F2/,
  );
});
