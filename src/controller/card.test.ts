import assert from 'node:assert/strict';
import { test } from 'node:test';
import { card, decodeCard, encodeCard } from './card.ts';

test('a card survives the text round trip', () => {
  const value = card({
    body: 'Two blocking problems remain.\nSee the review.',
    displayRef: 'dpaez/factory-dashboard#11',
    items: ['R2-1 [major] Missing DB_URL', 'R2-2 [critical] Undefined id'],
    next: '/factory reply dpaez/factory-dashboard#11 "answer"',
    outcome: 'changes requested',
    progress: '2/6 done',
    round: 2,
    stage: 'review',
    task: '03/06 Overview page',
    tone: 'attention',
  });
  const text = encodeCard(value);
  assert.match(text, /^dpaez\/factory-dashboard#11\nstage: review\nstatus: changes requested\n/);
  assert.deepEqual(decodeCard(text), value);
});

test('plain text decodes with its first line as the title', () => {
  const value = decodeCard('No factory execution matches proj-404.\nTry /factory status.');
  assert.equal(value.displayRef, 'No factory execution matches proj-404.');
  assert.equal(value.stage, '');
  assert.equal(value.body, 'Try /factory status.');
  assert.equal(value.tone, 'progress');
});

test('a body line that looks like a header after the body starts stays in the body', () => {
  const value = decodeCard('proj-1\nstage: work\nThe plan says:\nstatus: unknown');
  assert.equal(value.stage, 'work');
  assert.equal(value.outcome, '');
  assert.equal(value.body, 'The plan says:\nstatus: unknown');
});
