import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, test } from 'node:test';
import {
  IncompatibleFactoryDatabaseError,
  openStateDatabase,
  stateDatabasePath,
} from './database.ts';

const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

// A database written by a schema 2 controller, with a ticket in flight.
function schema2Root(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'factory-upgrade-'));
  roots.push(root);
  const file = stateDatabasePath(root);
  mkdirSync(path.dirname(file), { recursive: true });
  const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')
    .replace('CHECK (schema_version = 3)', 'CHECK (schema_version = 2)')
    .replace('VALUES (1, 3);', 'VALUES (1, 2);')
    .replace('PRAGMA user_version = 3;', 'PRAGMA user_version = 2;');
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

test('a schema 2 database is refused with what to do, and left as it was', () => {
  const root = schema2Root();
  for (const options of [{}, { create: true }, { readOnly: true }]) {
    assert.throws(
      () => openStateDatabase(root, options),
      (error: unknown) =>
        error instanceof IncompatibleFactoryDatabaseError &&
        /is schema 2; this controller needs schema 3/.test(error.message) &&
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
