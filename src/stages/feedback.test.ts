import assert from 'node:assert/strict';
import { test } from 'node:test';
import { taskId } from '../domain.ts';
import {
  feedbackItemIds,
  feedbackResponseFailures,
  feedbackResponses,
  feedbackRoundOf,
  feedbackRounds,
  renderFeedbackTask,
  roundItems,
} from './feedback.ts';

const feedback = {
  items: [
    {
      comments: [
        { author: 'alice', body: 'Is this right?\nIt reads oddly.', createdAt: 't', url: 'u1' },
      ],
      kind: 'thread' as const,
      line: 12,
      path: 'src/filter.ts',
      threadId: 'PRRT_1',
    },
    {
      author: 'bob',
      body: 'Two fixes.',
      createdAt: 't',
      kind: 'review' as const,
      state: 'changes_requested',
      url: null,
    },
  ],
  since: null,
  skipped: [
    { author: 'coderabbitai', kind: 'thread' as const, url: 'u2' },
    { author: 'coderabbitai', kind: 'review' as const, url: null },
  ],
  truncated: true,
};

test('a round is task F<n>, and its task file lists the items as criteria and in full', () => {
  assert.equal(feedbackRoundOf({ taskId: taskId('F2') }), 2);
  assert.equal(feedbackRoundOf({ taskId: taskId('02') }), null);
  assert.equal(feedbackRounds([{ taskId: taskId('01') }, { taskId: taskId('F1') }]), 1);
  const items = roundItems(feedback, ' Mention it in the README. ');
  assert.deepEqual(
    items.map((item) => item.id),
    ['F1', 'F2', 'F3'],
  );
  const text = renderFeedbackTask({
    feedback,
    items,
    pullRequestUrl: 'https://x/pull/7',
    qa: true,
    round: 1,
  });
  assert.match(text, /^qa: e2e$/m);
  assert.match(
    text,
    /^- \[ \] F1: review thread on `src\/filter.ts:12` \(alice\): Is this right\?$/m,
  );
  assert.match(text, /^- \[ \] F2: changes requested review \(bob\): Two fixes\.$/m);
  assert.match(text, /^- \[ \] F3: the operator's note: Mention it in the README\.$/m);
  // The whole comment, quoted, so it reads as the reviewer's words.
  assert.match(text, /^> It reads oddly\.$/m);
  assert.match(text, /- 2 from coderabbitai: not a collaborator/);
  assert.match(text, /only the first page was read/);
  assert.deepEqual(feedbackItemIds(text), ['F1', 'F2', 'F3']);
  assert.deepEqual(roundItems({ items: [], since: null, skipped: [], truncated: false }, '  '), []);
});

test('every item is answered once, and a declined one has a reason', () => {
  const ids = ['F1', 'F2'];
  const ok =
    '## Summary\n\nDone.\n\n## Feedback responses\n\n- F1: addressed — renamed it\n- F2: declined - out of scope\n\n## Blocker\n\nnone\n';
  assert.deepEqual(feedbackResponses(ok), [
    { id: 'F1', note: 'renamed it', status: 'addressed' },
    { id: 'F2', note: 'out of scope', status: 'declined' },
  ]);
  assert.deepEqual(feedbackResponseFailures([ok], ids), []);
  assert.match(
    feedbackResponseFailures(['## Summary\n'], ids)[0] ?? '',
    /## Feedback responses is missing/,
  );
  assert.deepEqual(
    feedbackResponseFailures(
      [
        '## Feedback responses\n\n- F1: addressed\n- F1: declined — no\n- F2: declined\n- F9: addressed — ?\n',
      ],
      ids,
    ),
    [
      'F1 is answered more than once.',
      'F9 is not a feedback item of this round (F1, F2).',
      'F2 is declined without a reason.',
    ],
  );
  assert.match(
    feedbackResponseFailures(['## Feedback responses\n\n- F1: addressed — yes\n'], ids)[0] ?? '',
    /has no line for F2/,
  );
});

test('a later reply of the round updates its answers, and the others stand', () => {
  const ids = ['F1', 'F2'];
  const first = '## Feedback responses\n\n- F1: addressed — renamed it\n- F2: declined\n';
  // Review sent the round back; the reply answers the findings and F2 only.
  const returned =
    '## Review responses\n\n- R1-1: fixed — a.ts:3\n\n## Feedback responses\n\n- F2: declined — out of scope\n';
  assert.deepEqual(feedbackResponseFailures([first, returned], ids), []);
  assert.deepEqual(feedbackResponseFailures([first, '## Review responses\n\nnone\n'], ids), [
    'F2 is declined without a reason.',
  ]);
});
