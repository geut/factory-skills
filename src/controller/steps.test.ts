import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actionId, type ActionRecord, type FactorySnapshot } from '../domain.ts';
import { addTasks, blank, run, session, task } from '../stories/fixtures.ts';
import { controllerStep, stepLabel } from './steps.ts';

const base = {
  attempts: 0,
  attentionReplyId: null,
  attentionRequestId: null,
  idempotencyKey: 'k',
  lastError: null,
  maxAttempts: 3,
  retryOfActionId: null,
  status: 'pending',
} as const;

function ticket(): { review: ReturnType<typeof run>; snapshot: FactorySnapshot } {
  const snapshot = blank();
  addTasks(snapshot, 6);
  task(snapshot, '02').status = 'active';
  const review = run(snapshot, session(snapshot, 'review', '02'), {
    minutesAgo: 1,
    terminal: null,
  });
  return { review, snapshot };
}

test('every action is labeled for a person, naming the stage and task', () => {
  const { review, snapshot } = ticket();
  const plan = run(snapshot, session(snapshot, 'plan', null), { minutesAgo: 5, terminal: null });
  const label = (action: ActionRecord) => stepLabel(snapshot, action);
  const id = actionId('a');
  assert.equal(
    label({ ...base, id, kind: 'prepare_worktree', runId: null, slug: 's' }),
    'preparing the worktree',
  );
  assert.equal(
    label({
      ...base,
      failures: [],
      id,
      kind: 'prepare_input',
      origin: null,
      purpose: 'initial',
      runId: null,
      stage: 'work',
      taskId: task(snapshot, '02').taskId,
    }),
    "preparing task 02's work",
  );
  assert.equal(
    label({ ...base, id, kind: 'validate_run', runId: review.id }),
    "validating task 02's review",
  );
  assert.equal(label({ ...base, id, kind: 'validate_run', runId: plan.id }), 'validating the plan');
  assert.equal(
    label({
      ...base,
      cwd: '/w',
      id,
      kind: 'launch_run',
      mode: 'launch',
      prompt: 'p',
      runId: review.id,
    }),
    'starting the review agent for task 02',
  );
  assert.equal(
    label({
      ...base,
      change: { body: 'b', kind: 'body' },
      id,
      kind: 'update_pull_request',
      pullRequestUrl: 'u',
      runId: review.id,
    }),
    'updating the pull request',
  );
  assert.equal(
    label({ ...base, cwd: '/w', id, kind: 'open_diff', name: 'n', runId: review.id }),
    'opening the handoff panes',
  );
});

test('the step is the running action, else the next one queued, timed from its claim or its queuing', () => {
  const { review, snapshot } = ticket();
  const times = new Map([
    ['queued', { createdAt: '2026-10-09T15:00:00.000Z', updatedAt: '2026-10-09T15:00:00.000Z' }],
    ['running', { createdAt: '2026-10-09T14:59:00.000Z', updatedAt: '2026-10-09T14:59:30.000Z' }],
  ]);
  assert.equal(controllerStep(snapshot, times), null);
  snapshot.actions.push({
    ...base,
    checklist: [],
    comment: null,
    commentKey: null,
    id: actionId('queued'),
    issueStatus: null,
    kind: 'update_ticket_source',
    runId: null,
    update: 'started',
  });
  assert.deepEqual(controllerStep(snapshot, times), {
    command: null,
    kind: 'update_ticket_source',
    label: 'updating the issue',
    since: '2026-10-09T15:00:00.000Z',
    state: 'queued',
  });
  snapshot.actions.push({
    ...base,
    id: actionId('running'),
    kind: 'validate_run',
    runId: review.id,
    status: 'leased',
  });
  assert.deepEqual(controllerStep(snapshot, times), {
    command: null,
    kind: 'validate_run',
    label: "validating task 02's review",
    since: '2026-10-09T14:59:30.000Z',
    state: 'running',
  });
  // Finished actions are no step.
  for (const action of snapshot.actions) {
    action.status = 'succeeded';
  }
  assert.equal(controllerStep(snapshot, times), null);
});

test('a running step carries the command the server says it is on; a queued one never does', () => {
  const { review, snapshot } = ticket();
  snapshot.actions.push({
    ...base,
    id: actionId('running'),
    kind: 'validate_run',
    runId: review.id,
    status: 'leased',
  });
  const times = new Map([['running', { createdAt: 't0', updatedAt: 't1' }]]);
  const command = { command: 'test', index: 2, startedAt: 't2', total: 3 };
  assert.deepEqual(
    controllerStep(snapshot, times, (id) => (id === 'running' ? command : null))?.command,
    command,
  );
  const queued = controllerStep(
    {
      ...snapshot,
      actions: [{ ...base, id: actionId('queued'), kind: 'validate_run', runId: review.id }],
    },
    new Map([['queued', { createdAt: 't0', updatedAt: 't0' }]]),
    () => command,
  );
  assert.equal(queued?.command, null);
});
