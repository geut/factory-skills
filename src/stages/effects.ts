import type { ActionRecord, FactorySnapshot, StageName } from '../domain.ts';
import { planValidator } from '../validation/plan.ts';
import type { Validator } from '../validation/report.ts';
import { reviewValidator } from '../validation/review.ts';
import { workValidator } from '../validation/work.ts';
import { wrapupValidator } from '../validation/wrapup.ts';
import type { InputStage, PreparedInput } from './index.ts';
import { prepareWorkInput } from './work/effects.ts';
import { prepareWrapupInput } from './wrapup/effects.ts';

export type InputContext = {
  action: Extract<ActionRecord, { kind: 'prepare_input' }>;
  deps: {
    // Whether the action's execution is still the ticket's current one.
    executionCurrent: boolean;
    // The all-stage usage table so far, excluding wrap-up.
    usage: () => string;
    // One line per passing work-validation check, per task.
    workChecks: () => Array<string>;
  };
  snapshot: FactorySnapshot;
};

// Input preparation reads the world outside the controller transaction and
// never throws for a problem the human can fix: that is a `failed` result.
export type InputResult<Prepared> =
  | { input: Prepared; kind: 'ready' }
  | { kind: 'failed'; message: string };

export type StageEffects<S extends StageName> = {
  validator: Validator<S>;
} & (S extends InputStage
  ? { prepareInput: (context: InputContext) => InputResult<PreparedInput[S]> }
  : unknown);

// The impure half of every stage. Only the action worker reads it; the
// reducer must not import this module.
export const effects: { [S in StageName]: StageEffects<S> } = {
  plan: { validator: planValidator },
  review: { validator: reviewValidator },
  work: { prepareInput: prepareWorkInput, validator: workValidator },
  wrapup: { prepareInput: prepareWrapupInput, validator: wrapupValidator },
};
