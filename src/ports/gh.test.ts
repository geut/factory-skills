import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createRouter } from '../api/router.ts';
import { apiRoutes } from '../api/routes.ts';
import { unusedCommands } from '../api/testing.ts';
import { createGithubCodeHost } from './code-host.ts';
import { ghJson } from './gh.ts';

const dirs: Array<string> = [];
const servers: Array<Server> = [];
after(() => {
  for (const server of servers) {
    server.close();
  }
  for (const dir of dirs) {
    rmSync(dir, { force: true, recursive: true });
  }
});

// A gh that takes `seconds` to answer, then prints `output`.
function slowGh(seconds: number, output: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'factory-gh-'));
  dirs.push(dir);
  const file = path.join(dir, 'gh');
  writeFileSync(file, `#!/bin/sh\nsleep ${seconds}\nprintf '%s' '${output}'\n`);
  chmodSync(file, 0o755);
  return file;
}

async function withGh<T>(bin: string, run: () => Promise<T>): Promise<T> {
  const before = process.env['FACTORY_GH_BIN'];
  process.env['FACTORY_GH_BIN'] = bin;
  try {
    return await run();
  } finally {
    if (before === undefined) {
      delete process.env['FACTORY_GH_BIN'];
    } else {
      process.env['FACTORY_GH_BIN'] = before;
    }
  }
}

test('while gh waits on GitHub, the server still answers requests', async () => {
  const server = createServer(
    createRouter({
      context: {
        backlog: null,
        commands: unusedCommands,
        db: null,
        events: null,
        factoryConfig: null,
        instanceId: 'test',
        openapi: () => ({ openapi: '3.1.0' }),
        pullRequestFormat: null,
        saveCommunication: null,
        trackerInventory: null,
        webhooks: null,
      },
      routes: apiRoutes,
      validateResponses: true,
    }),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
  const order: Array<string> = [];
  await withGh(slowGh(1, '{"number":7,"url":"https://github.com/geut/app/pull/7"}'), async () => {
    const host = createGithubCodeHost(null);
    const reading = Promise.resolve(host.pullRequest('https://github.com/geut/app/pull/7')).then(
      (found) => {
        order.push(`gh answered #${String(found?.number)}`);
      },
    );
    const health = await fetch(`${base}/health`);
    order.push(`health ${health.status}`);
    await reading;
  });
  assert.deepEqual(order, ['health 200', 'gh answered #7']);
});

test('gh output is read whole, past a pipe buffer', async () => {
  const big = JSON.stringify({ text: 'x'.repeat(2_000_000) });
  const dir = mkdtempSync(path.join(tmpdir(), 'factory-gh-'));
  dirs.push(dir);
  const payload = path.join(dir, 'payload.json');
  writeFileSync(payload, big);
  const file = path.join(dir, 'gh');
  writeFileSync(file, `#!/bin/sh\ncat '${payload}'\n`);
  chmodSync(file, 0o755);
  const parsed = await withGh(file, () => ghJson(['api', 'anything']));
  assert.equal(JSON.stringify(parsed).length, big.length);
});
