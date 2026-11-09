import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  backlogQuery,
  blockersQuery,
  childrenQuery,
  commentQuery,
  issueQuery,
  labelsQuery,
  parseResponse,
  projectsQuery,
  statesQuery,
  teamStatesQuery,
  teamsQuery,
} from './linear-graphql.ts';

// Responses in the shape Linear's GraphQL API returns them for each query,
// trimmed to the fields the queries select. No network.

const state = { id: 's-progress', name: 'In Progress', position: 1, type: 'started' };

function issueNode(overrides: Record<string, unknown> = {}) {
  return {
    createdAt: '2026-11-01T10:00:00.000Z',
    creator: { displayName: 'ada' },
    description: 'Keep the filter.\n- [ ] A reload keeps it.\n',
    id: 'uuid-42',
    identifier: 'ENG-42',
    labels: { nodes: [{ name: 'factory' }] },
    state,
    team: { id: 'team-eng', key: 'ENG' },
    title: 'Remember the filter',
    updatedAt: '2026-11-02T10:00:00.000Z',
    url: 'https://linear.app/acme/issue/ENG-42/remember-the-filter',
    ...overrides,
  };
}

function related(identifier: string, type = 'started') {
  return {
    identifier,
    state: { type },
    title: `Issue ${identifier}`,
    url: `https://linear.app/acme/issue/${identifier}`,
  };
}

function backlogNode(overrides: Record<string, unknown> = {}) {
  return {
    ...issueNode(),
    children: { nodes: [related('ENG-43')], pageInfo: { hasNextPage: false } },
    inverseRelations: {
      nodes: [
        { issue: related('ENG-30', 'completed'), type: 'blocks' },
        { issue: related('ENG-31'), type: 'related' },
      ],
      pageInfo: { hasNextPage: false },
    },
    ...overrides,
  };
}

function backlog(nodes: Array<unknown>, pageInfo = { endCursor: 'c1', hasNextPage: false }) {
  return { issues: { nodes, pageInfo } };
}

const parsedIssue = {
  createdAt: '2026-11-01T10:00:00.000Z',
  creator: 'ada',
  description: 'Keep the filter.\n- [ ] A reload keeps it.\n',
  id: 'uuid-42',
  identifier: 'ENG-42',
  labels: ['factory'],
  state,
  team: { id: 'team-eng', key: 'ENG' },
  title: 'Remember the filter',
  updatedAt: '2026-11-02T10:00:00.000Z',
  url: 'https://linear.app/acme/issue/ENG-42/remember-the-filter',
};

test('a backlog page parses into issues with their blockers and sub-issues', () => {
  assert.deepEqual(parseResponse(backlogQuery, backlog([backlogNode()])), {
    endCursor: 'c1',
    hasMore: false,
    nodes: [
      {
        // Only the `blocks` relation blocks; finished blockers are the tracker's to drop.
        blockers: [
          {
            identifier: 'ENG-30',
            stateType: 'completed',
            title: 'Issue ENG-30',
            url: 'https://linear.app/acme/issue/ENG-30',
          },
        ],
        children: [
          {
            identifier: 'ENG-43',
            stateType: 'started',
            title: 'Issue ENG-43',
            url: 'https://linear.app/acme/issue/ENG-43',
          },
        ],
        issue: parsedIssue,
      },
    ],
  });
});

test('a list with more than the backlog read is left to be read on its own', () => {
  const page = parseResponse(
    backlogQuery,
    backlog(
      [
        backlogNode({
          children: { nodes: [related('ENG-43')], pageInfo: { hasNextPage: true } },
          inverseRelations: { nodes: [], pageInfo: { hasNextPage: true } },
        }),
      ],
      { endCursor: 'c2', hasNextPage: true },
    ),
  );
  assert.equal(page.hasMore, true);
  assert.equal(page.endCursor, 'c2');
  assert.equal(page.nodes[0]?.blockers, null);
  assert.equal(page.nodes[0]?.children, null);
});

test('a null description or creator, as Linear allows, parses', () => {
  const issue = parseResponse(issueQuery, {
    issue: issueNode({ creator: null, description: null }),
  });
  assert.equal(issue.description, '');
  assert.equal(issue.creator, null);
  assert.deepEqual(parseResponse(issueQuery, { issue: issueNode() }), parsedIssue);
});

test('a missing or mistyped field fails with the query and where it is', () => {
  const { identifier: _, ...noKey } = backlogNode();
  assert.throws(
    () => parseResponse(backlogQuery, backlog([backlogNode(), noKey])),
    /^Error: Linear returned an unexpected FactoryBacklog response: issues\.nodes\[1\]\.identifier: Invalid input: expected string, received undefined$/,
  );
  assert.throws(
    () => parseResponse(issueQuery, { issue: issueNode({ title: 42, url: null }) }),
    /^Error: Linear returned an unexpected FactoryIssue response: issue\.title: Invalid input: expected string, received number \(and 1 more\)$/,
  );
  assert.throws(
    () => parseResponse(issueQuery, { issue: null }),
    /^Error: Linear returned an unexpected FactoryIssue response: issue: /,
  );
  assert.throws(
    () => parseResponse(teamsQuery, null),
    /^Error: Linear returned an unexpected FactoryTeams response: the response: /,
  );
});

test('a workflow state or relation type Linear adds still parses', () => {
  const custom = { ...state, type: 'review' };
  assert.deepEqual(parseResponse(teamStatesQuery, { team: { states: { nodes: [custom] } } }), [
    custom,
  ]);
  const blockers = parseResponse(blockersQuery, {
    issue: {
      inverseRelations: {
        nodes: [
          { issue: related('ENG-50', 'review'), type: 'blocks' },
          { issue: related('ENG-51'), type: 'similar' },
        ],
      },
    },
  });
  assert.deepEqual(
    blockers.map((item) => [item.identifier, item.stateType]),
    [['ENG-50', 'review']],
  );
});

test('sub-issues, and a comment by id that is there or not', () => {
  assert.deepEqual(
    parseResponse(childrenQuery, { issue: { children: { nodes: [related('ENG-43')] } } }).map(
      (item) => item.identifier,
    ),
    ['ENG-43'],
  );
  assert.deepEqual(
    parseResponse(commentQuery, { issue: { comments: { nodes: [{ body: 'Started.' }] } } }),
    { body: 'Started.' },
  );
  assert.equal(parseResponse(commentQuery, { issue: { comments: { nodes: [] } } }), null);
});

test('the inventory lists parse: teams, states, labels with their group and team, projects', () => {
  const pageInfo = { endCursor: null, hasNextPage: false };
  assert.deepEqual(
    parseResponse(teamsQuery, {
      teams: { nodes: [{ key: 'ENG', name: 'Engineering' }], pageInfo },
    }),
    { endCursor: null, hasMore: false, nodes: [{ key: 'ENG', name: 'Engineering' }] },
  );
  assert.deepEqual(
    parseResponse(statesQuery, {
      workflowStates: {
        nodes: [{ name: 'Todo', position: 0, team: { key: 'ENG' }, type: 'unstarted' }],
        pageInfo,
      },
    }).nodes,
    [{ name: 'Todo', position: 0, team: { key: 'ENG' }, type: 'unstarted' }],
  );
  assert.deepEqual(
    parseResponse(labelsQuery, {
      issueLabels: {
        nodes: [
          { isGroup: false, name: 'factory', parent: null, team: null },
          { isGroup: true, name: 'Type', parent: null, team: null },
          { isGroup: false, name: 'Bug', parent: { name: 'Type' }, team: { key: 'ENG' } },
        ],
        pageInfo,
      },
    }).nodes,
    [
      { isGroup: false, label: { group: null, name: 'factory' }, team: null },
      { isGroup: true, label: { group: null, name: 'Type' }, team: null },
      { isGroup: false, label: { group: 'Type', name: 'Bug' }, team: 'ENG' },
    ],
  );
  assert.deepEqual(
    parseResponse(projectsQuery, { projects: { nodes: [{ name: 'Catalog' }], pageInfo } }).nodes,
    [{ name: 'Catalog' }],
  );
});

test('every query is named, so a failure can say which one', () => {
  assert.deepEqual(
    [
      backlogQuery,
      blockersQuery,
      childrenQuery,
      commentQuery,
      issueQuery,
      labelsQuery,
      projectsQuery,
      statesQuery,
      teamStatesQuery,
      teamsQuery,
    ].map((query) => query.name),
    [
      'FactoryBacklog',
      'FactoryBlockers',
      'FactoryChildren',
      'FactoryComment',
      'FactoryIssue',
      'FactoryLabels',
      'FactoryProjects',
      'FactoryStates',
      'FactoryTeamStates',
      'FactoryTeams',
    ],
  );
});
