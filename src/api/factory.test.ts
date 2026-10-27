import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { parseFactoryConfig, type ConfigResult } from '../config.ts';
import { factoryIdentity } from '../controller/facts.ts';
import { openStateDatabase } from '../state/database.ts';
import { createRouter } from './router.ts';
import { apiRoutes } from './routes.ts';
import { unusedCommands } from './testing.ts';

const servers: Array<Server> = [];
after(() => {
  for (const server of servers) {
    server.close();
  }
});

async function serveWith(config: ConfigResult) {
  const db = openStateDatabase(mkdtempSync(path.join(tmpdir(), 'factory-api-')), { create: true });
  const server = createServer(
    createRouter({
      context: {
        backlog: null,
        commands: unusedCommands,
        db,
        events: null,
        factoryConfig: () => config,
        instanceId: 'test',
        openapi: () => ({ openapi: '3.1.0' }),
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
  return { base, factoryId: factoryIdentity(db).factoryId };
}

// A minimal FACTORY.json with `extra` on top.
const config = (extra: Record<string, unknown>) =>
  parseFactoryConfig({ models: { review: 'review-model', work: 'work-model' }, ...extra });

const qa = (enabled: boolean) => ({
  qa: { commands: [{ argv: ['npm', 'run', 'e2e'], name: 'e2e' }], enabled },
});

test('the factory route lists every stage in flow order, and which are on', async () => {
  const { base, factoryId } = await serveWith(config({ name: 'catalog', stages: qa(false) }));
  const response = await fetch(`${base}/v1/factory`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    factoryId,
    name: 'catalog',
    stages: [
      { enabled: true, name: 'plan', optional: false, perTask: false },
      { enabled: true, name: 'work', optional: false, perTask: true },
      { enabled: false, name: 'qa', optional: true, perTask: true },
      { enabled: true, name: 'review', optional: false, perTask: true },
      { enabled: true, name: 'wrapup', optional: false, perTask: false },
    ],
  });
});

// What the factory route says about QA, and the factory's name.
async function qaOf(read: ConfigResult) {
  const { base } = await serveWith(read);
  const body = (await (await fetch(`${base}/v1/factory`)).json()) as {
    name: string | null;
    stages: Array<{ enabled: boolean; name: string }>;
  };
  return { enabled: body.stages.find((stage) => stage.name === 'qa')?.enabled, name: body.name };
}

test('QA is on only when FACTORY.json enables it; with no settings it is off', async () => {
  assert.deepEqual(await qaOf(config({ stages: qa(true) })), {
    enabled: true,
    name: null,
  });
  assert.deepEqual(await qaOf(config({})), { enabled: false, name: null });
});

test('a FACTORY.json the server cannot read is a problem that keeps its paths in the server', async () => {
  const { base } = await serveWith({
    kind: 'error',
    message: 'Missing /srv/app/.factory/FACTORY.json.',
  });
  const response = await fetch(`${base}/v1/factory`);
  assert.equal(response.status, 500);
  assert.doesNotMatch(JSON.stringify(await response.json()), /\/srv\/app/);
});
