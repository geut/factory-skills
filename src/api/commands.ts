import { z } from 'zod';
import type { CommandOptions, CommandOutcome } from '../controller/service.ts';
import type { Actor } from '../domain.ts';
import { ProblemError, type ProblemType } from './problem.ts';
import { defineRoute, type RouteResult } from './route.ts';
import { TicketKey, TicketParams } from './schemas.ts';

// Commands return once they are committed: 202 with the ticket and the
// events.revision that recorded the command. Agents launch afterwards, so a
// client waits for the event stream to pass that revision.

const CommandAccepted = z
  .object({
    message: z.string().meta({ description: 'What the controller did, for people.' }),
    revision: z.int().nonnegative().meta({
      description: 'The events.revision that recorded the command. The event stream passes it.',
    }),
    ticket: TicketKey,
  })
  .meta({ id: 'CommandAccepted' });

const CommandHeaders = z.object({
  'idempotency-key': z.string().min(1).max(255).optional().meta({
    description:
      'Repeating a command with the same key returns the first result instead of applying it again.',
  }),
  'x-factory-on-behalf-of': z.string().optional().meta({
    description: 'Who the client acts for, such as a dashboard user. Stored, never verified.',
  }),
});

const StartTicket = z
  .union([
    z.object({
      ref: z
        .string()
        .trim()
        .min(1)
        .meta({ description: 'A GitHub issue URL, owner/repo#n, #n, KEY-123, or a local file.' }),
    }),
    z.object({
      id: z.string().trim().min(1).meta({ description: 'An id for a ticket given as text.' }),
      text: z.string().trim().min(1).meta({ description: 'The ticket itself, as markdown.' }),
    }),
  ])
  .meta({ id: 'StartTicket' });

const Reply = z
  .object({
    answer: z.string().trim().min(1).meta({ description: 'The answer for the waiting agent.' }),
  })
  .meta({ id: 'Reply' });

const accepted = {
  202: { description: 'The command is committed.', schema: CommandAccepted },
};

const refusals: Record<Exclude<CommandOutcome, { kind: 'accepted' }>['reason'], ProblemType> = {
  factory_config: 'internal_error',
  invalid_ref: 'validation_error',
  invalid_state: 'invalid_state',
  not_waiting_for_reply: 'not_waiting_for_reply',
  run_not_found: 'not_found',
  ticket_not_found: 'ticket_not_found',
  tracker_unavailable: 'tracker_unavailable',
  umbrella_issue: 'umbrella_issue',
};

function answer(outcome: CommandOutcome): RouteResult {
  if (outcome.kind === 'accepted') {
    return {
      body: { message: outcome.message, revision: outcome.revision, ticket: outcome.ticket },
      status: 202,
    };
  }
  if (outcome.reason === 'invalid_ref') {
    throw new ProblemError('validation_error', outcome.message, [
      { message: outcome.message, path: 'body.ref' },
    ]);
  }
  throw new ProblemError(refusals[outcome.reason], outcome.message);
}

function options(
  actor: Actor | null,
  headers: { 'idempotency-key'?: string | undefined },
): CommandOptions {
  return { actor, idempotencyKey: headers['idempotency-key'] ?? null };
}

const startTicket = defineRoute({
  handler: ({ actor, body, context, headers }) =>
    answer(
      context.commands.start(
        'ref' in body
          ? { kind: 'ref', value: body.ref }
          : { body: body.text, id: body.id, kind: 'text' },
        options(actor, headers),
      ),
    ),
  method: 'POST',
  operationId: 'startTicket',
  path: '/v1/tickets',
  request: { body: StartTicket, headers: CommandHeaders },
  responses: accepted,
  scope: 'act',
  summary: 'Start a ticket from a tracker issue, a local file, or text',
  tags: ['commands'],
});

const replyToTicket = defineRoute({
  handler: ({ actor, body, context, headers, params }) =>
    answer(context.commands.reply(params.key, body.answer, options(actor, headers))),
  method: 'POST',
  operationId: 'replyToTicket',
  path: '/v1/tickets/{key}/replies',
  request: { body: Reply, headers: CommandHeaders, params: TicketParams },
  responses: accepted,
  scope: 'act',
  summary: 'Answer the agent that paused the ticket',
  tags: ['commands'],
});

const retryTicket = defineRoute({
  handler: ({ actor, context, headers, params }) =>
    answer(context.commands.retry(params.key, options(actor, headers))),
  method: 'POST',
  operationId: 'retryTicket',
  path: '/v1/tickets/{key}/retries',
  request: { headers: CommandHeaders, params: TicketParams },
  responses: accepted,
  scope: 'act',
  summary: 'Retry the step that failed for infrastructure reasons',
  tags: ['commands'],
});

const completeTicket = defineRoute({
  handler: ({ actor, context, headers, params }) =>
    answer(context.commands.complete(params.key, options(actor, headers))),
  method: 'POST',
  operationId: 'completeTicket',
  path: '/v1/tickets/{key}/complete',
  request: { headers: CommandHeaders, params: TicketParams },
  responses: accepted,
  scope: 'act',
  summary: 'Mark a ticket that is ready for handoff as done',
  tags: ['commands'],
});

const cancelTicket = defineRoute({
  handler: ({ actor, body, context, headers, params }) =>
    answer(context.commands.cancel(params.key, body?.reason ?? null, options(actor, headers))),
  method: 'POST',
  operationId: 'cancelTicket',
  path: '/v1/tickets/{key}/cancel',
  request: {
    body: z
      .object({
        reason: z.string().trim().min(1).optional().meta({ description: 'Why, for the issue.' }),
      })
      .optional()
      .meta({ id: 'CancelTicket' }),
    headers: CommandHeaders,
    params: TicketParams,
  },
  responses: accepted,
  scope: 'act',
  summary:
    'End a ticket for good. Its agents stop and its tab closes; its worktree, branch, and pull request stay.',
  tags: ['commands'],
});

const rerunTicket = defineRoute({
  handler: ({ actor, context, headers, params }) =>
    answer(context.commands.rerun(params.key, options(actor, headers))),
  method: 'POST',
  operationId: 'rerunTicket',
  path: '/v1/tickets/{key}/reruns',
  request: { headers: CommandHeaders, params: TicketParams },
  responses: accepted,
  scope: 'act',
  summary:
    'Run a complete, cancelled, or failed ticket again as a new generation, from a fresh copy of its issue',
  tags: ['commands'],
});

const stopRun = defineRoute({
  handler: ({ actor, context, headers, params }) =>
    answer(context.commands.stopRun(params.id, options(actor, headers))),
  method: 'POST',
  operationId: 'stopRun',
  path: '/v1/runs/{id}/stop',
  request: { headers: CommandHeaders, params: z.object({ id: z.string().min(1) }) },
  responses: accepted,
  scope: 'act',
  summary:
    'Stop a running agent. The ticket pauses: a reply resumes the agent with instructions, a retry relaunches it.',
  tags: ['commands'],
});

export const commandRoutes = [
  startTicket,
  replyToTicket,
  retryTicket,
  completeTicket,
  cancelTicket,
  rerunTicket,
  stopRun,
];
