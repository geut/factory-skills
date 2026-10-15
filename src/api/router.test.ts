import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import { z } from 'zod';
import { problem, ProblemError } from './problem.ts';
import { defineRoute, type Route } from './route.ts';
import { createRouter, type RouterOptions } from './router.ts';
import { unusedCommands } from './testing.ts';

const echo = defineRoute({
  handler: ({ body, params, query }) => ({
    body: { id: params.id, limit: query.limit ?? null, ref: body.ref },
    status: 201,
  }),
  method: 'POST',
  operationId: 'echo',
  path: '/v1/things/{id}',
  request: {
    body: z.object({ ref: z.string().min(1) }),
    params: z.object({ id: z.string().regex(/^t\d+$/) }),
    query: z.object({ limit: z.coerce.number().int().positive().optional() }),
  },
  responses: {
    201: {
      description: 'Echoed.',
      schema: z.object({ id: z.string(), limit: z.number().nullable(), ref: z.string() }),
    },
  },
  scope: 'act',
  summary: 'Echo',
});

const refuse = defineRoute({
  handler: () => {
    throw new ProblemError('ticket_not_found', 'No ticket t1.');
  },
  method: 'GET',
  operationId: 'refuse',
  path: '/v1/refuse',
  responses: { 200: { description: 'Never.', schema: z.object({}) } },
  scope: 'read',
  summary: 'Refuse',
});

const crash = defineRoute({
  handler: () => {
    throw new Error('boom');
  },
  method: 'GET',
  operationId: 'crash',
  path: '/v1/crash',
  responses: { 200: { description: 'Never.', schema: z.object({}) } },
  scope: 'read',
  summary: 'Crash',
});

const drift = defineRoute({
  handler: () => ({ body: { count: 'three' }, status: 200 }),
  method: 'GET',
  operationId: 'drift',
  path: '/v1/drift',
  responses: { 200: { description: 'A count.', schema: z.object({ count: z.number() }) } },
  scope: 'read',
  summary: 'Drift',
});

const routes: Array<Route> = [echo, refuse, crash, drift];
const errors: Array<unknown> = [];
const servers: Array<Server> = [];

async function start(options: Partial<RouterOptions> = {}): Promise<string> {
  const server = createServer(
    createRouter({
      context: {
        commands: unusedCommands,
        db: null,
        events: null,
        instanceId: 'test',
        openapi: () => ({}),
        webhooks: null,
      },
      onError: (error) => errors.push(error),
      routes,
      validateResponses: true,
      ...options,
    }),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
}

let base = '';
let unchecked = '';

before(async () => {
  base = await start();
  unchecked = await start({ validateResponses: false });
});

after(() => {
  for (const server of servers) {
    server.close();
  }
});

function post(path: string, body: string, contentType = 'application/json'): Promise<Response> {
  return fetch(`${base}${path}`, {
    body,
    headers: { 'content-type': contentType },
    method: 'POST',
  });
}

async function problemOf(response: Response): Promise<Record<string, unknown>> {
  assert.equal(response.headers.get('content-type'), 'application/problem+json');
  return (await response.json()) as Record<string, unknown>;
}

test('a valid request reaches the handler with parsed params, query, and body', async () => {
  const response = await post('/v1/things/t1?limit=5', JSON.stringify({ ref: 'owner/repo#1' }));
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { id: 't1', limit: 5, ref: 'owner/repo#1' });
});

test('an invalid request is a 400 listing each bad field', async () => {
  const response = await post('/v1/things/x?limit=-1', JSON.stringify({ ref: '' }));
  assert.equal(response.status, 400);
  const body = await problemOf(response);
  assert.equal(body['type'], 'validation_error');
  const paths = (body['errors'] as Array<{ path: string }>).map((error) => error.path).sort();
  assert.deepEqual(paths, ['body.ref', 'params.id', 'query.limit']);
});

test('a body that is not JSON is a validation error', async () => {
  const body = await problemOf(await post('/v1/things/t1', '{nope'));
  assert.equal(body['type'], 'validation_error');
  assert.equal(body['detail'], 'Body is not valid JSON.');
});

test('a body that is not application/json is refused', async () => {
  const response = await post('/v1/things/t1', 'ref=x', 'application/x-www-form-urlencoded');
  assert.equal(response.status, 415);
  assert.equal((await problemOf(response))['type'], 'unsupported_media_type');
});

test('an unknown path is not_found and a wrong method lists the allowed ones', async () => {
  const missing = await fetch(`${base}/v1/nothing`);
  assert.equal(missing.status, 404);
  assert.equal((await problemOf(missing))['type'], 'not_found');

  const wrong = await fetch(`${base}/v1/things/t1`);
  assert.equal(wrong.status, 405);
  assert.equal(wrong.headers.get('allow'), 'POST');
  assert.equal((await problemOf(wrong))['type'], 'method_not_allowed');
});

test('a handler refuses with a typed problem', async () => {
  const response = await fetch(`${base}/v1/refuse`);
  assert.equal(response.status, 404);
  assert.deepEqual(await problemOf(response), problem('ticket_not_found', 'No ticket t1.'));
});

test('an unexpected error is a bare internal_error and is reported', async () => {
  errors.length = 0;
  const response = await fetch(`${base}/v1/crash`);
  assert.equal(response.status, 500);
  assert.deepEqual(await problemOf(response), problem('internal_error'));
  assert.equal(errors.length, 1);
});

test('a response that breaks its schema fails only when responses are validated', async () => {
  errors.length = 0;
  const checked = await fetch(`${base}/v1/drift`);
  assert.equal(checked.status, 500);
  assert.match(String(errors[0]), /drift response does not match its schema/);

  const passed = await fetch(`${unchecked}/v1/drift`);
  assert.equal(passed.status, 200);
  assert.deepEqual(await passed.json(), { count: 'three' });
});

test('authorize can refuse a route by its scope', async () => {
  const guarded = await start({
    authorize: (_request, scope) =>
      scope === 'act'
        ? { problem: problem('insufficient_scope', 'Needs act.') }
        : { actor: { client: 'reader', onBehalfOf: null } },
  });
  const refused = await fetch(`${guarded}/v1/things/t1`, {
    body: JSON.stringify({ ref: 'x' }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  assert.equal(refused.status, 403);
  assert.equal((await problemOf(refused))['type'], 'insufficient_scope');
});
