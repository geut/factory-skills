import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { after, test } from 'node:test';
import type { PullRequestInfo } from '../ports/code-host.ts';
import { verifyGithubSignature } from '../ports/code-host.ts';
import { createRouter } from './router.ts';
import { apiRoutes } from './routes.ts';
import { unusedCommands } from './testing.ts';

const servers: Array<Server> = [];

after(() => {
  for (const server of servers) {
    server.close();
  }
});

async function serveWith(secret: string | null, changed: Array<PullRequestInfo>): Promise<string> {
  const server = createServer(
    createRouter({
      context: {
        backlog: null,
        commands: unusedCommands,
        db: null,
        events: null,
        instanceId: 'test',
        openapi: () => ({ openapi: '3.1.0' }),
        webhooks: {
          pullRequestChanged: (pullRequest) => {
            changed.push(pullRequest);
            return pullRequest.headBranch === 'factory/proj-123' ? 'proj-123-ab12cd34' : null;
          },
          secret: () => secret,
          verify: verifyGithubSignature,
        },
      },
      routes: apiRoutes,
      validateResponses: true,
    }),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
}

const merged = {
  action: 'closed',
  pull_request: {
    closed_at: '2026-10-16T09:00:00Z',
    created_at: '2026-10-15T10:00:00Z',
    head: { ref: 'factory/proj-123' },
    html_url: 'https://github.com/geut/factory-skills/pull/7',
    merged: true,
    merged_at: '2026-10-16T09:00:00Z',
    number: 7,
    state: 'closed',
    user: { login: 'dpaez' },
  },
};

function deliver(
  base: string,
  event: string,
  payload: unknown,
  secret: string | null,
): Promise<Response> {
  const body = JSON.stringify(payload);
  return fetch(`${base}/v1/webhooks/github`, {
    body,
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      ...(secret === null
        ? {}
        : {
            'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
          }),
    },
    method: 'POST',
  });
}

test('a signed pull_request delivery updates the ticket of that pull request', async () => {
  const changed: Array<PullRequestInfo> = [];
  const base = await serveWith('s3cret', changed);
  const response = await deliver(base, 'pull_request', merged, 's3cret');
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ticket: 'proj-123-ab12cd34' });
  assert.equal(changed[0]?.state, 'merged');
  assert.equal(changed[0]?.headBranch, 'factory/proj-123');
});

test('an unsigned or wrongly signed delivery is refused and changes nothing', async () => {
  const changed: Array<PullRequestInfo> = [];
  const base = await serveWith('s3cret', changed);
  assert.equal((await deliver(base, 'pull_request', merged, null)).status, 401);
  assert.equal((await deliver(base, 'pull_request', merged, 'wrong')).status, 401);
  assert.deepEqual(changed, []);
});

test('other events and unknown pull requests are accepted and ignored', async () => {
  const changed: Array<PullRequestInfo> = [];
  const base = await serveWith('s3cret', changed);
  const ping = await deliver(base, 'ping', { zen: 'Keep it logically awesome.' }, 's3cret');
  assert.deepEqual(await ping.json(), { ticket: null });
  const other = {
    ...merged,
    pull_request: { ...merged.pull_request, head: { ref: 'someone/else' } },
  };
  const unknown = await deliver(base, 'pull_request_review', other, 's3cret');
  assert.deepEqual(await unknown.json(), { ticket: null });
});

test('without a secret, webhooks are off', async () => {
  const base = await serveWith(null, []);
  const response = await deliver(base, 'pull_request', merged, 's3cret');
  assert.equal(response.status, 404);
  assert.match(((await response.json()) as { detail: string }).detail, /webhookSecretEnv/);
});
