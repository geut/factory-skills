import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  actionId,
  randomIds,
  taskId,
  type ControllerEvent,
  type FactorySnapshot,
} from '../domain.ts';
import { task } from '../stories/fixtures.ts';
import { readyForReview } from '../stories/scenarios.ts';
import { reduce } from './reduce.ts';

const now = '2026-10-10T00:00:00.000Z';

// The review of task 03 about to launch, and its pending launch.
function launching(code?: 'project_rules'): {
  event: ControllerEvent;
  snapshot: FactorySnapshot;
} {
  const { snapshot } = readyForReview();
  const reviewRun = snapshot.runs.at(-1);
  if (reviewRun === undefined) {
    throw new Error('missing review run');
  }
  reviewRun.status = 'prepared';
  const id = actionId('action-launch-review');
  snapshot.actions.push({
    attempts: 0,
    attentionReplyId: null,
    attentionRequestId: null,
    cwd: '/repo/.factory/worktrees/demo',
    id,
    idempotencyKey: `launch:${reviewRun.id}`,
    kind: 'launch_run',
    lastError: null,
    maxAttempts: 3,
    mode: 'launch',
    prompt: 'Follow the factory-review skill.',
    retryOfActionId: null,
    runId: reviewRun.id,
    status: 'leased',
  });
  return {
    event: {
      actionId: id,
      ...(code === undefined ? {} : { code }),
      kind: 'launch_failed',
      message: 'Cannot read the project rules: the base commit fff is not in /repo.',
      runId: reviewRun.id,
    },
    snapshot,
  };
}

test('unreadable project rules pause the ticket instead of retrying the launch', () => {
  const { event, snapshot } = launching('project_rules');
  const runs = snapshot.runs.length;
  const reduced = reduce({ event, ids: randomIds(), now, snapshot });
  const after = reduced.snapshot;
  assert.equal(after?.execution.status, 'paused');
  assert.equal(after?.execution.statusReasonCode, 'project_rules');
  assert.match(after?.execution.statusReason ?? '', /the base commit fff is not in/);
  // The retry validates the work again, which starts the review with its input.
  assert.deepEqual(after?.execution.retry, {
    kind: 'revalidate',
    stage: 'work',
    taskId: taskId('03'),
  });
  assert.equal(after === null ? null : task(after, '03').status, 'blocked');
  // No infrastructure retry run.
  assert.equal(after?.runs.length, runs);
  assert.match(after?.attention.at(-1)?.question ?? '', /\/factory retry .* to start review again/);
});

test('any other launch failure still retries as infrastructure', () => {
  const { event, snapshot } = launching();
  const runs = snapshot.runs.length;
  const reduced = reduce({ event, ids: randomIds(), now, snapshot });
  assert.equal(reduced.snapshot?.execution.status, 'active');
  assert.equal(reduced.snapshot?.runs.at(-1)?.purpose, 'infrastructure_retry');
  assert.equal(reduced.snapshot?.runs.length, runs + 1);
});
