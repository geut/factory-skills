import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  openStateDatabase,
  SCHEMA_VERSION,
  stateDatabasePath,
  upgradeBackupPath,
} from '../state/database.ts';
import type { Download } from './install.ts';
import { writePreviousRecord } from './rollback.ts';
import { readUpdateState } from './state.ts';
import { ROLLBACK_YES_HINT, runUpdateCommand, type ServerUpdate } from './update-cli.ts';
import { SOURCE_RUN_MESSAGE } from './updater.ts';

const one = async () => [
  {
    draft: false,
    html_url: 'https://github.com/geut/factory-skills/releases/tag/v0.5.0',
    name: 'v0.5.0',
    prerelease: false,
    tag_name: 'v0.5.0',
  },
];

const download: Download = async ({ asset, dir }) => {
  writeFileSync(path.join(dir, asset), 'new binary');
  const sum = createHash('sha256').update('new binary').digest('hex');
  writeFileSync(path.join(dir, `${asset}.sha256`), `${sum}  ${asset}\n`);
};

async function run(
  args: Array<string>,
  input: {
    binary?: string | null;
    factoryRoot?: string;
    gh?: () => Promise<unknown>;
    server?: ServerUpdate | null;
  } = {},
) {
  const out: Array<string> = [];
  const err: Array<string> = [];
  const code = await runUpdateCommand(
    args,
    { err: (line) => err.push(line), out: (line) => out.push(line) },
    {
      arch: 'x64',
      binary: input.binary ?? null,
      current: '0.4.0+1ddf4f6',
      download,
      factoryRoot: input.factoryRoot ?? mkdtempSync(path.join(tmpdir(), 'factory-cli-root-')),
      gh: input.gh ?? one,
      platform: 'linux',
      server: input.server ?? null,
    },
  );
  return { code, err, out };
}

test('factory update --check says what is newer and where to read about it', async () => {
  assert.deepEqual(await run(['--check']), {
    code: 0,
    err: [],
    out: [
      'factory 0.5.0 is available (you run 0.4.0).',
      "What's new: https://github.com/geut/factory-skills/releases/tag/v0.5.0",
    ],
  });
  assert.deepEqual((await run(['--check'], { gh: async () => [] })).out, [
    'factory 0.4.0 is the newest release.',
  ]);
});

test('a check that fails exits 1 with why, and other arguments print the usage', async () => {
  const failed = await run(['--check'], { gh: () => Promise.reject(new Error('gh: not found')) });
  assert.equal(failed.code, 1);
  assert.match(failed.err.join('\n'), /gh: not found/);
  assert.equal((await run(['--now'])).code, 2);
});

test('with a server running, factory update hands off to it', async () => {
  const asked: Array<string> = [];
  const server: ServerUpdate = {
    rollback: () => Promise.reject(new Error('not asked')),
    update: async (mode) => {
      asked.push(mode);
      return { kind: 'text', text: 'Installed factory 0.5.0; a new server starts on it.' };
    },
  };
  assert.deepEqual(await run([], { server }), {
    code: 0,
    err: [],
    out: ['Installed factory 0.5.0; a new server starts on it.'],
  });
  await run(['--when-idle'], { server });
  assert.deepEqual(asked, ['install', 'when-idle']);
  const refused = await run([], {
    server: { ...server, update: async () => ({ kind: 'problem', text: 'busy' }) },
  });
  assert.deepEqual({ code: refused.code, err: refused.err }, { code: 1, err: ['busy'] });
});

test('with no server, factory update swaps the binary for the next factory serve', async () => {
  const binary = path.join(mkdtempSync(path.join(tmpdir(), 'factory-cli-')), 'factory');
  writeFileSync(binary, 'old binary');
  chmodSync(binary, 0o755);
  const result = await run([], { binary });
  assert.equal(result.code, 0);
  assert.equal(result.out[0], 'Installed factory 0.5.0; the next factory serve runs it.');
  assert.equal(readFileSync(binary, 'utf8'), 'new binary');
  assert.equal(readFileSync(`${binary}.previous`, 'utf8'), 'old binary');
});

test('a source run with no server says to use git pull', async () => {
  assert.deepEqual(await run([]), { code: 1, err: [SOURCE_RUN_MESSAGE], out: [] });
});

test('with a server running, rollback hands off, and asks for --yes before restoring', async () => {
  const confirms: Array<boolean> = [];
  const server: ServerUpdate = {
    rollback: async (confirm) => {
      confirms.push(confirm);
      return confirm
        ? { kind: 'text', text: 'Rolling back to factory 0.4.0.' }
        : { kind: 'confirm', text: 'Everything recorded since is lost: 3 events.' };
    },
    update: () => Promise.reject(new Error('not asked')),
  };
  assert.deepEqual(await run(['--rollback'], { server }), {
    code: 1,
    err: [],
    out: ['Everything recorded since is lost: 3 events.', ROLLBACK_YES_HINT],
  });
  assert.equal((await run(['--rollback', '--yes'], { server })).code, 0);
  assert.deepEqual(confirms, [false, true]);
  assert.equal((await run(['--rollback', '--now'], { server })).code, 2);
});

test('with no server, rollback swaps the binaries and restores the database once confirmed', async () => {
  const factoryRoot = mkdtempSync(path.join(tmpdir(), 'factory-cli-root-'));
  const db = openStateDatabase(factoryRoot, { create: true });
  const databasePath = stateDatabasePath(factoryRoot);
  // The backup an upgrade from schema SCHEMA_VERSION - 1 would have made.
  const backup = upgradeBackupPath(databasePath, SCHEMA_VERSION - 1);
  db.exec(`VACUUM INTO '${backup}'`);
  db.close();
  const binary = path.join(mkdtempSync(path.join(tmpdir(), 'factory-cli-')), 'factory');
  writeFileSync(binary, 'binary 0.4.0+');
  writeFileSync(`${binary}.previous`, 'binary 0.3.0');
  writePreviousRecord(binary, { schema: SCHEMA_VERSION - 1, version: '0.3.0' });

  const asked = await run(['--rollback'], { binary, factoryRoot });
  assert.equal(asked.code, 1);
  assert.match(asked.out.join('\n'), /restores .*state\.schema-\d+\.sqlite[\s\S]*--rollback --yes/);
  assert.equal(readFileSync(binary, 'utf8'), 'binary 0.4.0+');

  const done = await run(['--rollback', '--yes'], { binary, factoryRoot });
  assert.equal(done.code, 0, done.err.join('\n'));
  assert.match(done.out[0] ?? '', /^Rolled back to factory 0\.3\.0, with the database from /);
  assert.equal(readFileSync(binary, 'utf8'), 'binary 0.3.0');
  assert.deepEqual(readFileSync(databasePath), readFileSync(backup));
  assert.equal(readUpdateState(factoryRoot).later, '0.4.0');
});

test('rollback refuses with no factory.previous', async () => {
  const binary = path.join(mkdtempSync(path.join(tmpdir(), 'factory-cli-')), 'factory');
  writeFileSync(binary, 'binary');
  const refused = await run(['--rollback'], { binary });
  assert.equal(refused.code, 1);
  assert.match(refused.err.join('\n'), /no .*factory\.previous to roll back to/);
});

// A factory whose database is on `stored`, with factory.previous on `previous`
// and a backup from an upgrade of `previous` beside it.
function rolledForward(input: { previous: number }) {
  const factoryRoot = mkdtempSync(path.join(tmpdir(), 'factory-cli-root-'));
  const db = openStateDatabase(factoryRoot, { create: true });
  const databasePath = stateDatabasePath(factoryRoot);
  const backup = upgradeBackupPath(databasePath, input.previous);
  db.exec(`VACUUM INTO '${backup}'`);
  db.close();
  const binary = path.join(mkdtempSync(path.join(tmpdir(), 'factory-cli-')), 'factory');
  writeFileSync(binary, 'binary 0.4.0+');
  writeFileSync(`${binary}.previous`, 'binary 0.3.0');
  writePreviousRecord(binary, { schema: input.previous, version: '0.3.0' });
  return { backup, binary, databasePath, factoryRoot };
}

test('after an update no server ran, rollback only swaps the binaries', async () => {
  // factory.previous runs the schema the database is still on; the backup
  // is from an older upgrade and must stay out of it.
  const { binary, databasePath, factoryRoot } = rolledForward({ previous: SCHEMA_VERSION });
  const before = readFileSync(databasePath);
  const done = await run(['--rollback'], { binary, factoryRoot });
  assert.equal(done.code, 0, done.err.join('\n'));
  assert.equal(done.out[0], 'Rolled back to factory 0.3.0; the next factory serve runs it.');
  assert.equal(readFileSync(binary, 'utf8'), 'binary 0.3.0');
  assert.deepEqual(readFileSync(databasePath), before);
});

test('a restore that fails puts the binaries back, and says nothing changed', async () => {
  const { binary, databasePath, factoryRoot } = rolledForward({ previous: SCHEMA_VERSION - 1 });
  // Where the restore copies the backup first.
  mkdirSync(`${databasePath}.restore`);
  const failed = await run(['--rollback', '--yes'], { binary, factoryRoot });
  assert.equal(failed.code, 1);
  assert.match(failed.err.join('\n'), /^Could not restore .*, so nothing changed/);
  assert.equal(readFileSync(binary, 'utf8'), 'binary 0.4.0+');
  assert.equal(readFileSync(`${binary}.previous`, 'utf8'), 'binary 0.3.0');
});
