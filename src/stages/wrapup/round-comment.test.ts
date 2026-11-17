import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FeedbackRoundItem } from '../../domain.ts';
import { roundComment } from './round-comment.ts';

const items: Array<FeedbackRoundItem> = [
  {
    author: 'coderabbitai',
    id: 'F1',
    kind: 'thread',
    location: 'src/filter.ts:12',
    ref: 'r501',
    summary: 'Name the flag after what it keeps.',
    url: 'https://github.com/geut/app/pull/9#discussion_r501',
  },
  {
    author: 'operator',
    id: 'F2',
    kind: 'note',
    location: null,
    ref: null,
    summary: 'Mention it in the README.',
    url: null,
  },
];

const base = {
  commit: { kind: 'pushed', sha: 'abcdef1234567890' } as const,
  files: ['src/filter.ts', 'README.md'],
  items,
  pullRequestUrl: 'https://github.com/geut/app/pull/9',
  round: 2,
  verification: [
    {
      evidence: 'renamed to keepFilter (src/filter.ts:12)',
      id: 'AC1',
      status: 'verified' as const,
    },
    { evidence: 'the README has no flags section', id: 'AC2', status: 'not_verified' as const },
  ],
};

test('a round comment links its commit and says, per item, addressed or why not', () => {
  assert.equal(
    roundComment({ ...base, communication: { verbosity: 'standard', voice: 'factory' } }),
    [
      'The factory finished feedback round 2 in [abcdef1](https://github.com/geut/app/pull/9/commits/abcdef1234567890).',
      '',
      '- [F1 (coderabbitai on src/filter.ts:12)](https://github.com/geut/app/pull/9#discussion_r501): addressed',
      '- F2 (note): left as is: the README has no flags section',
    ].join('\n'),
  );
});

test('at full it adds review’s evidence and the files; the developer voice never names the factory', () => {
  const full = roundComment({ ...base, communication: { verbosity: 'full', voice: 'developer' } });
  assert.match(full, /^Feedback round 2, in \[abcdef1\]/);
  assert.match(full, /: addressed — renamed to keepFilter \(src\/filter\.ts:12\)$/m);
  assert.match(full, /\n\nFiles changed:\n- `src\/filter\.ts`\n- `README\.md`$/);
  assert.doesNotMatch(full, /factory/i);
});

test('an item review gave no line for is left as is, saying so', () => {
  const missing = roundComment({
    ...base,
    communication: { verbosity: 'minimal', voice: 'factory' },
    verification: [],
  });
  assert.match(missing, /F1 .*: left as is: review gave no verdict/);
});

test('a round with nothing to commit says so instead of naming an older commit', () => {
  const none = { ...base, commit: { kind: 'none' } as const, files: [] };
  assert.match(
    roundComment({ ...none, communication: { verbosity: 'standard', voice: 'factory' } }),
    /^The factory finished feedback round 2 without a new commit\.\n\n- /,
  );
  const developer = roundComment({
    ...none,
    communication: { verbosity: 'full', voice: 'developer' },
  });
  assert.match(developer, /^Feedback round 2, with no new commit\./);
  assert.doesNotMatch(developer, /commits\/|Files changed/);
});
