import { z } from 'zod';
import type { PullRequestInfo } from '../ports/code-host.ts';
import { ProblemError } from './problem.ts';
import { defineRoute } from './route.ts';

// POST /v1/webhooks/github: GitHub's pull_request and pull_request_review
// deliveries, a faster feed for pull request outcomes than the sync. The
// delivery's HMAC signature, not a bearer token, proves where it came from.

const HANDLED = new Set(['pull_request', 'pull_request_review']);

const WebhookReceived = z
  .object({
    ticket: z
      .string()
      .nullable()
      .meta({ description: 'The ticket the delivery updated, or null when it was ignored.' }),
  })
  .meta({ id: 'WebhookReceived' });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The pull request a delivery is about, as the code host port describes one.
export function pullRequestFromPayload(payload: unknown): PullRequestInfo | null {
  const pr = isRecord(payload) ? payload['pull_request'] : null;
  if (!isRecord(pr) || typeof pr['number'] !== 'number' || typeof pr['html_url'] !== 'string') {
    return null;
  }
  const head = isRecord(pr['head']) ? pr['head'] : {};
  const user = isRecord(pr['user']) ? pr['user'] : {};
  const mergedAt = typeof pr['merged_at'] === 'string' ? pr['merged_at'] : null;
  const closed = pr['state'] === 'closed';
  return {
    author: typeof user['login'] === 'string' ? user['login'] : null,
    closedAt: typeof pr['closed_at'] === 'string' ? pr['closed_at'] : null,
    headBranch: typeof head['ref'] === 'string' ? head['ref'] : '',
    mergedAt,
    number: pr['number'],
    openedAt: typeof pr['created_at'] === 'string' ? pr['created_at'] : null,
    state: mergedAt !== null || pr['merged'] === true ? 'merged' : closed ? 'closed' : 'open',
    url: pr['html_url'],
  };
}

const githubWebhook = defineRoute({
  handler: ({ context, headers, rawBody }) => {
    const webhooks = context.webhooks;
    const secret = webhooks?.secret() ?? null;
    if (webhooks === null || secret === null) {
      throw new ProblemError(
        'not_found',
        'Webhooks are off. Set codeHost.webhookSecretEnv and put the secret in that variable.',
      );
    }
    const body = rawBody ?? Buffer.alloc(0);
    if (!webhooks.verify(headers, body, secret)) {
      throw new ProblemError('unauthorized', 'The delivery signature does not match.');
    }
    const event = headers['x-github-event'] ?? '';
    if (!HANDLED.has(event)) {
      return { body: { ticket: null }, status: 202 };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      throw new ProblemError('validation_error', 'The delivery is not valid JSON.');
    }
    const pullRequest = pullRequestFromPayload(payload);
    const ticket = pullRequest === null ? null : webhooks.pullRequestChanged(pullRequest);
    return { body: { ticket }, status: 202 };
  },
  method: 'POST',
  operationId: 'receiveGithubWebhook',
  path: '/v1/webhooks/github',
  request: {
    headers: z.object({
      'x-github-delivery': z.string().optional(),
      'x-github-event': z.string().optional().meta({
        description:
          'pull_request and pull_request_review are handled; others are accepted and ignored.',
      }),
      'x-hub-signature-256': z.string().optional().meta({
        description: 'sha256=<HMAC of the raw body with the webhook secret>.',
      }),
    }),
    raw: true,
  },
  responses: {
    202: { description: 'The delivery was checked and handled.', schema: WebhookReceived },
  },
  scope: null,
  summary: 'Receive a GitHub webhook delivery',
  tags: ['webhooks'],
});

export const webhookRoutes = [githubWebhook];
