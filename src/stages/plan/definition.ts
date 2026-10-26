import { factoryRootOf } from '../../controller/keys.ts';
import { defineStage, type LimitSpec } from '../definition.ts';
import { childInstructions } from '../prompt.ts';
import { contextInstruction, type ContextGaps } from './context.ts';

// `context`: what the factory root's CONTEXT.md still lacks.
export type PlanInput = {
  body: string;
  context: ContextGaps;
  displayRef: string;
  factoryDir: string;
  title: string;
};

const skill = 'factory-plan';
const contract = 'factory.plan.v3';
// The plan is the files the planner writes; its reply is only a summary.
const handoff = `Write plan.md and the task files. The ${contract} template in the skill is a suggested summary, not a requirement. Then call subagent_done once.`;

// The FACTORY.json limits this stage reads.
export const planLimits = { planCorrections: { default: 3, min: 0 } } as const satisfies Record<
  string,
  LimitSpec
>;

export const plan = defineStage<PlanInput, 'plan'>({
  conclude: (_view, _run, report) =>
    report.status === 'passed'
      ? { kind: 'accept', plan: { path: report.detail.planPath, tasks: report.detail.tasks } }
      : { failures: report.failures, kind: 'correct' },
  contract,
  corrections: {
    limit: 'planCorrections',
    limitNotice: 'Plan validation is still failing after the correction limit:',
    per: 'session',
  },
  emoji: '🔎',
  handoff,
  label: 'Plan',
  model: 'plan',
  name: 'plan',
  // The plan is the files it wrote, not its response.
  parse: () => ({ json: JSON.stringify({ contract, source: 'files' }), kind: 'valid' }),
  preparesInput: false,
  prompts: {
    correction: (failures) =>
      [
        childInstructions(skill, contract, handoff),
        '',
        'Plan validation failed. plan.md, at least one task file and CONTEXT.md with its required sections must exist. Fix these exact problems:',
        ...failures.map((failure) => `- ${failure}`),
      ].join('\n'),
    initial: (input) =>
      [
        childInstructions(skill, contract, handoff),
        '',
        `Ticket: ${input.displayRef}`,
        `Title: ${input.title}`,
        `Factory root: ${factoryRootOf(input.factoryDir)}`,
        `Write plan.md and numbered task files in ${input.factoryDir}.`,
        ...[contextInstruction(input.context, factoryRootOf(input.factoryDir))].filter(
          (line) => line !== null,
        ),
        '',
        input.body,
      ].join('\n'),
  },
  scope: 'ticket',
  skill,
  thinking: 'medium',
  tools: ['read', 'bash', 'grep', 'find', 'ls'],
});
