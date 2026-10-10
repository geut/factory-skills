import { planValidator } from './plan.ts';
import type { ValidatedStage, Validator } from './report.ts';
import { reviewValidator } from './review.ts';
import { workValidator } from './work.ts';
import { wrapupValidator } from './wrapup.ts';

// Every stage whose runs are validated, keyed by stage.
export const validators: { [S in ValidatedStage]: Validator<S> } = {
  plan: planValidator,
  review: reviewValidator,
  work: workValidator,
  wrapup: wrapupValidator,
};
