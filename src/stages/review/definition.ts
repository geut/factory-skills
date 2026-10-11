import { defineStage } from '../definition.ts';
import { childInstructions } from '../prompt.ts';
import { parseReview } from './parse.ts';

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

const skill = 'factory-review';
const contract = 'factory.review.v4';

export const review = defineStage<ReviewInput, 'review'>({
  contract,
  corrections: {
    // A malformed verdict never spends a review round.
    limit: 'reviewCorrections',
    limitNotice: 'The review result is still malformed after the correction limit:',
    per: 'round',
  },
  emoji: '👀',
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
  scope: 'task',
  skill,
  thinking: 'high',
  tools: ['read', 'grep', 'find', 'ls'],
});
