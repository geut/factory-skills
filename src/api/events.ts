import { z } from 'zod';
import type { FactoryEvent } from '../server/events.ts';
import { ProblemError } from './problem.ts';
import { defineRoute } from './route.ts';

// GET /v1/events: Server-Sent Events, one per row of the events table. Events
// are thin: they name what changed, and a client refetches it through the read
// routes. Each event's id is its revision, so a client resumes with
// Last-Event-ID (or ?since=) and gets every later event exactly once.

export const HEARTBEAT_MS = 15_000;

// The `data` of every event, as JSON.
export const EventPayload = z
  .object({
    actor: z
      .object({ client: z.string(), onBehalfOf: z.string().nullable() })
      .nullable()
      .meta({ description: 'The API client behind a command; null for everything else.' }),
    card: z
      .string()
      .nullable()
      .meta({ description: 'For `card` events, the status card the controller posted.' }),
    run: z.string().nullable(),
    task: z.string().nullable(),
    ticket: z.string().nullable().meta({ description: 'The ticket key, when the event has one.' }),
  })
  .meta({
    description:
      'The data of a /v1/events event. The SSE `id` is the revision and `event` is the kind, such as `start`, `reply`, `runtime_terminal`, `validation_finished`, or `card`.',
    id: 'EventPayload',
  });

function frame(event: FactoryEvent): string {
  const data: z.infer<typeof EventPayload> = {
    actor: event.actor,
    card: event.card,
    run: event.run,
    task: event.task,
    ticket: event.ticket,
  };
  return `id: ${event.revision}\nevent: ${event.kind}\ndata: ${JSON.stringify(data)}\n\n`;
}

const Revision = z.coerce.number().int().nonnegative();

const streamEvents = defineRoute({
  handler: ({ context, headers, query }) => {
    const hub = context.events;
    if (hub === null) {
      throw new ProblemError('internal_error', 'The server has no event feed.');
    }
    // Last-Event-ID wins: a browser's EventSource sends it on reconnect.
    const since = headers['last-event-id'] ?? query.since ?? hub.latest();
    return {
      stream: (response) => {
        response.writeHead(200, {
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'content-type': 'text/event-stream',
          'x-accel-buffering': 'no',
        });
        response.flushHeaders();
        response.write(`: from revision ${since}\n\n`);
        const unsubscribe = hub.subscribe(since, (event) => {
          response.write(frame(event));
        });
        const heartbeat = setInterval(() => {
          response.write(': heartbeat\n\n');
        }, HEARTBEAT_MS);
        response.on('close', () => {
          clearInterval(heartbeat);
          unsubscribe();
        });
      },
    };
  },
  method: 'GET',
  operationId: 'streamEvents',
  path: '/v1/events',
  request: {
    headers: z.object({
      'last-event-id': Revision.optional().meta({
        description: 'The last revision seen. EventSource sends it when it reconnects.',
      }),
    }),
    query: z.object({
      since: Revision.optional().meta({
        description: 'Start after this revision. Without it or Last-Event-ID, only new events.',
      }),
    }),
  },
  responses: {
    200: {
      description:
        'A text/event-stream. Each event has `id: <revision>`, `event: <kind>`, and `data:` holding an EventPayload. A comment line is sent every 15 s.',
      mediaType: 'text/event-stream',
      schema: z.string(),
    },
  },
  scope: 'read',
  summary: 'Stream changes as Server-Sent Events',
  tags: ['events'],
});

export const eventRoutes = [streamEvents];
