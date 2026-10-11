import { defineStage } from '../definition.ts';
import { childInstructions, childToolList } from '../prompt.ts';
import { handoffSections, WRAPUP_HEADINGS } from './handoff.ts';

// What wrap-up's input preparation captured before the agent runs.
export type WrapupPrepared = {
  adrPath: string | null;
  // The worktree, refs, and factory files before wrap-up ran (WrapupBaseline JSON).
  baseline: string;
  contextPath: string | null;
  // The all-stage usage table so far, excluding wrap-up.
  usage: string;
  // One line per passing work-validation check, per task.
  verification: Array<string>;
};

export type WrapupInput = {
  adrPath: string | null;
  baseBranch: string | null;
  codeRoot: string;
  contextPath: string | null;
  displayRef: string;
  factoryRoot: string;
  minorFindings: Array<string>;
  model: string;
  planPath: string;
  pullRequests: boolean;
  tasks: Array<{
    status: string;
    taskFile: string;
    taskId: string;
    title: string;
    verdict: string;
  }>;
  usage: string;
  verification: Array<string>;
  worktree: string;
  worktreeBranch: string;
};

const skill = 'factory-wrapup';
const contract = 'factory.wrapup.v1';
const tools = ['read', 'bash', 'grep', 'find', 'ls'];

export const wrapup = defineStage<WrapupInput, 'wrapup'>({
  contract,
  emoji: '📦',
  label: 'Wrap-up',
  // Wrap-up runs on the work model; it has no model setting of its own.
  model: 'work',
  name: 'wrapup',
  // The raw response is the handoff text. Its headings make it complete.
  parse: (output) => {
    const sections = handoffSections(output);
    const missing = WRAPUP_HEADINGS.filter((name) => !sections.has(name.toLowerCase()));
    const json = JSON.stringify({ output });
    return missing.length === 0
      ? { json, kind: 'valid' }
      : {
          error: missing.map((name) => `## ${name} is missing.`).join('\n'),
          json,
          kind: 'invalid',
        };
  },
  preparesInput: true,
  prompts: {
    correction: (failures) =>
      [
        childInstructions(skill, contract),
        '',
        `Wrap-up validation failed. Fix these exact problems and return the complete ${contract} template again:`,
        ...failures.map((failure) => `- ${failure}`),
      ].join('\n'),
    initial: (input) =>
      [
        childInstructions(skill, contract),
        '',
        `Ticket: ${input.displayRef}`,
        `Plan: ${input.planPath}`,
        `ADR: ${input.adrPath ?? 'none'}`,
        `Factory root: ${input.factoryRoot}`,
        `Factory context: ${input.contextPath ?? 'none'}`,
        `Code root: ${input.codeRoot}`,
        `Worktree: ${input.worktree}`,
        `Branch: ${input.worktreeBranch}`,
        `Base branch: ${input.baseBranch ?? 'unknown'}`,
        `Model: ${input.model}. Tools: ${childToolList(tools)}.`,
        `github.pullRequests: ${input.pullRequests ? 'true' : 'false'}`,
        '',
        'Tasks:',
        ...input.tasks.map(
          (task) =>
            `- ${task.taskId} ${task.title}: ${task.status}, review ${task.verdict} (${task.taskFile})`,
        ),
        '',
        'Final work validation:',
        ...(input.verification.length === 0
          ? ['- none recorded']
          : input.verification.map((line) => `- ${line}`)),
        '',
        'Non-blocking review findings:',
        ...(input.minorFindings.length === 0
          ? ['none']
          : input.minorFindings.map((finding) => `- ${finding}`)),
        '',
        'Usage so far (the controller adds wrap-up after you finish; do not estimate it):',
        input.usage,
        '',
        'The controller checks the handoff against the worktree: ## Files must list every changed path and nothing else, ## Tests must name the validation commands above, and you must not change product code, commit, merge, or push unless github.pullRequests allows it.',
      ].join('\n'),
  },
  scope: 'ticket',
  skill,
  thinking: 'medium',
  tools,
});
