import { z } from 'zod';

// The GraphQL queries the Linear adapter sends, each with the schema of the
// response it expects. A response is parsed once, here, as it arrives, into
// the adapter's own types: one that does not match fails with the query and
// the field path instead of passing empty values on. Fields are nullable only
// where Linear's schema makes them so; open sets, such as a workflow state's
// type, stay strings so a value Linear adds still parses.

export type LinearState = { id: string; name: string; position: number; type: string };

export type LinearIssue = {
  createdAt: string | null;
  // The display name of whoever opened it.
  creator: string | null;
  description: string;
  // Linear's UUID for the issue.
  id: string;
  // How people name it, such as `ENG-42`.
  identifier: string;
  labels: Array<string>;
  state: LinearState | null;
  team: { id: string; key: string };
  title: string;
  updatedAt: string | null;
  url: string;
};

// A sub-issue or a blocker, with the type of its workflow state.
export type LinearRelated = {
  identifier: string;
  stateType: string | null;
  title: string;
  url: string | null;
};

// A backlog issue with its blockers and sub-issues, read in the same query.
export type LinearBacklogIssue = LinearIssue & {
  blockers: Array<LinearRelated>;
  children: Array<LinearRelated>;
};

export type LinearLabel = { group: string | null; name: string };

// A query, its text, and the schema of its response's `data`.
export type LinearQuery<T> = { name: string; schema: z.ZodType<T>; text: string };

// One page of a connection.
export type Page<T> = { endCursor: string | null; hasMore: boolean; nodes: Array<T> };

function linearQuery<T>(text: string, schema: z.ZodType<T>): LinearQuery<T> {
  const name = /query (\w+)/.exec(text)?.[1];
  if (name === undefined) {
    throw new Error('A Linear query needs a name.');
  }
  return { name, schema, text };
}

// Where in a response a problem is, such as `issues.nodes[3].identifier`.
function pathOf(path: ReadonlyArray<PropertyKey>): string {
  const text = path
    .map((part) => (typeof part === 'number' ? `[${part}]` : `.${String(part)}`))
    .join('')
    .replace(/^\./, '');
  return text.length === 0 ? 'the response' : text;
}

// The response's `data` as `query` expects it, or an error that names the
// query and the first field that does not match.
export function parseResponse<T>(query: LinearQuery<T>, data: unknown): T {
  const result = query.schema.safeParse(data);
  if (result.success) {
    return result.data;
  }
  const [first, ...rest] = result.error.issues;
  const where = first === undefined ? '' : `: ${pathOf(first.path)}: ${first.message}`;
  const more = rest.length === 0 ? '' : ` (and ${rest.length} more)`;
  throw new Error(`Linear returned an unexpected ${query.name} response${where}${more}`);
}

const nodesOf = <T extends z.ZodType>(node: T) => z.object({ nodes: z.array(node) });

function connection<T>(node: z.ZodType<T>): z.ZodType<Page<T>> {
  return z
    .object({
      nodes: z.array(node),
      pageInfo: z.object({ endCursor: z.string().nullable(), hasNextPage: z.boolean() }),
    })
    .transform((value) => ({
      endCursor: value.pageInfo.endCursor,
      hasMore: value.pageInfo.hasNextPage,
      nodes: value.nodes,
    }));
}

const State = z.object({
  id: z.string(),
  name: z.string(),
  position: z.number(),
  type: z.string(),
}) satisfies z.ZodType<LinearState>;

const ISSUE_FIELDS = `
  id identifier title description url createdAt updatedAt
  creator { displayName }
  labels(first: 25) { nodes { name } }
  state { id name type position }
  team { id key }
`;

const IssueFields = z.object({
  createdAt: z.string(),
  creator: z.object({ displayName: z.string() }).nullable(),
  description: z.string().nullable(),
  id: z.string(),
  identifier: z.string(),
  labels: nodesOf(z.object({ name: z.string() })),
  state: State,
  team: z.object({ id: z.string(), key: z.string() }),
  title: z.string(),
  updatedAt: z.string(),
  url: z.string(),
});

function issueOf(value: z.output<typeof IssueFields>): LinearIssue {
  return {
    createdAt: value.createdAt,
    creator: value.creator?.displayName ?? null,
    description: value.description ?? '',
    id: value.id,
    identifier: value.identifier,
    labels: value.labels.nodes.map((label) => label.name),
    state: value.state,
    team: value.team,
    title: value.title,
    updatedAt: value.updatedAt,
    url: value.url,
  };
}

const RELATED_FIELDS = 'identifier title url state { type }';

const Related = z
  .object({
    identifier: z.string(),
    state: z.object({ type: z.string() }),
    title: z.string(),
    url: z.string(),
  })
  .transform((value): LinearRelated => ({
    identifier: value.identifier,
    stateType: value.state.type,
    title: value.title,
    url: value.url,
  }));

// Inverse relations of every type; the issues of `blocks` ones block it.
const InverseRelation = z.object({ issue: Related, type: z.string() });

function blockersOf(relations: Array<z.output<typeof InverseRelation>>): Array<LinearRelated> {
  return relations.flatMap((relation) => (relation.type === 'blocks' ? [relation.issue] : []));
}

// How many issues a backlog page holds, and how many sub-issues or relations
// it reads with each. Linear prices a query by its page sizes multiplied, so
// these stay small; an issue with more gets them read on their own.
export const BACKLOG_PAGE = 25;
export const LINKS_PAGE = 20;

// A list read with a backlog issue: null when it has more than a page, so it
// is read on its own.
function firstPage<T>(node: z.ZodType<T>) {
  return z
    .object({ nodes: z.array(node), pageInfo: z.object({ hasNextPage: z.boolean() }) })
    .transform((value) => (value.pageInfo.hasNextPage ? null : value.nodes));
}

const BacklogIssue = IssueFields.extend({
  children: firstPage(Related),
  inverseRelations: firstPage(InverseRelation),
}).transform((value) => ({
  blockers: value.inverseRelations === null ? null : blockersOf(value.inverseRelations),
  children: value.children,
  issue: issueOf(value),
}));

export const backlogQuery = linearQuery(
  `query FactoryBacklog($filter: IssueFilter, $after: String) {
    issues(filter: $filter, first: ${BACKLOG_PAGE}, after: $after, orderBy: createdAt) {
      nodes {
        ${ISSUE_FIELDS}
        children(first: ${LINKS_PAGE}) { nodes { ${RELATED_FIELDS} } pageInfo { hasNextPage } }
        inverseRelations(first: ${LINKS_PAGE}) {
          nodes { type issue { ${RELATED_FIELDS} } }
          pageInfo { hasNextPage }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`,
  z.object({ issues: connection(BacklogIssue) }).transform((data) => data.issues),
);

export const issueQuery = linearQuery(
  `query FactoryIssue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
  z.object({ issue: IssueFields.transform(issueOf) }).transform((data) => data.issue),
);

export const blockersQuery = linearQuery(
  `query FactoryBlockers($id: String!) {
    issue(id: $id) { inverseRelations(first: 100) { nodes { type issue { ${RELATED_FIELDS} } } } }
  }`,
  z
    .object({ issue: z.object({ inverseRelations: nodesOf(InverseRelation) }) })
    .transform((data) => blockersOf(data.issue.inverseRelations.nodes)),
);

export const childrenQuery = linearQuery(
  `query FactoryChildren($id: String!) {
    issue(id: $id) { children(first: 100) { nodes { ${RELATED_FIELDS} } } }
  }`,
  z
    .object({ issue: z.object({ children: nodesOf(Related) }) })
    .transform((data) => data.issue.children.nodes),
);

// A deleted comment is left out, as if it never was.
export const commentQuery = linearQuery(
  `query FactoryComment($id: String!, $commentId: ID) {
    issue(id: $id) { comments(first: 1, filter: { id: { eq: $commentId } }) { nodes { body } } }
  }`,
  z
    .object({ issue: z.object({ comments: nodesOf(z.object({ body: z.string() })) }) })
    .transform((data) => data.issue.comments.nodes[0] ?? null),
);

export const teamStatesQuery = linearQuery(
  `query FactoryTeamStates($id: String!) {
    team(id: $id) { states(first: 100) { nodes { id name type position } } }
  }`,
  z
    .object({ team: z.object({ states: nodesOf(State) }) })
    .transform((data) => data.team.states.nodes),
);

// The inventory reads flat lists, never one inside another: teams × states
// went past Linear's complexity limit.

export const teamsQuery = linearQuery(
  `query FactoryTeams($after: String) {
    teams(first: 100, after: $after) { nodes { key name } pageInfo { hasNextPage endCursor } }
  }`,
  z
    .object({ teams: connection(z.object({ key: z.string(), name: z.string() })) })
    .transform((data) => data.teams),
);

export const statesQuery = linearQuery(
  `query FactoryStates($after: String) {
    workflowStates(first: 250, after: $after) {
      nodes { name type position team { key } }
      pageInfo { hasNextPage endCursor }
    }
  }`,
  z
    .object({
      workflowStates: connection(
        z.object({
          name: z.string(),
          position: z.number(),
          team: z.object({ key: z.string() }),
          type: z.string(),
        }),
      ),
    })
    .transform((data) => data.workflowStates),
);

// A label group only gathers labels; issues carry the labels inside it.
// `team` is null for a workspace label, which every team can use.
export const labelsQuery = linearQuery(
  `query FactoryLabels($after: String) {
    issueLabels(first: 250, after: $after) {
      nodes { name isGroup parent { name } team { key } }
      pageInfo { hasNextPage endCursor }
    }
  }`,
  z
    .object({
      issueLabels: connection(
        z
          .object({
            isGroup: z.boolean(),
            name: z.string(),
            parent: z.object({ name: z.string() }).nullable(),
            team: z.object({ key: z.string() }).nullable(),
          })
          .transform((value) => ({
            isGroup: value.isGroup,
            label: { group: value.parent?.name ?? null, name: value.name } satisfies LinearLabel,
            team: value.team?.key ?? null,
          })),
      ),
    })
    .transform((data) => data.issueLabels),
);

export const projectsQuery = linearQuery(
  `query FactoryProjects($after: String) {
    projects(first: 250, after: $after) { nodes { name } pageInfo { hasNextPage endCursor } }
  }`,
  z
    .object({ projects: connection(z.object({ name: z.string() })) })
    .transform((data) => data.projects),
);

// A failed call's errors, as GraphQL reports them.
const GraphqlErrors = z.object({
  errors: z.array(z.object({ message: z.string().min(1) })).min(1),
});

const FailedResponse = z.object({ response: GraphqlErrors });

// Linear's own message for a failed call, such as "Authentication required,
// not authenticated", without the request and response the SDK appends.
export function linearMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const typed = GraphqlErrors.safeParse(error);
  if (typed.success) {
    return typed.data.errors[0]?.message ?? error.message;
  }
  const raw = FailedResponse.safeParse(error);
  if (raw.success) {
    return raw.data.response.errors[0]?.message ?? error.message;
  }
  return error.message.split(': {')[0] ?? error.message;
}
