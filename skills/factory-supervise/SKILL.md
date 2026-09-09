---
name: factory-supervise
description: Run or resume one or more tickets inside a Herdr-managed Pi sandbox, coordinating specialist subagents, isolated worktrees, atomic factory state, usage accounting, and at most three work-review rounds. Use for factory orchestration rather than planning, implementation, or review itself.
---

# Factory Supervise

Coordinate ticket stages without doing specialist work. Herdr owns live sessions, `.factory/` holds durable guidance, and `.factory/FACTORY-STATE.json` holds operational state.

Read [references/runtime-protocol.md](references/runtime-protocol.md) before starting or resuming supervision.

## Establish the runtime

Derive the code root with `git rev-parse --show-toplevel` and default the factory root to `<code-root>/.factory`. Use an explicit `--factory-root` or `FACTORY_ROOT` override only when supplied. Read `<factory-root>/FACTORY.json`; obtain the ticket ID from its source or `ticketIdPattern`, asking the user when neither determines it.

Verify that:

- Pi runs in a persistent Herdr pane.
- Herdr is at least 0.8.2.
- `subagent`, `subagent_resume`, `subagent_interrupt`, and `subagents_list` are provided by `pi-herdr-subagents`.
- The extension's bundled Herdr plugin is linked and enabled.
- `factory-state` is available before relying on supervised state changes.

If the subagent tools are absent, report the setup problem. Do not fall back to typing commands into panes, scraping terminal output, or polling session files for completion.

Use one Herdr workspace and one isolated worktree per active ticket. The extension places child panes beside their supervisor, so each ticket has its own supervisor workspace. Never run two tickets in the same checkout. Respect `maxTickets` and `maxAgents`; queue excess work.

## Start specialist subagents

Use the extension's asynchronous `subagent` tool. Set its overrides from `FACTORY.json` rather than maintaining model-specific agent definitions:

- Plan: `model=models.plan`, `skills=factory-plan`, ticket worktree as `cwd`, and only research-capable tools.
- Work: `model=models.work`, `skills=factory-work`, ticket worktree as `cwd`, and the tools needed to edit and verify code.
- Review: `model=models.review`, `skills=factory-review`, ticket worktree as `cwd`, and read-only tools. Supply the diff and test evidence in the task when the reviewer cannot obtain them with its allowlist.
- Wrap-up: `model=models.wrapup`, `skills=factory-wrapup`, ticket worktree as `cwd`, and only the tools needed for documentation and evidence.

The reviewer model must differ from the work model. Create a subagent only when its stage is active. The spawn call returns immediately; continue independent work or end the turn and wait for the extension's steer message. Never fabricate a result or poll for one.

Use `subagent_resume` to continue the same planner after `caller_ping`, the same worker after findings, and the same reviewer during later rounds. Use `subagent_interrupt` only to stop work that is no longer valid or explicitly exceeds a limit.

## Coordinate ticket stages

```text
plan → work → review → wrapup → done
          ↑       |
          └───────┘    changes requested; maximum three review rounds
```

At each stage boundary:

1. Validate `factory.plan.v2`, `factory.work.v2`, `factory.review.v2`, or the wrap-up handoff requirements.
2. Record numeric Pi token and cost usage for the completed or paused session through `factory-state usage record`.
3. Apply one atomic ticket transition through `factory-state`.
4. Record only meaningful progress or blockers.
5. Start or resume the next role with only the context it needs.

Stage is `plan`, `work`, `review`, `wrapup`, or `done`. Status is independently `active`, `waiting_for_user`, `blocked`, `failed`, or `complete`. Herdr lifecycle status is not ticket status, and an idle child is not proof that a stage succeeded.

When a planner calls `caller_ping`, set the ticket to `waiting_for_user`, present its question, and stop. After the user responds, return the ticket to `active` and resume the same planner session with the answer.

## Review loop

On review completion, validate the final assistant message from the extension's steer as `factory.review.v2`. If parsing fails, resume the reviewer once and request only the JSON object. A temporary file is an allowed fallback only when the steer cannot carry the result; remove it after relay and do not create a review archive.

Relay blocking findings to the existing work session. Validate its `factory.work.v2` response, including a disposition and evidence for each finding, then resume the same reviewer with the response, current diff, and updated test evidence. Stop when:

- The reviewer approves with no findings.
- Three review rounds have completed.
- A role reports a genuine blocker requiring the user.

After round three, unresolved blocking findings set the ticket to `waiting_for_user`. Never begin a fourth round without explicit authorization.

The supervisor is the default arbiter: it enforces schemas, identity, ordering, limits, and evidence relay without overruling technical judgment. If work and review explicitly disagree, it may make one bounded call using `models.arbiter` with only the disputed findings and evidence. Otherwise ask the user rather than paying for another full review.

After approval, set the task to `done`, reset its review counter, and choose the next `pending` task whose dependencies are all `done`. Start wrap-up only after every required task is `done` and required checks pass.

## Finish

Validate the wrap-up handoff, record its usage, and set stage `done` with status `complete`. Never commit, merge, push, open a pull request, publish a ticket, remove a worktree, or delete a branch unless the user explicitly requests it.

Keep concurrent tickets' workspaces, worktrees, prompts, sessions, and state entries isolated. One ticket's blocker must not stop another ticket.
