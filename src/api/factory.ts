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

const Update = z
  .object({
    current: z.string().meta({ description: 'The version this factory runs.' }),
    later: z.boolean().meta({ description: 'Whether the owner said later to it.' }),
    latest: z.string().meta({ description: 'The newest stable release.' }),
    name: z.string().meta({ description: 'The release’s name.' }),
    notesUrl: z.string().meta({
      description:
        'What changed: the release notes, or the compare page from the running version when releases were skipped.',
    }),
  })
  .meta({ id: 'FactoryUpdate' });

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
    update: Update.nullable().meta({
      description:
        'A newer stable release than the one this factory runs, as the last check found it; null when there is none or checks are off.',
    }),
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
        update: read.config.updates.check ? (context.updates?.view() ?? null) : null,
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

const UpdateCheck = z
  .object({
    message: z.string().meta({ description: 'For a person: what the check found.' }),
    update: Update.nullable(),
  })
  .meta({ id: 'FactoryUpdateCheck' });

// POST /v1/factory/update-check: check GitHub now instead of waiting for the
// daily check.
const checkUpdate = defineRoute({
  handler: async ({ context }) => {
    if (context.updates === null) {
      throw new ProblemError('internal_error', 'The server has no update checker.');
    }
    const outcome = await context.updates.check();
    switch (outcome.kind) {
      case 'off':
        return {
          body: { message: 'Update checks are off (FACTORY.json updates.check).', update: null },
          status: 200,
        };
      case 'failed':
        throw new ProblemError(
          'code_host_unavailable',
          `Cannot check for updates: ${outcome.message}`,
        );
      case 'checked':
        return {
          body: {
            message:
              outcome.update === null
                ? 'This factory runs the newest release.'
                : `factory ${outcome.update.latest} is available (you run ${outcome.update.current}).`,
            update: outcome.update,
          },
          status: 200,
        };
      default: {
        const _exhaustive: never = outcome;
        return _exhaustive;
      }
    }
  },
  method: 'POST',
  operationId: 'checkFactoryUpdate',
  path: '/v1/factory/update-check',
  responses: { 200: { description: 'What the check found.', schema: UpdateCheck } },
  scope: 'act',
  summary: 'Check for a factory update now',
  tags: ['meta'],
});

// POST /v1/factory/update-later: no more notices for the release on offer.
const updateLater = defineRoute({
  handler: ({ context }) => {
    const update = context.updates?.later() ?? null;
    if (update === null) {
      throw new ProblemError('invalid_state', 'There is no update to put off.');
    }
    return { body: update, status: 200 };
  },
  method: 'POST',
  operationId: 'putOffFactoryUpdate',
  path: '/v1/factory/update-later',
  responses: { 200: { description: 'The update, now put off.', schema: Update } },
  scope: 'act',
  summary: 'Put off the factory update on offer until a newer release',
  tags: ['meta'],
});

export const factoryRoutes: Array<Route> = [factory, putCommunication, checkUpdate, updateLater];
