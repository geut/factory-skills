import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, test } from 'node:test';
import {
  IncompatibleFactoryDatabaseError,
  openStateDatabase,
  SCHEMA_VERSION,
  stateDatabasePath,
  upgradeBackupPath,
} from './database.ts';

const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const schema3 = readFileSync(new URL('./fixtures/schema-3.sql', import.meta.url), 'utf8');

// A database written by an older controller, with a ticket in flight.
function oldRoot(version: 2 | 3): string {
  const root = mkdtempSync(path.join(tmpdir(), 'factory-upgrade-'));
  roots.push(root);
  const file = stateDatabasePath(root);
  mkdirSync(path.dirname(file), { recursive: true });
  const schema = schema3
    .replace('CHECK (schema_version = 3)', `CHECK (schema_version = ${version})`)
    .replace('VALUES (1, 3);', `VALUES (1, ${version});`)
    .replace('PRAGMA user_version = 3;', `PRAGMA user_version = ${version};`);
  const db = new DatabaseSync(file);
  db.exec(schema);
  db.exec(`
    INSERT INTO tickets (id, title, source_kind) VALUES ('t1', 'Ticket', 'local');
    INSERT INTO ticket_executions (id, ticket_id, generation, stage, status, factory_dir)
      VALUES ('e1', 't1', 1, 'review', 'active', '/f');
  `);
  db.close();
  return root;
}

function freshRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'factory-upgrade-'));
  roots.push(root);
  openStateDatabase(root, { create: true }).close();
  return root;
}

// Every table, column, index, view, and trigger, without the SQL text that a
// rename rewrites.
function shape(root: string): Array<string> {
  const db = new DatabaseSync(stateDatabasePath(root), { readOnly: true });
  const objects = db
    .prepare(
      "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all();
  const rows = objects.map((item) => `${String(item['type'])} ${String(item['name'])}`);
  for (const item of objects) {
    if (item['type'] !== 'table') {
      continue;
    }
    for (const column of db.prepare(`PRAGMA table_info(${String(item['name'])})`).all()) {
      rows.push(
        `column ${String(item['name'])}.${String(column['name'])} ${String(column['type'])} ${String(column['notnull'])} ${String(column['pk'])}`,
      );
    }
  }
  db.close();
  return rows.sort();
}

test('a schema 2 database is refused with what to do, and left as it was', () => {
  const root = oldRoot(2);
  for (const options of [{}, { create: true }, { readOnly: true }]) {
    assert.throws(
      () => openStateDatabase(root, options),
      (error: unknown) =>
        error instanceof IncompatibleFactoryDatabaseError &&
        /is schema 2; this controller needs schema \d+ and only upgrades schema 3/.test(
          error.message,
        ) &&
        /Finish or cancel its tickets/.test(error.message),
    );
  }
  const db = new DatabaseSync(stateDatabasePath(root));
  assert.equal(db.prepare('PRAGMA user_version').get()?.['user_version'], 2);
  assert.equal(
    db.prepare("SELECT stage FROM ticket_executions WHERE id = 'e1'").get()?.['stage'],
    'review',
  );
  db.close();
});

test('a schema 3 database upgrades in place and keeps its tickets', () => {
  const root = oldRoot(3);
  const db = openStateDatabase(root);
  assert.equal(db.prepare('PRAGMA user_version').get()?.['user_version'], SCHEMA_VERSION);
  assert.equal(
    db.prepare('SELECT schema_version FROM schema_meta').get()?.['schema_version'],
    SCHEMA_VERSION,
  );
  assert.equal(
    db.prepare("SELECT stage FROM ticket_executions WHERE id = 'e1'").get()?.['stage'],
    'review',
  );
  db.close();
  assert.deepEqual(shape(root), shape(freshRoot()));
});

test('a schema 3 database opened read-only is refused and left as it was', () => {
  const root = oldRoot(3);
  assert.throws(
    () => openStateDatabase(root, { readOnly: true }),
    (error: unknown) =>
      error instanceof IncompatibleFactoryDatabaseError &&
      /open it read-write once to upgrade it/.test(error.message),
  );
  const db = new DatabaseSync(stateDatabasePath(root));
  assert.equal(db.prepare('PRAGMA user_version').get()?.['user_version'], 3);
  db.close();
});

test('an upgrade first copies the database as it was, and the copy keeps its tickets', () => {
  const root = oldRoot(3);
  openStateDatabase(root).close();
  const backup = upgradeBackupPath(stateDatabasePath(root), 3);
  const db = new DatabaseSync(backup, { readOnly: true });
  assert.equal(db.prepare('PRAGMA user_version').get()?.['user_version'], 3);
  assert.equal(db.prepare('SELECT schema_version FROM schema_meta').get()?.['schema_version'], 3);
  assert.equal(
    db.prepare("SELECT stage FROM ticket_executions WHERE id = 'e1'").get()?.['stage'],
    'review',
  );
  db.close();
  assert.deepEqual(
    readdirSync(path.dirname(backup)).filter((name) => name.includes('schema-')),
    ['state.schema-3.sqlite'],
  );
});

test('a database that needs no upgrade is not copied', () => {
  const root = freshRoot();
  openStateDatabase(root).close();
  assert.deepEqual(
    readdirSync(path.dirname(stateDatabasePath(root))).filter((name) => name.includes('schema-')),
    [],
  );
});

test('a copy that fails stops the upgrade and leaves the database as it was', () => {
  const root = oldRoot(3);
  const backup = upgradeBackupPath(stateDatabasePath(root), 3);
  // A directory in the way makes the rename into place fail.
  mkdirSync(path.join(backup, 'in-the-way'), { recursive: true });
  assert.throws(
    () => openStateDatabase(root),
    (error: unknown) =>
      error instanceof Error &&
      /could not back up .* before upgrading it from schema 3 to \d+; the database was not upgraded/.test(
        error.message,
      ),
  );
  const db = new DatabaseSync(stateDatabasePath(root));
  assert.equal(db.prepare('PRAGMA user_version').get()?.['user_version'], 3);
  db.close();
  assert.deepEqual(
    readdirSync(path.dirname(backup)).filter((name) => name.endsWith('.partial')),
    [],
  );
});
