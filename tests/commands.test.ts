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
  body: 'Keep the catalog filter.',
  host: 'github.com',
  labels: [],
  nodeId: 'I_1',
  number: 7,
  owner: 'geut',
  repo: 'factory-skills',
  title: 'Remember the filter',
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
    listSubIssues: () => [{ body: '', number: 8, title: 'Child', url: null }],
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
