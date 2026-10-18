import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_LIMITS } from '../config.ts';
import { taskId } from '../domain.ts';
import { addTasks, blank, setTask } from '../stories/fixtures.ts';
import { effects } from './effects.ts';
import { flow, nextStep, previousTaskStage } from './flow.ts';
import { stages } from './index.ts';

test('every stage is in the flow once, with its effects and its limit', () => {
  const listed = [...flow.ticket, ...flow.task, ...flow.closing];
  assert.deepEqual([...listed].sort(), Object.keys(stages).sort());
  assert.equal(new Set(listed).size, listed.length);
  for (const stage of listed) {
    assert.ok(stage in effects, stage);
    const limit = stages[stage].corrections.limit;
    assert.ok(limit === null || limit in DEFAULT_LIMITS, stage);
    // Per-task stages run per task, and no other stage does.
    assert.equal(
      stages[stage].scope === 'task',
      flow.task.some((item) => item === stage),
      stage,
    );
  }
});

test('the plan leads to the first ready task, and work to review of that task', () => {
  const snapshot = blank();
  addTasks(snapshot, 3);
  assert.deepEqual(nextStep(snapshot, 'plan', null), {
    kind: 'stage',
    stage: 'work',
    taskId: taskId('01'),
  });
  assert.deepEqual(nextStep(snapshot, 'work', taskId('01')), {
    kind: 'stage',
    stage: 'review',
    taskId: taskId('01'),
  });
  assert.equal(previousTaskStage(snapshot.execution.policy, 'review', null), 'work');
  assert.equal(previousTaskStage(snapshot.execution.policy, 'work', null), null);
});

test('after a task, the next one whose dependencies are done, then wrap-up', () => {
  const snapshot = blank();
  addTasks(snapshot, 3);
  setTask(snapshot, '01', 'done');
  assert.deepEqual(nextStep(snapshot, 'review', taskId('01')), {
    kind: 'stage',
    stage: 'work',
    taskId: taskId('02'),
  });
  setTask(snapshot, '02', { blocked: true, stage: 'review' });
  assert.deepEqual(nextStep(snapshot, 'review', taskId('01')), {
    kind: 'waiting',
    taskIds: [taskId('02'), taskId('03')],
  });
  setTask(snapshot, '02', 'done');
  setTask(snapshot, '03', 'done');
  assert.deepEqual(nextStep(snapshot, 'review', taskId('03')), {
    kind: 'stage',
    stage: 'wrapup',
    taskId: null,
  });
  assert.deepEqual(nextStep(snapshot, 'wrapup', null), { kind: 'handoff' });
});

test('a task whose file says qa: none goes from work straight to review', () => {
  const snapshot = blank();
  addTasks(snapshot, 2);
  snapshot.execution.policy.stages['qa'] = {
    commands: [{ argv: ['pnpm', 'test:e2e'], name: 'e2e', timeoutMs: 60_000 }],
    enabled: true,
  };
  const [first, second] = snapshot.tasks;
  if (first === undefined || second === undefined) {
    throw new Error('two tasks expected');
  }
  first.summaries.qa = { counts: {}, label: 'skipped', round: 0 };
  assert.deepEqual(nextStep(snapshot, 'work', taskId('01')), {
    kind: 'stage',
    stage: 'review',
    taskId: taskId('01'),
  });
  assert.equal(previousTaskStage(snapshot.execution.policy, 'review', first), 'work');
  assert.deepEqual(nextStep(snapshot, 'work', taskId('02')), {
    kind: 'stage',
    stage: 'qa',
    taskId: taskId('02'),
  });
  assert.equal(previousTaskStage(snapshot.execution.policy, 'review', second), 'qa');
});
