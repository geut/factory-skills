import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addTasks, blank, review, run, session } from '../../stories/fixtures.ts';
import { wrapup } from './definition.ts';

test('wrap-up is given each task’s review verification, gaps included', () => {
  const snapshot = blank();
  addTasks(snapshot, 1);
  snapshot.execution.worktreePath = '/repo/.factory/worktrees/demo';
  run(snapshot, session(snapshot, 'review', '01'), {
    output: review(
      'approve',
      'none',
      undefined,
      ['- AC1: verified — src/a.ts:4', '- AC2: not_verified — needs a real browser'].join('\n'),
    ),
    round: 1,
  });
  const input = wrapup.input?.(
    { snapshot, task: null },
    {
      handoff: null,
      prepared: {
        adrPath: null,
        baseline: '{}',
        contextPath: null,
        screenshots: [],
        usage: '',
        verification: [],
      },
      round: 0,
    },
  );
  const text = wrapup.turn({ input: input ?? assert.fail('no input'), kind: 'initial' });
  assert.match(
    text,
    /Review verification:\n- Task 01 AC1: verified — src\/a\.ts:4\n- Task 01 AC2: not_verified — needs a real browser\n/,
  );
});
