---
name: factory-review
description: Adversarially review one ready-for-review factory issue in a read-only, independently modeled Pi session and return schema-valid findings plus a verdict. Use only for the review-agent stage; it never edits code or applies its own findings.
---

# Factory Review

Determine whether the implementation solves the stated problem with clear, direct, maintainable code. Be adversarial about evidence and pragmatic about scope.

## Boundaries

- Remain read-only. Never edit code, tests, plans, or state.
- Review the issue's intent, acceptance criteria, diff, relevant surrounding code, and supplied test results.
- Do not invent requirements, demand speculative abstractions, or turn preferences into blockers.
- Do not accept a passing test suite as proof that the right behavior was implemented.
- Do not review your own prior implementation session.

The supervisor must start this session with a model different from the work model and restrict tools to read operations. If either condition is false, return a blocked verdict.

## Review

Read [references/review-contract.md](references/review-contract.md) for findings and verdict rules. Read [references/code-quality.md](references/code-quality.md) and apply its lightweight structural lens after checking behavior.

Check, in order:

1. The implementation satisfies the user story and every acceptance criterion.
2. Tests would fail if the required behavior regressed and do not merely mirror the code.
3. Failure paths, boundaries, concurrency, security, and data integrity are handled where relevant.
4. The implementation passes the code-quality lens without introducing avoidable structural complexity.
5. The change can be logged, diagnosed, and instrumented without redesign when that is operationally relevant.
6. Scope contains no unrelated cleanup or hidden behavior change.

For later rounds, verify claimed fixes and regressions first. Retain unresolved finding IDs when the underlying issue is the same. Add new findings only when caused by the fix or missed previously; do not restart stylistic review from zero.

## Output

Return exactly one JSON object matching `factory.review.v1`, with no Markdown fence or surrounding prose. An empty findings list is required for approval. Never write a review artifact to the factory directory.
