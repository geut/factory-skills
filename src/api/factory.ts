import { z } from 'zod';
import { Communication } from '../communication.ts';
import { factoryIdentity } from '../controller/facts.ts';
import { flowOrder, stageEnabled } from '../stages/flow.ts';
import { stageNames, stages } from '../stages/index.ts';
import { ProblemError } from './problem.ts';
import { database, defineRoute, type Route } from './route.ts';

// GET /v1/factory: what this factory is and which stages it runs, read from
// FACTORY.json when asked, so a client can show only the stages that are on.
// A ticket already running keeps the settings it started with.

const FactoryStage = z
  .object({
    enabled: z.boolean().meta({
      description: 'Whether new tickets run this stage: always for a required stage.',
    }),
    name: z.enum(stageNames).meta({ description: 'The stage. The stages array gives the order.' }),
    optional: z
      .boolean()
      .meta({ description: 'An optional stage runs only when FACTORY.json turns it on.' }),
    perTask: z.boolean().meta({ description: 'Whether the stage runs once per task.' }),
  })
  .meta({ id: 'FactoryStage' });

const Factory = z
  .object({
    communication: Communication.meta({
      description:
        'How much new tickets write outside, and in whose voice: FACTORY.json `communication`, with defaults. A ticket keeps the settings it started with.',
    }),
    factoryId: z.string(),
    name: z.string().nullable().meta({ description: 'FACTORY.json `name`, when set.' }),
    pullRequestFormat: z
      .object({
        path: z.string().nullable().meta({
          description:
            'The file it comes from, such as `.github/pull_request_template.md`; null for `default`.',
        }),
        source: z.enum(['agents', 'github', 'default']).meta({
          description:
            "`agents`: a pull-request section of the root AGENTS.md or CLAUDE.md. `github`: a pull_request_template.md in .github/, the root, or docs/. `default`: the factory's own body.",
        }),
      })
      .meta({
        description:
          "The format a ticket started now would give its pull request body, read at the remote's default branch as last fetched. Each ticket reads it again at its own base commit.",
      }),
    stages: z.array(FactoryStage).meta({ description: 'Every stage, in flow order.' }),
  })
  .meta({ id: 'Factory' });

const factory = defineRoute({
  handler: ({ context }) => {
    if (context.factoryConfig === null) {
      throw new ProblemError('internal_error', 'The server has no FACTORY.json.');
    }
    const read = context.factoryConfig();
    if (read.kind === 'error') {
      // The message names the server's paths; the server log keeps it.
      throw new Error(`GET /v1/factory: ${read.message}`);
    }
    return {
      body: {
        communication: read.config.communication,
        factoryId: factoryIdentity(database(context)).factoryId,
        name: read.config.name,
        pullRequestFormat: context.pullRequestFormat?.() ?? { path: null, source: 'default' },
        stages: flowOrder.map((stage) => ({
          enabled: stageEnabled(read.config, stage),
          name: stage,
          optional: stages[stage].optional,
          perTask: stages[stage].scope === 'task',
        })),
      },
      status: 200,
    };
  },
  method: 'GET',
  operationId: 'getFactory',
  path: '/v1/factory',
  responses: { 200: { description: 'The factory and its stages.', schema: Factory } },
  scope: 'read',
  summary: 'See which stages this factory runs, in order',
  tags: ['meta'],
});

// PUT /v1/factory/communication: the owner sets how new tickets communicate
// outside. FACTORY.json stays the only source (ADR-004): the route rewrites
// its `communication` block and answers with what the file now says.
const putCommunication = defineRoute({
  handler: ({ body, context }) => {
    if (context.saveCommunication === null) {
      throw new ProblemError('internal_error', 'The server has no FACTORY.json.');
    }
    const saved = context.saveCommunication(body);
    if (saved.kind === 'error') {
      // The rest of FACTORY.json no longer parses; the message names the
      // server's paths, so the server log keeps it and the file is unchanged.
      throw new Error(`PUT /v1/factory/communication: ${saved.message}`);
    }
    return { body: saved.config.communication, status: 200 };
  },
  method: 'PUT',
  operationId: 'putCommunication',
  path: '/v1/factory/communication',
  request: { body: Communication },
  responses: {
    200: {
      description: 'FACTORY.json now has these settings; tickets started from now on use them.',
      schema: Communication,
    },
  },
  scope: 'act',
  summary: 'Set how much new tickets write outside, and in whose voice',
  tags: ['meta'],
});

export const factoryRoutes: Array<Route> = [factory, putCommunication];
