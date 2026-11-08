import { createHash } from 'node:crypto';
import { LinearClient } from '@linear/sdk';
import { LINEAR_STATE_TYPES, type LinearStateType, type LinearTrackerConfig } from '../config.ts';
import { markdownChecklist, tickMarkdown } from './markdown-checklist.ts';
import type { BacklogIssue, IssueLink, Resolved, Tracker, TrackerIssue } from './tracker.ts';

// Linear as a tracker, through the Linear SDK and a personal API key. The
// factory only uses the teams, labels, projects, and workflow states the
// workspace already has; it never creates them.

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

// What a workspace has, for writing the tracker settings and checking them.
export type LinearInventory = {
  // Labels that belong to no team, which every team can use.
  labels: Array<LinearLabel>;
  projects: Array<{ name: string }>;
  teams: Array<{
    key: string;
    labels: Array<LinearLabel>;
    name: string;
    // In workflow order.
    states: Array<{ name: string; type: string }>;
  }>;
};

export type LinearBacklogQuery = {
  labels: Array<string>;
  project: string | null;
  states: Array<LinearStateType>;
  team: string;
};

// The calls the adapter makes. Tests pass a stand-in.
export type LinearApi = {
  // Open issues matching the query, newest first.
  backlog: (query: LinearBacklogQuery) => Promise<Array<LinearBacklogIssue>>;
  // Issues with a `blocks` relation to the issue.
  blockers: (issueId: string) => Promise<Array<LinearRelated>>;
  children: (issueId: string) => Promise<Array<LinearRelated>>;
  // The issue's comment of this id, or null when it has none. A deleted
  // comment counts as none, and Linear takes its id again.
  comment: (issueId: string, commentId: string) => Promise<{ body: string } | null>;
  createComment: (input: { body: string; id: string; issueId: string }) => Promise<void>;
  inventory: () => Promise<LinearInventory>;
  // By UUID or key; rejects when Linear has no such issue.
  issue: (idOrKey: string) => Promise<LinearIssue>;
  setDescription: (issueId: string, description: string) => Promise<void>;
  setState: (issueId: string, stateId: string) => Promise<void>;
  teamStates: (teamId: string) => Promise<Array<LinearState>>;
  updateComment: (commentId: string, body: string) => Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function nodes(value: unknown): Array<Record<string, unknown>> {
  const list = isRecord(value) ? value['nodes'] : null;
  return Array.isArray(list) ? list.filter(isRecord) : [];
}

function stateOf(value: unknown): LinearState | null {
  return isRecord(value) && typeof value['id'] === 'string'
    ? {
        id: value['id'],
        name: text(value['name']),
        position: typeof value['position'] === 'number' ? value['position'] : 0,
        type: text(value['type']),
      }
    : null;
}

const ISSUE_FIELDS = `
  id identifier title description url createdAt updatedAt
  creator { displayName }
  labels(first: 25) { nodes { name } }
  state { id name type position }
  team { id key }
`;

function issueOf(value: unknown): LinearIssue {
  if (!isRecord(value) || typeof value['id'] !== 'string') {
    throw new Error('Linear did not return the issue.');
  }
  const team = isRecord(value['team']) ? value['team'] : {};
  const creator = isRecord(value['creator']) ? value['creator'] : {};
  return {
    createdAt: textOrNull(value['createdAt']),
    creator: textOrNull(creator['displayName']),
    description: text(value['description']),
    id: value['id'],
    identifier: text(value['identifier']),
    labels: nodes(value['labels']).map((label) => text(label['name'])),
    state: stateOf(value['state']),
    team: { id: text(team['id']), key: text(team['key']) },
    title: text(value['title']),
    updatedAt: textOrNull(value['updatedAt']),
    url: text(value['url']),
  };
}

function relatedOf(value: Record<string, unknown>): LinearRelated {
  const state = isRecord(value['state']) ? value['state'] : {};
  return {
    identifier: text(value['identifier']),
    stateType: textOrNull(state['type']),
    title: text(value['title']),
    url: textOrNull(value['url']),
  };
}

const RELATED_FIELDS = 'identifier title url state { type }';
// How many sub-issues or relations the backlog query reads with each issue.
// Linear prices a query by its page sizes multiplied, so these stay small;
// an issue with more gets them read on their own.
const BACKLOG_PAGE = 25;
const LINKS_PAGE = 20;

// The issues with a `blocks` relation in a connection of inverse relations.
function blockersOf(relations: unknown): Array<LinearRelated> {
  return nodes(relations).flatMap((relation) =>
    relation['type'] === 'blocks' && isRecord(relation['issue'])
      ? [relatedOf(relation['issue'])]
      : [],
  );
}

function hasMore(connection: unknown): boolean {
  return (
    isRecord(connection) &&
    isRecord(connection['pageInfo']) &&
    connection['pageInfo']['hasNextPage'] === true
  );
}

function labelOf(value: Record<string, unknown>): LinearLabel {
  const parent = isRecord(value['parent']) ? value['parent'] : {};
  return { group: textOrNull(parent['name']), name: text(value['name']) };
}

function teamOf(item: Record<string, unknown>): string | null {
  return isRecord(item['team']) ? textOrNull(item['team']['key']) : null;
}

// Linear's own message for a failed call, such as "Authentication required,
// not authenticated", without the request and response the SDK appends.
export function linearMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const first = (list: unknown): string | null =>
    Array.isArray(list) && isRecord(list[0]) ? textOrNull(list[0]['message']) : null;
  const response = (error as { response?: unknown }).response;
  return (
    first((error as { errors?: unknown }).errors) ??
    first(isRecord(response) ? response['errors'] : null) ??
    error.message.split(': {')[0] ??
    error.message
  );
}

async function plainly<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error: unknown) {
    throw new Error(linearMessage(error), { cause: error });
  }
}

function succeeded(payload: { success: boolean }, what: string): void {
  if (!payload.success) {
    throw new Error(`Linear did not ${what}.`);
  }
}

function listed(names: Array<string>): string {
  return names.length === 0 ? 'none' : names.map((name) => `"${name}"`).join(', ');
}

function labelName(item: LinearLabel): string {
  return item.group === null ? item.name : `${item.name} (in ${item.group})`;
}

// How many backlog issues one read returns at most, as on GitHub.
const BACKLOG_LIMIT = 100;
// How many labels or projects an inventory reads at most.
const INVENTORY_LIMIT = 1000;

export function linearSdkApi(apiKey: string): LinearApi {
  // Made on the first call: the SDK throws on an empty key, and the server
  // builds a tracker to read its capabilities before it checks for one.
  let client: LinearClient | null = null;
  const sdk = (): LinearClient => (client ??= new LinearClient({ apiKey }));
  const request = async (query: string, variables: Record<string, unknown> = {}) => {
    const data: unknown = await plainly(() => sdk().client.request(query, variables));
    if (!isRecord(data)) {
      throw new Error('Linear returned no data.');
    }
    return data;
  };
  // Every page of a connection at `field` of the query's root, up to `limit`.
  const pages = async (
    query: string,
    field: string,
    variables: Record<string, unknown>,
    limit: number,
  ): Promise<Array<Record<string, unknown>>> => {
    const all: Array<Record<string, unknown>> = [];
    let after: string | null = null;
    while (all.length < limit) {
      const data = await request(query, { ...variables, after });
      const connection = isRecord(data[field]) ? data[field] : {};
      all.push(...nodes(connection));
      const pageInfo = isRecord(connection['pageInfo']) ? connection['pageInfo'] : {};
      after = textOrNull(pageInfo['endCursor']);
      if (pageInfo['hasNextPage'] !== true || after === null) {
        break;
      }
    }
    return all.slice(0, limit);
  };
  // One selection of an issue; `$id` is the issue, `$other` an optional id.
  const issueField = async (issueId: string, selection: string, other?: string) => {
    const data = await request(
      `query FactoryIssueField($id: String!${other === undefined ? '' : ', $other: ID'}) {
        issue(id: $id) { ${selection} }
      }`,
      { id: issueId, ...(other === undefined ? {} : { other }) },
    );
    return isRecord(data['issue']) ? data['issue'] : {};
  };
  const blockers = async (issueId: string) =>
    blockersOf(
      (
        await issueField(
          issueId,
          `inverseRelations(first: 100) { nodes { type issue { ${RELATED_FIELDS} } } }`,
        )
      )['inverseRelations'],
    );
  const children = async (issueId: string) =>
    nodes(
      (await issueField(issueId, `children(first: 100) { nodes { ${RELATED_FIELDS} } }`))[
        'children'
      ],
    ).map(relatedOf);
  return {
    backlog: async (query) => {
      const filter: Record<string, unknown> = {
        state: { type: { in: query.states } },
        team: { key: { eq: query.team } },
        ...(query.project === null ? {} : { project: { name: { eq: query.project } } }),
        ...(query.labels.length === 0
          ? {}
          : { and: query.labels.map((name) => ({ labels: { some: { name: { eq: name } } } })) }),
      };
      // Blockers and sub-issues come in the same query, so the backlog makes
      // no call per issue unless one has more than a page of them.
      const found = await pages(
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
        'issues',
        { filter },
        BACKLOG_LIMIT,
      );
      const issues: Array<LinearBacklogIssue> = [];
      for (const node of found) {
        const issue = issueOf(node);
        issues.push({
          ...issue,
          blockers: hasMore(node['inverseRelations'])
            ? await blockers(issue.id)
            : blockersOf(node['inverseRelations']),
          children: hasMore(node['children'])
            ? await children(issue.id)
            : nodes(node['children']).map(relatedOf),
        });
      }
      return issues.toSorted((left, right) =>
        (right.createdAt ?? '').localeCompare(left.createdAt ?? ''),
      );
    },
    blockers,
    children,
    comment: async (issueId, commentId) => {
      const issue = await issueField(
        issueId,
        'comments(first: 1, filter: { id: { eq: $other } }) { nodes { id body } }',
        commentId,
      );
      const found = nodes(issue['comments'])[0];
      return found === undefined ? null : { body: text(found['body']) };
    },
    createComment: async (input) => {
      succeeded(await plainly(() => sdk().createComment(input)), 'create the comment');
    },
    inventory: async () => {
      // Flat lists, never one inside another: Linear prices a query by its
      // page sizes multiplied, and teams × states went past its limit. They
      // do not depend on each other, so they are read at once.
      const [teams, states, labels, projects] = await Promise.all([
        pages(
          `query FactoryTeams($after: String) {
          teams(first: 100, after: $after) { nodes { key name } pageInfo { hasNextPage endCursor } }
        }`,
          'teams',
          {},
          INVENTORY_LIMIT,
        ),
        pages(
          `query FactoryStates($after: String) {
          workflowStates(first: 250, after: $after) {
            nodes { name type position team { key } }
            pageInfo { hasNextPage endCursor }
          }
        }`,
          'workflowStates',
          {},
          INVENTORY_LIMIT,
        ),
        pages(
          `query FactoryLabels($after: String) {
          issueLabels(first: 250, after: $after) {
            nodes { name isGroup parent { name } team { key } }
            pageInfo { hasNextPage endCursor }
          }
        }`,
          'issueLabels',
          {},
          INVENTORY_LIMIT,
        ),
        pages(
          `query FactoryProjects($after: String) {
          projects(first: 250, after: $after) { nodes { name } pageInfo { hasNextPage endCursor } }
        }`,
          'projects',
          {},
          INVENTORY_LIMIT,
        ),
      ]);
      // A label group only gathers labels; issues carry the labels inside it.
      const usable = labels.filter((label) => label['isGroup'] !== true);
      return {
        labels: usable.filter((label) => teamOf(label) === null).map(labelOf),
        projects: projects.map((project) => ({ name: text(project['name']) })),
        teams: teams.map((team) => {
          const key = text(team['key']);
          return {
            key,
            labels: usable.filter((label) => teamOf(label) === key).map(labelOf),
            name: text(team['name']),
            states: inWorkflowOrder(
              states
                .filter((state) => teamOf(state) === key)
                .flatMap((state) => {
                  const found = stateOf({ ...state, id: '' });
                  return found === null ? [] : [found];
                }),
            ).map((state) => ({ name: state.name, type: state.type })),
          };
        }),
      };
    },
    issue: async (idOrKey) => {
      const data = await request(
        `query FactoryIssue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
        { id: idOrKey },
      );
      return issueOf(data['issue']);
    },
    setDescription: async (issueId, description) => {
      succeeded(
        await plainly(() => sdk().updateIssue(issueId, { description })),
        'update the description',
      );
    },
    setState: async (issueId, stateId) => {
      succeeded(
        await plainly(() => sdk().updateIssue(issueId, { stateId })),
        'change the workflow state',
      );
    },
    teamStates: async (teamId) => {
      const data = await request(
        `query FactoryTeamStates($id: String!) {
          team(id: $id) { states(first: 100) { nodes { id name type position } } }
        }`,
        { id: teamId },
      );
      return nodes(isRecord(data['team']) ? data['team']['states'] : null).flatMap((state) => {
        const found = stateOf(state);
        return found === null ? [] : [found];
      });
    },
    updateComment: async (commentId, body) => {
      succeeded(
        await plainly(() => sdk().updateComment(commentId, { body })),
        'update the comment',
      );
    },
  };
}

// Where a state stands in its team's workflow: by type, then by position.
function workflowRank(state: { position: number; type: string }): [number, number] {
  const type = LINEAR_STATE_TYPES.indexOf(state.type as LinearStateType);
  return [type === -1 ? LINEAR_STATE_TYPES.length : type, state.position];
}

function inWorkflowOrder<S extends { position: number; type: string }>(states: Array<S>): Array<S> {
  return states.toSorted((left, right) => {
    const [leftType, leftPosition] = workflowRank(left);
    const [rightType, rightPosition] = workflowRank(right);
    return leftType - rightType || leftPosition - rightPosition;
  });
}

function comesAfter(
  target: { position: number; type: string },
  current: { position: number; type: string },
): boolean {
  const [targetType, targetPosition] = workflowRank(target);
  const [currentType, currentPosition] = workflowRank(current);
  return (
    targetType > currentType || (targetType === currentType && targetPosition > currentPosition)
  );
}

// A finished issue's state is never changed.
const FINISHED = new Set(['canceled', 'completed', 'duplicate']);

// The Linear refs a factory accepts: an issue key, such as ENG-42, and the
// issue's URL. A bare number is refused, since GitHub uses those.
export function linearTarget(
  ref: string,
  config: LinearTrackerConfig,
): { key: string } | { kind: 'error'; message: string } | null {
  const url =
    /^https?:\/\/linear\.app\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9_]*-\d+)(?:\/[^?#]*)?(?:[?#].*)?$/.exec(
      ref,
    );
  if (url?.[1]) {
    return { key: url[1].toUpperCase() };
  }
  if (/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(ref)) {
    return { key: ref.toUpperCase() };
  }
  const bare = /^#?(\d+)$/.exec(ref);
  if (bare?.[1]) {
    return {
      kind: 'error',
      message: `Bare issue ${ref} is not a Linear ref; use its key, such as ${config.team}-${bare[1]}.`,
    };
  }
  return null;
}

// The id of the factory's comment of `key` on an issue: a UUID v4 in shape,
// derived from both, so a retried post finds the comment it may already have
// made instead of posting twice.
export function commentIdFor(issueId: string, key: string): string {
  const bytes = createHash('sha256').update(`factory:${issueId}:${key}`).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function trackerIssue(issue: LinearIssue, ref: string): TrackerIssue {
  return {
    author: issue.creator,
    body: issue.description,
    createdAt: issue.createdAt,
    displayRef: issue.identifier,
    id: `linear:${issue.id}`,
    labels: issue.labels,
    ref,
    title: issue.title,
    updatedAt: issue.updatedAt,
    url: issue.url,
  };
}

function uuidOf(issue: TrackerIssue): string {
  if (!issue.id.startsWith('linear:')) {
    throw new Error(`${issue.displayRef} is not a Linear issue.`);
  }
  return issue.id.slice('linear:'.length);
}

function linkOf(related: LinearRelated): IssueLink {
  return { displayRef: related.identifier, title: related.title, url: related.url };
}

function openBlockers(related: Array<LinearRelated>): Array<IssueLink> {
  return related
    .filter((item) => item.stateType === null || !FINISHED.has(item.stateType))
    .map(linkOf);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Linear request failed';
}

export function createLinearTracker(config: LinearTrackerConfig, api: LinearApi): Tracker {
  return {
    blockedBy: async (issue) => openBlockers(await api.blockers(uuidOf(issue))),
    capabilities: new Set(['backlog', 'blockedBy', 'checklist', 'children', 'comment', 'status']),
    // Linear keeps an issue's checklist as Markdown boxes in its description.
    checklistItems: async (issue) =>
      markdownChecklist((await api.issue(uuidOf(issue))).description),
    children: async (issue) => (await api.children(uuidOf(issue))).map(linkOf),
    comment: async (issue, markdown, key, mode) => {
      const issueId = uuidOf(issue);
      const id = commentIdFor(issueId, key);
      const keep = async (posted: { body: string }) => {
        if (mode === 'replace' && posted.body !== markdown) {
          await api.updateComment(id, markdown);
        }
      };
      const posted = await api.comment(issueId, id);
      if (posted !== null) {
        return keep(posted);
      }
      try {
        await api.createComment({ body: markdown, id, issueId });
      } catch (error: unknown) {
        // The create may have gone through before the error, as after a
        // timeout: then the comment is there and is kept, not posted again.
        const made = await api.comment(issueId, id);
        if (made === null) {
          throw error;
        }
        await keep(made);
      }
    },
    kind: 'linear',
    listBacklog: async () =>
      (await api.backlog({ ...config.backlog, team: config.team })).map((issue): BacklogIssue => ({
        ...trackerIssue(issue, issue.identifier),
        links: { blockedBy: openBlockers(issue.blockers), children: issue.children.map(linkOf) },
      })),
    refHint: 'a Linear issue key such as ENG-42, or its URL',
    resolve: async (ref): Promise<Resolved | null> => {
      const target = linearTarget(ref, config);
      if (target === null) {
        return null;
      }
      if ('kind' in target) {
        return target;
      }
      try {
        return { issue: trackerIssue(await api.issue(target.key), ref), kind: 'issue' };
      } catch (error: unknown) {
        return { kind: 'error', message: messageOf(error), reason: 'tracker_unavailable' };
      }
    },
    // Moves the issue forward to the mapped workflow state of its own team,
    // never back, and never once it is finished: people and Linear's own
    // automation move issues too. Clearing a status leaves the state alone.
    setStatus: async (issue, status) => {
      const mapped = status === 'clear' ? undefined : config.status[status];
      if (mapped === undefined) {
        return null;
      }
      const current = await api.issue(uuidOf(issue));
      const target = (await api.teamStates(current.team.id)).find(
        (state) => state.name === mapped.state,
      );
      if (target === undefined) {
        return `The ${current.team.key} team has no workflow state "${mapped.state}", so ${current.identifier} stays where it is.`;
      }
      if (
        current.state !== null &&
        (FINISHED.has(current.state.type) || !comesAfter(target, current.state))
      ) {
        return null;
      }
      await api.setState(current.id, target.id);
      return null;
    },
    tickBoxes: async (issue, keys) => {
      const issueId = uuidOf(issue);
      // The description as it is now: people may have edited it since it was read.
      const current = (await api.issue(issueId)).description;
      const ticked = tickMarkdown(current, keys);
      if (ticked.body !== current) {
        await api.setDescription(issueId, ticked.body);
      }
      return { conflicts: ticked.conflicts };
    },
  };
}

// What FACTORY.json's Linear tracker names that the workspace does not have,
// each with the names it does have; empty when everything is there.
export function checkLinearSettings(
  config: LinearTrackerConfig,
  inventory: LinearInventory,
): Array<string> {
  const team = inventory.teams.find((item) => item.key === config.team);
  if (team === undefined) {
    return [
      `Linear has no team with key "${config.team}" that the API key can see. Teams: ${listed(inventory.teams.map((item) => `${item.key} (${item.name})`))}.`,
    ];
  }
  const problems: Array<string> = [];
  const labels = [...inventory.labels, ...team.labels].map((label) => label.name);
  for (const label of config.backlog.labels) {
    if (!labels.includes(label)) {
      problems.push(
        `The ${team.key} team has no label "${label}". Labels: ${listed([...new Set(labels)])}.`,
      );
    }
  }
  const project = config.backlog.project;
  if (project !== null && !inventory.projects.some((item) => item.name === project)) {
    problems.push(
      `Linear has no project "${project}". Projects: ${listed(inventory.projects.map((item) => item.name))}.`,
    );
  }
  const states = team.states.map((state) => state.name);
  for (const [status, mapping] of Object.entries(config.status)) {
    if (!states.includes(mapping.state)) {
      problems.push(
        `tracker.status.${status}: the ${team.key} team has no workflow state "${mapping.state}". States: ${listed(states)}.`,
      );
    }
  }
  return problems;
}

// The inventory as lines a person reads to write the tracker settings.
export function formatLinearInventory(inventory: LinearInventory): Array<string> {
  return [
    'Teams (tracker.team is the key):',
    ...inventory.teams.flatMap((team) => [
      `  ${team.key}  ${team.name}`,
      `    states (tracker.status maps names; tracker.backlog.states takes types):`,
      ...team.states.map((state) => `      ${state.name}  [${state.type}]`),
      ...(team.labels.length === 0
        ? []
        : [`    team labels: ${team.labels.map(labelName).join(', ')}`]),
    ]),
    `Workspace labels (tracker.backlog.labels): ${inventory.labels.length === 0 ? 'none' : inventory.labels.map(labelName).join(', ')}`,
    `Projects (tracker.backlog.project): ${inventory.projects.length === 0 ? 'none' : inventory.projects.map((project) => project.name).join(', ')}`,
  ];
}
