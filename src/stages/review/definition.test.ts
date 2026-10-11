import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addTasks,
  blank,
  majorFinding,
  review,
  run,
  session,
  task,
} from '../../stories/fixtures.ts';
import { REVIEW_VALIDATOR_VERSION } from '../../validation/review.ts';
import { review as reviewStage } from './definition.ts';

function concluded(output: string, round: number) {
  const snapshot = blank();
  addTasks(snapshot, 1);
  const finished = run(snapshot, session(snapshot, 'review', '01'), { output, round });
  const view = { snapshot, task: task(snapshot, '01') };
  return {
    fail: (reason: 'malformed' | 'stale' | 'unsafe') =>
      reviewStage.conclude(view, finished, {
        checks: [],
        detail: { reason },
        failures: ['Reviewer could write files.'],
        status: 'failed',
        summary: 'Reviewer could write files.',
        version: REVIEW_VALIDATOR_VERSION,
      }),
    pass: () =>
      reviewStage.conclude(view, finished, {
        checks: [],
        detail: null,
        status: 'passed',
        summary: null,
        version: REVIEW_VALIDATOR_VERSION,
      }),
  };
}

test('an approving review accepts the task with its summary', () => {
  assert.deepEqual(concluded(review('approve'), 1).pass(), {
    kind: 'accept',
    summary: { counts: { blocking: 0, findings: 0 }, label: 'approve', round: 1 },
  });
});

test('blocking findings return the task to work until the round limit pauses', () => {
  const returned = concluded(review('changes_requested', majorFinding), 1).pass();
  assert.equal(returned.kind, 'return_to_work');
  assert.match(returned.kind === 'return_to_work' ? (returned.problems[0] ?? '') : '', /^R1-1/);
  const limited = concluded(review('changes_requested', majorFinding), 3).pass();
  assert.equal(limited.kind, 'pause');
  assert.equal(limited.kind === 'pause' && limited.reply, true);
});

test('an unreadable verdict is corrected; a stale diff revalidates; isolation pauses', () => {
  assert.equal(concluded('Looks good to me.', 1).pass().kind, 'correct');
  assert.deepEqual(concluded(review('approve'), 1).fail('stale'), {
    kind: 'revalidate_previous',
  });
  const unsafe = concluded(review('approve'), 1).fail('unsafe');
  assert.equal(unsafe.kind === 'pause' && unsafe.reply, false);
});
