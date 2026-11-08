import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import type { GithubClient } from '../src/ports/github.ts';
import type { LinearApi, LinearInventory, LinearIssue, LinearState } from '../src/ports/linear.ts';
import { FakeRuntime } from '../src/runtime/fake.ts';
import { type RunningServer, serve } from '../src/server/serve.ts';
import { runTrackerCommand } from '../src/server/tracker-cli.ts';
import { openStateDatabase } from '../src/state/database.ts';
import { initRepo } from './git-repo.ts';

// Linear as the tracker, end to end: startup checks, starting a ticket from an
// issue key, tracker updates, the backlog, and the inventory, with a stand-in
// for Linear.

const roots: Array<string> = [];
const servers: Array<RunningServer> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const states: Array<LinearState> = [
  { id: 's-backlog', name: 'Backlog', position: 0, type: 'backlog' },
  { id: 's-progress', name: 'In Progress', position: 1, type: 'started' },
  { id: 's-review', name: 'In Review', position: 2, type: 'started' },
];

const inventory: LinearInventory = {
  labels: [{ group: null, name: 'factory' }],
  projects: [],
  teams: [
    {
      key: 'ENG',
      labels: [],
      name: 'Engineering',
      states: states.map((state) => ({ name: state.name, type: state.type })),
    },
  ],
};

function issue(identifier: string, teamKey = 'ENG'): LinearIssue {
  return {
    createdAt: '2026-11-01T10:00:00.000Z',
    creator: 'Ada',
    description: 'Keep the catalog filter.',
    id: `uuid-${identifier}`,
    identifier,
    labels: ['factory'],
    state: states[0] ?? null,
    team: { id: `team-${teamKey}`, key: teamKey },
    title: 'Remember the filter',
    updatedAt: null,
    url: `https://linear.app/acme/issue/${identifier}`,
  };
}

type Linear = {
  api: LinearApi;
  comments: Map<string, string>;
  issues: Map<string, LinearIssue>;
  keys: Array<string>;
};

function linear(): Linear {
  const issues = new Map([issue('ENG-42'), issue('OPS-7', 'OPS')].map((item) => [item.id, item]));
  const find = (idOrKey: string): LinearIssue => {
    const found = [...issues.values()].find(
      (item) => item.id === idOrKey || item.identifier === idOrKey,
    );
    if (found === undefined) {
      throw new Error(`Entity not found: Issue ${idOrKey}`);
    }
    return found;
  };
  const state: Linear = {
    api: null as unknown as LinearApi,
    comments: new Map(),
    issues,
    keys: [],
  };
  state.api = {
    backlog: async () => [{ ...find('ENG-42'), blockers: [], children: [] }],
    blockers: async () => [],
    children: async () => [],
    comment: async (_issueId, ids) => {
      const id = ids.findLast((item) => state.comments.has(item));
      return id === undefined ? null : { body: state.comments.get(id) ?? '', id };
    },
    createComment: async ({ body, id }) => {
      state.comments.set(id, body);
    },
    inventory: async () => inventory,
    issue: async (idOrKey) => find(idOrKey),
    setDescription: async () => undefined,
    setState: async (issueId, stateId) => {
      const current = find(issueId);
      issues.set(issueId, {
        ...current,
        state: states.find((item) => item.id === stateId) ?? null,
      });
    },
    teamStates: async (teamId) => (teamId === 'team-ENG' ? states : []),
    updateComment: async (id, body) => {
      state.comments.set(id, body);
    },
  };
  return state;
}

function repository(tracker: Record<string, unknown> = {}): string {
  const codeRoot = mkdtempSync(path.join(tmpdir(), 'factory-linear-'));
  roots.push(codeRoot);
  initRepo(codeRoot);
  mkdirSync(path.join(codeRoot, '.factory'));
  writeFileSync(
    path.join(codeRoot, '.factory', 'FACTORY.json'),
    JSON.stringify({
      models: { review: 'review-model', work: 'work-model' },
      tracker: {
        backlog: { labels: ['factory'] },
        kind: 'linear',
        status: { in_progress: { state: 'In Progress' }, in_review: { state: 'In Review' } },
        team: 'ENG',
        ...tracker,
      },
    }),
  );
  const pi = path.join(codeRoot, 'pi');
  writeFileSync(pi, '#!/bin/sh\n');
  chmodSync(pi, 0o755);
  return codeRoot;
}

// GitHub is never asked for a Linear ticket.
const noGithub: GithubClient = {
  fetchIssue: () => {
    throw new Error('GitHub was asked');
  },
  listSubIssues: () => [],
};

async function start(
  codeRoot: string,
  fake: Linear,
  env: NodeJS.ProcessEnv = { LINEAR_API_KEY: 'lin_api_test' },
  out: (line: string) => void = () => undefined,
) {
  const keys = fake.keys;
  return serve({
    cwd: codeRoot,
    env: {
      FACTORY_PI_BIN: path.join(codeRoot, 'pi'),
      HERDR_PANE_ID: 'pane-1',
      HERDR_SOCKET_PATH: '/tmp/herdr.sock',
      ...env,
    },
    github: noGithub,
    linear: (apiKeyEnv) => {
      keys.push(apiKeyEnv);
      return fake.api;
    },
    out,
    port: 0,
    runtime: () => new FakeRuntime(),
  });
}

async function running(codeRoot: string, fake: Linear) {
  const result = await start(codeRoot, fake);
  if (result.kind !== 'ok') {
    throw new Error(result.message);
  }
  servers.push(result.server);
  const token = readFileSync(path.join(codeRoot, '.factory', 'local.token'), 'utf8').trim();
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  return { base: result.server.url, headers };
}

async function until(check: () => boolean, tries = 400): Promise<void> {
  for (let left = tries; left > 0 && !check(); left -= 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(check(), 'timed out');
}

function updates(codeRoot: string): Array<Record<string, unknown>> {
  const db = openStateDatabase(path.join(codeRoot, '.factory'), { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT status, last_error FROM actions WHERE kind = 'update_ticket_source' ORDER BY rowid",
      )
      .all()
      .map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

test('without its API key, a Linear tracker refuses to start', async () => {
  const result = await start(repository(), linear(), {});
  assert.equal(result.kind, 'error');
  assert.match(
    result.kind === 'error' ? result.message : '',
    /tracker is Linear: Set LINEAR_API_KEY to a Linear personal API key/,
  );
});

test('without its API key, the real Linear client still lets the server say so', async () => {
  const codeRoot = repository();
  const result = await serve({
    cwd: codeRoot,
    env: {
      FACTORY_PI_BIN: path.join(codeRoot, 'pi'),
      HERDR_PANE_ID: 'pane-1',
      HERDR_SOCKET_PATH: '/tmp/herdr.sock',
    },
    github: noGithub,
    out: () => undefined,
    port: 0,
    runtime: () => new FakeRuntime(),
  });
  assert.match(
    result.kind === 'error' ? result.message : '',
    /tracker is Linear: Set LINEAR_API_KEY/,
  );
});

test('a team, label, or state the workspace lacks stops the server, listing what it has', async () => {
  const result = await start(
    repository({ backlog: { labels: ['agent'] }, status: { in_review: { state: 'Review' } } }),
    linear(),
  );
  assert.equal(result.kind, 'error');
  const message = result.kind === 'error' ? result.message : '';
  assert.match(message, /run factory tracker inspect/);
  assert.match(message, /- The ENG team has no label "agent"\. Labels: "factory"\./);
  assert.match(
    message,
    /- tracker\.status\.in_review: the ENG team has no workflow state "Review"/,
  );
});

test('Linear out of reach at startup is a warning, and the server starts', async () => {
  const fake = linear();
  fake.api.inventory = async () => {
    throw new Error('fetch failed');
  };
  const lines: Array<string> = [];
  const result = await start(repository(), fake, undefined, (line) => lines.push(line));
  assert.equal(result.kind, 'ok');
  if (result.kind === 'ok') {
    servers.push(result.server);
  }
  assert.ok(
    lines.includes(
      "Warning: could not check FACTORY.json's tracker settings with Linear: fetch failed",
    ),
    lines.join('\n'),
  );
});

test('a Linear issue starts by its key, gets one comment, and moves to In Progress', async () => {
  const codeRoot = repository();
  const fake = linear();
  const { base, headers } = await running(codeRoot, fake);
  const response = await fetch(`${base}/v1/tickets`, {
    body: JSON.stringify({ ref: 'eng-42' }),
    headers,
    method: 'POST',
  });
  assert.equal(response.status, 202);
  await until(() => updates(codeRoot)[0]?.['status'] === 'succeeded');
  assert.deepEqual([...fake.comments.values()].length, 1);
  assert.match([...fake.comments.values()][0] ?? '', /The factory started working on this issue\./);
  // The comment needs no hidden marker: its id is the key.
  assert.doesNotMatch([...fake.comments.values()][0] ?? '', /<!--/);
  assert.equal(fake.issues.get('uuid-ENG-42')?.state?.name, 'In Progress');
  assert.ok(fake.keys.every((key) => key === 'LINEAR_API_KEY'));

  const tickets = (await (await fetch(`${base}/v1/tickets`, { headers })).json()) as {
    items: Array<{ displayRef: string }>;
  };
  assert.deepEqual(
    tickets.items.map((item) => item.displayRef),
    ['ENG-42'],
  );
});

test('a bare number is refused with the key to use instead', async () => {
  const { base, headers } = await running(repository(), linear());
  const response = await fetch(`${base}/v1/tickets`, {
    body: JSON.stringify({ ref: '42' }),
    headers,
    method: 'POST',
  });
  assert.equal(response.status, 400);
  assert.match(
    ((await response.json()) as { detail: string }).detail,
    /use its key, such as ENG-42/,
  );
});

test('an issue of another team starts, and its missing state is a warning, not a pause', async () => {
  const codeRoot = repository();
  const fake = linear();
  const { base, headers } = await running(codeRoot, fake);
  const response = await fetch(`${base}/v1/tickets`, {
    body: JSON.stringify({ ref: 'OPS-7' }),
    headers,
    method: 'POST',
  });
  assert.equal(response.status, 202);
  await until(() => updates(codeRoot)[0]?.['status'] === 'failed');
  assert.equal(
    updates(codeRoot)[0]?.['last_error'],
    'The OPS team has no workflow state "In Progress", so OPS-7 stays where it is.',
  );
  // The comment still went out.
  assert.equal(fake.comments.size, 1);
});

test('the backlog and the inventory come from Linear', async () => {
  const { base, headers } = await running(repository(), linear());
  const backlog = (await (await fetch(`${base}/v1/backlog`, { headers })).json()) as {
    items: Array<{ displayRef: string; url: string }>;
  };
  assert.deepEqual(
    backlog.items.map((item) => [item.displayRef, item.url]),
    [['ENG-42', 'https://linear.app/acme/issue/ENG-42']],
  );
  const found = await fetch(`${base}/v1/tracker/inventory`, { headers });
  assert.equal(found.status, 200);
  assert.deepEqual(await found.json(), { kind: 'linear', ...inventory });
});

test('factory tracker inspect lists the workspace before any tracker is configured', async () => {
  const codeRoot = mkdtempSync(path.join(tmpdir(), 'factory-inspect-'));
  roots.push(codeRoot);
  const out: Array<string> = [];
  const err: Array<string> = [];
  const io = { err: (line: string) => err.push(line), out: (line: string) => out.push(line) };
  const fake = linear();
  const linearFor = (apiKeyEnv: string) => {
    fake.keys.push(apiKeyEnv);
    return fake.api;
  };

  assert.equal(
    await runTrackerCommand(['inspect'], codeRoot, io, { env: {}, linear: linearFor }),
    1,
  );
  assert.deepEqual(err, ['Set LINEAR_API_KEY to a Linear personal API key.']);

  const env = { LINEAR_API_KEY: 'lin_api_test' };
  assert.equal(await runTrackerCommand(['inspect'], codeRoot, io, { env, linear: linearFor }), 0);
  assert.equal(out[0], 'Teams (tracker.team is the key):');
  assert.ok(out.includes('      In Review  [started]'));

  out.length = 0;
  assert.equal(
    await runTrackerCommand(['inspect', '--json'], codeRoot, io, { env, linear: linearFor }),
    0,
  );
  assert.deepEqual(JSON.parse(out.join('\n')), inventory);
  assert.equal(await runTrackerCommand(['list'], codeRoot, io, { env, linear: linearFor }), 2);
});
