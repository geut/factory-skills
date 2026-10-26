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

// A tracker that records its calls; `changed` names box texts the issue no longer has.
function fake(capabilities: Array<TrackerCapability>, changed: Array<string> = []) {
  const calls: Array<Call> = [];
  const tracker: Tracker = {
    blockedBy: () => [],
    capabilities: new Set(capabilities),
    children: () => [],
    comment: (_issue, markdown, marker, mode) => {
      calls.push(['comment', markdown, marker, mode]);
    },
    kind: 'github',
    listBacklog: () => [],
    resolve: () => null,
    setStatus: (_issue, status) => {
      calls.push(['status', status]);
    },
    tickBoxes: (_issue, texts) => {
      calls.push(['tickBoxes', texts]);
      return { conflicts: texts.filter((text) => changed.includes(text)) };
    },
  };
  return { calls, tracker };
}

const handoff = {
  checklist: ['A reload keeps the filter.', 'The filter is labelled.'],
  comment: 'The factory finished this ticket.',
  commentMarker: '<!-- factory:handoff:T1 -->',
  idempotencyKey: 'tracker:E1:handoff:R1',
  issueStatus: 'in_review' as const,
};

test('a handoff ticks the met boxes, then replaces its one comment, then shows the status', () => {
  const { calls, tracker } = fake(['checklist', 'comment', 'status']);
  assert.deepEqual(applyTicketUpdate(tracker, issue, handoff), { conflicts: [] });
  assert.deepEqual(calls, [
    ['tickBoxes', handoff.checklist],
    ['comment', 'The factory finished this ticket.', '<!-- factory:handoff:T1 -->', 'replace'],
    ['status', 'in_review'],
  ]);
});

test('a box someone changed stays unticked and the comment says so', () => {
  const { calls, tracker } = fake(['checklist', 'comment'], ['The filter is labelled.']);
  assert.deepEqual(applyTicketUpdate(tracker, issue, handoff), {
    conflicts: ['The filter is labelled.'],
  });
  assert.equal(
    calls[1]?.[1],
    'The factory finished this ticket.\n\nNot ticked, because the box changed on the issue:\n- The filter is labelled.',
  );
});

test('a tracker that cannot tick boxes gets the met boxes in the comment instead', () => {
  const { calls, tracker } = fake(['comment']);
  applyTicketUpdate(tracker, issue, handoff);
  assert.deepEqual(calls, [
    [
      'comment',
      'The factory finished this ticket.\n\nMet (this tracker cannot tick the issue’s boxes):\n- [x] A reload keeps the filter.\n- [x] The filter is labelled.',
      '<!-- factory:handoff:T1 -->',
      'replace',
    ],
  ]);
});

test('an update without a marker posts once, keyed by its action', () => {
  const { calls, tracker } = fake(['comment']);
  applyTicketUpdate(tracker, issue, {
    ...handoff,
    checklist: [],
    commentMarker: null,
    issueStatus: null,
  });
  assert.deepEqual(calls, [
    [
      'comment',
      'The factory finished this ticket.',
      '<!-- factory:tracker:E1:handoff:R1 -->',
      'once',
    ],
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
      '<!-- factory:handoff:T1 -->',
      'replace',
    ],
    ['status', 'in_review'],
  ]);
});
