import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGithubTracker, type GithubClient } from './ports/github.ts';
import { resolveTicket } from './tickets.ts';

const tracker = {
  backlog: { labels: [], milestone: null },
  host: 'github.com',
  kind: 'github' as const,
  owner: 'geut',
  repo: 'factory-skills',
  status: {},
};

const issue = {
  author: null,
  body: 'Keep the catalog filter.',
  createdAt: null,
  host: 'github.com',
  labels: ['factory'],
  nodeId: 'I_7',
  number: 7,
  owner: 'geut',
  repo: 'factory-skills',
  title: 'Remember the filter',
  updatedAt: null,
  url: 'https://github.com/geut/factory-skills/issues/7',
};

function client(overrides: Partial<GithubClient> = {}): GithubClient {
  return { fetchIssue: () => issue, listSubIssues: () => [], ...overrides };
}

function resolve(ref: string, github: GithubClient = client()) {
  return resolveTicket({
    codeRoot: '/repo',
    factoryRoot: '/repo/.factory',
    fetchedAt: '2026-10-15T00:00:00.000Z',
    source: { kind: 'ref', value: ref },
    tracker: createGithubTracker(tracker, github),
  });
}

test('GitHub refs resolve to the same tracked ticket', () => {
  for (const ref of [
    'https://github.com/geut/factory-skills/issues/7',
    'geut/factory-skills#7',
    '#7',
    '7',
  ]) {
    const resolved = resolve(ref);
    assert.equal(resolved.kind, 'ticket', ref);
    if (resolved.kind !== 'ticket') {
      continue;
    }
    assert.equal(resolved.ticket.id, 'github:github.com:I_7');
    assert.equal(resolved.ticket.displayRef, 'geut/factory-skills#7');
    assert.equal(resolved.ticket.sourceKind, 'github');
    assert.equal(resolved.ticket.commandRef, ref);
  }
});

test('an issue with native sub-issues is an umbrella and is refused', () => {
  const resolved = resolve(
    '#7',
    client({
      listSubIssues: () => [
        {
          body: '',
          number: 8,
          state: 'open',
          title: 'First slice',
          url: 'https://github.com/geut/other/issues/8',
        },
      ],
    }),
  );
  assert.equal(resolved.kind, 'error');
  if (resolved.kind !== 'error') {
    return;
  }
  assert.equal(resolved.reason, 'umbrella_issue');
  assert.match(resolved.message, /geut\/other#8 First slice/);
});

test('issue keys are not GitHub refs, and a tracker failure says so', () => {
  const keyed = resolve('PROJ-7');
  assert.equal(keyed.kind, 'error');
  assert.equal(keyed.kind === 'error' ? keyed.reason : 'none', undefined);

  const down = resolve(
    '#7',
    client({
      fetchIssue: () => {
        throw new Error('gh: connection refused');
      },
    }),
  );
  assert.equal(down.kind === 'error' ? down.reason : 'none', 'tracker_unavailable');
});

test('blocking links come from GitHub, and without them the operation is unsupported', () => {
  const linked = createGithubTracker(
    tracker,
    client({
      listBlockedBy: () => [
        {
          body: '',
          number: 3,
          state: 'open',
          title: 'Schema first',
          url: 'https://github.com/geut/factory-skills/issues/3',
        },
      ],
    }),
  );
  const resolved = linked.resolve('#7');
  assert.equal(resolved?.kind, 'issue');
  if (resolved?.kind !== 'issue') {
    return;
  }
  assert.deepEqual(linked.blockedBy(resolved.issue), [
    {
      displayRef: 'geut/factory-skills#3',
      title: 'Schema first',
      url: 'https://github.com/geut/factory-skills/issues/3',
    },
  ]);
  assert.ok(linked.capabilities.has('blockedBy'));

  const plain = createGithubTracker(tracker, client());
  assert.equal(plain.capabilities.has('blockedBy'), false);
  assert.throws(() => plain.blockedBy(resolved.issue), /does not support blocking links/);
});
