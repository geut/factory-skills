import { z } from 'zod';
import { ProblemError } from './problem.ts';
import { defineRoute } from './route.ts';

// GET /v1/tracker/inventory: what the Linear workspace has, so the tracker
// settings can name its teams, labels, projects, and workflow states. The
// factory never creates them.

const Label = z
  .object({
    group: z.string().nullable().meta({ description: 'The label group it sits in, if any.' }),
    name: z.string().meta({ description: 'The name tracker.backlog.labels takes.' }),
  })
  .meta({ id: 'TrackerLabel' });

const TrackerInventory = z
  .object({
    kind: z.literal('linear'),
    labels: z.array(Label).meta({ description: 'Workspace labels, which every team can use.' }),
    projects: z.array(z.object({ name: z.string() })),
    teams: z.array(
      z.object({
        key: z.string().meta({ description: 'The key tracker.team takes, such as ENG.' }),
        labels: z.array(Label).meta({ description: "The team's own labels." }),
        name: z.string(),
        states: z.array(z.object({ name: z.string(), type: z.string() })).meta({
          description:
            'Workflow states in workflow order: tracker.status maps names, tracker.backlog.states takes types.',
        }),
      }),
    ),
  })
  .meta({ id: 'TrackerInventory' });

const inventory = defineRoute({
  handler: async ({ context }) => {
    const result = context.trackerInventory === null ? null : await context.trackerInventory();
    if (result === null) {
      throw new ProblemError('not_found', 'Only a Linear tracker has an inventory.');
    }
    if (result.kind === 'error') {
      throw new ProblemError('tracker_unavailable', result.message);
    }
    return { body: { kind: 'linear', ...result.inventory }, status: 200 };
  },
  method: 'GET',
  operationId: 'trackerInventory',
  path: '/v1/tracker/inventory',
  responses: {
    200: { description: 'What the Linear workspace has.', schema: TrackerInventory },
  },
  scope: 'read',
  summary: "List the Linear workspace's teams, workflow states, labels, and projects",
  tags: ['backlog'],
});

export const trackerRoutes = [inventory];
