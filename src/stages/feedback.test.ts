import assert from 'node:assert/strict';
import { test } from 'node:test';
import { taskId } from '../domain.ts';
import {
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
  assert.deepEqual(roundItems({ items: [], since: null, skipped: [], truncated: false }, '  '), []);
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
