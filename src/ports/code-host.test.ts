import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import type { CodeHostConfig } from '../config.ts';
import { createGithubCodeHost, type GhJson, type PullRequestInfo } from './code-host.ts';

const config: CodeHostConfig = {
  feedbackAuthors: [],
  host: 'github.com',
  kind: 'github',
  owner: 'geut',
  pullRequests: true,
  pullRequestTitle: null,
  repo: 'factory-skills',
  syncMinutes: 10,
  webhookSecretEnv: null,
};

const view = {
  author: { login: 'dpaez' },
  closedAt: null,
  createdAt: '2026-10-15T10:00:00Z',
  headRefName: 'factory/proj-123',
  headRefOid: 'abc123',
  mergedAt: null,
  number: 7,
  state: 'OPEN',
  title: 'Persist the filter',
  url: 'https://github.com/geut/factory-skills/pull/7',
};

function gh(answers: Record<string, unknown>, calls: Array<string> = []): GhJson {
  return (args) => {
    const key = args.join(' ');
    calls.push(key);
    for (const [prefix, answer] of Object.entries(answers)) {
      if (key.startsWith(prefix)) {
        if (answer instanceof Error) {
          throw answer;
        }
        return answer;
      }
    }
    throw new Error(`unexpected gh ${key}`);
  };
}

test('a pull request reads by URL, and a missing one is null', () => {
  const host = createGithubCodeHost(config, gh({ 'pr view': view }));
  assert.deepEqual(host.pullRequest(view.url), {
    author: 'dpaez',
    closedAt: null,
    headBranch: 'factory/proj-123',
    headSha: 'abc123',
    mergedAt: null,
    number: 7,
    openedAt: '2026-10-15T10:00:00Z',
    state: 'open',
    title: 'Persist the filter',
    url: view.url,
  });
  const missing = createGithubCodeHost(
    config,
    gh({ 'pr view': new Error('no pull requests found for branch') }),
  );
  assert.equal(missing.pullRequest(view.url), null);
  const down = createGithubCodeHost(config, gh({ 'pr view': new Error('gh: connection refused') }));
  assert.throws(() => down.pullRequest(view.url), /connection refused/);
});

test('a pull request opened by hand is found by its branch', () => {
  const calls: Array<string> = [];
  const host = createGithubCodeHost(
    config,
    gh({ 'pr list': [{ ...view, state: 'MERGED' }] }, calls),
  );
  assert.equal(host.findPullRequest('factory/proj-123')?.state, 'merged');
  assert.match(calls[0] ?? '', /--repo geut\/factory-skills --head factory\/proj-123 --state all/);
  assert.equal(createGithubCodeHost(config, gh({ 'pr list': [] })).findPullRequest('x'), null);
});

test('an outcome carries reviews, with bots told apart, and commits', () => {
  const host = createGithubCodeHost(
    config,
    gh({
      'api --paginate --slurp repos/geut/factory-skills/pulls/7/commits': [
        [{ commit: { committer: { date: '2026-10-15T11:00:00Z' } }, sha: 'abc' }],
      ],
      'api --paginate --slurp repos/geut/factory-skills/pulls/7/reviews': [
        [
          {
            body: 'Please rename this.',
            commit_id: 'abc',
            id: 11,
            state: 'CHANGES_REQUESTED',
            submitted_at: '2026-10-15T12:00:00Z',
            user: { login: 'reviewer', type: 'User' },
          },
          {
            body: '',
            commit_id: 'abc',
            id: 12,
            state: 'COMMENTED',
            user: { login: 'coderabbitai[bot]', type: 'Bot' },
          },
        ],
      ],
      'pr view': { ...view, mergedAt: '2026-10-16T09:00:00Z', state: 'MERGED' },
    }),
  );
  const pullRequest = host.pullRequest(view.url);
  if (pullRequest === null) {
    throw new Error('missing pull request');
  }
  const outcome = host.pullRequestOutcome(pullRequest);
  assert.equal(outcome.pullRequest.state, 'merged');
  assert.deepEqual(
    outcome.reviews.map((review) => [review.id, review.state, review.authorType, review.hasBody]),
    [
      ['11', 'changes_requested', 'human', true],
      ['12', 'commented', 'bot', false],
    ],
  );
  assert.deepEqual(outcome.commits, [{ committedAt: '2026-10-15T11:00:00Z', sha: 'abc' }]);
});

test('webhook deliveries are checked against their HMAC signature', () => {
  const host = createGithubCodeHost(config, gh({}));
  const body = Buffer.from('{"action":"closed"}');
  const signature = `sha256=${createHmac('sha256', 's3cret').update(body).digest('hex')}`;
  assert.equal(host.verifyWebhook({ 'x-hub-signature-256': signature }, body, 's3cret'), true);
  assert.equal(host.verifyWebhook({ 'x-hub-signature-256': signature }, body, 'other'), false);
  assert.equal(host.verifyWebhook({}, body, 's3cret'), false);
});

// A review thread, review, or comment node as GitHub's GraphQL API returns it.
function node(input: { association?: string; at: string; author?: string | null; body: string }) {
  return {
    author: input.author === null ? null : { login: input.author ?? 'maintainer' },
    authorAssociation: input.association ?? 'MEMBER',
    body: input.body,
    createdAt: input.at,
    url: `https://github.com/geut/factory-skills/pull/7#${input.body.length}`,
  };
}

function page<T>(nodes: Array<T>, hasNextPage = false) {
  return { nodes, pageInfo: { hasNextPage } };
}

const openPullRequest: PullRequestInfo = {
  author: 'dpaez',
  closedAt: null,
  headBranch: 'factory/proj-1',
  headSha: 'abc',
  mergedAt: null,
  number: 7,
  openedAt: '2026-10-15T10:00:00Z',
  state: 'open',
  title: 'Persist the filter',
  url: 'https://github.com/geut/factory-skills/pull/7',
};

const pushed = '2026-10-16T10:00:00Z';
const before = '2026-10-16T09:00:00Z';
const after = '2026-10-16T11:00:00Z';

const feedbackPayload = {
  data: {
    repository: {
      pullRequest: {
        comments: page([
          node({ at: after, body: 'Please also update the README.' }),
          node({ at: before, body: 'An old comment before the push.' }),
          node({ association: 'NONE', at: after, author: 'passerby', body: 'Rewrite it in Rust.' }),
          node({ at: after, body: 'Addressed. <!-- factory:feedback:1:F1 -->' }),
        ]),
        reviews: page([
          {
            ...node({ at: after, body: 'Two things to fix.' }),
            state: 'CHANGES_REQUESTED',
            submittedAt: after,
          },
          { ...node({ at: after, body: '' }), state: 'APPROVED', submittedAt: after },
          {
            ...node({ association: 'NONE', at: after, author: 'coderabbitai', body: 'Nitpicks.' }),
            state: 'COMMENTED',
            submittedAt: after,
          },
        ]),
        reviewThreads: page([
          {
            comments: page([
              node({ at: before, body: 'Is this name right?' }),
              node({ at: after, body: 'It still reads oddly.' }),
            ]),
            id: 'PRRT_open',
            isResolved: false,
            line: 12,
            originalLine: 10,
            path: 'src/filter.ts',
          },
          {
            comments: page([node({ at: after, body: 'Fixed, thanks.' })]),
            id: 'PRRT_resolved',
            isResolved: true,
            line: 3,
            originalLine: 3,
            path: 'src/store.ts',
          },
          {
            comments: page([node({ at: before, body: 'Answered in round 1.' })]),
            id: 'PRRT_old',
            isResolved: false,
            line: null,
            originalLine: 7,
            path: 'src/old.ts',
          },
          {
            comments: page([
              node({
                association: 'NONE',
                at: after,
                author: 'coderabbitai',
                body: 'Consider a guard here.',
              }),
            ]),
            id: 'PRRT_bot',
            isResolved: false,
            line: 4,
            originalLine: 4,
            path: 'src/guard.ts',
          },
        ]),
      },
    },
  },
};

test('feedback since the last push: unresolved threads, review bodies and comments from collaborators', () => {
  const calls: Array<string> = [];
  const host = createGithubCodeHost(config, gh({ 'api graphql': feedbackPayload }, calls));
  const feedback = host.pullRequestFeedback(openPullRequest, pushed);
  assert.match(calls[0] ?? '', /owner=geut -F repo=factory-skills -F number=7$/);
  assert.deepEqual(
    feedback.items.map((item) =>
      item.kind === 'thread'
        ? `${item.kind} ${item.path}:${item.line} ${item.threadId} (${item.comments.length})`
        : `${item.kind} ${item.body}`,
    ),
    [
      // The whole thread, its earlier comment included, for context.
      'thread src/filter.ts:12 PRRT_open (2)',
      'review Two things to fix.',
      'comment Please also update the README.',
    ],
  );
  // Resolved threads, threads with nothing new, the factory's own replies,
  // empty review bodies, and comments from before the push are left out.
  assert.deepEqual(
    feedback.skipped.map((item) => `${item.kind} ${item.author}`),
    ['thread coderabbitai', 'review coderabbitai', 'comment passerby'],
  );
  assert.equal(feedback.truncated, false);
});

test('a listed bot counts, whichever way its login is spelled', () => {
  for (const listed of ['coderabbitai', 'coderabbitai[bot]', 'CodeRabbitAI']) {
    const host = createGithubCodeHost(
      { ...config, feedbackAuthors: [listed] },
      gh({ 'api graphql': feedbackPayload }),
    );
    const feedback = host.pullRequestFeedback(openPullRequest, pushed);
    assert.deepEqual(
      feedback.skipped.map((item) => item.author),
      ['passerby'],
      listed,
    );
    assert.equal(feedback.items.length, 5);
  }
});

test('a feedback list longer than one page is flagged, and an unexpected payload fails', () => {
  const long = structuredClone(feedbackPayload);
  long.data.repository.pullRequest.comments.pageInfo.hasNextPage = true;
  const host = createGithubCodeHost(config, gh({ 'api graphql': long }));
  assert.equal(host.pullRequestFeedback(openPullRequest, pushed).truncated, true);
  const broken = createGithubCodeHost(config, gh({ 'api graphql': { data: null } }));
  assert.throws(
    () => broken.pullRequestFeedback(openPullRequest, pushed),
    /Unexpected pull request feedback from GitHub/,
  );
});
