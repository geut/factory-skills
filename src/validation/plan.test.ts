import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { inspectPlanDir } from './plan.ts';

test('plan inspection accepts plan.md plus at least one task file', () => {
  const factoryDir = mkdtempSync(path.join(tmpdir(), 'factory-plan-'));
  try {
    assert.equal(inspectPlanDir({ factoryDir: path.join(factoryDir, 'missing') }).status, 'error');
    assert.equal(inspectPlanDir({ factoryDir }).status, 'failed');
    writeFileSync(path.join(factoryDir, 'plan.md'), '# Filter\n\n## Outcome\nRemembered.\n');
    const missingTasks = inspectPlanDir({ factoryDir });
    assert.equal(missingTasks.status, 'failed');
    if (missingTasks.status === 'failed') {
      assert.ok(missingTasks.failures.some((failure) => failure.includes('task file')));
    }
    writeFileSync(path.join(factoryDir, '01-task-store.md'), '# Store\n\nBlocked by: none\n');
    writeFileSync(path.join(factoryDir, '02-task-restore.md'), '# Restore\n\nBlocked by: 01\n');
    const passed = inspectPlanDir({ factoryDir });
    assert.equal(passed.status, 'passed');
    if (passed.status !== 'passed') {
      return;
    }
    assert.equal(passed.detail.tasks[0]?.taskId, '01');
    assert.deepEqual(passed.detail.tasks[1]?.blockedBy, ['01']);
  } finally {
    rmSync(factoryDir, { force: true, recursive: true });
  }
});
