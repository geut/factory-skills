import { factoryRootOf } from '../../controller/keys.ts';
import type { FactorySnapshot } from '../../domain.ts';
import { defineStage } from '../definition.ts';
import { runOutput } from '../output.ts';
import { childInstructions, childToolList } from '../prompt.ts';
import { formatFinding, parseReview } from '../review/parse.ts';
import { handoffSections, WRAPUP_HEADINGS } from './handoff.ts';

// What wrap-up's input preparation captured before the agent runs.
export type WrapupPrepared = {
  adrPath: string | null;
  // The worktree, refs, and factory files before wrap-up ran (WrapupBaseline JSON).
  baseline: string;
  contextPath: string | null;
  // QA's screenshots from each task's latest passed QA validation.
  screenshots: Array<{ name: string; path: string; taskId: string }>;
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
  screenshots: WrapupPrepared['screenshots'];
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

// Every task's non-blocking review findings, from its latest valid review.
function minorFindings(snapshot: FactorySnapshot): Array<string> {
  const findings: Array<string> = [];
  for (const session of snapshot.sessions) {
    if (session.stage !== 'review') {
      continue;
    }
    const latest = snapshot.runs
      .filter((run) => run.sessionId === session.id && run.resultStatus === 'valid')
      .sort((left, right) => right.sequence - left.sequence)[0];
    if (latest === undefined) {
      continue;
    }
    const parsed = parseReview(runOutput(latest), latest.semanticRound);
    // Finding ids restart in every task's review, so name the task.
    if (parsed.kind === 'valid') {
      findings.push(
        ...parsed.result.findings
          .filter((item) => !item.blocking)
          .map((item) => `Task ${session.taskId ?? '?'} ${formatFinding(item)}`),
      );
    }
  }
  return findings;
}

const skill = 'factory-wrapup';
const contract = 'factory.wrapup.v1';
const tools = ['read', 'bash', 'grep', 'find', 'ls'];

export const wrapup = defineStage<WrapupInput, 'wrapup', WrapupPrepared>({
  conclude: (_view, _run, report) =>
    report.status === 'passed'
      ? {
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
    return {
      adrPath: prepared.adrPath,
      baseBranch: execution.worktreeBaseBranch,
      codeRoot: execution.policy.codeRoot,
      contextPath: prepared.contextPath,
      displayRef: snapshot.ticket.displayRef,
      factoryRoot: factoryRootOf(execution.factoryDir),
      minorFindings: minorFindings(snapshot),
      // Wrap-up runs on the work model.
      model: execution.policy.models.work,
      planPath: execution.planPath ?? '',
      pullRequests: execution.policy.pullRequests,
      screenshots: prepared.screenshots,
      tasks: snapshot.tasks.map((task) => ({
        status: task.status,
        taskFile: `${execution.factoryDir}/${task.taskFile}`,
        taskId: task.taskId,
        title: task.title,
        verdict: task.summaries.review?.label ?? 'none',
      })),
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
        'Non-blocking review findings:',
        ...(input.minorFindings.length === 0
          ? ['none']
          : input.minorFindings.map((finding) => `- ${finding}`)),
        '',
        'Usage so far (the controller adds wrap-up after you finish; do not estimate it):',
        input.usage,
        '',
        'The controller checks the handoff against the worktree: ## Files must list every changed path and nothing else, ## Tests must name the validation commands above, and you must not change product code, commit, merge, or push unless codeHost.pullRequests allows it.',
      ].join('\n'),
  },
  runBaseline: (prepared) => prepared.baseline,
  scope: 'ticket',
  skill,
  thinking: 'medium',
  tools,
});
