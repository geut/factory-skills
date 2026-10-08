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
    limits: { infrastructureRetries: 3, planCorrections: 3, workCorrections: 3 },
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
