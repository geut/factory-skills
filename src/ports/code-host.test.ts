import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { createGithubCodeHost, type GhJson } from './code-host.ts';

const config = {
  host: 'github.com',
  kind: 'github' as const,
  owner: 'geut',
  pullRequests: true,
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
