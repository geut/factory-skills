import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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
  const result = await serve({
    cwd,
    env,
    out: () => undefined,
    port: 0,
    releases: async () => [],
    runtime: fake,
  });
  assert.equal(result.kind, 'ok', result.kind === 'error' ? result.message : '');
  if (result.kind !== 'ok') {
    throw new Error('serve failed');
  }
  servers.push(result.server);
  return result.server;
}

const fake = () => new FakeRuntime();

// GitHub with one release newer than any source run.
const releases = async () => [
  {
    draft: false,
    html_url: 'https://github.com/geut/factory-skills/releases/tag/v99.0.0',
    name: 'v99.0.0',
    prerelease: false,
    tag_name: 'v99.0.0',
  },
];

test('serve refuses to start outside a Herdr pane', async () => {
  const { cwd, env } = project();
  const result = await serve({
    cwd,
    env: { ...env, HERDR_PANE_ID: '' },
    out: () => undefined,
    port: 0,
    releases: async () => [],
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
  const second = await serve({
    cwd,
    env,
    out: () => undefined,
    port: 0,
    releases: async () => [],
    runtime: fake,
  });
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

test('serve gives Pi a private local token that the API accepts', async () => {
  const { cwd, env } = project();
  const server = await start(cwd, env);
  const file = path.join(cwd, '.factory', 'local.token');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const token = readFileSync(file, 'utf8').trim();
  const me = await fetch(`${server.url}/v1/me`, { headers: { authorization: `Bearer ${token}` } });
  assert.deepEqual(await me.json(), { name: 'local', onBehalfOf: null, scope: 'act' });
  assert.equal((await fetch(`${server.url}/v1/me`)).status, 401);
});

test('an update installs the release, starts a server after this one, and hands it the lease', async () => {
  const { cwd, env } = project();
  const binary = path.join(cwd, 'factory');
  writeFileSync(binary, 'old binary');
  chmodSync(binary, 0o755);
  const sum = createHash('sha256').update('new binary').digest('hex');
  let restarted = false;
  const replacement: { started: ReturnType<typeof serve> | null } = { started: null };
  const old = await serve({
    binary,
    cwd,
    download: async ({ asset, dir }) => {
      writeFileSync(path.join(dir, asset), 'new binary');
      writeFileSync(path.join(dir, `${asset}.sha256`), `${sum}  ${asset}\n`);
    },
    env,
    onRestarted: () => {
      restarted = true;
    },
    out: () => undefined,
    port: 0,
    // The pane the restart opens runs `factory serve --after <instance>`.
    relaunch: async ({ after }) => {
      replacement.started = serve({
        after,
        cwd,
        env,
        out: () => undefined,
        port: 0,
        releases,
        runtime: fake,
      });
    },
    releases,
    runtime: fake,
  });
  if (old.kind !== 'ok') {
    throw new Error(old.message);
  }
  const token = readFileSync(path.join(cwd, '.factory', 'local.token'), 'utf8').trim();
  const response = await fetch(`${old.server.url}/v1/factory/update`, {
    headers: { authorization: `Bearer ${token}` },
    method: 'POST',
  });
  assert.equal(response.status, 202);
  assert.match(
    ((await response.json()) as { message: string }).message,
    /Installed factory 99\.0\.0/,
  );
  for (let tries = 0; tries < 200 && !restarted; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(restarted);
  assert.equal(readFileSync(binary, 'utf8'), 'new binary');
  assert.equal(readFileSync(`${binary}.previous`, 'utf8'), 'old binary');

  const taken = await (replacement.started ?? Promise.reject(new Error('no new server')));
  assert.equal(taken.kind, 'ok', taken.kind === 'error' ? taken.message : '');
  if (taken.kind === 'ok') {
    servers.push(taken.server);
    const db = openStateDatabase(path.join(cwd, '.factory'), { readOnly: true });
    assert.equal(readServerLease(db)?.instanceId, taken.server.instanceId);
    db.close();
  }
});

test('a source run refuses to update itself', async () => {
  const { cwd, env } = project();
  const server = await start(cwd, env);
  const token = readFileSync(path.join(cwd, '.factory', 'local.token'), 'utf8').trim();
  const response = await fetch(`${server.url}/v1/factory/update`, {
    headers: { authorization: `Bearer ${token}` },
    method: 'POST',
  });
  assert.equal(response.status, 409);
  assert.match(((await response.json()) as { detail: string }).detail, /git pull/);
});
