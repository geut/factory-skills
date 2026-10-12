import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import type { FactorySnapshot } from '../domain.ts';
import { addTasks, blank, setTask } from '../stories/fixtures.ts';
import { inspectWrapupInput } from './wrapup-input.ts';

const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function git(cwd: string, args: Array<string>): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  }
}

// Two approved tasks, with plan, task files, and a worktree on the branch.
function ready(): { factoryRoot: string; snapshot: FactorySnapshot } {
  const codeRoot = mkdtempSync(path.join(tmpdir(), 'factory-wrapup-input-'));
  roots.push(codeRoot);
  git(codeRoot, ['init', '-b', 'main']);
  writeFileSync(path.join(codeRoot, 'README.md'), '# demo\n');
  git(codeRoot, ['add', '.']);
  git(codeRoot, [
    '-c',
    'user.email=f@example.com',
    '-c',
    'user.name=F',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'init',
  ]);
  const factoryRoot = path.join(codeRoot, '.factory');
  const factoryDir = path.join(factoryRoot, 'tickets/proj-1');
  mkdirSync(factoryDir, { recursive: true });
  const worktree = path.join(factoryRoot, 'worktrees/proj-1');
  git(codeRoot, ['worktree', 'add', '-b', 'factory/proj-1', worktree, 'main']);
  const snapshot = blank();
  addTasks(snapshot, 2);
  for (const task of snapshot.tasks) {
    task.taskFile = `${task.taskId}-task.md`;
    writeFileSync(path.join(factoryDir, task.taskFile), `# ${task.title}\n`);
    setTask(snapshot, task.taskId, 'done', { round: 1, verdict: 'approve' });
  }
  writeFileSync(path.join(factoryDir, 'plan.md'), '# Plan\n');
  snapshot.execution = {
    ...snapshot.execution,
    factoryDir,
    planPath: path.join(factoryDir, 'plan.md'),
    stage: 'wrapup',
    worktreeBranch: 'factory/proj-1',
    worktreePath: worktree,
    worktreeStatus: 'ready',
  };
  return { factoryRoot, snapshot };
}

function inspect(
  value: { factoryRoot: string; snapshot: FactorySnapshot },
  overrides: { activeChild?: boolean; executionCurrent?: boolean } = {},
) {
  return inspectWrapupInput({
    activeChild: overrides.activeChild ?? false,
    executionCurrent: overrides.executionCurrent ?? true,
    factoryRoot: value.factoryRoot,
    snapshot: value.snapshot,
  });
}

function failures(result: ReturnType<typeof inspect>): string {
  return result.kind === 'failed' ? result.failures.join('\n') : '';
}

test('valid wrap-up input is ready, with the optional ADR and context', () => {
  const value = ready();
  assert.deepEqual(inspect(value), { adrPath: null, contextPath: null, kind: 'ready' });
  writeFileSync(path.join(value.snapshot.execution.factoryDir, 'adr.md'), '# ADR\n');
  writeFileSync(path.join(value.factoryRoot, 'CONTEXT.md'), '# Context\n');
  const result = inspect(value);
  assert.equal(result.kind, 'ready');
  if (result.kind === 'ready') {
    assert.match(result.adrPath ?? '', /adr\.md$/);
    assert.match(result.contextPath ?? '', /CONTEXT\.md$/);
  }
});

test('a task that is not done, or not approved, blocks wrap-up', () => {
  const pending = ready();
  setTask(pending.snapshot, '02', { stage: 'review' });
  assert.match(failures(inspect(pending)), /Task 02 is at review, not done/);
  const unapproved = ready();
  setTask(unapproved.snapshot, '02', 'done', { round: 1, verdict: 'changes_requested' });
  assert.match(failures(inspect(unapproved)), /Task 02 has no approving review/);
});

test('a missing plan or task file blocks wrap-up', () => {
  const value = ready();
  rmSync(value.snapshot.execution.planPath ?? '');
  rmSync(path.join(value.snapshot.execution.factoryDir, '02-task.md'));
  const text = failures(inspect(value));
  assert.match(text, /plan\.md is missing/);
  assert.match(text, /task file for 02 is missing/);
});

test('a wrong worktree or branch blocks wrap-up', () => {
  const wrongBranch = ready();
  wrongBranch.snapshot.execution.worktreeBranch = 'factory/other';
  assert.match(failures(inspect(wrongBranch)), /expected factory\/other/);
  const notReady = ready();
  notReady.snapshot.execution.worktreeStatus = 'preparing';
  assert.match(failures(inspect(notReady)), /worktree is not ready/);
});

test('another active child, a stale execution, or the wrong stage blocks wrap-up', () => {
  const value = ready();
  assert.match(failures(inspect(value, { activeChild: true })), /Another child is active/);
  assert.match(failures(inspect(value, { executionCurrent: false })), /not current/);
  value.snapshot.execution.stage = 'review';
  assert.match(failures(inspect(value)), /in review, not wrapup/);
});

test('a path outside the factory root and worktree blocks wrap-up', () => {
  const value = ready();
  const outside = mkdtempSync(path.join(tmpdir(), 'factory-outside-'));
  roots.push(outside);
  writeFileSync(path.join(outside, 'plan.md'), '# Plan\n');
  value.snapshot.execution.planPath = path.join(outside, 'plan.md');
  assert.match(failures(inspect(value)), /outside the factory root or worktree/);
});
