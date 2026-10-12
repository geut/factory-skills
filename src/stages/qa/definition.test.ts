import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFactoryConfig } from '../../config.ts';
import { addTasks, blank, run, session, task } from '../../stories/fixtures.ts';
import { acceptanceCriteria, testGaps, testPlan } from './criteria.ts';
import { changedFiles, qa, readQaSettings } from './definition.ts';
import { QA_VALIDATOR_VERSION } from './effects.ts';

const models = { review: 'review-model', work: 'work-model' };
const e2e = { argv: ['npx', 'playwright', 'test'], name: 'e2e' };

test('QA is off by default and needs a command to be on', () => {
  assert.deepEqual(readQaSettings(undefined), {
    kind: 'ok',
    settings: { commands: [], enabled: false },
  });
  assert.equal(readQaSettings({ enabled: true }).kind, 'error');
  const on = parseFactoryConfig({ models, stages: { qa: { commands: [e2e], enabled: true } } });
  assert.equal(on.kind, 'ok');
  assert.deepEqual(on.kind === 'ok' ? on.config.stages['qa'] : null, {
    commands: [{ ...e2e, timeoutMs: 60_000 }],
    enabled: true,
  });
  assert.equal(parseFactoryConfig({ models, stages: { review: {} } }).kind, 'error');
});

test('criteria, test plan rows, and ledger lines are keyed AC1..ACn', () => {
  const task =
    '# T\n\n## Acceptance criteria\n\n- [ ] Filter applies to\n      every column.\n- [x] Filter survives a reload.\n\n## Verification\n- not a criterion\n';
  assert.deepEqual(acceptanceCriteria(task), [
    { id: 'AC1', text: 'Filter applies to every column.' },
    { id: 'AC2', text: 'Filter survives a reload.' },
  ]);
  assert.deepEqual(
    testPlan(
      '| AC | Test | Screenshot |\n| --- | --- | --- |\n| ac1 | e2e › AC1 | none |\n| AC2 | e2e › AC2 | screenshots/a.png, `screenshots/b.png` |\n' +
        '| AC3 | e2e › AC3: work\\|qa | screenshots/c.png (plus screenshots/d.png for the strip) |\n| AC4 | e2e › AC4 | qa\\ |\n',
    ),
    [
      { criterion: 'AC1', screenshots: [], test: 'e2e › AC1' },
      {
        criterion: 'AC2',
        screenshots: ['screenshots/a.png', 'screenshots/b.png'],
        test: 'e2e › AC2',
      },
      {
        criterion: 'AC3',
        screenshots: ['screenshots/c.png', 'screenshots/d.png'],
        test: 'e2e › AC3: work|qa',
      },
      { criterion: 'AC4', screenshots: ['qa\\'], test: 'e2e › AC4' },
    ],
  );
  assert.deepEqual(
    [...testGaps('- AC2: needs the real provider\n- other gap\n')],
    [['AC2', 'needs the real provider']],
  );
});

function concluded(reason: 'incomplete' | 'product', round: number) {
  const snapshot = blank();
  addTasks(snapshot, 1);
  const finished = run(snapshot, session(snapshot, 'qa', '01'), { round });
  return qa.conclude({ snapshot, task: task(snapshot, '01') }, finished, {
    checks: [],
    detail: { reason },
    failures: ['e2e failed: AC1 filter reset'],
    status: 'failed',
    summary: 'e2e failed: AC1 filter reset',
    version: QA_VALIDATOR_VERSION,
  });
}

test('incomplete QA output is corrected; a failing product goes back to work until the round limit', () => {
  assert.equal(concluded('incomplete', 1).kind, 'correct');
  const returned = concluded('product', 1);
  assert.equal(returned.kind, 'return_to_work');
  assert.deepEqual(returned.kind === 'return_to_work' ? returned.problems : [], [
    'e2e failed: AC1 filter reset',
  ]);
  const limited = concluded('product', 3);
  assert.equal(limited.kind === 'pause' ? limited.code : null, 'qa_round_limit');
});

test('QA reads the files the worker changed from its diff', () => {
  assert.deepEqual(
    changedFiles(
      'diff --git a/src/a.ts b/src/a.ts\n+x\ndiff --git a/old.ts b/new.ts\n-y\ndiff --git a/src/a.ts b/src/a.ts\n',
    ),
    ['src/a.ts', 'new.ts'],
  );
});
