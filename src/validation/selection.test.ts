import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { addTasks, blank, run, session } from '../stories/fixtures.ts';
import {
  missingTests,
  parseSelection,
  SELECTION_ENV,
  selectionEnv,
  taskSelection,
} from './selection.ts';

const dirs: Array<string> = [];
after(() => {
  for (const dir of dirs) {
    rmSync(dir, { force: true, recursive: true });
  }
});

// A work reply with this selection section, between the template's others.
const reply = (section: string): string =>
  `## Status\n\nready_for_review\n\n## Tests\n\n- \`npm test\`: passed\n\n## Validation selection\n\n${section}\n\n## E2E\n\nqa\n`;

test('the section lists test files with a reason each; none or empty lists nothing', () => {
  assert.deepEqual(
    parseSelection(
      reply(
        '- `tests/test_filter.py`: checks disabled entries are excluded\n- `./tests/../tests/test_sort.py`: sort keeps the order',
      ),
    ),
    {
      kind: 'listed',
      tests: [
        { path: 'tests/test_filter.py', reason: 'checks disabled entries are excluded' },
        { path: 'tests/test_sort.py', reason: 'sort keeps the order' },
      ],
    },
  );
  assert.deepEqual(parseSelection(reply('none')), { kind: 'listed', tests: [] });
  assert.deepEqual(parseSelection('## Validation selection\n'), { kind: 'listed', tests: [] });
  // Older replies have no section.
  assert.deepEqual(parseSelection('## Status\n\nready_for_review\n'), { kind: 'absent' });
});

test('a malformed entry, a path outside the repository, or a missing reason is a problem to correct', () => {
  const parsed = parseSelection(
    reply(
      [
        '- tests/test_filter.py: no backticks',
        '- `/etc/passwd`: absolute',
        '- `../other/test_x.py`: outside',
        '- `tests/test_ok.py`:',
      ].join('\n'),
    ),
  );
  assert.equal(parsed.kind, 'invalid');
  const problems = parsed.kind === 'invalid' ? parsed.problems : [];
  assert.equal(problems.length, 4);
  assert.match(
    problems[0] ?? '',
    /is not an entry\. Under ## Validation selection, write one line per test file/,
  );
  assert.match(problems[1] ?? '', /\/etc\/passwd is outside the repository/);
  assert.match(problems[2] ?? '', /\.\.\/other\/test_x\.py is outside the repository/);
  assert.match(problems[3] ?? '', /is not an entry/);
});

test('a listed path must be a file in the worktree', () => {
  const worktree = mkdtempSync(path.join(tmpdir(), 'factory-selection-'));
  dirs.push(worktree);
  mkdirSync(path.join(worktree, 'tests'));
  writeFileSync(path.join(worktree, 'tests', 'test_filter.py'), '');
  assert.deepEqual(
    missingTests(
      [
        { path: 'tests/test_filter.py', reason: 'r' },
        { path: 'tests', reason: 'a directory' },
        { path: 'tests/gone.py', reason: 'deleted' },
      ],
      worktree,
    ),
    [
      'Validation selection: tests is not a file in the worktree; list test files that exist.',
      'Validation selection: tests/gone.py is not a file in the worktree; list test files that exist.',
    ],
  );
});

test('a selection holds for its round: corrections keep it, none clears it, and a later run never counts back', () => {
  const snapshot = blank();
  addTasks(snapshot, 2);
  const work = session(snapshot, 'work', '01');
  const first = run(snapshot, work, { output: reply('- `tests/a.test.ts`: first') });
  const correction = run(snapshot, work, {
    output: 'Fixed the lint error.',
    purpose: 'validation_correction',
  });
  assert.deepEqual(taskSelection(snapshot, '01', correction), {
    kind: 'listed',
    tests: [{ path: 'tests/a.test.ts', reason: 'first' }],
  });
  // An answered question and a crash's retry carry on the round too.
  run(snapshot, work, { output: '', purpose: 'human_reply', terminal: 'caller_ping' });
  const retried = run(snapshot, work, { output: 'Done.', purpose: 'infrastructure_retry' });
  assert.equal(taskSelection(snapshot, '01', retried).kind, 'listed');
  const cleared = run(snapshot, work, {
    output: reply('`none`'),
    purpose: 'validation_correction',
  });
  // As of the first run, a later reply does not count.
  assert.deepEqual(taskSelection(snapshot, '01', first), {
    kind: 'listed',
    tests: [{ path: 'tests/a.test.ts', reason: 'first' }],
  });
  assert.deepEqual(taskSelection(snapshot, '01', cleared), { kind: 'listed', tests: [] });
  // Another task's runs, and runs that did not finish, never count.
  run(snapshot, session(snapshot, 'work', '02'), { output: reply('- `tests/b.test.ts`: other') });
  run(snapshot, work, {
    output: reply('- `tests/c.test.ts`: crashed'),
    purpose: 'infrastructure_retry',
    terminal: 'crashed',
  });
  assert.deepEqual(taskSelection(snapshot, '01'), { kind: 'listed', tests: [] });
  assert.deepEqual(taskSelection(snapshot, '03'), { kind: 'absent' });
});

test('a round returned from review starts without the earlier round’s selection', () => {
  const snapshot = blank();
  addTasks(snapshot, 1);
  const work = session(snapshot, 'work', '01');
  run(snapshot, work, { output: reply('- `tests/old_filter.test.ts`: round 1') });
  // Review returned the task; the worker renamed the file and answered only
  // the findings.
  const returned = run(snapshot, work, {
    output: '## Review responses\n\n- R1-01: fixed — renamed the test\n',
    purpose: 'return_to_work',
  });
  assert.deepEqual(taskSelection(snapshot, '01', returned), { kind: 'absent' });
  const listed = run(snapshot, work, {
    output: reply('- `tests/filter.test.ts`: round 2'),
    purpose: 'validation_correction',
  });
  assert.deepEqual(taskSelection(snapshot, '01', listed), {
    kind: 'listed',
    tests: [{ path: 'tests/filter.test.ts', reason: 'round 2' }],
  });
});

test('none is none however it is written', () => {
  for (const line of ['none', '- none', '`none`', '- `none`', 'None.', 'none (no focused tests)']) {
    assert.deepEqual(parseSelection(reply(line)), { kind: 'listed', tests: [] }, line);
  }
  assert.equal(parseSelection(reply('nothing')).kind, 'invalid');
});

test('each command gets a fresh environment, with the selection only when there is one', () => {
  const before = process.env[SELECTION_ENV];
  process.env[SELECTION_ENV] = 'left over from the server';
  try {
    const tests = [{ path: 'tests/a.test.ts', reason: 'covers it' }];
    const env = selectionEnv(tests);
    assert.notEqual(env, process.env);
    assert.deepEqual(JSON.parse(env[SELECTION_ENV] ?? ''), { tests, version: 1 });
    assert.equal(env['PATH'], process.env['PATH']);
    assert.equal(SELECTION_ENV in selectionEnv([]), false);
    assert.equal(SELECTION_ENV in selectionEnv(null), false);
    assert.notEqual(selectionEnv(tests), env);
  } finally {
    if (before === undefined) {
      delete process.env[SELECTION_ENV];
    } else {
      process.env[SELECTION_ENV] = before;
    }
  }
});
