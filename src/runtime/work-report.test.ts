import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { feedbackResponses } from '../stages/feedback.ts';
import { parseSelection } from '../validation/selection.ts';
import { readWorkReport, renderWorkReport, workReportProblems } from './work-report.ts';

const dirs: Array<string> = [];
after(() => {
  for (const dir of dirs) {
    rmSync(dir, { force: true, recursive: true });
  }
});

// A worktree with one test file, and a file outside it a symlink reaches.
function worktree(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'factory-report-'));
  dirs.push(root);
  const tree = path.join(root, 'tree');
  mkdirSync(path.join(tree, 'tests'), { recursive: true });
  writeFileSync(path.join(tree, 'tests', 'filter.test.ts'), '');
  writeFileSync(path.join(root, 'secret.test.ts'), '');
  symlinkSync(path.join(root, 'secret.test.ts'), path.join(tree, 'tests', 'escape.test.ts'));
  return tree;
}

const focused = {
  mode: 'focused',
  tests: [{ path: 'tests/filter.test.ts', reason: 'checks that disabled entries are excluded' }],
};
const report = {
  status: 'ready_for_review',
  summary: 'Disabled entries are left out.',
  validation_selection: focused,
};

test('a complete report has no problems', () => {
  const tree = worktree();
  assert.deepEqual(workReportProblems(report, { feedbackItems: [], worktree: tree }), []);
  assert.deepEqual(
    workReportProblems(
      { ...report, validation_selection: { mode: 'default', reason: 'docs only' } },
      { feedbackItems: [], worktree: tree },
    ),
    [],
  );
});

test('an empty call, as from an agent that only thought its reply, names every required field', () => {
  assert.deepEqual(workReportProblems({}, { feedbackItems: [], worktree: worktree() }), [
    'status: `ready_for_review` or `blocked`.',
    'summary: one sentence for the observable result.',
    'validation_selection: set `mode` to `focused` with `tests`, or `default` with a `reason`.',
  ]);
});

test('selected tests must be files inside the worktree', () => {
  const tree = worktree();
  const problems = (tests: Array<{ path: string; reason: string }>) =>
    workReportProblems(
      { ...report, validation_selection: { mode: 'focused', tests } },
      { feedbackItems: [], worktree: tree },
    );
  assert.deepEqual(problems([{ path: 'tests/missing.test.ts', reason: 'r' }]), [
    'validation_selection.tests[0].path: tests/missing.test.ts is not a file in this worktree.',
  ]);
  assert.deepEqual(problems([{ path: '../secret.test.ts', reason: 'r' }]), [
    'validation_selection.tests[0].path: ../secret.test.ts is outside the repository; give it relative to the repository root.',
  ]);
  // A symlink that leaves the worktree is outside it too.
  assert.deepEqual(problems([{ path: 'tests/escape.test.ts', reason: 'r' }]), [
    'validation_selection.tests[0].path: tests/escape.test.ts is not a file in this worktree.',
  ]);
  assert.deepEqual(problems([{ path: 'tests', reason: 'r' }]), [
    'validation_selection.tests[0].path: tests is not a file in this worktree.',
  ]);
});

test('proposing no tests is an explicit choice with a reason', () => {
  const tree = worktree();
  const problems = (selection: unknown) =>
    workReportProblems(
      { ...report, validation_selection: selection },
      { feedbackItems: [], worktree: tree },
    );
  assert.deepEqual(problems({ mode: 'default' }), [
    'validation_selection: `default` needs a `reason` and no `tests`.',
  ]);
  assert.deepEqual(problems({ mode: 'default', reason: 'x', tests: focused.tests }), [
    'validation_selection: `default` needs a `reason` and no `tests`.',
  ]);
  assert.deepEqual(problems({ mode: 'focused', tests: [] }), [
    'validation_selection: `focused` needs `tests`, each with a `path` and a `reason`; use `default` with a `reason` to propose none.',
  ]);
});

test('a blocked report names its blocker', () => {
  assert.deepEqual(
    workReportProblems(
      { ...report, status: 'blocked' },
      { feedbackItems: [], worktree: worktree() },
    ),
    ['blocker: a blocked report says what stops the task.'],
  );
});

test("a feedback round's report answers every item exactly once", () => {
  const tree = worktree();
  const problems = (responses: Array<{ disposition: string; id: string; note: string }>) =>
    workReportProblems(
      { ...report, feedback_responses: responses },
      { feedbackItems: ['F1', 'F2'], worktree: tree },
    );
  assert.deepEqual(
    problems([
      { disposition: 'addressed', id: 'F1', note: 'renamed the flag' },
      { disposition: 'declined', id: 'f2', note: 'no flag section yet' },
    ]),
    [],
  );
  assert.deepEqual(
    problems([
      { disposition: 'addressed', id: 'F1', note: 'a' },
      { disposition: 'addressed', id: 'F1', note: 'b' },
      { disposition: 'declined', id: 'F3', note: '' },
    ]),
    [
      'feedback_responses: F1 is answered twice; answer each item once.',
      'feedback_responses: F3 is not an item of this round (F1, F2).',
      'feedback_responses: F3 is declined without a reason in its note.',
      'feedback_responses: answer F2, each addressed with what changed or declined with why.',
    ],
  );
  assert.deepEqual(
    workReportProblems(
      { ...report, feedback_responses: [{ disposition: 'addressed', id: 'F1', note: 'a' }] },
      { feedbackItems: [], worktree: tree },
    ),
    [
      'feedback_responses: F1 is not an item; this task is not a feedback round, so leave feedback_responses out.',
    ],
  );
});

test('the rendered template reads back through the selection and feedback parsers', () => {
  const read = readWorkReport({
    ...report,
    e2e: { note: 'QA owns them', result: 'qa' },
    feedback_responses: [
      { disposition: 'addressed', id: 'F1', note: 'renamed\nthe flag' },
      { disposition: 'declined', id: 'F2', note: 'no section yet' },
    ],
    summary: 'Disabled entries\n## are left out.',
    tests: [{ command: 'npm test', note: '22 files', result: 'passed' }],
  });
  assert.ok(read !== null);
  const text = renderWorkReport(read);
  // A field never opens a section of its own.
  assert.deepEqual(
    text.split('\n').filter((line) => line.startsWith('## ')),
    [
      '## Status',
      '## Summary',
      '## Tests',
      '## Validation selection',
      '## E2E',
      '## Review responses',
      '## Feedback responses',
      '## Plan changed',
      '## Blocker',
      '## Evidence',
    ],
  );
  assert.deepEqual(parseSelection(text), { kind: 'listed', tests: focused.tests });
  assert.deepEqual(feedbackResponses(text), [
    { id: 'F1', note: 'renamed the flag', status: 'addressed' },
    { id: 'F2', note: 'no section yet', status: 'declined' },
  ]);
  const none = readWorkReport({
    ...report,
    validation_selection: { mode: 'default', reason: 'docs (only) change' },
  });
  assert.ok(none !== null);
  assert.deepEqual(parseSelection(renderWorkReport(none)), { kind: 'listed', tests: [] });
});

test('arguments that make no report read as none', () => {
  assert.equal(readWorkReport({}), null);
  assert.equal(readWorkReport(undefined), null);
  assert.equal(readWorkReport({ ...report, tests: 'all passed' }), null);
});
