import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import type { FactorySnapshot, RunRecord, SessionRecord } from '../domain.ts';
import { sha256 } from '../hash.ts';
import {
  formatFinding,
  parseReview,
  REVIEW_CONTRACT,
  type ReviewContext,
} from '../stages/review/parse.ts';
import { addTasks, session, task } from '../stories/fixtures.ts';
import { validationContext } from './fixture.ts';
import { reviewValidator } from './review.ts';
import { collectWorkDiff } from './work.ts';

function review(
  verdict: string,
  findings = 'none',
  summary = 'The filter survives a reload.',
  verification = 'none',
) {
  return `## Verdict\n\n${verdict}\n\n## Summary\n\n${summary}\n\n## Verification\n\n${verification}\n\n## Findings\n\n${findings}\n`;
}

const major = `### 1. [Major] Filter resets on reload

**Location:** src/filter.ts:10
**Finding:** The filter is never stored.
**Evidence:** No storage call exists on the change path.
**Suggestion:** Persist the filter before navigation.`;

const minor = `### 2. [Minor] Unclear name

**Location:** src/filter.ts:4
**Finding:** \`f\` hides what it holds.
**Evidence:** It is read in three places.`;

test('approve with no findings and approve with minor findings are valid', () => {
  const clean = parseReview(review('approve'), 1);
  assert.equal(clean.kind, 'valid');
  if (clean.kind === 'valid') {
    assert.equal(clean.result.verdict, 'approve');
    assert.deepEqual(clean.result.findings, []);
    assert.equal(clean.result.summary, 'The filter survives a reload.');
  }
  const withMinor = parseReview(review('approve', minor), 1);
  assert.equal(withMinor.kind, 'valid');
  if (withMinor.kind === 'valid') {
    assert.equal(withMinor.result.findings[0]?.id, 'R1-2');
    assert.equal(withMinor.result.findings[0]?.blocking, false);
  }
});

test('changes_requested keeps stable round ids and finding fields', () => {
  const parsed = parseReview(review('changes_requested', `${major}\n\n${minor}`), 2);
  assert.equal(parsed.kind, 'valid');
  if (parsed.kind !== 'valid') {
    return;
  }
  const [first, second] = parsed.result.findings;
  assert.equal(first?.id, 'R2-1');
  assert.equal(first?.severity, 'major');
  assert.equal(first?.blocking, true);
  assert.equal(first?.location, 'src/filter.ts:10');
  assert.equal(first?.suggestion, 'Persist the filter before navigation.');
  assert.equal(second?.id, 'R2-2');
  assert.equal(second?.suggestion, null);
  assert.match(formatFinding(first ?? assert.fail('missing finding')), /^R2-1 \[major\] Filter/);
});

test('verdict rules reject inconsistent results', () => {
  const approveBlocking = parseReview(review('approve', major), 1);
  assert.equal(approveBlocking.kind, 'invalid');
  if (approveBlocking.kind === 'invalid') {
    assert.match(
      approveBlocking.failures.join('\n'),
      /approve cannot include a blocking finding: R1-1/,
    );
  }
  const changesWithoutBlocker = parseReview(review('changes_requested', minor), 1);
  assert.equal(changesWithoutBlocker.kind, 'invalid');
  if (changesWithoutBlocker.kind === 'invalid') {
    assert.match(changesWithoutBlocker.failures.join('\n'), /at least one Critical or Major/);
  }
});

test('missing headings, template placeholders, and unknown verdicts are malformed', () => {
  const placeholder = parseReview(review('approve | changes_requested | blocked'), 1);
  assert.equal(placeholder.kind, 'invalid');
  const unknown = parseReview(review('lgtm'), 1);
  assert.equal(unknown.kind, 'invalid');
  if (unknown.kind === 'invalid') {
    assert.match(unknown.failures[0] ?? '', /got "lgtm"/);
  }
  const missing = parseReview('Looks good to me.', 1);
  assert.equal(missing.kind, 'invalid');
  if (missing.kind === 'invalid') {
    assert.deepEqual(missing.failures, [
      '## Verdict is missing.',
      '## Summary is missing or empty.',
      '## Findings is missing.',
      '## Verification is missing. Add it between Summary and Findings, with one line per acceptance criterion and earlier blocking finding.',
    ]);
  }
  const noSummary = parseReview(review('approve', 'none', ''), 1);
  assert.equal(noSummary.kind, 'invalid');
});

test('finding headings, severity, numbering, and required fields are checked', () => {
  const badHeading = parseReview(review('changes_requested', '### Filter resets'), 1);
  assert.equal(badHeading.kind, 'invalid');
  const badSeverity = parseReview(
    review('changes_requested', major.replace('[Major]', '[High]')),
    1,
  );
  assert.equal(badSeverity.kind, 'invalid');
  if (badSeverity.kind === 'invalid') {
    assert.match(badSeverity.failures[0] ?? '', /severity "High"/);
  }
  const duplicate = parseReview(review('changes_requested', `${major}\n\n${major}`), 1);
  assert.equal(duplicate.kind, 'invalid');
  if (duplicate.kind === 'invalid') {
    assert.match(duplicate.failures.join('\n'), /Finding 1 is numbered twice/);
  }
  const noEvidence = parseReview(
    review('changes_requested', major.replace(/\*\*Evidence:\*\*.*\n/, '')),
    1,
  );
  assert.equal(noEvidence.kind, 'invalid');
  if (noEvidence.kind === 'invalid') {
    assert.match(noEvidence.failures.join('\n'), /Finding 1 is missing \*\*Evidence:\*\*/);
  }
  const prose = parseReview(review('approve', 'Everything looks fine.'), 1);
  assert.equal(prose.kind, 'invalid');
});

test('a fenced template and multi-line fields are accepted', () => {
  const multiline = major.replace(
    '**Evidence:** No storage call exists on the change path.',
    '**Evidence:** No storage call exists\non the change path.',
  );
  const parsed = parseReview(`\`\`\`markdown\n${review('changes_requested', multiline)}\`\`\``, 1);
  assert.equal(parsed.kind, 'valid');
  if (parsed.kind === 'valid') {
    assert.equal(
      parsed.result.findings[0]?.evidence,
      'No storage call exists\non the change path.',
    );
  }
});

// A review with a Verification line per acceptance criterion and, from round
// 2, per earlier blocking finding.
function verifying(verdict: string, verification: string, findings = 'none') {
  return review(verdict, findings, undefined, verification);
}

// A worktree where src/filter.ts has 40 lines and its test 20.
const context: ReviewContext = {
  criteria: ['AC1', 'AC2'],
  earlierFindings: [],
  lineCount: (file) => ({ 'src/filter.test.ts': 20, 'src/filter.ts': 40 })[file] ?? null,
};

const verified = [
  '- AC1: verified — src/filter.ts:10-18; test "keeps the filter" in src/filter.test.ts:5',
  '- AC2: not_verified — needs a real browser; covered by QA',
].join('\n');

function failuresOf(output: string, round = 1, given: ReviewContext = context): string {
  const parsed = parseReview(output, round, given);
  assert.equal(parsed.kind, 'invalid');
  return parsed.kind === 'invalid' ? parsed.failures.join('\n') : '';
}

test('an approval records one verification line per criterion', () => {
  const parsed = parseReview(verifying('approve', verified), 1, context);
  assert.equal(parsed.kind, 'valid');
  assert.deepEqual(parsed.kind === 'valid' ? parsed.result.verification : null, [
    {
      evidence: 'src/filter.ts:10-18; test "keeps the filter" in src/filter.test.ts:5',
      id: 'AC1',
      status: 'verified',
    },
    { evidence: 'needs a real browser; covered by QA', id: 'AC2', status: 'not_verified' },
  ]);
});

test('a review without Verification is malformed', () => {
  assert.match(
    failuresOf(review('approve').replace('## Verification\n\nnone\n\n', '')),
    /## Verification is missing/,
  );
});

test('every criterion appears exactly once, and only known ids appear', () => {
  assert.match(
    failuresOf(verifying('approve', '- AC1: verified — src/filter.ts:3')),
    /no line for AC2/,
  );
  assert.match(
    failuresOf(verifying('approve', `${verified}\n- AC1: verified — src/filter.ts:4`)),
    /AC1 appears twice/,
  );
  assert.match(
    failuresOf(verifying('approve', `${verified}\n- AC7: verified — src/filter.ts:4`)),
    /AC7 is not an acceptance criterion of this task/,
  );
});

test('verified lines cite locations that exist in the worktree', () => {
  assert.match(
    failuresOf(verifying('approve', verified.replace('src/filter.ts:10-18', 'src/gone.ts:3'))),
    /src\/gone\.ts:3, which does not exist in the worktree/,
  );
  assert.match(
    failuresOf(
      verifying('approve', verified.replace('src/filter.ts:10-18', 'src/filter.ts:10-41')),
    ),
    /AC1 cites src\/filter\.ts:10-41, but src\/filter\.ts has 40 lines/,
  );
  assert.match(
    failuresOf(
      verifying('approve', verified.replace(/src\/filter\.ts:10-18;.*$/m, 'the tests pass')),
    ),
    /AC1 is verified but cites no path:line/,
  );
});

test('citations may sit in brackets or backticks, and the evidence keeps its text', () => {
  const parsed = parseReview(
    verifying(
      'approve',
      [
        '- AC1: verified — [src/filter.ts:10] and `src/filter.test.ts:5` cover src/**/filter.ts',
        '- AC2: verified — (src/filter.ts:2-3)',
      ].join('\n'),
    ),
    1,
    context,
  );
  assert.equal(parsed.kind, 'valid');
  assert.equal(
    parsed.kind === 'valid' ? parsed.result.verification[0]?.evidence : null,
    '[src/filter.ts:10] and src/filter.test.ts:5 cover src/**/filter.ts',
  );
});

test('a not_verified line needs a reason', () => {
  assert.match(
    failuresOf(verifying('approve', verified.replace(/not_verified — .*$/m, 'not_verified'))),
    /AC2 is not_verified without a reason/,
  );
});

test('from round 2, earlier blocking findings are verified, and approve leaves none open', () => {
  const round2 = { ...context, earlierFindings: ['R1-1', 'R1-2'] };
  assert.match(
    failuresOf(verifying('approve', `${verified}\n- R1-01: fixed — src/filter.ts:12`), 2, round2),
    /no line for R1-2/,
  );
  const open = `${verified}\n- R1-01: fixed — src/filter.ts:12\n- R1-2: still_open — still unsorted`;
  assert.match(
    failuresOf(verifying('approve', open), 2, round2),
    /approve cannot leave an earlier finding still_open: R1-2/,
  );
  const changes = parseReview(verifying('changes_requested', open, major), 2, round2);
  assert.equal(changes.kind, 'valid');
  assert.deepEqual(
    changes.kind === 'valid' ? changes.result.verification.map((line) => line.id) : null,
    ['AC1', 'AC2', 'R1-1', 'R1-2'],
  );
  assert.match(
    failuresOf(verifying('approve', `${verified}\n- R1-1: verified — src/filter.ts:12`), 2, round2),
    /R1-1 has status "verified"; use fixed or still_open/,
  );
});

const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

// A worktree with one uncommitted change, as the worker left it.
function worktree(): string {
  const cwd = mkdtempSync(path.join(tmpdir(), 'factory-review-'));
  roots.push(cwd);
  const git = (args: Array<string>) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(result.stderr);
    }
  };
  git(['init', '-b', 'main']);
  writeFileSync(path.join(cwd, 'README.md'), '# demo\n');
  git(['add', 'README.md']);
  git(['config', 'user.email', 'factory@example.com']);
  git(['config', 'user.name', 'Factory']);
  git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'init']);
  writeFileSync(path.join(cwd, 'README.md'), '# demo\nchanged\n');
  return cwd;
}

function diffHash(cwd: string): string {
  const collected = collectWorkDiff(cwd);
  if ('message' in collected) {
    throw new Error(collected.message);
  }
  return sha256(collected.diff);
}

function validate(
  cwd: string,
  edit: (run: RunRecord, owner: SessionRecord, snapshot: FactorySnapshot) => void = () => {},
) {
  return reviewValidator.validate(
    validationContext('review', (snapshot, finished, owner) => {
      snapshot.execution.worktreePath = cwd;
      session(snapshot, 'work', '01');
      finished.diffHash = diffHash(cwd);
      finished.resultError = null;
      finished.resultJson = JSON.stringify({ output: review('approve') });
      finished.resultStatus = 'valid';
      edit(finished, owner, snapshot);
    }),
  );
}

test('review validation passes only for an isolated, fresh, parsed review', async () => {
  const cwd = worktree();
  const passed = await validate(cwd);
  assert.equal(passed.status, 'passed');
  assert.equal(passed.version, reviewValidator.version);
  assert.deepEqual(
    passed.checks.map((check) => [check.name, check.status]),
    [
      ['review result', 'passed'],
      ['reviewer model', 'passed'],
      // The review stage's own tool policy is read-only.
      ['read-only tools', 'passed'],
      ['reviewed diff', 'passed'],
    ],
  );
  const untracked = await validate(cwd, (run) => {
    run.diffHash = null;
  });
  assert.equal(untracked.status, 'passed');
  assert.equal(
    untracked.checks.some((check) => check.name === 'reviewed diff'),
    false,
  );
});

test('isolation outranks a stale diff, which outranks a malformed result', async () => {
  const cwd = worktree();
  const malformed = await validate(cwd, (run) => {
    run.resultError = '## Verdict is missing.\n## Findings is missing.';
    run.resultStatus = 'invalid';
  });
  assert.equal(malformed.status === 'failed' && malformed.detail.reason, 'malformed');
  if (malformed.status === 'failed') {
    assert.deepEqual(malformed.failures, ['## Verdict is missing.', '## Findings is missing.']);
  }
  const stale = await validate(cwd, (run) => {
    run.diffHash = 'diff-before-the-worker-changed-it';
    run.resultStatus = 'invalid';
  });
  assert.equal(stale.status === 'failed' && stale.detail.reason, 'stale');
  const sameModel = await validate(cwd, (run, owner) => {
    run.diffHash = 'diff-before-the-worker-changed-it';
    owner.model = 'qwen3.8-max';
  });
  assert.equal(sameModel.status === 'failed' && sameModel.detail.reason, 'unsafe');
  if (sameModel.status === 'failed') {
    assert.match(sameModel.failures[0] ?? '', /both use qwen3.8-max/);
  }
});

// A review of task 01, whose one criterion is about the README the
// worker changed to two lines.
function validateTask(cwd: string, verification: string) {
  const factoryDir = mkdtempSync(path.join(tmpdir(), 'factory-review-ticket-'));
  roots.push(factoryDir);
  writeFileSync(
    path.join(factoryDir, '01-task.md'),
    '# Demo\n\n## Acceptance criteria\n\n- [ ] The README says it changed.\n',
  );
  return validate(cwd, (run, _owner, snapshot) => {
    addTasks(snapshot, 1);
    task(snapshot, '01').taskFile = '01-task.md';
    snapshot.execution.factoryDir = factoryDir;
    run.resultJson = JSON.stringify({ output: verifying('approve', verification) });
  });
}

test('a review is checked against the task file and the worktree', async () => {
  const cwd = worktree();
  const passed = await validateTask(cwd, '- AC1: verified — README.md:2');
  assert.equal(passed.status, 'passed');
  assert.equal(passed.checks[0]?.details, REVIEW_CONTRACT);
  const beyond = await validateTask(cwd, '- AC1: verified — README.md:3');
  assert.equal(beyond.status === 'failed' && beyond.detail.reason, 'malformed');
  assert.deepEqual(beyond.status === 'failed' ? beyond.failures : null, [
    'AC1 cites README.md:3, but README.md has 2 lines.',
  ]);
  const outside = await validateTask(cwd, '- AC1: verified — ../README.md:1');
  assert.match(
    outside.status === 'failed' ? outside.failures.join('\n') : '',
    /cites \.\.\/README\.md:1, which does not exist in the worktree/,
  );
  writeFileSync(path.join(cwd, 'empty.ts'), '');
  const empty = await validateTask(cwd, '- AC1: verified — empty.ts:1');
  assert.deepEqual(empty.status === 'failed' ? empty.failures : null, [
    'AC1 cites empty.ts:1, but empty.ts has 0 lines.',
  ]);
  const missing = await validateTask(cwd, 'none');
  assert.match(
    missing.status === 'failed' ? missing.failures.join('\n') : '',
    /## Verification has no line for AC1/,
  );
});

test('a review without a worktree is a validator error', async () => {
  const report = await reviewValidator.validate(
    validationContext('review', (snapshot) => {
      snapshot.execution.worktreePath = null;
    }),
  );
  assert.equal(report.status, 'error');
});
