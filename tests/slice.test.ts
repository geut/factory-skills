import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { createFactoryService } from '../src/controller/service.ts';
import { applyControllerEvent } from '../src/controller/store.ts';
import { randomIds, ticketId, type Policy, type ResolvedTicket } from '../src/domain.ts';
import { sha256 } from '../src/hash.ts';
import { FakeRuntime, sampleUsage } from '../src/runtime/fake.ts';
import { openStateDatabase } from '../src/state/database.ts';
import type { GithubClient } from '../src/tickets.ts';

const roots: Array<string> = [];
const scratch = path.join(process.cwd(), '.scratch');
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_EMAIL: 'factory@example.com',
  GIT_AUTHOR_NAME: 'Factory',
  GIT_COMMITTER_EMAIL: 'factory@example.com',
  GIT_COMMITTER_NAME: 'Factory',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'commit.gpgsign',
  GIT_CONFIG_VALUE_0: 'false',
};

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) {
      rmSync(root, { force: true, recursive: true });
    }
  }
});

function git(cwd: string, args: Array<string>): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
}

function repo(withGit = false): { codeRoot: string; factoryRoot: string } {
  mkdirSync(scratch, { recursive: true });
  const codeRoot = mkdtempSync(path.join(scratch, 'factory-slice-'));
  roots.push(codeRoot);
  if (withGit) {
    git(codeRoot, ['init', '-b', 'main']);
    writeFileSync(path.join(codeRoot, 'README.md'), '# demo\n');
    git(codeRoot, ['add', 'README.md']);
    git(codeRoot, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'init']);
  }
  const factoryRoot = path.join(codeRoot, '.factory');
  mkdirSync(factoryRoot, { recursive: true });
  writeFileSync(
    path.join(factoryRoot, 'FACTORY.json'),
    `${JSON.stringify({
      github: { owner: 'geut', repo: 'factory-skills' },
      keys: { PROJ: { provider: 'github' } },
      models: { review: 'review-model', work: 'work-model' },
    })}\n`,
  );
  return { codeRoot, factoryRoot };
}

function writePlanFiles(factoryDir: string, taskFile: string): void {
  writeFileSync(
    path.join(factoryDir, 'plan.md'),
    '# Remember the filter\n\n## Outcome\nThe catalog keeps its filter.\n',
  );
  writeFileSync(
    path.join(factoryDir, taskFile),
    `# Store the filter

Status: pending
Type: feature
Blocked by: none

## Acceptance criteria
- [ ] The filter survives a reload.
`,
  );
}

function ticketDir(factoryRoot: string): string {
  const tickets = path.join(factoryRoot, 'tickets');
  const [dir] = readdirSync(tickets);
  if (dir === undefined) {
    throw new Error('missing ticket directory');
  }
  return path.join(tickets, dir);
}

const github: GithubClient = {
  fetchIssue: () => {
    throw new Error('github unused');
  },
  listSubIssues: () => [],
};

test('start is idempotent and invalid planning resumes the same session', async () => {
  const { codeRoot, factoryRoot } = repo();
  writeFileSync(
    path.join(codeRoot, 'proj-123.md'),
    '# Remember the filter\n\nKeep the catalog filter.\n',
  );
  const runtime = new FakeRuntime();
  const service = createFactoryService({
    codeRoot,
    factoryRoot,
    github,
    ids: randomIds(),
    runtime,
  });
  const started = await service.command('start proj-123.md');
  assert.match(started, /stage: plan/);
  assert.equal(runtime.launches.length, 1);
  assert.equal(runtime.launches[0]?.stage, 'plan');
  const repeated = await service.command('start proj-123.md');
  assert.match(repeated, /did not launch another child/);
  assert.equal(runtime.launches.length, 1);

  const runId = runtime.launches[0]?.runId;
  if (runId === undefined) {
    throw new Error('missing plan run');
  }
  runtime.emit(runId, { kind: 'subagent_done', output: 'not a plan', usage: sampleUsage() });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.launches.length, 2);
  assert.match(runtime.launches[1]?.prompt ?? '', /factory.plan.v3/);
  runtime.emit(runId, {
    kind: 'subagent_done',
    output: 'not a plan again',
    usage: sampleUsage(20),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.launches.length, 2);
  const status = service.status('proj-123');
  assert.match(status, /stage: plan/);
  assert.doesNotMatch(status, /stage: work/);
});

test('a valid plan registers tasks and launches the first work agent', async () => {
  const { codeRoot, factoryRoot } = repo(true);
  writeFileSync(path.join(codeRoot, 'proj-123.md'), '# Remember the filter\n');
  const runtime = new FakeRuntime();
  const service = createFactoryService({ codeRoot, factoryRoot, github, runtime });
  await service.command('start proj-123.md');
  const taskFile = '01-task-store-filter.md';
  const directory = ticketDir(factoryRoot);
  writePlanFiles(directory, taskFile);
  const planRun = runtime.launches[0]?.runId;
  if (planRun === undefined) {
    throw new Error('missing plan run');
  }
  runtime.emit(planRun, {
    kind: 'subagent_done',
    output: 'Plan files are written.',
    usage: sampleUsage(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  const work = runtime.launches.find((launch) => launch.stage === 'work');
  assert.ok(work, 'expected a work launch');
  assert.match(service.status('proj-123'), /stage: work/);
  assert.equal(work.cwd.includes(`${path.sep}worktrees${path.sep}`), true);
});

test('caller_ping is durable and reply resumes that session', async () => {
  const { codeRoot, factoryRoot } = repo();
  writeFileSync(path.join(codeRoot, 'proj-123.md'), '# Remember the filter\n');
  const runtime = new FakeRuntime();
  const notified: Array<string> = [];
  const service = createFactoryService({
    codeRoot,
    factoryRoot,
    github,
    notify: (message) => {
      notified.push(message);
    },
    runtime,
  });
  await service.command('start proj-123.md');
  const planRun = runtime.launches[0]?.runId;
  if (planRun === undefined) {
    throw new Error('missing plan run');
  }
  runtime.emit(planRun, {
    kind: 'caller_ping',
    question: 'Which API should the filter use?',
    usage: sampleUsage(),
  });
  await new Promise((resolve) => setImmediate(resolve));
  const waiting = service.status('proj-123');
  assert.match(waiting, /waiting_for_user/);
  assert.match(waiting, /Which API should the filter use\?/);
  assert.equal(notified[0], 'Which API should the filter use?');
  const illegal = await service.command('reply proj-123 "Use the existing API"');
  assert.match(illegal, /Resuming the session|stage:/);
  assert.equal(runtime.launches.at(-1)?.mode, 'resume');
  assert.match(runtime.launches.at(-1)?.prompt ?? '', /Use the existing API/);
});

test('three failed plan corrections pause instead of launching again', async () => {
  const { codeRoot, factoryRoot } = repo();
  writeFileSync(path.join(codeRoot, 'proj-123.md'), '# Remember the filter\n');
  const runtime = new FakeRuntime();
  const service = createFactoryService({ codeRoot, factoryRoot, github, runtime });
  await service.command('start proj-123.md');
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const runId = runtime.launches.at(-1)?.runId;
    if (runId === undefined) {
      throw new Error('missing plan run');
    }
    runtime.emit(runId, { kind: 'subagent_done', output: 'not a plan', usage: sampleUsage() });
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(runtime.launches.length, 4);
  assert.match(service.status('proj-123'), /paused/);
});

test('reply is rejected while planning is still active', async () => {
  const { codeRoot, factoryRoot } = repo();
  writeFileSync(path.join(codeRoot, 'proj-123.md'), '# Remember the filter\n');
  const runtime = new FakeRuntime();
  const service = createFactoryService({ codeRoot, factoryRoot, github, runtime });
  await service.command('start proj-123.md');
  const rejected = await service.command('reply proj-123 "too soon"');
  assert.match(rejected, /not waiting for a reply/);
  assert.equal(runtime.launches.length, 1);
});

test('restart dispatches a reserved launch once and does not relaunch a running child', async () => {
  const { codeRoot, factoryRoot } = repo();
  const db = openStateDatabase(factoryRoot, { create: true });
  const canonical = ticketId(`local:slice:proj-123`);
  const factoryDir = path.join(factoryRoot, 'tickets', `proj-123-${sha256(canonical).slice(0, 8)}`);
  const ticket: ResolvedTicket = {
    body: 'Keep the filter.',
    commandRef: 'proj-123',
    contentHash: sha256('Keep the filter.'),
    displayRef: 'proj-123',
    factoryDir,
    fetchedAt: '2026-10-06T00:00:00.000Z',
    id: canonical,
    sourceKind: 'text',
    sourceRef: 'text:proj-123',
    title: 'Remember the filter',
  };
  const policy: Policy = {
    codeRoot,
    limits: { infrastructureRetries: 3, planCorrections: 3 },
    models: { plan: 'work-model', review: 'review-model', work: 'work-model' },
  };
  applyControllerEvent(db, {
    dedupeKey: `command:start:${canonical}`,
    event: { kind: 'start', policy, ticket },
    ids: randomIds(),
    now: '2026-10-06T00:00:00.000Z',
    source: 'command',
  });
  const runtime = new FakeRuntime();
  const service = createFactoryService({ codeRoot, db, factoryRoot, github, runtime });
  await service.recover();
  assert.equal(runtime.launches.length, 1);
  await service.recover();
  assert.equal(runtime.launches.length, 1);

  const other = new FakeRuntime();
  const restarted = createFactoryService({ codeRoot, db, factoryRoot, github, runtime: other });
  await restarted.recover();
  assert.equal(other.launches.length, 0);
  db.close();
});

test('launch failures stay retryable without consuming plan corrections', async () => {
  const { codeRoot, factoryRoot } = repo();
  writeFileSync(path.join(codeRoot, 'proj-123.md'), '# Remember the filter\n');
  const runtime = new FakeRuntime();
  runtime.failuresRemaining = 4;
  const service = createFactoryService({ codeRoot, factoryRoot, github, runtime });
  const text = await service.command('start proj-123.md');
  assert.match(text, /failed/);
  assert.match(text, /\/factory retry/);
  assert.equal(runtime.launches.length, 0);
});

test('github umbrella issues do not create an execution', async () => {
  const { codeRoot, factoryRoot } = repo();
  const runtime = new FakeRuntime();
  const umbrella: GithubClient = {
    fetchIssue: () => ({
      body: 'Coordinate the slices.',
      host: 'github.com',
      nodeId: 'I_parent',
      number: 6,
      owner: 'geut',
      repo: 'factory-skills',
      title: 'Parent',
      url: 'https://github.com/geut/factory-skills/issues/6',
    }),
    listSubIssues: () => [{ body: '', number: 7, title: 'Concrete slice', url: null }],
  };
  const service = createFactoryService({ codeRoot, factoryRoot, github: umbrella, runtime });
  const text = await service.command('start PROJ-6');
  assert.match(text, /umbrella/);
  assert.equal(runtime.launches.length, 0);
});
