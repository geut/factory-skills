import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, test } from 'node:test';
import { openStateDatabase, stateDatabasePath } from './database.ts';

const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

// A schema 2 database created before the wrap-up action kinds existed.
function legacyRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'factory-upgrade-'));
  roots.push(root);
  const file = stateDatabasePath(root);
  mkdirSync(path.dirname(file), { recursive: true });
  const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8').replace(
    "'open_diff',\n      'prepare_wrapup_input', 'open_pane'",
    "'open_diff'",
  );
  assert.doesNotMatch(schema, /prepare_wrapup_input/);
  const db = new DatabaseSync(file);
  db.exec(schema);
  db.exec(`
    INSERT INTO tickets (id, title, source_kind) VALUES ('t1', 'Ticket', 'local');
    INSERT INTO ticket_executions (id, ticket_id, generation, stage, status, factory_dir)
      VALUES ('e1', 't1', 1, 'review', 'active', '/f');
    INSERT INTO actions (id, execution_id, kind, status, idempotency_key, completed_at)
      VALUES ('a1', 'e1', 'prepare_worktree', 'succeeded', 'k1', '2026-10-10T00:00:00.000Z');
  `);
  db.close();
  return root;
}

function tableSql(db: DatabaseSync, type: string, name: string): string {
  const found = db
    .prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?')
    .get(type, name);
  return typeof found?.['sql'] === 'string' ? found['sql'] : '';
}

test('opening an older schema 2 database widens the action kinds and keeps its rows', () => {
  const root = legacyRoot();
  const db = openStateDatabase(root);
  assert.match(tableSql(db, 'table', 'actions'), /'prepare_wrapup_input', 'open_pane'/);
  assert.equal(db.prepare('SELECT schema_version FROM schema_meta').get()?.['schema_version'], 2);
  assert.equal(db.prepare('PRAGMA user_version').get()?.['user_version'], 2);
  assert.equal(
    db.prepare('SELECT status FROM actions WHERE id = ?').get('a1')?.['status'],
    'succeeded',
  );
  for (const index of [
    'dispatchable_actions',
    'one_active_validation_per_execution',
    'one_start_action_per_run',
  ]) {
    assert.notEqual(tableSql(db, 'index', index), '', index);
  }
  for (const trigger of ['terminal_action_is_immutable', 'terminal_action_cannot_be_deleted']) {
    assert.notEqual(tableSql(db, 'trigger', trigger), '', trigger);
  }
  // The new kinds insert, and the old guards still hold.
  db.exec(`INSERT INTO actions (id, execution_id, kind, status, idempotency_key)
           VALUES ('a2', 'e1', 'prepare_wrapup_input', 'pending', 'k2')`);
  assert.throws(() => db.exec("UPDATE actions SET status = 'pending' WHERE id = 'a1'"));
  assert.throws(() =>
    db.exec(`INSERT INTO actions (id, execution_id, kind, status, idempotency_key)
             VALUES ('a3', 'e1', 'not_a_kind', 'pending', 'k3')`),
  );
  assert.equal(db.prepare('PRAGMA foreign_keys').get()?.['foreign_keys'], 1);
  db.close();
  // A second open finds nothing to do.
  const again = openStateDatabase(root);
  assert.match(tableSql(again, 'table', 'actions'), /'open_pane'/);
  again.close();
});

test('a read-only open leaves an older database untouched', () => {
  const root = legacyRoot();
  const db = openStateDatabase(root, { readOnly: true });
  assert.doesNotMatch(tableSql(db, 'table', 'actions'), /prepare_wrapup_input/);
  db.close();
});
