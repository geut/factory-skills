---
name: factory-work
description: Implement one dependency-ready ticket task in an isolated worktree using a small design sketch, behavior-first tests, the appropriate task playbook, and bounded verification. Use for the work stage after ticket planning.
---

# Factory Work

Implement one task. Keep the change no larger than the task's observable outcome requires.

## Establish the contract

Read `.factory/CONTEXT.md`, the ticket's `plan.md`, optional `adr.md`, the target task, its blockers, relevant code and tests, and project instructions. Confirm the ticket and task identifiers before editing. Do not begin when a dependency is incomplete or the worktree is shared with another active ticket.

If the plan conflicts with current evidence, add a bullet to `plan.md` under `Discoveries` and adjust affected task scope before continuing. A bullet is a plain finding, what was found and what it changed, with no date, round, or run label; see [the plan artifacts](../factory-plan/references/artifacts.md). Escalate when the new evidence changes product behavior or invalidates multiple tasks.

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

Prove the real artifact before claiming the task is ready. Follow [../prove-it-works/SKILL.md](../prove-it-works/SKILL.md). A compile, typecheck, file timestamp, or self-report is not proof. When the project has `.factory/skills/verify-<repo>/`, drive that skill.

Leave the work uncommitted. The controller inspects the worktree diff and runs the commands in `FACTORY.json` `validation.work.commands`. Do not write an evidence manifest and do not set the task status. Review owns approval.

In a controller run, report the result and let the controller validate the diff, the configured checks, and usage. In a direct invocation, report the result without inventing operational state edits. Never open `.factory/db/` by hand.

Do not start the reviewer, commit, push, publish, or create a pull request. The controller owns the next stage.

## Output

Return only the `factory.work.v3` template in [references/output.md](references/output.md). No JSON object, no recap after it.

After the template, call `subagent_done` once and emit nothing else. If it replies that the session is shutting down, stop. Do not call it again, do not call `caller_ping`, and do not send more text. `caller_ping` is the only other terminal call, and it replaces the template when you need a decision. Do not edit the controller database.
