import { z } from 'zod';
import { commandRoutes } from './commands.ts';
import { eventRoutes } from './events.ts';
import { readRoutes } from './reads.ts';
import { defineRoute, type Route } from './route.ts';
import { statsRoutes } from './stats.ts';
import { webhookRoutes } from './webhooks.ts';

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

const Me = z
  .object({
    name: z.string().meta({ description: 'The API client the token belongs to.' }),
    onBehalfOf: z
      .string()
      .nullable()
      .meta({ description: 'The X-Factory-On-Behalf-Of header, as sent. Never verified.' }),
  })
  .meta({ id: 'Me' });

const me = defineRoute({
  handler: ({ actor }) => ({
    body: { name: actor?.client ?? '', onBehalfOf: actor?.onBehalfOf ?? null },
    status: 200,
  }),
  method: 'GET',
  operationId: 'getMe',
  path: '/v1/me',
  responses: { 200: { description: 'The client behind the token.', schema: Me } },
  scope: 'read',
  summary: 'Check a token and see which client it belongs to',
  tags: ['clients'],
});

// Every route the server serves, in the order the document lists them.
export const apiRoutes: Array<Route> = [
  health,
  openapi,
  me,
  ...readRoutes,
  ...eventRoutes,
  ...statsRoutes,
  ...commandRoutes,
  ...webhookRoutes,
];
