import { defineStage } from '../definition.ts';
import { childInstructions, childToolList } from '../prompt.ts';

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

export const work = defineStage<WorkInput, 'work'>({
  contract,
  emoji: '🛠',
  model: 'work',
  name: 'work',
  prompts: {
    correction: (failures) =>
      [
        childInstructions(skill, contract),
        '',
        'Work validation failed. Fix these exact problems:',
        ...failures.map((failure) => `- ${failure}`),
      ].join('\n'),
    initial: (input) => {
      const commands =
        input.commands.length === 0
          ? 'none'
          : input.commands
              .map((command) => `${command.name}: ${command.argv.join(' ')}`)
              .join('\n');
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
        'Configured checks:',
        commands,
      ].join('\n');
    },
    returned: (round, problems) =>
      [
        childInstructions(skill, contract),
        '',
        `Review round ${round} requested changes. Resolve these blocking findings in the same worktree:`,
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
