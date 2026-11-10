import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomIds, zeroUsage, type ActionRecord, type FactorySnapshot } from '../domain.ts';
import { wrapupRunning } from '../stories/scenarios.ts';
import { errorReport, failedReport, passedReport } from '../validation/report.ts';
import { WRAPUP_VALIDATOR_VERSION } from '../validation/wrapup.ts';
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

const noIssue = { decisions: [], met: [], open: [] };

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
  assert.equal(run?.resultContract, 'factory.wrapup.v2');
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
        report: errorReport(WRAPUP_VALIDATOR_VERSION, 'git crashed'),
        runId,
        stage: 'wrapup',
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
  assert.deepEqual(snapshot.execution.retry, { kind: 'validate' });
  // No correction run was created: an infrastructure error asks nothing of the agent.
  assert.equal(snapshot.runs.filter((run) => run.purpose === 'validation_correction').length, 0);
});

test('a passed validation sets ready_for_handoff once; a duplicate result is ignored', () => {
  const { runId, snapshot } = finishedWrapup();
  const action = validation(snapshot);
  const event = {
    actionId: action.id,
    kind: 'validation_finished' as const,
    report: passedReport(
      WRAPUP_VALIDATOR_VERSION,
      [{ details: 'ok', kind: 'schema', name: 'handoff headings', status: 'passed' }],
      { checklist: noIssue, pullRequest: null, rules: [], usage: 'Stage  Sess  Input' },
    ),
    runId,
    stage: 'wrapup' as const,
  };
  const passed = reduce({ event, ids: randomIds(), now, snapshot });
  const after = passed.snapshot ?? snapshot;
  assert.equal(after.execution.stage, 'wrapup');
  assert.equal(after.execution.status, 'ready_for_handoff');
  assert.deepEqual(
    after.actions.filter((item) => item.status === 'pending').map((item) => item.kind),
    ['open_pane', 'open_diff', 'update_ticket_source', 'notify_attention'],
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

test('an accepted wrap-up ticks the met boxes and keeps one handoff comment with decisions and gaps', () => {
  const { runId, snapshot } = finishedWrapup();
  const passed = reduce({
    event: {
      actionId: validation(snapshot).id,
      kind: 'validation_finished',
      report: passedReport(WRAPUP_VALIDATOR_VERSION, [], {
        checklist: {
          decisions: ['Stored the filter in the URL instead of localStorage.'],
          met: [
            { id: 'B1', key: '1:A reload keeps the filter.', text: 'A reload keeps the filter.' },
          ],
          open: [
            {
              id: 'B2',
              key: '1:The filter is labelled.',
              reason: 'Task 01 R1-2: no label yet',
              text: 'The filter is labelled.',
            },
          ],
        },
        pullRequest: null,
        rules: [],
        usage: '',
      }),
      runId,
      stage: 'wrapup',
    },
    ids: randomIds(),
    now,
    snapshot,
  });
  const updates = (passed.snapshot ?? snapshot).actions.filter(
    (item): item is Extract<ActionRecord, { kind: 'update_ticket_source' }> =>
      item.kind === 'update_ticket_source' && item.update === 'handoff',
  );
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0]?.checklist, [
    { key: '1:A reload keeps the filter.', text: 'A reload keeps the filter.' },
  ]);
  // One comment per ticket: a rerun's handoff replaces it.
  assert.equal(updates[0]?.commentKey, `handoff:${snapshot.ticket.id}`);
  assert.equal(
    updates[0]?.comment,
    [
      'The factory finished this ticket. Its handoff has the merge commands.',
      '',
      'Decisions:',
      '- Stored the filter in the URL instead of localStorage.',
      '',
      'Left open:',
      '- [ ] The filter is labelled. — Task 01 R1-2: no label yet',
    ].join('\n'),
  );
});

test('an accepted wrap-up names the project rule files the ticket changes', () => {
  const { runId, snapshot } = finishedWrapup();
  const passed = reduce({
    event: {
      actionId: validation(snapshot).id,
      kind: 'validation_finished',
      report: passedReport(WRAPUP_VALIDATOR_VERSION, [], {
        checklist: noIssue,
        pullRequest: null,
        rules: ['AGENTS.md'],
        usage: '',
      }),
      runId,
      stage: 'wrapup',
    },
    ids: randomIds(),
    now,
    snapshot,
  });
  const after = passed.snapshot ?? snapshot;
  const comment = after.actions.find(
    (item): item is Extract<ActionRecord, { kind: 'update_ticket_source' }> =>
      item.kind === 'update_ticket_source' && item.update === 'handoff',
  )?.comment;
  assert.match(comment ?? '', /This ticket changes project rules: AGENTS\.md\./);
  assert.match(after.attention.at(-1)?.question ?? '', /changes project rules: AGENTS\.md/);
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

// Wrap-up validation of `runId` failing with `failures`.
function failedWith(
  snapshot: FactorySnapshot,
  runId: FactorySnapshot['runs'][number]['id'],
  failures: Array<string>,
): FactorySnapshot {
  const pending = snapshot.actions.some(
    (action) => action.kind === 'validate_run' && action.status === 'pending',
  );
  if (!pending) {
    // The correction's run finished and is validated again.
    snapshot.actions.push({
      attempts: 0,
      attentionReplyId: null,
      attentionRequestId: null,
      id: randomIds().action(),
      idempotencyKey: `validate-again:${snapshot.actions.length}`,
      kind: 'validate_run',
      lastError: null,
      maxAttempts: 3,
      retryOfActionId: null,
      runId,
      status: 'pending',
    });
  }
  const detail = { checklist: noIssue, pullRequest: null, rules: [], usage: '' };
  return (
    reduce({
      event: {
        actionId: validation(snapshot).id,
        kind: 'validation_finished',
        report: failedReport(
          WRAPUP_VALIDATOR_VERSION,
          [
            {
              details: failures.join('\n'),
              kind: 'policy',
              name: 'factory files',
              status: 'failed',
            },
          ],
          failures,
          detail,
        ),
        runId,
        stage: 'wrapup',
      },
      ids: randomIds(),
      now,
      snapshot,
    }).snapshot ?? snapshot
  );
}

test('wrap-up corrections have no limit, but the same failure after a correction pauses', () => {
  const { runId, snapshot } = finishedWrapup();
  const stuck = [
    'Wrap-up changed .factory/.DS_Store; only CONTEXT.md, PRD.md, and learnings/ may change.',
  ];
  // The first failure asks the agent to fix it.
  const corrected = failedWith(snapshot, runId, stuck);
  assert.equal(corrected.execution.status, 'active');
  const corrections = corrected.actions.filter(
    (action) => action.kind === 'prepare_input' && action.purpose === 'validation_correction',
  );
  assert.equal(corrections.length, 1);
  // A different failure is another correction.
  const other = failedWith(structuredClone(corrected), runId, ['## Files is missing.']);
  assert.equal(other.execution.status, 'active');
  // The same failure again: the correction did not help, so the ticket pauses.
  const paused = failedWith(corrected, runId, stuck);
  assert.equal(paused.execution.status, 'paused');
  assert.equal(paused.execution.statusReasonCode, 'wrapup_failure_repeated');
  assert.deepEqual(paused.execution.retry, { kind: 'validate' });
  assert.match(paused.attention.at(-1)?.question ?? '', /failed the same way after its correction/);
  assert.match(paused.attention.at(-1)?.question ?? '', /\.factory\/\.DS_Store/);
  assert.equal(
    paused.actions.filter(
      (action) => action.kind === 'prepare_input' && action.purpose === 'validation_correction',
    ).length,
    1,
  );
});
