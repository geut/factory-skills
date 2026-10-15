import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { randomIds, type Actor } from '../domain.ts';
import { openStateDatabase } from '../state/database.ts';
import { blank } from '../stories/fixtures.ts';
import { applyControllerEvent, loadCurrentByTicketKey } from './store.ts';

const roots: Array<string> = [];
const now = '2026-10-11T00:00:00.000Z';

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

// A started ticket, so its execution loads through the store.
function started(actor: Actor | null = null) {
  const root = mkdtempSync(path.join(tmpdir(), 'factory-store-'));
  roots.push(root);
  const db = openStateDatabase(root, { create: true });
  const { execution, ticket } = blank();
  applyControllerEvent(db, {
    actor,
    dedupeKey: 'start',
    event: {
      kind: 'start',
      policy: execution.policy,
      ticket: {
        body: ticket.body,
        commandRef: ticket.commandRef,
        contentHash: 'content-hash',
        displayRef: ticket.displayRef,
        factoryDir: path.join(root, 'tickets/demo'),
        fetchedAt: now,
        id: ticket.id,
        labels: [],
        sourceKind: 'text',
        sourceRef: ticket.sourceRef,
        title: ticket.title,
      },
    },
    ids: randomIds(),
    now,
    source: 'action',
  });
  const snapshot = loadCurrentByTicketKey(db, ticket.id);
  if (snapshot === null) {
    throw new Error('the ticket did not start');
  }
  const addSession = (id: string, stage: string, task: string | null) =>
    db
      .prepare(
        `INSERT INTO agent_sessions (id, execution_id, logical_key, stage, task_id, model, status)
         VALUES (?, ?, ?, ?, ?, 'model', 'completed')`,
      )
      .run(id, snapshot.execution.id, id, stage, task);
  return { addSession, db, ticketId: ticket.id };
}

test('a per-task stage session without a task does not load', () => {
  const { addSession, db, ticketId } = started();
  addSession('work-without-task', 'work', null);
  assert.throws(() => loadCurrentByTicketKey(db, ticketId), /a work session needs a task/);
  db.close();
});

test('a stage the registry does not know does not load', () => {
  const { addSession, db, ticketId } = started();
  addSession('removed-stage', 'triage', null);
  assert.throws(() => loadCurrentByTicketKey(db, ticketId), /unknown stage triage/);
  db.close();
});

test('a command records the API client behind it on its event', () => {
  const { db } = started({ client: 'dashboard', onBehalfOf: 'diego' });
  const event = db
    .prepare("SELECT actor, actor_on_behalf_of FROM events WHERE dedupe_key = 'start'")
    .get();
  assert.deepEqual({ ...event }, { actor: 'dashboard', actor_on_behalf_of: 'diego' });
  db.close();
});
