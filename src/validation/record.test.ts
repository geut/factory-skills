import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, test } from 'node:test';
import { applyControllerEvent, loadCurrentByTicketKey } from '../controller/store.ts';
import { randomIds, zeroUsage, type ActionRecord, type ControllerEvent } from '../domain.ts';
import { openStateDatabase } from '../state/database.ts';
import { blank } from '../stories/fixtures.ts';
import { recordValidation } from './record.ts';
import { failedReport, passedReport } from './report.ts';

const roots: Array<string> = [];
const now = () => '2026-10-10T00:00:00.000Z';

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

// A ticket whose plan run finished, so its plan validation is pending.
function pendingPlanValidation() {
  const root = mkdtempSync(path.join(tmpdir(), 'factory-record-'));
  roots.push(root);
  const db = openStateDatabase(root, { create: true });
  const { execution, ticket } = blank();
  const send = (event: ControllerEvent, dedupeKey: string) =>
    applyControllerEvent(db, { dedupeKey, event, ids: randomIds(), now: now(), source: 'action' });
  const resolved = {
    body: ticket.body,
    commandRef: ticket.commandRef,
    contentHash: 'content-hash',
    displayRef: ticket.displayRef,
    factoryDir: path.join(root, 'tickets/demo'),
    fetchedAt: now(),
    id: ticket.id,
    labels: [],
    sourceKind: 'text' as const,
    sourceRef: ticket.sourceRef,
    title: ticket.title,
  };
  send({ kind: 'start', policy: execution.policy, ticket: resolved }, 'start');
  const launch = loadCurrentByTicketKey(db, ticket.id)?.actions.find(
    (item) => item.kind === 'launch_run',
  );
  if (launch?.kind !== 'launch_run') {
    throw new Error('the plan run was not launched');
  }
  send(
    {
      actionId: launch.id,
      kind: 'run_started',
      paneId: 'pane-1',
      paneName: 'plan',
      piSessionId: 'pi-1',
      runId: launch.runId,
      sessionFile: path.join(root, 'plan.jsonl'),
    },
    'started',
  );
  applyControllerEvent(db, {
    dedupeKey: 'terminal',
    event: {
      kind: 'runtime_terminal',
      runId: launch.runId,
      terminal: { kind: 'subagent_done', output: '', usage: zeroUsage() },
    },
    ids: randomIds(),
    now: now(),
    source: 'runtime',
  });
  const snapshot = loadCurrentByTicketKey(db, ticket.id);
  const action = snapshot?.actions.find((item) => item.kind === 'validate_run');
  const run = snapshot?.runs.find((item) => item.id === launch.runId);
  if (snapshot === null || snapshot === undefined || action === undefined || run === undefined) {
    throw new Error('plan validation is not pending');
  }
  return { action, db, executionId: snapshot.execution.id, run, ticketId: ticket.id };
}

function record(
  harness: ReturnType<typeof pendingPlanValidation>,
  report: Parameters<typeof recordValidation<'plan'>>[1]['report'],
) {
  recordValidation(
    { db: harness.db, ids: randomIds(), now },
    {
      actionId: harness.action.id,
      executionId: harness.executionId,
      report,
      resultHash: harness.run.resultHash,
      runId: harness.run.id,
      stage: 'plan',
    },
  );
}

function rows(db: DatabaseSync, sql: string): Array<Record<string, unknown>> {
  return db
    .prepare(sql)
    .all()
    .map((item) => ({ ...item }));
}

const failure = failedReport(
  'plan.v3',
  [{ details: 'plan.md is missing.', kind: 'artifact', name: 'plan.md', status: 'failed' }],
  ['plan.md is missing.'],
  null,
);

test('a report is written with its checks and applied in one step', () => {
  const harness = pendingPlanValidation();
  record(harness, failure);
  assert.deepEqual(
    rows(
      harness.db,
      'SELECT attempt, validator_version, input_hash, status, summary FROM validation_runs',
    ),
    [
      {
        attempt: 1,
        input_hash: harness.run.resultHash,
        status: 'failed',
        summary: 'plan.md is missing.',
        validator_version: 'plan.v3',
      },
    ],
  );
  assert.deepEqual(rows(harness.db, 'SELECT ordinal, name, kind, status FROM validation_checks'), [
    { kind: 'artifact', name: 'plan.md', ordinal: 1, status: 'failed' },
  ]);
  // The controller took the failure: the action finished and a correction is queued.
  const snapshot = loadCurrentByTicketKey(harness.db, harness.ticketId);
  const action = snapshot?.actions.find((item: ActionRecord) => item.id === harness.action.id);
  assert.equal(action?.status, 'succeeded');
  assert.ok(snapshot?.runs.some((item) => item.purpose === 'validation_correction'));
  harness.db.close();
});

test('the same action reports once; a repeat writes and applies nothing', () => {
  const harness = pendingPlanValidation();
  record(harness, failure);
  const before = loadCurrentByTicketKey(harness.db, harness.ticketId);
  record(harness, passedReport('plan.v3', [], { planPath: 'plan.md', tasks: [] }));
  assert.equal(rows(harness.db, 'SELECT id FROM validation_runs').length, 1);
  assert.deepEqual(loadCurrentByTicketKey(harness.db, harness.ticketId), before);
  harness.db.close();
});

test('a result for an action that already finished is not written', () => {
  const harness = pendingPlanValidation();
  // A background validation outlived its action, which was cancelled meanwhile.
  harness.db
    .prepare("UPDATE actions SET status = 'cancelled', completed_at = ? WHERE id = ?")
    .run(now(), harness.action.id);
  record(harness, failure);
  assert.equal(rows(harness.db, 'SELECT id FROM validation_runs').length, 0);
  harness.db.close();
});
