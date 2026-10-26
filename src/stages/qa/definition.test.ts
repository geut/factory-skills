import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFactoryConfig } from '../../config.ts';
import { sessionId } from '../../domain.ts';
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
  const again = readQaSettings({ commands: [e2e], enabled: true, workCommands: ['lint'] });
  assert.deepEqual(again.kind === 'ok' ? again.settings['workCommands'] : null, ['lint']);
  assert.equal(readQaSettings({ commands: [e2e], workCommands: 'lint' }).kind, 'error');
  const typo = parseFactoryConfig({
    models,
    stages: { qa: { commands: [e2e], enabled: true, workCommands: ['lnt'] } },
    validation: { work: { commands: [{ argv: ['npm', 'run', 'lint'], name: 'lint' }] } },
  });
  assert.deepEqual(typo, {
    kind: 'error',
    message:
      'FACTORY.json stages.qa.workCommands names lnt, which validation.work.commands does not list.',
  });
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

// The worker summary QA's prompt shows for task 01, after `build` adds work runs.
function workerSummaryAfter(build: (snapshot: ReturnType<typeof blank>) => void): string {
  const snapshot = blank();
  addTasks(snapshot, 1);
  snapshot.execution.worktreePath = '/repo/.factory/worktrees/demo';
  build(snapshot);
  const input = qa.input?.(
    { snapshot, task: task(snapshot, '01') },
    {
      handoff: null,
      prepared: { baseline: '{}', changedFiles: [], checks: [], criteria: [], dir: '/qa' },
      round: 2,
    },
  );
  return input?.workerSummary ?? assert.fail('no input');
}

test('QA is given the worker’s latest reply, in every round', () => {
  assert.equal(
    workerSummaryAfter((snapshot) => {
      run(snapshot, session(snapshot, 'work', '01'), { output: 'Round 1: stored the filter.' });
    }),
    'Round 1: stored the filter.',
  );
  assert.equal(
    workerSummaryAfter((snapshot) => {
      const work = session(snapshot, 'work', '01');
      run(snapshot, work, { output: 'Round 1: stored the filter.' });
      run(snapshot, work, { output: 'Round 2: fixed R1-1.', purpose: 'return_to_work', round: 1 });
    }),
    'Round 2: fixed R1-1.',
  );
  assert.equal(
    workerSummaryAfter((snapshot) => {
      const first = session(snapshot, 'work', '01');
      run(snapshot, first, { output: 'Round 1: stored the filter.' });
      const second = { ...first, id: sessionId('session-work:01-again') };
      snapshot.sessions.push(second);
      run(snapshot, second, { output: 'Round 2, new session.', round: 1 });
    }),
    'Round 2, new session.',
  );
  assert.equal(
    workerSummaryAfter((snapshot) => {
      const work = session(snapshot, 'work', '01');
      run(snapshot, work, { output: 'Round 1: stored the filter.' });
      run(snapshot, work, { output: 'Round 2: fixed R1-1.', purpose: 'return_to_work', round: 1 });
      run(snapshot, work, { output: 'Fixed the lint error.', purpose: 'validation_correction' });
      // Another task's worker is not this one.
      addTasks(snapshot, 2);
      run(snapshot, session(snapshot, 'work', '02'), { output: 'Task 02 summary.' });
    }),
    // The round's reply keeps its review responses; the correction follows it.
    'Round 2: fixed R1-1.\n\nFixed the lint error.',
  );
});

test('an empty latest reply falls back to the last one, and says so', () => {
  const summary = workerSummaryAfter((snapshot) => {
    const work = session(snapshot, 'work', '01');
    run(snapshot, work, { output: 'Round 1: stored the filter.' });
    run(snapshot, work, { output: '', purpose: 'return_to_work', round: 1 });
  });
  assert.match(summary, /^Round 1: stored the filter\.\n\n/);
  assert.match(summary, /latest reply was empty/);
  assert.equal(
    workerSummaryAfter(() => {}),
    '',
  );
});
