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
        testPlan: [],
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

test('wrap-up is given the issue’s open boxes as B1..Bn and each task’s QA test plan', () => {
  const snapshot = blank();
  snapshot.execution.worktreePath = '/repo/.factory/worktrees/demo';
  snapshot.ticket.body =
    '## Done when\n\n- [x] The README says so.\n- [ ] A reload keeps the filter.\n- [ ] The filter is labelled.\n';
  const prepared = {
    adrPath: null,
    baseline: '{}',
    contextPath: null,
    screenshots: [],
    testPlan: ['Task 01 AC1: e2e/filter.e2e.ts › survives a reload'],
    usage: '',
    verification: [],
  };
  const turn = () => {
    const input = wrapup.input?.({ snapshot, task: null }, { handoff: null, prepared, round: 0 });
    return wrapup.turn({ input: input ?? assert.fail('no input'), kind: 'initial' });
  };
  const text = turn();
  assert.match(
    text,
    /Issue checkboxes \(one ## Issue checklist line each\):\n- B1: A reload keeps the filter\.\n- B2: The filter is labelled\.\n/,
  );
  assert.match(text, /QA test plan:\n- Task 01 AC1: e2e\/filter\.e2e\.ts › survives a reload\n/);
  assert.match(text, /an open review finding names/);
  snapshot.ticket.sourceKind = 'file';
  assert.match(turn(), /Issue checkboxes: none; write `none` under ## Issue checklist\./);
});
