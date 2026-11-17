import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cancelledComment,
  feedbackRoundComment,
  handoffComment,
  pausedComment,
  startedComment,
} from './tracker-comments.ts';

const checklist = {
  decisions: ['Stored the filter in the URL.'],
  met: [],
  open: [{ id: 'B2', key: 'k', reason: 'no label yet', text: 'The filter is labelled.' }],
};
const handoff = {
  checklist,
  pullRequestUrl: 'https://github.com/geut/app/pull/9',
  rules: ['AGENTS.md'],
};

test('started, feedback-round, and cancelled comments are posted only at full', () => {
  for (const verbosity of ['minimal', 'standard'] as const) {
    const settings = { verbosity, voice: 'factory' } as const;
    assert.equal(startedComment(settings), null);
    assert.equal(feedbackRoundComment(settings, 2), null);
    assert.equal(cancelledComment(settings, { by: 'diego', reason: null }), null);
  }
  const full = { verbosity: 'full', voice: 'factory' } as const;
  assert.equal(startedComment(full), 'The factory started working on this issue.');
  assert.equal(
    feedbackRoundComment(full, 2),
    'The factory started feedback round 2 on the pull request.',
  );
  assert.equal(
    cancelledComment(full, { by: 'diego', reason: 'Out of scope.' }),
    'The factory stopped working on this issue: cancelled by diego.\n\n> Out of scope.',
  );
});

test('the handoff comment is left out at minimal, short at standard, and complete at full', () => {
  assert.equal(handoffComment({ verbosity: 'minimal', voice: 'factory' }, handoff), null);
  assert.equal(
    handoffComment({ verbosity: 'standard', voice: 'factory' }, handoff),
    [
      'The factory finished this ticket and opened https://github.com/geut/app/pull/9 for review.',
      '',
      'Left open:',
      '- [ ] The filter is labelled. — no label yet',
    ].join('\n'),
  );
  const full = handoffComment({ verbosity: 'full', voice: 'factory' }, handoff) ?? '';
  assert.match(full, /This ticket changes project rules: AGENTS\.md\./);
  assert.match(full, /Decisions:\n- Stored the filter in the URL\./);
  assert.match(full, /Left open:\n- \[ \] The filter is labelled\./);
});

test('the developer voice never names the factory or its commands', () => {
  const developer = { verbosity: 'full', voice: 'developer' } as const;
  const comments = [
    startedComment(developer),
    feedbackRoundComment(developer, 1),
    cancelledComment(developer, { by: null, reason: 'Later.' }),
    pausedComment(developer, { commandRef: '#7', question: 'Which API?' }),
    handoffComment(developer, handoff),
    handoffComment(developer, { ...handoff, pullRequestUrl: null }),
    handoffComment({ verbosity: 'standard', voice: 'developer' }, handoff),
  ];
  for (const comment of comments) {
    assert.ok(comment !== null);
    assert.doesNotMatch(comment, /factory/i);
  }
  assert.equal(comments[3], 'Blocked, need input:\n\n> Which API?');
  assert.equal(
    comments[6],
    [
      'Done, ready for review: https://github.com/geut/app/pull/9',
      '',
      'Left open:',
      '- [ ] The filter is labelled. — no label yet',
    ].join('\n'),
  );
});

test('a pause asks at every level, and the factory voice says how to answer', () => {
  for (const verbosity of ['minimal', 'standard', 'full'] as const) {
    assert.equal(
      pausedComment(
        { verbosity, voice: 'factory' },
        { commandRef: '#7', question: 'Which API?\nREST?' },
      ),
      [
        'The factory paused this ticket and needs a person:',
        '',
        '> Which API?',
        '> REST?',
        '',
        'Answer from the dashboard, or in Pi with `/factory reply #7 "answer"`.',
      ].join('\n'),
    );
  }
});
