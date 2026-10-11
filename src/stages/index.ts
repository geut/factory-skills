import type { StageName } from '../domain.ts';
import { plan, planLimits } from './plan/definition.ts';
import { childToolList } from './prompt.ts';
import { review, reviewLimits } from './review/definition.ts';
import { work, workLimits, type WorkPrepared } from './work/definition.ts';
import { wrapup, type WrapupPrepared } from './wrapup/definition.ts';

// The pure half of every stage. The reducer reads stages only through this.
export const stages = { plan, review, work, wrapup } satisfies {
  [S in StageName]: { name: S };
};

// Every stage's FACTORY.json limits, by key.
export const stageLimits = { ...planLimits, ...reviewLimits, ...workLimits };

// The input each stage with input preparation hands the reducer.
export type PreparedInput = { work: WorkPrepared; wrapup: WrapupPrepared };
export type InputStage = keyof PreparedInput;

export function isInputStage(stage: StageName): stage is InputStage {
  return stages[stage].preparesInput;
}

export function stageTools(stage: StageName): string {
  return childToolList(stages[stage].tools);
}
