---
name: factory-supervise
description: Coordinate one or more tickets inside a Herdr-managed Pi sandbox using specialist subagents, isolated worktrees, atomic factory state, usage accounting, and at most three work-review rounds. Use when starting factory orchestration in this session, not for planning, implementation, or review itself. Do not apply when the user is continuing an already-supervised ticket; those prompts resume this session by ticket id.
---

# Factory Supervise

Coordinate ticket stages. Do not do specialist work. Herdr owns live sessions. `.factory/` holds durable guidance. `.factory/db/state.sqlite` holds operational state.

## Establish the runtime

Derive the code root with `git rev-parse --show-toplevel`. Default the factory root to `<code-root>/.factory`. Use `--factory-root` or `FACTORY_ROOT` only when the request supplies that override. Config object shape is in [references/runtime-protocol.md](references/runtime-protocol.md#configuration).

Read `<factory-root>/FACTORY.json`. Obtain the ticket ID from the ticket source or `ticketIdPattern`. If neither determines the ID, ask the user.

Verify that:

- Pi runs in a persistent Herdr pane.
- Herdr is at least 0.8.2.
- `subagent`, `subagent_resume`, `subagent_interrupt`, and `subagents_list` are provided by `pi-herdr-subagents`.
- The extension's bundled Herdr plugin is linked and enabled.
- Node.js 24+ can run [scripts/fstate/cli.mjs](scripts/fstate/cli.mjs).

Use `fstate` for every factory-state mutation. Never open `.factory/db/` by hand. The command catalog is in [references/runtime-protocol.md](references/runtime-protocol.md#state-ownership) and in `fstate help`.

If the subagent tools are absent, report the setup problem. Do not type commands into panes. Do not scrape terminal output. Do not poll session files for completion. Do not drive roles with `herdr agent start` or `herdr agent prompt`.

Use one Herdr workspace and one isolated worktree per active ticket. Never run two tickets in the same checkout. If `maxTickets` or `maxAgents` would be exceeded, queue the excess work.

## Name panes and report metadata

Rename the supervisor pane to `<ticket-id> · supervisor`. Pass a compact, unique `name` on every `subagent` and `subagent_resume` call. `pi-herdr-subagents` uses that name as the child pane label:

- `<ticket-id> · plan`
- `<ticket-id> · work T<task>`
- `<ticket-id> · review T<task> R<round>`
- `<ticket-id> · wrapup`

After spawn returns a pane ID, report display-only Herdr metadata from source `factory-supervise`: `ticket`, `stage`, and, when they apply, `task` and `round`. Clear tokens that no longer apply. Store the pane label as `paneName` beside `paneId` in state. Call `herdr` directly for rename and `report-metadata`. For a single JSON field, use `jq`. Do not write `python3 -c` or a heredoc to parse Herdr JSON.

Display-metadata commands are in [references/runtime-protocol.md](references/runtime-protocol.md#herdr-display-metadata).

## Start specialist subagents

Use the extension's asynchronous `subagent` tool. Set `model` and `thinking` from `FACTORY.json`. If `thinking` is omitted in config, use `medium`. Always pass both `model` and `thinking` on `subagent`. Omitting `thinking` on the tool call makes the child inherit the supervisor's level. Do not type `pi --model` or `--thinking` into a pane. Role object shape is in [references/runtime-protocol.md](references/runtime-protocol.md#configuration).

Create a subagent only when its stage is active:

- Plan: `model=models.plan.model`, `thinking=models.plan.thinking`, `skills=factory-plan`, ticket worktree as `cwd`, and only research-capable tools.
- Work: `model=models.work.model`, `thinking=models.work.thinking`, `skills=factory-work`, ticket worktree as `cwd`, and the tools needed to edit and verify code.
- Review: `model=models.review.model`, `thinking=models.review.thinking`, `skills=factory-review`, ticket worktree as `cwd`, and `tools=read,grep,find,ls`. Never `bash`, `edit`, or `write`.
- Wrap-up: `model=models.wrapup.model`, `thinking=models.wrapup.thinking`, `skills=factory-wrapup`, ticket worktree as `cwd`, and the tools needed for documentation, evidence, and the Pi summary plus Fresh diff surfaces.

The reviewer model must differ from the work model. The spawn call returns immediately. Continue independent work or end the turn and wait for the extension's steer message. Never fabricate a result. Never poll for a result. Tell each child to end with the skill Output template and to omit a recap after that template.

To continue the same planner after `caller_ping`, the same worker after findings, or the same reviewer during later rounds, use `subagent_resume`. Do not pass `thinking` on resume. Use `subagent_interrupt` only to stop work that is no longer valid or that exceeds a limit.

After the steer, run [scripts/pi-session-reader.py](scripts/pi-session-reader.py) once against the child's `sessionFile`. Do not treat steered prose as the contract. Do not poll the file. Do not write inline Python to parse Pi JSONL.

`--check` is the stage gate. It prints one line, `ok` or `invalid`, and exits 0, 3, or 4. To print compact JSON for `fstate`, omit `--check`. Copy `--expected-revision` from the previous `fstate` JSON `revision`.

Commands used at stage boundaries:

- `python3 <skill-dir>/scripts/pi-session-reader.py contract --schema <factory.plan.v3|factory.work.v3|factory.review.v4|factory.wrapup.v1> --check <session-file>`
- `node <skill-dir>/scripts/fstate/cli.mjs usage record --ticket <ticket-id> --stage <stage> --session <session-file> --expected-revision <revision>`
- `node <skill-dir>/scripts/fstate/cli.mjs transition --ticket <ticket-id> --stage <stage> --status <status> --expected-revision <revision>`
- `python3 <skill-dir>/scripts/review-packet.py --ticket <ticket-id> --task <task-id> --worktree <worktree> --out /tmp`

## Coordinate ticket stages

Stages run `plan`, then `work`, then `review`, then `wrapup`, then `done`. Review can return to work. At most three review rounds run unattended.

At each stage boundary:

1. Run `pi-session-reader.py contract --schema … --check` once on `sessionFile`. The schema is `factory.plan.v3`, `factory.work.v3`, `factory.review.v4`, or `factory.wrapup.v1`. Do not treat steered prose as the contract. If the exit code is 0, continue. If the exit code is 3 or 4, call `subagent_resume` once with the stderr line and request only the Output template.
2. Record billed usage with `node <skill-dir>/scripts/fstate/cli.mjs usage record`.
3. Apply one atomic ticket transition through `node <skill-dir>/scripts/fstate/cli.mjs`. For review, `review record` takes verdict, finding-count, and blocking-count from `contract` without `--check`.
4. Record only meaningful progress or blockers.
5. Start or resume the next role with only the context it needs.

Ticket stage is `plan`, `work`, `review`, `wrapup`, or `done`. Ticket status is `active`, `waiting_for_user`, `blocked`, `failed`, or `complete`. Herdr lifecycle status is not ticket status. An idle child is not proof that a stage succeeded.

When a planner calls `caller_ping`, set the ticket to `waiting_for_user`, present its question, and stop. After the user responds, return the ticket to `active` and resume the same planner session with the answer.

On resume after a crash or restart, follow [recovery](references/runtime-protocol.md#recovery).

## Run the review loop

After work `--check` passes, run `review-packet.py` once against the ticket worktree. The diff is the cumulative uncommitted ticket change, including earlier approved tasks. Pass only the two output paths as the reviewer task. Do not restate outcome, acceptance criteria, file lists, or test results in the spawn prompt:

```text
Review ticket PROJ-14 task 01 round 1. Follow factory-review.
Packet: /tmp/PROJ-14-T01-R1-packet.md
Diff: /tmp/PROJ-14-T01-R1.diff
End with the factory.review.v4 Output template only.
```

On review completion, run `pi-session-reader.py contract --schema factory.review.v4 --check --round <n>` once. If that fails, resume the reviewer once with the stderr line and request only the Output template. Do not create a review archive. Do not ask for a JSON object.

Relay blocking findings to the existing work session as the parsed Findings list (`R{round}-{n}`, location, finding, suggestion), not the whole review. Validate the worker with `contract --schema factory.work.v3 --check`. Include a disposition and evidence for each finding. Then rerun `review-packet.py` and resume the same reviewer with the new packet and diff paths.

Stop when the reviewer approves with no blocking findings (`critical` or `major`). Stop when three review rounds have completed. Stop when a role reports a genuine blocker requiring the user.

If blocking findings remain after round three, set the ticket to `waiting_for_user`. Never begin a fourth round without explicit authorization.

Enforce Output templates, identity, ordering, limits, and evidence relay. Do not overrule technical judgment. If work and review explicitly disagree, make one bounded `subagent` call using `models.arbiter.model` and `models.arbiter.thinking` with only the disputed findings and evidence. If `thinking` is omitted, use `medium`. If there is no arbiter, ask the user. Do not pay for another full review.

After approval, set the task to `done` and reset its review counter. Choose the next `pending` task whose dependencies are all `done`. Start wrap-up only after every required task is `done` and required checks pass.

## Finish

Validate the wrap-up handoff with `contract --schema factory.wrapup.v1 --check`. Record its usage with `pi-session-reader.py usage`. Render the final all-stage table described in [../factory-wrapup/references/usage-table.md](../factory-wrapup/references/usage-table.md). Include the table in the supervisor's user-facing completion message. Do not create a handoff artifact solely to carry it.

`pi-herdr-subagents` closes a child pane after clean completion. Once the wrap-up result has been steered back, follow [../factory-wrapup/references/panes-handoff.md](../factory-wrapup/references/panes-handoff.md) to open two human-facing panes with its generic argv launcher and leave them open:

- `<ticket-id> · summary` reopens the completed wrap-up Pi session with `pi --session` and no prompt.
- `<ticket-id> · diff` opens Fresh in the worktree and runs the working-tree `Review Diff` command.

Use absolute executable, session, and script paths in the generic launcher. Capture each returned pane ID with `jq`, not inline Python. Do not call `subagent_resume`, send a prompt, start a model turn, or pass `--thinking` when reopening the transcript. If either surface cannot be opened, report the exact limitation in the handoff.

After the handoff and usage table are complete, set stage `done` with status `complete`. Never commit, merge, push, open a pull request, publish a ticket, remove a worktree, or delete a branch unless the user explicitly requests it.

Keep concurrent tickets' workspaces, worktrees, prompts, sessions, and state entries isolated. One ticket's blocker must not stop another ticket.
