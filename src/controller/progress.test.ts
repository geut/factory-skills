import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  askingUser,
  changesRequested,
  diffKeepsChanging,
  planReady,
  readyForReview,
  roundLimit,
} from '../stories/scenarios.ts';
import { currentStep, nextAction, planItems, progressText, readyTasks } from './progress.ts';

test('the plan lists every task with its dependencies and the ready frontier', () => {
  const { snapshot } = planReady();
  assert.equal(progressText(snapshot), '0/6 done');
  assert.equal(
    planItems(snapshot)[4],
    '05 Contract: delete the legacy data layer and supersede the fstate ADRs · after 03, 04',
  );
  assert.deepEqual(
    readyTasks(snapshot).map((task) => task.taskId),
    ['01'],
  );
});

test('the current step names the task and the review round', () => {
  assert.equal(
    currentStep(readyForReview().snapshot),
    '03/06 Overview page (`/`) on the v2 read module · review r1',
  );
  assert.equal(
    currentStep(changesRequested().snapshot),
    '03/06 Overview page (`/`) on the v2 read module · fixing r2',
  );
  assert.equal(currentStep(roundLimit().snapshot)?.endsWith('review r3'), true);
});

test('the next action matches how the ticket is waiting', () => {
  assert.equal(nextAction(readyForReview().snapshot), null);
  assert.equal(
    nextAction(askingUser().snapshot),
    '/factory reply dpaez/factory-dashboard#11 "answer"',
  );
  assert.equal(
    nextAction(roundLimit().snapshot),
    '/factory reply dpaez/factory-dashboard#11 "answer"',
  );
  assert.equal(
    nextAction(diffKeepsChanging().snapshot),
    '/factory retry dpaez/factory-dashboard#11',
  );
});
