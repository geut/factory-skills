import { defineStage } from '../definition.ts';
import { childInstructions } from '../prompt.ts';

export type PlanInput = { body: string; displayRef: string; factoryDir: string; title: string };

const skill = 'factory-plan';
const contract = 'factory.plan.v3';

export const plan = defineStage<PlanInput, 'plan'>({
  contract,
  corrections: {
    limit: 'planCorrections',
    limitNotice: 'Plan validation is still failing after the correction limit:',
    per: 'session',
  },
  emoji: '🔎',
  label: 'Plan',
  model: 'plan',
  name: 'plan',
  // The plan is the files it wrote, not its response.
  parse: () => ({ json: JSON.stringify({ contract, source: 'files' }), kind: 'valid' }),
  preparesInput: false,
  prompts: {
    correction: (failures) =>
      [
        childInstructions(skill, contract),
        '',
        'Plan validation failed. plan.md must exist and at least one task file must be defined. Fix these exact problems, then return the factory.plan.v3 template again:',
        ...failures.map((failure) => `- ${failure}`),
      ].join('\n'),
    initial: (input) =>
      [
        childInstructions(skill, contract),
        '',
        `Ticket: ${input.displayRef}`,
        `Title: ${input.title}`,
        `Write plan.md and numbered task files in ${input.factoryDir}.`,
        '',
        input.body,
      ].join('\n'),
  },
  scope: 'ticket',
  skill,
  thinking: 'medium',
  tools: ['read', 'bash', 'grep', 'find', 'ls'],
});
