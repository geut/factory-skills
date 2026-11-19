import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { upgradeBackupPath } from '../state/database.ts';
import { previousPath } from './install.ts';
import {
  lossSince,
  planRollback,
  readPreviousRecord,
  restoreDatabase,
  rollbackQuestion,
  swapBack,
  writePreviousRecord,
} from './rollback.ts';

// A binary with factory.previous beside it, and a database path.
function installed(previous?: { schema: number; version: string }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'factory-rollback-'));
  const binary = path.join(dir, 'factory');
  writeFileSync(binary, 'factory 0.6.0');
  writeFileSync(previousPath(binary), 'factory 0.5.0');
  if (previous !== undefined) {
    writePreviousRecord(binary, previous);
  }
  const databasePath = path.join(dir, 'db', 'state.sqlite');
  mkdirSync(path.dirname(databasePath));
  return { binary, databasePath };
}

const current = { schema: 9, version: '0.6.0' };
const noLoss = () => ({ events: 0, tickets: [] });
// The database as the running version upgraded it.
const storedSchema = 9;

test('with no factory.previous, or one no update put there, rollback refuses and says why', () => {
  const { binary, databasePath } = installed();
  const unknown = planRollback({ binary, current, databasePath, loss: noLoss, storedSchema });
  assert.equal(unknown.kind, 'refused');
  assert.match(
    unknown.kind === 'refused' ? unknown.message : '',
    /not put there by factory update/,
  );

  const dir = mkdtempSync(path.join(tmpdir(), 'factory-rollback-'));
  const none = planRollback({
    binary: path.join(dir, 'factory'),
    current,
    databasePath,
    loss: noLoss,
    storedSchema,
  });
  assert.match(
    none.kind === 'refused' ? none.message : '',
    /no .*factory\.previous to roll back to/,
  );
});

test('a previous version on the same schema rolls back without touching the database', () => {
  const { binary, databasePath } = installed({ schema: 9, version: '0.5.0' });
  assert.deepEqual(planRollback({ binary, current, databasePath, loss: noLoss, storedSchema }), {
    kind: 'ready',
    previous: { schema: 9, version: '0.5.0' },
    restore: null,
  });
});

test('across a schema upgrade, rollback needs the backup the upgrade made', () => {
  const { binary, databasePath } = installed({ schema: 8, version: '0.5.0' });
  const missing = planRollback({ binary, current, databasePath, loss: noLoss, storedSchema });
  assert.match(
    missing.kind === 'refused' ? missing.message : '',
    /upgraded from schema 8 to 9, and the backup the upgrade made, .*state\.schema-8\.sqlite, is gone/,
  );

  writeFileSync(upgradeBackupPath(databasePath, 8), 'schema 8');
  const plan = planRollback({
    binary,
    current,
    databasePath,
    loss: () => ({ events: 12, tickets: ['geut/app#7', 'geut/app#9'] }),
    storedSchema,
  });
  assert.equal(plan.kind, 'ready');
  if (plan.kind !== 'ready') {
    return;
  }
  assert.equal(plan.restore?.backup, upgradeBackupPath(databasePath, 8));
  assert.match(
    rollbackQuestion({ current: '0.6.0', plan }),
    /^Rolling back from factory 0\.6\.0 to 0\.5\.0 restores .*state\.schema-8\.sqlite, the database as it was at .*, before it was upgraded\. Everything recorded since is lost: 12 events for geut\/app#7, geut\/app#9\.$/,
  );
});

test('a database no server upgraded is left alone, even with an older backup beside it', () => {
  // factory update swapped the binary with no server running: the database
  // is still on the schema factory.previous runs.
  const { binary, databasePath } = installed({ schema: 8, version: '0.5.0' });
  writeFileSync(upgradeBackupPath(databasePath, 8), 'an upgrade weeks ago');
  assert.deepEqual(planRollback({ binary, current, databasePath, loss: noLoss, storedSchema: 8 }), {
    kind: 'ready',
    previous: { schema: 8, version: '0.5.0' },
    restore: null,
  });
  // No database yet: nothing to restore either.
  assert.equal(
    planRollback({ binary, current, databasePath, loss: noLoss, storedSchema: null }).kind,
    'ready',
  );
});

test('what a restore loses: the events after the backup, and their tickets', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'factory-loss-'));
  const make = (file: string, revisions: Array<[number, string]>) => {
    const db = new DatabaseSync(path.join(dir, file));
    db.exec(`
      CREATE TABLE tickets (id TEXT PRIMARY KEY, source_ref TEXT);
      CREATE TABLE ticket_executions (id TEXT PRIMARY KEY, ticket_id TEXT);
      CREATE TABLE events (revision INTEGER PRIMARY KEY, execution_id TEXT);
      INSERT INTO tickets VALUES ('t1', 'geut/app#7'), ('t2', NULL);
      INSERT INTO ticket_executions VALUES ('x1', 't1'), ('x2', 't2');
    `);
    for (const [revision, execution] of revisions) {
      db.prepare('INSERT INTO events VALUES (?, ?)').run(revision, execution);
    }
    return db;
  };
  make('backup.sqlite', [[1, 'x1']]).close();
  make('state.sqlite', [
    [1, 'x1'],
    [2, 'x1'],
    [3, 'x2'],
  ]).close();
  assert.deepEqual(
    lossSince({
      backup: path.join(dir, 'backup.sqlite'),
      databasePath: path.join(dir, 'state.sqlite'),
    }),
    { events: 2, tickets: ['geut/app#7', 't2'] },
  );
});

test('rolling back swaps the binaries, so rolling back again goes forward', () => {
  const { binary } = installed({ schema: 8, version: '0.5.0' });
  swapBack({ binary, current });
  assert.equal(readFileSync(binary, 'utf8'), 'factory 0.5.0');
  assert.equal(readFileSync(previousPath(binary), 'utf8'), 'factory 0.6.0');
  assert.deepEqual(readPreviousRecord(binary), current);
  assert.equal(existsSync(`${binary}.rollback`), false);
});

test('restoring puts the backup in place and drops the write-ahead log', () => {
  const { databasePath } = installed();
  writeFileSync(databasePath, 'schema 9');
  writeFileSync(`${databasePath}-wal`, 'log');
  writeFileSync(`${databasePath}-shm`, 'index');
  const backup = upgradeBackupPath(databasePath, 8);
  writeFileSync(backup, 'schema 8');
  restoreDatabase({ backup, databasePath });
  assert.equal(readFileSync(databasePath, 'utf8'), 'schema 8');
  assert.equal(existsSync(`${databasePath}-wal`), false);
  assert.equal(existsSync(`${databasePath}-shm`), false);
  // The backup stays.
  assert.equal(readFileSync(backup, 'utf8'), 'schema 8');
});
