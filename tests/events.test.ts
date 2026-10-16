import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { FakeRuntime, sampleUsage } from '../src/runtime/fake.ts';
import { type RunningServer, serve } from '../src/server/serve.ts';

// GET /v1/events end to end: what arrives, and how a client resumes.

const roots: Array<string> = [];
const servers: Array<RunningServer> = [];
const streams: Array<AbortController> = [];

afterEach(async () => {
  for (const stream of streams.splice(0)) {
    stream.abort();
  }
  for (const server of servers.splice(0)) {
    await server.close();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

type Factory = { base: string; runtime: FakeRuntime; token: string };

async function factory(): Promise<Factory> {
  const codeRoot = mkdtempSync(path.join(tmpdir(), 'factory-events-'));
  roots.push(codeRoot);
  mkdirSync(path.join(codeRoot, '.factory'));
  writeFileSync(
    path.join(codeRoot, '.factory', 'FACTORY.json'),
    JSON.stringify({ models: { review: 'review-model', work: 'work-model' } }),
  );
  writeFileSync(path.join(codeRoot, 'proj-123.md'), '# Remember the filter\n');
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
  return { base: result.server.url, runtime, token };
}

type Received = { data: Record<string, unknown>; event: string; id: number };

// Opens the stream and collects its events as they arrive.
async function listen(
  f: Factory,
  query = '',
  headers: Record<string, string> = {},
): Promise<{ events: Array<Received>; response: Response }> {
  const abort = new AbortController();
  streams.push(abort);
  const response = await fetch(`${f.base}/v1/events${query}`, {
    headers: { authorization: `Bearer ${f.token}`, ...headers },
    signal: abort.signal,
  });
  const events: Array<Received> = [];
  const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
  void (async () => {
    let buffer = '';
    for (;;) {
      const chunk = await reader?.read().catch(() => ({ done: true, value: undefined }));
      if (chunk === undefined || chunk.done === true) {
        return;
      }
      buffer += chunk.value;
      let end = buffer.indexOf('\n\n');
      while (end !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const fields = Object.fromEntries(
          block
            .split('\n')
            .filter((line) => !line.startsWith(':') && line.includes(': '))
            .map((line) => [line.slice(0, line.indexOf(': ')), line.slice(line.indexOf(': ') + 2)]),
        );
        if (fields['id'] !== undefined) {
          events.push({
            data: JSON.parse(fields['data'] ?? '{}') as Record<string, unknown>,
            event: fields['event'] ?? '',
            id: Number(fields['id']),
          });
        }
        end = buffer.indexOf('\n\n');
      }
    }
  })();
  return { events, response };
}

async function until(check: () => boolean): Promise<void> {
  for (let tries = 0; tries < 300 && !check(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(check(), 'timed out');
}

async function start(f: Factory): Promise<string> {
  const response = await fetch(`${f.base}/v1/tickets`, {
    body: JSON.stringify({ ref: 'proj-123.md' }),
    headers: {
      authorization: `Bearer ${f.token}`,
      'content-type': 'application/json',
      'x-factory-on-behalf-of': 'diego',
    },
    method: 'POST',
  });
  return ((await response.json()) as { ticket: string }).ticket;
}

test('starting a ticket produces an event on the stream', async () => {
  const f = await factory();
  const { events, response } = await listen(f);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const ticket = await start(f);
  await until(() => events.some((event) => event.event === 'start'));
  const started = events.find((event) => event.event === 'start');
  assert.deepEqual(started?.data, {
    actor: { client: 'local', onBehalfOf: 'diego' },
    card: null,
    run: null,
    task: null,
    ticket,
  });
});

test('a client that resumes with Last-Event-ID gets every later event once', async () => {
  const f = await factory();
  await start(f);
  await until(() => f.runtime.launches.length === 1);
  const runId = f.runtime.launches[0]?.runId;
  if (runId === undefined) {
    throw new Error('missing run');
  }
  f.runtime.emit(runId, { kind: 'caller_ping', question: 'Which API?', usage: sampleUsage() });

  const all = await listen(f, '?since=0');
  await until(() => all.events.some((event) => event.event === 'card'));
  const ids = all.events.map((event) => event.id);
  assert.deepEqual(
    ids,
    [...ids].sort((left, right) => left - right),
  );
  assert.equal(new Set(ids).size, ids.length);
  const card = all.events.find((event) => event.event === 'card');
  assert.match(String(card?.data['card']), /Which API\?/);

  const cut = ids[0] ?? 0;
  const resumed = await listen(f, '', { 'last-event-id': String(cut) });
  await until(() => resumed.events.length === ids.length - 1);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(
    resumed.events.map((event) => event.id),
    ids.slice(1),
  );
});

test('without a cursor the stream starts with new events only', async () => {
  const f = await factory();
  await start(f);
  await until(() => f.runtime.launches.length === 1);
  const fresh = await listen(f);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(fresh.events, []);
});

test('the stream needs a read token', async () => {
  const f = await factory();
  const response = await fetch(`${f.base}/v1/events`);
  assert.equal(response.status, 401);
});
