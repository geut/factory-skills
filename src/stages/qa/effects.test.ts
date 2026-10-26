import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import type { WorkCommand } from '../../config.ts';
import { addTasks, task } from '../../stories/fixtures.ts';
import { validationContext } from '../../validation/fixture.ts';
import type { ValidationCheck } from '../../validation/report.ts';
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
    typecheck?: WorkCommand;
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
    '| AC | Test | Screenshot |\n| --- | --- | --- |\n| AC1 | e2e/app.e2e.ts › shows 2 | none |\n',
  );
  writeFileSync(paths.ledger, 'none\n');
  return qaValidator.validate(
    validationContext('qa', (snapshot, finished) => {
      addTasks(snapshot, 1);
      task(snapshot, '01').taskFile = '01-task.md';
      snapshot.execution.factoryDir = factoryDir;
      snapshot.execution.worktreePath = cwd;
      snapshot.execution.policy.stages['qa'] = {
        commands: [input.e2e ?? command('e2e')],
        enabled: true,
        ...(input.again === undefined ? {} : { workCommands: input.again }),
      };
      snapshot.execution.policy.validation.work.commands = [
        command('test'),
        input.typecheck ?? command('check'),
        input.lint ?? command('lint'),
      ];
      finished.baseline = input.baseline === false ? null : baseline;
    }),
  );
}

test('QA runs the work commands again after its own, and hands on both groups of checks', async () => {
  const report = await validate(worktree(), { again: ['check', 'lint'] });
  assert.equal(report.status, 'passed');
  assert.deepEqual(
    report.checks.filter((check) => check.kind === 'command').map((check) => check.name),
    ['e2e', 'check', 'lint'],
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
