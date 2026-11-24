import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import type { WorkCommand } from '../../config.ts';
import { addTasks, run, session, task } from '../../stories/fixtures.ts';
import { validationContext } from '../../validation/fixture.ts';
import type { ValidationCheck } from '../../validation/report.ts';
import { SELECTION_ENV } from '../../validation/selection.ts';
import { collectWorkDiff } from '../../validation/work.ts';
import { qaPaths } from './criteria.ts';
import { qaBaseline, qaValidator } from './effects.ts';

const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function temp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

// A worktree where the worker changed src/app.ts.
function worktree(): string {
  const cwd = temp('factory-qa-');
  const git = (args: Array<string>) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(result.stderr);
    }
  };
  git(['init', '-b', 'main']);
  mkdirSync(path.join(cwd, 'src'));
  writeFileSync(path.join(cwd, 'src/app.ts'), 'export const a = 1;\n');
  git(['add', '.']);
  git(['config', 'user.email', 'factory@example.com']);
  git(['config', 'user.name', 'Factory']);
  git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'init']);
  writeFileSync(path.join(cwd, 'src/app.ts'), 'export const a = 2;\n');
  return cwd;
}

// A command that prints `output` and exits with `code`.
function command(name: string, output = '', code = 0): WorkCommand {
  return {
    argv: ['node', '-e', `console.log(${JSON.stringify(output)}); process.exit(${code})`],
    name,
    timeoutMs: 10_000,
  };
}

const passedTest: ValidationCheck = {
  command: 'npm test',
  details: 'passed in work validation',
  kind: 'command',
  name: 'test',
  status: 'passed',
};

// QA of task 01 in `cwd`: the baseline is taken as work left it, then QA
// writes its test and its plan, then the validator runs.
function validate(
  cwd: string,
  input: {
    again?: Array<string>;
    baseline?: false;
    e2e?: WorkCommand;
    lint?: WorkCommand;
    // The test the plan cites for AC1.
    proof?: string;
    // Collects the commands the validator reports as it starts each one.
    reported?: Array<string>;
    typecheck?: WorkCommand;
    // The reply of the task's last work run.
    workReply?: string;
  },
) {
  const factoryDir = temp('factory-qa-ticket-');
  writeFileSync(
    path.join(factoryDir, '01-task.md'),
    '# Demo\n\n## Acceptance criteria\n\n- [ ] The app shows 2.\n',
  );
  const diff = collectWorkDiff(cwd);
  const baseline = qaBaseline('message' in diff ? '' : diff.diff, [passedTest]);
  mkdirSync(path.join(cwd, 'e2e'), { recursive: true });
  writeFileSync(path.join(cwd, 'e2e/app.e2e.ts'), 'test("shows 2", () => {});\n');
  const paths = qaPaths(factoryDir, '01');
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(
    paths.plan,
    `| AC | Test | Screenshot |\n| --- | --- | --- |\n| AC1 | ${input.proof ?? 'e2e/app.e2e.ts › shows 2'} | none |\n`,
  );
  writeFileSync(paths.ledger, 'none\n');
  return qaValidator.validate(
    validationContext(
      'qa',
      (snapshot, finished) => {
        addTasks(snapshot, 1);
        task(snapshot, '01').taskFile = '01-task.md';
        snapshot.execution.factoryDir = factoryDir;
        snapshot.execution.worktreePath = cwd;
        // The commit the ticket branched from: its worktree descends from it.
        snapshot.execution.worktreeBaseSha = spawnSync('git', ['rev-parse', 'HEAD'], {
          cwd,
          encoding: 'utf8',
        }).stdout.trim();
        snapshot.execution.policy.stages['qa'] = {
          commands: [input.e2e ?? command('e2e')],
          enabled: true,
        };
        const work = [
          command('test'),
          input.typecheck ?? command('check'),
          input.lint ?? command('lint'),
        ];
        snapshot.execution.policy.validation.work.commands = work;
        snapshot.execution.policy.validation.qa.commands =
          input.again === undefined
            ? work
            : work.filter((item) => input.again?.includes(item.name));
        finished.baseline = input.baseline === false ? null : baseline;
        if (input.workReply !== undefined) {
          run(snapshot, session(snapshot, 'work', '01'), { output: input.workReply });
        }
      },
      {
        reportCommand: (progress) => {
          input.reported?.push(
            progress === null ? 'none' : `${progress.command} ${progress.index}/${progress.total}`,
          );
        },
      },
    ),
  );
}

test('QA runs every work command after its own, and hands on both groups of checks', async () => {
  // validation.qa lists only lint, yet the type check still runs: QA's
  // files must pass what work had to.
  const report = await validate(worktree(), { again: ['lint'] });
  assert.equal(report.status, 'passed');
  assert.deepEqual(
    report.checks.filter((check) => check.kind === 'command').map((check) => check.name),
    ['e2e', 'test', 'check', 'lint'],
  );
  assert.deepEqual(
    report.status === 'passed' ? report.detail.workChecks.map((check) => check.name) : null,
    ['test', 'check', 'lint'],
  );
  assert.deepEqual(
    report.status === 'passed' ? report.detail.qaChecks.map((check) => check.name) : null,
    ['test plan', 'test-gap ledger', 'AC1 covered', 'e2e'],
  );
});

test('a lint failure in a file QA wrote is QA’s to correct', async () => {
  const report = await validate(worktree(), {
    lint: command('lint', 'e2e/app.e2e.ts:1:1 error no-unused-vars', 1),
  });
  assert.equal(report.status === 'failed' && report.detail.reason, 'incomplete');
  assert.match(
    report.status === 'failed' ? report.failures.join('\n') : '',
    /lint .* failed after QA in e2e\/app\.e2e\.ts:/,
  );
});

test('a type error in a test QA wrote fails QA, though validation.qa leaves the type check out', async () => {
  const report = await validate(worktree(), {
    again: ['lint'],
    typecheck: command('check', 'e2e/app.e2e.ts:994:39 Error: Argument of type', 1),
  });
  assert.equal(report.status === 'failed' && report.detail.reason, 'incomplete');
  assert.match(
    report.status === 'failed' ? report.failures.join('\n') : '',
    /check .* failed after QA in e2e\/app\.e2e\.ts:/,
  );
});

test('a type error in product code after QA goes back to work', async () => {
  const report = await validate(worktree(), {
    typecheck: command('check', 'src/app.ts(1,14): error TS2322', 1),
  });
  assert.equal(report.status === 'failed' && report.detail.reason, 'product');
  assert.match(
    report.status === 'failed' ? report.failures.join('\n') : '',
    /check .* failed after QA: src\/app\.ts\(1,14\)/,
  );
});

test('QA corrects its own files first, even when its tests also fail', async () => {
  const report = await validate(worktree(), {
    e2e: command('e2e', 'AC1 failed', 1),
    lint: command('lint', 'e2e/app.e2e.ts:1:1 error no-unused-vars', 1),
  });
  assert.equal(report.status === 'failed' && report.detail.reason, 'incomplete');
});

test('without a baseline, or with a longer path, no failure is QA’s', async () => {
  const lint = command('lint', 'e2e/app.e2e.ts:1:1 error no-unused-vars', 1);
  const unknown = await validate(worktree(), { baseline: false, lint });
  assert.equal(unknown.status === 'failed' && unknown.detail.reason, 'product');
  const longer = await validate(worktree(), {
    lint: command('lint', 'tests/e2e/app.e2e.tsx:1:1 error', 1),
  });
  assert.equal(longer.status === 'failed' && longer.detail.reason, 'product');
});

test('a component test or story counts as a criterion’s proof', async () => {
  const report = await validate(worktree(), {
    proof: 'src/App.stories.ts › Shows two (story, light and dark)',
  });
  assert.equal(report.status, 'passed');
  assert.equal(report.checks.find((check) => check.name === 'AC1 covered')?.status, 'passed');
});

test('QA reports each command as it starts, its own then the validation ones, on one count', async () => {
  const reported: Array<string> = [];
  await validate(worktree(), { again: ['lint'], reported });
  assert.deepEqual(reported, ['e2e 1/4', 'test 2/4', 'check 3/4', 'lint 4/4']);
});

// A command that writes the selection it was given to `file`.
function recorder(name: string, file: string): WorkCommand {
  return {
    argv: [
      'node',
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(file)}, process.env.${SELECTION_ENV} ?? 'unset')`,
    ],
    name,
    timeoutMs: 10_000,
  };
}

test('the work commands QA runs again get the task’s latest work selection; QA’s own do not', async () => {
  const cwd = worktree();
  mkdirSync(path.join(cwd, 'tests'));
  writeFileSync(path.join(cwd, 'tests/app.test.ts'), 'test\n');
  const out = temp('factory-qa-seen-');
  const report = await validate(cwd, {
    e2e: recorder('e2e', path.join(out, 'e2e.txt')),
    typecheck: recorder('check', path.join(out, 'check.txt')),
    workReply: '## Validation selection\n\n- `tests/app.test.ts`: the app shows 2\n',
  });
  assert.equal(report.status, 'passed', JSON.stringify(report));
  assert.deepEqual(JSON.parse(readFileSync(path.join(out, 'check.txt'), 'utf8')), {
    tests: [{ path: 'tests/app.test.ts', reason: 'the app shows 2' }],
    version: 1,
  });
  assert.equal(readFileSync(path.join(out, 'e2e.txt'), 'utf8'), 'unset');
});
