import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import type { WorkCommand } from '../config.ts';
import { taskId } from '../domain.ts';
import { renderMissingReport } from '../runtime/work-report.ts';
import { addTasks } from '../stories/fixtures.ts';
import { ROUND_BASE_REF, TARGET_REF } from './bases.ts';
import { VALIDATION_LOGS, VALIDATION_LOGS_ENV } from './command-env.ts';
import { validationContext } from './fixture.ts';
import { SELECTION_ENV } from './selection.ts';
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
    assert.match(commit.failures.join('\n'), /HEAD is at [0-9a-f]{40}, not the round's start/);
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

test('a feedback round works on top of the round start, and may change nothing', async () => {
  const { baseSha, cwd } = repo();
  // Wrap-up committed the first pass; the round starts from that commit.
  writeFileSync(path.join(cwd, 'README.md'), '# demo\nfirst pass\n');
  git(cwd, ['-c', 'commit.gpgsign=false', 'commit', '-qam', 'first pass']);
  const roundBase = git(cwd, ['rev-parse', 'HEAD']);
  writeFileSync(path.join(cwd, 'README.md'), '# demo\nfirst pass\nround one\n');
  // The ticket directory lives outside the worktree, as the factory root's does.
  const ticketDir = mkdtempSync(path.join(process.cwd(), '.scratch-work-ticket-'));
  roots.push(ticketDir);
  mkdirSync(path.join(ticketDir, 'feedback', '1'), { recursive: true });
  writeFileSync(
    path.join(ticketDir, 'feedback', '1', 'task.md'),
    "# Feedback round 1\n\n## Acceptance criteria\n\n- [ ] F1: comment (alice): Rename it.\n- [ ] F2: the operator's note: Explain it.\n",
  );
  const round = (output: string, roundBaseSha: string | null) =>
    workValidator.validate(
      validationContext('work', (snapshot, finished, owner) => {
        snapshot.execution.worktreePath = cwd;
        snapshot.execution.worktreeBaseSha = baseSha;
        snapshot.execution.roundBaseSha = roundBaseSha;
        snapshot.execution.factoryDir = ticketDir;
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
  // The worker's answers are review's to judge; work passes on its diff.
  const passed = await round('## Summary\n\nRenamed it.\n', roundBase);
  assert.equal(passed.status, 'passed', passed.status === 'failed' ? passed.summary : '');
  // Without the round start, the first pass's commit is one work made.
  const committed = await round('', null);
  assert.match(
    committed.status === 'failed' ? committed.summary : '',
    /HEAD is at [0-9a-f]{40}, not the round's start/,
  );
  // A round may decline every item and change nothing.
  git(cwd, ['checkout', '--', 'README.md']);
  const empty = await round('', roundBase);
  assert.equal(empty.status, 'passed', empty.status === 'failed' ? empty.summary : '');
  assert.equal(empty.status === 'passed' ? empty.detail.diff : null, '');
});

test('work validation reports each command as it starts', async () => {
  const { baseSha, cwd } = repo();
  writeFileSync(path.join(cwd, 'change.txt'), 'changed\n');
  const reported: Array<string> = [];
  const commands: Array<WorkCommand> = ['lint', 'test', 'check'].map((name) => ({
    argv: ['node', '-e', ''],
    name,
    timeoutMs: 10_000,
  }));
  await workValidator.validate(
    validationContext(
      'work',
      (snapshot) => {
        snapshot.execution.worktreePath = cwd;
        snapshot.execution.worktreeBaseSha = baseSha;
        snapshot.execution.policy.validation.work.commands = commands;
      },
      {
        reportCommand: (progress) => {
          reported.push(
            progress === null ? 'none' : `${progress.command} ${progress.index}/${progress.total}`,
          );
        },
      },
    ),
  );
  assert.deepEqual(reported, ['lint 1/3', 'test 2/3', 'check 3/3']);
});

// Work validation of a run whose reply is `output`, with one command that
// writes the selection it was given to a file outside the worktree.
async function validateReply(output: string) {
  const { baseSha, cwd } = repo();
  mkdirSync(path.join(cwd, 'tests'));
  writeFileSync(path.join(cwd, 'tests', 'filter.test.ts'), 'test\n');
  writeFileSync(path.join(cwd, 'README.md'), '# demo\nchanged\n');
  const seen = path.join(mkdtempSync(path.join(process.cwd(), '.scratch-selection-')), 'seen.txt');
  roots.push(path.dirname(seen));
  // A factory root beside the worktree, as in a real factory.
  const factoryRoot = path.join(path.dirname(seen), '.factory');
  mkdirSync(factoryRoot);
  const report = await workValidator.validate(
    validationContext('work', (snapshot, finished) => {
      addTasks(snapshot, 1);
      snapshot.execution.factoryDir = path.join(factoryRoot, 'tickets/demo');
      snapshot.execution.worktreePath = cwd;
      snapshot.execution.worktreeBaseSha = baseSha;
      snapshot.execution.policy.validation.work.commands = [
        {
          argv: [
            'node',
            '-e',
            `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(seen)}, process.env.${SELECTION_ENV} ?? 'unset'); fs.writeFileSync(${JSON.stringify(`${seen}.logs`)}, String(process.env.${VALIDATION_LOGS_ENV}) + ' ' + fs.existsSync(process.env.${VALIDATION_LOGS_ENV} ?? ''))`,
          ],
          name: 'tests',
          timeoutMs: 5000,
        },
      ];
      finished.resultJson = JSON.stringify({ output });
    }),
  );
  return {
    factoryRoot,
    logs: existsSync(`${seen}.logs`) ? readFileSync(`${seen}.logs`, 'utf8') : null,
    report,
    seen: existsSync(seen) ? readFileSync(seen, 'utf8') : null,
  };
}

test('the worker’s selection reaches the commands as JSON, and the report lists it', async () => {
  const { report, seen } = await validateReply(
    '## Validation selection\n\n- `tests/filter.test.ts`: checks disabled entries are excluded\n',
  );
  assert.equal(report.status, 'passed');
  assert.deepEqual(JSON.parse(seen ?? ''), {
    tests: [{ path: 'tests/filter.test.ts', reason: 'checks disabled entries are excluded' }],
    version: 1,
  });
  assert.equal(
    report.checks.find((check) => check.name === 'validation selection')?.details,
    `${SELECTION_ENV} lists 1 test file: tests/filter.test.ts`,
  );
});

test('a reply without the section runs the commands as before, with no selection', async () => {
  const { report, seen } = await validateReply('## Status\n\nready_for_review\n');
  assert.equal(report.status, 'passed');
  assert.equal(seen, 'unset');
  assert.equal(
    report.checks.some((check) => check.name === 'validation selection'),
    false,
  );
});

test('a malformed or missing selection is corrected before any command runs', async () => {
  const malformed = await validateReply('## Validation selection\n\n- tests/filter.test.ts\n');
  assert.equal(malformed.report.status, 'failed');
  assert.match(
    malformed.report.status === 'failed' ? malformed.report.failures.join('\n') : '',
    /is not an entry\. Under ## Validation selection, write one line per test file/,
  );
  assert.equal(malformed.seen, null);
  // The section is optional: the correction says how to drop it.
  assert.match(
    malformed.report.status === 'failed' ? malformed.report.failures.join('\n') : '',
    /The selection is optional: write the section again with the lines fixed, or with `none` alone, so the validator uses its default behavior/,
  );

  const missing = await validateReply('## Validation selection\n\n- `tests/gone.test.ts`: gone\n');
  assert.match(
    missing.report.status === 'failed' ? missing.report.failures.join('\n') : '',
    /tests\/gone\.test\.ts is not a file in the worktree/,
  );
  assert.equal(missing.seen, null);
});

test('a run that ended without a report is corrected before any command runs', async () => {
  const { report, seen } = await validateReply(
    renderMissingReport(
      'Report refused; the session goes on.\n- summary: one sentence for the observable result.',
    ),
  );
  assert.equal(report.status, 'failed');
  assert.equal(seen, null);
  const failures = report.status === 'failed' ? report.failures.join('\n') : '';
  assert.match(failures, /The run ended without a report/);
  assert.match(failures, /- summary: one sentence for the observable result\./);
  assert.match(failures, /Call subagent_done with your report as its arguments/);
});

test("a command compares through the worktree's refs, which the target's moving tip never shifts", async () => {
  const { baseSha, cwd } = repo();
  git(cwd, ['remote', 'add', 'origin', cwd]);
  // The target moves on after the ticket branched: another ticket's start, or
  // any fetch, updates the shared origin/main.
  git(cwd, ['checkout', '-qb', 'upstream']);
  writeFileSync(path.join(cwd, 'routes.py'), 'urlpatterns = []\n');
  git(cwd, ['add', 'routes.py']);
  git(cwd, ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'reorganize routes']);
  git(cwd, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  git(cwd, ['checkout', '-q', 'main']);
  // The ticket's own, uncommitted change.
  writeFileSync(path.join(cwd, 'README.md'), '# demo\nchanged\n');
  const seen = path.join(mkdtempSync(path.join(process.cwd(), '.scratch-bases-')), 'seen');
  roots.push(path.dirname(seen));
  const script = [
    `git rev-parse ${ROUND_BASE_REF} > ${JSON.stringify(`${seen}.round`)}`,
    `git diff --name-only "$(git merge-base HEAD ${TARGET_REF})" > ${JSON.stringify(`${seen}.ticket`)}`,
    `git diff --name-only origin/main > ${JSON.stringify(`${seen}.tip`)}`,
  ].join(' && ');
  const report = await workValidator.validate(
    validationContext('work', (snapshot) => {
      snapshot.execution.worktreePath = cwd;
      snapshot.execution.worktreeBaseSha = baseSha;
      snapshot.execution.worktreeBaseBranch = 'main';
      snapshot.execution.policy.validation.work.commands = [
        { argv: ['sh', '-c', script], name: 'placement', timeoutMs: 5000 },
      ];
    }),
  );
  assert.equal(report.status, 'passed');
  assert.equal(readFileSync(`${seen}.round`, 'utf8').trim(), baseSha);
  // Through the refs: the ticket's change only.
  assert.equal(readFileSync(`${seen}.ticket`, 'utf8').trim(), 'README.md');
  // Against the moving tip, the upstream route change shows up as the ticket's.
  assert.match(readFileSync(`${seen}.tip`, 'utf8'), /routes\.py/);
});

test('a worker that moved HEAD off the round base is corrected; one with no history in common with the target runs no command', async () => {
  const { baseSha, cwd } = repo();
  writeFileSync(path.join(cwd, 'README.md'), '# demo\nchanged\n');
  // A commit the branch does not descend from, as the worker's own rebase
  // leaves the round's start behind.
  const elsewhere = git(cwd, ['commit-tree', 'HEAD^{tree}', '-m', 'elsewhere']);
  const moved = await validate({ allowsEmptyDiff: false, baseSha: elsewhere, commands: [], cwd });
  assert.equal(moved.status, 'failed');
  assert.match(
    moved.status === 'failed' ? moved.failures.join('\n') : '',
    /uncommitted: HEAD is at [0-9a-f]{40}, not the round's start [0-9a-f]{40}: leave the work uncommitted/,
  );

  // A target the branch shares no history with.
  git(cwd, ['remote', 'add', 'origin', cwd]);
  git(cwd, ['update-ref', 'refs/remotes/origin/main', elsewhere]);
  const seen = path.join(mkdtempSync(path.join(process.cwd(), '.scratch-bases-')), 'seen');
  roots.push(path.dirname(seen));
  const unrelated = await workValidator.validate(
    validationContext('work', (snapshot) => {
      snapshot.execution.worktreePath = cwd;
      snapshot.execution.worktreeBaseSha = baseSha;
      snapshot.execution.worktreeBaseBranch = 'main';
      snapshot.execution.policy.validation.work.commands = [
        { argv: ['touch', seen], name: 'tests', timeoutMs: 5000 },
      ];
    }),
  );
  assert.equal(unrelated.status, 'error');
  assert.match(
    unrelated.status === 'error' ? unrelated.summary : '',
    /shares no history with the target \(refs\/worktree\/factory\/target\).*no project check ran/,
  );
  assert.equal(existsSync(seen), false);
});

test('parallel validations of different tickets each give their commands only their own selection', async () => {
  // Set when Factory validates this repository with a selection.
  const inherited = process.env[SELECTION_ENV];
  const [one, two, none] = await Promise.all([
    validateReply('## Validation selection\n\n- `tests/filter.test.ts`: ticket one\n'),
    validateReply('## Validation selection\n\n- `README.md`: ticket two\n'),
    validateReply('## Status\n\nready_for_review\n'),
  ]);
  assert.deepEqual(JSON.parse(one.seen ?? ''), {
    tests: [{ path: 'tests/filter.test.ts', reason: 'ticket one' }],
    version: 1,
  });
  assert.deepEqual(JSON.parse(two.seen ?? ''), {
    tests: [{ path: 'README.md', reason: 'ticket two' }],
    version: 1,
  });
  assert.equal(none.seen, 'unset');
  // The server's own environment is never changed.
  assert.equal(process.env[SELECTION_ENV], inherited);
});

test('every work command is told where to keep its logs, and the directory is there', async () => {
  const { factoryRoot, logs } = await validateReply('## Status\n\nready_for_review\n');
  assert.equal(logs, `${path.join(factoryRoot, VALIDATION_LOGS)} true`);
});
