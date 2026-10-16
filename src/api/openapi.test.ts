import assert from 'node:assert/strict';
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
