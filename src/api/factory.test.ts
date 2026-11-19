import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  parseFactoryConfig,
  readFactoryConfig,
  writeCommunication,
  type ConfigResult,
} from '../config.ts';
import { factoryIdentity } from '../controller/facts.ts';
import { openStateDatabase } from '../state/database.ts';
import { createUpdateChecker } from '../update/checker.ts';
import type { ApiContext } from './route.ts';
import { createRouter } from './router.ts';
import { apiRoutes } from './routes.ts';
import { unusedCommands } from './testing.ts';

const servers: Array<Server> = [];
after(() => {
  for (const server of servers) {
    server.close();
  }
});

async function serveWith(
  config: ConfigResult | (() => ConfigResult),
  saveCommunication: ApiContext['saveCommunication'] = null,
  updates: ApiContext['updates'] = null,
) {
  const db = openStateDatabase(mkdtempSync(path.join(tmpdir(), 'factory-api-')), { create: true });
  const server = createServer(
    createRouter({
      context: {
        backlog: null,
        commandProgress: null,
        commands: unusedCommands,
        db,
        events: null,
        factoryConfig: typeof config === 'function' ? config : () => config,
        instanceId: 'test',
        openapi: () => ({ openapi: '3.1.0' }),
        pullRequestFormat: () => ({ path: '.github/pull_request_template.md', source: 'github' }),
        saveCommunication,
        trackerInventory: null,
        updates,
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
    communication: {
      tone: 'succinct, technical, to the point',
      verbosity: 'full',
      voice: 'factory',
    },
    factoryId,
    name: 'catalog',
    pullRequestFormat: { path: '.github/pull_request_template.md', source: 'github' },
    stages: [
      { enabled: true, name: 'plan', optional: false, perTask: false },
      { enabled: true, name: 'work', optional: false, perTask: true },
      { enabled: false, name: 'qa', optional: true, perTask: true },
      { enabled: true, name: 'review', optional: false, perTask: true },
      { enabled: true, name: 'wrapup', optional: false, perTask: false },
    ],
    update: null,
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

test('PUT /v1/factory/communication rewrites FACTORY.json, and GET reads it back', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'factory-api-root-'));
  const file = path.join(root, 'FACTORY.json');
  writeFileSync(
    file,
    `${JSON.stringify({ models: { review: 'review-model', work: 'work-model' }, name: 'catalog' }, null, 2)}\n`,
  );
  const { base } = await serveWith(
    () => readFactoryConfig(root),
    (communication) => writeCommunication(root, communication),
  );
  const put = (body: unknown) =>
    fetch(`${base}/v1/factory/communication`, {
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
      method: 'PUT',
    });
  const settings = { tone: 'terse, lowercase', verbosity: 'standard', voice: 'developer' };
  const saved = await put(settings);
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), settings);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
    communication: settings,
    models: { review: 'review-model', work: 'work-model' },
    name: 'catalog',
  });
  const read = (await (await fetch(`${base}/v1/factory`)).json()) as { communication: unknown };
  assert.deepEqual(read.communication, settings);

  // The whole block, by the same rules as the file; a refusal changes nothing.
  const before = readFileSync(file, 'utf8');
  const refused = await put({ verbosity: 'loud', voice: 'developer' });
  assert.equal(refused.status, 400);
  const problem = (await refused.json()) as { errors: Array<{ path: string }>; type: string };
  assert.equal(problem.type, 'validation_error');
  assert.deepEqual(problem.errors.map((error) => error.path).sort(), [
    'body.tone',
    'body.verbosity',
  ]);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('setting communication needs an act token', () => {
  const route = apiRoutes.find(
    (item) => item.method === 'PUT' && item.path === '/v1/factory/communication',
  );
  assert.equal(route?.scope, 'act');
});

// A checker on a fresh factory root whose GitHub lists `tags` as stable
// releases, newest first.
function checkerWith(tags: Array<string>, enabled = true) {
  return createUpdateChecker({
    current: '0.4.0',
    enabled: () => enabled,
    factoryRoot: mkdtempSync(path.join(tmpdir(), 'factory-update-')),
    gh: async () =>
      tags.map((tag) => ({
        draft: false,
        html_url: `https://github.com/geut/factory-skills/releases/tag/${tag}`,
        name: tag,
        prerelease: false,
        tag_name: tag,
      })),
    now: () => '2026-11-19T10:00:00.000Z',
  });
}

test('POST /v1/factory/update-check finds the newest release, and GET /v1/factory shows it', async () => {
  const updates = checkerWith(['v0.5.0']);
  const { base } = await serveWith(config({}), null, updates);
  const checked = await fetch(`${base}/v1/factory/update-check`, { method: 'POST' });
  assert.equal(checked.status, 200);
  const update = {
    current: '0.4.0',
    later: false,
    latest: '0.5.0',
    name: 'v0.5.0',
    notesUrl: 'https://github.com/geut/factory-skills/releases/tag/v0.5.0',
  };
  assert.deepEqual(await checked.json(), {
    message: 'factory 0.5.0 is available (you run 0.4.0).',
    update,
  });
  const read = (await (await fetch(`${base}/v1/factory`)).json()) as { update: unknown };
  assert.deepEqual(read.update, update);

  const putOff = await fetch(`${base}/v1/factory/update-later`, { method: 'POST' });
  assert.equal(putOff.status, 200);
  assert.deepEqual(await putOff.json(), { ...update, later: true });
});

test('an up-to-date factory has no update, and nothing to put off', async () => {
  const { base } = await serveWith(config({}), null, checkerWith(['v0.4.0', 'v0.3.0']));
  const checked = await fetch(`${base}/v1/factory/update-check`, { method: 'POST' });
  assert.deepEqual(await checked.json(), {
    message: 'This factory runs the newest release.',
    update: null,
  });
  const putOff = await fetch(`${base}/v1/factory/update-later`, { method: 'POST' });
  assert.equal(putOff.status, 409);
});

test('with update checks off, the check says so and GET /v1/factory shows no update', async () => {
  const updates = checkerWith(['v0.5.0'], false);
  const { base } = await serveWith(config({ updates: { check: false } }), null, updates);
  const checked = await fetch(`${base}/v1/factory/update-check`, { method: 'POST' });
  assert.deepEqual(await checked.json(), {
    message: 'Update checks are off (FACTORY.json updates.check).',
    update: null,
  });
  const read = (await (await fetch(`${base}/v1/factory`)).json()) as { update: unknown };
  assert.equal(read.update, null);
});

test('a check GitHub fails is a problem the caller can read', async () => {
  const updates = createUpdateChecker({
    current: '0.4.0',
    enabled: () => true,
    factoryRoot: mkdtempSync(path.join(tmpdir(), 'factory-update-')),
    gh: () => Promise.reject(new Error('gh: HTTP 503')),
    now: () => '2026-11-19T10:00:00.000Z',
  });
  const { base } = await serveWith(config({}), null, updates);
  const checked = await fetch(`${base}/v1/factory/update-check`, { method: 'POST' });
  assert.equal(checked.status, 502);
  assert.match(((await checked.json()) as { detail: string }).detail, /HTTP 503/);
});
