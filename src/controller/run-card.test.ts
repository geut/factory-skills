import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REVIEW_CONTRACT } from '../stages/review/parse.ts';
import { reviewV5 } from '../stories/fixtures.ts';
import { approvedNext, roundLimit, staleDiff } from '../stories/scenarios.ts';
import {
  classifyRun,
  outcomeTone,
  purposeSegment,
  runCard,
  runListLabel,
  runOutcome,
  runsInStartOrder,
} from './run-card.ts';

const finished = {
  correctionScheduled: false,
  limitPaused: false,
  retryScheduled: false,
  stale: false,
  status: 'terminal',
  terminalKind: 'subagent_done',
  verdict: null,
} as const;

test('retries, replies, and corrections are named; first runs and review rounds are not', () => {
  assert.equal(purposeSegment({ purpose: 'initial', semanticRound: 0 }), null);
  assert.equal(purposeSegment({ purpose: 'return_to_work', semanticRound: 2 }), null);
  assert.equal(purposeSegment({ purpose: 'reentry', semanticRound: 2 }), null);
  assert.equal(
    purposeSegment({ purpose: 'validation_correction', semanticRound: 2 }),
    'correction',
  );
  assert.equal(purposeSegment({ purpose: 'infrastructure_retry', semanticRound: 1 }), 'retry');
});

test('outcomes describe what a run led to, never a bare "done"', () => {
  assert.equal(classifyRun({ ...finished, stage: 'plan' }), 'planned');
  assert.equal(classifyRun({ ...finished, stage: 'work' }), 'ready for review');
  assert.equal(classifyRun({ ...finished, stage: 'review', verdict: 'approve' }), 'approved');
  assert.equal(
    classifyRun({ ...finished, stage: 'review', verdict: 'changes_requested' }),
    'changes requested',
  );
  assert.equal(classifyRun({ ...finished, stage: 'review', verdict: 'blocked' }), 'blocked');
  assert.equal(
    classifyRun({ ...finished, stage: 'review', stale: true, verdict: 'approve' }),
    'diff changed',
  );
  assert.equal(classifyRun({ ...finished, stage: 'wrapup' }), 'finished');
  assert.equal(
    classifyRun({ ...finished, correctionScheduled: true, stage: 'work' }),
    'correcting',
  );
  assert.equal(classifyRun({ ...finished, limitPaused: true, stage: 'work' }), 'paused');
  assert.equal(
    classifyRun({ ...finished, stage: 'review', terminalKind: 'caller_ping' }),
    'waiting for you',
  );
  assert.equal(classifyRun({ ...finished, stage: 'work', terminalKind: 'crashed' }), 'failed');
  assert.equal(
    classifyRun({ ...finished, retryScheduled: true, stage: 'work', terminalKind: 'crashed' }),
    'retrying',
  );
  assert.equal(classifyRun({ ...finished, stage: 'work', status: 'running' }), 'running');
  assert.equal(outcomeTone('approved'), 'done');
  assert.equal(outcomeTone('paused'), 'attention');
  assert.equal(outcomeTone('failed'), 'failed');
  assert.equal(outcomeTone('correcting'), 'progress');
});

test('a review card names the task, the round, and the ticket progress', () => {
  const { run, snapshot } = approvedNext();
  assert.ok(run !== null);
  const value = runCard(snapshot, run, 'Meets every criterion.');
  assert.equal(value.stage, 'review');
  assert.equal(value.outcome, 'approved');
  assert.equal(value.task, '03/06 Overview page (`/`) on the v2 read module');
  assert.equal(value.round, 1);
  assert.equal(value.progress, '3/6 done');
  assert.equal(value.tone, 'done');
  assert.equal(value.next, null);
  assert.equal(runListLabel(snapshot, run), 'review · 03 · r1 · approved');
});

test('a v5 review card sums up the acceptance criteria it verified', () => {
  const { run, snapshot } = approvedNext();
  assert.ok(run !== null);
  assert.deepEqual(runCard(snapshot, run, 'Meets every criterion.').items, []);
  const verify = (lines: Array<string>) => {
    run.resultContract = REVIEW_CONTRACT;
    run.resultJson = JSON.stringify({ output: reviewV5('approve', lines.join('\n')) });
    return runCard(snapshot, run, 'Meets every criterion.').items;
  };
  assert.deepEqual(verify(['- AC1: verified — src/a.ts:1', '- AC2: verified — src/b.ts:2']), [
    '2/2 ACs verified',
  ]);
  assert.deepEqual(
    verify([
      '- AC1: verified — src/a.ts:1',
      '- AC2: not_verified — needs a browser',
      '- AC3: not_verified — needs production data',
    ]),
    ['1/3 ACs verified · AC2, AC3 not verified'],
  );
});

test('only the run a pause is about reads as paused', () => {
  const { run, snapshot } = roundLimit();
  assert.ok(run !== null);
  const card = runCard(snapshot, run, 'Two blocking problems remain.');
  assert.equal(card.outcome, 'paused');
  assert.deepEqual(card.items, [
    'R3-1 [major] Missing DB_URL bypasses the typed error page',
    'R3-2 [critical] The detail lookup can return a ticket with id "undefined"',
  ]);
  assert.equal(card.next, '/factory reply dpaez/factory-dashboard#11 "answer"');
  const others = snapshot.runs.filter((item) => item.id !== run.id);
  assert.equal(
    others.some((item) => runOutcome(snapshot, item) === 'paused'),
    false,
  );
});

test('a review whose diff changed is not reported as approved', () => {
  const { run, snapshot } = staleDiff();
  assert.ok(run !== null);
  assert.equal(runOutcome(snapshot, run), 'diff changed');
});

test('ticket runs follow start time, not the per-session sequence', () => {
  const ordered = runsInStartOrder([
    { name: 'plan', startedAt: '2026-10-08T18:22:19.000Z' },
    { name: 'work', startedAt: '2026-10-08T18:27:11.000Z' },
    { name: 'review', startedAt: '2026-10-08T18:47:47.000Z' },
    { name: 'correction', startedAt: '2026-10-08T18:45:07.000Z' },
    { name: 'next', startedAt: null },
  ]);
  assert.deepEqual(
    ordered.map((run) => run.name),
    ['plan', 'work', 'correction', 'review', 'next'],
  );
});
