import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildOpenApiDocument } from './openapi.ts';
import { apiRoutes } from './routes.ts';

const documentFile = new URL('../../openapi.json', import.meta.url).pathname;

// The committed openapi.json must match the routes. After changing a route,
// run `npm run openapi:update` and commit the document.
test('the committed openapi.json matches the routes', (t) => {
  t.assert.fileSnapshot(buildOpenApiDocument(apiRoutes), documentFile, {
    serializers: [(value) => `${JSON.stringify(value, null, 2)}\n`],
  });
});

test('every route is documented with its scope', () => {
  const document = buildOpenApiDocument(apiRoutes);
  const paths = document['paths'] as Record<string, Record<string, { security: unknown }>>;
  for (const route of apiRoutes) {
    const operation = paths[route.path]?.[route.method.toLowerCase()];
    assert.notEqual(operation, undefined, `${route.method} ${route.path}`);
    assert.deepEqual(operation?.security, route.scope === null ? [] : [{ bearer: [route.scope] }]);
  }
});

type Schema = {
  const?: string;
  enum?: Array<string>;
  properties?: Record<string, Schema>;
  required?: Array<string>;
};

function schemas(): Record<string, Schema> {
  const document = buildOpenApiDocument(apiRoutes) as {
    components: { schemas: Record<string, Schema> };
  };
  return document.components.schemas;
}

test('a run’s purpose lists every purpose the database accepts, and its outcome is an enum', () => {
  const sql = readFileSync(new URL('../state/schema.sql', import.meta.url), 'utf8');
  const check = /purpose\s+TEXT NOT NULL CHECK \(\s*purpose IN \(([^)]*)\)/.exec(sql)?.[1] ?? '';
  const stored = [...check.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
  assert.ok(stored.length > 0);
  const run = schemas()['Run']?.properties;
  assert.deepEqual([...(run?.['purpose']?.enum ?? [])].sort(), [...stored].sort());
  assert.ok(run?.['outcome']?.enum?.includes('ready for handoff'));
});

test('the stats export names the schema of each line it writes', () => {
  const ticket = schemas()['StatsExportTicketLine'];
  const run = schemas()['StatsExportRunLine'];
  assert.equal(ticket?.properties?.['type']?.const, 'ticket');
  assert.equal(run?.properties?.['type']?.const, 'run');
  for (const field of [
    'purpose',
    'returnedFrom',
    'infrastructureLost',
    'passed',
    'stage',
    'task',
    'round',
    'setup',
    'tokens',
    'costUsd',
    'agentMs',
  ]) {
    assert.ok(run?.required?.includes(field), field);
  }
  assert.deepEqual(
    run?.properties?.['purpose']?.enum,
    schemas()['Run']?.properties?.['purpose']?.enum,
  );
  const document = buildOpenApiDocument(apiRoutes) as {
    paths: Record<string, { get: { responses: { 200: { description: string } } } }>;
  };
  const description = document.paths['/v1/stats/export']?.get.responses[200].description ?? '';
  assert.match(description, /StatsExportTicketLine/);
  assert.match(description, /StatsExportRunLine/);
});
