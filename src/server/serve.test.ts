import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { FakeRuntime } from '../runtime/fake.ts';
import { openStateDatabase } from '../state/database.ts';
import { readServerLease } from './lease.ts';
import { type RunningServer, serve } from './serve.ts';

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

// A repository with a factory root and a stand-in pi binary.
function project(): { cwd: string; env: NodeJS.ProcessEnv } {
  const cwd = mkdtempSync(path.join(tmpdir(), 'factory-serve-'));
  roots.push(cwd);
  mkdirSync(path.join(cwd, '.factory'));
  writeFileSync(
    path.join(cwd, '.factory', 'FACTORY.json'),
    JSON.stringify({ models: { review: 'review-model', work: 'work-model' } }),
  );
  const pi = path.join(cwd, 'pi');
  writeFileSync(pi, '#!/bin/sh\n');
  chmodSync(pi, 0o755);
  return {
    cwd,
    env: { FACTORY_PI_BIN: pi, HERDR_PANE_ID: 'pane-1', HERDR_SOCKET_PATH: '/tmp/herdr.sock' },
  };
}

async function start(cwd: string, env: NodeJS.ProcessEnv): Promise<RunningServer> {
  const result = await serve({ cwd, env, out: () => undefined, port: 0, runtime: fake });
  assert.equal(result.kind, 'ok', result.kind === 'error' ? result.message : '');
  if (result.kind !== 'ok') {
    throw new Error('serve failed');
  }
  servers.push(result.server);
  return result.server;
}

const fake = () => new FakeRuntime();

test('serve refuses to start outside a Herdr pane', async () => {
  const { cwd, env } = project();
  const result = await serve({
    cwd,
    env: { ...env, HERDR_PANE_ID: '' },
    out: () => undefined,
    port: 0,
    runtime: fake,
  });
  assert.equal(result.kind, 'error');
  assert.match(result.kind === 'error' ? result.message : '', /must run inside a Herdr pane/);
});

test('serve answers /health and publishes its url in the lease', async () => {
  const { cwd, env } = project();
  const server = await start(cwd, env);
  const response = await fetch(`${server.url}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { instanceId: server.instanceId, status: 'ok' });

  const db = openStateDatabase(path.join(cwd, '.factory'));
  assert.equal(readServerLease(db)?.url, server.url);
  db.close();
});

test('a second server on the same factory root is refused', async () => {
  const { cwd, env } = project();
  const first = await start(cwd, env);
  const second = await serve({ cwd, env, out: () => undefined, port: 0, runtime: fake });
  assert.equal(second.kind, 'error');
  assert.match(
    second.kind === 'error' ? second.message : '',
    new RegExp(`already runs .*${first.url.replaceAll('.', String.raw`\.`)}`),
  );
});

test('closing a server releases the lease for the next one', async () => {
  const { cwd, env } = project();
  const first = await start(cwd, env);
  await first.close();
  const second = await start(cwd, env);
  assert.notEqual(second.instanceId, first.instanceId);
});

test('serve publishes its OpenAPI document without a token', async () => {
  const { cwd, env } = project();
  const server = await start(cwd, env);
  const response = await fetch(`${server.url}/openapi.json`);
  assert.equal(response.status, 200);
  const document = (await response.json()) as Record<string, unknown>;
  assert.equal(document['openapi'], '3.1.0');

  const missing = await fetch(`${server.url}/v1/nothing`);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('content-type'), 'application/problem+json');
});
