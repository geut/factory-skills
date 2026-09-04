---
name: factory-wrapup
description: Prepare an approved factory change for human pull-request submission by updating durable knowledge, summarizing scope and verification, and teaching material flows with progressive visuals. Use only after review approval; it never commits, pushes, or publishes.
---

# Factory Wrap-up

Turn approved work into a clean human handoff. Do not change product code unless a broken generated artifact prevents an accurate handoff; route substantive code changes back through work and review.

## Confirm readiness

Read the plan, issue files, optional ADR, approved review verdict, diff, and final test evidence. Stop and return the factory to work or review if required checks failed, acceptance criteria remain open, or the diff contains unexplained scope.

## Update durable knowledge

Update `CONTEXT.md`, `PRD.md`, or the project's documentation only when implementation established knowledge that remains useful beyond this factory. Keep task-local detail in `plan.md`. Add to company `learnings/` only when an observation could improve another factory or a factory skill; do not create a learning for routine success.

Do not create `wrapup.md` or a `visuals/` directory by default. The Pi/Herdr wrap-up session is the output surface. Promote an artifact to project documentation only when it must survive the factory.

## Build the handoff

Present:

1. The user-visible outcome.
2. A plain pull-request summary with explicit non-goals.
3. Files or artifacts added, modified, and removed.
4. Tests and E2E evidence, including anything not run.
5. Operational or migration notes.
6. Known limitations and follow-up work that is genuinely out of scope.

Open the diff, relevant code, runtime, or debugger when that lands the explanation faster than prose. Read [references/visual-explanations.md](references/visual-explanations.md) whenever the change has three or more moving parts or a spatial UI behavior.

In a supervised run, let the supervisor snapshot wrap-up usage and transition the factory to `done`. In a direct invocation, use `factory-state` when available. Do not commit, push, open a pull request, publish, or clean up the worktree. The human owns submission.
