import type { ReviewResult } from '../../domain.ts';
import { defineStage, type Outcome, type StageView } from '../definition.ts';
import { runOutput } from '../output.ts';
import { childInstructions } from '../prompt.ts';
import { formatFinding, parseReview } from './parse.ts';

export type ReviewInput = {
  diff: string;
  displayRef: string;
  planPath: string;
  rawOutput: string;
  round: number;
  taskFile: string;
  taskTitle: string;
  validationSummary: string;
};

// The review verdict decides what happens to the task. The round limit lives
// here because only review counts its rounds.
function verdictOutcome({ snapshot, task }: StageView, result: ReviewResult): Outcome {
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
      return { kind: 'accept', summary };
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

const skill = 'factory-review';
const contract = 'factory.review.v4';

export const review = defineStage<ReviewInput, 'review'>({
  conclude: (view, run, report) => {
    if (report.status === 'passed') {
      const parsed = parseReview(runOutput(run), run.semanticRound);
      return parsed.kind === 'invalid'
        ? { failures: parsed.failures, kind: 'correct' }
        : verdictOutcome(view, parsed.result);
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
      diff: handoff.diff,
      displayRef: snapshot.ticket.displayRef,
      planPath: snapshot.execution.planPath ?? '',
      rawOutput: handoff.output,
      round,
      taskFile: `${snapshot.execution.factoryDir}/${task.taskFile}`,
      taskTitle: task.title,
      validationSummary: handoff.checks.map((check) => `${check.name}: ${check.status}`).join('\n'),
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
  // Later rounds resume the same reviewer so it can check its earlier findings.
  prompts: {
    correction: (failures) =>
      [
        childInstructions(skill, contract),
        '',
        `The controller could not read your verdict. Fix these exact problems and return the complete ${contract} template again:`,
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
          ? 'The worker addressed your earlier blocking findings. Verify those fixes first and keep the same finding numbers for problems that remain.'
          : 'This is the first review of this task.',
        'Read only. Do not edit files.',
        '',
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
