import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { validationContext } from './fixture.ts';
import { planValidator } from './plan.ts';

function validate(factoryDir: string) {
  return planValidator.validate(
    validationContext('plan', (snapshot, finished) => {
      snapshot.execution.factoryDir = factoryDir;
      finished.resultHash = 'result-hash';
    }),
  );
}

// A task file whose frontmatter is `fields`, one YAML line each.
function task(title: string, fields: string, body = ''): string {
  return `---\n${fields}\n---\n\n# ${title}\n${body}`;
}

const store = task('Store', 'type: feature\nqa: e2e\nblocked_by: []');

async function failures(files: Record<string, string>): Promise<Array<string>> {
  const factoryDir = mkdtempSync(path.join(tmpdir(), 'factory-plan-'));
  try {
    writeFileSync(path.join(factoryDir, 'plan.md'), '# Filter\n');
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(path.join(factoryDir, name), text);
    }
    const report = await validate(factoryDir);
    return report.status === 'failed' ? report.failures : [];
  } finally {
    rmSync(factoryDir, { force: true, recursive: true });
  }
}

test('plan validation accepts plan.md plus at least one task file', async () => {
  const factoryDir = mkdtempSync(path.join(tmpdir(), 'factory-plan-'));
  try {
    const empty = await validate(factoryDir);
    assert.equal(empty.status, 'failed');
    writeFileSync(path.join(factoryDir, 'plan.md'), '# Filter\n\n## Outcome\nRemembered.\n');
    const missingTasks = await validate(factoryDir);
    assert.equal(missingTasks.status, 'failed');
    if (missingTasks.status === 'failed') {
      assert.ok(missingTasks.failures.some((failure) => failure.includes('task file')));
      assert.equal(missingTasks.summary, missingTasks.failures.join('\n'));
    }
    writeFileSync(path.join(factoryDir, '01-task-store.md'), store);
    writeFileSync(
      path.join(factoryDir, '02-task-restore.md'),
      task('Restore', 'type: bug\nqa: e2e\nblocked_by: ["01"]'),
    );
    const passed = await validate(factoryDir);
    assert.equal(passed.status, 'passed');
    if (passed.status !== 'passed') {
      return;
    }
    assert.equal(passed.version, planValidator.version);
    assert.equal(passed.summary, null);
    assert.deepEqual(
      passed.checks.map((check) => [check.name, check.status]),
      [
        ['plan.md', 'passed'],
        ['task graph', 'passed'],
      ],
    );
    assert.equal(passed.detail.tasks[0]?.taskId, '01');
    assert.equal(passed.detail.tasks[1]?.title, 'Restore');
    assert.deepEqual(passed.detail.tasks[1]?.blockedBy, ['01']);
  } finally {
    rmSync(factoryDir, { force: true, recursive: true });
  }
});

test('a dependency is the task with that number or filename', async () => {
  const factoryDir = mkdtempSync(path.join(tmpdir(), 'factory-plan-'));
  try {
    writeFileSync(path.join(factoryDir, 'plan.md'), '# Filter\n');
    writeFileSync(path.join(factoryDir, '01-task-store.md'), store);
    // YAML reads the unquoted 01 as the number 1.
    writeFileSync(
      path.join(factoryDir, '02-task-restore.md'),
      task('Restore', 'type: feature\nqa: e2e\nblocked_by: [01]'),
    );
    writeFileSync(
      path.join(factoryDir, '03-task-show.md'),
      task('Show', 'type: feature\nqa: e2e\nblocked_by:\n  - "001"\n  - 02-task-restore.md\n  - 1'),
    );
    const report = await validate(factoryDir);
    assert.equal(report.status, 'passed');
    if (report.status !== 'passed') {
      return;
    }
    assert.deepEqual(
      report.detail.tasks.map((item) => item.blockedBy),
      [[], ['01'], ['01', '02']],
    );
  } finally {
    rmSync(factoryDir, { force: true, recursive: true });
  }
});

test('a dependency on a missing task or on itself is a correction', async () => {
  assert.deepEqual(
    await failures({
      '01-task-store.md': task('Store', 'type: feature\nqa: e2e\nblocked_by: [1]'),
      '02-task-restore.md': task('Restore', 'type: feature\nqa: e2e\nblocked_by: [7, task 1]'),
    }),
    [
      '01-task-store.md is blocked by itself.',
      '02-task-restore.md is blocked by 7, which matches no task file number (01, 02).',
      '02-task-restore.md is blocked by task 1, which matches no task file number (01, 02).',
    ],
  );
});

test('tasks that block each other are a correction', async () => {
  assert.deepEqual(
    await failures({
      '01-task-store.md': task('Store', 'type: feature\nqa: e2e\nblocked_by: [3]'),
      '02-task-restore.md': task('Restore', 'type: feature\nqa: e2e\nblocked_by: [1]'),
      '03-task-show.md': task('Show', 'type: feature\nqa: e2e\nblocked_by: [2]'),
    }),
    ['Tasks 01 → 03 → 02 → 01 block each other, so none of them can start.'],
  );
});

test('two task files with one number are a correction', async () => {
  assert.deepEqual(await failures({ '01-task-store.md': store, '1-task-restore.md': store }), [
    '01-task-store.md and 1-task-restore.md share a number; give each task file its own.',
  ]);
});

test('frontmatter holds exactly type, qa and blocked_by', async () => {
  assert.deepEqual(
    await failures({
      '01-task-store.md': '# Store\n\nType: feature\nBlocked by: none\n',
      '02-task-restore.md': task('Restore', 'type: feature\nqa: e2e'),
      '03-task-show.md': task('Show', 'status: pending\ntype: feature\nqa: e2e\nblocked_by: []'),
      '04-task-list.md': task('List', 'type: chore\nqa: maybe\nblocked_by: none'),
      '05-task-sort.md': task('Sort', 'type: [feature'),
    }),
    [
      '01-task-store.md uses the old Status, Type, QA and Blocked by lines. Delete them and start the file with this frontmatter instead:\n---\ntype: feature\nqa: e2e\nblocked_by: []\n---',
      '02-task-restore.md has no blocked_by in its frontmatter.',
      '03-task-show.md has status in its frontmatter, which holds only type, qa and blocked_by.',
      '04-task-list.md has an invalid blocked_by: Invalid input: expected array, received string.',
      '04-task-list.md has an invalid qa: Invalid option: expected one of "e2e"|"none".',
      '04-task-list.md has an invalid type: Invalid option: expected one of "bug"|"feature"|"performance"|"refactor"|"investigation".',
      '05-task-sort.md has frontmatter that is not YAML: Flow sequence in block collection must be sufficiently indented and end with a ] at line 1, column 15.',
    ],
  );
});

test('a task file in the old format is told the frontmatter its lines become', async () => {
  assert.deepEqual(
    await failures({
      '01-task-store.md': '# Store\n\nStatus: pending\nType: Bug\nQA: maybe\nBlocked by: 1, 02\n',
      '02-task-restore.md': '# Restore\n\nNothing to see.\n',
    }),
    [
      '01-task-store.md uses the old Status, Type, QA and Blocked by lines. Delete them and start the file with this frontmatter instead:\n---\ntype: bug\nqa: e2e | none\nblocked_by: ["1", "02"]\n---',
      '02-task-restore.md has no frontmatter; start it with ---, then type, qa and blocked_by, then ---.',
    ],
  );
});

test('an unreadable ticket directory is a validator error, not a correction', async () => {
  const report = await validate(path.join(tmpdir(), 'factory-plan-missing', 'nowhere'));
  assert.equal(report.status, 'error');
  assert.match(report.summary, /cannot be read/);
});

test('a plan run without a result is not validated', async () => {
  await assert.rejects(planValidator.validate(validationContext('plan')), /missing a plan result/);
});

test('with QA enabled, every task file must list acceptance criteria', async () => {
  const factoryDir = mkdtempSync(path.join(tmpdir(), 'factory-plan-'));
  const withQa = () =>
    planValidator.validate(
      validationContext('plan', (snapshot, finished) => {
        snapshot.execution.factoryDir = factoryDir;
        snapshot.execution.policy.stages = {
          qa: { commands: [{ argv: ['npx', 'playwright', 'test'], name: 'e2e' }], enabled: true },
        };
        finished.resultHash = 'result-hash';
      }),
    );
  try {
    writeFileSync(path.join(factoryDir, 'plan.md'), '# Filter\n');
    writeFileSync(path.join(factoryDir, '01-task-store.md'), store);
    const missing = await withQa();
    assert.equal(missing.status, 'failed');
    if (missing.status === 'failed') {
      assert.match(missing.summary, /01-task-store\.md lists no acceptance criteria/);
    }
    writeFileSync(
      path.join(factoryDir, '01-task-store.md'),
      task(
        'Store',
        'type: feature\nqa: e2e\nblocked_by: []',
        '\n## Acceptance criteria\n\n- [ ] The filter is kept.\n',
      ),
    );
    assert.equal((await withQa()).status, 'passed');
    // Without QA the same plan never needed criteria.
    writeFileSync(path.join(factoryDir, '01-task-store.md'), store);
    assert.equal((await validate(factoryDir)).status, 'passed');
    // A task that opts out of QA needs no criteria and is planned with QA skipped.
    writeFileSync(
      path.join(factoryDir, '01-task-store.md'),
      task('Store', 'type: feature\nqa: none\nblocked_by: []'),
    );
    const skipped = await withQa();
    assert.equal(skipped.status, 'passed');
    if (skipped.status === 'passed') {
      assert.deepEqual(skipped.detail.tasks[0]?.skips, ['qa']);
    }
  } finally {
    rmSync(factoryDir, { force: true, recursive: true });
  }
});
