import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  factoryVersionsSeen,
  runFacts,
  STATS_DEFINITIONS,
  statsIdentity,
  ticketFacts,
} from '../stats/facts.ts';
import { configurationMeasures, stageMeasures, summarize } from '../stats/measures.ts';
import { ProblemError } from './problem.ts';
import { defineRoute, type ApiContext } from './route.ts';

// GET /v1/stats/*: factory stats, `stats.v1`. Every response names the
// factory, the factory versions its tickets ran on, and the definitions, so
// two factories' numbers can be compared. Windows are by ticket start.

const Window = z.object({
  from: z.iso.datetime().optional().meta({ description: 'Tickets started at or after this time.' }),
  to: z.iso.datetime().optional().meta({ description: 'Tickets started before this time.' }),
});

const Envelope = {
  definitions: z.literal(STATS_DEFINITIONS),
  factoryId: z.string(),
  factoryVersions: z.array(z.string()),
};

const nullableNumber = z.number().nullable();

const Interventions = z
  .object({
    limitPauses: z.int(),
    manualCompletes: z.int(),
    manualRetries: z.int(),
    questions: z.int(),
    replies: z.int(),
    stops: z.int(),
  })
  .meta({ id: 'Interventions' });

const Summary = z
  .object({
    ...Envelope,
    costUsd: z.number(),
    externalReviewRounds: z.object({
      bot: z.int(),
      distribution: z.record(z.string(), z.int()).meta({
        description: 'Tickets with a merged or abandoned pull request, by their number of rounds.',
      }),
      human: z.int(),
      median: nullableNumber,
    }),
    followUpCommits: z.int(),
    handedOff: z.int(),
    interventions: Interventions,
    medianMs: z.object({
      factory: nullableNumber,
      handoffToMerge: nullableNumber,
      lead: nullableNumber,
      waiting: nullableNumber,
    }),
    mergeRate: nullableNumber.meta({
      description: 'Merged over merged, abandoned, and cancelled. Open and unknown are left out.',
    }),
    neededAPerson: z.int().meta({ description: 'Tickets with at least one human intervention.' }),
    outcomes: z.object({
      abandoned: z.int(),
      cancelled: z.int(),
      merged: z.int(),
      open: z.int(),
      unknown: z.int(),
    }),
    started: z.int(),
    tokens: z.int(),
  })
  .meta({ id: 'StatsSummary' });

const StageRow = z
  .object({
    acceptedOutputs: z.int(),
    agentMs: z.number(),
    correctionsPerAcceptedOutput: nullableNumber,
    costUsdPerAcceptedOutput: nullableNumber,
    firstPassAcceptance: nullableNumber,
    infrastructureLost: z.int(),
    model: z.string(),
    returnsToWork: z
      .record(z.string(), z.int())
      .meta({ description: 'By the stage that sent the task back.' }),
    reviewRoundsPerTask: nullableNumber,
    runs: z.int(),
    setup: z.string().meta({ description: 'The model setup: model and thinking level.' }),
    stage: z.string(),
    thinking: z.string(),
    tokensPerAcceptedOutput: nullableNumber,
  })
  .meta({ id: 'StatsStageRow' });

const ConfigurationRow = z
  .object({
    configuration: z
      .string()
      .meta({ description: 'The model setup of every stage, `stage=setup …`.' }),
    interventions: z.int(),
    medianCostUsd: nullableNumber,
    medianExternalReviewRounds: nullableNumber,
    medianFactoryMs: nullableNumber,
    merged: z.int(),
    mergeRate: nullableNumber,
    tickets: z.int(),
  })
  .meta({ id: 'StatsConfigurationRow' });

const TicketRow = z
  .object({
    agentMs: z.number(),
    configuration: z.string(),
    costUsd: z.number(),
    displayRef: z.string(),
    execution: z.string(),
    externalReviewRounds: z.object({ bot: z.int(), human: z.int(), total: z.int() }),
    factoryMs: nullableNumber,
    factoryVersion: z.string().nullable(),
    followUpCommits: z.int(),
    handedOffAt: z.string().nullable(),
    handoffToMergeMs: nullableNumber,
    interventions: Interventions,
    key: z.string(),
    leadMs: nullableNumber,
    mergedAt: z.string().nullable(),
    outcome: z.enum(['abandoned', 'cancelled', 'merged', 'open', 'unknown']),
    overheadMs: nullableNumber,
    stageMs: z.record(z.string(), z.number()),
    startedAt: z.string(),
    startToHandoffMs: nullableNumber,
    tokens: z.int(),
    waitingMs: z.number(),
  })
  .meta({ id: 'StatsTicketRow' });

function database(context: ApiContext): DatabaseSync {
  if (context.db === null) {
    throw new ProblemError('internal_error', 'The server has no database.');
  }
  return context.db;
}

function facts(db: DatabaseSync, query: { from?: string | undefined; to?: string | undefined }) {
  const tickets = ticketFacts(db, {
    ...(query.from === undefined ? {} : { from: query.from }),
    now: new Date().toISOString(),
    ...(query.to === undefined ? {} : { to: query.to }),
  });
  return {
    envelope: {
      definitions: STATS_DEFINITIONS,
      factoryId: statsIdentity(db).factoryId,
      factoryVersions: factoryVersionsSeen(tickets),
    },
    tickets,
  };
}

const summary = defineRoute({
  handler: ({ context, query }) => {
    const { envelope, tickets } = facts(database(context), query);
    return { body: { ...envelope, ...summarize(tickets) }, status: 200 };
  },
  method: 'GET',
  operationId: 'getStatsSummary',
  path: '/v1/stats/summary',
  request: { query: Window },
  responses: {
    200: { description: 'Totals for the tickets started in the window.', schema: Summary },
  },
  scope: 'read',
  summary: 'Factory totals: outcomes, merge rate, review rounds, cost, time, and interventions',
  tags: ['stats'],
});

const stagesRoute = defineRoute({
  handler: ({ context, query }) => {
    const db = database(context);
    const { envelope, tickets } = facts(db, query);
    const runs = runFacts(
      db,
      tickets.map((item) => item.execution),
    );
    return { body: { ...envelope, items: stageMeasures(runs) }, status: 200 };
  },
  method: 'GET',
  operationId: 'getStatsStages',
  path: '/v1/stats/stages',
  request: {
    query: Window.extend({
      groupBy: z
        .literal('setup')
        .default('setup')
        .meta({ description: 'Rows per stage and model setup.' }),
    }),
  },
  responses: {
    200: {
      description: 'Stage measures per model setup.',
      schema: z.object({ ...Envelope, items: z.array(StageRow) }).meta({ id: 'StatsStages' }),
    },
  },
  scope: 'read',
  summary: 'Stage measures per model setup',
  tags: ['stats'],
});

const configurations = defineRoute({
  handler: ({ context, query }) => {
    const { envelope, tickets } = facts(database(context), query);
    return { body: { ...envelope, items: configurationMeasures(tickets) }, status: 200 };
  },
  method: 'GET',
  operationId: 'getStatsConfigurations',
  path: '/v1/stats/configurations',
  request: { query: Window },
  responses: {
    200: {
      description: 'Ticket outcomes per factory configuration.',
      schema: z
        .object({ ...Envelope, items: z.array(ConfigurationRow) })
        .meta({ id: 'StatsConfigurations' }),
    },
  },
  scope: 'read',
  summary: 'Ticket outcomes per factory configuration',
  tags: ['stats'],
});

function decodeOffset(cursor: string | undefined): number {
  if (cursor === undefined) {
    return 0;
  }
  const offset = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!Number.isInteger(offset) || offset < 0) {
    throw new ProblemError('validation_error', 'The cursor is not valid.', [
      { message: 'Use the nextCursor of the previous page.', path: 'query.cursor' },
    ]);
  }
  return offset;
}

const ticketsRoute = defineRoute({
  handler: ({ context, query }) => {
    const { envelope, tickets } = facts(database(context), query);
    const offset = decodeOffset(query.cursor);
    const items = tickets.slice(offset, offset + query.limit);
    const next =
      offset + query.limit < tickets.length
        ? Buffer.from(String(offset + query.limit)).toString('base64url')
        : null;
    return { body: { ...envelope, items, nextCursor: next }, status: 200 };
  },
  method: 'GET',
  operationId: 'getStatsTickets',
  path: '/v1/stats/tickets',
  request: {
    query: Window.extend({
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
  },
  responses: {
    200: {
      description: 'One fact row per ticket, oldest start first.',
      schema: z
        .object({ ...Envelope, items: z.array(TicketRow), nextCursor: z.string().nullable() })
        .meta({ id: 'StatsTickets' }),
    },
  },
  scope: 'read',
  summary: 'Ticket fact rows for drill-down',
  tags: ['stats'],
});

const exportRoute = defineRoute({
  handler: ({ context, query }) => {
    const db = database(context);
    const { envelope, tickets } = facts(db, query);
    const runs = runFacts(
      db,
      tickets.map((item) => item.execution),
    );
    const byExecution = new Map(tickets.map((item) => [item.execution, item]));
    return {
      stream: (response) => {
        response.writeHead(200, { 'content-type': 'application/x-ndjson' });
        for (const ticket of tickets) {
          response.write(
            `${JSON.stringify({ definitions: envelope.definitions, factoryId: envelope.factoryId, type: 'ticket', ...ticket })}\n`,
          );
        }
        for (const run of runs) {
          const ticket = byExecution.get(run.execution);
          response.write(
            `${JSON.stringify({
              configuration: ticket?.configuration ?? '',
              definitions: envelope.definitions,
              factoryId: envelope.factoryId,
              factoryVersion: ticket?.factoryVersion ?? null,
              type: 'run',
              ...run,
            })}\n`,
          );
        }
        response.end();
      },
    };
  },
  method: 'GET',
  operationId: 'exportStats',
  path: '/v1/stats/export',
  request: { query: Window },
  responses: {
    200: {
      description:
        'NDJSON: one StatsTicketRow per line with `type: "ticket"`, then one run row per line with `type: "run"`. Every line carries factoryId and definitions, so another factory\'s export can be compared row by row.',
      mediaType: 'application/x-ndjson',
      schema: z.string(),
    },
  },
  scope: 'read',
  summary: 'Export raw ticket and run facts as NDJSON',
  tags: ['stats'],
});

export const statsRoutes = [summary, stagesRoute, configurations, ticketsRoute, exportRoute];
