import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGithubTracker, type GithubClient, type GithubIssue } from './github.ts';
import type { TrackerIssue } from './tracker.ts';

const config = {
  backlog: { labels: [], milestone: null },
  host: 'github.com',
  kind: 'github' as const,
  owner: 'geut',
  repo: 'factory-skills',
  status: {},
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

test('the checklist is the issue body’s boxes, ticked by key in the body as it is now', () => {
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
  assert.deepEqual(tracker.checklistItems(issue), [
    { done: false, key: '1:Survives a reload.', text: 'Survives a reload.' },
    { done: false, key: '1:Has a clear label.', text: 'Has a clear label.' },
  ]);
  assert.deepEqual(tracker.tickBoxes(issue, ['1:Survives a reload.', '1:Has a label.']), {
    conflicts: ['1:Has a label.'],
  });
  assert.deepEqual(written, ['Intro\n- [x] Survives a reload.\n- [ ] Has a clear label.\n']);
  // Nothing to tick: the body is not written again.
  assert.deepEqual(tracker.tickBoxes(issue, ['1:Has a label.']), { conflicts: ['1:Has a label.'] });
  assert.equal(written.length, 1);
});

test('a tracker that cannot edit the body has no checklist', () => {
  const tracker = createGithubTracker(config, {
    fetchIssue: () => fetched(''),
    listSubIssues: () => [],
  });
  assert.equal(tracker.capabilities.has('checklist'), false);
  assert.throws(() => tracker.tickBoxes(issue, ['x']), /does not support/);
});

test('a replacing comment updates the comment of its key, found by a hidden marker', () => {
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
  tracker.comment(issue, 'Finished; opened #9.', 'handoff:T1', 'replace');
  tracker.comment(issue, 'Finished again; opened #10.', 'handoff:T1', 'replace');
  assert.deepEqual(comments, [
    { body: 'Started.', id: 1 },
    { body: `Finished again; opened #10.\n\n${marker}`, id: 2 },
  ]);
  // A once comment is still posted only once.
  tracker.comment(issue, 'Something else.', 'handoff:T1', 'once');
  assert.equal(comments.length, 2);
});
