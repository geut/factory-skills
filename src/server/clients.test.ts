import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, test } from 'node:test';
import { z } from 'zod';
import { defineRoute } from '../api/route.ts';
import { createRouter } from '../api/router.ts';
import { apiRoutes } from '../api/routes.ts';
import { unusedCommands } from '../api/testing.ts';
import { openStateDatabase, stateDatabasePath } from '../state/database.ts';
import {
  authenticate,
  createAuthorizer,
  createClient,
  ensureLocalClient,
  listClients,
  localTokenPath,
  revokeClient,
} from './clients.ts';

const roots: Array<string> = [];
const dbs: Array<DatabaseSync> = [];
const servers: Array<Server> = [];
const now = '2026-10-15T10:00:00.000Z';

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
  for (const db of dbs.splice(0)) {
    db.close();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function factory(): { db: DatabaseSync; root: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'factory-clients-'));
  roots.push(root);
  const db = openStateDatabase(root, { create: true });
  dbs.push(db);
  return { db, root };
}

function create(db: DatabaseSync, name: string, scope: 'act' | 'read'): string {
  const created = createClient(db, { name, now, scope });
  assert.equal(created.kind, 'created', created.kind === 'error' ? created.message : '');
  return created.kind === 'created' ? created.token : '';
}

test('a created token authenticates, and only its hash is stored', () => {
  const { db, root } = factory();
  const token = create(db, 'dashboard', 'act');
  assert.match(token, /^fct_[\w-]{43}$/);
  assert.equal(authenticate(db, token, now)?.name, 'dashboard');
  assert.equal(listClients(db)[0]?.lastUsedAt, now);

  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  assert.equal(readFileSync(stateDatabasePath(root)).includes(token), false);
});

test('a name is taken until its client is revoked, and the old token stops working', () => {
  const { db } = factory();
  const first = create(db, 'dashboard', 'read');
  assert.equal(createClient(db, { name: 'dashboard', now, scope: 'read' }).kind, 'error');

  assert.equal(revokeClient(db, 'dashboard', now), true);
  assert.equal(authenticate(db, first, now), null);
  assert.equal(revokeClient(db, 'dashboard', now), false);

  const second = create(db, 'dashboard', 'act');
  assert.notEqual(second, first);
  assert.equal(authenticate(db, second, now)?.scope, 'act');
});

test('local is reserved and names must be simple', () => {
  const { db } = factory();
  for (const name of ['local', 'Dashboard', '-x', 'a b', 'x'.repeat(65)]) {
    assert.equal(createClient(db, { name, now, scope: 'read' }).kind, 'error', name);
  }
});

test('the local token file is private, stable, and replaced when it no longer works', () => {
  const { db, root } = factory();
  const file = localTokenPath(root);
  ensureLocalClient(db, root, now);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const token = readFileSync(file, 'utf8').trim();
  assert.equal(authenticate(db, token, now)?.scope, 'act');

  ensureLocalClient(db, root, now);
  assert.equal(readFileSync(file, 'utf8').trim(), token);

  revokeClient(db, 'local', now);
  ensureLocalClient(db, root, now);
  const renewed = readFileSync(file, 'utf8').trim();
  assert.notEqual(renewed, token);
  assert.equal(authenticate(db, renewed, now)?.name, 'local');

  unlinkSync(file);
  ensureLocalClient(db, root, now);
  assert.equal(authenticate(db, readFileSync(file, 'utf8').trim(), now)?.name, 'local');
  assert.equal(authenticate(db, renewed, now), null);
});

const act = defineRoute({
  handler: ({ actor }) => ({ body: { actor }, status: 200 }),
  method: 'POST',
  operationId: 'act',
  path: '/v1/act',
  responses: { 200: { description: 'Acted.', schema: z.object({ actor: z.unknown() }) } },
  scope: 'act',
  summary: 'Act',
});

async function serveWith(db: DatabaseSync): Promise<string> {
  const server = createServer(
    createRouter({
      authorize: createAuthorizer(db, () => now),
      context: {
        backlog: null,
        commands: unusedCommands,
        db: null,
        events: null,
        factoryConfig: null,
        instanceId: 'test',
        openapi: () => ({ openapi: '3.1.0' }),
        webhooks: null,
      },
      routes: [...apiRoutes, act],
      validateResponses: true,
    }),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
}

const bearer = (token: string, extra: Record<string, string> = {}) => ({
  headers: { authorization: `Bearer ${token}`, ...extra },
});

test('scoped routes need a live token whose scope covers them', async () => {
  const { db } = factory();
  const reader = create(db, 'stats', 'read');
  const actor = create(db, 'dashboard', 'act');
  const base = await serveWith(db);

  const anonymous = await fetch(`${base}/v1/me`);
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get('www-authenticate'), 'Bearer');
  assert.equal(((await anonymous.json()) as { type: string }).type, 'unauthorized');

  assert.equal((await fetch(`${base}/v1/me`, bearer('fct_nope'))).status, 401);
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/openapi.json`)).status, 200);

  // A client learns its token's scope before trying a command.
  const me = await fetch(`${base}/v1/me`, bearer(reader));
  assert.deepEqual(await me.json(), { name: 'stats', onBehalfOf: null, scope: 'read' });
  const acting = await fetch(`${base}/v1/me`, bearer(actor));
  assert.deepEqual(await acting.json(), { name: 'dashboard', onBehalfOf: null, scope: 'act' });

  const denied = await fetch(`${base}/v1/act`, { method: 'POST', ...bearer(reader) });
  assert.equal(denied.status, 403);
  assert.equal(((await denied.json()) as { type: string }).type, 'insufficient_scope');

  const allowed = await fetch(`${base}/v1/act`, {
    method: 'POST',
    ...bearer(actor, { 'x-factory-on-behalf-of': ' diego ' }),
  });
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), { actor: { client: 'dashboard', onBehalfOf: 'diego' } });

  revokeClient(db, 'dashboard', now);
  assert.equal((await fetch(`${base}/v1/act`, { method: 'POST', ...bearer(actor) })).status, 401);
});
