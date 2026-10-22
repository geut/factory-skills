import { z } from 'zod';
import { ProblemError } from './problem.ts';
import { defineRoute } from './route.ts';

// GET /v1/backlog: open tracker issues that match the backlog query and are
// not tickets yet, flagged when another issue blocks them or when they are
// umbrellas with sub-issues. Served from a short cache; refresh=true asks the
// tracker again.

const IssueLink = z
  .object({ displayRef: z.string(), title: z.string(), url: z.string().nullable() })
  .meta({ id: 'IssueLink' });

const BacklogIssue = z
  .object({
    author: z.string().nullable().meta({ description: 'The tracker login of whoever opened it.' }),
    blocked: z.boolean().meta({ description: 'Another issue blocks it.' }),
    blockedBy: z.array(IssueLink),
    body: z.string().meta({ description: 'Its description, as markdown the tracker holds.' }),
    children: z.array(IssueLink).meta({ description: 'Its sub-issues; start those instead.' }),
    createdAt: z.string().nullable(),
    displayRef: z
      .string()
      .meta({ description: 'The ref to start it with, such as owner/repo#42.' }),
    id: z.string(),
    labels: z.array(z.string()),
    title: z.string(),
    umbrella: z.boolean().meta({ description: 'It has sub-issues, so it cannot be started.' }),
    updatedAt: z.string().nullable(),
    url: z.string(),
  })
  .meta({ id: 'BacklogIssue' });

const BacklogPage = z
  .object({
    fetchedAt: z.string().meta({ description: 'When the tracker was last asked.' }),
    items: z.array(BacklogIssue),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: 'BacklogPage' });

const listBacklog = defineRoute({
  handler: ({ context, query }) => {
    if (context.backlog === null) {
      throw new ProblemError('internal_error', 'The server has no backlog.');
    }
    const result = context.backlog(query.refresh);
    if (result.kind === 'error') {
      throw new ProblemError('tracker_unavailable', result.message);
    }
    const offset =
      query.cursor === undefined
        ? 0
        : Number(Buffer.from(query.cursor, 'base64url').toString('utf8'));
    if (!Number.isInteger(offset) || offset < 0) {
      throw new ProblemError('validation_error', 'The cursor is not valid.', [
        { message: 'Use the nextCursor of the previous page.', path: 'query.cursor' },
      ]);
    }
    const items = result.items.slice(offset, offset + query.limit).map((item) => ({
      ...item,
      blocked: item.blockedBy.length > 0,
      umbrella: item.children.length > 0,
    }));
    const next =
      offset + query.limit < result.items.length
        ? Buffer.from(String(offset + query.limit)).toString('base64url')
        : null;
    return { body: { fetchedAt: result.fetchedAt, items, nextCursor: next }, status: 200 };
  },
  method: 'GET',
  operationId: 'listBacklog',
  path: '/v1/backlog',
  request: {
    query: z.object({
      cursor: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      refresh: z
        .enum(['true', 'false'])
        .default('false')
        .transform((value) => value === 'true')
        .meta({ description: 'Ask the tracker now instead of using the cached backlog.' }),
    }),
  },
  responses: {
    200: { description: 'Backlog issues, as the tracker lists them.', schema: BacklogPage },
  },
  scope: 'read',
  summary: 'List the backlog: open tracker issues that are not tickets yet',
  tags: ['backlog'],
});

export const backlogRoutes = [listBacklog];
