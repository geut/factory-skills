import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyRun, formatRunCard, purposeSegment, runsInStartOrder } from './run-card.ts';

test('a finished correction is labeled apart from the first work run', () => {
  assert.equal(purposeSegment({ purpose: 'initial', semanticRound: 0 }), null);
  assert.equal(
    purposeSegment({ purpose: 'validation_correction', semanticRound: 2 }),
    'correction 2',
  );
  assert.equal(
    formatRunCard({
      displayRef: 'proj-123',
      outcome: 'checks failed',
      purposeLabel: null,
      stage: 'work',
      summary: 'diff is empty',
    }),
    ['proj-123', 'stage: work', 'status: checks failed', 'diff is empty'].join('\n'),
  );
  assert.equal(
    formatRunCard({
      displayRef: 'proj-123',
      outcome: 'done',
      purposeLabel: 'correction 1',
      stage: 'work',
      summary: 'Ready for review.',
    }),
    ['proj-123', 'stage: work', 'status: correction 1 · done', 'Ready for review.'].join('\n'),
  );
  assert.equal(
    classifyRun({
      correctionScheduled: true,
      limitPaused: false,
      status: 'terminal',
      terminalKind: 'subagent_done',
    }),
    'checks failed',
  );
  assert.equal(
    classifyRun({
      correctionScheduled: false,
      limitPaused: false,
      status: 'terminal',
      terminalKind: 'caller_ping',
    }),
    'needs you',
  );
  assert.equal(
    classifyRun({
      correctionScheduled: false,
      limitPaused: false,
      status: 'running',
      terminalKind: null,
    }),
    'running',
  );
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
