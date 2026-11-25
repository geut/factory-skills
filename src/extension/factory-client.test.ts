import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { initRepo } from '../../tests/git-repo.ts';
import { parseFactoryCommand } from '../controller/parse.ts';
import { FakeRuntime, sampleUsage } from '../runtime/fake.ts';
import { type RunningServer, serve } from '../server/serve.ts';
import { CONTEXT_SECTIONS } from '../stages/plan/context.ts';
import { openStateDatabase } from '../state/database.ts';
import { captureWrapupState } from '../validation/wrapup.ts';
import { factoryVersion } from '../version.ts';
import { createFactoryClient, noServerMessage } from './factory-client.ts';

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

function repository(): { codeRoot: string; factoryRoot: string; pi: string } {
  const codeRoot = mkdtempSync(path.join(tmpdir(), 'factory-pi-'));
  roots.push(codeRoot);
  initRepo(codeRoot);
  const factoryRoot = path.join(codeRoot, '.factory');
  mkdirSync(factoryRoot);
  writeFileSync(
    path.join(factoryRoot, 'FACTORY.json'),
    JSON.stringify({ models: { review: 'review-model', work: 'work-model' } }),
  );
  writeFileSync(path.join(codeRoot, 'proj-123.md'), '# Remember the filter\n');
  const pi = path.join(codeRoot, 'pi');
  writeFileSync(pi, '#!/bin/sh\n');
  chmodSync(pi, 0o755);
  return { codeRoot, factoryRoot, pi };
}

async function serverFor(
  codeRoot: string,
  pi: string,
  runtime: FakeRuntime,
  releases: () => Promise<unknown> = async () => [],
): Promise<void> {
  const result = await serve({
    cwd: codeRoot,
    env: { FACTORY_PI_BIN: pi, HERDR_PANE_ID: 'pane-1', HERDR_SOCKET_PATH: '/tmp/herdr.sock' },
    out: () => undefined,
    port: 0,
    releases,
    runtime: () => runtime,
  });
  if (result.kind !== 'ok') {
    throw new Error(result.message);
  }
  servers.push(result.server);
}

async function until(check: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200 && !check(); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(check(), 'timed out');
}

test('without a server, commands say how to start one and nothing changes', async () => {
  const { factoryRoot } = repository();
  const client = createFactoryClient({ factoryRoot });
  const answer = await client.command(parseFactoryCommand('start proj-123.md'));
  assert.equal(answer, noServerMessage(factoryRoot));
  assert.deepEqual(client.progress(), []);
  client.close();
});

test('Pi starts a ticket through the server, then sees its cards in the database', async () => {
  const { codeRoot, factoryRoot, pi } = repository();
  const runtime = new FakeRuntime();
  await serverFor(codeRoot, pi, runtime);
  const client = createFactoryClient({ factoryRoot });
  const cursor = client.revision();

  const started = await client.command(parseFactoryCommand('start proj-123.md'));
  assert.match(started, /proj-123/);
  await until(() => runtime.launches.length === 1);
  assert.equal(client.progress()[0]?.displayRef, 'proj-123');

  const planRun = runtime.launches[0]?.runId;
  if (planRun === undefined) {
    throw new Error('missing plan run');
  }
  runtime.emit(planRun, {
    kind: 'caller_ping',
    question: 'Which API should the filter use?',
    usage: sampleUsage(),
  });
  await until(() => client.cardsSince(cursor).length > 0);
  assert.match(client.cardsSince(cursor).at(-1)?.card ?? '', /Which API should the filter use\?/);
  assert.match(client.status('proj-123'), /waiting_for_user/);

  const replied = await client.command(
    parseFactoryCommand('reply proj-123 "Use the existing API"'),
  );
  assert.doesNotMatch(replied, /No factory/);
  await until(() => runtime.launches.length === 2);
  assert.equal(runtime.launches[1]?.mode, 'resume');
  client.close();
});

test('Pi sees the update the server found, checks again, and puts it off', async () => {
  const { codeRoot, factoryRoot, pi } = repository();
  const notesUrl = 'https://github.com/geut/factory-skills/releases/tag/v99.0.0';
  await serverFor(codeRoot, pi, new FakeRuntime(), async () => [
    { draft: false, html_url: notesUrl, name: 'v99.0.0', prerelease: false, tag_name: 'v99.0.0' },
  ]);
  const client = createFactoryClient({ factoryRoot });
  // The server checks on start, without holding it up.
  await until(() => client.updateState().update !== null);
  const { announcedAt, update } = client.updateState();
  assert.notEqual(announcedAt, null);
  assert.equal(update?.latest, '99.0.0');
  assert.equal(update?.later, false);

  const checked = await client.update('check');
  assert.equal(checked.kind === 'notice' ? checked.notice.notesUrl : checked.text, notesUrl);
  assert.equal(client.updateState().announcedAt, announcedAt);

  // Read again only when the server rewrote the file.
  assert.equal(client.updateState(), client.updateState());

  const putOff = await client.update('later');
  assert.match(putOff.kind === 'text' ? putOff.text : '', /No more notices for factory 99\.0\.0/);
  assert.equal(client.updateState().update?.later, true);
  assert.match(
    await client.command(parseFactoryCommand('update')),
    /runs from source; update it with git pull/,
  );
  client.close();
});

test('Pi reads the running server and its version, and none when it is gone', async () => {
  const { codeRoot, factoryRoot, pi } = repository();
  const client = createFactoryClient({ factoryRoot });
  assert.equal(client.serverInstance(), null);
  assert.equal(await client.serverVersion(), null);
  await serverFor(codeRoot, pi, new FakeRuntime());
  assert.equal(client.serverInstance(), servers.at(-1)?.instanceId);
  assert.equal(await client.serverVersion(), factoryVersion());
  await servers.pop()?.close();
  assert.equal(client.serverInstance(), null);
  assert.equal(await client.serverVersion(), null);
  client.close();
});

test('/factory update takes --check, --later, --when-idle, or --rollback, and nothing else', () => {
  assert.deepEqual(parseFactoryCommand('update'), { kind: 'update', mode: 'install' });
  assert.deepEqual(parseFactoryCommand('update --check'), { kind: 'update', mode: 'check' });
  assert.deepEqual(parseFactoryCommand('update --later'), { kind: 'update', mode: 'later' });
  assert.deepEqual(parseFactoryCommand('update --when-idle'), {
    kind: 'update',
    mode: 'when-idle',
  });
  assert.deepEqual(parseFactoryCommand('update --rollback'), {
    kind: 'update',
    mode: 'rollback',
    yes: false,
  });
  assert.deepEqual(parseFactoryCommand('update --rollback --yes'), {
    kind: 'update',
    mode: 'rollback',
    yes: true,
  });
  assert.equal(parseFactoryCommand('update now').kind, 'invalid');
});

test('commands for a ticket the factory does not know are refused locally', async () => {
  const { codeRoot, factoryRoot, pi } = repository();
  await serverFor(codeRoot, pi, new FakeRuntime());
  const client = createFactoryClient({ factoryRoot });
  assert.equal(
    await client.command(parseFactoryCommand('retry nope')),
    'No factory execution matches nope.',
  );
  client.close();
});

test('the extension never creates the controller', () => {
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /createFactoryService|\.recover\(/);
});

test('a feedback round goes through the API and is refused before handoff', async () => {
  const { codeRoot, factoryRoot, pi } = repository();
  await serverFor(codeRoot, pi, new FakeRuntime());
  const client = createFactoryClient({ factoryRoot });
  await client.command(parseFactoryCommand('start proj-123.md'));
  assert.match(
    await client.command(parseFactoryCommand('feedback proj-123 "Also rename the flag"')),
    /proj-123 is plan\/\w+, not ready for handoff/,
  );
  assert.deepEqual(parseFactoryCommand('feedback proj-123 "Also rename the flag"'), {
    kind: 'feedback',
    list: false,
    note: 'Also rename the flag',
    only: null,
    ref: 'proj-123',
    skip: [],
  });
  assert.deepEqual(parseFactoryCommand('feedback proj-123 --list'), {
    kind: 'feedback',
    list: true,
    note: null,
    only: null,
    ref: 'proj-123',
    skip: [],
  });
  assert.deepEqual(
    parseFactoryCommand('feedback proj-123 --only r2841,c6799 --skip p12 "and the README"'),
    {
      kind: 'feedback',
      list: false,
      note: 'and the README',
      only: ['r2841', 'c6799'],
      ref: 'proj-123',
      skip: ['p12'],
    },
  );
  assert.equal(parseFactoryCommand('feedback proj-123 --only').kind, 'invalid');
  assert.equal(parseFactoryCommand('feedback proj-123 --bogus').kind, 'invalid');
  assert.equal(parseFactoryCommand('feedback').kind, 'invalid');
  client.close();
});

// Git for the test's own commits; throws on failure.
function run(cwd: string, args: Array<string>): string {
  const result = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
  return result.stdout.trim();
}
// A wrap-up pass that started before passes kept their compare base, after a
// person rebased the ticket onto a target that gained 40 files, with its
// agent waiting on a question: what PLT-3432 hit on 0.6.9.
test('retry --rebased, and its dry run, go through the server from Pi and recover a wrap-up waiting for you', async () => {
  const { codeRoot, factoryRoot, pi } = repository();
  const runtime = new FakeRuntime();
  await serverFor(codeRoot, pi, runtime);
  const client = createFactoryClient({ factoryRoot });
  const launched = (stage: string) => runtime.launches.filter((item) => item.stage === stage);
  const nth = (stage: string, index: number) => {
    const found = launched(stage)[index];
    if (found === undefined) {
      throw new Error(`missing ${stage} run ${index}`);
    }
    return found;
  };
  const waitFor = async (label: string, check: () => boolean) => {
    for (let tries = 0; tries < 500 && !check(); tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(check(), `timed out: ${label}\n${client.status('proj-123')}`);
  };
  await client.command(parseFactoryCommand('start proj-123.md'));
  await waitFor('plan launch', () => runtime.launches.length === 1);
  const [ticketName] = readdirSync(path.join(factoryRoot, 'tickets'));
  const ticketDir = path.join(factoryRoot, 'tickets', ticketName ?? '');
  writeFileSync(
    path.join(factoryRoot, 'CONTEXT.md'),
    CONTEXT_SECTIONS.map((section) => `## ${section}\nnone known yet\n`).join('\n'),
  );
  writeFileSync(path.join(ticketDir, 'plan.md'), '# Remember the filter\n\n## Outcome\nKept.\n');
  writeFileSync(
    path.join(ticketDir, '01-task-store-filter.md'),
    '---\ntype: feature\nqa: e2e\nblocked_by: []\n---\n\n# Store the filter\n\n## Acceptance criteria\n- [ ] The filter survives a reload.\n',
  );
  runtime.emit(nth('plan', 0).runId, {
    kind: 'subagent_done',
    output: 'files',
    usage: sampleUsage(),
  });
  await waitFor('work launch', () => launched('work').length === 1);
  const work = launched('work')[0];
  if (work === undefined) {
    throw new Error('missing work run');
  }
  writeFileSync(path.join(work.cwd, 'change.txt'), 'changed\n');
  runtime.emit(work.runId, { kind: 'subagent_done', output: 'stored it', usage: sampleUsage() });
  await waitFor('review launch', () => launched('review').length === 1);
  runtime.emit(nth('review', 0).runId, {
    kind: 'subagent_done',
    output:
      '## Verdict\n\napprove\n\n## Summary\n\nChecked.\n\n## Verification\n\n- AC1: verified — change.txt:1\n\n## Findings\n\nnone\n',
    usage: sampleUsage(),
  });
  await waitFor('wrap-up launch', () => launched('wrapup').length === 1);
  const wrapup = launched('wrapup')[0];
  if (wrapup === undefined) {
    throw new Error('missing wrap-up run');
  }

  // The target gains 40 files, and a person rebases the ticket onto it.

  mkdirSync(path.join(codeRoot, 'upstream'));
  for (let index = 0; index < 40; index += 1) {
    writeFileSync(path.join(codeRoot, `upstream/file${index}.ts`), `${index}\n`);
  }
  run(codeRoot, ['add', 'upstream']);
  run(codeRoot, ['commit', '-qm', 'upstream']);
  run(work.cwd, ['stash', '-q', '-u']);
  run(work.cwd, ['rebase', '-q', 'main']);
  run(work.cwd, ['stash', 'pop', '-q']);
  // The pass's baseline, as 0.6.8 took it: against where the ticket branched.
  const db = openStateDatabase(factoryRoot);
  const branched = String(
    db.prepare('SELECT worktree_base_sha FROM ticket_executions WHERE is_current = 1').get()?.[
      'worktree_base_sha'
    ],
  );
  const branch = run(work.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const { compareBase: _base, ...legacy } = captureWrapupState({
    baseBranch: 'main',
    baseSha: branched,
    branch,
    codeRoot,
    factoryRoot,
    ticketDir,
    worktree: work.cwd,
  });
  db.prepare(
    "UPDATE agent_runs SET lifecycle_json = json_set(lifecycle_json, '$.baseline', ?) WHERE id = ?",
  ).run(JSON.stringify({ ...legacy, boxes: [] }), wrapup.runId);
  db.close();

  // Validation demands the upstream files; the agent asks what to do.
  const handoff = `## Outcome\n\nKept.\n\n## PR summary\n\nKeep it.\n\n## Files\n\n- \`change.txt\`\n\n## Tests\n\nNo validation commands are configured.\n\n## Issue checklist\n\nnone\n\n## Decisions\n\nnone\n\n## Operations\n\nnone\n\n## Limitations\n\nnone\n\n## Merge commands\n\ngit -C "${work.cwd}" add -- change.txt\ngit merge --ff-only "${branch}"\n`;
  runtime.emit(wrapup.runId, { kind: 'subagent_done', output: handoff, usage: sampleUsage() });
  await waitFor('wrap-up correction', () => launched('wrapup').length === 2);
  runtime.emit(nth('wrapup', 1).runId, {
    kind: 'caller_ping',
    question: 'Should I list 40 files I did not change?',
    usage: sampleUsage(),
  });
  await waitFor('waiting for user', () => /waiting_for_user/.test(client.status('proj-123')));
  // Plain retry has nothing to retry.
  assert.match(
    await client.command(parseFactoryCommand('retry proj-123')),
    /not waiting for retry/,
  );

  const preview = await client.command(parseFactoryCommand('retry proj-123 --rebased --dry-run'));
  assert.match(preview, /dropped as the target's own \(40\): upstream\/file0\.ts/);
  assert.match(preview, /kept \(1\): change\.txt/);
  assert.match(client.status('proj-123'), /waiting_for_user/);

  await client.command(parseFactoryCommand('retry proj-123 --rebased'));
  await waitFor('ready for handoff', () => /ready_for_handoff/.test(client.status('proj-123')));
  assert.doesNotMatch(client.status('proj-123'), /Should I list 40 files/);
  client.close();
});
