import { factoryRootOf } from '../../controller/keys.ts';
import type { FactorySnapshot } from '../../domain.ts';
import type { Checkbox } from '../../ports/checklist.ts';
import { defineStage } from '../definition.ts';
import { childInstructions, childToolList } from '../prompt.ts';
import { formatFinding, latestReviews } from '../review/parse.ts';
import { openBoxes } from './checklist.ts';
import { handoffSections, WRAPUP_HEADINGS } from './handoff.ts';

// What wrap-up's input preparation captured before the agent runs.
export type WrapupPrepared = {
  adrPath: string | null;
  // The worktree, refs, and factory files before wrap-up ran (WrapupBaseline JSON).
  baseline: string;
  contextPath: string | null;
  // QA's screenshots from each task's latest passed QA validation.
  screenshots: Array<{ name: string; path: string; taskId: string }>;
  // Each task's QA test plan rows, such as `Task 01 AC1: e2e/filter.e2e.ts › survives a reload`.
  testPlan: Array<string>;
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
  // The issue's open boxes, B1..Bn.
  issueBoxes: Array<Checkbox>;
  minorFindings: Array<string>;
  model: string;
  planPath: string;
  pullRequests: boolean;
  // Each task's Verification lines from its latest valid review.
  reviewVerification: Array<string>;
  screenshots: WrapupPrepared['screenshots'];
  tasks: Array<{
    status: string;
    taskFile: string;
    taskId: string;
    title: string;
    verdict: string;
  }>;
  testPlan: Array<string>;
  usage: string;
  verification: Array<string>;
  worktree: string;
  worktreeBranch: string;
};

// Every task's non-blocking review findings and Verification lines, from its
// latest valid review.
function reviewNotes(snapshot: FactorySnapshot): {
  findings: Array<string>;
  verification: Array<string>;
} {
  const findings: Array<string> = [];
  const verification: Array<string> = [];
  for (const { result, taskId } of latestReviews(snapshot)) {
    // Finding ids restart in every task's review, so name the task.
    const label = `Task ${taskId}`;
    findings.push(
      ...result.findings
        .filter((item) => !item.blocking)
        .map((item) => `${label} ${formatFinding(item)}`),
    );
    verification.push(
      ...result.verification.map(
        (line) => `${label} ${line.id}: ${line.status} — ${line.evidence}`,
      ),
    );
  }
  return { findings, verification };
}

const skill = 'factory-wrapup';
const contract = 'factory.wrapup.v2';
const tools = ['read', 'bash', 'grep', 'find', 'ls'];

export const wrapup = defineStage<WrapupInput, 'wrapup', WrapupPrepared>({
  conclude: (_view, _run, report) =>
    report.status === 'passed'
      ? {
          checklist: report.detail.checklist,
          kind: 'accept',
          notice: report.detail.usage,
          ...(report.detail.pullRequest === null
            ? {}
            : { pullRequestUrl: report.detail.pullRequest.url }),
        }
      : { failures: report.failures, kind: 'correct' },
  contract,
  corrections: {
    limit: null,
    limitNotice: 'Wrap-up validation is still failing:',
    per: 'session',
  },
  emoji: '📦',
  input: ({ snapshot }, { prepared }) => {
    const execution = snapshot.execution;
    if (execution.worktreePath === null) {
      throw new Error('Wrap-up runs in a ready worktree.');
    }
    const notes = reviewNotes(snapshot);
    return {
      adrPath: prepared.adrPath,
      baseBranch: execution.worktreeBaseBranch,
      codeRoot: execution.policy.codeRoot,
      contextPath: prepared.contextPath,
      displayRef: snapshot.ticket.displayRef,
      factoryRoot: factoryRootOf(execution.factoryDir),
      issueBoxes: openBoxes(snapshot.ticket),
      minorFindings: notes.findings,
      // Wrap-up runs on the work model.
      model: execution.policy.models.work,
      planPath: execution.planPath ?? '',
      pullRequests: execution.policy.pullRequests,
      reviewVerification: notes.verification,
      screenshots: prepared.screenshots,
      tasks: snapshot.tasks.map((task) => ({
        status: task.status,
        taskFile: `${execution.factoryDir}/${task.taskFile}`,
        taskId: task.taskId,
        title: task.title,
        verdict: task.summaries.review?.label ?? 'none',
      })),
      testPlan: prepared.testPlan,
      usage: prepared.usage,
      verification: prepared.verification,
      worktree: execution.worktreePath,
      worktreeBranch: execution.worktreeBranch ?? '',
    };
  },
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
  // The validator compares the worktree, refs, and factory files against it.
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
        `codeHost.pullRequests: ${input.pullRequests ? 'true' : 'false'}`,
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
        ...(input.screenshots.length === 0
          ? []
          : [
              'QA screenshots (add a ## Screenshots section to the PR summary with each one):',
              ...input.screenshots.map(
                (shot) => `- Task ${shot.taskId} ${shot.name}: ${shot.path}`,
              ),
              '',
            ]),
        'Review verification:',
        ...(input.reviewVerification.length === 0
          ? ['none']
          : input.reviewVerification.map((line) => `- ${line}`)),
        '',
        'QA test plan:',
        ...(input.testPlan.length === 0 ? ['none'] : input.testPlan.map((row) => `- ${row}`)),
        '',
        'Non-blocking review findings:',
        ...(input.minorFindings.length === 0
          ? ['none']
          : input.minorFindings.map((finding) => `- ${finding}`)),
        '',
        ...(input.issueBoxes.length === 0
          ? ['Issue checkboxes: none; write `none` under ## Issue checklist.']
          : [
              'Issue checkboxes (one ## Issue checklist line each):',
              ...input.issueBoxes.map((box) => `- ${box.id}: ${box.text}`),
              '',
              'Mark a box met only with evidence: a task criterion review verified or QA tested that proves it, as `Task 01 AC2`, or a file. Leave it not_met, with the reason, when an open review finding names a criterion it rests on. The controller ticks the met boxes on the issue and comments the open ones with ## Decisions.',
            ]),
        '',
        'Usage so far (the controller adds wrap-up after you finish; do not estimate it):',
        input.usage,
        '',
        'The controller checks the handoff against the worktree: ## Files must list every changed path and nothing else, ## Tests must name the validation commands above, and you must not change product code or merge.',
        input.pullRequests
          ? 'codeHost.pullRequests is on: commit exactly the ## Files paths on the ticket branch, push it, and open or update the pull request. Its head must be your local HEAD.'
          : 'codeHost.pullRequests is off: do not commit or push; print the commands.',
      ].join('\n'),
  },
  runBaseline: (prepared) => prepared.baseline,
  scope: 'ticket',
  skill,
  thinking: 'medium',
  tools,
});
