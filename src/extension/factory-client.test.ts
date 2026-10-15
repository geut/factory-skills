import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { parseFactoryCommand } from '../controller/parse.ts';
import { FakeRuntime, sampleUsage } from '../runtime/fake.ts';
import { type RunningServer, serve } from '../server/serve.ts';
import { createFactoryClient, noServerMessage } from './factory-client.ts';

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

function repository(): { codeRoot: string; factoryRoot: string; pi: string } {
  const codeRoot = mkdtempSync(path.join(tmpdir(), 'factory-pi-'));
  roots.push(codeRoot);
  const factoryRoot = path.join(codeRoot, '.factory');
  mkdirSync(factoryRoot);
  writeFileSync(
    path.join(factoryRoot, 'FACTORY.json'),
    JSON.stringify({ models: { review: 'review-model', work: 'work-model' } }),
  );
  writeFileSync(path.join(codeRoot, 'proj-123.md'), '# Remember the filter\n');
  const pi = path.join(codeRoot, 'pi');
  writeFileSync(pi, '#!/bin/sh\n');
  chmodSync(pi, 0o755);
  return { codeRoot, factoryRoot, pi };
}

async function serverFor(codeRoot: string, pi: string, runtime: FakeRuntime): Promise<void> {
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
}

async function until(check: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200 && !check(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(check(), 'timed out');
}

test('without a server, commands say how to start one and nothing changes', async () => {
  const { factoryRoot } = repository();
  const client = createFactoryClient({ factoryRoot });
  const answer = await client.command(parseFactoryCommand('start proj-123.md'));
  assert.equal(answer, noServerMessage(factoryRoot));
  assert.deepEqual(client.progress(), []);
  client.close();
});

test('Pi starts a ticket through the server, then sees its cards in the database', async () => {
  const { codeRoot, factoryRoot, pi } = repository();
  const runtime = new FakeRuntime();
  await serverFor(codeRoot, pi, runtime);
  const client = createFactoryClient({ factoryRoot });
  const cursor = client.revision();

  const started = await client.command(parseFactoryCommand('start proj-123.md'));
  assert.match(started, /proj-123/);
  await until(() => runtime.launches.length === 1);
  assert.equal(client.progress()[0]?.displayRef, 'proj-123');

  const planRun = runtime.launches[0]?.runId;
  if (planRun === undefined) {
    throw new Error('missing plan run');
  }
  runtime.emit(planRun, {
    kind: 'caller_ping',
    question: 'Which API should the filter use?',
    usage: sampleUsage(),
  });
  await until(() => client.cardsSince(cursor).length > 0);
  assert.match(client.cardsSince(cursor).at(-1)?.card ?? '', /Which API should the filter use\?/);
  assert.match(client.status('proj-123'), /waiting_for_user/);

  const replied = await client.command(
    parseFactoryCommand('reply proj-123 "Use the existing API"'),
  );
  assert.doesNotMatch(replied, /No factory/);
  await until(() => runtime.launches.length === 2);
  assert.equal(runtime.launches[1]?.mode, 'resume');
  client.close();
});

test('commands for a ticket the factory does not know are refused locally', async () => {
  const { codeRoot, factoryRoot, pi } = repository();
  await serverFor(codeRoot, pi, new FakeRuntime());
  const client = createFactoryClient({ factoryRoot });
  assert.equal(
    await client.command(parseFactoryCommand('retry nope')),
    'No factory execution matches nope.',
  );
  client.close();
});

test('the extension never creates the controller', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /createFactoryService|\.recover\(/);
});
