import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { openStateDatabase } from '../state/database.ts';
import { requeueOrphanedPanes } from './store.ts';

const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

test('restart requeues a pane action that a stopped controller still leased', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'factory-panes-'));
  roots.push(root);
  const db = openStateDatabase(root, { create: true });
  db.exec(`
    INSERT INTO tickets (id, title, source_kind) VALUES ('t1', 'Ticket', 'local');
    INSERT INTO ticket_executions (id, ticket_id, generation, stage, status, factory_dir)
      VALUES ('e1', 't1', 1, 'wrapup', 'ready_for_handoff', '/f');
    INSERT INTO actions
      (id, execution_id, kind, status, idempotency_key, attempts, max_attempts,
       lease_owner, lease_token, lease_expires_at)
    VALUES
      ('diff', 'e1', 'open_diff', 'leased', 'pane:diff', 0, 3, 'gone', 'token-1', '2026-10-10T00:00:00.000Z'),
      ('last', 'e1', 'open_pane', 'leased', 'pane:session', 3, 3, 'gone', 'token-2', '2026-10-10T00:00:00.000Z');
  `);
  requeueOrphanedPanes(db, '2026-10-10T00:01:00.000Z');
  const rows = db
    .prepare('SELECT id, status, attempts, lease_token, last_error FROM actions ORDER BY id')
    .all()
    .map((item) => ({ ...item }));
  assert.deepEqual(rows, [
    { attempts: 1, id: 'diff', last_error: null, lease_token: null, status: 'pending' },
    {
      attempts: 3,
      id: 'last',
      last_error: 'Pane lease expired.',
      lease_token: null,
      status: 'failed',
    },
  ]);
  // The execution stays ready for handoff: a pane never fails it.
  assert.equal(
    db.prepare("SELECT status FROM ticket_executions WHERE id = 'e1'").get()?.['status'],
    'ready_for_handoff',
  );
  db.close();
});
