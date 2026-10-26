import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addTasks,
  blank,
  majorFinding,
  minorFinding,
  review,
  reviewV5,
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

function prompt(round: number, earlier: Array<string>) {
  const snapshot = blank();
  addTasks(snapshot, 1);
  const owner = session(snapshot, 'review', '01');
  for (const [index, output] of earlier.entries()) {
    run(snapshot, owner, { output, round: index + 1 });
  }
  const input = reviewStage.input?.(
    { snapshot, task: task(snapshot, '01') },
    {
      handoff: {
        checks: [
          {
            details: 'npm run check',
            kind: 'command',
            name: 'check',
            stage: 'Work',
            status: 'passed',
          },
          {
            details: 'npm run lint',
            kind: 'command',
            name: 'lint',
            stage: 'Work',
            status: 'passed',
          },
          { details: 'AC1', kind: 'schema', name: 'AC1 covered', stage: 'QA', status: 'passed' },
        ],
        criteria: [
          { id: 'AC1', text: 'The filter survives a reload.' },
          { id: 'AC2', text: 'An empty filter shows every ticket.' },
        ],
        diff: 'diff --git a/src/filter.ts b/src/filter.ts',
        output: 'Stored the filter.',
      },
      prepared: null,
      round,
    },
  );
  return reviewStage.turn({ input: input ?? assert.fail('no input'), kind: 'initial' });
}

const roundOneVerification = [
  '- AC1: not_verified — the filter is never stored',
  '- AC2: verified — src/filter.ts:3',
].join('\n');

test('the first review lists the criteria to verify', () => {
  const text = prompt(1, []);
  assert.match(text, /Return only the factory\.review\.v5 template/);
  assert.match(
    text,
    /Acceptance criteria \(one Verification line each\):\n- AC1: The filter survives a reload\.\n- AC2: An empty filter shows every ticket\./,
  );
  assert.doesNotMatch(text, /Earlier blocking findings/);
});

test('the validation block groups the work checks and the QA checks', () => {
  assert.match(
    prompt(1, []),
    /Validation:\nWork:\n- check: passed\n- lint: passed\nQA:\n- AC1 covered: passed\n/,
  );
});

test('a later review asks to verify each earlier blocking finding, without claiming a fix', () => {
  const earlier = reviewV5(
    'changes_requested',
    roundOneVerification,
    `${majorFinding}\n\n${minorFinding}`,
  );
  const text = prompt(2, [earlier]);
  assert.doesNotMatch(text, /addressed/);
  assert.match(text, /Verify each earlier blocking finding below and report it in Verification/);
  const listed = text.split('Earlier blocking findings (one Verification line each):\n')[1] ?? '';
  assert.match(listed, /^- R1-1 \[major\] Missing DB_URL bypasses the typed error page/);
  // Minor findings do not block, so they are not re-verified.
  assert.doesNotMatch(listed, /R1-3/);
});
