import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import type { GithubClient, GithubIssue } from '../src/ports/github.ts';
import { FakeRuntime } from '../src/runtime/fake.ts';
import { type RunningServer, serve } from '../src/server/serve.ts';

// GET /v1/backlog end to end, with a stand-in for gh.

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

function issue(number: number, title: string): GithubIssue {
  return {
    body: '',
    host: 'github.com',
    labels: ['factory'],
    nodeId: `I_${number}`,
    number,
    owner: 'geut',
    repo: 'factory-skills',
    title,
    url: `https://github.com/geut/factory-skills/issues/${number}`,
  };
}

const issues = [issue(7, 'Remember the filter'), issue(8, 'Show the filter'), issue(9, 'Filters')];

type Factory = { base: string; listed: Array<Array<string>>; token: string };

async function factory(github: Partial<GithubClient> = {}): Promise<Factory> {
  const codeRoot = mkdtempSync(path.join(tmpdir(), 'factory-backlog-'));
  roots.push(codeRoot);
  mkdirSync(path.join(codeRoot, '.factory'));
  writeFileSync(
    path.join(codeRoot, '.factory', 'FACTORY.json'),
    JSON.stringify({
      models: { review: 'review-model', work: 'work-model' },
      tracker: {
        backlog: { labels: ['factory'] },
        kind: 'github',
        owner: 'geut',
        repo: 'factory-skills',
      },
    }),
  );
  const pi = path.join(codeRoot, 'pi');
  writeFileSync(pi, '#!/bin/sh\n');
  chmodSync(pi, 0o755);
  const listed: Array<Array<string>> = [];
  const result = await serve({
    cwd: codeRoot,
    env: { FACTORY_PI_BIN: pi, HERDR_PANE_ID: 'pane-1', HERDR_SOCKET_PATH: '/tmp/herdr.sock' },
    github: {
      fetchIssue: (input) => issues.find((item) => item.number === input.number) ?? issue(0, ''),
      listBlockedBy: (input) =>
        input.number === 8
          ? [
              {
                body: '',
                number: 3,
                title: 'Schema first',
                url: 'https://github.com/geut/factory-skills/issues/3',
              },
            ]
          : [],
      listIssues: (input) => {
        listed.push(input.labels);
        return issues;
      },
      listSubIssues: (input) =>
        input.number === 9 ? [{ body: '', number: 10, title: 'Slice', url: null }] : [],
      ...github,
    },
    out: () => undefined,
    port: 0,
    runtime: () => new FakeRuntime(),
  });
  if (result.kind !== 'ok') {
    throw new Error(result.message);
  }
  servers.push(result.server);
  const token = readFileSync(path.join(codeRoot, '.factory', 'local.token'), 'utf8').trim();
  return { base: result.server.url, listed, token };
}

type Backlog = {
  items: Array<{
    blocked: boolean;
    blockedBy: Array<{ displayRef: string }>;
    displayRef: string;
    umbrella: boolean;
  }>;
};

async function backlog(f: Factory, query = '', status = 200): Promise<Backlog> {
  const response = await fetch(`${f.base}/v1/backlog${query}`, {
    headers: { authorization: `Bearer ${f.token}` },
  });
  assert.equal(response.status, status);
  return (await response.json()) as Backlog;
}

test('the backlog lists matching issues, flags blocked ones and umbrellas, and drops started ones', async () => {
  const f = await factory();
  const first = await backlog(f);
  assert.deepEqual(f.listed, [['factory']]);
  assert.deepEqual(
    first.items.map((item) => [item.displayRef, item.blocked, item.umbrella]),
    [
      ['geut/factory-skills#7', false, false],
      ['geut/factory-skills#8', true, false],
      ['geut/factory-skills#9', false, true],
    ],
  );
  assert.deepEqual(
    first.items[1]?.blockedBy.map((link) => link.displayRef),
    ['geut/factory-skills#3'],
  );

  const started = await fetch(`${f.base}/v1/tickets`, {
    body: JSON.stringify({ ref: 'geut/factory-skills#7' }),
    headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json' },
    method: 'POST',
  });
  assert.equal(started.status, 202);
  const after = await backlog(f);
  assert.deepEqual(
    after.items.map((item) => item.displayRef),
    ['geut/factory-skills#8', 'geut/factory-skills#9'],
  );
  // That came from the cache; refresh asks the tracker again.
  assert.equal(f.listed.length, 1);
  await backlog(f, '?refresh=true');
  assert.equal(f.listed.length, 2);
});

test('a tracker that fails answers tracker_unavailable', async () => {
  const f = await factory({
    listIssues: () => {
      throw new Error('gh: connection refused');
    },
  });
  const failed = (await backlog(f, '', 502)) as unknown as { type: string };
  assert.equal(failed.type, 'tracker_unavailable');
});
