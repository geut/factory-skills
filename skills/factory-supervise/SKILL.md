---
name: factory-supervise
description: Coordinate one or more tickets inside a Herdr-managed Pi sandbox using specialist subagents, isolated worktrees, atomic factory state, usage accounting, and at most three work-review rounds. Use when starting factory orchestration in this session, not for planning, implementation, or review itself. Do not apply when the user is continuing an already-supervised ticket; those prompts resume this session by ticket id.
---

# Factory Supervise

Coordinate ticket stages. Do not do specialist work. Herdr owns live sessions. `.factory/` holds durable guidance. `.factory/db/state.sqlite` holds operational state.

## Establish the runtime

Derive the code root with `git rev-parse --show-toplevel`. Default the factory root to `<code-root>/.factory`. Use `--factory-root` or `FACTORY_ROOT` only when the request supplies that override. Config object shape is in [references/runtime-protocol.md](references/runtime-protocol.md#configuration).

Read `<factory-root>/FACTORY.json`. Obtain the ticket ID from the ticket source or `ticketIdPattern`. If neither determines the ID, ask the user.

When the ticket argument is a GitHub issue URL, `#<number>`, or a bare issue number, and `FACTORY.json` has `github.cli: true`, GitHub is the source of truth. Read the issue with `gh issue view <number> --comments`. Discover related concrete issues with `node <skill-dir>/scripts/github-related.mjs --issue <n> --repo <owner/name>`. Register each concrete issue as its own fstate ticket (`--kind concrete --parent <umbrella>`), record ticket dependencies with `ticket depend`, and work those tickets. The parent is an umbrella: comment on it, do not copy its children into `.factory/tickets` or into numbered tasks under the parent. Comment and update labels at stage and task boundaries. If a GitHub write fails, rerun `fstate github reconcile --ticket <id>` and execute the printed commands. Create or update a pull request only when `github.pullRequests` is true. Do not close an issue until its pull request is merged or the user asks.

When `github.cli` is not true, `.factory/tickets` is the source of truth. Do not create, comment on, or label GitHub issues. If `gh` is not authenticated, say that the issue was not read.

Verify that:

- Pi runs in a persistent Herdr pane.
- Herdr is at least 0.8.2.
- `subagent`, `subagent_resume`, `subagent_interrupt`, and `subagents_list` are provided by `pi-herdr-subagents`.
- The extension's bundled Herdr plugin is linked and enabled.
- Node.js 24+ can run [scripts/fstate/cli.mjs](scripts/fstate/cli.mjs).

Use `fstate` for every factory-state mutation. Never open `.factory/db/` by hand. The command catalog is in [references/runtime-protocol.md](references/runtime-protocol.md#state-ownership) and in `fstate help`.

If the subagent tools are absent, report the setup problem. Do not type commands into panes. Do not scrape terminal output. Do not poll session files for completion. Do not drive roles with `herdr agent start` or `herdr agent prompt`.

Use one Herdr workspace and one isolated worktree per active concrete ticket. Never run two tickets in the same checkout. If `maxTickets` or `maxAgents` would be exceeded, queue the excess work.

Create a new worktree at `$HOME/<repo-name>/worktrees/<ticket-id>`. Print that path with `fstate worktree path --repo <repo-name> --ticket <ticket-id>` and record it on `fstate create`. Do not put worktrees inside `.factory`. Keep an already recorded worktree where it is. The factory root stays `<main-checkout>/.factory`. Pass that absolute path as `FACTORY_ROOT` to every child, hook, and script. Never assume `<worktree>/.factory`.

## Name panes and report metadata

Rename every pane to `<prefix> <emoji>`, then ` T<task>` and ` R<round>` only when they apply. `<prefix>` is the first 12 characters of the ticket id. Use a shorter id whole. Separate the prefix, emoji, task, and round with a single space. Each role is one emoji:

- 🧭 supervisor
- 📋 plan
- 🔨 work
- 🔍 review
- 📦 wrapup
- ⚖️ arbiter
- 🔀 diff

Pass that label as `name` on every `subagent` and `subagent_resume` call, including the arbiter. `pi-herdr-subagents` uses that name as the child pane label. Rename the supervisor pane to the supervisor label. For `PROJ-123`: `PROJ-123 🧭`, `PROJ-123 🔨 T01`, `PROJ-123 🔍 T01 R1`.

After spawn returns a pane ID, report display-only Herdr metadata from source `factory-supervise`: `ticket` as the full ticket id, `stage`, and, when they apply, `task` and `round`. Clear tokens that no longer apply. Store the pane label as `paneName` beside `paneId` in state. Call `herdr` directly for rename and `report-metadata`. For a single JSON field, use `jq`. Do not write `python3 -c` or a heredoc to parse Herdr JSON.

Display-metadata commands are in [references/runtime-protocol.md](references/runtime-protocol.md#herdr-display-metadata).

## Start specialist subagents

Use the extension's asynchronous `subagent` tool. Set `model` and `thinking` from `FACTORY.json`. If `thinking` is omitted in config, use `medium`. Always pass both `model` and `thinking` on `subagent`. Omitting `thinking` on the tool call makes the child inherit the supervisor's level. Do not type `pi --model` or `--thinking` into a pane. Role object shape is in [references/runtime-protocol.md](references/runtime-protocol.md#configuration).

Create a subagent only when its stage is active:

- Plan: `model=models.plan.model`, `thinking=models.plan.thinking`, `skills=factory-plan`, ticket worktree as `cwd`, and only research-capable tools.
- Work: `model=models.work.model`, `thinking=models.work.thinking`, `skills=factory-work,prove-it-works`, ticket worktree as `cwd`, and the tools needed to edit and verify code. The worker proves the real artifact and writes the evidence manifest before `ready_for_review`.
- Review: `model=models.review.model`, `thinking=models.review.thinking`, `skills=factory-review`, ticket worktree as `cwd`, and `tools=read,grep,find,ls`. Never `bash`, `edit`, or `write`.
- Wrap-up: `model=models.wrapup.model`, `thinking=models.wrapup.thinking`, `skills=factory-wrapup`, ticket worktree as `cwd`, and the tools needed for documentation, evidence, and the Pi summary plus Fresh diff surfaces.

The reviewer model must differ from the work model. The spawn call returns immediately. Continue independent work or end the turn and wait for the extension's steer message. Never fabricate a result. Never poll for a result. Tell each child to end with the skill Output template, call `subagent_done`, and emit nothing after that tool. `caller_ping` is the only other terminal call.

Pass `agent=factory-plan|factory-work|factory-review|factory-wrapup` so the child gets `auto-exit: true` from [agents](agents). Still pass explicit `model`, `thinking`, `skills`, and `tools`. As soon as `subagent` returns `id`, `paneId`, and `sessionFile`, record the session as `starting` with `--subagent-id` set to that runtime id and `--session-id` set to the Pi session id when the session file already has one. Do not use the runtime id as the Pi session id. On the completion steer, reconcile the Pi session id from `pi-session-reader.py usage` and record usage against that id. Before `subagent_resume`, refuse a second `starting` or `running` runtime for the same session file. Name every resumed pane; do not leave it labeled `Resume`.

To continue the same planner after `caller_ping`, the same worker after findings, or the same reviewer during later rounds, use `subagent_resume`. Do not pass `thinking` on resume. Use `subagent_interrupt` only to stop work that is no longer valid or that exceeds a limit.

After the steer, run [scripts/pi-session-reader.py](scripts/pi-session-reader.py) once against the child's `sessionFile`. Do not treat steered prose as the contract. Do not poll the file. Do not write inline Python to parse Pi JSONL.

`--check` is the stage gate. It prints one line, `ok` or `invalid`, and exits 0, 3, or 4. To print compact JSON for `fstate`, omit `--check`. Copy `--expected-revision` from the previous `fstate` JSON `revision`.

Commands used at stage boundaries:

- `python3 <skill-dir>/scripts/pi-session-reader.py contract --schema <factory.plan.v3|factory.work.v3|factory.review.v4|factory.wrapup.v1> --check <session-file>`
- `node <skill-dir>/scripts/fstate/cli.mjs usage record --ticket <ticket-id> --stage <stage> --session <session-file> --expected-revision <revision>`
- `node <skill-dir>/scripts/fstate/cli.mjs transition --ticket <ticket-id> --stage <stage> --status <status> --expected-revision <revision>`
- `python3 <skill-dir>/scripts/review-packet.py --ticket <ticket-id> --task <task-id> --round <n> --worktree <worktree> --factory-root <factory-root> --out /tmp`

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

After work `--check` passes, run `review-packet.py` once against the ticket worktree with `--factory-root` and `--round`. The diff is the cumulative uncommitted ticket change, including earlier approved tasks. Pass only the two output paths as the reviewer task. Do not restate outcome, acceptance criteria, file lists, or test results in the spawn prompt:

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

Register every planned task with `fstate task register` while it is still `pending`. Do not use `task transition` to create tasks, and do not register a batch of tasks in a way that changes `currentTask`. `task register` never changes `currentTask`.

Move a task only through `fstate task transition`: `pending` → `in_progress` → `ready_for_review` → `in_review` → `done`. `in_review` → `in_progress` is the changes-requested edge. `blocked` returns to `pending` or `in_progress`. `ready_for_review` means the evidence gate passed and review has not started. `in_review` means a reviewer is running. Set `currentTask` only for `in_progress`, `ready_for_review`, `in_review`, and `blocked`. Clear it when that task is `done`.

`task transition` and ticket `transition` run the factory lifecycle hooks. A failing `before` hook blocks the write. Do not bypass a failed evidence hook. The default gates are `task:ready_for_review` and `ticket:wrapup`.

After approval, set the task to `done` and reset its review counter. Choose the next `pending` task whose task dependencies are all `done`, and whose ticket dependencies are all `done` or `complete`. Start the reviewer by transitioning the task to `in_review` before spawning it. Start wrap-up only after every required task is `done` and required checks pass.

## Finish

Validate the wrap-up handoff with `contract --schema factory.wrapup.v1 --check`. Record its usage with `pi-session-reader.py usage`. Render the final all-stage table described in [../factory-wrapup/references/usage-table.md](../factory-wrapup/references/usage-table.md). Include the table in the supervisor's user-facing completion message. Do not create a handoff artifact solely to carry it.

`pi-herdr-subagents` closes a child pane after clean completion. Once the wrap-up result has been steered back, follow [../factory-wrapup/references/panes-handoff.md](../factory-wrapup/references/panes-handoff.md) to open two human-facing panes with its generic argv launcher and leave them open:

- `<prefix> 📦` reopens the completed wrap-up Pi session with `pi --session` and no prompt.
- `<prefix> 🔀` opens Fresh in the worktree and runs the working-tree `Review Diff` command.

Use absolute executable, session, and script paths in the generic launcher. Capture each returned pane ID with `jq`, not inline Python. Do not call `subagent_resume`, send a prompt, start a model turn, or pass `--thinking` when reopening the transcript. If either surface cannot be opened, report the exact limitation in the handoff.

After the handoff and usage table are complete, set stage `done` with status `complete`. Never commit, merge, publish a ticket, remove a worktree, or delete a branch unless the user explicitly requests it. When `github.pullRequests` is true, the wrap-up stage may push the committed ticket branch and create or update the pull request. That permission is the setup answer, not a new ask on each ticket.

Keep concurrent tickets' workspaces, worktrees, prompts, sessions, and state entries isolated. One ticket's blocker must not stop another ticket.
