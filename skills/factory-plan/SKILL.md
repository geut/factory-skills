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
4. Create or reuse `.factory/tickets/<ticket-id>/` and read [references/artifacts.md](references/artifacts.md).

Do not create `reviews/`, `handoffs/`, `visuals/`, `decisions.md`, `wrapup.md`, or per-ticket state files.

## Resolve uncertainty economically

Answer questions from the codebase and existing documents before asking the user. When a material unknown changes scope, behavior, sequencing, or a hard-to-reverse decision, request user attention and use `grill-with-docs`. Ask one focused question at a time, include a recommended answer and its consequence, and stop as soon as the ticket is executable.

In a supervised child session, call `caller_ping` with the question. The supervisor sets the ticket status to `waiting_for_user`, presents the question, and resumes this same planning session with `subagent_resume` after the answer. Do not emit a final planning contract while waiting. In a direct session, ask the user and pause normally.

When Matt Pocock's skills are installed, use their useful mechanics rather than copying their output locations:

- `grill-with-docs`: use the focused interview and domain-modeling behavior for unresolved decisions.
- `to-spec`: use its synthesis and test-seam thinking, but write `plan.md`; do not publish to a tracker.
- `to-tickets`: use tracer-bullet slicing and explicit blocking edges, but write numbered task files in the ticket directory; do not publish externally or use `.scratch/`.

Factory paths and the user's no-publish requirement override upstream defaults. If `grill-with-docs` is unavailable, use the same focused one-question behavior and report the missing optional skill; do not guess.

## Build the plan

Ground claims in inspected evidence. Capture the problem, desired behavior, constraints, non-goals, test seams, risks, and open questions. Prefer existing abstractions and seams. Propose a new abstraction only when it removes real duplication or hides complexity required by this task.

Split the plan into the fewest independently verifiable tasks. Prefer vertical behavior slices. Use expand-migrate-contract only when a wide refactor cannot remain green as vertical slices. Each task must fit one fresh work session and declare its dependencies.

Record a decision in `adr.md` only when it is hard to reverse, materially constrains future work, and has real alternatives. Update `.factory/CONTEXT.md` only with durable vocabulary or facts useful beyond this ticket. Do not create or update `PRD.md` for ticket-local knowledge.

## Validate and hand off

Before finishing, verify that:

- Every success condition maps to at least one task acceptance criterion.
- Every task has a user story or observable outcome, explicit scope, and a verification approach.
- Dependencies form an acyclic graph and the ready frontier is clear.
- The plan does not contain speculative infrastructure or unrelated cleanup.
- Unknowns that could invalidate implementation are resolved or marked as blockers.

In a supervised run, return the planning result and let the supervisor create or transition state. In a direct invocation, use `factory-state` when available; otherwise report the missing integration without inventing state edits.

Do not commit or publish anything. End with exactly one JSON object so the supervisor can validate the stage boundary:

```json
{
  "schema": "factory.plan.v2",
  "ticket": "PROJ-123",
  "status": "planned",
  "plan": ".factory/tickets/PROJ-123/plan.md",
  "adr": null,
  "tasks": [
    {
      "id": "01",
      "path": ".factory/tickets/PROJ-123/01-task-foundation.md",
      "status": "pending",
      "blockedBy": []
    }
  ],
  "readyTasks": ["01"],
  "contextChanged": false,
  "prdChanged": false,
  "assumptions": [],
  "blocker": null
}
```

`status` is either `planned` or `blocked`. A blocked result must identify the unresolved decision or missing evidence in `blocker`; it may contain partial artifact paths but must not advertise a ready task frontier.
