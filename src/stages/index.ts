import type { StageName } from '../domain.ts';
import type { StageDefinition } from './definition.ts';
import { plan } from './plan/definition.ts';
import { childToolList } from './prompt.ts';
import { review } from './review/definition.ts';
import { work } from './work/definition.ts';
import { wrapup } from './wrapup/definition.ts';

// The pure half of every stage. The reducer reads stages only through this.
export const stages = { plan, review, work, wrapup } satisfies {
  [S in StageName]: StageDefinition<never, S>;
};

export function stageTools(stage: StageName): string {
  return childToolList(stages[stage].tools);
}
