import { createHash } from 'node:crypto';
import { LinearClient } from '@linear/sdk';
import { LINEAR_STATE_TYPES, type LinearStateType, type LinearTrackerConfig } from '../config.ts';
import {
  backlogQuery,
  blockersQuery,
  childrenQuery,
  commentQuery,
  issueQuery,
  type LinearBacklogIssue,
  type LinearIssue,
  type LinearLabel,
  type LinearQuery,
  type LinearRelated,
  type LinearState,
  labelsQuery,
  linearMessage,
  type Page,
  parseResponse,
  projectsQuery,
  statesQuery,
  teamStatesQuery,
  teamsQuery,
} from './linear-graphql.ts';
import { markdownChecklist, tickMarkdown } from './markdown-checklist.ts';
import type { BacklogIssue, IssueLink, Resolved, Tracker, TrackerIssue } from './tracker.ts';

// Linear as a tracker, through the Linear SDK and a personal API key. The
// factory only uses the teams, labels, projects, and workflow states the
// workspace already has; it never creates them.

export type {
  LinearBacklogIssue,
  LinearIssue,
  LinearLabel,
  LinearRelated,
  LinearState,
} from './linear-graphql.ts';
export { linearMessage } from './linear-graphql.ts';

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
  // The response of `query`, parsed as it arrives.
  const request = async <T>(query: LinearQuery<T>, variables: Record<string, unknown> = {}) =>
    parseResponse(
      query,
      await plainly(() =>
        sdk().client.request<unknown, Record<string, unknown>>(query.text, variables),
      ),
    );
  // Every page of a connection, up to `limit` nodes.
  const pages = async <T>(
    query: LinearQuery<Page<T>>,
    variables: Record<string, unknown>,
    limit: number,
  ): Promise<Array<T>> => {
    const all: Array<T> = [];
    let after: string | null = null;
    while (all.length < limit) {
      const page: Page<T> = await request(query, { ...variables, after });
      all.push(...page.nodes);
      after = page.endCursor;
      if (!page.hasMore || after === null) {
        break;
      }
    }
    return all.slice(0, limit);
  };
  const blockers = (issueId: string) => request(blockersQuery, { id: issueId });
  const children = (issueId: string) => request(childrenQuery, { id: issueId });
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
      const found = await pages(backlogQuery, { filter }, BACKLOG_LIMIT);
      const issues: Array<LinearBacklogIssue> = [];
      for (const node of found) {
        issues.push({
          ...node.issue,
          blockers: node.blockers ?? (await blockers(node.issue.id)),
          children: node.children ?? (await children(node.issue.id)),
        });
      }
      return issues.toSorted((left, right) =>
        (right.createdAt ?? '').localeCompare(left.createdAt ?? ''),
      );
    },
    blockers,
    children,
    comment: (issueId, commentId) => request(commentQuery, { commentId, id: issueId }),
    createComment: async (input) => {
      succeeded(await plainly(() => sdk().createComment(input)), 'create the comment');
    },
    inventory: async () => {
      // The lists do not depend on each other, so they are read at once.
      const [teams, states, labels, projects] = await Promise.all([
        pages(teamsQuery, {}, INVENTORY_LIMIT),
        pages(statesQuery, {}, INVENTORY_LIMIT),
        pages(labelsQuery, {}, INVENTORY_LIMIT),
        pages(projectsQuery, {}, INVENTORY_LIMIT),
      ]);
      const usable = labels.filter((item) => !item.isGroup);
      const labelsOf = (team: string | null) =>
        usable.filter((item) => item.team === team).map((item) => item.label);
      return {
        labels: labelsOf(null),
        projects,
        teams: teams.map((team) => ({
          key: team.key,
          labels: labelsOf(team.key),
          name: team.name,
          states: inWorkflowOrder(states.filter((state) => state.team.key === team.key)).map(
            (state) => ({ name: state.name, type: state.type }),
          ),
        })),
      };
    },
    issue: (idOrKey) => request(issueQuery, { id: idOrKey }),
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
    teamStates: (teamId) => request(teamStatesQuery, { id: teamId }),
    updateComment: async (commentId, body) => {
      succeeded(
        await plainly(() => sdk().updateComment(commentId, { body })),
        'update the comment',
      );
    },
  };
}

// The workflow state types in workflow order, as plain strings: a state from
// Linear may have a type the factory does not know, which ranks last.
const WORKFLOW_ORDER: ReadonlyArray<string> = LINEAR_STATE_TYPES;

// Where a state stands in its team's workflow: by type, then by position.
function workflowRank(state: { position: number; type: string }): [number, number] {
  const type = WORKFLOW_ORDER.indexOf(state.type);
  return [type === -1 ? WORKFLOW_ORDER.length : type, state.position];
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
