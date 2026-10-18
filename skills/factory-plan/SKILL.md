---
name: factory-plan
description: Research and plan one ticket, producing a local plan, dependency-ordered task files, and only the durable context or ADR updates the ticket earns. Use before implementation when a feature, bug, refactor, performance task, or investigation needs to become executable work.
---

# Factory Plan

Turn one ticket into the smallest plan that another agent can execute without rediscovering the problem. Do not implement code.

## Start

1. Derive the code root with `git rev-parse --show-toplevel`. Use `<code-root>/.factory` unless the request supplies a `--factory-root` or `FACTORY_ROOT` override.
2. Read `.factory/FACTORY.json`. Obtain the ticket ID from the source or `ticketIdPattern`; if neither determines it, ask the user before creating artifacts.
3. Read `.factory/CONTEXT.md`, optional `.factory/PRD.md`, relevant code and tests, and project instructions.
4. When `github.cli` is true and the ticket is a GitHub issue, do not create `.factory/tickets/<ticket-id>/` as a copy of the issue. Keep acceptance criteria on the issue. A local execution note may point at the issue URL. When GitHub is not the source, create or reuse `.factory/tickets/<ticket-id>/` and read [references/artifacts.md](references/artifacts.md).

A parent issue is coordination only. If it has related concrete issues, stop and tell the controller to register those issues as separate tickets. Do not turn them into numbered tasks under the parent. A concrete ticket gets local task files only when its own implementation needs more than one slice, and only in filesystem mode. In tracker mode, split further by commenting on that issue or by asking the user before creating local tasks.

Do not create `reviews/`, `handoffs/`, `visuals/`, `decisions.md`, `wrapup.md`, or per-ticket state files.

## Resolve uncertainty economically

Answer questions from the codebase and existing documents before asking the user. When a material unknown changes scope, behavior, sequencing, or a hard-to-reverse decision, request user attention and use `grill-with-docs`. Ask one focused question at a time, include a recommended answer and its consequence, and stop as soon as the ticket is executable.

In a controller child session, call `caller_ping` with the question. The controller persists the question, sets the execution status to `waiting_for_user`, presents it, and resumes this same planning session after the answer. Do not emit a final planning contract while waiting. In a direct session, ask the user and pause normally.

When Matt Pocock's skills are installed, use their useful mechanics rather than copying their output locations:

- `grill-with-docs`: use the focused interview and domain-modeling behavior for unresolved decisions.
- `to-spec`: use its synthesis and test-seam thinking, but write `plan.md`; do not publish to a tracker.
- `to-tickets`: use tracer-bullet slicing and explicit blocking edges. In filesystem mode, write numbered task files in the ticket directory. In tracker mode, the concrete GitHub issue is the task source; do not publish a second copy. Do not use `.scratch/`.

Factory paths and the user's no-publish requirement override upstream defaults. If `grill-with-docs` is unavailable, use the same focused one-question behavior and report the missing optional skill; do not guess.

## Build the plan

Ground claims in inspected evidence. Capture the problem, desired behavior, constraints, non-goals, test seams, risks, and open questions. Prefer existing abstractions and seams. Propose a new abstraction only when it removes real duplication or hides complexity required by this task.

Split the plan into the fewest independently verifiable tasks. Prefer vertical behavior slices. Use expand-migrate-contract only when a wide refactor cannot remain green as vertical slices. Each task must fit one fresh work session and declare its dependencies.

Record a decision in `adr.md` only when it is hard to reverse, materially constrains future work, and has real alternatives. Update `.factory/CONTEXT.md` only with durable vocabulary or facts useful beyond this ticket. Do not create or update `PRD.md` for ticket-local knowledge.

## Validate and hand off

Before finishing, verify that:

- Every success condition maps to at least one task acceptance criterion.
- Every task has a user story or observable outcome, explicit scope, and a verification approach.
- Every task file starts with frontmatter holding `type`, `qa` and `blocked_by`. `qa` is `e2e` when a criterion can be observed in the running product, `none` when every criterion is internal (data layer, documentation, ADR, skill).
- Dependencies form an acyclic graph and the ready frontier is clear.
- The plan does not contain speculative infrastructure or unrelated cleanup.
- No task commits, pushes, or merges, and no criterion requires a commit. Work leaves its change uncommitted in the worktree and fails validation if HEAD moves; wrap-up hands off the commit.
- Unknowns that could invalidate implementation are resolved or marked as blockers.

In a controller run, return the planning result and let the controller validate artifacts and transition state. In a direct invocation, report the result without inventing operational state edits.

Do not commit or publish anything.

## Output

Write `plan.md` and one or more numbered task files, using [references/artifacts.md](references/artifacts.md). The plan is those files: the controller accepts it when `plan.md` exists, at least one task file is present, and every task file's frontmatter is valid with dependencies that name other task files and form no cycle. It does not grade the chat text. Summarize the result in your reply using the `factory.plan.v3` template in [references/output.md](references/output.md) as a model; it is a suggestion, not a requirement. Then call `subagent_done` once and emit nothing else. If it replies that the session is shutting down, stop. Do not call it again, do not call `caller_ping`, and do not send more text. `caller_ping` is the only other terminal call, and it replaces the template when you need a decision. Do not publish a second copy of a GitHub issue into `.factory/tickets` when GitHub is the ticket source. Do not edit the controller database.
