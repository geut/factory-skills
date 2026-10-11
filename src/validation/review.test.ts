import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import type { RunRecord, SessionRecord } from '../domain.ts';
import { sha256 } from '../hash.ts';
import { formatFinding, parseReview } from '../stages/review/parse.ts';
import { session } from '../stories/fixtures.ts';
import { validationContext } from './fixture.ts';
import { reviewValidator } from './review.ts';
import { collectWorkDiff } from './work.ts';

function review(verdict: string, findings = 'none', summary = 'The filter survives a reload.') {
  return `## Verdict\n\n${verdict}\n\n## Summary\n\n${summary}\n\n## Findings\n\n${findings}\n`;
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

function validate(cwd: string, edit: (run: RunRecord, owner: SessionRecord) => void = () => {}) {
  return reviewValidator.validate(
    validationContext('review', (snapshot, finished, owner) => {
      snapshot.execution.worktreePath = cwd;
      session(snapshot, 'work', '01');
      finished.diffHash = diffHash(cwd);
      finished.resultError = null;
      finished.resultStatus = 'valid';
      edit(finished, owner);
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

test('a review without a worktree is a validator error', async () => {
  const report = await reviewValidator.validate(
    validationContext('review', (snapshot) => {
      snapshot.execution.worktreePath = null;
    }),
  );
  assert.equal(report.status, 'error');
});
