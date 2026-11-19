import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createUpdateChecker } from './checker.ts';
import type { Download } from './install.ts';
import { writePreviousRecord } from './rollback.ts';
import { readUpdateState, writeUpdateState } from './state.ts';
import { createUpdater, SOURCE_RUN_MESSAGE, type Restart } from './updater.ts';

const download: Download = async ({ asset, dir }) => {
  writeFileSync(path.join(dir, asset), 'new binary');
  const sum = createHash('sha256').update('new binary').digest('hex');
  writeFileSync(path.join(dir, `${asset}.sha256`), `${sum}  ${asset}\n`);
};

// An updater on a fresh factory root and binary, with GitHub offering
// `tags`, and a world the test changes.
function setUp(
  input: {
    binary?: boolean;
    idle?: () => boolean;
    restart?: Restart;
    tags?: Array<string>;
    version?: () => Promise<string | null>;
  } = {},
) {
  const factoryRoot = mkdtempSync(path.join(tmpdir(), 'factory-updater-'));
  const binary = path.join(mkdtempSync(path.join(tmpdir(), 'factory-bin-')), 'factory');
  writeFileSync(binary, 'old binary');
  chmodSync(binary, 0o755);
  const world = {
    idle: true,
    onDisk: '0.5.0' as string | null,
    reports: [] as Array<string>,
    restarted: [] as Array<{ restore: string | null; rollback: boolean }>,
    restarts: 0,
  };
  const checker = createUpdateChecker({
    current: '0.5.0',
    enabled: () => true,
    factoryRoot,
    gh: async () =>
      (input.tags ?? ['v0.6.0']).map((tag) => ({
        draft: false,
        html_url: `https://github.com/geut/factory-skills/releases/tag/${tag}`,
        name: tag,
        prerelease: false,
        tag_name: tag,
      })),
    now,
  });
  const updater = createUpdater({
    arch: 'x64',
    binary: input.binary === false ? null : binary,
    checker,
    current: '0.5.0',
    databasePath: path.join(factoryRoot, 'db', 'state.sqlite'),
    download,
    factoryRoot,
    idle: input.idle ?? (() => world.idle),
    loss: () => ({ events: 3, tickets: ['geut/app#7'] }),
    now,
    platform: 'linux',
    pollMs: 60_000,
    report: (line) => world.reports.push(line),
    restart:
      input.restart ??
      (async (restarted) => {
        world.restarts += 1;
        world.restarted.push({ restore: restarted.restore, rollback: restarted.rollback });
      }),
    schema: 8,
    storedSchema: () => 8,
    version: input.version ?? (async () => world.onDisk),
  });
  return { binary, checker, factoryRoot, updater, world };
}

const now = () => '2026-11-19T10:00:00.000Z';

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test('a source run says to use git pull and changes nothing', async () => {
  const { updater } = setUp({ binary: false });
  assert.deepEqual(await updater.update({ whenIdle: false }), {
    kind: 'refused',
    message: SOURCE_RUN_MESSAGE,
  });
});

test('updating installs the newest release, then restarts on it', async () => {
  const { binary, updater, world } = setUp();
  const result = await updater.update({ whenIdle: false });
  assert.equal(result.kind, 'restarting');
  assert.match(result.message, /Installed factory 0\.6\.0/);
  assert.equal(readFileSync(binary, 'utf8'), 'new binary');
  assert.equal(readFileSync(`${binary}.previous`, 'utf8'), 'old binary');
  await settle();
  assert.equal(world.restarts, 1);
  // One update at a time.
  assert.equal((await updater.update({ whenIdle: false })).kind, 'refused');
});

test('with nothing newer there is nothing to do', async () => {
  const { binary, updater, world } = setUp({ tags: ['v0.5.0'] });
  assert.deepEqual(await updater.update({ whenIdle: false }), {
    kind: 'none',
    message: 'factory 0.5.0 is the newest release.',
  });
  await settle();
  assert.equal(world.restarts, 0);
  assert.equal(readFileSync(binary, 'utf8'), 'old binary');
});

test('a newer binary another factory installed is announced, and updating only restarts', async () => {
  const { binary, checker, factoryRoot, updater, world } = setUp({ tags: ['v0.5.0'] });
  await checker.check();
  world.onDisk = '0.6.0';
  writeFileSync(binary, 'binary from another factory');
  await updater.probe();
  const state = readUpdateState(factoryRoot);
  assert.equal(state.installed, '0.6.0');
  assert.equal(state.announcedAt, '2026-11-19T10:00:00.000Z');
  assert.deepEqual(
    { installed: checker.view()?.installed, latest: checker.view()?.latest },
    { installed: true, latest: '0.6.0' },
  );

  const result = await updater.update({ whenIdle: false });
  assert.match(result.message, /^Restarting on factory 0\.6\.0/);
  assert.equal(readFileSync(binary, 'utf8'), 'binary from another factory');
  await settle();
  assert.equal(world.restarts, 1);
});

test('the binary is asked its version only when the file changed', async () => {
  let asked = 0;
  const { binary, updater } = setUp({
    version: async () => {
      asked += 1;
      return '0.5.0';
    },
  });
  await updater.probe();
  await updater.probe();
  assert.equal(asked, 1);
  utimesSync(binary, new Date(), new Date(Date.now() + 5000));
  await updater.probe();
  assert.equal(asked, 2);
});

test('--when-idle waits while agents run, then updates once idle', async () => {
  const { binary, factoryRoot, updater, world } = setUp();
  world.idle = false;
  const result = await updater.update({ whenIdle: true });
  assert.equal(result.kind, 'pending');
  assert.equal(readUpdateState(factoryRoot).pending, true);
  assert.equal(readFileSync(binary, 'utf8'), 'old binary');

  world.idle = true;
  updater.start();
  for (let tries = 0; tries < 50 && world.restarts === 0; tries += 1) {
    await settle();
  }
  updater.close();
  assert.equal(world.restarts, 1);
  assert.equal(readFileSync(binary, 'utf8'), 'new binary');
  assert.equal(readUpdateState(factoryRoot).pending, false);
});

test('a failed restart says how to run the update, and allows another try', async () => {
  const { binary, updater, world } = setUp({
    restart: () => Promise.reject(new Error('herdr is gone')),
  });
  assert.equal((await updater.update({ whenIdle: false })).kind, 'restarting');
  await settle();
  assert.match(world.reports.join('\n'), /could not restart on it: herdr is gone/);
  // The binary is already the update: another try only restarts, and
  // factory.previous keeps the old binary.
  assert.match(
    (await updater.update({ whenIdle: false })).message,
    /^Restarting on factory 0\.6\.0/,
  );
  assert.equal(readFileSync(`${binary}.previous`, 'utf8'), 'old binary');
});

test('a server restarted on the installed version offers nothing', async () => {
  const { checker, factoryRoot } = setUp({ tags: ['v0.5.0'] });
  await checker.check();
  const state = readUpdateState(factoryRoot);
  writeUpdateState(factoryRoot, { ...state, installed: '0.5.0' });
  assert.equal(checker.view(), null);
});

test('after an update restarts the server, the release it runs is not offered again', async () => {
  const { binary, checker, factoryRoot, updater } = setUp({ tags: ['v0.5.0'] });
  // What the server on 0.4.x recorded before it updated to 0.5.0.
  writeUpdateState(factoryRoot, {
    announcedAt: now(),
    checkedAt: now(),
    current: '0.4.0',
    installed: '0.5.0',
    later: null,
    latest: { name: 'v0.5.0', notesUrl: 'https://example.test', version: '0.5.0' },
    pending: false,
  });
  assert.equal(checker.view(), null);
  // Updating asks GitHub again rather than reinstalling the running release.
  assert.equal((await updater.update({ whenIdle: false })).kind, 'none');
  assert.equal(readFileSync(binary, 'utf8'), 'old binary');
});

test('later puts off a newer binary another factory installed', async () => {
  const { binary, checker, updater, world } = setUp({ tags: ['v0.5.0'] });
  await checker.check();
  world.onDisk = '0.6.0';
  writeFileSync(binary, 'binary from another factory');
  await updater.probe();
  const putOff = checker.later();
  assert.deepEqual(
    { later: putOff?.later, latest: putOff?.latest },
    { later: true, latest: '0.6.0' },
  );
  assert.equal(checker.view()?.later, true);
});

test('a background poll that fails is reported, and never ends the server', async () => {
  const { factoryRoot, updater, world } = setUp({
    idle: () => {
      throw new Error('database is locked');
    },
  });
  writeUpdateState(factoryRoot, { ...readUpdateState(factoryRoot), pending: true });
  updater.start();
  for (let tries = 0; tries < 50 && world.reports.length === 0; tries += 1) {
    await settle();
  }
  updater.close();
  assert.deepEqual(world.reports, ['Update poll failed: database is locked']);
});

test('an update that throws is a failed update, not a rejection', async () => {
  const { updater } = setUp({
    idle: () => {
      throw new Error('database is locked');
    },
  });
  assert.deepEqual(await updater.update({ whenIdle: true }), {
    kind: 'failed',
    message: 'The update failed: database is locked',
  });
  // Nothing is left marked as under way.
  assert.equal((await updater.update({ whenIdle: true })).kind, 'failed');
});

// factory.previous as an update leaves it: the 0.4.0 binary on `schema`.
function previousOf(binary: string, schema: number): void {
  writeFileSync(`${binary}.previous`, 'binary 0.4.0');
  writePreviousRecord(binary, { schema, version: '0.4.0' });
}

test('rollback with no factory.previous refuses, and changes nothing', async () => {
  const { binary, updater, world } = setUp();
  const result = await updater.rollback({ confirm: true });
  assert.equal(result.kind, 'refused');
  await settle();
  assert.equal(world.restarts, 0);
  assert.equal(readFileSync(binary, 'utf8'), 'old binary');
});

test('rollback on the same schema swaps factory.previous in and restarts on it', async () => {
  const { binary, factoryRoot, updater, world } = setUp();
  previousOf(binary, 8);
  const result = await updater.rollback({ confirm: false });
  assert.equal(result.kind, 'restarting');
  assert.match(result.message, /^Rolling back to factory 0\.4\.0/);
  assert.equal(readFileSync(binary, 'utf8'), 'binary 0.4.0');
  assert.equal(readFileSync(`${binary}.previous`, 'utf8'), 'old binary');
  // The version rolled back from is put off, so its cards stay away.
  assert.equal(readUpdateState(factoryRoot).later, '0.5.0');
  await settle();
  assert.deepEqual(world.restarted, [{ restore: null, rollback: true }]);
});

test('across a schema upgrade, rollback asks first, then restores the backup', async () => {
  const { binary, factoryRoot, updater, world } = setUp();
  previousOf(binary, 7);
  const backup = path.join(factoryRoot, 'db', 'state.schema-7.sqlite');
  mkdirSync(path.dirname(backup), { recursive: true });
  writeFileSync(backup, 'schema 7');

  const asked = await updater.rollback({ confirm: false });
  assert.equal(asked.kind, 'confirm');
  assert.match(asked.message, /Everything recorded since is lost: 3 events for geut\/app#7\./);
  assert.equal(readFileSync(binary, 'utf8'), 'old binary');

  assert.equal((await updater.rollback({ confirm: true })).kind, 'restarting');
  await settle();
  assert.deepEqual(world.restarted, [{ restore: backup, rollback: true }]);
});

test('a rollback whose restart fails puts the binary back, and changes nothing', async () => {
  const { binary, factoryRoot, updater, world } = setUp({
    restart: () => Promise.reject(new Error('herdr is gone')),
  });
  previousOf(binary, 8);
  assert.equal((await updater.rollback({ confirm: true })).kind, 'restarting');
  await settle();
  assert.equal(readFileSync(binary, 'utf8'), 'old binary');
  assert.equal(readFileSync(`${binary}.previous`, 'utf8'), 'binary 0.4.0');
  assert.equal(readUpdateState(factoryRoot).later, null);
  assert.match(world.reports.join('\n'), /nothing was rolled back: herdr is gone/);
});

test('a rollback whose restore fails is undone, so the newer version starts again', async () => {
  const { binary, factoryRoot, updater } = setUp({
    // The server stopped, and restoring the backup failed.
    restart: async ({ undo }) => {
      undo();
    },
  });
  previousOf(binary, 7);
  const backup = path.join(factoryRoot, 'db', 'state.schema-7.sqlite');
  mkdirSync(path.dirname(backup), { recursive: true });
  writeFileSync(backup, 'schema 7');
  assert.equal((await updater.rollback({ confirm: true })).kind, 'restarting');
  await settle();
  assert.equal(readFileSync(binary, 'utf8'), 'old binary');
  assert.equal(readFileSync(`${binary}.previous`, 'utf8'), 'binary 0.4.0');
  assert.equal(readUpdateState(factoryRoot).later, null);
});
