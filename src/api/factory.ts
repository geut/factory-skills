import { z } from 'zod';
import { factoryIdentity } from '../controller/facts.ts';
import { pipeline, stageEnabled } from '../stages/flow.ts';
import { stageNames, stages } from '../stages/index.ts';
import { ProblemError } from './problem.ts';
import { defineRoute, type Route } from './route.ts';

// GET /v1/factory: what this factory is and which stages it runs, read from
// FACTORY.json when asked, so a client can show only the stages that are on.
// A ticket already running keeps the settings it started with.

const FactoryStage = z
  .object({
    enabled: z.boolean().meta({
      description: 'Whether new tickets run this stage: always for a required stage.',
    }),
    name: z.enum(stageNames),
    optional: z
      .boolean()
      .meta({ description: 'An optional stage runs only when FACTORY.json turns it on.' }),
    perTask: z.boolean().meta({ description: 'Whether the stage runs once per task.' }),
  })
  .meta({ id: 'FactoryStage' });

const Factory = z
  .object({
    factoryId: z.string(),
    name: z.string().nullable().meta({ description: 'FACTORY.json `name`, when set.' }),
    stages: z.array(FactoryStage).meta({ description: 'Every stage, in pipeline order.' }),
  })
  .meta({ id: 'Factory' });

const factory = defineRoute({
  handler: ({ context }) => {
    const read = context.factoryConfig?.() ?? null;
    if (read === null || context.db === null) {
      throw new ProblemError('internal_error', 'The server has no factory.');
    }
    if (read.kind === 'error') {
      throw new ProblemError('internal_error', read.message);
    }
    return {
      body: {
        factoryId: factoryIdentity(context.db).factoryId,
        name: read.config.name,
        stages: pipeline.map(({ perTask, stage }) => ({
          enabled: stageEnabled(read.config, stage),
          name: stage,
          optional: stages[stage].optional,
          perTask,
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

export const factoryRoutes: Array<Route> = [factory];
