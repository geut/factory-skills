import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { inspectWorkInput } from './work-input.ts';

const roots: Array<string> = [];
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_EMAIL: 'factory@example.com',
  GIT_AUTHOR_NAME: 'Factory',
  GIT_COMMITTER_EMAIL: 'factory@example.com',
  GIT_COMMITTER_NAME: 'Factory',
};

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) {
      rmSync(root, { force: true, recursive: true });
    }
  }
});

function git(cwd: string, args: Array<string>): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
}

function fixture(): { factoryDir: string; factoryRoot: string; worktree: string } {
  const factoryRoot = mkdtempSync(path.join(process.cwd(), '.scratch-work-input-'));
  roots.push(factoryRoot);
  const codeRoot = path.join(factoryRoot, 'repo');
  const factoryDir = path.join(factoryRoot, 'tickets', 'proj');
  const worktree = path.join(factoryRoot, 'worktrees', 'proj');
  mkdirSync(codeRoot, { recursive: true });
  mkdirSync(factoryDir, { recursive: true });
  git(codeRoot, ['init', '-b', 'main']);
  writeFileSync(path.join(codeRoot, 'README.md'), '# demo\n');
  git(codeRoot, ['add', 'README.md']);
  git(codeRoot, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'init']);
  git(codeRoot, ['worktree', 'add', '-b', 'factory/proj', worktree, 'HEAD']);
  writeFileSync(path.join(factoryDir, 'plan.md'), '# Plan\n');
  writeFileSync(path.join(factoryDir, '01-task.md'), '# Task\n\nType: feature\n');
  return { factoryDir, factoryRoot, worktree };
}

function readyInput(paths: { factoryDir: string; factoryRoot: string; worktree: string }) {
  return {
    activeChild: false,
    dependenciesDone: true,
    executionCurrent: true,
    expectedBranch: 'factory/proj',
    factoryDir: paths.factoryDir,
    factoryRoot: paths.factoryRoot,
    planPath: path.join(paths.factoryDir, 'plan.md'),
    selectedTask: true,
    taskFile: '01-task.md',
    worktreePath: paths.worktree,
    worktreeReady: true,
  };
}

test('valid work input reports the task type', () => {
  const paths = fixture();
  const inspected = inspectWorkInput(readyInput(paths));
  assert.equal(inspected.kind, 'ready');
  if (inspected.kind !== 'ready') {
    return;
  }
  assert.equal(inspected.taskType, 'feature');
});

test('work input fails for missing files, dependencies, children, branch, and escaped paths', () => {
  const paths = fixture();
  const missing = inspectWorkInput({
    ...readyInput(paths),
    planPath: path.join(paths.factoryDir, 'missing.md'),
  });
  assert.equal(missing.kind, 'failed');
  if (missing.kind === 'failed') {
    assert.match(missing.failures.join('\n'), /plan.md is missing/);
  }
  rmSync(path.join(paths.factoryDir, '01-task.md'));
  const missingTask = inspectWorkInput(readyInput(paths));
  assert.equal(missingTask.kind, 'failed');
  if (missingTask.kind === 'failed') {
    assert.match(missingTask.failures.join('\n'), /task file is missing/);
  }
  writeFileSync(path.join(paths.factoryDir, '01-task.md'), '# Task\n');
  const dependency = inspectWorkInput({ ...readyInput(paths), dependenciesDone: false });
  assert.equal(dependency.kind, 'failed');
  if (dependency.kind === 'failed') {
    assert.match(dependency.failures.join('\n'), /dependency is not done/);
  }
  const child = inspectWorkInput({ ...readyInput(paths), activeChild: true });
  assert.equal(child.kind, 'failed');
  if (child.kind === 'failed') {
    assert.match(child.failures.join('\n'), /Another child is active/);
  }
  git(paths.worktree, ['checkout', '-b', 'other']);
  const branch = inspectWorkInput(readyInput(paths));
  assert.equal(branch.kind, 'failed');
  if (branch.kind === 'failed') {
    assert.match(branch.failures.join('\n'), /expected factory\/proj/);
  }
  const outside = path.join(paths.factoryRoot, 'outside.md');
  writeFileSync(outside, 'secret\n');
  const escaped = inspectWorkInput({
    ...readyInput(paths),
    factoryRoot: paths.factoryDir,
    taskFile: path.relative(paths.factoryDir, outside),
  });
  unlinkSync(outside);
  assert.equal(escaped.kind, 'failed');
  if (escaped.kind === 'failed') {
    assert.match(escaped.failures.join('\n'), /outside the factory root or worktree/);
  }
});
