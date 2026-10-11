import { existsSync } from 'node:fs';
import path from 'node:path';
import type { FactorySnapshot } from '../domain.ts';
import { contained, worktreeFailures } from './work-input.ts';

export type WrapupInputInspection =
  | { adrPath: string | null; contextPath: string | null; kind: 'ready' }
  | { failures: Array<string>; kind: 'failed' };

// Code-owned checks before any wrap-up run launches. They read the
// filesystem and Git, so they run outside the controller transaction.
export function inspectWrapupInput(input: {
  activeChild: boolean;
  executionCurrent: boolean;
  factoryRoot: string;
  snapshot: FactorySnapshot;
}): WrapupInputInspection {
  const { snapshot } = input;
  const execution = snapshot.execution;
  const failures: Array<string> = [];
  if (!input.executionCurrent) {
    failures.push('The execution is not current.');
  }
  if (execution.stage !== 'wrapup') {
    failures.push(`The execution is in ${execution.stage}, not wrapup.`);
  }
  if (snapshot.tasks.length === 0) {
    failures.push('The execution has no registered tasks.');
  }
  for (const task of snapshot.tasks) {
    if (task.status !== 'done') {
      const at = task.stage === null ? task.status : `at ${task.stage}`;
      failures.push(`Task ${task.taskId} is ${at}, not done.`);
    } else if (task.summaries.review?.label !== 'approve') {
      failures.push(`Task ${task.taskId} has no approving review.`);
    }
  }
  if (input.activeChild) {
    failures.push('Another child is active for this execution.');
  }
  const worktree = execution.worktreePath;
  const branch = execution.worktreeBranch;
  if (worktree === null || branch === null || execution.worktreeStatus !== 'ready') {
    failures.push('The worktree is not ready for this execution.');
    return { failures, kind: 'failed' };
  }
  const worktreePath = path.resolve(worktree);
  const factoryRoot = path.resolve(input.factoryRoot);
  const planPath = path.resolve(execution.planPath ?? path.join(execution.factoryDir, 'plan.md'));
  const taskFiles = snapshot.tasks.map((task) => path.resolve(execution.factoryDir, task.taskFile));
  if (!existsSync(planPath)) {
    failures.push('plan.md is missing.');
  }
  snapshot.tasks.forEach((task, index) => {
    if (!existsSync(taskFiles[index] ?? '')) {
      failures.push(`The task file for ${task.taskId} is missing.`);
    }
  });
  for (const target of [planPath, worktreePath, ...taskFiles]) {
    if (!contained(factoryRoot, worktreePath, target)) {
      failures.push(`Path is outside the factory root or worktree: ${target}`);
    }
  }
  failures.push(...worktreeFailures(worktreePath, branch));
  if (failures.length > 0) {
    return { failures, kind: 'failed' };
  }
  const adrPath = path.join(execution.factoryDir, 'adr.md');
  const contextPath = path.join(factoryRoot, 'CONTEXT.md');
  return {
    adrPath: existsSync(adrPath) ? adrPath : null,
    contextPath: existsSync(contextPath) ? contextPath : null,
    kind: 'ready',
  };
}
