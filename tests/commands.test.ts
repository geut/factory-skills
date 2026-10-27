import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { latestRevision } from '../src/controller/store.ts';
import type { GithubClient } from '../src/ports/github.ts';
import { FakeRuntime, sampleUsage } from '../src/runtime/fake.ts';
import { createClient } from '../src/server/clients.ts';
import { type RunningServer, serve } from '../src/server/serve.ts';
import { openStateDatabase } from '../src/state/database.ts';
import { initRepo } from './git-repo.ts';

// The command routes, end to end: bearer auth, the router, and the controller,
// with a fake runtime in place of Herdr.

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

const issue = {
  author: null,
  body: 'Keep the catalog filter.',
  createdAt: null,
  host: 'github.com',
  labels: [],
  nodeId: 'I_1',
  number: 7,
  owner: 'geut',
  repo: 'factory-skills',
  title: 'Remember the filter',
  updatedAt: null,
  url: 'https://github.com/geut/factory-skills/issues/7',
};

type Factory = {
  base: string;
  codeRoot: string;
  runtime: FakeRuntime;
  token: string;
};

async function factory(github: Partial<GithubClient> = {}): Promise<Factory> {
  const codeRoot = mkdtempSync(path.join(tmpdir(), 'factory-commands-'));
  roots.push(codeRoot);
  initRepo(codeRoot);
  mkdirSync(path.join(codeRoot, '.factory'));
  writeFileSync(
    path.join(codeRoot, '.factory', 'FACTORY.json'),
    JSON.stringify({
      models: { review: 'review-model', work: 'work-model' },
      tracker: { kind: 'github', owner: 'geut', repo: 'factory-skills' },
    }),
  );
  writeFileSync(path.join(codeRoot, 'proj-123.md'), '# Remember the filter\n');
  const pi = path.join(codeRoot, 'pi');
  writeFileSync(pi, '#!/bin/sh\n');
  chmodSync(pi, 0o755);
  const runtime = new FakeRuntime();
  const result = await serve({
    cwd: codeRoot,
    env: { FACTORY_PI_BIN: pi, HERDR_PANE_ID: 'pane-1', HERDR_SOCKET_PATH: '/tmp/herdr.sock' },
    github: {
      fetchIssue: () => issue,
      listSubIssues: () => [],
      ...github,
    },
    out: () => undefined,
    port: 0,
    runtime: () => runtime,
  });
  if (result.kind !== 'ok') {
    throw new Error(result.message);
  }
  servers.push(result.server);
  const token = readFileSync(path.join(codeRoot, '.factory', 'local.token'), 'utf8').trim();
  return { base: result.server.url, codeRoot, runtime, token };
}

function post(
  f: Factory,
  route: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(`${f.base}${route}`, {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: {
      authorization: `Bearer ${f.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    method: 'POST',
  });
}

async function until(check: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200 && !check(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(check(), 'timed out');
}

function query(f: Factory, sql: string, ...values: Array<string>): Record<string, unknown> {
  const db = openStateDatabase(path.join(f.codeRoot, '.factory'));
  try {
    return { ...db.prepare(sql).get(...values) };
  } finally {
    db.close();
  }
}

async function started(f: Factory): Promise<{ revision: number; ticket: string }> {
  const response = await post(f, '/v1/tickets', { ref: 'proj-123.md' });
  assert.equal(response.status, 202);
  const body = (await response.json()) as { revision: number; ticket: string };
  await until(() => f.runtime.launches.length === 1);
  return body;
}

test('starting a ticket answers 202 with its key and revision, then launches the planner', async () => {
  const f = await factory();
  const response = await post(
    f,
    '/v1/tickets',
    { ref: 'proj-123.md' },
    { 'x-factory-on-behalf-of': 'diego' },
  );
  assert.equal(response.status, 202);
  const body = (await response.json()) as { message: string; revision: number; ticket: string };
  assert.match(body.ticket, /^proj-123-[0-9a-f]{8}$/);

  const db = openStateDatabase(path.join(f.codeRoot, '.factory'));
  assert.ok(body.revision > 0 && body.revision <= latestRevision(db));
  db.close();
  assert.deepEqual(
    query(
      f,
      'SELECT actor, actor_on_behalf_of FROM events WHERE revision = ?',
      String(body.revision),
    ),
    { actor: 'local', actor_on_behalf_of: 'diego' },
  );
  await until(() => f.runtime.launches.length === 1);
  assert.equal(f.runtime.launches[0]?.mode, 'launch');
});

test('a ticket given as text starts the same way', async () => {
  const f = await factory();
  const response = await post(f, '/v1/tickets', { id: 'filter', text: '# Remember the filter' });
  assert.equal(response.status, 202);
  assert.match(((await response.json()) as { ticket: string }).ticket, /^filter-[0-9a-f]{8}$/);
});

test('repeating a command with the same Idempotency-Key applies it once', async () => {
  const f = await factory();
  const key = { 'idempotency-key': 'start-1' };
  const first = (await (await post(f, '/v1/tickets', { ref: 'proj-123.md' }, key)).json()) as {
    revision: number;
  };
  const again = (await (await post(f, '/v1/tickets', { ref: 'proj-123.md' }, key)).json()) as {
    revision: number;
  };
  assert.equal(again.revision, first.revision);
  await until(() => f.runtime.launches.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(f.runtime.launches.length, 1);
});

test('problems found before anything starts come back as typed 4xx', async () => {
  const umbrella = await factory({
    listSubIssues: () => [
      { body: '', number: 8, state: 'open' as const, title: 'Child', url: null },
    ],
  });
  const refused = await post(umbrella, '/v1/tickets', { ref: 'geut/factory-skills#7' });
  assert.equal(refused.status, 422);
  assert.equal(((await refused.json()) as { type: string }).type, 'umbrella_issue');

  const unknown = await post(umbrella, '/v1/tickets', { ref: 'not a ticket' });
  assert.equal(unknown.status, 400);
  const invalid = (await unknown.json()) as { errors: Array<{ path: string }>; type: string };
  assert.equal(invalid.type, 'validation_error');
  assert.equal(invalid.errors[0]?.path, 'body.ref');

  const down = await factory({
    fetchIssue: () => {
      throw new Error('gh: connection refused');
    },
  });
  const unavailable = await post(down, '/v1/tickets', { ref: 'geut/factory-skills#7' });
  assert.equal(unavailable.status, 502);
  assert.equal(((await unavailable.json()) as { type: string }).type, 'tracker_unavailable');
  assert.equal(umbrella.runtime.launches.length + down.runtime.launches.length, 0);
});

test('a reply resumes the waiting agent and records who sent it', async () => {
  const f = await factory();
  const { ticket } = await started(f);

  const early = await post(f, `/v1/tickets/${ticket}/replies`, { answer: 'too soon' });
  assert.equal(early.status, 409);
  assert.equal(((await early.json()) as { type: string }).type, 'not_waiting_for_reply');

  const planRun = f.runtime.launches[0]?.runId;
  if (planRun === undefined) {
    throw new Error('missing plan run');
  }
  f.runtime.emit(planRun, {
    kind: 'caller_ping',
    question: 'Which API should the filter use?',
    usage: sampleUsage(),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const response = await post(
    f,
    `/v1/tickets/${ticket}/replies`,
    { answer: 'Use the existing API' },
    { 'x-factory-on-behalf-of': 'diego' },
  );
  assert.equal(response.status, 202);
  await until(() => f.runtime.launches.length === 2);
  assert.equal(f.runtime.launches[1]?.mode, 'resume');
  assert.match(f.runtime.launches[1]?.prompt ?? '', /Use the existing API/);
  assert.deepEqual(query(f, 'SELECT actor, actor_on_behalf_of FROM attention_replies'), {
    actor: 'local',
    actor_on_behalf_of: 'diego',
  });
});

test('commands on an unknown ticket or in the wrong state are refused', async () => {
  const f = await factory();
  const missing = await post(f, '/v1/tickets/nope-00000000/retries');
  assert.equal(missing.status, 404);
  assert.equal(((await missing.json()) as { type: string }).type, 'ticket_not_found');

  const { ticket } = await started(f);
  const early = await post(f, `/v1/tickets/${ticket}/complete`);
  assert.equal(early.status, 409);
  assert.equal(((await early.json()) as { type: string }).type, 'invalid_state');

  const badKey = await post(f, '/v1/tickets/Not_A_Key/retries');
  assert.equal(badKey.status, 400);
});

test('commands need an act token', async () => {
  const f = await factory();
  const db = openStateDatabase(path.join(f.codeRoot, '.factory'));
  const created = createClient(db, { name: 'stats', now: new Date().toISOString(), scope: 'read' });
  db.close();
  const reader = { ...f, token: created.kind === 'created' ? created.token : '' };
  const refused = await post(reader, '/v1/tickets', { ref: 'proj-123.md' });
  assert.equal(refused.status, 403);
  assert.equal(f.runtime.launches.length, 0);
});

test('cancel ends a ticket once, with or without a reason', async () => {
  const f = await factory();
  const { ticket } = await started(f);
  const first = await post(f, `/v1/tickets/${ticket}/cancel`, { reason: 'Duplicate of #6' });
  assert.equal(first.status, 202);
  const again = await post(f, `/v1/tickets/${ticket}/cancel`);
  assert.equal(again.status, 202);
  assert.equal(
    ((await again.json()) as { revision: number }).revision,
    ((await first.json()) as { revision: number }).revision,
  );
  assert.deepEqual(query(f, 'SELECT status, status_reason FROM ticket_executions'), {
    status: 'cancelled',
    status_reason: 'Duplicate of #6',
  });
  const late = await post(f, `/v1/tickets/${ticket}/replies`, { answer: 'x' });
  assert.equal(late.status, 409);
});

test('a rerun adds a generation, and earlier ones stay readable', async () => {
  const f = await factory();
  const { ticket } = await started(f);
  const active = await post(f, `/v1/tickets/${ticket}/reruns`);
  assert.equal(active.status, 409);
  assert.equal(((await active.json()) as { type: string }).type, 'invalid_state');

  await post(f, `/v1/tickets/${ticket}/cancel`);
  const rerun = await post(f, `/v1/tickets/${ticket}/reruns`);
  assert.equal(rerun.status, 202);
  assert.equal(((await rerun.json()) as { ticket: string }).ticket, ticket);
  await until(() => f.runtime.launches.length === 2);

  const read = async <T>(route: string): Promise<T> =>
    (await (
      await fetch(`${f.base}${route}`, { headers: { authorization: `Bearer ${f.token}` } })
    ).json()) as T;
  const executions = await read<{
    items: Array<{ current: boolean; generation: number; status: string }>;
  }>(`/v1/tickets/${ticket}/executions`);
  assert.deepEqual(
    executions.items.map((item) => [item.generation, item.status, item.current]),
    [
      [1, 'cancelled', false],
      [2, 'active', true],
    ],
  );
  assert.equal((await read<{ execution: number }>(`/v1/tickets/${ticket}`)).execution, 2);
  const first = await read<{ execution: number; status: string }>(
    `/v1/tickets/${ticket}?execution=1`,
  );
  assert.deepEqual([first.execution, first.status], [1, 'cancelled']);
  const runs = await read<{ items: Array<unknown> }>(`/v1/tickets/${ticket}/runs?execution=1`);
  assert.equal(runs.items.length, 1);
});

test('a ticket shows the source each generation started from', async () => {
  let tracked = {
    ...issue,
    author: 'octocat',
    createdAt: '2026-10-01T00:00:00Z',
    labels: ['factory'],
    updatedAt: '2026-10-02T00:00:00Z',
  };
  const f = await factory({ fetchIssue: () => tracked });
  const response = await post(f, '/v1/tickets', { ref: 'geut/factory-skills#7' });
  assert.equal(response.status, 202);
  const { ticket } = (await response.json()) as { ticket: string };
  await until(() => f.runtime.launches.length === 1);

  tracked = {
    ...tracked,
    body: 'Keep the filter across reloads.',
    updatedAt: '2026-10-05T00:00:00Z',
  };
  await post(f, `/v1/tickets/${ticket}/cancel`);
  assert.equal((await post(f, `/v1/tickets/${ticket}/reruns`)).status, 202);
  await until(() => f.runtime.launches.length === 2);

  type Source = {
    author: string | null;
    body: string;
    createdAt: string | null;
    displayRef: string;
    fetchedAt: string;
    labels: Array<string>;
    title: string;
    updatedAt: string | null;
    url: string | null;
  };
  const source = async (query: string): Promise<Source> =>
    (
      (await (
        await fetch(`${f.base}/v1/tickets/${ticket}${query}`, {
          headers: { authorization: `Bearer ${f.token}` },
        })
      ).json()) as { source: Source }
    ).source;
  const first = await source('?execution=1');
  assert.deepEqual(
    { ...first, fetchedAt: typeof first.fetchedAt },
    {
      author: 'octocat',
      body: 'Keep the catalog filter.',
      createdAt: '2026-10-01T00:00:00Z',
      displayRef: 'geut/factory-skills#7',
      fetchedAt: 'string',
      labels: ['factory'],
      title: 'Remember the filter',
      updatedAt: '2026-10-02T00:00:00Z',
      url: 'https://github.com/geut/factory-skills/issues/7',
    },
  );
  const second = await source('');
  assert.equal(second.body, 'Keep the filter across reloads.');
  assert.equal(second.updatedAt, '2026-10-05T00:00:00Z');
});

test('a written brief is its own source, with no tracker author or url', async () => {
  const f = await factory();
  const { ticket } = await started(f);
  const detail = (await (
    await fetch(`${f.base}/v1/tickets/${ticket}`, {
      headers: { authorization: `Bearer ${f.token}` },
    })
  ).json()) as { source: { author: string | null; body: string; url: string | null } };
  assert.deepEqual(
    [detail.source.author, detail.source.body, detail.source.url],
    [null, '# Remember the filter\n', null],
  );
});
