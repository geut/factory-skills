import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export type WorkInputInspection =
  | {
      adrPath: string | null;
      contextPath: string | null;
      kind: 'ready';
      taskType: string | null;
    }
  | { failures: Array<string>; kind: 'failed' };

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function contained(factoryRoot: string, worktreePath: string, target: string): boolean {
  return inside(factoryRoot, target) || inside(worktreePath, target);
}

function taskType(file: string): string | null {
  try {
    const match = /^Type:\s*(.+)$/m.exec(readFileSync(file, 'utf8'));
    const value = match?.[1]?.trim();
    return value === undefined || value.length === 0 ? null : value;
  } catch {
    return null;
  }
}

// The worktree exists and is on the ticket branch.
export function worktreeFailures(worktreePath: string, expectedBranch: string): Array<string> {
  if (!existsSync(worktreePath) || !statSync(worktreePath).isDirectory()) {
    return ['The worktree path is not a directory.'];
  }
  const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: worktreePath,
    encoding: 'utf8',
  });
  const name = (branch.stdout ?? '').trim();
  if (branch.status !== 0 || name !== expectedBranch) {
    return [`The worktree is on ${name || 'an unknown branch'}, expected ${expectedBranch}.`];
  }
  return [];
}

export function inspectWorkInput(input: {
  activeChild: boolean;
  dependenciesDone: boolean;
  executionCurrent: boolean;
  expectedBranch: string;
  factoryDir: string;
  factoryRoot: string;
  planPath: string;
  selectedTask: boolean;
  taskFile: string;
  worktreePath: string;
  worktreeReady: boolean;
}): WorkInputInspection {
  const failures: Array<string> = [];
  if (!input.executionCurrent) {
    failures.push('The execution is not current.');
  }
  if (!input.selectedTask) {
    failures.push('The task is not the selected dependency-ready task.');
  }
  if (!input.dependenciesDone) {
    failures.push('A task dependency is not done.');
  }
  if (!input.worktreeReady) {
    failures.push('The worktree is not ready for this execution.');
  }
  if (input.activeChild) {
    failures.push('Another child is active for this execution.');
  }
  const planPath = path.resolve(input.planPath);
  const taskFilePath = path.resolve(input.factoryDir, input.taskFile);
  const worktreePath = path.resolve(input.worktreePath);
  const factoryRoot = path.resolve(input.factoryRoot);
  if (!existsSync(planPath)) {
    failures.push('plan.md is missing.');
  }
  if (!existsSync(taskFilePath)) {
    failures.push('The task file is missing.');
  }
  for (const target of [planPath, taskFilePath, worktreePath]) {
    if (!contained(factoryRoot, worktreePath, target)) {
      failures.push(`Path is outside the factory root or worktree: ${target}`);
    }
  }
  failures.push(...worktreeFailures(worktreePath, input.expectedBranch));
  if (failures.length > 0) {
    return { failures, kind: 'failed' };
  }
  const adrPath = path.join(input.factoryDir, 'adr.md');
  const contextPath = path.join(factoryRoot, 'CONTEXT.md');
  return {
    adrPath: existsSync(adrPath) ? adrPath : null,
    contextPath: existsSync(contextPath) ? contextPath : null,
    kind: 'ready',
    taskType: taskType(taskFilePath),
  };
}
