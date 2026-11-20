import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createGithubTracker,
  githubMentions,
  type GithubClient,
  type GithubIssue,
  type GithubLinked,
} from './github.ts';
import type { TrackerIssue } from './tracker.ts';

const config = {
  backlog: { labels: [], milestone: null },
  host: 'github.com',
  kind: 'github' as const,
  owner: 'geut',
  repo: 'factory-skills',
  status: {},
  updates: { checklist: true, comments: true },
};

function fetched(body: string): GithubIssue {
  return {
    author: null,
    body,
    createdAt: null,
    host: 'github.com',
    labels: [],
    nodeId: 'I_7',
    number: 7,
    owner: 'geut',
    repo: 'factory-skills',
    title: 'Remember the filter',
    updatedAt: null,
    url: 'https://github.com/geut/factory-skills/issues/7',
  };
}

// The issue as the factory saw it when the ticket started.
const issue: TrackerIssue = {
  author: null,
  body: '',
  createdAt: null,
  displayRef: 'geut/factory-skills#7',
  id: 'github:github.com:I_7',
  labels: [],
  ref: 'geut/factory-skills#7',
  title: 'Remember the filter',
  updatedAt: null,
  url: 'https://github.com/geut/factory-skills/issues/7',
};

test('the checklist is the issue body’s boxes, ticked by key in the body as it is now', async () => {
  const written: Array<string> = [];
  const tracker = createGithubTracker(config, {
    editBody: (_at, body) => {
      written.push(body);
    },
    // Someone reworded the second box after the ticket started.
    fetchIssue: () => fetched('Intro\n- [ ] Survives a reload.\n- [ ] Has a clear label.\n'),
    listSubIssues: () => [],
  });
  assert.ok(tracker.capabilities.has('checklist'));
  assert.deepEqual(await tracker.checklistItems(issue), [
    { done: false, key: '1:Survives a reload.', text: 'Survives a reload.' },
    { done: false, key: '1:Has a clear label.', text: 'Has a clear label.' },
  ]);
  assert.deepEqual(await tracker.tickBoxes(issue, ['1:Survives a reload.', '1:Has a label.']), {
    conflicts: ['1:Has a label.'],
  });
  assert.deepEqual(written, ['Intro\n- [x] Survives a reload.\n- [ ] Has a clear label.\n']);
  // Nothing to tick: the body is not written again.
  assert.deepEqual(await tracker.tickBoxes(issue, ['1:Has a label.']), {
    conflicts: ['1:Has a label.'],
  });
  assert.equal(written.length, 1);
});

test('a tracker that cannot edit the body has no checklist', async () => {
  const tracker = createGithubTracker(config, {
    fetchIssue: () => fetched(''),
    listSubIssues: () => [],
  });
  assert.equal(tracker.capabilities.has('checklist'), false);
  await assert.rejects(() => tracker.tickBoxes(issue, ['x']), /does not support/);
});

test('a replacing comment updates the comment of its key, found by a hidden marker', async () => {
  const comments: Array<{ body: string; id: number }> = [{ body: 'Started.', id: 1 }];
  const client: GithubClient = {
    addComment: (_at, body) => {
      comments.push({ body, id: comments.length + 1 });
    },
    editComment: (_at, id, body) => {
      const found = comments.find((item) => item.id === id);
      assert.ok(found !== undefined);
      found.body = body;
    },
    fetchIssue: () => fetched(''),
    listComments: () => comments,
    listSubIssues: () => [],
  };
  const tracker = createGithubTracker(config, client);
  const marker = '<!-- factory:handoff:T1 -->';
  await tracker.comment(issue, 'Finished; opened #9.', 'handoff:T1', 'replace');
  await tracker.comment(issue, 'Finished again; opened #10.', 'handoff:T1', 'replace');
  assert.deepEqual(comments, [
    { body: 'Started.', id: 1 },
    { body: `Finished again; opened #10.\n\n${marker}`, id: 2 },
  ]);
  // A once comment is still posted only once.
  await tracker.comment(issue, 'Something else.', 'handoff:T1', 'once');
  assert.equal(comments.length, 2);
});

test('only an open blocker blocks: GitHub keeps the link after the blocker closes', async () => {
  const tracker = createGithubTracker(config, {
    fetchIssue: () => fetched(''),
    listBlockedBy: () => [
      {
        body: '',
        number: 32,
        state: 'closed',
        title: 'Stats: time, quality, and configurations',
        url: 'https://github.com/geut/factory-skills/issues/32',
      },
      {
        body: '',
        number: 40,
        state: 'open',
        title: 'Stats page shell',
        url: 'https://github.com/geut/factory-skills/issues/40',
      },
    ],
    listSubIssues: () => [],
  });
  assert.deepEqual(await tracker.blockedBy(issue), [
    {
      displayRef: 'geut/factory-skills#40',
      title: 'Stats page shell',
      url: 'https://github.com/geut/factory-skills/issues/40',
    },
  ]);
});

// An issue in geut/factory-skills as a link, closed as completed unless it
// says otherwise.
function linked(number: number, overrides: Partial<GithubLinked> = {}): GithubLinked {
  return {
    comments: 0,
    kind: 'issue',
    number,
    owner: 'geut',
    pullRequests: [],
    repo: 'factory-skills',
    state: 'CLOSED',
    stateReason: 'COMPLETED',
    title: `Issue ${number}`,
    url: `https://github.com/geut/factory-skills/issues/${number}`,
    ...overrides,
  };
}

test('linked issues: parent, sub-issue, and the issues the body names, each once', async () => {
  const looked: Array<string> = [];
  const tracker = createGithubTracker(config, {
    fetchIssue: () => fetched(''),
    issueLinks: () => ({
      blockedBy: [],
      blocking: [],
      parent: linked(3, { state: 'OPEN', stateReason: null }),
      subIssues: [linked(8, { state: 'OPEN', stateReason: null })],
    }),
    listSubIssues: () => [],
    lookupRef: (at) => {
      looked.push(`${at.owner}/${at.repo}#${at.number}`);
      if (at.number === 99) {
        return null;
      }
      return at.number === 5
        ? linked(5, {
            comments: 16,
            pullRequests: ['https://github.com/geut/factory-skills/pull/6'],
          })
        : linked(at.number, { owner: at.owner, repo: at.repo });
    },
  });
  assert.ok(tracker.capabilities.has('related'));
  const found = await tracker.related({
    ...issue,
    body: 'Same fix shape as #5. Not #99. Parent is #3, see also acme/app#12 and #7 (this one).',
  });
  assert.deepEqual(
    found.map((item) => [item.relation, item.displayRef, item.state, item.stateType]),
    [
      ['parent', 'geut/factory-skills#3', 'open', 'open'],
      ['sub-issue', 'geut/factory-skills#8', 'open', 'open'],
      ['mentioned', 'geut/factory-skills#5', 'closed', 'completed'],
      ['mentioned', 'acme/app#12', 'closed', 'completed'],
    ],
  );
  assert.deepEqual(found[2]?.pullRequests, ['https://github.com/geut/factory-skills/pull/6']);
  assert.deepEqual(found[2]?.comments, { count: 16, more: false });
  // #3 is the parent already, and #7 is the issue itself: neither is looked up.
  assert.deepEqual(looked, ['geut/factory-skills#5', 'geut/factory-skills#99', 'acme/app#12']);
});

test('refs in a body: URLs, owner/repo#n, and #n, never an anchor or an entity', () => {
  assert.deepEqual(
    githubMentions(
      [
        'https://github.com/geut/factory-skills/issues/4 and https://github.com/acme/app/pull/9',
        'acme/app#12, #5, and #5 again.',
        'Not https://github.com/geut/factory-skills/pull/4#issuecomment-1, x#6, or &#123;.',
      ].join('\n'),
      { owner: 'geut', repo: 'factory-skills' },
      'github.com',
    ),
    [
      { number: 4, owner: 'geut', repo: 'factory-skills' },
      { number: 9, owner: 'acme', repo: 'app' },
      { number: 12, owner: 'acme', repo: 'app' },
      { number: 5, owner: 'geut', repo: 'factory-skills' },
    ],
  );
});

test('a client that cannot read links has no related capability', () => {
  const tracker = createGithubTracker(config, {
    fetchIssue: () => fetched(''),
    listSubIssues: () => [],
  });
  assert.equal(tracker.capabilities.has('related'), false);
});
