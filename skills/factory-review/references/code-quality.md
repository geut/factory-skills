# Lightweight code-quality review

This is a scoped adaptation of pstack's [code-quality review](https://github.com/cursor/plugins/blob/main/pstack/skills/interrogate/references/code-quality-review.md) for a single-reviewer, budget-limited factory.

Apply this lens after correctness and acceptance criteria. A different implementation is not automatically a better implementation; require a concrete maintainability benefit.

## Look for subtractive simplification

Ask whether one structural move could remove branches, helpers, modes, duplicated paths, or layers while preserving behavior. Prefer deletion of incidental complexity over rearranging it. Block only when the current change introduces material avoidable complexity, not because a broader redesign would be interesting.

## Inspect the changed structure

- **Control flow:** flag scattered feature checks, nested conditionals, silent fallbacks, and special cases inserted into unrelated paths. Prefer one explicit policy or state transition when it makes the behavior easier to follow.
- **Ownership:** keep logic in the canonical module or layer. Reuse an existing helper when it truly owns the rule; do not normalize duplicated one-offs or leak implementation details across an API.
- **Abstractions:** challenge pass-through wrappers, thin indirection, premature generality, and extension points with no current caller. Also challenge a large mixed-responsibility function when extracting one cohesive unit would hide real complexity.
- **Boundaries:** make important invariants explicit at inputs, outputs, and state transitions. Flag loose types, unchecked shapes, casts, or optional fields only when they conceal a plausible failure or spread uncertainty.
- **State and concurrency:** look for partial updates, inconsistent ownership, races, and unnecessary serialization. Ask for atomicity or parallelism only when the task and evidence require it.
- **Diagnostics:** important failures should be observable with the project's existing logging and instrumentation seams. Do not demand an observability framework for a local change.
- **Proportion:** the amount of code and machinery should match the issue. Flag unrelated cleanup and infrastructure for hypothetical future work.

## Findings bar

Prefer a few high-confidence structural findings over a catalog of nits. Each finding must show:

1. The concrete complexity or maintenance failure introduced or preserved by this change.
2. Evidence in the diff and surrounding code.
3. A smaller or clearer outcome, without prescribing a speculative rewrite.

Treat a structural problem as blocking when it makes required behavior unsafe, duplicates a canonical rule, creates tangled control flow likely to regress, or adds substantial unnecessary machinery. Otherwise omit it or mark it non-blocking. Naming, formatting, and personal style are not findings unless they obscure a real invariant.

If a valuable restructuring exceeds the ticket's scope, report it as a non-blocking follow-up. Do not hold a correct, direct change hostage to a codebase-wide cleanup.
