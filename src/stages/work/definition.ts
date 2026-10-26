import { defineStage, type LimitSpec } from '../definition.ts';
import { runOutput } from '../output.ts';
import { childInstructions, childToolList } from '../prompt.ts';

// What work's input preparation found in the factory files.
export type WorkPrepared = {
  adrPath: string | null;
  contextPath: string | null;
  taskType: string | null;
};

export type WorkInput = {
  adrPath: string | null;
  commands: Array<{ argv: Array<string>; name: string }>;
  contextPath: string | null;
  dependencies: Array<{ status: string; taskId: string }>;
  displayRef: string;
  planPath: string;
  taskFile: string;
  taskId: string;
  taskType: string | null;
  title: string;
  worktree: string;
  worktreeBranch: string;
};

const skill = 'factory-work';
const contract = 'factory.work.v3';
const tools = ['read', 'bash', 'grep', 'find', 'ls', 'edit', 'write'];

// The FACTORY.json limits this stage reads.
export const workLimits = { workCorrections: { default: 3, min: 0 } } as const satisfies Record<
  string,
  LimitSpec
>;

export const work = defineStage<WorkInput, 'work', WorkPrepared>({
  conclude: (_view, run, report) =>
    report.status === 'passed'
      ? {
          handoff: {
            checks: report.checks,
            criteria: report.detail.criteria,
            diff: report.detail.diff,
            output: runOutput(run),
          },
          kind: 'accept',
        }
      : { failures: report.failures, kind: 'correct' },
  contract,
  corrections: {
    limit: 'workCorrections',
    limitNotice: 'Work validation is still failing after the correction limit:',
    per: 'session',
  },
  emoji: '🛠',
  input: ({ snapshot, task }, { prepared }) => {
    const execution = snapshot.execution;
    if (task === null || execution.worktreePath === null) {
      throw new Error('Work runs for a task in a ready worktree.');
    }
    return {
      adrPath: prepared.adrPath,
      commands: execution.policy.validation.work.commands,
      contextPath: prepared.contextPath,
      dependencies: task.blockedBy.map((id) => ({
        status: snapshot.tasks.find((item) => item.taskId === id)?.status ?? 'missing',
        taskId: id,
      })),
      displayRef: snapshot.ticket.displayRef,
      planPath: execution.planPath ?? '',
      taskFile: `${execution.factoryDir}/${task.taskFile}`,
      taskId: task.taskId,
      taskType: prepared.taskType,
      title: task.title,
      worktree: execution.worktreePath,
      worktreeBranch: execution.worktreeBranch ?? '',
    };
  },
  label: 'Work',
  model: 'work',
  name: 'work',
  preparesInput: true,
  prompts: {
    correction: (failures) =>
      [
        childInstructions(skill, contract),
        '',
        'Work validation failed. Fix these exact problems:',
        ...failures.map((failure) => `- ${failure}`),
      ].join('\n'),
    initial: (input) => {
      const commands = input.commands.map(
        (command) => `- ${command.name} passes: ${command.argv.join(' ')}`,
      );
      const dependencies =
        input.dependencies.length === 0
          ? 'none'
          : input.dependencies.map((dep) => `${dep.taskId} (${dep.status})`).join(', ');
      return [
        childInstructions(skill, contract),
        '',
        `Ticket: ${input.displayRef}`,
        `Task: ${input.taskId} ${input.title}`,
        `Type: ${input.taskType ?? 'unspecified'}`,
        `Task file: ${input.taskFile}`,
        `Plan: ${input.planPath}`,
        `ADR: ${input.adrPath ?? 'none'}`,
        `Context: ${input.contextPath ?? 'none'}`,
        `Dependencies: ${dependencies}`,
        `Branch: ${input.worktreeBranch}`,
        `Tools: ${childToolList(tools)}`,
        `Work only in ${input.worktree}.`,
        'Leave the work uncommitted.',
        // Everything work validation checks, so nothing it rejects is a surprise.
        'Work validation checks that:',
        '- the worktree has a change (an investigation ticket may leave none)',
        '- nothing is committed: HEAD stays at the base commit',
        ...commands,
      ].join('\n');
    },
    returned: (origin, round, problems) =>
      [
        childInstructions(skill, contract),
        '',
        `${origin} round ${round} requested changes. Resolve these blocking findings in the same worktree:`,
        ...problems.map((problem) => `- ${problem}`),
        '',
        'Change only what these findings require. Leave the work uncommitted.',
      ].join('\n'),
  },
  scope: 'task',
  skill,
  thinking: 'medium',
  tools,
});
