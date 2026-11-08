import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LinearTrackerConfig } from '../config.ts';
import {
  checkLinearSettings,
  commentIdFor,
  commentIdsFor,
  createLinearTracker,
  formatLinearInventory,
  linearMessage,
  type LinearApi,
  type LinearBacklogQuery,
  type LinearInventory,
  type LinearIssue,
  type LinearRelated,
  type LinearState,
} from './linear.ts';
import type { Tracker, TrackerIssue } from './tracker.ts';

const config: LinearTrackerConfig = {
  apiKeyEnv: 'LINEAR_API_KEY',
  backlog: { labels: ['factory'], project: null, states: ['backlog', 'unstarted'] },
  kind: 'linear',
  status: { in_progress: { state: 'In Progress' }, in_review: { state: 'In Review' } },
  team: 'ENG',
  updates: { checklist: true, comments: true },
};

// The ENG team's workflow, deliberately out of order: Linear orders states by
// type, then by position.
const engStates: Array<LinearState> = [
  { id: 's-review', name: 'In Review', position: 2, type: 'started' },
  { id: 's-todo', name: 'Todo', position: 1, type: 'unstarted' },
  { id: 's-progress', name: 'In Progress', position: 1, type: 'started' },
  { id: 's-done', name: 'Done', position: 1, type: 'completed' },
  { id: 's-backlog', name: 'Backlog', position: 0, type: 'backlog' },
];

function linearIssue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    createdAt: '2026-11-01T10:00:00.000Z',
    creator: 'Ada',
    description: 'Keep the catalog filter.\n- [ ] A reload keeps the filter.\n',
    id: 'uuid-42',
    identifier: 'ENG-42',
    labels: ['factory'],
    state: engStates[1] ?? null,
    team: { id: 'team-eng', key: 'ENG' },
    title: 'Remember the filter',
    updatedAt: '2026-11-02T10:00:00.000Z',
    url: 'https://linear.app/acme/issue/ENG-42/remember-the-filter',
    ...overrides,
  };
}

type Fake = {
  api: LinearApi;
  backlogQueries: Array<LinearBacklogQuery>;
  blockers: Array<LinearRelated>;
  children: Array<LinearRelated>;
  comments: Map<string, string>;
  // Ids of comments a person deleted, which Linear never takes again.
  deleted: Set<string>;
  issue: LinearIssue;
  writes: Array<Array<unknown>>;
};

// An in-memory Linear with one issue.
function fake(issue = linearIssue()): Fake {
  const state: Fake = {
    api: null as unknown as LinearApi,
    backlogQueries: [],
    blockers: [],
    children: [],
    comments: new Map(),
    deleted: new Set(),
    issue,
    writes: [],
  };
  state.api = {
    backlog: async (query) => {
      state.backlogQueries.push(query);
      return [{ ...state.issue, blockers: state.blockers, children: state.children }];
    },
    blockers: async () => {
      state.writes.push(['blockers']);
      return state.blockers;
    },
    children: async () => {
      state.writes.push(['children']);
      return state.children;
    },
    comment: async (_issueId, commentIds) => {
      const id = commentIds.findLast((item) => state.comments.has(item));
      return id === undefined ? null : { body: state.comments.get(id) ?? '', id };
    },
    createComment: async (input) => {
      if (state.comments.has(input.id) || state.deleted.has(input.id)) {
        throw new Error('Argument Validation Error');
      }
      state.writes.push(['createComment', input.id, input.body]);
      state.comments.set(input.id, input.body);
    },
    inventory: async () => {
      throw new Error('unused');
    },
    issue: async (idOrKey) => {
      if (idOrKey !== state.issue.id && idOrKey !== state.issue.identifier) {
        throw new Error(`Entity not found: Issue ${idOrKey}`);
      }
      return state.issue;
    },
    setDescription: async (_issueId, description) => {
      state.writes.push(['setDescription', description]);
      state.issue = { ...state.issue, description };
    },
    setState: async (_issueId, stateId) => {
      state.writes.push(['setState', stateId]);
      state.issue = {
        ...state.issue,
        state: engStates.find((item) => item.id === stateId) ?? null,
      };
    },
    teamStates: async (teamId) => (teamId === 'team-eng' ? engStates : []),
    updateComment: async (commentId, body) => {
      state.writes.push(['updateComment', commentId, body]);
      state.comments.set(commentId, body);
    },
  };
  return state;
}

async function resolved(tracker: Tracker, ref = 'ENG-42'): Promise<TrackerIssue> {
  const result = await tracker.resolve(ref);
  assert.equal(result?.kind, 'issue', ref);
  if (result?.kind !== 'issue') {
    throw new Error('not resolved');
  }
  return result.issue;
}

test('an issue key or its Linear URL resolves; GitHub refs are not Linear refs', async () => {
  const tracker = createLinearTracker(config, fake().api);
  for (const ref of [
    'ENG-42',
    'eng-42',
    'https://linear.app/acme/issue/ENG-42/remember-the-filter',
    'https://linear.app/acme/issue/ENG-42',
  ]) {
    const issue = await resolved(tracker, ref);
    assert.deepEqual(issue, {
      author: 'Ada',
      body: 'Keep the catalog filter.\n- [ ] A reload keeps the filter.\n',
      createdAt: '2026-11-01T10:00:00.000Z',
      displayRef: 'ENG-42',
      id: 'linear:uuid-42',
      labels: ['factory'],
      ref,
      title: 'Remember the filter',
      updatedAt: '2026-11-02T10:00:00.000Z',
      url: 'https://linear.app/acme/issue/ENG-42/remember-the-filter',
    });
  }
  for (const ref of ['geut/factory-skills#7', 'https://github.com/geut/factory-skills/issues/7']) {
    assert.equal(await tracker.resolve(ref), null, ref);
  }
});

test('a bare number asks for the issue key, and an unknown issue is a tracker error', async () => {
  const tracker = createLinearTracker(config, fake().api);
  assert.deepEqual(await tracker.resolve('42'), {
    kind: 'error',
    message: 'Bare issue 42 is not a Linear ref; use its key, such as ENG-42.',
  });
  assert.deepEqual(await tracker.resolve('#42'), {
    kind: 'error',
    message: 'Bare issue #42 is not a Linear ref; use its key, such as ENG-42.',
  });
  assert.deepEqual(await tracker.resolve('ENG-7'), {
    kind: 'error',
    message: 'Entity not found: Issue ENG-7',
    reason: 'tracker_unavailable',
  });
});

test('the backlog is the configured team, labels, project, and state types', async () => {
  const linear = fake();
  const tracker = createLinearTracker(
    { ...config, backlog: { labels: ['factory', 'web'], project: 'Catalog', states: ['backlog'] } },
    linear.api,
  );
  assert.ok(tracker.capabilities.has('backlog'));
  const issues = await tracker.listBacklog();
  assert.deepEqual(linear.backlogQueries, [
    { labels: ['factory', 'web'], project: 'Catalog', states: ['backlog'], team: 'ENG' },
  ]);
  assert.deepEqual(
    issues.map((issue) => [issue.displayRef, issue.ref, issue.id]),
    [['ENG-42', 'ENG-42', 'linear:uuid-42']],
  );
});

test('a backlog issue comes with its links, so the backlog makes no call per issue', async () => {
  const linear = fake();
  linear.children = [{ identifier: 'ENG-43', stateType: 'started', title: 'Slice', url: null }];
  linear.blockers = [
    { identifier: 'ENG-30', stateType: 'completed', title: 'Done already', url: null },
    { identifier: 'ENG-32', stateType: 'started', title: 'Schema first', url: null },
  ];
  const [issue] = await createLinearTracker(config, linear.api).listBacklog();
  assert.deepEqual(issue?.links, {
    blockedBy: [{ displayRef: 'ENG-32', title: 'Schema first', url: null }],
    children: [{ displayRef: 'ENG-43', title: 'Slice', url: null }],
  });
  assert.deepEqual(linear.writes, []);
});

test('sub-issues are children, and only an unfinished blocker blocks', async () => {
  const linear = fake();
  linear.children = [
    { identifier: 'ENG-43', stateType: 'completed', title: 'First slice', url: null },
  ];
  linear.blockers = [
    { identifier: 'ENG-30', stateType: 'completed', title: 'Done already', url: null },
    { identifier: 'ENG-31', stateType: 'canceled', title: 'Dropped', url: null },
    { identifier: 'ENG-32', stateType: 'started', title: 'Schema first', url: 'https://l/32' },
  ];
  const tracker = createLinearTracker(config, linear.api);
  const issue = await resolved(tracker);
  assert.deepEqual(await tracker.children(issue), [
    { displayRef: 'ENG-43', title: 'First slice', url: null },
  ]);
  assert.deepEqual(await tracker.blockedBy(issue), [
    { displayRef: 'ENG-32', title: 'Schema first', url: 'https://l/32' },
  ]);
});

test('the checklist is the description’s boxes, ticked in the description as it is now', async () => {
  const linear = fake();
  const tracker = createLinearTracker(config, linear.api);
  const issue = await resolved(tracker);
  assert.deepEqual(await tracker.checklistItems(issue), [
    { done: false, key: '1:A reload keeps the filter.', text: 'A reload keeps the filter.' },
  ]);
  // Someone adds a box after the ticket started; ticking keeps it.
  linear.issue = {
    ...linear.issue,
    description: `${linear.issue.description}- [ ] Has a clear label.\n`,
  };
  assert.deepEqual(await tracker.tickBoxes(issue, ['1:A reload keeps the filter.', '1:Gone.']), {
    conflicts: ['1:Gone.'],
  });
  assert.deepEqual(linear.writes, [
    [
      'setDescription',
      'Keep the catalog filter.\n- [x] A reload keeps the filter.\n- [ ] Has a clear label.\n',
    ],
  ]);
  // Nothing left to tick: the description is not written again.
  await tracker.tickBoxes(issue, ['1:A reload keeps the filter.']);
  assert.equal(linear.writes.length, 1);
});

test('a comment gets an id from its issue and key, so a retry finds it instead of posting twice', async () => {
  const linear = fake();
  const tracker = createLinearTracker(config, linear.api);
  const issue = await resolved(tracker);
  const id = commentIdFor('uuid-42', 'handoff:T1');
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(commentIdFor('uuid-42', 'handoff:T1'), id);
  assert.notEqual(commentIdFor('uuid-43', 'handoff:T1'), id);

  await tracker.comment(issue, 'Finished; opened #9.', 'handoff:T1', 'replace');
  await tracker.comment(issue, 'Finished; opened #9.', 'handoff:T1', 'replace');
  await tracker.comment(issue, 'Finished again; opened #10.', 'handoff:T1', 'replace');
  await tracker.comment(issue, 'Something else.', 'handoff:T1', 'once');
  assert.deepEqual(linear.writes, [
    ['createComment', id, 'Finished; opened #9.'],
    ['updateComment', id, 'Finished again; opened #10.'],
  ]);
});

test('after a person deletes the factory’s comment, the next post takes the next id', async () => {
  const linear = fake();
  const tracker = createLinearTracker(config, linear.api);
  const issue = await resolved(tracker);
  const [first, second] = commentIdsFor('uuid-42', 'progress:T1');
  assert.equal(first, commentIdFor('uuid-42', 'progress:T1'));
  await tracker.comment(issue, 'Step 1.', 'progress:T1', 'replace');
  linear.comments.delete(first ?? '');
  linear.deleted.add(first ?? '');
  await tracker.comment(issue, 'Step 2.', 'progress:T1', 'replace');
  await tracker.comment(issue, 'Step 3.', 'progress:T1', 'replace');
  assert.deepEqual(linear.writes, [
    ['createComment', first, 'Step 1.'],
    ['createComment', second, 'Step 2.'],
    ['updateComment', second, 'Step 3.'],
  ]);
});

test('a create that failed after it went through is found, not posted again', async () => {
  const linear = fake();
  const create = linear.api.createComment;
  linear.api.createComment = async (input) => {
    await create(input);
    throw new Error('socket hang up');
  };
  const tracker = createLinearTracker(config, linear.api);
  await tracker.comment(await resolved(tracker), 'Once.', 'handoff:T1', 'once');
  assert.deepEqual(linear.writes, [
    ['createComment', commentIdFor('uuid-42', 'handoff:T1'), 'Once.'],
  ]);
});

test('a status moves the issue forward to the mapped state of its team, never back', async () => {
  const linear = fake();
  const tracker = createLinearTracker(config, linear.api);
  const issue = await resolved(tracker);
  assert.equal(await tracker.setStatus(issue, 'in_progress'), null);
  assert.equal(await tracker.setStatus(issue, 'in_review'), null);
  // In Review is already past In Progress, as when a person moved it.
  assert.equal(await tracker.setStatus(issue, 'in_progress'), null);
  assert.deepEqual(linear.writes, [
    ['setState', 's-progress'],
    ['setState', 's-review'],
  ]);
});

test('a finished issue, a clear, and an unmapped status leave the state alone', async () => {
  const done = fake(linearIssue({ state: engStates[3] ?? null }));
  const tracker = createLinearTracker(config, done.api);
  const issue = await resolved(tracker);
  assert.equal(await tracker.setStatus(issue, 'in_review'), null);
  assert.equal(await tracker.setStatus(issue, 'clear'), null);
  const unmapped = createLinearTracker({ ...config, status: {} }, done.api);
  assert.equal(await unmapped.setStatus(issue, 'in_progress'), null);
  assert.deepEqual(done.writes, []);
});

test('an issue of a team without the mapped state is left as it is, and says why', async () => {
  const ops = fake(
    linearIssue({ id: 'uuid-7', identifier: 'OPS-7', team: { id: 'team-ops', key: 'OPS' } }),
  );
  const tracker = createLinearTracker(config, ops.api);
  const issue = await resolved(tracker, 'OPS-7');
  assert.equal(
    await tracker.setStatus(issue, 'in_progress'),
    'The OPS team has no workflow state "In Progress", so OPS-7 stays where it is.',
  );
  assert.deepEqual(ops.writes, []);
});

const inventory: LinearInventory = {
  labels: [
    { group: null, name: 'factory' },
    { group: 'Type', name: 'Bug' },
  ],
  projects: [{ name: 'Catalog' }],
  teams: [
    {
      key: 'ENG',
      labels: [{ group: null, name: 'web' }],
      name: 'Engineering',
      states: [
        { name: 'Backlog', type: 'backlog' },
        { name: 'Todo', type: 'unstarted' },
        { name: 'In Progress', type: 'started' },
        { name: 'In Review', type: 'started' },
        { name: 'Done', type: 'completed' },
      ],
    },
    { key: 'OPS', labels: [], name: 'Operations', states: [] },
  ],
};

test('settings that name what the workspace has pass the check', () => {
  assert.deepEqual(
    checkLinearSettings(
      {
        ...config,
        backlog: { labels: ['factory', 'web', 'Bug'], project: 'Catalog', states: ['backlog'] },
      },
      inventory,
    ),
    [],
  );
});

test('each name the workspace lacks is listed with the names it has', () => {
  assert.deepEqual(checkLinearSettings({ ...config, team: 'WEB' }, inventory), [
    'Linear has no team with key "WEB" that the API key can see. Teams: "ENG (Engineering)", "OPS (Operations)".',
  ]);
  assert.deepEqual(
    checkLinearSettings(
      {
        ...config,
        backlog: { labels: ['agent'], project: 'Search', states: ['backlog'] },
        status: { in_review: { state: 'Review' } },
      },
      inventory,
    ),
    [
      'The ENG team has no label "agent". Labels: "factory", "Bug", "web".',
      'Linear has no project "Search". Projects: "Catalog".',
      'tracker.status.in_review: the ENG team has no workflow state "Review". States: "Backlog", "Todo", "In Progress", "In Review", "Done".',
    ],
  );
});

test('the inventory reads as the names each setting takes', () => {
  assert.deepEqual(formatLinearInventory(inventory), [
    'Teams (tracker.team is the key):',
    '  ENG  Engineering',
    '    states (tracker.status maps names; tracker.backlog.states takes types):',
    '      Backlog  [backlog]',
    '      Todo  [unstarted]',
    '      In Progress  [started]',
    '      In Review  [started]',
    '      Done  [completed]',
    '    team labels: web',
    '  OPS  Operations',
    '    states (tracker.status maps names; tracker.backlog.states takes types):',
    'Workspace labels (tracker.backlog.labels): factory, Bug (in Type)',
    'Projects (tracker.backlog.project): Catalog',
  ]);
});

test('a failed Linear call reads as Linear’s own message, without the request it sent', () => {
  const raw = Object.assign(
    new Error('Authentication required, not authenticated: {"response":{"errors":[]}}'),
    { response: { errors: [{ message: 'Authentication required, not authenticated' }] } },
  );
  assert.equal(linearMessage(raw), 'Authentication required, not authenticated');
  const typed = Object.assign(new Error('Entity not found - Could not find referenced Issue.'), {
    errors: [{ message: 'Entity not found: Issue' }],
  });
  assert.equal(linearMessage(typed), 'Entity not found: Issue');
  assert.equal(linearMessage(new Error('fetch failed: {"x":1}')), 'fetch failed');
});
