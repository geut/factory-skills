import path from 'node:path';
import { inspectWorkInput } from '../../actions/work-input.ts';
import { factoryRootOf } from '../../controller/keys.ts';
import type { FactorySnapshot, TaskRecord } from '../../domain.ts';
import type { InputContext, InputResult } from '../effects.ts';
import type { WorkPrepared } from './definition.ts';

function readyTask(snapshot: FactorySnapshot): TaskRecord | null {
  const done = new Set(
    snapshot.tasks.filter((task) => task.status === 'done').map((task) => task.taskId),
  );
  const ready = snapshot.tasks
    .filter((task) => task.status === 'pending' && task.blockedBy.every((id) => done.has(id)))
    .sort((left, right) => left.ordinal - right.ordinal);
  return ready[0] ?? null;
}

function dependenciesDone(snapshot: FactorySnapshot, task: TaskRecord): boolean {
  return task.blockedBy.every((id) =>
    snapshot.tasks.some((item) => item.taskId === id && item.status === 'done'),
  );
}

export function prepareWorkInput({
  action,
  deps,
  snapshot,
}: InputContext): InputResult<WorkPrepared> {
  const factoryRoot = factoryRootOf(snapshot.execution.factoryDir);
  const task = snapshot.tasks.find((item) => item.taskId === action.taskId) ?? null;
  const selected =
    task !== null &&
    (action.purpose === 'initial'
      ? readyTask(snapshot)?.taskId === task.taskId
      : action.purpose === 'validation_correction' || action.purpose === 'return_to_work'
        ? task.status === 'active' && task.stage === 'work'
        : task.status === 'blocked');
  const inspection =
    task === null ||
    snapshot.execution.worktreePath === null ||
    snapshot.execution.worktreeBranch === null
      ? { failures: ['The worktree is not ready for this execution.'], kind: 'failed' as const }
      : inspectWorkInput({
          activeChild: snapshot.runs.some((run) => run.status !== 'terminal'),
          dependenciesDone: dependenciesDone(snapshot, task),
          executionCurrent: deps.executionCurrent,
          expectedBranch: snapshot.execution.worktreeBranch,
          factoryDir: snapshot.execution.factoryDir,
          factoryRoot,
          planPath:
            snapshot.execution.planPath ?? path.join(snapshot.execution.factoryDir, 'plan.md'),
          selectedTask: selected,
          taskFile: task.taskFile,
          worktreePath: snapshot.execution.worktreePath,
          worktreeReady: snapshot.execution.worktreeStatus === 'ready',
        });
  if (inspection.kind === 'failed') {
    return { kind: 'failed', message: inspection.failures.join('\n') };
  }
  return {
    input: {
      adrPath: inspection.adrPath,
      contextPath: inspection.contextPath,
      taskType: inspection.taskType,
    },
    kind: 'ready',
  };
}
