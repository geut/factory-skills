import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import type { GithubClient, GithubIssue, GithubLinked } from '../src/ports/github.ts';
import { FakeRuntime, sampleUsage } from '../src/runtime/fake.ts';
import { type RunningServer, serve } from '../src/server/serve.ts';
import { initRepo } from './git-repo.ts';

// The plan stage gets the ticket's linked issues, end to end: read once from
// the tracker when its worktree is ready, listed in its first prompt.

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

const issue: GithubIssue = {
  author: null,
  body: 'Same fix shape as #5.',
  createdAt: null,
  host: 'github.com',
  labels: [],
  nodeId: 'I_7',
  number: 7,
  owner: 'geut',
  repo: 'factory-skills',
  title: 'Remember the filter',
  updatedAt: null,
  url: 'https://github.com/geut/factory-skills/issues/7',
};

function linked(
  number: number,
  title: string,
  overrides: Partial<GithubLinked> = {},
): GithubLinked {
  return {
    comments: 0,
    kind: 'issue',
    number,
    owner: 'geut',
    pullRequests: [],
    repo: 'factory-skills',
    state: 'CLOSED',
    stateReason: 'COMPLETED',
    title,
    url: `https://github.com/geut/factory-skills/issues/${number}`,
    ...overrides,
  };
}

function repository(limits: Record<string, number> = {}): string {
  const codeRoot = mkdtempSync(path.join(tmpdir(), 'factory-links-'));
  roots.push(codeRoot);
  initRepo(codeRoot);
  mkdirSync(path.join(codeRoot, '.factory'));
  writeFileSync(
    path.join(codeRoot, '.factory', 'FACTORY.json'),
    JSON.stringify({
      limits,
      models: { review: 'review-model', work: 'work-model' },
      tracker: { kind: 'github', owner: 'geut', repo: 'factory-skills' },
    }),
  );
  const pi = path.join(codeRoot, 'pi');
  writeFileSync(pi, '#!/bin/sh\n');
  chmodSync(pi, 0o755);
  return codeRoot;
}

async function serveFor(input: {
  codeRoot: string;
  github: GithubClient;
  log: Array<string>;
  runtime: FakeRuntime;
}): Promise<{ server: RunningServer; token: string }> {
  const result = await serve({
    cwd: input.codeRoot,
    env: {
      FACTORY_PI_BIN: path.join(input.codeRoot, 'pi'),
      HERDR_PANE_ID: 'pane-1',
      HERDR_SOCKET_PATH: '/tmp/herdr.sock',
    },
    github: input.github,
    linksRetryDelaysMs: [1, 1, 1],
    out: (line) => input.log.push(line),
    port: 0,
    releases: async () => [],
    runtime: () => input.runtime,
  });
  if (result.kind !== 'ok') {
    throw new Error(result.message);
  }
  servers.push(result.server);
  const token = readFileSync(path.join(input.codeRoot, '.factory', 'local.token'), 'utf8').trim();
  return { server: result.server, token };
}

async function post(server: RunningServer, token: string, ref: string): Promise<void> {
  const response = await fetch(`${server.url}/v1/tickets`, {
    body: JSON.stringify({ ref }),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    method: 'POST',
  });
  assert.equal(response.status, 202);
}

async function startTicket(input: {
  codeRoot: string;
  github: GithubClient;
  log: Array<string>;
  runtime: FakeRuntime;
}): Promise<void> {
  const { server, token } = await serveFor(input);
  await post(server, token, 'geut/factory-skills#7');
}

async function until(check: () => boolean, tries = 300): Promise<void> {
  for (let left = tries; left > 0 && !check(); left -= 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(check(), 'timed out');
}

test('the plan prompt lists the linked issues, read once, and a correction does not read them again', async () => {
  let reads = 0;
  const runtime = new FakeRuntime();
  await startTicket({
    codeRoot: repository(),
    github: {
      fetchIssue: () => issue,
      issueLinks: () => {
        reads += 1;
        return {
          blockedBy: [],
          blocking: [],
          parent: linked(3, 'Filters everywhere', { state: 'OPEN', stateReason: null }),
          subIssues: [linked(8, 'Persist the sort too', { state: 'OPEN', stateReason: null })],
        };
      },
      listSubIssues: () => [],
      lookupRef: (at) =>
        at.number === 5
          ? linked(5, 'Remember the search', {
              pullRequests: ['https://github.com/geut/factory-skills/pull/6'],
            })
          : null,
    },
    log: [],
    runtime,
  });
  await until(() => runtime.launches.length === 1);
  const prompt = runtime.launches[0]?.prompt ?? '';
  assert.ok(
    prompt.endsWith(
      [
        'Same fix shape as #5.',
        '',
        'Linked issues (one level; read one with the project’s tools when it matters):',
        '- parent geut/factory-skills#3 [open] Filters everywhere',
        '- sub-issue geut/factory-skills#8 [open] Persist the sort too',
        '- mentioned geut/factory-skills#5 [closed] Remember the search · PR https://github.com/geut/factory-skills/pull/6',
      ].join('\n'),
    ),
    prompt,
  );

  // A plan that fails validation is corrected in the same session.
  const runId = runtime.launches[0]?.runId;
  if (runId === undefined) {
    throw new Error('missing plan run');
  }
  runtime.emit(runId, { kind: 'subagent_done', output: 'not a plan', usage: sampleUsage() });
  await until(() => runtime.launches.length === 2);
  assert.doesNotMatch(runtime.launches[1]?.prompt ?? '', /Linked issues/);
  assert.equal(reads, 1);
});

test('a tracker that fails to read the links is logged, and the plan still starts', async () => {
  const runtime = new FakeRuntime();
  const log: Array<string> = [];
  await startTicket({
    codeRoot: repository(),
    github: {
      fetchIssue: () => issue,
      issueLinks: () => {
        throw new Error('gh: HTTP 502');
      },
      listSubIssues: () => [],
    },
    log,
    runtime,
  });
  await until(() => runtime.launches.length === 1);
  assert.match(runtime.launches[0]?.prompt ?? '', /Linked issues: the tracker could not be read/);
  assert.ok(
    log.includes(
      'Could not read the linked issues of geut/factory-skills#7 after 4 attempts; planning without them: gh: HTTP 502',
    ),
    log.join('\n'),
  );
});

test('limits.linkedIssues of 0 reads no links, and the prompt is as before', async () => {
  const runtime = new FakeRuntime();
  let reads = 0;
  await startTicket({
    codeRoot: repository({ linkedIssues: 0 }),
    github: {
      fetchIssue: () => issue,
      issueLinks: () => {
        reads += 1;
        return { blockedBy: [], blocking: [], parent: null, subIssues: [] };
      },
      listSubIssues: () => [],
    },
    log: [],
    runtime,
  });
  await until(() => runtime.launches.length === 1);
  assert.ok((runtime.launches[0]?.prompt ?? '').endsWith('Same fix shape as #5.'));
  assert.equal(reads, 0);
});

test('a slow links read holds up only its own ticket: another ticket plans meanwhile', async () => {
  const runtime = new FakeRuntime();
  const slow = Promise.withResolvers<void>();
  const { server, token } = await serveFor({
    codeRoot: repository(),
    github: {
      fetchIssue: (at) => ({
        ...issue,
        nodeId: `I_${at.number}`,
        number: at.number,
        title: `Issue ${at.number}`,
        url: `https://github.com/geut/factory-skills/issues/${at.number}`,
      }),
      issueLinks: async (at) => {
        if (at.number === 7) {
          await slow.promise;
        }
        return { blockedBy: [], blocking: [], parent: null, subIssues: [] };
      },
      listSubIssues: () => [],
    },
    log: [],
    runtime,
  });
  await post(server, token, 'geut/factory-skills#7');
  await post(server, token, 'geut/factory-skills#8');
  await until(() => runtime.launches.length === 1);
  assert.match(runtime.launches[0]?.prompt ?? '', /Ticket: geut\/factory-skills#8/);
  slow.resolve();
  await until(() => runtime.launches.length === 2);
  assert.match(runtime.launches[1]?.prompt ?? '', /Ticket: geut\/factory-skills#7/);
});

test('a server stopped while reading the links prepares the worktree again on restart', async () => {
  const codeRoot = repository();
  const stuck = new FakeRuntime();
  const { server, token } = await serveFor({
    codeRoot,
    github: {
      fetchIssue: () => issue,
      // Never answers.
      issueLinks: () => new Promise(() => undefined),
      listSubIssues: () => [],
    },
    log: [],
    runtime: stuck,
  });
  await post(server, token, 'geut/factory-skills#7');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(stuck.launches.length, 0);
  await servers.pop()?.close();

  const runtime = new FakeRuntime();
  await serveFor({
    codeRoot,
    github: {
      fetchIssue: () => issue,
      issueLinks: () => ({
        blockedBy: [],
        blocking: [],
        parent: linked(3, 'Filters everywhere', { state: 'OPEN', stateReason: null }),
        subIssues: [],
      }),
      listSubIssues: () => [],
    },
    log: [],
    runtime,
  });
  await until(() => runtime.launches.length === 1);
  assert.match(runtime.launches[0]?.prompt ?? '', /- parent geut\/factory-skills#3 \[open\]/);
});
