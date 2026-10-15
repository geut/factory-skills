import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { FakeRuntime, sampleUsage } from '../src/runtime/fake.ts';
import { type RunningServer, serve } from '../src/server/serve.ts';
import { openStateDatabase } from '../src/state/database.ts';

// The read routes, end to end, against a server with a fake runtime.

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

type Factory = { base: string; codeRoot: string; runtime: FakeRuntime; token: string };

async function factory(): Promise<Factory> {
  const codeRoot = mkdtempSync(path.join(tmpdir(), 'factory-reads-'));
  roots.push(codeRoot);
  mkdirSync(path.join(codeRoot, '.factory'));
  writeFileSync(
    path.join(codeRoot, '.factory', 'FACTORY.json'),
    JSON.stringify({ models: { review: 'review-model', work: 'work-model' } }),
  );
  for (const name of ['alpha', 'beta']) {
    writeFileSync(path.join(codeRoot, `${name}.md`), `# ${name}\n`);
  }
  const pi = path.join(codeRoot, 'pi');
  writeFileSync(pi, '#!/bin/sh\n');
  chmodSync(pi, 0o755);
  const runtime = new FakeRuntime();
  const result = await serve({
    cwd: codeRoot,
    env: { FACTORY_PI_BIN: pi, HERDR_PANE_ID: 'pane-1', HERDR_SOCKET_PATH: '/tmp/herdr.sock' },
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

async function get<T>(f: Factory, route: string, status = 200): Promise<T> {
  const response = await fetch(`${f.base}${route}`, {
    headers: { authorization: `Bearer ${f.token}` },
  });
  assert.equal(response.status, status, route);
  return (await response.json()) as T;
}

async function start(f: Factory, ref: string): Promise<string> {
  const response = await fetch(`${f.base}/v1/tickets`, {
    body: JSON.stringify({ ref }),
    headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json' },
    method: 'POST',
  });
  return ((await response.json()) as { ticket: string }).ticket;
}

async function until(check: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200 && !check(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(check(), 'timed out');
}

type Summary = { key: string; needsUser: boolean; stage: string; status: string };
type Page<T> = { items: Array<T>; nextCursor: string | null };

// Two tickets in planning; alpha's planner has asked a question.
async function twoTickets(f: Factory): Promise<{ alpha: string; beta: string }> {
  const alpha = await start(f, 'alpha.md');
  await until(() => f.runtime.launches.length === 1);
  const beta = await start(f, 'beta.md');
  await until(() => f.runtime.launches.length === 2);
  const alphaRun = f.runtime.launches[0]?.runId;
  if (alphaRun === undefined) {
    throw new Error('missing run');
  }
  f.runtime.emit(alphaRun, { kind: 'caller_ping', question: 'Which API?', usage: sampleUsage() });
  await until(() => {
    const db = openStateDatabase(path.join(f.codeRoot, '.factory'), { readOnly: true });
    const waiting = db
      .prepare("SELECT 1 FROM ticket_executions WHERE status = 'waiting_for_user'")
      .get();
    db.close();
    return waiting !== undefined;
  });
  return { alpha, beta };
}

const keys = (page: Page<Summary>) => page.items.map((item) => item.key).sort();

test('ticket filters combine with AND and repeat with OR', async () => {
  const f = await factory();
  const { alpha, beta } = await twoTickets(f);

  assert.deepEqual(keys(await get(f, '/v1/tickets')), [alpha, beta].sort());
  assert.deepEqual(keys(await get(f, '/v1/tickets?needsUser=true')), [alpha]);
  assert.deepEqual(keys(await get(f, '/v1/tickets?needsUser=false')), [beta]);
  assert.deepEqual(keys(await get(f, '/v1/tickets?stage=plan&needsUser=true')), [alpha]);
  assert.deepEqual(keys(await get(f, '/v1/tickets?stage=review&stage=qa&needsUser=true')), []);
  assert.deepEqual(keys(await get(f, '/v1/tickets?stage=review&stage=plan')), [alpha, beta].sort());
  assert.deepEqual(keys(await get(f, '/v1/tickets?state=waiting_for_user&state=paused')), [alpha]);
  assert.deepEqual(keys(await get(f, '/v1/tickets?ref=beta')), [beta]);
  assert.deepEqual(keys(await get(f, '/v1/tickets?status=finished')), []);

  const invalid = await get<{ errors: Array<{ path: string }>; type: string }>(
    f,
    '/v1/tickets?stage=nope',
    400,
  );
  assert.equal(invalid.type, 'validation_error');
  assert.equal(invalid.errors[0]?.path, 'query.stage');
});

test('all tickets page with a cursor', async () => {
  const f = await factory();
  await twoTickets(f);
  const first = await get<Page<Summary>>(f, '/v1/tickets?status=all&limit=1');
  assert.equal(first.items.length, 1);
  assert.notEqual(first.nextCursor, null);
  const second = await get<Page<Summary>>(
    f,
    `/v1/tickets?status=all&limit=1&cursor=${first.nextCursor ?? ''}`,
  );
  assert.equal(second.items.length, 1);
  assert.equal(second.nextCursor, null);
  assert.notEqual(second.items[0]?.key, first.items[0]?.key);
  await get(f, '/v1/tickets?status=all&cursor=garbage', 400);
});

test('a ticket shows its open question, and its run shows the latest activity', async () => {
  const f = await factory();
  const { alpha } = await twoTickets(f);

  const detail = await get<{
    attention: Array<{ question: string; status: string }>;
    startedBy: { client: string } | null;
    tasks: Array<unknown>;
  }>(f, `/v1/tickets/${alpha}`);
  assert.equal(detail.attention[0]?.question, 'Which API?');
  assert.equal(detail.attention[0]?.status, 'open');
  assert.equal(detail.startedBy?.client, 'local');

  const runs = await get<Page<{ activity: string | null; id: string; stage: string }>>(
    f,
    `/v1/tickets/${alpha}/runs`,
  );
  const run = runs.items[0];
  assert.equal(run?.stage, 'plan');

  // Write the run's Pi session file the way Pi does, then read it through the API.
  const db = openStateDatabase(path.join(f.codeRoot, '.factory'), { readOnly: true });
  const sessionFile = String(
    db
      .prepare(
        'SELECT s.session_file FROM agent_sessions AS s JOIN agent_runs AS r ON r.session_id = s.id WHERE r.id = ?',
      )
      .get(run?.id ?? '')?.['session_file'],
  );
  db.close();
  mkdirSync(path.dirname(sessionFile), { recursive: true });
  writeFileSync(
    sessionFile,
    [
      { message: { content: `Factory run ${run?.id}`, role: 'user' }, type: 'message' },
      {
        message: {
          content: [{ text: 'Reading the catalog code.', type: 'text' }],
          role: 'assistant',
        },
        type: 'message',
      },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n'),
  );
  const single = await get<{ activity: string | null }>(f, `/v1/runs/${run?.id}`);
  assert.equal(single.activity, 'Reading the catalog code.');

  await get(f, '/v1/tickets/nope-00000000', 404);
  await get(f, '/v1/runs/nope', 404);
});

test('agents lists the runs that are still going', async () => {
  const f = await factory();
  const { beta } = await twoTickets(f);
  const agents = await get<{ items: Array<{ stage: string; ticket: string }> }>(f, '/v1/agents');
  assert.deepEqual(
    agents.items.map((item) => [item.ticket, item.stage]),
    [[beta, 'plan']],
  );
});

test('reads need a token', async () => {
  const f = await factory();
  const response = await fetch(`${f.base}/v1/tickets`);
  assert.equal(response.status, 401);
});
