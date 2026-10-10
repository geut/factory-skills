import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomIds, zeroUsage, type ActionRecord, type FactorySnapshot } from '../domain.ts';
import { wrapupRunning } from '../stories/scenarios.ts';
import { parseFactoryCommand } from './parse.ts';
import { reduce } from './reduce.ts';

const now = '2026-10-10T00:00:00.000Z';

function finishedWrapup(): {
  runId: FactorySnapshot['runs'][number]['id'];
  snapshot: FactorySnapshot;
} {
  const { snapshot } = wrapupRunning();
  const run = snapshot.runs.at(-1);
  if (run === undefined) {
    throw new Error('missing wrap-up run');
  }
  const done = reduce({
    event: {
      kind: 'runtime_terminal',
      runId: run.id,
      terminal: { kind: 'subagent_done', output: '## Outcome\n\nDone.', usage: zeroUsage() },
    },
    ids: randomIds(),
    now,
    snapshot,
  });
  return { runId: run.id, snapshot: done.snapshot ?? snapshot };
}

function validation(snapshot: FactorySnapshot): Extract<ActionRecord, { kind: 'validate_run' }> {
  const found = snapshot.actions.findLast(
    (action): action is Extract<ActionRecord, { kind: 'validate_run' }> =>
      action.kind === 'validate_run' && action.status === 'pending',
  );
  if (found === undefined) {
    throw new Error('missing validation action');
  }
  return found;
}

test('subagent_done enqueues exactly one wrap-up validation and keeps the raw handoff', () => {
  const { runId, snapshot } = finishedWrapup();
  const validations = snapshot.actions.filter(
    (action) => action.kind === 'validate_run' && action.runId === runId,
  );
  assert.equal(validations.length, 1);
  const run = snapshot.runs.find((item) => item.id === runId);
  assert.equal(run?.resultContract, 'factory.wrapup.v1');
  assert.equal(run?.resultStatus, 'invalid');
  assert.match(run?.resultError ?? '', /## PR summary is missing/);
  assert.match(run?.resultJson ?? '', /Done\./);
  const duplicate = reduce({
    event: {
      kind: 'runtime_terminal',
      runId,
      terminal: { kind: 'subagent_done', output: 'again', usage: zeroUsage() },
    },
    ids: randomIds(),
    now,
    snapshot,
  });
  assert.equal(duplicate.changed, false);
});

test('a validator error uses the infrastructure retry budget, then fails retryably', () => {
  const start = finishedWrapup();
  const { runId } = start;
  let { snapshot } = start;
  const limit = snapshot.execution.policy.limits.infrastructureRetries;
  for (let attempt = 1; attempt <= limit; attempt += 1) {
    const action = validation(snapshot);
    const result = reduce({
      event: {
        actionId: action.id,
        kind: 'validation_finished',
        outcome: { kind: 'error', message: 'git crashed' },
        runId,
        stage: 'wrapup',
        usage: '',
      },
      ids: randomIds(),
      now,
      snapshot,
    });
    snapshot = result.snapshot ?? snapshot;
    if (attempt < limit) {
      assert.equal(snapshot.execution.status, 'active');
      assert.equal(validation(snapshot).retryOfActionId, action.id);
    }
  }
  assert.equal(snapshot.execution.status, 'failed');
  assert.equal(snapshot.execution.statusReasonCode, 'validator_error');
  assert.equal(snapshot.execution.retryable, true);
  // No correction run was created: an infrastructure error asks nothing of the agent.
  assert.equal(snapshot.runs.filter((run) => run.purpose === 'validation_correction').length, 0);
});

test('a passed validation sets ready_for_handoff once; a duplicate result is ignored', () => {
  const { runId, snapshot } = finishedWrapup();
  const action = validation(snapshot);
  const event = {
    actionId: action.id,
    kind: 'validation_finished' as const,
    outcome: {
      checks: [
        {
          details: 'ok',
          kind: 'schema' as const,
          name: 'handoff headings',
          status: 'passed' as const,
        },
      ],
      kind: 'passed' as const,
    },
    runId,
    stage: 'wrapup' as const,
    usage: 'Stage  Sess  Input',
  };
  const passed = reduce({ event, ids: randomIds(), now, snapshot });
  const after = passed.snapshot ?? snapshot;
  assert.equal(after.execution.stage, 'wrapup');
  assert.equal(after.execution.status, 'ready_for_handoff');
  assert.deepEqual(
    after.actions.filter((item) => item.status === 'pending').map((item) => item.kind),
    ['open_pane', 'open_diff', 'notify_attention'],
  );
  assert.equal(after.attention.at(-1)?.kind, 'manual_approval');
  assert.match(after.attention.at(-1)?.question ?? '', /Stage {2}Sess {2}Input/);
  assert.equal(
    after.tasks.every((task) => task.status === 'done'),
    true,
  );
  const duplicate = reduce({ event, ids: randomIds(), now, snapshot: after });
  assert.equal(duplicate.changed, false);
  assert.match(
    duplicate.response.kind === 'status' ? duplicate.response.message : '',
    /Duplicate validation event ignored/,
  );
});

test('complete is a command, and only a ready-for-handoff ticket can be completed', () => {
  assert.deepEqual(parseFactoryCommand('complete PROJ-1'), { kind: 'complete', ref: 'PROJ-1' });
  assert.equal(parseFactoryCommand('complete').kind, 'invalid');
  const { snapshot } = finishedWrapup();
  const early = reduce({
    event: { idempotencyKey: 'complete:1', kind: 'complete', ticketId: snapshot.ticket.id },
    ids: randomIds(),
    now,
    snapshot,
  });
  assert.equal(early.response.kind, 'rejected');
  assert.match(
    early.response.kind === 'rejected' ? early.response.message : '',
    /not ready for handoff/,
  );
});
