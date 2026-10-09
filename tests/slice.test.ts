import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { createFactoryService } from '../src/controller/service.ts';
import { applyControllerEvent } from '../src/controller/store.ts';
import {
  randomIds,
  ticketId,
  type Policy,
  type ResolvedTicket,
  type RunId,
} from '../src/domain.ts';
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
    labels: [],
    sourceKind: 'text',
    sourceRef: 'text:proj-123',
    title: 'Remember the filter',
  };
  const policy: Policy = {
    codeRoot,
    labels: { map: {} },
    limits: {
      infrastructureRetries: 3,
      planCorrections: 3,
      reviewCorrections: 3,
      reviewRounds: 3,
      workCorrections: 3,
    },
    models: { plan: 'work-model', review: 'review-model', work: 'work-model' },
    validation: { work: { commands: [] } },
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
  const text = await service.command('start PROJ-6');
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
  await waitFor(() =>
    notified.some((message) => message.includes('status: correction 1 · checks failed')),
  );
  assert.ok(
    notified.some((message) => message.includes('stage: plan') && message.includes('status: done')),
  );
  assert.ok(
    notified.some(
      (message) => message.includes('stage: work') && message.includes('\nstatus: checks failed'),
    ),
  );
  assert.equal(
    notified.some((message) => message.includes('status: active')),
    false,
  );
  assert.equal(runtime.launches.filter((launch) => launch.stage === 'review').length, 0);
  assert.equal(runtime.launches.filter((launch) => launch.stage === 'work').length, 2);
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
      `SELECT status, review_round, review_verdict, finding_count, blocking_count
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
  assert.equal(fix?.purpose, 'review_changes');
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
