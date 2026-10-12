import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { ExecutionId } from '../domain.ts';
import { usageRows } from './usage.ts';

// A database that answers the by-stage query with one row per given stage.
function fakeDb(stages: Array<string>): DatabaseSync {
  const byStage = stages.map((stage) => ({
    cache_read: 10,
    cache_write: 1,
    cost: 1000,
    input: 2,
    models: 'm',
    output: 3,
    sessions: 1,
    stage,
    total: 16,
  }));
  return {
    prepare: (sql: string) => ({
      all: () => (sql.includes('GROUP BY s.stage') && !sql.includes('context') ? byStage : []),
      get: () => ({ sessions: stages.length }),
    }),
  } as unknown as DatabaseSync;
}

test('the usage table has a row for every stage that ran, QA included', () => {
  const rows = usageRows(fakeDb(['plan', 'work', 'qa', 'review', 'wrapup']), 'e1' as ExecutionId, {
    includeWrapup: true,
  });
  assert.deepEqual(
    rows.map((row) => row.label),
    ['Plan', 'Work', 'QA', 'Review', 'Wrap-up', 'Total'],
  );
});
