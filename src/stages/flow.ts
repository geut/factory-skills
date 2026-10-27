import type { FactorySnapshot, Policy, StageName, TaskId, TaskRecord } from '../domain.ts';
import { stages } from './index.ts';

// The order of the factory: stages that run once per ticket, then the
// per-task stages for each task in dependency order, then the closing stages.
export const flow = {
  closing: ['wrapup'],
  // QA is optional: it runs only when FACTORY.json stages.qa enables it.
  task: ['work', 'qa', 'review'],
  ticket: ['plan'],
} as const satisfies Record<'closing' | 'task' | 'ticket', ReadonlyArray<StageName>>;

// What runs after a stage accepts its output.
export type Step =
  | { kind: 'stage'; stage: StageName; taskId: TaskId | null }
  // Tasks remain, but none has its dependencies done.
  | { kind: 'waiting'; taskIds: Array<TaskId> }
  // Every stage is done: the person takes the ticket from here.
  | { kind: 'handoff' };

// Every stage in the order a ticket meets it, and whether it runs per task.
export const pipeline: ReadonlyArray<{ perTask: boolean; stage: StageName }> = [
  ...flow.ticket.map((stage) => ({ perTask: false, stage })),
  ...flow.task.map((stage) => ({ perTask: true, stage })),
  ...flow.closing.map((stage) => ({ perTask: false, stage })),
];

// An optional stage runs only when the policy (an execution's, or the
// factory's FACTORY.json) turns it on.
export function stageEnabled(policy: Pick<Policy, 'stages'>, stage: StageName): boolean {
  return !stages[stage].optional || policy.stages[stage]?.enabled === true;
}

function enabled(policy: Policy, list: ReadonlyArray<StageName>): Array<StageName> {
  return list.filter((stage) => stageEnabled(policy, stage));
}

// The per-task stages that run for `task`: enabled ones the task file does not
// skip (plan records a skip as a `skipped` summary).
function taskStages(policy: Policy, task: TaskRecord | null): Array<StageName> {
  return enabled(policy, flow.task).filter((stage) => task?.summaries[stage]?.label !== 'skipped');
}

// Whether `stage` runs for `task`: enabled, and not skipped by its task file.
export function runsForTask(policy: Policy, task: TaskRecord, stage: StageName): boolean {
  return taskStages(policy, task).includes(stage);
}

// The lowest-ordinal pending task whose dependencies are done.
export function readyTask(snapshot: FactorySnapshot): TaskRecord | null {
  const done = new Set(
    snapshot.tasks.filter((task) => task.status === 'done').map((task) => task.taskId),
  );
  const ready = snapshot.tasks
    .filter((task) => task.status === 'pending' && task.blockedBy.every((id) => done.has(id)))
    .sort((left, right) => left.ordinal - right.ordinal);
  return ready[0] ?? null;
}

// The first per-task stage for the next ready task, else the closing stages.
function afterTasks(snapshot: FactorySnapshot): Step {
  const policy = snapshot.execution.policy;
  const next = readyTask(snapshot);
  const first = taskStages(policy, next)[0];
  if (next !== null && first !== undefined) {
    return { kind: 'stage', stage: first, taskId: next.taskId };
  }
  const open = snapshot.tasks.filter(
    (task) => task.status !== 'done' && task.status !== 'cancelled',
  );
  if (open.length > 0) {
    return { kind: 'waiting', taskIds: open.map((task) => task.taskId) };
  }
  const closing = enabled(policy, flow.closing)[0];
  return closing === undefined
    ? { kind: 'handoff' }
    : { kind: 'stage', stage: closing, taskId: null };
}

// Pure: what runs after `stage` accepted, for `taskId` when it runs per task.
// After a task's last enabled per-task stage, the caller marks the task done
// first, so the next ready task is chosen without it.
export function nextStep(snapshot: FactorySnapshot, stage: StageName, taskId: TaskId | null): Step {
  const policy = snapshot.execution.policy;
  for (const [phase, list] of Object.entries(flow) as Array<
    [keyof typeof flow, ReadonlyArray<StageName>]
  >) {
    const index = list.indexOf(stage);
    if (index === -1) {
      continue;
    }
    const task =
      phase === 'task' ? (snapshot.tasks.find((item) => item.taskId === taskId) ?? null) : null;
    const later = (phase === 'task' ? taskStages(policy, task) : enabled(policy, list)).filter(
      (item) => list.indexOf(item) > index,
    )[0];
    if (later !== undefined) {
      return { kind: 'stage', stage: later, taskId: phase === 'task' ? taskId : null };
    }
    if (phase === 'ticket' || phase === 'task') {
      return afterTasks(snapshot);
    }
    return { kind: 'handoff' };
  }
  throw new Error(`The ${stage} stage is not in the flow.`);
}

// The enabled per-task stage before `stage`, whose output `stage` was given.
export function previousTaskStage(
  policy: Policy,
  stage: StageName,
  task: TaskRecord | null,
): StageName | null {
  const list = taskStages(policy, task);
  const index = list.indexOf(stage);
  return index > 0 ? (list[index - 1] ?? null) : null;
}
