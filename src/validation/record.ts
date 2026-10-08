import type { DatabaseSync } from 'node:sqlite';
import type { ExecutionId, RunId } from '../domain.ts';
import type { ValidationCheckDraft } from './plan.ts';

export function writeValidation(
  db: DatabaseSync,
  input: {
    checks: Array<ValidationCheckDraft>;
    executionId: ExecutionId;
    id: string;
    now: string;
    resultHash: string | null;
    runId: RunId;
    status: 'passed' | 'failed' | 'error';
    summary: string | null;
    validatorVersion: string;
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
    input.validatorVersion,
    input.resultHash,
    input.now,
  );
  input.checks.forEach((check, index) => {
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
  ).run(input.status, input.summary, input.now, input.id);
}

export function writePlanValidation(
  db: DatabaseSync,
  input: {
    checks: Array<ValidationCheckDraft>;
    executionId: ExecutionId;
    id: string;
    now: string;
    passed: boolean;
    resultHash: string;
    runId: RunId;
  },
): void {
  writeValidation(db, {
    checks: input.checks,
    executionId: input.executionId,
    id: input.id,
    now: input.now,
    resultHash: input.resultHash,
    runId: input.runId,
    status: input.passed ? 'passed' : 'failed',
    summary: null,
    validatorVersion: 'plan.v3',
  });
}
