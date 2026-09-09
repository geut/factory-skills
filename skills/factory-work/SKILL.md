---
name: factory-work
description: Implement one dependency-ready ticket task in an isolated worktree using a small design sketch, behavior-first tests, the appropriate task playbook, and bounded verification. Use for the work stage after ticket planning.
---

# Factory Work

Implement one task. Keep the change no larger than the task's observable outcome requires.

## Establish the contract

Read `.factory/CONTEXT.md`, the ticket's `plan.md`, optional `adr.md`, the target task, its blockers, relevant code and tests, and project instructions. Confirm the ticket and task identifiers before editing. Do not begin when a dependency is incomplete or the worktree is shared with another active ticket.

If the plan conflicts with current evidence, update `plan.md` under `Discoveries` and adjust affected task scope before continuing. Escalate when the new evidence changes product behavior or invalidates multiple tasks.

Read [references/playbooks.md](references/playbooks.md) and use only the playbook matching the task type.

## Design before editing

Sketch the smallest viable shape:

- Start with the caller or user-visible behavior.
- Identify the highest existing test seam.
- Name the modules and public interfaces that must change.
- State what remains unchanged.
- Prefer one clear path over speculative extension points.

Keep this sketch in the session unless it changes the durable plan. Do not scaffold unused abstractions. If implementation repeatedly fights the sketch, stop, incorporate the evidence, and redesign instead of layering exceptions.

## Implement in proving slices

1. Add the smallest failing test that demonstrates the next required behavior when a meaningful automated test is feasible.
2. Confirm it fails for the expected reason.
3. Write the least code that makes it pass.
4. Refactor only where the passing behavior exposes duplication or unclear ownership.
5. Repeat until the acceptance criteria are covered.

Tests should exercise public behavior, not mirror implementation. For a behavior that cannot reasonably begin with a failing test, state why and use the closest reliable validation. Do not add test-only production interfaces.

Add or update E2E coverage for user stories when the project has a viable harness. If automation is unavailable or disproportionately expensive, record the reason and a concrete human verification path in the task.

Run focused checks while working, then the relevant broader suite once. Do not spend budget repeatedly running an unchanged full suite.

## Finish the work stage

Mark satisfied acceptance criteria and set the task status to `ready_for_review`, not `done`; review owns approval. Update durable context only for facts useful beyond this ticket.

In a supervised run, report transitions and blockers in the result and let the supervisor update state and usage. In a direct invocation, use `factory-state` when available. Never edit `FACTORY-STATE.json` directly.

Do not start the reviewer, commit, push, publish, or create a pull request. The supervisor owns the next stage.

End with exactly one JSON object so the supervisor can relay it:

```json
{
  "schema": "factory.work.v2",
  "ticket": "<ticket-id>",
  "task": "<task-number>",
  "status": "ready_for_review",
  "summary": "<observable result>",
  "changed": ["<path>"],
  "tests": [{"command": "<command>", "result": "passed|failed|not_run", "note": "<why>"}],
  "e2e": {"result": "passed|failed|not_feasible", "note": "<evidence or human path>"},
  "reviewResponses": [{"finding": "R1-01", "disposition": "fixed|not_fixed|disputed", "evidence": "<path, test, or explanation>"}],
  "planChanged": false,
  "blocker": null
}
```

`status` is either `ready_for_review` or `blocked`. A blocked result must explain the blocker; it must not claim completed verification.
