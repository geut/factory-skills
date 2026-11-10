import { diffPaths, fileDiffHashes } from '../../diff.ts';
import type { FactorySnapshot, ReviewFinding, ReviewResult, TaskId } from '../../domain.ts';
import {
  defineStage,
  type LimitSpec,
  type Outcome,
  type StageCheck,
  type StageView,
} from '../definition.ts';
import { feedbackRoundOf } from '../feedback.ts';
import { childInstructions } from '../prompt.ts';
import type { Criterion } from '../qa/criteria.ts';
import {
  earlierFindings,
  formatFinding,
  parseReview,
  REVIEW_CONTRACT,
  runReview,
} from './parse.ts';
import { acceptedRules, changedRules, ruleChanges, rulesSource } from './rules.ts';

export type ReviewInput = {
  criteria: Array<Criterion>;
  diff: string;
  displayRef: string;
  // From round 2: the blocking findings of the previous review, to verify.
  earlierFindings: Array<ReviewFinding>;
  // The feedback round this task is, or null for a planned task.
  feedbackRound: number | null;
  planPath: string;
  rawOutput: string;
  round: number;
  // Where the reviewer's project rules came from; the rule files the diff
  // changes, each of which needs a Verification line; and the rule changes
  // earlier tasks' reviews accepted, unchanged since.
  rules: {
    accepted: Array<{ file: string; taskId: string }>;
    changed: Array<string>;
    source: string | null;
  };
  taskFile: string;
  taskTitle: string;
  validationSummary: string;
};

// The review verdict decides what happens to the task. The round limit lives
// here because only review counts its rounds.
// An approval records the reviewed rule files' diff hashes (`rules`), so
// later tasks' reviews take those changes as accepted.
function verdictOutcome(
  { snapshot, task }: StageView,
  result: ReviewResult,
  rules: Record<string, string>,
): Outcome {
  const id = task?.taskId ?? '?';
  const blocking = result.findings.filter((finding) => finding.blocking);
  const summary = {
    counts: { blocking: blocking.length, findings: result.findings.length },
    label: result.verdict,
    round: result.round,
  };
  const limit = snapshot.execution.policy.limits.reviewRounds;
  switch (result.verdict) {
    case 'approve':
      return {
        kind: 'accept',
        summary: Object.keys(rules).length === 0 ? summary : { ...summary, rules },
      };
    case 'changes_requested': {
      const lines = blocking.map((finding) => formatFinding(finding));
      if (result.round >= limit) {
        return {
          code: 'review_round_limit',
          failures: lines,
          kind: 'pause',
          message: `Review round limit reached for task ${id}.`,
          question: [
            `Review round ${result.round} of ${limit} for task ${id} still has blocking findings:`,
            ...lines.map((line) => `- ${line}`),
            'Reply to tell the reviewer how to settle them.',
          ].join('\n'),
          reply: true,
          summary,
        };
      }
      return { kind: 'return_to_work', problems: lines, summary };
    }
    case 'blocked': {
      const lines = result.findings.map((finding) => formatFinding(finding));
      return {
        code: 'review_blocked',
        failures: [result.summary, ...lines],
        kind: 'pause',
        message: `Review blocked task ${id}.`,
        question: [
          `The reviewer blocked task ${id}: ${result.summary}`,
          ...lines.map((line) => `- ${line}`),
          'Reply to resume the reviewer with what it needs.',
        ].join('\n'),
        reply: true,
        summary,
      };
    }
    default: {
      const _exhaustive: never = result.verdict;
      return _exhaustive;
    }
  }
}

// The handed-on checks, grouped under the label of the stage they belong to.
function validationGroups(checks: Array<StageCheck>): string {
  const groups = new Map<string, Array<string>>();
  for (const check of checks) {
    groups.set(check.stage, [
      ...(groups.get(check.stage) ?? []),
      `- ${check.name}: ${check.status}`,
    ]);
  }
  return [...groups].flatMap(([stage, lines]) => [`${stage}:`, ...lines]).join('\n');
}

// The rule files `diff` changes that this task's review judges, and those an
// earlier task's review accepted, unchanged since.
export function reviewedRules(
  snapshot: FactorySnapshot,
  taskId: TaskId | null,
  diff: string,
): { accepted: Array<{ file: string; taskId: TaskId }>; changed: Array<string> } {
  const worktree = snapshot.execution.worktreePath;
  if (worktree === null) {
    return { accepted: [], changed: [] };
  }
  const split = ruleChanges({
    accepted: acceptedRules(snapshot.tasks, taskId),
    changed: changedRules(
      { codeRoot: snapshot.execution.policy.codeRoot, worktree },
      diffPaths(diff),
    ),
    hashes: fileDiffHashes(diff),
  });
  return { accepted: split.accepted, changed: split.judged };
}

// Where the rules came from, and what to do about each rule file the diff
// changes: the worker must not decide the rules its own work is judged by.
function projectRules(rules: ReviewInput['rules']): Array<string> {
  return [
    `Project rules: your system prompt holds them from ${rules.source ?? 'the base commit'}, not from the ticket's branch. Judge the work by them.`,
    ...(rules.accepted.length === 0
      ? []
      : [
          `Earlier tasks changed project rules, and their reviews accepted the change: ${rules.accepted.map((item) => `${item.file} (task ${item.taskId})`).join(', ')}. Judge the work by the base rules as those changes amend them. They need no Verification line.`,
        ]),
    ...(rules.changed.length === 0
      ? []
      : [
          `This diff changes project rules: ${rules.changed.join(', ')}. Decide for each whether the task asks for the change, and give it one Verification line:`,
          '- `<file>: in_scope — <the task criterion that asks for it>`: review the change as part of the task, and judge the work by the base rules as that change amends them.',
          '- `<file>: out_of_scope — <why>`: judge the work by the base rules, and report the change as a Major finding that names the file.',
        ]),
    '',
  ];
}

const skill = 'factory-review';
const contract = REVIEW_CONTRACT;

// The FACTORY.json limits this stage reads.
export const reviewLimits = {
  reviewCorrections: { default: 3, min: 0 },
  reviewRounds: { default: 3, min: 1 },
} as const satisfies Record<string, LimitSpec>;

export const review = defineStage<ReviewInput, 'review'>({
  conclude: (view, run, report) => {
    if (report.status === 'passed') {
      const parsed = runReview(run);
      return parsed.kind === 'invalid'
        ? { failures: parsed.failures, kind: 'correct' }
        : verdictOutcome(view, parsed.result, report.detail.rules);
    }
    switch (report.detail.reason) {
      case 'unsafe':
        return {
          code: 'review_isolation',
          failures: report.failures,
          kind: 'pause',
          message: 'Review isolation failed.',
          question: [
            'The reviewer was not isolated from the worker:',
            ...report.failures.map((failure) => `- ${failure}`),
          ].join('\n'),
          reply: false,
        };
      case 'stale':
        return { kind: 'revalidate_previous' };
      case 'malformed':
        return { failures: report.failures, kind: 'correct' };
      default: {
        const _exhaustive: never = report.detail.reason;
        return _exhaustive;
      }
    }
  },
  contract,
  corrections: {
    // A malformed verdict never spends a review round.
    limit: 'reviewCorrections',
    limitNotice: 'The review result is still malformed after the correction limit:',
    per: 'round',
  },
  emoji: '👀',
  input: ({ snapshot, task }, { handoff, round }) => {
    if (task === null || handoff === null) {
      throw new Error('Review runs for a task with the diff its previous stage left.');
    }
    return {
      criteria: handoff.criteria,
      diff: handoff.diff,
      displayRef: snapshot.ticket.displayRef,
      earlierFindings: earlierFindings(snapshot, task.taskId, round),
      feedbackRound: feedbackRoundOf(task),
      planPath: snapshot.execution.planPath ?? '',
      rawOutput: handoff.output,
      round,
      rules: {
        ...reviewedRules(snapshot, task.taskId, handoff.diff),
        source:
          snapshot.execution.worktreeBaseSha === null
            ? null
            : rulesSource({
                branch: snapshot.execution.worktreeBaseBranch,
                sha: snapshot.execution.worktreeBaseSha,
              }),
      },
      taskFile: `${snapshot.execution.factoryDir}/${task.taskFile}`,
      taskTitle: task.title,
      validationSummary: validationGroups(handoff.checks),
    };
  },
  label: 'Review',
  model: 'review',
  name: 'review',
  parse: (output, round) => {
    const parsed = parseReview(output, round);
    return parsed.kind === 'valid'
      ? { json: JSON.stringify({ output, review: parsed.result }), kind: 'valid' }
      : { error: parsed.failures.join('\n'), json: JSON.stringify({ output }), kind: 'invalid' };
  },
  preparesInput: false,
  // The reviewer judges the work by the base commit's rules, not by rules the
  // ticket's branch may have changed.
  projectRules: 'base',
  // Later rounds resume the same reviewer so it can check its earlier findings.
  prompts: {
    correction: (failures) =>
      [
        childInstructions(skill, contract),
        '',
        `The controller could not accept your review. Fix these exact problems and return the complete ${contract} template again:`,
        ...failures.map((failure) => `- ${failure}`),
      ].join('\n'),
    initial: (input) =>
      [
        childInstructions(skill, contract),
        '',
        `Ticket: ${input.displayRef}`,
        `Task: ${input.taskTitle}`,
        `Task file: ${input.taskFile}`,
        `Plan: ${input.planPath}`,
        `Review round: ${input.round}`,
        input.round > 1
          ? 'Verify each earlier blocking finding below and report it in Verification. Keep the same finding number for a problem that remains.'
          : 'This is the first review of this task.',
        'Read only. Do not edit files.',
        ...(input.feedbackRound === null
          ? []
          : [
              `This task is feedback round ${input.feedbackRound} on the ticket's pull request. Each acceptance criterion is a reviewer's feedback item, F1..Fn, and the diff is only this round's change. The worker's reply answers each item under ## Feedback responses: verify an addressed item in the diff, and judge whether a declined item's reason holds. An item declined without a sound reason is a Major finding.`,
            ]),
        '',
        ...projectRules(input.rules),
        'Acceptance criteria (one Verification line each):',
        ...(input.criteria.length === 0
          ? ['none']
          : input.criteria.map((criterion) => `- ${criterion.id}: ${criterion.text}`)),
        '',
        ...(input.round > 1
          ? [
              'Earlier blocking findings (one Verification line each):',
              ...(input.earlierFindings.length === 0
                ? ['none']
                : input.earlierFindings.map((finding) => `- ${formatFinding(finding)}`)),
              '',
            ]
          : []),
        'Validation:',
        input.validationSummary,
        '',
        'Worker summary:',
        input.rawOutput.length > 0 ? input.rawOutput : 'none',
        '',
        'Diff:',
        input.diff.length > 0 ? input.diff : 'none',
      ].join('\n'),
  },
  rounds: true,
  scope: 'task',
  skill,
  thinking: 'high',
  tools: ['read', 'grep', 'find', 'ls'],
});
