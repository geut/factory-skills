import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Tracker, TrackerCapability, TrackerIssue } from '../ports/tracker.ts';
import { applyTicketUpdate } from './ticket-source.ts';

const issue: TrackerIssue = {
  author: null,
  body: '- [ ] A reload keeps the filter.\n- [ ] The filter is labelled.\n',
  createdAt: null,
  displayRef: 'geut/factory-skills#7',
  id: 'github:github.com:I_7',
  labels: [],
  ref: 'geut/factory-skills#7',
  title: 'Remember the filter',
  updatedAt: null,
  url: 'https://github.com/geut/factory-skills/issues/7',
};

type Call = Array<unknown>;

// A tracker that records its calls; `changed` names item keys the issue no longer has.
function fake(capabilities: Array<TrackerCapability>, changed: Array<string> = []) {
  const calls: Array<Call> = [];
  const tracker: Tracker = {
    blockedBy: () => [],
    capabilities: new Set(capabilities),
    checklistItems: () => [],
    children: () => [],
    comment: (_issue, markdown, key, mode) => {
      calls.push(['comment', markdown, key, mode]);
    },
    kind: 'github',
    listBacklog: () => [],
    resolve: () => null,
    setStatus: (_issue, status) => {
      calls.push(['status', status]);
    },
    tickBoxes: (_issue, keys) => {
      calls.push(['tickBoxes', keys]);
      return { conflicts: keys.filter((key) => changed.includes(key)) };
    },
  };
  return { calls, tracker };
}

const handoff = {
  checklist: [
    { key: '1:A reload keeps the filter.', text: 'A reload keeps the filter.' },
    { key: '1:The filter is labelled.', text: 'The filter is labelled.' },
  ],
  comment: 'The factory finished this ticket.',
  commentKey: 'handoff:T1',
  idempotencyKey: 'tracker:E1:handoff:R1',
  issueStatus: 'in_review' as const,
};

test('a handoff ticks the met boxes, then replaces its one comment, then shows the status', () => {
  const { calls, tracker } = fake(['checklist', 'comment', 'status']);
  assert.deepEqual(applyTicketUpdate(tracker, issue, handoff), { conflicts: [] });
  assert.deepEqual(calls, [
    ['tickBoxes', ['1:A reload keeps the filter.', '1:The filter is labelled.']],
    ['comment', 'The factory finished this ticket.', 'handoff:T1', 'replace'],
    ['status', 'in_review'],
  ]);
});

test('a box someone changed stays unticked and the comment says so', () => {
  const { calls, tracker } = fake(['checklist', 'comment'], ['1:The filter is labelled.']);
  assert.deepEqual(applyTicketUpdate(tracker, issue, handoff), {
    conflicts: ['The filter is labelled.'],
  });
  assert.equal(
    calls[1]?.[1],
    'The factory finished this ticket.\n\nNot ticked, because the item changed on the issue:\n- The filter is labelled.',
  );
});

test('a tracker without a checklist gets the comment only', () => {
  const { calls, tracker } = fake(['comment']);
  applyTicketUpdate(tracker, issue, handoff);
  assert.deepEqual(calls, [
    ['comment', 'The factory finished this ticket.', 'handoff:T1', 'replace'],
  ]);
});

test('an update without a comment key posts once, keyed by its action', () => {
  const { calls, tracker } = fake(['comment']);
  applyTicketUpdate(tracker, issue, {
    ...handoff,
    checklist: [],
    commentKey: null,
    issueStatus: null,
  });
  assert.deepEqual(calls, [
    ['comment', 'The factory finished this ticket.', 'tracker:E1:handoff:R1', 'once'],
  ]);
});

test('a failed edit still posts the comment, with the met boxes, then fails for a retry', () => {
  const { calls, tracker } = fake(['checklist', 'comment', 'status']);
  tracker.tickBoxes = () => {
    throw new Error('gh issue edit failed');
  };
  assert.throws(() => applyTicketUpdate(tracker, issue, handoff), /gh issue edit failed/);
  assert.deepEqual(calls, [
    [
      'comment',
      'The factory finished this ticket.\n\nMet (ticking them on the issue failed):\n- [x] A reload keeps the filter.\n- [x] The filter is labelled.',
      'handoff:T1',
      'replace',
    ],
    ['status', 'in_review'],
  ]);
});
