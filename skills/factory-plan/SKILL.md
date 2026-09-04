---
name: factory-plan
description: Research and plan one factory task, producing a local plan, dependency-ordered issue files, and only the durable context or ADR updates the task earns. Use before implementation when a ticket, feature, bug, refactor, or investigation needs to become executable work.
---

# Factory Plan

Turn one task into the smallest plan that another agent can execute without rediscovering the problem. Do not implement code.

## Start

1. Locate the company root, code root, and factory identifier from the request or `FACTORY.json`.
2. If the company has no factory naming convention, ask for it before creating the directory. Otherwise follow it without asking.
3. Read `CONTEXT.md`, optional `PRD.md`, relevant code and tests, and any project instructions.
4. Create or reuse `factories/<factory-id>/` and read [references/artifacts.md](references/artifacts.md).

Do not create `reviews/`, `handoffs/`, `visuals/`, `decisions.md`, `wrapup.md`, or a per-factory state file.

## Resolve uncertainty economically

Answer questions from the codebase and existing documents before asking the user. Ask one question at a time only when its answer changes scope, behavior, sequencing, or a hard-to-reverse decision. Offer a recommended answer and explain its consequence. Stop questioning as soon as the work is executable.

When Matt Pocock's skills are installed, use their useful mechanics rather than copying their output locations:

- `grill-with-docs`: use the focused interview and domain-modeling behavior for unresolved decisions.
- `to-spec`: use its synthesis and test-seam thinking, but write `plan.md`; do not publish to a tracker.
- `to-tickets`: use tracer-bullet slicing and explicit blocking edges, but write numbered files in this factory directory; do not publish externally or use `.scratch/`.

Factory paths and the user's no-publish requirement override upstream defaults.

## Build the plan

Ground claims in inspected evidence. Capture the problem, desired behavior, constraints, non-goals, test seams, risks, and open questions. Prefer existing abstractions and seams. Propose a new abstraction only when it removes real duplication or hides complexity required by this task.

Split the plan into the fewest independently verifiable issues. Prefer vertical behavior slices. Use expand-migrate-contract only when a wide refactor cannot remain green as vertical slices. Each issue must fit one fresh work session and declare its dependencies.

Record a decision in `adr.md` only when it is hard to reverse, materially constrains future work, and has real alternatives. Update company `CONTEXT.md` only with durable vocabulary or facts useful beyond this factory. Do not create or update `PRD.md` for task-local knowledge.

## Validate and hand off

Before finishing, verify that:

- Every success condition maps to at least one issue acceptance criterion.
- Every issue has a user story or observable outcome, explicit scope, and a verification approach.
- Dependencies form an acyclic graph and the ready frontier is clear.
- The plan does not contain speculative infrastructure or unrelated cleanup.
- Unknowns that could invalidate implementation are resolved or marked as blockers.

In a supervised run, return the planning result and let the supervisor create or transition state. In a direct invocation, use `factory-state` when available; otherwise report the missing integration without inventing state edits.

Finish with the paths created or updated, the ready issue frontier, remaining blockers, and any assumptions. Do not commit or publish anything.
