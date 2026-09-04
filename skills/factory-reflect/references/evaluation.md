# Budget-aware skill evaluation

Evaluate decisions and observable artifacts, not exact prose.

## Minimal scenario set

Maintain small fixture repositories or reproducible cases covering:

- One bug with a misleading symptom.
- One narrow feature with a user-visible E2E story.
- One refactor where behavior must not change.
- One performance claim requiring a baseline.
- One review containing both a real blocker and a tempting false positive.
- One multi-factory state-concurrency case.

Run only scenarios touched by a candidate, plus one nearby regression case. Use the same model and comparable starting context for baseline and candidate. Repeat only when nondeterminism makes the result ambiguous.

## Scorecard

Capture machine-checkable results first:

- Required artifacts and JSON contracts are valid.
- Project tests and scenario assertions pass.
- Forbidden writes, publishing, or extra review rounds did not occur.
- State transitions and concurrent updates remain valid.
- Token counts and reported cost by stage.

Then apply a short human rubric:

- Solves the stated problem.
- Uses clear, minimal abstractions.
- Avoids unrelated scope and speculative machinery.
- Leaves maintainable tests and an understandable handoff.

## Promotion rule

Promote a candidate only when it improves its target failure without a material regression in correctness, scope, or budget. A cheaper result that is wrong does not pass. A more expensive result needs a demonstrated quality gain worth the cost.

Store durable evaluation results with the skills repository's evaluation harness, not in each factory directory. Company `learnings/` may hold a concise evidence link and proposal while it awaits evaluation or approval.
