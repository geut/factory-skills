import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import type { WrapupBaseline } from '../domain.ts';
import { markdownChecklist } from '../ports/markdown-checklist.ts';
import { openBoxes } from '../stages/wrapup/checklist.ts';
import { listedPaths } from '../stages/wrapup/handoff.ts';
import { addTasks, review, run, session, task } from '../stories/fixtures.ts';
import { validationContext } from './fixture.ts';
import { captureWrapupState, wrapupValidator, type PullRequestLookup } from './wrapup.ts';

const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function git(cwd: string, args: Array<string>): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

const branch = 'factory/proj-1';
const commands = [{ argv: ['npm', 'test'], name: 'test', timeoutMs: 1000 }];

type Fixture = {
  baseline: () => WrapupBaseline;
  baseSha: string;
  codeRoot: string;
  factoryRoot: string;
  worktree: string;
};

// A code root with a ticket worktree whose work is approved but uncommitted.
function fixture(): Fixture {
  const codeRoot = mkdtempSync(path.join(tmpdir(), 'factory-wrapup-'));
  roots.push(codeRoot);
  git(codeRoot, ['init', '-b', 'main']);
  git(codeRoot, ['config', 'user.email', 'factory@example.com']);
  git(codeRoot, ['config', 'user.name', 'Factory']);
  writeFileSync(path.join(codeRoot, 'README.md'), '# demo\n');
  mkdirSync(path.join(codeRoot, 'src'));
  writeFileSync(path.join(codeRoot, 'src/filter.ts'), 'export const filter = 1;\n');
  git(codeRoot, ['add', '.']);
  git(codeRoot, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'init']);
  writeFileSync(path.join(codeRoot, '.git/info/exclude'), '.factory/\n');
  const baseSha = git(codeRoot, ['rev-parse', 'HEAD']);
  const factoryRoot = path.join(codeRoot, '.factory');
  mkdirSync(path.join(factoryRoot, 'tickets/proj-1'), { recursive: true });
  writeFileSync(path.join(factoryRoot, 'FACTORY.json'), '{}\n');
  writeFileSync(path.join(factoryRoot, 'tickets/proj-1/plan.md'), '# Plan\n');
  writeFileSync(
    path.join(factoryRoot, 'tickets/proj-1/01-task.md'),
    '# Store the filter\n\n## Acceptance criteria\n\n- [ ] The filter survives a reload.\n- [ ] The filter has a label.\n',
  );
  const worktree = path.join(factoryRoot, 'worktrees/proj-1');
  git(codeRoot, ['worktree', 'add', '-b', branch, worktree, 'main']);
  // The approved work: one changed file and one new file.
  writeFileSync(path.join(worktree, 'src/filter.ts'), 'export const filter = 2;\n');
  writeFileSync(path.join(worktree, 'src/store.ts'), 'export const store = {};\n');
  return {
    baseline: () => ({
      boxes: [],
      ...captureWrapupState({
        baseBranch: 'main',
        baseSha,
        branch,
        codeRoot,
        factoryRoot,
        ticketDir: path.join(factoryRoot, 'tickets/proj-1'),
        worktree,
      }),
    }),
    baseSha,
    codeRoot,
    factoryRoot,
    worktree,
  };
}

function handoff(
  fixtureValue: Fixture,
  input: {
    checklist?: string;
    decisions?: string;
    files?: Array<string>;
    merge?: string;
    tests?: string;
  } = {},
): string {
  const files = input.files ?? ['src/filter.ts', 'src/store.ts'];
  return `Some prose before the template is ignored.

## Outcome

The catalog keeps its filter.

## PR summary

Persist the filter. Non-goals: none.

## Files

${files.map((file) => `- \`${file}\``).join('\n')}

## Tests

${input.tests ?? '- `npm test` (test): passed'}

## Issue checklist

${input.checklist ?? 'none'}

## Decisions

${input.decisions ?? 'none'}

## Operations

none

## Limitations

none

## Merge commands

${
  input.merge ??
  `\`\`\`sh
git -C "${fixtureValue.worktree}" add -- src/filter.ts src/store.ts
git -C "${fixtureValue.worktree}" commit -m "Persist the filter"
git -C "${fixtureValue.codeRoot}" merge --ff-only "${branch}"
\`\`\``
}
`;
}

const noPullRequest: PullRequestLookup = () => ({ missing: true });

function validate(
  value: Fixture,
  baseline: WrapupBaseline,
  output: string,
  options: {
    findPullRequest?: PullRequestLookup;
    generated?: Array<string>;
    // The ticket's issue body, with task 01 and its approving review.
    issue?: { body: string; review: string };
    pullRequests?: boolean;
  } = {},
) {
  return wrapupValidator.validate(
    validationContext(
      'wrapup',
      (snapshot, finished) => {
        const { execution } = snapshot;
        execution.factoryDir = path.join(value.factoryRoot, 'tickets/proj-1');
        execution.policy.codeRoot = value.codeRoot;
        execution.policy.pullRequests = options.pullRequests ?? false;
        execution.policy.validation.work.commands = commands;
        execution.policy.validation.wrapup.generated = options.generated ?? [];
        execution.worktreeBaseBranch = 'main';
        execution.worktreeBaseSha = value.baseSha;
        execution.worktreeBranch = branch;
        execution.worktreePath = value.worktree;
        // The issue's checklist as wrap-up's input preparation read it.
        finished.baseline = JSON.stringify(
          options.issue === undefined
            ? baseline
            : { ...baseline, boxes: openBoxes(markdownChecklist(options.issue.body)) },
        );
        finished.resultJson = JSON.stringify({ output });
        if (options.issue !== undefined) {
          addTasks(snapshot, 1);
          task(snapshot, '01').taskFile = '01-task.md';
          run(snapshot, session(snapshot, 'review', '01'), {
            output: options.issue.review,
            round: 1,
          });
        }
      },
      { findPullRequest: options.findPullRequest ?? noPullRequest, usage: () => 'usage table' },
    ),
  );
}

function failures(outcome: Awaited<ReturnType<typeof validate>>): string {
  return outcome.status === 'failed' ? outcome.failures.join('\n') : '';
}

test('a complete handoff passes, and prose outside the headings is ignored', async () => {
  const value = fixture();
  const outcome = await validate(value, value.baseline(), handoff(value));
  assert.equal(outcome.status, 'passed', failures(outcome));
  if (outcome.status === 'passed') {
    assert.deepEqual(
      outcome.checks.map((item) => item.name),
      [
        'handoff headings',
        'files section',
        'tests section',
        'issue checklist',
        'decision locations',
        'merge commands',
        'no product code',
        'factory files',
        'no commit or merge',
        'pull-request policy',
      ],
    );
  }
});

const issueBody =
  '## Done when\n\n- [ ] A reload keeps the filter.\n- [x] The README says so.\n- [ ] The filter is labelled.\n';

// An approving review that verified both criteria of task 01, with `findings`.
const approved = (findings = 'none') =>
  review(
    'approve',
    findings,
    undefined,
    '- AC1: verified — src/filter.ts:1\n- AC2: verified — src/filter.ts:1',
  );

// A minor finding that contradicts AC2, the label criterion.
const labelFinding = `### 2. [Minor] The label is never rendered (AC 2)

**Location:** src/filter.ts:1
**Finding:** The label text exists but no component shows it.
**Evidence:** Nothing reads filter.label.`;

test('the issue checklist marks each open box met with evidence or not_met with a reason', async () => {
  const value = fixture();
  const outcome = await validate(
    value,
    value.baseline(),
    handoff(value, {
      checklist: [
        '- B1: met — Task 01 AC1 verified; src/filter.ts:1 keeps it',
        '- B2: not_met — Task 01 R1-2 says the label is never rendered',
      ].join('\n'),
      decisions: '- Stored the filter in the URL instead of localStorage.',
    }),
    { issue: { body: issueBody, review: approved() } },
  );
  assert.equal(outcome.status, 'passed', failures(outcome));
  assert.deepEqual(outcome.status === 'passed' ? outcome.detail.checklist : null, {
    decisions: ['Stored the filter in the URL instead of localStorage.'],
    met: [{ id: 'B1', key: '1:A reload keeps the filter.', text: 'A reload keeps the filter.' }],
    open: [
      {
        id: 'B2',
        key: '1:The filter is labelled.',
        reason: 'Task 01 R1-2 says the label is never rendered',
        text: 'The filter is labelled.',
      },
    ],
  });
});

test('an unknown or missing box, or a met box without evidence, comes back as a correction', async () => {
  const value = fixture();
  const checked = (checklist: string, decisions = 'none') =>
    validate(value, value.baseline(), handoff(value, { checklist, decisions }), {
      issue: { body: issueBody, review: approved() },
    }).then(failures);
  assert.match(
    await checked('- B1: met — Task 01 AC1\n- B2: met — src/store.ts\n- B9: met — Task 01 AC1'),
    /B9 is not an open box of the issue \(B1, B2\)/,
  );
  assert.match(await checked('- B1: met — Task 01 AC1'), /## Issue checklist has no line for B2/);
  const unsupported = await checked(
    '- B1: met — it works now\n- B2: met — Task 03 AC1, src/missing.ts:4\n',
  );
  assert.match(
    unsupported,
    /B1 is met but cites no verified task criterion \(Task 01 AC1\) or file/,
  );
  assert.match(unsupported, /B2 cites Task 03 AC1, which is not a criterion of this ticket/);
  assert.match(
    await checked('- B1: met — Task 01 AC1\n- B2: not_met'),
    /B2 is not_met without a reason/,
  );
  assert.match(
    await checked('- B1: met — Task 01 AC1\n- B2: not_met — later', 'We changed things.'),
    /## Decisions must be none or bullet points/,
  );
});

test('a met box rests on a criterion review verified or QA tested', async () => {
  const value = fixture();
  const checklist = '- B1: met — Task 01 AC1\n- B2: met — Task 01 AC2';
  const unverified = review(
    'approve',
    'none',
    undefined,
    '- AC1: verified — src/filter.ts:1\n- AC2: not_verified — needs a browser',
  );
  const output = handoff(value, { checklist });
  const options = { issue: { body: issueBody, review: unverified } };
  assert.match(
    failures(await validate(value, value.baseline(), output, options)),
    /B2 cites Task 01 AC2, which review did not verify and QA's test plan does not cover/,
  );
  // QA's test plan proves it instead.
  const qa = path.join(value.factoryRoot, 'tickets/proj-1/qa/01');
  mkdirSync(qa, { recursive: true });
  writeFileSync(
    path.join(qa, 'test-plan.md'),
    '| AC | Test | Screenshot |\n| --- | --- | --- |\n| AC2 | e2e/label.e2e.ts › shows the label | none |\n',
  );
  const outcome = await validate(value, value.baseline(), output, options);
  assert.equal(outcome.status, 'passed', failures(outcome));
});

test('a box is not met while an open review finding names the criterion it cites', async () => {
  const value = fixture();
  const outcome = await validate(
    value,
    value.baseline(),
    handoff(value, {
      checklist: '- B1: met — Task 01 AC1\n- B2: met — Task 01 AC2 verified',
    }),
    { issue: { body: issueBody, review: approved(labelFinding) } },
  );
  assert.match(
    failures(outcome),
    /B2 is met, but open finding Task 01 R1-2 names AC2; mark B2 not_met with that finding as the reason/,
  );
});

test('a missing heading fails', async () => {
  const value = fixture();
  const outcome = await validate(
    value,
    value.baseline(),
    handoff(value).replace('## Operations', '## Ops'),
  );
  assert.match(failures(outcome), /## Operations is missing/);
});

test('the Files section must list every changed path and nothing else', async () => {
  const value = fixture();
  const baseline = value.baseline();
  assert.match(
    failures(await validate(value, baseline, handoff(value, { files: ['src/filter.ts'] }))),
    /does not list changed path src\/store\.ts/,
  );
  assert.match(
    failures(
      await validate(
        value,
        baseline,
        handoff(value, { files: ['src/filter.ts', 'src/store.ts', 'src/ghost.ts'] }),
      ),
    ),
    /lists src\/ghost\.ts, which did not change/,
  );
});

test('a decision cites lines of a changed file, where the diff shows it', async () => {
  const value = fixture();
  const baseline = value.baseline();
  const decided = (where: string) =>
    validate(
      value,
      baseline,
      handoff(value, { decisions: `- Kept the filter in a module constant (${where})` }),
    );
  assert.equal((await decided('src/filter.ts:1')).status, 'passed');
  assert.match(
    failures(await decided('src/filter.ts:1-3')),
    /cites src\/filter\.ts:1-3, but src\/filter\.ts has 1 line/,
  );
  assert.match(
    failures(await decided('README.md:1')),
    /cites README\.md:1, but README\.md did not change/,
  );
});

test('the Tests section must name the recorded validation commands', async () => {
  const value = fixture();
  assert.match(
    failures(await validate(value, value.baseline(), handoff(value, { tests: 'Ran the suite.' }))),
    /does not mention the validation command test/,
  );
});

test('a product-code change by the wrap-up agent fails; a named doc change passes', async () => {
  const value = fixture();
  const baseline = value.baseline();
  writeFileSync(path.join(value.worktree, 'src/filter.ts'), 'export const filter = 3;\n');
  assert.match(
    failures(await validate(value, baseline, handoff(value))),
    /Wrap-up changed product code: src\/filter\.ts/,
  );

  const docs = fixture();
  const docsBaseline = docs.baseline();
  writeFileSync(path.join(docs.worktree, 'README.md'), '# demo\n\nThe filter persists.\n');
  assert.match(
    failures(await validate(docs, docsBaseline, handoff(docs))),
    /changed README\.md without naming it/,
  );
  const named = await validate(
    docs,
    docsBaseline,
    handoff(docs, { files: ['README.md', 'src/filter.ts', 'src/store.ts'] }),
  );
  assert.equal(named.status, 'passed', failures(named));

  const generated = fixture();
  const generatedBaseline = generated.baseline();
  writeFileSync(path.join(generated.worktree, 'src/schema.snap'), 'snapshot\n');
  const allowed = await validate(
    generated,
    generatedBaseline,
    handoff(generated, { files: ['src/filter.ts', 'src/schema.snap', 'src/store.ts'] }),
    { generated: ['*.snap'] },
  );
  assert.equal(allowed.status, 'passed', failures(allowed));
});

test('only CONTEXT.md, PRD.md, and learnings/ may change in the factory root', async () => {
  const value = fixture();
  const baseline = value.baseline();
  mkdirSync(path.join(value.factoryRoot, 'learnings'));
  writeFileSync(path.join(value.factoryRoot, 'CONTEXT.md'), '# Context\n');
  writeFileSync(path.join(value.factoryRoot, 'learnings/filters.md'), 'Persist early.\n');
  // The server and other tickets write beside wrap-up; that is not wrap-up's change.
  mkdirSync(path.join(value.factoryRoot, 'runtime'));
  writeFileSync(path.join(value.factoryRoot, 'runtime/tabs.json'), '{}\n');
  writeFileSync(path.join(value.factoryRoot, 'local.token'), 'token\n');
  mkdirSync(path.join(value.factoryRoot, 'tickets/proj-2'));
  writeFileSync(path.join(value.factoryRoot, 'tickets/proj-2/plan.md'), '# Other plan\n');
  assert.equal((await validate(value, baseline, handoff(value))).status, 'passed');
  writeFileSync(path.join(value.factoryRoot, 'tickets/proj-1/plan.md'), '# Edited plan\n');
  writeFileSync(path.join(value.factoryRoot, 'wrapup.md'), 'handoff\n');
  const text = failures(await validate(value, baseline, handoff(value)));
  assert.match(text, /changed \.factory\/tickets\/proj-1\/plan\.md/);
  assert.match(text, /changed \.factory\/wrapup\.md/);
});

test('an unexpected commit fails', async () => {
  const value = fixture();
  const baseline = value.baseline();
  git(value.worktree, ['add', '.']);
  git(value.worktree, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'sneaky']);
  assert.match(failures(await validate(value, baseline, handoff(value))), /A commit was made/);
});

function addRemote(value: Fixture): void {
  const remote = path.join(value.codeRoot, '..', `${path.basename(value.codeRoot)}-remote.git`);
  roots.push(remote);
  git(value.codeRoot, ['init', '--bare', remote]);
  git(value.codeRoot, ['remote', 'add', 'origin', remote]);
}

test('with pull requests off, a push fails and commands are required', async () => {
  const value = fixture();
  addRemote(value);
  const baseline = value.baseline();
  assert.equal((await validate(value, baseline, handoff(value))).status, 'passed');
  git(value.worktree, ['push', '-u', 'origin', branch]);
  assert.match(
    failures(await validate(value, baseline, handoff(value))),
    /pushed, but codeHost\.pullRequests is off/,
  );
});

test('with pull requests on and uncommitted changes, no push or pull request is allowed', async () => {
  const value = fixture();
  const baseline = value.baseline();
  const outcome = await validate(
    value,
    baseline,
    handoff(value, { merge: 'https://github.com/geut/demo/pull/7' }),
    { pullRequests: true },
  );
  assert.match(
    failures(outcome),
    /pull request was reported while the worktree has uncommitted changes/,
  );
  assert.equal(
    (await validate(value, baseline, handoff(value), { pullRequests: true })).status,
    'passed',
  );
});

test('with pull requests on and a clean worktree, the handoff needs a real pull request', async () => {
  const value = fixture();
  addRemote(value);
  // A human committed the approved work before wrap-up.
  git(value.worktree, ['add', '.']);
  git(value.worktree, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'Persist the filter']);
  const baseline = value.baseline();
  git(value.worktree, ['push', '-u', 'origin', branch]);
  const url = 'https://github.com/geut/demo/pull/7';
  const pullRequest = {
    author: 'dpaez',
    closedAt: null,
    headBranch: branch,
    headSha: git(value.worktree, ['rev-parse', 'HEAD']),
    mergedAt: null,
    number: 7,
    openedAt: '2026-10-15T10:00:00Z',
    state: 'open' as const,
    url,
  };
  const found: PullRequestLookup = () => pullRequest;
  const passed = await validate(value, baseline, handoff(value, { merge: url }), {
    findPullRequest: found,
    pullRequests: true,
  });
  assert.equal(passed.status, 'passed', failures(passed));
  // A passing wrap-up hands the controller the pull request it checked.
  assert.deepEqual(passed.status === 'passed' ? passed.detail.pullRequest : null, pullRequest);
  assert.match(
    failures(
      await validate(value, baseline, handoff(value, { merge: url }), { pullRequests: true }),
    ),
    /No pull request exists at/,
  );
  assert.match(
    failures(
      await validate(value, baseline, handoff(value), {
        findPullRequest: found,
        pullRequests: true,
      }),
    ),
    /needs the pull-request URL/,
  );
  const broken = await validate(value, baseline, handoff(value, { merge: url }), {
    findPullRequest: () => {
      throw new Error('gh: network unreachable');
    },
    pullRequests: true,
  });
  assert.equal(broken.status, 'error');
  assert.equal(broken.summary, 'gh: network unreachable');
});

const url = 'https://github.com/geut/demo/pull/7';

// The pull request on the code host whose branch is at `headSha`.
function openPullRequest(headSha: string | null): PullRequestLookup {
  return () => ({
    author: 'dpaez',
    closedAt: null,
    headBranch: branch,
    headSha,
    mergedAt: null,
    number: 7,
    openedAt: '2026-10-15T10:00:00Z',
    state: 'open',
    url,
  });
}

function commit(value: Fixture, paths: Array<string>, message = 'feat: persist the filter (#1)') {
  git(value.worktree, ['add', '--', ...paths]);
  git(value.worktree, ['-c', 'commit.gpgsign=false', 'commit', '-m', message]);
  return git(value.worktree, ['rev-parse', 'HEAD']);
}

test('with pull requests on, wrap-up commits the approved work, pushes it, and opens the pull request', async () => {
  const value = fixture();
  addRemote(value);
  const baseline = value.baseline();
  const head = commit(value, ['src/filter.ts', 'src/store.ts']);
  git(value.worktree, ['push', '-u', 'origin', branch]);
  const outcome = await validate(value, baseline, handoff(value, { merge: url }), {
    findPullRequest: openPullRequest(head),
    pullRequests: true,
  });
  assert.equal(outcome.status, 'passed', failures(outcome));
  if (outcome.status === 'passed') {
    assert.equal(outcome.detail.pullRequest?.headSha, head);
    assert.deepEqual(
      outcome.checks.filter((item) => item.name === 'ticket commits').map((item) => item.details),
      [`committed on ${branch} at ${head}`],
    );
  }
});

test('with pull requests on, the commit holds only paths ## Files lists', async () => {
  const value = fixture();
  addRemote(value);
  const baseline = value.baseline();
  writeFileSync(path.join(value.worktree, 'src/extra.ts'), 'export const extra = 1;\n');
  const head = commit(value, ['src/filter.ts', 'src/store.ts', 'src/extra.ts']);
  git(value.worktree, ['push', '-u', 'origin', branch]);
  const text = failures(
    await validate(value, baseline, handoff(value, { merge: url }), {
      findPullRequest: openPullRequest(head),
      pullRequests: true,
    }),
  );
  assert.match(text, /The commit includes src\/extra\.ts, which ## Files does not list/);
  assert.match(text, /Wrap-up changed product code: src\/extra\.ts/);
});

test('with pull requests on, a commit that was not pushed fails', async () => {
  const value = fixture();
  addRemote(value);
  const baseline = value.baseline();
  const head = commit(value, ['src/filter.ts', 'src/store.ts']);
  assert.match(
    failures(
      await validate(value, baseline, handoff(value, { merge: url }), {
        findPullRequest: openPullRequest(value.baseSha),
        pullRequests: true,
      }),
    ),
    new RegExp(`has head ${value.baseSha}, not the local HEAD ${head}; push`),
  );
});

test('with pull requests on, committing part of the work fails', async () => {
  const value = fixture();
  const baseline = value.baseline();
  commit(value, ['src/filter.ts']);
  assert.match(
    failures(await validate(value, baseline, handoff(value), { pullRequests: true })),
    /committed part of the work and left the rest uncommitted/,
  );
});

test('with pull requests on, rewriting a commit made before wrap-up fails', async () => {
  const value = fixture();
  addRemote(value);
  // A human committed part of the work before wrap-up.
  commit(value, ['src/filter.ts'], 'wip');
  const baseline = value.baseline();
  git(value.worktree, ['add', '--', 'src/store.ts']);
  git(value.worktree, ['-c', 'commit.gpgsign=false', 'commit', '--amend', '-m', 'everything']);
  const head = git(value.worktree, ['rev-parse', 'HEAD']);
  git(value.worktree, ['push', '-u', 'origin', branch]);
  assert.match(
    failures(
      await validate(value, baseline, handoff(value, { merge: url }), {
        findPullRequest: openPullRequest(head),
        pullRequests: true,
      }),
    ),
    /does not contain .*, the commit wrap-up started from/,
  );
});

test('with pull requests on, a merge commit fails', async () => {
  const value = fixture();
  addRemote(value);
  const baseline = value.baseline();
  git(value.codeRoot, ['switch', '-c', 'side']);
  writeFileSync(path.join(value.codeRoot, 'side.md'), 'side\n');
  git(value.codeRoot, ['add', 'side.md']);
  git(value.codeRoot, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'side']);
  git(value.codeRoot, ['switch', 'main']);
  commit(value, ['src/filter.ts', 'src/store.ts']);
  git(value.worktree, [
    '-c',
    'commit.gpgsign=false',
    'merge',
    '--no-ff',
    '-m',
    'merge side',
    'side',
  ]);
  const head = git(value.worktree, ['rev-parse', 'HEAD']);
  git(value.worktree, ['push', '-u', 'origin', branch]);
  assert.match(
    failures(
      await validate(
        value,
        baseline,
        handoff(value, { files: ['side.md', 'src/filter.ts', 'src/store.ts'], merge: url }),
        { findPullRequest: openPullRequest(head), pullRequests: true },
      ),
    ),
    /Wrap-up made a merge commit/,
  );
});

test('Files paths come from backticks or the first word of a list item', () => {
  assert.deepEqual(
    [...listedPaths('- `src/a.ts` — new\n- src/b.ts: changed\n- **Removed:** `old/c.md`\nnone\n')],
    ['src/a.ts', 'src/b.ts', 'old/c.md'],
  );
  // What a line says about its file may name other code; only the paths before it count.
  assert.deepEqual(
    [...listedPaths('- `src/a.ts`, `src/b.ts` — both call `api/client.ts` now\n')],
    ['src/a.ts', 'src/b.ts'],
  );
});
