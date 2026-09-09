---
name: factory-reflect
description: Mine completed ticket evidence for reusable factory improvements, propose narrowly routed skill or tooling changes, and compare candidates against a budget-aware evaluation set before human approval. Use after meaningful factory experience, not after every routine ticket.
---

# Factory Reflect

Improve the factory from evidence without turning one incident into universal policy. Never auto-apply a skill change.

## Select evidence

Use completed tickets in the current factory root only: plans and discoveries, state transitions, usage, blockers, final work and review session outputs, wrap-up, and existing learnings. Do not search unrelated repositories or private sessions.

Run reflection when the user asks, when a costly failure or correction reveals a general mechanism, or when the same useful pattern appears across tickets. Skip routine success already covered by existing instructions.

## Derive candidates

For each candidate learning, record:

- The observed evidence and ticket identifiers.
- The general mechanism, separated from task-specific details.
- The smallest place that can enforce it.
- Expected benefit and budget effect.
- A counterexample showing when it should not apply.

Route the change to deterministic tooling or validation when code can enforce it more reliably. Route stable project facts to `.factory/CONTEXT.md` or `.factory/FACTORY.json`. Route decision guidance to the narrowest existing skill. Propose a new skill only when no existing boundary fits.

Write accepted candidates under `.factory/learnings/` only when they are reusable. Keep rejected ideas in the session rather than building a permanent backlog of noise.

## Evaluate before proposing application

Read [references/evaluation.md](references/evaluation.md). Compare the current skill baseline with the candidate using the smallest scenario set capable of exposing the intended improvement and likely regression. Include quality, schema validity, test outcome, scope, review rounds, token usage, and cost.

Present each candidate as `accept`, `revise`, or `reject`, with evidence and evaluation results. Ask the user which accepted candidates to apply. Only after explicit approval may the relevant skill-authoring workflow edit the skill repository. Validate changed skills and rerun affected evaluations.

Do not commit, publish, or update installed skills automatically.
