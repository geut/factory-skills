import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import type { GithubClient, GithubIssue } from '../src/ports/github.ts';
import { FakeRuntime, sampleUsage } from '../src/runtime/fake.ts';
import { type RunningServer, serve } from '../src/server/serve.ts';
import { openStateDatabase } from '../src/state/database.ts';
import { initRepo } from './git-repo.ts';

// Tracker updates end to end: comments and status labels on the ticket's
// issue, written through the outbox with a stand-in for gh.

const roots: Array<string> = [];
const servers: Array<RunningServer> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const issue: GithubIssue = {
  body: '',
  host: 'github.com',
  labels: [],
  nodeId: 'I_7',
  number: 7,
  owner: 'geut',
  repo: 'factory-skills',
  title: 'Remember the filter',
  url: 'https://github.com/geut/factory-skills/issues/7',
};

type Tracked = {
  comments: Array<string>;
  labels: Array<{ add: Array<string>; remove: Array<string> }>;
};

function repository(): string {
  const codeRoot = mkdtempSync(path.join(tmpdir(), 'factory-updates-'));
  roots.push(codeRoot);
  initRepo(codeRoot);
  mkdirSync(path.join(codeRoot, '.factory'));
  writeFileSync(
    path.join(codeRoot, '.factory', 'FACTORY.json'),
    JSON.stringify({
      models: { review: 'review-model', work: 'work-model' },
      tracker: {
        kind: 'github',
        owner: 'geut',
        repo: 'factory-skills',
        status: {
          in_progress: { label: 'factory:in-progress' },
          in_review: { label: 'factory:in-review' },
        },
      },
    }),
  );
  const pi = path.join(codeRoot, 'pi');
  writeFileSync(pi, '#!/bin/sh\n');
  chmodSync(pi, 0o755);
  return codeRoot;
}

function client(tracked: Tracked, overrides: Partial<GithubClient> = {}): GithubClient {
  return {
    addComment: (_input, body) => {
      tracked.comments.push(body);
    },
    editLabels: (_input, add, remove) => {
      tracked.labels.push({ add, remove });
    },
    fetchIssue: () => issue,
    listComments: () => tracked.comments,
    listSubIssues: () => [],
    ...overrides,
  };
}

async function start(
  codeRoot: string,
  github: GithubClient,
  runtime: FakeRuntime,
): Promise<{ base: string; server: RunningServer; token: string }> {
  const result = await serve({
    cwd: codeRoot,
    env: {
      FACTORY_PI_BIN: path.join(codeRoot, 'pi'),
      HERDR_PANE_ID: 'pane-1',
      HERDR_SOCKET_PATH: '/tmp/herdr.sock',
    },
    github,
    out: () => undefined,
    port: 0,
    runtime: () => runtime,
  });
  if (result.kind !== 'ok') {
    throw new Error(result.message);
  }
  servers.push(result.server);
  const token = readFileSync(path.join(codeRoot, '.factory', 'local.token'), 'utf8').trim();
  return { base: result.server.url, server: result.server, token };
}

async function startTicket(base: string, token: string): Promise<string> {
  const response = await fetch(`${base}/v1/tickets`, {
    body: JSON.stringify({ ref: 'geut/factory-skills#7' }),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    method: 'POST',
  });
  assert.equal(response.status, 202);
  return ((await response.json()) as { ticket: string }).ticket;
}

async function until(check: () => boolean, tries = 300): Promise<void> {
  for (let left = tries; left > 0 && !check(); left -= 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(check(), 'timed out');
}

function action(codeRoot: string): Record<string, unknown> {
  const db = openStateDatabase(path.join(codeRoot, '.factory'), { readOnly: true });
  try {
    return {
      ...db
        .prepare("SELECT id, status, last_error FROM actions WHERE kind = 'update_ticket_source'")
        .get(),
    };
  } finally {
    db.close();
  }
}

test('starting a ticket comments once and shows in-progress, even when the post is retried', async () => {
  const codeRoot = repository();
  const tracked: Tracked = { comments: [], labels: [] };
  // The first post reaches GitHub, then the call fails, as when the server
  // dies before it records success. The retry finds the marker and skips.
  let posts = 0;
  const flaky = client(tracked, {
    addComment: (_input, body) => {
      tracked.comments.push(body);
      posts += 1;
      if (posts === 1) {
        throw new Error('socket hang up');
      }
    },
  });
  const { base, token } = await start(codeRoot, flaky, new FakeRuntime());
  await startTicket(base, token);
  await until(() => action(codeRoot)['status'] === 'succeeded', 400);
  assert.equal(tracked.comments.length, 1);
  assert.match(tracked.comments[0] ?? '', /The factory started working on this issue\./);
  assert.match(tracked.comments[0] ?? '', /<!-- factory:tracker:.*:started -->/);
  assert.deepEqual(tracked.labels, [
    { add: ['factory:in-progress'], remove: ['factory:in-review'] },
  ]);
});

test('a question comments on the issue with how to answer it', async () => {
  const codeRoot = repository();
  const tracked: Tracked = { comments: [], labels: [] };
  const runtime = new FakeRuntime();
  const { base, token } = await start(codeRoot, client(tracked), runtime);
  await startTicket(base, token);
  await until(() => runtime.launches.length === 1 && tracked.comments.length === 1);
  const run = runtime.launches[0]?.runId;
  if (run === undefined) {
    throw new Error('missing run');
  }
  runtime.emit(run, { kind: 'caller_ping', question: 'Which API?', usage: sampleUsage() });
  await until(() => tracked.comments.length === 2);
  assert.match(tracked.comments[1] ?? '', /> Which API\?/);
  assert.match(tracked.comments[1] ?? '', /\/factory reply geut\/factory-skills#7 "answer"/);
});

test('an unreachable tracker is a warning on the ticket, never a pause', async () => {
  const codeRoot = repository();
  const runtime = new FakeRuntime();
  const down = client(
    { comments: [], labels: [] },
    {
      addComment: () => {
        throw new Error('gh: connection refused');
      },
    },
  );
  const { base, token } = await start(codeRoot, down, runtime);
  const ticket = await startTicket(base, token);
  await until(() => runtime.launches.length === 1);
  await until(() => action(codeRoot)['status'] === 'failed', 400);
  assert.match(String(action(codeRoot)['last_error']), /connection refused/);
  const read = (await (
    await fetch(`${base}/v1/tickets/${ticket}`, { headers: { authorization: `Bearer ${token}` } })
  ).json()) as { status: string; trackerWarnings: Array<string> };
  assert.notEqual(read.status, 'paused');
  assert.match(read.trackerWarnings[0] ?? '', /Tracker update failed: gh: connection refused/);
});

test('a tracker that cannot show statuses refuses a status mapping at startup', async () => {
  const codeRoot = repository();
  const tracked: Tracked = { comments: [], labels: [] };
  const { editLabels: _drop, ...noLabels } = client(tracked);
  const result = await serve({
    cwd: codeRoot,
    env: {
      FACTORY_PI_BIN: path.join(codeRoot, 'pi'),
      HERDR_PANE_ID: 'pane-1',
      HERDR_SOCKET_PATH: '/tmp/herdr.sock',
    },
    github: noLabels,
    out: () => undefined,
    port: 0,
    runtime: () => new FakeRuntime(),
  });
  assert.equal(result.kind, 'error');
  assert.match(result.kind === 'error' ? result.message : '', /cannot show statuses/);
});
