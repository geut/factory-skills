import type { DatabaseSync } from 'node:sqlite';
import type { ExecutionId, RunId } from '../domain.ts';
import type { ValidationCheckDraft } from './plan.ts';

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
      (id, execution_id, run_id, attempt, validator_version, input_hash, status, started_at)
     VALUES (?, ?, ?, ?, 'plan.v3', ?, 'running', ?)`,
  ).run(input.id, input.executionId, input.runId, count + 1, input.resultHash, input.now);
  input.checks.forEach((check, index) => {
    db.prepare(
      `INSERT INTO validation_checks (validation_id, ordinal, name, kind, status, details_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      index + 1,
      check.name,
      check.kind,
      check.status,
      JSON.stringify({ details: check.details }),
    );
  });
  db.prepare('UPDATE validation_runs SET status = ?, completed_at = ? WHERE id = ?').run(
    input.passed ? 'passed' : 'failed',
    input.now,
    input.id,
  );
}
