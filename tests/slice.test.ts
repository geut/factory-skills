import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { createRouter } from '../src/api/router.ts';
import { apiRoutes } from '../src/api/routes.ts';
import { unusedCommands } from '../src/api/testing.ts';
import { DEFAULT_LIMITS } from '../src/config.ts';
import { createFactoryService } from '../src/controller/service.ts';
import { applyControllerEvent } from '../src/controller/store.ts';
import { usageRows } from '../src/controller/usage.ts';
import {
  executionId,
  randomIds,
  ticketId,
  type Policy,
  type ResolvedTicket,
  type RunId,
} from '../src/domain.ts';
import { sha256 } from '../src/hash.ts';
import type { CodeHost, PullRequestInfo, PullRequestOutcome } from '../src/ports/code-host.ts';
import type { GithubClient } from '../src/ports/github.ts';
import { FakeRuntime, sampleUsage } from '../src/runtime/fake.ts';
import { openStateDatabase } from '../src/state/database.ts';
import { runFacts, ticketFacts } from '../src/stats/facts.ts';
import { stageMeasures, summarize } from '../src/stats/measures.ts';

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
      codeHost: { kind: 'github', owner: 'geut', pullRequests: false, repo: 'factory-skills' },
      models: { review: 'review-model', work: 'work-model' },
      tracker: { kind: 'github', owner: 'geut', repo: 'factory-skills' },
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
  assert.match(started, /Started proj-123\./);
  assert.doesNotMatch(started, /queued/);
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
  assert.match(notified[0] ?? '', /status: waiting for you\n/);
  assert.match(notified[0] ?? '', /next: \/factory reply proj-123\.md "answer"\n/);
  assert.match(notified[0] ?? '', /Which API should the filter use\?$/);
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
    labels: [],
    sourceKind: 'text',
    sourceRef: 'text:proj-123',
    title: 'Remember the filter',
  };
  const policy: Policy = {
    codeRoot,
    labels: { map: {} },
    limits: { ...DEFAULT_LIMITS },
    models: { plan: 'work-model', review: 'review-model', work: 'work-model' },
    pullRequests: false,
    stages: {},
    validation: { work: { commands: [] }, wrapup: { generated: [] } },
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
      labels: [],
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
  const text = await service.command('start #6');
  assert.match(text, /umbrella/);
  assert.equal(runtime.launches.length, 0);
});

async function waitFor(ready: () => boolean): Promise<void> {
  const started = Date.now();
  while (!ready()) {
    if (Date.now() - started > 8000) {
      throw new Error('timed out waiting for factory state');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function reachWork(): Promise<{
  factoryRoot: string;
  runtime: FakeRuntime;
  service: ReturnType<typeof createFactoryService>;
  workCwd: string;
  workRunId: RunId;
}> {
  const { codeRoot, factoryRoot } = repo(true);
  writeFileSync(path.join(codeRoot, 'proj-123.md'), '# Remember the filter\n');
  const runtime = new FakeRuntime();
  const service = createFactoryService({ codeRoot, factoryRoot, github, runtime });
  await service.command('start proj-123.md');
  writePlanFiles(ticketDir(factoryRoot), '01-task-store-filter.md');
  const planRun = runtime.launches[0]?.runId;
  if (planRun === undefined) {
    throw new Error('missing plan run');
  }
  runtime.emit(planRun, {
    kind: 'subagent_done',
    output: 'files written',
    usage: sampleUsage(),
  });
  await waitFor(
    () =>
      runtime.launches.some((launch) => launch.stage === 'work') &&
      service.status('proj-123').includes('Launched'),
  );
  const work = runtime.launches.find((launch) => launch.stage === 'work');
  if (work === undefined) {
    throw new Error('missing work run');
  }
  return { factoryRoot, runtime, service, workCwd: work.cwd, workRunId: work.runId };
}

test('passing work validation launches one read-only reviewer', async () => {
  const { runtime, service, workCwd, workRunId } = await reachWork();
  writeFileSync(path.join(workCwd, 'change.txt'), 'changed\n');
  runtime.emit(workRunId, {
    kind: 'subagent_done',
    output: 'not a template',
    usage: sampleUsage(),
  });
  runtime.emit(workRunId, {
    kind: 'subagent_done',
    output: 'duplicate',
    usage: sampleUsage(),
  });
  await waitFor(() => runtime.launches.some((launch) => launch.stage === 'review'));
  const reviews = runtime.launches.filter((launch) => launch.stage === 'review');
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0]?.model, 'review-model');
  assert.doesNotMatch(reviews[0]?.tools ?? '', /edit|write|bash/);
  assert.match(reviews[0]?.prompt ?? '', /changed/);
  assert.match(reviews[0]?.prompt ?? '', /not a template/);
  assert.match(service.status('proj-123'), /stage: review/);
});

test('failed work validation resumes the same session and the limit pauses', async () => {
  const { codeRoot, factoryRoot } = repo(true);
  writeFileSync(
    path.join(factoryRoot, 'FACTORY.json'),
    `${JSON.stringify({
      limits: { workCorrections: 1 },
      models: { review: 'review-model', work: 'work-model' },
    })}\n`,
  );
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
  writePlanFiles(ticketDir(factoryRoot), '01-task-store-filter.md');
  const planRun = runtime.launches[0]?.runId;
  if (planRun === undefined) {
    throw new Error('missing plan run');
  }
  runtime.emit(planRun, { kind: 'subagent_done', output: 'files', usage: sampleUsage() });
  await waitFor(
    () =>
      runtime.launches.some((launch) => launch.stage === 'work') &&
      service.status('proj-123').includes('Launched'),
  );
  const first = runtime.launches.find((launch) => launch.stage === 'work');
  if (first === undefined) {
    throw new Error('missing work run');
  }
  runtime.emit(first.runId, { kind: 'subagent_done', output: 'no diff', usage: sampleUsage() });
  await waitFor(() => runtime.launches.filter((launch) => launch.stage === 'work').length === 2);
  const correction = runtime.launches.filter((launch) => launch.stage === 'work')[1];
  assert.match(correction?.prompt ?? '', /diff is empty/);
  assert.equal(correction?.cwd, first.cwd);
  runtime.emit(correction?.runId ?? first.runId, {
    kind: 'subagent_done',
    output: 'still empty',
    usage: sampleUsage(),
  });
  await waitFor(() => service.status('proj-123').includes('paused'));
  await waitFor(() => notified.some((message) => message.includes('status: correction · paused')));
  assert.ok(
    notified.some(
      (message) =>
        message.includes('stage: plan') &&
        message.includes('status: planned') &&
        message.includes('item: 01 '),
    ),
  );
  assert.ok(
    notified.some(
      (message) =>
        message.includes('stage: work') &&
        message.includes('\nstatus: correcting') &&
        message.includes('\ntask: 01/01 '),
    ),
  );
  assert.equal(
    notified.some((message) => message.includes('status: active')),
    false,
  );
  assert.equal(runtime.launches.filter((launch) => launch.stage === 'review').length, 0);
  assert.equal(runtime.launches.filter((launch) => launch.stage === 'work').length, 2);
});

test('at the work correction limit a reply resumes the worker with the answer', async () => {
  const { codeRoot, factoryRoot } = repo(true);
  writeFileSync(
    path.join(factoryRoot, 'FACTORY.json'),
    `${JSON.stringify({
      limits: { workCorrections: 0 },
      models: { review: 'review-model', work: 'work-model' },
    })}\n`,
  );
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
  writePlanFiles(ticketDir(factoryRoot), '01-task-store-filter.md');
  const planRun = runtime.launches[0]?.runId;
  if (planRun === undefined) {
    throw new Error('missing plan run');
  }
  runtime.emit(planRun, { kind: 'subagent_done', output: 'files', usage: sampleUsage() });
  await waitFor(() => runtime.launches.some((launch) => launch.stage === 'work'));
  const first = runtime.launches.find((launch) => launch.stage === 'work');
  if (first === undefined) {
    throw new Error('missing work run');
  }
  runtime.emit(first.runId, { kind: 'subagent_done', output: 'no diff', usage: sampleUsage() });
  await waitFor(() => service.status('proj-123').includes('paused'));
  // The notice names the worker's run, so the hint offers a reply.
  await waitFor(() => notified.some((message) => message.includes('Reply to resume the agent')));
  assert.ok(notified.some((message) => message.includes('next: /factory reply proj-123.md')));
  await service.command('reply proj-123 "Commit nothing; write the filter in src/store.ts"');
  await waitFor(
    () =>
      runtime.launches.filter((launch) => launch.stage === 'work' && launch.mode === 'resume')
        .length === 1,
  );
  const resumed = runtime.launches.filter((launch) => launch.stage === 'work').at(-1);
  assert.match(resumed?.prompt ?? '', /The user answered:\nCommit nothing/);
  assert.equal(resumed?.cwd, first.cwd);
});

test('work caller_ping resumes that work session and a failed resume keeps the answer', async () => {
  const { runtime, service, workCwd, workRunId } = await reachWork();
  runtime.emit(workRunId, {
    kind: 'caller_ping',
    question: 'Which filter store?',
    usage: sampleUsage(),
  });
  await waitFor(() => service.status('proj-123').includes('waiting_for_user'));
  runtime.failuresRemaining = 4;
  await service.command('reply proj-123 "Use the catalog store"');
  await waitFor(() => service.status('proj-123').includes('resume_failed'));
  runtime.failuresRemaining = 0;
  await service.command('retry proj-123');
  await waitFor(() =>
    runtime.launches.some((launch) => launch.stage === 'work' && launch.mode === 'resume'),
  );
  const resumed = runtime.launches.filter(
    (launch) => launch.stage === 'work' && launch.prompt.includes('Use the catalog store'),
  );
  assert.ok(resumed.length > 0);
  assert.equal(resumed.at(-1)?.cwd, workCwd);
  assert.match(resumed.at(-1)?.prompt ?? '', /factory-work/);
});

test('restart validates a finished worker once and reconciles one reviewer', async () => {
  const { codeRoot, factoryRoot } = repo(true);
  const db = openStateDatabase(factoryRoot, { create: true });
  writeFileSync(path.join(codeRoot, 'proj-123.md'), '# Remember the filter\n');
  const runtime = new FakeRuntime();
  const service = createFactoryService({ codeRoot, db, factoryRoot, github, runtime });
  await service.command('start proj-123.md');
  writePlanFiles(ticketDir(factoryRoot), '01-task-store-filter.md');
  const planRun = runtime.launches[0]?.runId;
  if (planRun === undefined) {
    throw new Error('missing plan run');
  }
  runtime.emit(planRun, { kind: 'subagent_done', output: 'files', usage: sampleUsage() });
  await waitFor(
    () =>
      runtime.launches.some((launch) => launch.stage === 'work') &&
      service.status('proj-123').includes('Launched'),
  );
  const work = runtime.launches.find((launch) => launch.stage === 'work');
  if (work === undefined) {
    throw new Error('missing work run');
  }
  writeFileSync(path.join(work.cwd, 'change.txt'), 'changed\n');
  applyControllerEvent(db, {
    dedupeKey: `runtime:${work.runId}:terminal`,
    event: {
      kind: 'runtime_terminal',
      runId: work.runId,
      terminal: { kind: 'subagent_done', output: 'done', usage: sampleUsage() },
    },
    ids: randomIds(),
    now: '2026-10-07T00:00:00.000Z',
    source: 'runtime',
  });
  applyControllerEvent(db, {
    dedupeKey: `runtime:${work.runId}:terminal`,
    event: {
      kind: 'runtime_terminal',
      runId: work.runId,
      terminal: { kind: 'subagent_done', output: 'again', usage: sampleUsage() },
    },
    ids: randomIds(),
    now: '2026-10-07T00:00:01.000Z',
    source: 'runtime',
  });
  await service.recover();
  await waitFor(
    () =>
      runtime.launches.some((launch) => launch.stage === 'review') &&
      service.status('proj-123').includes('Launched'),
  );
  assert.equal(runtime.launches.filter((launch) => launch.stage === 'review').length, 1);
  await service.recover();
  assert.equal(runtime.launches.filter((launch) => launch.stage === 'review').length, 1);
  db.close();
});

test('two tickets can validate at the same time', async () => {
  const { codeRoot, factoryRoot } = repo(true);
  writeFileSync(
    path.join(factoryRoot, 'FACTORY.json'),
    `${JSON.stringify({
      models: { review: 'review-model', work: 'work-model' },
      validation: {
        work: { commands: [{ argv: ['sleep', '2'], name: 'pause', timeoutMs: 10_000 }] },
      },
    })}\n`,
  );
  writeFileSync(path.join(codeRoot, 'proj-123.md'), '# Remember the filter\n');
  writeFileSync(path.join(codeRoot, 'proj-456.md'), '# Remember the sort\n');
  const runtime = new FakeRuntime();
  const service = createFactoryService({ codeRoot, factoryRoot, github, runtime });
  await service.command('start proj-123.md');
  await service.command('start proj-456.md');
  const directories = readdirSync(path.join(factoryRoot, 'tickets'));
  for (const directory of directories) {
    writePlanFiles(path.join(factoryRoot, 'tickets', directory), '01-task-store-filter.md');
  }
  for (const launch of runtime.launches.filter((item) => item.stage === 'plan')) {
    runtime.emit(launch.runId, { kind: 'subagent_done', output: 'files', usage: sampleUsage() });
  }
  await waitFor(
    () =>
      runtime.launches.filter((launch) => launch.stage === 'work').length === 2 &&
      service.status('proj-123').includes('Launched') &&
      service.status('proj-456').includes('Launched'),
  );
  for (const launch of runtime.launches.filter((item) => item.stage === 'work')) {
    writeFileSync(path.join(launch.cwd, 'change.txt'), 'changed\n');
    runtime.emit(launch.runId, { kind: 'subagent_done', output: 'done', usage: sampleUsage() });
  }
  const started = Date.now();
  await waitFor(() => runtime.launches.filter((launch) => launch.stage === 'review').length === 2);
  assert.ok(Date.now() - started < 3500);
});

const blockingFinding = `### 1. [Major] Filter resets on reload

**Location:** src/filter.ts:10
**Finding:** The filter is never stored.
**Evidence:** No storage call exists on the change path.
**Suggestion:** Persist the filter before navigation.`;

const minorFinding = `### 2. [Minor] Unclear name

**Location:** src/filter.ts:4
**Finding:** The variable f hides what it holds.
**Evidence:** It is read in three places.`;

function reviewOutput(verdict: string, findings = 'none', summary = 'Checked the diff.'): string {
  return `## Verdict\n\n${verdict}\n\n## Summary\n\n${summary}\n\n## Findings\n\n${findings}\n`;
}

type ReviewHarness = {
  db: ReturnType<typeof openStateDatabase>;
  notified: Array<string>;
  review: FakeRuntime['launches'][number];
  runtime: FakeRuntime;
  service: ReturnType<typeof createFactoryService>;
  work: FakeRuntime['launches'][number];
};

async function reachReview(
  config: Record<string, unknown> = {},
  taskCount = 1,
  codeHost?: () => CodeHost,
): Promise<ReviewHarness> {
  const { codeRoot, factoryRoot } = repo(true);
  writeFileSync(
    path.join(factoryRoot, 'FACTORY.json'),
    `${JSON.stringify({ models: { review: 'review-model', work: 'work-model' }, ...config })}\n`,
  );
  writeFileSync(path.join(codeRoot, 'proj-123.md'), '# Remember the filter\n');
  const db = openStateDatabase(factoryRoot, { create: true });
  const runtime = new FakeRuntime();
  const notified: Array<string> = [];
  const service = createFactoryService({
    ...(codeHost === undefined ? {} : { codeHost }),
    codeRoot,
    db,
    factoryRoot,
    github,
    notify: (message) => {
      notified.push(message);
    },
    runtime,
  });
  await service.command('start proj-123.md');
  const directory = ticketDir(factoryRoot);
  writePlanFiles(directory, '01-task-store-filter.md');
  if (taskCount > 1) {
    writeFileSync(
      path.join(directory, '02-task-show-filter.md'),
      '# Show the filter\n\nType: feature\nBlocked by: 01\n\n## Acceptance criteria\n- [ ] The filter is visible.\n',
    );
  }
  const planRun = runtime.launches[0]?.runId;
  if (planRun === undefined) {
    throw new Error('missing plan run');
  }
  runtime.emit(planRun, { kind: 'subagent_done', output: 'files', usage: sampleUsage() });
  await waitFor(
    () =>
      runtime.launches.some((launch) => launch.stage === 'work') &&
      service.status('proj-123').includes('Launched'),
  );
  const work = runtime.launches.find((launch) => launch.stage === 'work');
  if (work === undefined) {
    throw new Error('missing work run');
  }
  writeFileSync(path.join(work.cwd, 'change.txt'), 'changed\n');
  runtime.emit(work.runId, { kind: 'subagent_done', output: 'stored it', usage: sampleUsage() });
  await waitFor(
    () =>
      runtime.launches.some((launch) => launch.stage === 'review') &&
      service.status('proj-123').includes('Launched'),
  );
  const review = runtime.launches.find((launch) => launch.stage === 'review');
  if (review === undefined) {
    throw new Error('missing review run');
  }
  return { db, notified, review, runtime, service, work };
}

// The service finishes run cards in the background; close after it settles.
async function closeWhenIdle(db: ReviewHarness['db']): Promise<void> {
  await waitFor(() => {
    const open: unknown = db
      .prepare("SELECT count(*) AS n FROM actions WHERE status IN ('pending', 'leased')")
      .get();
    return typeof open === 'object' && open !== null && 'n' in open && open.n === 0;
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  db.close();
}

function launchesOf(runtime: FakeRuntime, stage: string): FakeRuntime['launches'] {
  return runtime.launches.filter((launch) => launch.stage === stage);
}

function taskRow(db: ReviewHarness['db'], task = '01'): Record<string, unknown> {
  const found: unknown = db
    .prepare(
      // The task as review leaves it: where it stands, and review's summary.
      `SELECT
         CASE WHEN status = 'active' AND stage = 'review' THEN 'reviewing'
              WHEN status = 'active' THEN 'working'
              ELSE status END AS status,
         coalesce(json_extract(summaries_json, '$.review.round'), 0) AS review_round,
         json_extract(summaries_json, '$.review.label') AS review_verdict,
         json_extract(summaries_json, '$.review.counts.findings') AS finding_count,
         json_extract(summaries_json, '$.review.counts.blocking') AS blocking_count
       FROM tasks WHERE task_id = ?`,
    )
    .get(task);
  if (typeof found !== 'object' || found === null) {
    throw new Error(`missing task ${task}`);
  }
  return { ...found };
}

function semanticRounds(db: ReviewHarness['db'], sessionId: string): Array<unknown> {
  return db
    .prepare('SELECT semantic_round FROM agent_runs WHERE session_id = ? ORDER BY sequence')
    .all(sessionId)
    .map((item) => (typeof item === 'object' && item !== null ? item.semantic_round : null));
}

test('an approving review marks the task done and launches one wrap-up run', async () => {
  const { db, review, runtime, service, work } = await reachReview();
  const approval = reviewOutput('approve', minorFinding);
  runtime.emit(review.runId, { kind: 'subagent_done', output: approval, usage: sampleUsage() });
  runtime.emit(review.runId, { kind: 'subagent_done', output: approval, usage: sampleUsage() });
  await waitFor(() => service.status('proj-123').includes('stage: wrapup'));
  await waitFor(() => launchesOf(runtime, 'wrapup').length > 0);
  const wrapups = launchesOf(runtime, 'wrapup');
  assert.equal(wrapups.length, 1);
  assert.equal(wrapups[0]?.model, 'work-model');
  assert.equal(wrapups[0]?.cwd, work.cwd);
  assert.match(wrapups[0]?.prompt ?? '', /factory-wrapup/);
  assert.match(wrapups[0]?.prompt ?? '', /Task 01 R1-2 \[minor\] Unclear name/);
  assert.deepEqual(taskRow(db), {
    blocking_count: 0,
    finding_count: 1,
    review_round: 1,
    review_verdict: 'approve',
    status: 'done',
  });
  const validation: unknown = db
    .prepare('SELECT status, validator_version FROM validation_runs WHERE run_id = ?')
    .get(review.runId);
  assert.deepEqual({ ...(validation ?? {}) }, { status: 'passed', validator_version: 'review.v1' });
  await closeWhenIdle(db);
});

// Each stage once per stretch, in order.
const stagesOf = (steps: Array<string>): Array<string | undefined> =>
  steps.map((step) => step.split('/')[0]).filter((step, index, steps) => step !== steps[index - 1]);

test('changes requested resume the same worker, then round 2 resumes the same reviewer', async () => {
  const { db, review, runtime, service, work } = await reachReview();
  runtime.emit(review.runId, {
    kind: 'subagent_done',
    output: reviewOutput('changes_requested', `${blockingFinding}\n\n${minorFinding}`),
    usage: sampleUsage(),
  });
  await waitFor(() => launchesOf(runtime, 'work').length === 2);
  const fix = launchesOf(runtime, 'work')[1];
  assert.equal(fix?.sessionId, work.sessionId);
  assert.equal(fix?.mode, 'resume');
  assert.equal(fix?.purpose, 'return_to_work');
  assert.equal(fix?.cwd, work.cwd);
  assert.match(fix?.prompt ?? '', /R1-1 \[major\] Filter resets on reload/);
  assert.doesNotMatch(fix?.prompt ?? '', /R1-2/);
  assert.match(service.status('proj-123'), /stage: work/);
  assert.equal(taskRow(db)['review_verdict'], 'changes_requested');
  await waitFor(() => service.status('proj-123').includes('Launched'));

  writeFileSync(path.join(work.cwd, 'change.txt'), 'stored\n');
  runtime.emit(fix?.runId ?? work.runId, {
    kind: 'subagent_done',
    output: 'stored the filter',
    usage: sampleUsage(),
  });
  await waitFor(() => launchesOf(runtime, 'review').length === 2);
  const second = launchesOf(runtime, 'review')[1];
  assert.equal(second?.sessionId, review.sessionId);
  assert.equal(second?.mode, 'resume');
  assert.match(second?.prompt ?? '', /Review round: 2/);
  assert.match(second?.prompt ?? '', /\+stored/);
  await waitFor(() => service.status('proj-123').includes('Launched'));

  runtime.emit(second?.runId ?? review.runId, {
    kind: 'subagent_done',
    output: reviewOutput('approve'),
    usage: sampleUsage(),
  });
  await waitFor(() => launchesOf(runtime, 'wrapup').length === 1);
  assert.equal(taskRow(db)['review_round'], 2);

  // Status history replays the path, including the return to work.
  const history = (task: string | null) =>
    db
      .prepare('SELECT stage, status, ended_at FROM status_history WHERE task_id IS ? ORDER BY id')
      .all(task)
      .map((item) => `${String(item['stage'])}/${String(item['status'])}`)
      .filter((step, index, steps) => step !== steps[index - 1]);
  assert.deepEqual(stagesOf(history(null)), ['plan', 'work', 'review', 'work', 'review', 'wrapup']);
  const task = String(db.prepare('SELECT task_id FROM tasks').get()?.['task_id']);
  assert.deepEqual(stagesOf(history(task)), ['null', 'work', 'review', 'work', 'review', 'null']);
  assert.equal(history(task).at(-1), 'null/done');
  const open = db
    .prepare('SELECT count(*) AS n FROM status_history WHERE task_id IS ? AND ended_at IS NULL')
    .get(task);
  assert.equal(open?.['n'], 1);
  assert.match(
    String(db.prepare('SELECT factory_version FROM ticket_executions').get()?.['factory_version']),
    /^\d+\.\d+\.\d+/,
  );
  await closeWhenIdle(db);
});

test('the review round limit pauses with the blockers and a reply resumes the reviewer', async () => {
  const { db, notified, review, runtime, service } = await reachReview({
    limits: { reviewRounds: 1 },
  });
  runtime.emit(review.runId, {
    kind: 'subagent_done',
    output: reviewOutput('changes_requested', blockingFinding),
    usage: sampleUsage(),
  });
  await waitFor(() => service.status('proj-123').includes('paused'));
  const status = service.status('proj-123');
  assert.match(status, /stage: review/);
  assert.match(status, /Review round 1 of 1/);
  assert.match(status, /R1-1 \[major\]/);
  await waitFor(() => notified.some((message) => message.includes('Review round 1 of 1')));
  assert.equal(launchesOf(runtime, 'work').length, 1);
  assert.equal(taskRow(db)['status'], 'blocked');

  await service.command('reply proj-123 "Resetting is acceptable for this ticket."');
  await waitFor(() => launchesOf(runtime, 'review').length === 2);
  const resumed = launchesOf(runtime, 'review')[1];
  assert.equal(resumed?.sessionId, review.sessionId);
  assert.equal(resumed?.mode, 'resume');
  assert.match(resumed?.prompt ?? '', /Resetting is acceptable/);
  await waitFor(() => service.status('proj-123').includes('Launched'));
  assert.equal(taskRow(db)['status'], 'reviewing');
  runtime.emit(resumed?.runId ?? review.runId, {
    kind: 'subagent_done',
    output: reviewOutput('approve'),
    usage: sampleUsage(),
  });
  await waitFor(() => launchesOf(runtime, 'wrapup').length === 1);
  await closeWhenIdle(db);
});

test('a malformed review resumes the reviewer without spending a round', async () => {
  const { db, review, runtime, service } = await reachReview({ limits: { reviewRounds: 1 } });
  runtime.emit(review.runId, {
    kind: 'subagent_done',
    output: 'Looks good to me.',
    usage: sampleUsage(),
  });
  await waitFor(() => launchesOf(runtime, 'review').length === 2);
  const correction = launchesOf(runtime, 'review')[1];
  assert.equal(correction?.sessionId, review.sessionId);
  assert.equal(correction?.purpose, 'validation_correction');
  assert.match(correction?.prompt ?? '', /## Verdict is missing/);
  await waitFor(() => service.status('proj-123').includes('Launched'));
  runtime.emit(correction?.runId ?? review.runId, {
    kind: 'subagent_done',
    output: reviewOutput('approve'),
    usage: sampleUsage(),
  });
  await waitFor(() => launchesOf(runtime, 'wrapup').length === 1);
  assert.deepEqual(semanticRounds(db, review.sessionId), [1, 1]);
  assert.equal(taskRow(db)['review_round'], 1);
  await closeWhenIdle(db);
});

test('the review correction limit pauses instead of resuming the reviewer again', async () => {
  const { db, review, runtime, service } = await reachReview({
    limits: { reviewCorrections: 1 },
  });
  runtime.emit(review.runId, { kind: 'subagent_done', output: 'fine', usage: sampleUsage() });
  await waitFor(() => launchesOf(runtime, 'review').length === 2);
  await waitFor(() => service.status('proj-123').includes('Launched'));
  const correction = launchesOf(runtime, 'review')[1];
  runtime.emit(correction?.runId ?? review.runId, {
    kind: 'subagent_done',
    output: 'still fine',
    usage: sampleUsage(),
  });
  await waitFor(() => service.status('proj-123').includes('paused'));
  assert.match(service.status('proj-123'), /still malformed after the correction limit/);
  assert.equal(launchesOf(runtime, 'review').length, 2);
  assert.equal(launchesOf(runtime, 'work').length, 1);
  await closeWhenIdle(db);
});

test('a crashed reviewer relaunches without spending a round', async () => {
  const { db, review, runtime, service } = await reachReview({ limits: { reviewRounds: 1 } });
  runtime.emit(review.runId, { kind: 'crashed', message: 'pane died' });
  await waitFor(() => launchesOf(runtime, 'review').length === 2);
  const retry = launchesOf(runtime, 'review')[1];
  assert.equal(retry?.purpose, 'infrastructure_retry');
  assert.equal(retry?.sessionId, review.sessionId);
  await waitFor(() => service.status('proj-123').includes('Launched'));
  runtime.emit(retry?.runId ?? review.runId, {
    kind: 'subagent_done',
    output: reviewOutput('changes_requested', blockingFinding),
    usage: sampleUsage(),
  });
  await waitFor(() => service.status('proj-123').includes('paused'));
  assert.deepEqual(semanticRounds(db, review.sessionId), [1, 1]);
  assert.equal(taskRow(db)['review_round'], 1);
  await closeWhenIdle(db);
});

test('a blocked verdict pauses the ticket and notifies the user', async () => {
  const { db, notified, review, runtime, service } = await reachReview();
  runtime.emit(review.runId, {
    kind: 'subagent_done',
    output: reviewOutput('blocked', 'none', 'The task file was not readable.'),
    usage: sampleUsage(),
  });
  await waitFor(() => service.status('proj-123').includes('paused'));
  assert.match(service.status('proj-123'), /The task file was not readable/);
  await waitFor(() => notified.some((message) => message.includes('The reviewer blocked task 01')));
  assert.equal(taskRow(db)['status'], 'blocked');
  assert.equal(taskRow(db)['review_verdict'], 'blocked');
  assert.equal(launchesOf(runtime, 'work').length, 1);
  assert.equal(launchesOf(runtime, 'wrapup').length, 0);
  await closeWhenIdle(db);
});

test('a reviewer caller_ping waits for the user and reply resumes the reviewer', async () => {
  const { db, review, runtime, service } = await reachReview();
  runtime.emit(review.runId, {
    kind: 'caller_ping',
    question: 'Is a reset on logout expected?',
    usage: sampleUsage(),
  });
  await waitFor(() => service.status('proj-123').includes('waiting_for_user'));
  assert.match(service.status('proj-123'), /stage: review/);
  assert.equal(taskRow(db)['status'], 'blocked');
  await service.command('reply proj-123 "Yes, logout clears it."');
  await waitFor(() => launchesOf(runtime, 'review').length === 2);
  const resumed = launchesOf(runtime, 'review')[1];
  assert.equal(resumed?.sessionId, review.sessionId);
  assert.match(resumed?.prompt ?? '', /logout clears it/);
  assert.match(resumed?.prompt ?? '', /factory-review/);
  await waitFor(() => taskRow(db)['status'] === 'reviewing');
  await closeWhenIdle(db);
});

test('approving the first of two tasks starts the next ready task, then wrap-up', async () => {
  const { db, review, runtime, service, work } = await reachReview({}, 2);
  runtime.emit(review.runId, {
    kind: 'subagent_done',
    output: reviewOutput('approve'),
    usage: sampleUsage(),
  });
  await waitFor(() => launchesOf(runtime, 'work').length === 2);
  const next = launchesOf(runtime, 'work')[1];
  assert.notEqual(next?.sessionId, work.sessionId);
  assert.equal(next?.mode, 'launch');
  assert.match(next?.prompt ?? '', /Task: 02 Show the filter/);
  assert.match(service.status('proj-123'), /stage: work/);
  assert.equal(launchesOf(runtime, 'wrapup').length, 0);
  assert.equal(taskRow(db, '01')['status'], 'done');
  await waitFor(() => service.status('proj-123').includes('Launched'));

  writeFileSync(path.join(work.cwd, 'show.txt'), 'visible\n');
  runtime.emit(next?.runId ?? work.runId, {
    kind: 'subagent_done',
    output: 'shown',
    usage: sampleUsage(),
  });
  await waitFor(() => launchesOf(runtime, 'review').length === 2);
  const secondReview = launchesOf(runtime, 'review')[1];
  assert.notEqual(secondReview?.sessionId, review.sessionId);
  assert.match(secondReview?.prompt ?? '', /Review round: 1/);
  await waitFor(() => service.status('proj-123').includes('Launched'));
  runtime.emit(secondReview?.runId ?? review.runId, {
    kind: 'subagent_done',
    output: reviewOutput('approve'),
    usage: sampleUsage(),
  });
  await waitFor(() => launchesOf(runtime, 'wrapup').length === 1);
  assert.equal(taskRow(db, '02')['status'], 'done');
  await closeWhenIdle(db);
});

test('a diff change during review validates the work again before another review', async () => {
  const { db, review, runtime, service, work } = await reachReview();
  writeFileSync(path.join(work.cwd, 'late.txt'), 'late edit\n');
  runtime.emit(review.runId, {
    kind: 'subagent_done',
    output: reviewOutput('approve'),
    usage: sampleUsage(),
  });
  await waitFor(() => launchesOf(runtime, 'review').length === 2);
  const fresh = launchesOf(runtime, 'review')[1];
  assert.equal(fresh?.sessionId, review.sessionId);
  assert.match(fresh?.prompt ?? '', /Review round: 1/);
  assert.match(fresh?.prompt ?? '', /late edit/);
  assert.equal(launchesOf(runtime, 'wrapup').length, 0);
  assert.equal(taskRow(db)['review_verdict'], null);
  await waitFor(() => service.status('proj-123').includes('Launched'));
  await closeWhenIdle(db);
});

test('a second diff change in one review round pauses until retry', async () => {
  const { db, notified, review, runtime, service, work } = await reachReview();
  writeFileSync(path.join(work.cwd, 'late.txt'), 'late edit\n');
  runtime.emit(review.runId, {
    kind: 'subagent_done',
    output: reviewOutput('approve'),
    usage: sampleUsage(),
  });
  await waitFor(() => launchesOf(runtime, 'review').length === 2);
  await waitFor(() => service.status('proj-123').includes('Launched'));
  const fresh = launchesOf(runtime, 'review')[1];

  writeFileSync(path.join(work.cwd, 'late.txt'), 'later edit\n');
  runtime.emit(fresh?.runId ?? review.runId, {
    kind: 'subagent_done',
    output: reviewOutput('approve'),
    usage: sampleUsage(),
  });
  await waitFor(() => service.status('proj-123').includes('paused'));
  const status = service.status('proj-123');
  assert.match(status, /worktree changed again while review round 1 of task 01/);
  await waitFor(() => notified.some((message) => message.includes('/factory retry')));
  assert.equal(launchesOf(runtime, 'review').length, 2);
  assert.equal(taskRow(db)['status'], 'blocked');
  assert.equal(taskRow(db)['review_verdict'], null);

  const reply = await service.command('reply proj-123 "go on"');
  assert.match(reply, /Retry with \/factory retry/);
  await service.command('retry proj-123');
  await waitFor(() => launchesOf(runtime, 'review').length === 3);
  const third = launchesOf(runtime, 'review')[2];
  assert.equal(third?.sessionId, review.sessionId);
  assert.match(third?.prompt ?? '', /Review round: 1/);
  assert.match(third?.prompt ?? '', /later edit/);
  await waitFor(() => service.status('proj-123').includes('Launched'));
  runtime.emit(third?.runId ?? review.runId, {
    kind: 'subagent_done',
    output: reviewOutput('approve'),
    usage: sampleUsage(),
  });
  await waitFor(() => launchesOf(runtime, 'wrapup').length === 1);
  assert.equal(taskRow(db)['review_round'], 1);
  await closeWhenIdle(db);
});

test('restart after a finished review records one verdict and launches one wrap-up', async () => {
  const { db, review, runtime, service } = await reachReview();
  const terminal = {
    kind: 'subagent_done' as const,
    output: reviewOutput('approve'),
    usage: sampleUsage(),
  };
  applyControllerEvent(db, {
    dedupeKey: `runtime:${review.runId}:terminal`,
    event: { kind: 'runtime_terminal', runId: review.runId, terminal },
    ids: randomIds(),
    now: '2026-10-08T00:00:00.000Z',
    source: 'runtime',
  });
  applyControllerEvent(db, {
    dedupeKey: `runtime:${review.runId}:terminal`,
    event: { kind: 'runtime_terminal', runId: review.runId, terminal },
    ids: randomIds(),
    now: '2026-10-08T00:00:01.000Z',
    source: 'runtime',
  });
  await service.recover();
  await waitFor(() => launchesOf(runtime, 'wrapup').length === 1);
  await service.recover();
  assert.equal(launchesOf(runtime, 'wrapup').length, 1);
  assert.equal(taskRow(db)['status'], 'done');
  await closeWhenIdle(db);
});

type WrapupHarness = ReviewHarness & { branch: string; wrapup: FakeRuntime['launches'][number] };

async function reachWrapup(
  config: Record<string, unknown> = {},
  codeHost?: () => CodeHost,
): Promise<WrapupHarness> {
  const harness = await reachReview(config, 1, codeHost);
  harness.runtime.emit(harness.review.runId, {
    kind: 'subagent_done',
    output: reviewOutput('approve', minorFinding),
    usage: sampleUsage(20),
  });
  await waitFor(() => launchesOf(harness.runtime, 'wrapup').length === 1);
  await waitFor(() => harness.service.status('proj-123').includes('Launched'));
  const wrapup = launchesOf(harness.runtime, 'wrapup')[0];
  const found: unknown = harness.db
    .prepare('SELECT worktree_branch FROM ticket_executions WHERE is_current = 1')
    .get();
  const branch =
    typeof found === 'object' && found !== null && 'worktree_branch' in found
      ? String(found.worktree_branch)
      : '';
  if (wrapup === undefined) {
    throw new Error('missing wrap-up run');
  }
  return { ...harness, branch, wrapup };
}

function handoff(worktree: string, branch: string, files = ['change.txt']): string {
  return `## Outcome

The catalog keeps its filter.

## PR summary

Persist the filter.

## Files

${files.map((file) => `- \`${file}\``).join('\n')}

## Tests

No validation commands are configured.

## Operations

none

## Limitations

none

## Merge commands

git -C "${worktree}" add -- change.txt
git -C "${worktree}" commit -m "Persist the filter"
git merge --ff-only "${branch}"
`;
}

function executionRow(db: ReviewHarness['db']): Record<string, unknown> {
  const found: unknown = db
    .prepare('SELECT stage, status, finished_at FROM ticket_executions WHERE is_current = 1')
    .get();
  return typeof found === 'object' && found !== null ? { ...found } : {};
}

test('wrap-up launches from checked input with the tasks, findings, verification, and usage', async () => {
  const { db, wrapup } = await reachWrapup();
  assert.equal(wrapup.model, 'work-model');
  assert.equal(wrapup.purpose, 'initial');
  assert.match(wrapup.prompt, /factory-wrapup/);
  assert.match(wrapup.prompt, /- 01 Store the filter: done, review approve/);
  assert.match(wrapup.prompt, /Task 01 R1-2 \[minor\] Unclear name/);
  assert.match(wrapup.prompt, /Task 01 · diff: passed/);
  assert.match(wrapup.prompt, /^Review\s+1\s+20\s/m);
  assert.match(wrapup.prompt, /Models: plan work-model · work work-model · review review-model/);
  assert.doesNotMatch(wrapup.prompt, /^Wrap-up/m);
  // No codeHost block: pull requests default to on.
  assert.match(wrapup.prompt, /codeHost\.pullRequests: true/);
  const prepared: unknown = db
    .prepare(
      "SELECT status FROM actions WHERE kind = 'prepare_input' AND json_extract(payload_json, '$.stage') = 'wrapup'",
    )
    .get();
  assert.deepEqual({ ...(prepared ?? {}) }, { status: 'succeeded' });
  await closeWhenIdle(db);
});

test('a valid handoff is ready for handoff, opens both panes, and complete finishes it once', async () => {
  const { branch, db, notified, runtime, service, wrapup } = await reachWrapup();
  const terminal = {
    kind: 'subagent_done' as const,
    output: handoff(wrapup.cwd, branch),
    usage: sampleUsage(30),
  };
  runtime.emit(wrapup.runId, terminal);
  runtime.emit(wrapup.runId, terminal);
  await waitFor(() => service.status('proj-123').includes('ready_for_handoff'));
  await waitFor(() => runtime.panes.length === 2);
  const [session, diff] = runtime.panes;
  assert.equal(session?.name, '📦 proj-123');
  assert.equal(session?.target.kind, 'session');
  assert.equal(diff?.name, '🔀 proj-123');
  assert.equal(diff?.cwd, wrapup.cwd);
  assert.equal(diff?.target.kind, 'diff');
  if (diff?.target.kind === 'diff') {
    assert.match(readFileSync(diff.target.file, 'utf8'), /change\.txt/);
  }
  await waitFor(() => notified.some((message) => /^Wrap-up\s+1\s/m.test(message)));
  const notice = notified.find((message) => /^Wrap-up\s+1\s/m.test(message)) ?? '';
  assert.match(notice, /status: ready for handoff/);
  assert.match(notice, /next: \/factory complete proj-123\.md/);
  assert.match(notice, /^Total\s+4\s/m);
  const validation: unknown = db
    .prepare('SELECT status, validator_version FROM validation_runs WHERE run_id = ?')
    .get(wrapup.runId);
  assert.deepEqual({ ...(validation ?? {}) }, { status: 'passed', validator_version: 'wrapup.v1' });
  const sessionRow: unknown = db
    .prepare("SELECT status FROM agent_sessions WHERE stage = 'wrapup'")
    .get();
  assert.deepEqual({ ...(sessionRow ?? {}) }, { status: 'open' });
  assert.equal(launchesOf(runtime, 'wrapup').length, 1);

  assert.match(await service.command('start proj-123.md'), /ready for handoff/);
  assert.equal(executionRow(db)['status'], 'ready_for_handoff');
  assert.match(await service.command('complete proj-123.md'), /stage: done\nstatus: complete/);
  assert.equal(executionRow(db)['stage'], 'done');
  assert.notEqual(executionRow(db)['finished_at'], null);
  assert.match(await service.command('complete proj-123.md'), /already complete/);
  await closeWhenIdle(db);
});

test('a failed handoff resumes the same wrap-up session with no correction limit', async () => {
  const { branch, db, runtime, service, wrapup } = await reachWrapup({
    limits: { infrastructureRetries: 1, workCorrections: 1 },
  });
  let current = wrapup;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    runtime.emit(current.runId, {
      kind: 'subagent_done',
      output: handoff(wrapup.cwd, branch, ['change.txt', 'ghost.txt']),
      usage: sampleUsage(10 * attempt),
    });
    await waitFor(() => launchesOf(runtime, 'wrapup').length === attempt + 1);
    const next = launchesOf(runtime, 'wrapup')[attempt];
    assert.equal(next?.sessionId, wrapup.sessionId);
    assert.equal(next?.mode, 'resume');
    assert.equal(next?.purpose, 'validation_correction');
    assert.equal(next?.cwd, wrapup.cwd);
    assert.match(next?.prompt ?? '', /## Files lists ghost\.txt, which did not change/);
    assert.match(service.status('proj-123'), /stage: wrapup/);
    await waitFor(() => service.status('proj-123').includes('Launched'));
    current = next ?? current;
  }
  runtime.emit(current.runId, {
    kind: 'subagent_done',
    output: handoff(wrapup.cwd, branch),
    usage: sampleUsage(40),
  });
  await waitFor(() => service.status('proj-123').includes('ready_for_handoff'));
  // The resumed session reported 10, 20, 30, then 40 cumulative tokens: it
  // counts once at 40, not 100.
  const wrapupUsage: unknown = db
    .prepare(
      `SELECT sum(u.delta_tokens_input) AS delta FROM usage_snapshots AS u
       JOIN agent_sessions AS s ON s.id = u.session_id WHERE s.stage = 'wrapup'`,
    )
    .get();
  assert.deepEqual({ ...(wrapupUsage ?? {}) }, { delta: 40 });
  const execution: unknown = db
    .prepare('SELECT id FROM ticket_executions WHERE is_current = 1')
    .get();
  const rows = usageRows(
    db,
    executionId(
      typeof execution === 'object' && execution !== null && 'id' in execution
        ? String(execution.id)
        : '',
    ),
    { includeWrapup: true },
  );
  assert.deepEqual(
    rows.map((row) => [row.label, row.sessions, row.input]),
    [
      ['Plan', 1, 10],
      ['Work', 1, 10],
      ['Review', 1, 20],
      ['Wrap-up', 1, 40],
      ['Total', 4, 80],
    ],
  );
  await closeWhenIdle(db);
});

test('two tickets wrap up at the same time', async () => {
  const { codeRoot, factoryRoot } = repo(true);
  writeFileSync(
    path.join(factoryRoot, 'FACTORY.json'),
    `${JSON.stringify({ models: { review: 'review-model', work: 'work-model' } })}\n`,
  );
  writeFileSync(path.join(codeRoot, 'proj-123.md'), '# Remember the filter\n');
  writeFileSync(path.join(codeRoot, 'proj-456.md'), '# Remember the sort\n');
  const db = openStateDatabase(factoryRoot, { create: true });
  const runtime = new FakeRuntime();
  const service = createFactoryService({ codeRoot, db, factoryRoot, github, runtime });
  await service.command('start proj-123.md');
  await service.command('start proj-456.md');
  for (const directory of readdirSync(path.join(factoryRoot, 'tickets'))) {
    writePlanFiles(path.join(factoryRoot, 'tickets', directory), '01-task-store-filter.md');
  }
  const settle = async (
    stage: string,
    count: number,
    finish: (launch: FakeRuntime['launches'][number]) => string,
  ) => {
    await waitFor(
      () =>
        launchesOf(runtime, stage).length === count &&
        service.status('proj-123').includes('Launched') &&
        service.status('proj-456').includes('Launched'),
    );
    for (const launch of launchesOf(runtime, stage)) {
      runtime.emit(launch.runId, {
        kind: 'subagent_done',
        output: finish(launch),
        usage: sampleUsage(),
      });
    }
  };
  for (const launch of launchesOf(runtime, 'plan')) {
    runtime.emit(launch.runId, { kind: 'subagent_done', output: 'files', usage: sampleUsage() });
  }
  await settle('work', 2, (launch) => {
    writeFileSync(path.join(launch.cwd, 'change.txt'), 'changed\n');
    return 'done';
  });
  await settle('review', 2, () => reviewOutput('approve'));
  await settle('wrapup', 2, (launch) => {
    const found: unknown = db
      .prepare('SELECT worktree_branch FROM ticket_executions WHERE worktree_path = ?')
      .get(launch.cwd);
    const branch =
      typeof found === 'object' && found !== null && 'worktree_branch' in found
        ? String(found.worktree_branch)
        : '';
    return handoff(launch.cwd, branch);
  });
  await waitFor(
    () =>
      service.status('proj-123').includes('ready_for_handoff') &&
      service.status('proj-456').includes('ready_for_handoff'),
  );
  await waitFor(() => runtime.panes.length === 4);
  assert.deepEqual(runtime.panes.map((pane) => pane.name).sort(), [
    '📦 proj-123',
    '📦 proj-456',
    '🔀 proj-123',
    '🔀 proj-456',
  ]);
  await closeWhenIdle(db);
});

test('a wrap-up question waits; reply resumes wrap-up in the worktree and survives a failed resume', async () => {
  const { db, runtime, service, wrapup } = await reachWrapup();
  runtime.emit(wrapup.runId, {
    kind: 'caller_ping',
    question: 'Should the handoff mention the migration?',
    usage: sampleUsage(),
  });
  await waitFor(() => service.status('proj-123').includes('waiting_for_user'));
  assert.match(service.status('proj-123'), /stage: wrapup/);
  runtime.failuresRemaining = 4;
  await service.command('reply proj-123 "Yes, mention it"');
  await waitFor(() => service.status('proj-123').includes('resume_failed'));
  runtime.failuresRemaining = 0;
  await service.command('retry proj-123');
  await waitFor(() =>
    launchesOf(runtime, 'wrapup').some((launch) => launch.prompt.includes('Yes, mention it')),
  );
  const resumed = launchesOf(runtime, 'wrapup').filter((launch) =>
    launch.prompt.includes('Yes, mention it'),
  );
  assert.equal(resumed.at(-1)?.sessionId, wrapup.sessionId);
  assert.equal(resumed.at(-1)?.cwd, wrapup.cwd);
  assert.match(resumed.at(-1)?.prompt ?? '', /factory-wrapup/);
  await waitFor(() => service.status('proj-123').includes('Launched'));
  await closeWhenIdle(db);
});

test('a pane that fails to open retries, and the handoff stands either way', async () => {
  const { branch, db, runtime, service, wrapup } = await reachWrapup();
  runtime.paneFailures = 1;
  runtime.emit(wrapup.runId, {
    kind: 'subagent_done',
    output: handoff(wrapup.cwd, branch),
    usage: sampleUsage(),
  });
  await waitFor(() => runtime.panes.length === 2);
  assert.equal(executionRow(db)['status'], 'ready_for_handoff');

  const second = await reachWrapup();
  second.runtime.paneFailures = 100;
  second.runtime.emit(second.wrapup.runId, {
    kind: 'subagent_done',
    output: handoff(second.wrapup.cwd, second.branch),
    usage: sampleUsage(),
  });
  await waitFor(() => second.service.status('proj-123').includes('ready_for_handoff'));
  await waitFor(() => {
    const failed: unknown = second.db
      .prepare(
        "SELECT count(*) AS n FROM actions WHERE kind IN ('open_pane', 'open_diff') AND status = 'failed'",
      )
      .get();
    return typeof failed === 'object' && failed !== null && 'n' in failed && failed.n === 2;
  });
  assert.equal(executionRow(second.db)['status'], 'ready_for_handoff');
  assert.equal(second.runtime.panes.length, 0);
  await closeWhenIdle(db);
  await closeWhenIdle(second.db);
  assert.ok(service);
});

test('wrap-up input that fails its checks pauses, and retry prepares it again', async () => {
  const harness = await reachReview();
  const plan = path.join(path.dirname(harness.work.cwd), '..', 'tickets');
  const [ticket] = readdirSync(plan);
  const planFile = path.join(plan, ticket ?? '', 'plan.md');
  const saved = readFileSync(planFile, 'utf8');
  rmSync(planFile);
  harness.runtime.emit(harness.review.runId, {
    kind: 'subagent_done',
    output: reviewOutput('approve'),
    usage: sampleUsage(),
  });
  await waitFor(() => harness.service.status('proj-123').includes('paused'));
  assert.match(harness.service.status('proj-123'), /plan\.md is missing/);
  assert.match(harness.service.status('proj-123'), /next: \/factory retry proj-123\.md/);
  assert.equal(launchesOf(harness.runtime, 'wrapup').length, 0);
  writeFileSync(planFile, saved);
  await harness.service.command('retry proj-123');
  await waitFor(() => launchesOf(harness.runtime, 'wrapup').length === 1);
  await waitFor(() => harness.service.status('proj-123').includes('Launched'));
  await closeWhenIdle(harness.db);
});

test('restart validates a finished wrap-up once and opens its panes once', async () => {
  const { branch, db, runtime, service, wrapup } = await reachWrapup();
  const terminal = {
    kind: 'subagent_done' as const,
    output: handoff(wrapup.cwd, branch),
    usage: sampleUsage(),
  };
  for (const now of ['2026-10-10T00:00:00.000Z', '2026-10-10T00:00:01.000Z']) {
    applyControllerEvent(db, {
      dedupeKey: `runtime:${wrapup.runId}:terminal`,
      event: { kind: 'runtime_terminal', runId: wrapup.runId, terminal },
      ids: randomIds(),
      now,
      source: 'runtime',
    });
  }
  await service.recover();
  await waitFor(() => service.status('proj-123').includes('ready_for_handoff'));
  await waitFor(() => runtime.panes.length === 2);
  await service.recover();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(runtime.panes.length, 2);
  const validations: unknown = db
    .prepare('SELECT count(*) AS n FROM validation_runs WHERE run_id = ?')
    .get(wrapup.runId);
  assert.deepEqual({ ...(validations ?? {}) }, { n: 1 });
  await closeWhenIdle(db);
});

test('QA corrects its own output, returns a failing product to work, then hands review the tested diff', async () => {
  const qa = {
    commands: [
      {
        argv: [
          process.execPath,
          '-e',
          "process.exit(require('node:fs').existsSync('product-ok.txt') ? 0 : 1)",
        ],
        name: 'e2e',
      },
    ],
    enabled: true,
  };
  const { codeRoot, factoryRoot } = repo(true);
  writeFileSync(
    path.join(factoryRoot, 'FACTORY.json'),
    `${JSON.stringify({
      models: { review: 'review-model', work: 'work-model' },
      stages: { qa },
    })}\n`,
  );
  writeFileSync(path.join(codeRoot, 'proj-123.md'), '# Remember the filter\n');
  const db = openStateDatabase(factoryRoot, { create: true });
  const runtime = new FakeRuntime();
  const service = createFactoryService({ codeRoot, db, factoryRoot, github, runtime });
  await service.command('start proj-123.md');
  const directory = ticketDir(factoryRoot);
  writePlanFiles(directory, '01-task-store-filter.md');
  const nth = (stage: string, index: number) => {
    const found = launchesOf(runtime, stage)[index];
    if (found === undefined) {
      throw new Error(`missing ${stage} run ${index + 1}`);
    }
    return found;
  };
  runtime.emit(nth('plan', 0).runId, {
    kind: 'subagent_done',
    output: 'files',
    usage: sampleUsage(),
  });
  await waitFor(() => launchesOf(runtime, 'work').length === 1);
  const work = launchesOf(runtime, 'work')[0];
  if (work === undefined) {
    throw new Error('missing work run');
  }
  writeFileSync(path.join(work.cwd, 'change.txt'), 'changed\n');
  runtime.emit(work.runId, { kind: 'subagent_done', output: 'stored it', usage: sampleUsage() });

  // QA is asked to prove AC1, then corrected for the files it did not write.
  await waitFor(() => launchesOf(runtime, 'qa').length === 1);
  const first = nth('qa', 0);
  assert.match(first.prompt, /AC1: The filter survives a reload\./);
  assert.equal(first.cwd, work.cwd);
  runtime.emit(first.runId, { kind: 'subagent_done', output: 'tested', usage: sampleUsage() });
  await waitFor(() => launchesOf(runtime, 'qa').length === 2);
  const correction = launchesOf(runtime, 'qa')[1];
  assert.match(correction?.prompt ?? '', /test-plan\.md is missing/);
  assert.match(correction?.prompt ?? '', /AC1 \(The filter survives a reload\.\) has no test/);

  // Now complete: the product still fails the e2e command, so work gets it back.
  const qaDir = path.join(directory, 'qa', '01');
  mkdirSync(path.join(qaDir, 'screenshots'), { recursive: true });
  writeFileSync(
    path.join(qaDir, 'test-plan.md'),
    '| AC | Test | Screenshot |\n| --- | --- | --- |\n| AC1 | e2e › AC1: filter survives a reload | screenshots/ac1.png |\n',
  );
  writeFileSync(path.join(qaDir, 'ledger.md'), '- Mobile layouts are not covered.\n');
  writeFileSync(path.join(qaDir, 'screenshots', 'ac1.png'), 'png');
  writeFileSync(path.join(work.cwd, 'filter.e2e.txt'), 'AC1 test\n');
  runtime.emit(nth('qa', 1).runId, {
    kind: 'subagent_done',
    output: 'tested',
    usage: sampleUsage(),
  });
  await waitFor(() => launchesOf(runtime, 'work').length === 2);
  const returned = launchesOf(runtime, 'work')[1];
  assert.equal(returned?.mode, 'resume');
  assert.match(returned?.prompt ?? '', /QA round 1 requested changes/);
  assert.match(returned?.prompt ?? '', /e2e \(.*\) failed/);

  // Work fixes the product; QA runs again on the same session and passes.
  writeFileSync(path.join(work.cwd, 'product-ok.txt'), 'ok\n');
  runtime.emit(nth('work', 1).runId, {
    kind: 'subagent_done',
    output: 'fixed',
    usage: sampleUsage(),
  });
  await waitFor(() => launchesOf(runtime, 'qa').length === 3);
  const again = launchesOf(runtime, 'qa')[2];
  assert.equal(again?.mode, 'resume');
  assert.match(again?.prompt ?? '', /QA round: 2/);
  runtime.emit(nth('qa', 2).runId, {
    kind: 'subagent_done',
    output: 'passed',
    usage: sampleUsage(),
  });

  // Review is given the diff QA left, tests included.
  await waitFor(() => launchesOf(runtime, 'review').length === 1);
  const review = launchesOf(runtime, 'review')[0];
  assert.match(review?.prompt ?? '', /filter\.e2e\.txt/);
  assert.match(review?.prompt ?? '', /screenshot AC1: passed/);
  runtime.emit(nth('review', 0).runId, {
    kind: 'subagent_done',
    output: reviewOutput('approve'),
    usage: sampleUsage(),
  });

  // Wrap-up is told about the screenshot for the pull request.
  await waitFor(() => launchesOf(runtime, 'wrapup').length === 1);
  assert.match(
    launchesOf(runtime, 'wrapup')[0]?.prompt ?? '',
    /QA screenshots[\s\S]*Task 01 screenshot AC1: .*qa\/01\/screenshots\/ac1\.png/,
  );
  await closeWhenIdle(db);
});

// A code host whose pull request for the ticket's branch is in `state`, or
// that finds none when `state` is null.
function codeHostWith(
  state: PullRequestInfo['state'] | null,
  found: Array<string>,
  reviews?: PullRequestOutcome['reviews'],
): CodeHost {
  const pullRequest = (branch: string): PullRequestInfo => ({
    author: 'dpaez',
    closedAt: state === 'open' ? null : '2026-10-16T09:00:00Z',
    headBranch: branch,
    mergedAt: state === 'merged' ? '2026-10-16T09:00:00Z' : null,
    number: 7,
    openedAt: '2026-10-15T10:00:00Z',
    state: state ?? 'open',
    url: 'https://github.com/geut/factory-skills/pull/7',
  });
  return {
    findPullRequest: (branch) => {
      found.push(branch);
      return state === null ? null : pullRequest(branch);
    },
    kind: 'github',
    pullRequest: () => null,
    pullRequestOutcome: (current) => ({
      commits: [{ committedAt: '2026-10-15T12:00:00Z', sha: 'abc' }],
      pullRequest: current,
      reviews: reviews ?? [
        {
          author: 'reviewer',
          authorType: 'human',
          commitSha: 'abc',
          hasBody: true,
          id: 'R1',
          state: 'changes_requested',
          submittedAt: '2026-10-15T13:00:00Z',
        },
      ],
    }),
    verifyWebhook: () => false,
  };
}

async function handedOff(
  state: PullRequestInfo['state'] | null,
  reviews?: PullRequestOutcome['reviews'],
) {
  const found: Array<string> = [];
  const harness = await reachWrapup({}, () => codeHostWith(state, found, reviews));
  harness.runtime.emit(harness.wrapup.runId, {
    kind: 'subagent_done',
    output: handoff(harness.wrapup.cwd, harness.branch),
    usage: sampleUsage(30),
  });
  await waitFor(() => harness.service.status('proj-123').includes('ready_for_handoff'));
  return { ...harness, found };
}

test('sync finds a merged pull request by branch, records it, and completes the ticket', async () => {
  const { branch, db, found, service } = await handedOff('merged');
  const result = await service.syncPullRequests();
  assert.deepEqual(result, { errors: [], synced: 1 });
  assert.deepEqual(found, [branch]);
  assert.match(service.status('proj-123'), /done\/complete|status: complete/);
  assert.deepEqual(
    { ...db.prepare('SELECT state, merged_at FROM pull_requests').get() },
    { merged_at: '2026-10-16T09:00:00Z', state: 'merged' },
  );
  assert.equal(db.prepare('SELECT count(*) AS n FROM pull_request_reviews').get()?.['n'], 1);
  assert.equal(
    db.prepare("SELECT actor FROM events WHERE kind = 'complete'").get()?.['actor'],
    'code-host',
  );
  assert.deepEqual(await service.syncPullRequests(), { errors: [], synced: 0 });
  await closeWhenIdle(db);
});

test('sync cancels a ticket whose pull request was closed without merging', async () => {
  const { db, service } = await handedOff('closed');
  await service.syncPullRequests();
  assert.deepEqual(
    { ...db.prepare('SELECT stage, status, status_reason_code FROM ticket_executions').get() },
    { stage: 'done', status: 'cancelled', status_reason_code: 'pull_request_closed' },
  );
  await closeWhenIdle(db);
});

test('sync leaves an open pull request waiting at handoff', async () => {
  const { db, service } = await handedOff('open');
  assert.deepEqual(await service.syncPullRequests(), { errors: [], synced: 1 });
  assert.match(service.status('proj-123'), /ready_for_handoff/);
  assert.notEqual(
    db.prepare('SELECT last_synced_at FROM pull_requests').get()?.['last_synced_at'],
    null,
  );
  await closeWhenIdle(db);
});

test('a webhook about a ticket pull request completes it like a sync would', async () => {
  const { branch, db, service } = await handedOff('merged');
  const ticket = service.pullRequestChanged({
    author: 'dpaez',
    closedAt: '2026-10-16T09:00:00Z',
    headBranch: branch,
    mergedAt: '2026-10-16T09:00:00Z',
    number: 7,
    openedAt: null,
    state: 'merged',
    url: 'https://github.com/geut/factory-skills/pull/7',
  });
  assert.match(ticket ?? '', /^proj-123-[0-9a-f]{8}$/);
  await waitFor(() => service.status('proj-123').includes('complete'));
  assert.equal(
    service.pullRequestChanged({
      author: null,
      closedAt: null,
      headBranch: 'someone/else',
      mergedAt: null,
      number: 9,
      openedAt: null,
      state: 'open',
      url: 'https://github.com/geut/factory-skills/pull/9',
    }),
    null,
  );
  await closeWhenIdle(db);
});

const review = (
  id: string,
  author: string,
  authorType: 'bot' | 'human',
  state: PullRequestOutcome['reviews'][number]['state'],
  commitSha: string,
  hasBody = true,
) => ({ author, authorType, commitSha, hasBody, id, state, submittedAt: '2026-10-15T13:00:00Z' });

test('external review rounds count commits that drew pushback, split human and bot', async () => {
  const { db, service } = await handedOff('merged', [
    review('R1', 'reviewer', 'human', 'changes_requested', 'c1'),
    review('R2', 'reviewer', 'human', 'commented', 'c1'),
    review('R3', 'coderabbitai[bot]', 'bot', 'commented', 'c2'),
    review('R4', 'coderabbitai[bot]', 'bot', 'commented', 'c3', false),
    review('R5', 'dpaez', 'human', 'commented', 'c4'),
    review('R6', 'reviewer', 'human', 'approved', 'c5'),
  ]);
  await service.syncPullRequests();
  const [ticket] = ticketFacts(db, { now: new Date().toISOString() });
  assert.equal(ticket?.outcome, 'merged');
  assert.deepEqual(ticket?.externalReviewRounds, { bot: 1, human: 1, total: 2 });
  assert.equal(
    ticket?.configuration,
    'plan=work-model · medium review=review-model · high work=work-model · medium wrapup=work-model · medium',
  );
  const summary = summarize(ticketFacts(db, { now: new Date().toISOString() }));
  assert.equal(summary.mergeRate, 1);
  assert.equal(summary.externalReviewRounds.median, 2);
  assert.ok(ticket !== undefined && ticket.leadMs !== null && ticket.factoryMs !== null);
  await closeWhenIdle(db);
});

test('a ticket finished without a known pull request is unknown: no merge rate, but its cost counts', async () => {
  const { db, service } = await handedOff(null);
  assert.deepEqual(await service.syncPullRequests(), { errors: [], synced: 0 });
  await service.command('complete proj-123');
  const facts = ticketFacts(db, { now: new Date().toISOString() });
  assert.equal(facts[0]?.outcome, 'unknown');
  assert.equal(facts[0]?.interventions.manualCompletes, 1);
  const summary = summarize(facts);
  assert.equal(summary.mergeRate, null);
  assert.equal(summary.outcomes.unknown, 1);
  // The fake runtime reports tokens and no cost; both are totalled.
  assert.equal(summary.tokens, facts[0]?.tokens);
  assert.ok(summary.tokens > 0);

  const stages = stageMeasures(
    runFacts(
      db,
      facts.map((item) => item.execution),
    ),
  );
  const review = stages.find((row) => row.stage === 'review');
  assert.equal(review?.model, 'review-model');
  assert.equal(review?.firstPassAcceptance, 1);
  assert.equal(review?.reviewRoundsPerTask, 1);
  await closeWhenIdle(db);
});

test('the stats routes answer for the factory, and the export is NDJSON', async () => {
  const { db, service } = await handedOff('merged');
  await service.syncPullRequests();
  const server = createServer(
    createRouter({
      context: {
        commands: unusedCommands,
        db,
        events: null,
        instanceId: 'test',
        openapi: () => ({ openapi: '3.1.0' }),
        webhooks: null,
      },
      routes: apiRoutes,
      validateResponses: true,
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
  const summary = (await (await fetch(`${base}/v1/stats/summary`)).json()) as {
    definitions: string;
    factoryId: string;
    factoryVersions: Array<string>;
    outcomes: { merged: number };
  };
  assert.equal(summary.definitions, 'stats.v1');
  assert.match(summary.factoryId, /^[0-9a-f-]{36}$/);
  assert.equal(summary.outcomes.merged, 1);
  assert.equal(summary.factoryVersions.length, 1);
  for (const route of ['stages', 'configurations', 'tickets']) {
    assert.equal((await fetch(`${base}/v1/stats/${route}`)).status, 200, route);
  }
  const later = await (await fetch(`${base}/v1/stats/summary?from=2999-01-01T00:00:00Z`)).json();
  assert.equal((later as { started: number }).started, 0);
  const exported = await fetch(`${base}/v1/stats/export`);
  assert.equal(exported.headers.get('content-type'), 'application/x-ndjson');
  const lines = (await exported.text())
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { factoryId: string; type: string });
  assert.equal(lines.filter((line) => line.type === 'ticket').length, 1);
  assert.ok(lines.filter((line) => line.type === 'run').length > 1);
  assert.ok(lines.every((line) => line.factoryId === summary.factoryId));
  server.close();
  await closeWhenIdle(db);
});
