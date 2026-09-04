# Issue playbooks

Use one playbook. These are decision guides, not mandatory ceremony.

## Bug

1. Reproduce the failure at the highest reliable seam.
2. Reduce it to the smallest case that preserves the failure.
3. Trace the root cause; distinguish it from the visible symptom.
4. Add a regression test that fails for that cause.
5. Apply the smallest root-cause fix and verify nearby behavior.

Do not broaden a bug fix into unrelated cleanup.

## Feature

1. Choose one user story and its observable outcome.
2. Identify the existing seam closest to that outcome.
3. Sketch the minimal caller-facing contract.
4. Build a thin vertical slice through the required layers.
5. Prove it at the seam, then add E2E evidence where feasible.

Do not build generalized infrastructure for hypothetical future stories.

## Performance

1. Establish a repeatable baseline and target.
2. Form one hypothesis tied to measured evidence.
3. Add only the instrumentation needed to test it.
4. Change one material variable.
5. Compare using the same workload and report tradeoffs.

Do not claim improvement from intuition or incomparable measurements.

## Refactor

1. Lock current behavior with existing or characterization tests.
2. Define the smaller or clearer target shape.
3. Move in reversible steps that keep verification green.
4. Remove the superseded path only after callers migrate.
5. Confirm externally observable behavior is unchanged.

If behavior must change, separate that change into a feature or bug issue.

## Investigation

1. State the decision the investigation must unlock.
2. Gather the minimum evidence that can distinguish the plausible answers.
3. Prefer a disposable experiment over production scaffolding.
4. Record the conclusion, confidence, and remaining uncertainty.
5. Update the plan or create implementation issues; do not smuggle prototype code into production.
