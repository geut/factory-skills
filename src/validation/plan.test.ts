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
    writeFileSync(path.join(factoryDir, '01-task-store.md'), '# Store\n\nBlocked by: none\n');
    writeFileSync(path.join(factoryDir, '02-task-restore.md'), '# Restore\n\nBlocked by: 01\n');
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
    writeFileSync(path.join(factoryDir, '01-task-store.md'), '# Store\n\nBlocked by: none\n');
    const missing = await withQa();
    assert.equal(missing.status, 'failed');
    if (missing.status === 'failed') {
      assert.match(missing.summary, /01-task-store\.md lists no acceptance criteria/);
    }
    writeFileSync(
      path.join(factoryDir, '01-task-store.md'),
      '# Store\n\nBlocked by: none\n\n## Acceptance criteria\n\n- [ ] The filter is kept.\n',
    );
    assert.equal((await withQa()).status, 'passed');
    // Without QA the same plan never needed criteria.
    writeFileSync(path.join(factoryDir, '01-task-store.md'), '# Store\n\nBlocked by: none\n');
    assert.equal((await validate(factoryDir)).status, 'passed');
  } finally {
    rmSync(factoryDir, { force: true, recursive: true });
  }
});
