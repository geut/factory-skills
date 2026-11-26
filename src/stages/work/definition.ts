import { SELECTION_ENV } from '../../validation/selection.ts';
import { defineStage, type LimitSpec } from '../definition.ts';
import { feedbackRoundOf } from '../feedback.ts';
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

// What a feedback round's report carries: the worker's answer to each item,
// which review reads and the pull request's threads show. subagent_done
// refuses a report that misses one; review judges every item either way.
const FEEDBACK_REPLY =
  "In this feedback round, the report's feedback_responses answer each item of the task file once: addressed, with what changed, or declined, with why. Review reads them, and a declined item needs a reason it can judge.";

// How a work run ends: its report is subagent_done's arguments, the one
// channel the controller reads. A reply written as text, or only thought
// through, never reaches it.
const REPORT =
  'When the work is done, call subagent_done with your report as its arguments: the controller reads only them, not your text. If it refuses the report, fix the fields it names and call it again.';

const contract = 'factory.work.v3';
// `run_validation` asks the controller to run the validation commands now;
// the child handshake provides it.
const tools = ['read', 'bash', 'grep', 'find', 'ls', 'edit', 'write', 'run_validation'];

// The FACTORY.json limits this stage reads.
// `missingReportCorrections` bounds the corrections in a row for runs that
// ended without a report; they spend none of `workCorrections`.
export const workLimits = {
  missingReportCorrections: { default: 2, min: 0 },
  workCorrections: { default: 3, min: 0 },
} as const satisfies Record<string, LimitSpec>;

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
  // Replaces "return only the template" in every work prompt, an answer's too.
  handoff: REPORT,
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
    correction: (failures) =>
      [
        childInstructions(skill, contract, REPORT),
        '',
        'Work validation failed. Fix these exact problems:',
        ...failures.map((failure) => `- ${failure}`),
        '',
        'Then call subagent_done with your report again.',
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
        childInstructions(skill, contract, REPORT),
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
        `The report's validation_selection goes to the validation commands below as ${SELECTION_ENV} JSON, and the project's validator decides how to run it: \`focused\` with the regression tests you found from your own diff, each a test file relative to the repository root with why it covers the change; or \`default\` with why, which leaves ${SELECTION_ENV} unset so the validator uses its default behavior. Every report states it again. The report's tests stay your account of what you ran.`,
        'To check your work before you report, call run_validation with the validation_selection your report will have: the controller runs the validation commands below on the worktree as it stands and tells you the results. Run them that way rather than yourself when you can: if they pass and you change nothing more, your report reuses that pass instead of waiting for them again. Your own runs of them never count.',
        // Everything work validation checks, so nothing it rejects is a surprise.
        'Work validation checks that:',
        // A round may decline every item and change nothing.
        ...(input.feedbackRound === null
          ? ['- the worktree has a change (an investigation ticket may leave none)']
          : []),
        '- every test in validation_selection is a file in the worktree, given relative to the repository root',
        input.feedbackRound === null
          ? '- nothing is committed: HEAD stays at the base commit'
          : "- nothing is committed: HEAD stays at the round's start commit, the pull request's head",
        ...commands,
      ].join('\n');
    },
    returned: (origin, round, problems) =>
      [
        childInstructions(skill, contract, REPORT),
        '',
        `${origin} round ${round} requested changes. Resolve these blocking findings in the same worktree:`,
        ...problems.map((problem) => `- ${problem}`),
        '',
        'Change only what these findings require. Leave the work uncommitted.',
        'Then call subagent_done with your report, answering each finding in review_responses.',
      ].join('\n'),
  },
  scope: 'task',
  skill,
  thinking: 'medium',
  tools,
});
