import type { DatabaseSync } from 'node:sqlite';
import { applyControllerEvent } from '../controller/store.ts';
import type { ActionId, ControllerEvent, ExecutionId, IdSource, RunId } from '../domain.ts';
import type {
  StageValidationReport,
  ValidatedStage,
  ValidationCheck,
  ValidationReport,
} from './report.ts';

type ValidationFinished = Extract<ControllerEvent, { kind: 'validation_finished' }>;

// The one way a validation result reaches the controller: the report is
// written to validation_runs/validation_checks and the controller applies it
// in the same transaction. A result for an action that already finished
// (a late background validation) is neither written nor applied.
export function recordValidation<S extends ValidatedStage>(
  input: { db: DatabaseSync; ids: IdSource; now: () => string },
  validation: {
    actionId: ActionId;
    executionId: ExecutionId;
    report: StageValidationReport<S>;
    resultHash: string | null;
    runId: RunId;
    stage: S;
  },
): void {
  const { actionId, executionId, report, resultHash, runId, stage } = validation;
  const id = input.ids.event();
  const now = input.now();
  // TypeScript cannot tie a generic `stage` to its `report`; the signature does.
  const event = { actionId, kind: 'validation_finished', report, runId, stage } as ValidationFinished;
  applyControllerEvent(input.db, {
    dedupeKey: `validation:${actionId}`,
    event,
    ids: input.ids,
    now,
    prepare: (db) => {
      if (actionFinished(db, actionId)) {
        return;
      }
      writeValidation(db, { executionId, id, now, report, resultHash, runId });
    },
    source: 'validator',
  });
}

function actionFinished(db: DatabaseSync, id: ActionId): boolean {
  const row = db.prepare('SELECT status FROM actions WHERE id = ?').get(id);
  const status =
    typeof row === 'object' && row !== null && 'status' in row && typeof row.status === 'string'
      ? row.status
      : '';
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function writeValidation(
  db: DatabaseSync,
  input: {
    executionId: ExecutionId;
    id: string;
    now: string;
    report: ValidationReport<unknown, unknown>;
    resultHash: string | null;
    runId: RunId;
  },
): void {
  const attemptRow = db
    .prepare('SELECT count(*) AS count FROM validation_runs WHERE run_id = ?')
    .get(input.runId);
  const count =
    typeof attemptRow === 'object' &&
    attemptRow !== null &&
    'count' in attemptRow &&
    typeof attemptRow.count === 'number'
      ? attemptRow.count
      : 0;
  db.prepare(
    `INSERT INTO validation_runs
      (id, execution_id, run_id, attempt, validator_version, input_hash, status, summary, started_at)
     VALUES (?, ?, ?, ?, ?, ?, 'running', NULL, ?)`,
  ).run(
    input.id,
    input.executionId,
    input.runId,
    count + 1,
    input.report.version,
    input.resultHash,
    input.now,
  );
  input.report.checks.forEach((check: ValidationCheck, index) => {
    db.prepare(
      `INSERT INTO validation_checks
        (validation_id, ordinal, name, kind, status, command, exit_code, duration_ms,
         output_excerpt, details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      index + 1,
      check.name,
      check.kind,
      check.status,
      check.command ?? null,
      check.exitCode ?? null,
      check.durationMs ?? null,
      check.outputExcerpt ?? null,
      JSON.stringify({ details: check.details }),
    );
  });
  db.prepare(
    'UPDATE validation_runs SET status = ?, summary = ?, completed_at = ? WHERE id = ?',
  ).run(input.report.status, input.report.summary, input.now, input.id);
}
