import { z } from 'zod';
import { defineRoute, type Route } from './route.ts';

const Health = z
  .object({
    instanceId: z
      .string()
      .meta({ description: 'The server instance holding the lease. It changes on every start.' }),
    status: z.literal('ok'),
  })
  .meta({ id: 'Health' });

const health = defineRoute({
  handler: ({ context }) => ({
    body: { instanceId: context.instanceId, status: 'ok' },
    status: 200,
  }),
  method: 'GET',
  operationId: 'getHealth',
  path: '/health',
  responses: { 200: { description: 'The server is running.', schema: Health } },
  scope: null,
  summary: 'Check that the server is running',
  tags: ['meta'],
});

const openapi = defineRoute({
  handler: ({ context }) => ({ body: context.openapi(), status: 200 }),
  method: 'GET',
  operationId: 'getOpenApi',
  path: '/openapi.json',
  responses: {
    200: {
      description: 'This document.',
      schema: z.looseObject({ openapi: z.string() }).meta({ id: 'OpenApiDocument' }),
    },
  },
  scope: null,
  summary: 'Get the OpenAPI document',
  tags: ['meta'],
});

// Every route the server serves, in the order the document lists them.
export const apiRoutes: Array<Route> = [health, openapi];
