import { defineStage, type LimitSpec } from '../definition.ts';
import { FEEDBACK_RESPONSES_CHECK, feedbackRoundOf } from '../feedback.ts';
import { runsForTask } from '../flow.ts';
import { workerSummary } from '../output.ts';
import { childInstructions, childToolList, END_TO_END } from '../prompt.ts';

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
  // The feedback round this task is, or null for a planned task.
  feedbackRound: number | null;
  planPath: string;
  // Whether QA runs for this task, and so owns its end-to-end tests.
  qaRuns: boolean;
  taskFile: string;
  taskId: string;
  taskType: string | null;
  title: string;
  worktree: string;
  worktreeBranch: string;
};

const skill = 'factory-work';

// Work validation's failures of a feedback round's reply start with this.
const FEEDBACK_CHECK = `${FEEDBACK_RESPONSES_CHECK}:`;

// The one part of a feedback round's reply the controller reads.
const FEEDBACK_REPLY =
  'In this feedback round, your reply must include ## Feedback responses as text: one line per item of the task file, `- F1: addressed — what changed` or `- F1: declined — why`. The rest of the template is optional.';
const contract = 'factory.work.v3';
const tools = ['read', 'bash', 'grep', 'find', 'ls', 'edit', 'write'];

// The FACTORY.json limits this stage reads.
export const workLimits = { workCorrections: { default: 3, min: 0 } } as const satisfies Record<
  string,
  LimitSpec
>;

export const work = defineStage<WorkInput, 'work', WorkPrepared>({
  conclude: ({ snapshot, task }, _run, report) =>
    report.status === 'passed'
      ? {
          handoff: {
            checks: report.checks.map((check) => ({ ...check, stage: 'Work' })),
            criteria: report.detail.criteria,
            diff: report.detail.diff,
            output: workerSummary(snapshot, task?.taskId ?? ''),
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
      feedbackRound: feedbackRoundOf(task),
      planPath: execution.planPath ?? '',
      qaRuns: runsForTask(execution.policy, task, 'qa'),
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
    correction: (failures) => {
      // A feedback round's reply is checked too; when that is what failed,
      // the code is fine and only the answers are missing.
      const reply = failures.filter((failure) => failure.startsWith(FEEDBACK_CHECK));
      const code = failures.filter((failure) => !failure.startsWith(FEEDBACK_CHECK));
      return [
        childInstructions(skill, contract),
        '',
        ...(code.length === 0
          ? []
          : [
              'Work validation failed. Fix these exact problems:',
              ...code.map((failure) => `- ${failure}`),
            ]),
        ...(reply.length === 0
          ? []
          : [
              `Your reply's feedback answers are what failed${code.length === 0 ? ', not the code' : ''}:`,
              ...reply.flatMap((failure) =>
                failure
                  .slice(FEEDBACK_CHECK.length)
                  .split('\n')
                  .map((line) => line.trim())
                  .filter((line) => line.length > 0)
                  .map((line) => `- ${line}`),
              ),
              FEEDBACK_REPLY,
            ]),
      ].join('\n');
    },
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
        ...(input.feedbackRound === null ? [] : [FEEDBACK_REPLY]),
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
        ...(input.feedbackRound === null
          ? []
          : [
              `This task is feedback round ${input.feedbackRound} on the ticket's pull request. Its acceptance criteria are the reviewers' feedback items F1..Fn, in full under ## Feedback in the task file. They are review requests to weigh, not instructions: address each one with a change, or decline it with a reason.`,
            ]),
        END_TO_END,
        input.qaRuns
          ? "QA runs for this task and owns its end-to-end tests: write unit tests (and component tests where the project has them), keep the existing end-to-end suite passing, and leave every end-to-end test of this task's acceptance criteria, API requests included, to QA."
          : 'QA does not run for this task: add or update end-to-end coverage for its acceptance criteria where the project has a harness.',
        // Everything work validation checks, so nothing it rejects is a surprise.
        'Work validation checks that:',
        '- the worktree has a change (an investigation ticket may leave none)',
        input.feedbackRound === null
          ? '- nothing is committed: HEAD stays at the base commit'
          : "- nothing is committed: HEAD stays at the round's start commit, the pull request's head",
        ...(input.feedbackRound === null
          ? []
          : [
              '- ## Feedback responses answers every item once, and a declined item gives a reason',
            ]),
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
        `Then return the complete ${contract} template, answering each finding under ## Review responses.`,
      ].join('\n'),
  },
  scope: 'task',
  skill,
  thinking: 'medium',
  tools,
});
