import assert from 'node:assert/strict';
import { test } from 'node:test';
import { taskId } from '../domain.ts';
import type { PullRequestFeedback } from '../ports/pull-request-feedback.ts';
import {
  feedbackResponses,
  feedbackRoundOf,
  feedbackRounds,
  parseFeedbackRound,
  renderFeedbackTask,
  roundItems,
  roundRecord,
  seenComments,
  selectFeedback,
} from './feedback.ts';

const feedback: PullRequestFeedback = {
  items: [
    {
      commentIds: ['11', '12'],
      comments: [
        { author: 'alice', body: 'Is this right?', createdAt: 't', id: '11', url: 'u0' },
        {
          author: 'alice',
          body: 'Is this right?\nIt reads oddly.',
          createdAt: 't',
          id: '12',
          url: 'u1',
        },
      ],
      kind: 'thread',
      line: 12,
      path: 'src/filter.ts',
      ref: 'r11',
      threadId: 'PRRT_1',
    },
    {
      author: 'bob',
      body: 'Two fixes.',
      commentIds: ['21'],
      createdAt: 't',
      id: '21',
      kind: 'review',
      ref: 'p21',
      state: 'changes_requested',
      url: null,
    },
  ],
  skipped: [
    { author: 'coderabbitai', id: '31', kind: 'thread', url: 'u2' },
    { author: 'coderabbitai', id: '32', kind: 'review', url: null },
  ],
  truncated: true,
};

test('a round is task F<n>, and its task file lists the items as criteria and in full', () => {
  assert.equal(feedbackRoundOf({ taskId: taskId('F2') }), 2);
  assert.equal(feedbackRoundOf({ taskId: taskId('02') }), null);
  assert.equal(feedbackRounds([{ taskId: taskId('01') }, { taskId: taskId('F1') }]), 1);
  const items = roundItems(feedback.items, ' Mention it in the README. ');
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
  assert.deepEqual(roundItems([], '  '), []);
});

test('a round records what it took and dismissed, and later rounds see neither again', () => {
  const all = selectFeedback(feedback, { only: null, skip: [] });
  assert.deepEqual('items' in all ? all.items.map((item) => item.ref) : all, ['r11', 'p21']);
  // --only takes those refs and leaves the rest pending.
  const only = selectFeedback(feedback, { only: ['p21'], skip: [] });
  assert.deepEqual(only, { dismissed: [], items: [feedback.items[1]] });
  // --skip dismisses those refs and takes the rest.
  const skip = selectFeedback(feedback, { only: null, skip: ['r11'] });
  assert.deepEqual(skip, { dismissed: ['11', '12'], items: [feedback.items[1]] });
  assert.deepEqual(selectFeedback(feedback, { only: ['r99'], skip: ['p21', 'c7'] }), {
    unknown: ['r99', 'c7'],
  });
  if (!('items' in skip)) {
    return;
  }
  const record = roundRecord({
    dismissed: skip.dismissed,
    feedback,
    items: roundItems(skip.items, null),
    pullRequestUrl: 'https://x/pull/7',
    round: 1,
  });
  // The items it took, and the skipped comments, are taken; r11 is dismissed.
  assert.deepEqual(record.taken, ['21', '31', '32']);
  assert.deepEqual(record.dismissed, ['11', '12']);
  assert.equal(record.items[0]?.ref, 'p21');
  assert.deepEqual(
    [...seenComments([{ feedback: record }, { feedback: null }])],
    ['21', '31', '32', '11', '12'],
  );
  // A round stored before refs reads back with none.
  assert.deepEqual(
    parseFeedbackRound(
      JSON.stringify({
        items: [{ author: 'a', id: 'F1', kind: 'note', location: null, summary: 's', url: null }],
        pullRequestUrl: 'u',
        round: 1,
        skipped: [],
      }),
    ),
    {
      dismissed: [],
      items: [
        { author: 'a', id: 'F1', kind: 'note', location: null, ref: null, summary: 's', url: null },
      ],
      pullRequestUrl: 'u',
      round: 1,
      skipped: [],
      taken: [],
    },
  );
});

test('a work reply’s feedback answers are read from its ## Feedback responses section', () => {
  const ok =
    '## Summary\n\nDone.\n\n## Feedback responses\n\n- F1: addressed — renamed it\n- F2: declined - out of scope\n\n## Blocker\n\nnone\n';
  assert.deepEqual(feedbackResponses(ok), [
    { id: 'F1', note: 'renamed it', status: 'addressed' },
    { id: 'F2', note: 'out of scope', status: 'declined' },
  ]);
  assert.equal(feedbackResponses('## Summary\n\nDone.\n'), null);
});
