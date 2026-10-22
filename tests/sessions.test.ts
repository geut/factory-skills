import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import type { GithubIssue } from '../src/ports/github.ts';
import { FakeRuntime } from '../src/runtime/fake.ts';
import { type RunningServer, serve } from '../src/server/serve.ts';
import { runSessionsCommand } from '../src/server/sessions-cli.ts';
import { initRepo } from './git-repo.ts';

// Finding a stage's session: the file is named for its ticket and stage, the
// API returns it on each run, and `factory sessions` lists it.

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
  body: '',
  host: 'github.com',
  labels: [],
  nodeId: 'I_7',
  number: 7,
  owner: 'geut',
  repo: 'factory-skills',
  title: 'Remember the filter',
  url: 'https://github.com/geut/factory-skills/issues/7',
};

function sessionsCli(cwd: string, ...args: Array<string>) {
  const out: Array<string> = [];
  const err: Array<string> = [];
  const code = runSessionsCommand(args, cwd, {
    err: (line) => err.push(line),
    out: (line) => out.push(line),
  });
  return { code, err: err.join('\n'), out: out.join('\n') };
}

test('a session is named for its ticket and stage, and the API and CLI point at it', async () => {
  const codeRoot = mkdtempSync(path.join(tmpdir(), 'factory-sessions-'));
  roots.push(codeRoot);
  initRepo(codeRoot);
  mkdirSync(path.join(codeRoot, '.factory'));
  writeFileSync(
    path.join(codeRoot, '.factory', 'FACTORY.json'),
    JSON.stringify({
      models: { review: 'review-model', work: 'work-model' },
      tracker: { kind: 'github', owner: 'geut', repo: 'factory-skills' },
    }),
  );
  const pi = path.join(codeRoot, 'pi');
  writeFileSync(pi, '#!/bin/sh\n');
  chmodSync(pi, 0o755);
  assert.match(sessionsCli(codeRoot).err, /No tickets yet/);

  const runtime = new FakeRuntime();
  const result = await serve({
    cwd: codeRoot,
    env: { FACTORY_PI_BIN: pi, HERDR_PANE_ID: 'pane-1', HERDR_SOCKET_PATH: '/tmp/herdr.sock' },
    github: { fetchIssue: () => issue, listSubIssues: () => [] },
    out: () => undefined,
    port: 0,
    runtime: () => runtime,
  });
  if (result.kind !== 'ok') {
    throw new Error(result.message);
  }
  servers.push(result.server);
  const token = readFileSync(path.join(codeRoot, '.factory', 'local.token'), 'utf8').trim();
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const started = await fetch(`${result.server.url}/v1/tickets`, {
    body: JSON.stringify({ ref: 'geut/factory-skills#7' }),
    headers,
    method: 'POST',
  });
  const { ticket } = (await started.json()) as { ticket: string };
  for (let tries = 300; tries > 0 && runtime.launches.length === 0; tries -= 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const sessionFile = runtime.launches[0]?.sessionFile ?? '';
  assert.equal(
    path.relative(codeRoot, path.dirname(sessionFile)),
    path.join('.factory', 'sessions', ticket),
  );
  assert.match(path.basename(sessionFile), /^plan-[0-9a-f-]{36}\.jsonl$/);

  const runs = (await (
    await fetch(`${result.server.url}/v1/tickets/${ticket}/runs`, { headers })
  ).json()) as { items: Array<{ sessionFile: string | null }> };
  assert.equal(runs.items[0]?.sessionFile, sessionFile);

  const listed = sessionsCli(codeRoot, 'geut/factory-skills#7');
  assert.equal(listed.code, 0, listed.err);
  assert.match(listed.out, new RegExp(`^geut/factory-skills#7  \\(${ticket}\\)`));
  assert.ok(
    listed.out.includes(`plan  running  ${path.relative(codeRoot, sessionFile)}`),
    listed.out,
  );
  assert.equal(sessionsCli(codeRoot, ticket).out, listed.out);
  assert.equal(sessionsCli(codeRoot).out, listed.out);
  assert.equal(sessionsCli(codeRoot, 'nope#1').code, 1);
});
