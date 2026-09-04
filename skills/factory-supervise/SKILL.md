---
name: factory-supervise
description: Run or resume one or more software factories inside a Herdr-managed Pi sandbox, coordinating role sessions, isolated worktrees, atomic factory state, usage accounting, and at most three work-review rounds. Use for factory orchestration rather than implementation or review itself.
---

# Factory Supervise

Coordinate factory stages without doing their specialist work. Herdr owns live sessions; factory files hold durable guidance; `FACTORY-STATE.json` holds authoritative operational state.

Read [references/runtime-protocol.md](references/runtime-protocol.md) before starting or resuming a managed factory.

## Establish the runtime

Verify that the session is inside Herdr, the Pi integration is current, and `herdr`, `pi`, and `factory-state` are available. Read `FACTORY.json` and validate the requested factory identifier against its naming convention. If company configuration is missing, ask only for the company root, code root, naming convention, model assignments, and concurrency limit needed to initialize it; do not invent model identifiers or budgets.

Use one Herdr workspace and one isolated code worktree per active factory. Never run two factories in the same checkout. Respect `maxFactories` and `maxAgents`; queue excess work instead of silently exceeding the budget.

Create role sessions only when their stage is active. Planning, review, arbiter, and wrap-up agents do not need to consume tokens while work is running.

## Coordinate stages

Use explicit factory transitions; do not infer domain completion merely because a Pi agent is idle.

```text
planning → planned → working → reviewing → wrapping → done
                         ↑          |
                         └── fixing ┘    maximum three review rounds
```

At every stage boundary:

1. Validate the specialist's structured result.
2. Snapshot Pi token and cost usage for that stage.
3. Apply one atomic state transition through `factory-state`.
4. Update the Herdr workspace's display metadata when useful.
5. Start or prompt the next role with only the context it needs.

Record only meaningful messages and blockers. Do not mirror every agent lifecycle event into factory state.

## Review loop

Start one reviewer with `models.review`, which must differ from `models.work`, and a read-only tool allowlist. Wait for the session to settle, obtain its native Pi session reference through Herdr, and extract the final assistant message from Pi's JSONL session. Validate it as `factory.review.v1`.

If parsing fails, ask the reviewer once to repeat only the JSON object. If the response is still unavailable, allow a temporary-file handoff and remove it after relay. Do not create a persistent review directory or file.

Send blocking findings to the work session. Validate its `factory.work.v1` response, including a disposition and evidence for each relayed finding, then send the response and current diff back to the same reviewer session. Stop when:

- The reviewer approves with no findings.
- Three review rounds have completed.
- A stage reports a genuine blocker requiring the user.

After round three, unresolved blocking findings produce `awaiting_human`; never begin a fourth round without explicit user authorization.

The supervisor is the default arbiter: it enforces schemas, identity, ordering, limits, and evidence relay. It does not overrule technical judgment. If work and review explicitly disagree, optionally make one bounded call using `models.arbiter` with only the disputed findings and evidence. Otherwise escalate to the user rather than paying for a third full review.

After an issue is approved, set its status to `done`, reset the per-issue review counter, and move to the next issue whose dependencies are all done. Start wrap-up only when every required issue is done.

## Finish

Start wrap-up only after all issue reviews approve and required checks succeed. Never commit, push, open a pull request, publish tickets, or delete a worktree unless the user explicitly requests it.

When multiple factories are active, keep their session references, state, worktrees, and prompts isolated. A blocker in one factory must not stop independent factories.
