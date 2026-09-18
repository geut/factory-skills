---
name: factory-supervise
description: Coordinate one or more tickets inside a Herdr-managed Pi sandbox using specialist subagents, isolated worktrees, atomic factory state, usage accounting, and at most three work-review rounds. Use when starting factory orchestration in this session, not for planning, implementation, or review itself. Do not apply when the user is continuing an already-supervised ticket; those prompts resume this session by ticket id.
---

# Factory Supervise

Coordinate ticket stages without doing specialist work. Herdr owns live sessions, `.factory/` holds durable guidance, and `.factory/db/state.sqlite` holds operational state.

Read [references/runtime-protocol.md](references/runtime-protocol.md) before starting or resuming supervision.

## Establish the runtime

Derive the code root with `git rev-parse --show-toplevel` and default the factory root to `<code-root>/.factory`. Use an explicit `--factory-root` or `FACTORY_ROOT` override only when supplied. Read `<factory-root>/FACTORY.json`; obtain the ticket ID from its source or `ticketIdPattern`, asking the user when neither determines it.

Verify that:

- Pi runs in a persistent Herdr pane.
- Herdr is at least 0.8.2.
- `subagent`, `subagent_resume`, `subagent_interrupt`, and `subagents_list` are provided by `pi-herdr-subagents`.
- The extension's bundled Herdr plugin is linked and enabled.
- Node.js 24+ can run [scripts/fstate/cli.mjs](scripts/fstate/cli.mjs). Use it for every factory-state mutation; never open `.factory/db/` by hand.

If the subagent tools are absent, report the setup problem. Do not fall back to typing commands into panes, scraping terminal output, polling session files for completion, or driving roles with `herdr agent start` / `herdr agent prompt`.

Use one Herdr workspace and one isolated worktree per active ticket. The extension places child panes beside their supervisor, so each ticket has its own supervisor workspace. Never run two tickets in the same checkout. Respect `maxTickets` and `maxAgents`; queue excess work.

## Make live work legible

Rename the supervisor pane to `<ticket-id> · supervisor`. Pass a compact, unique `name` on every `subagent` and `subagent_resume` call; `pi-herdr-subagents` uses it as the child pane label:

- `<ticket-id> · plan`
- `<ticket-id> · work T<task>`
- `<ticket-id> · review T<task> R<round>`
- `<ticket-id> · wrapup`

After spawn returns a pane ID, report display-only Herdr metadata from source `factory-supervise`: `ticket`, `stage`, and, when applicable, `task` and `round`. Clear tokens that no longer apply. These are presentation hints, not lifecycle or factory state. A sidebar configured with `pane`, `$ticket`, `$stage`, `$task`, and `$round` then remains readable when tickets run in parallel. Store the pane label as `paneName` beside `paneId` in state. Call `herdr` directly for rename and `report-metadata`. Do not write `python3 -c` or a heredoc to parse Herdr JSON; for a single field, use `jq`.

## Start specialist subagents

Use the extension's asynchronous `subagent` tool. Set its overrides from `FACTORY.json` rather than maintaining model-specific agent definitions. Read each role as `{ "model", "thinking" }`. A legacy string is `{ "model": "<string>", "thinking": "medium" }`. If `thinking` is omitted, use `medium`. Always pass both `model` and `thinking` on `subagent`; omitting `thinking` makes the child inherit the supervisor's level. Do not put a `:<thinking>` suffix on the model id. Allowed levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Keep review at `medium` unless `FACTORY.json` raises it. The extension launches `pi --model <id> --thinking <level>`; do not type those flags into a pane.

- Plan: `model=models.plan.model`, `thinking=models.plan.thinking`, `skills=factory-plan`, ticket worktree as `cwd`, and only research-capable tools.
- Work: `model=models.work.model`, `thinking=models.work.thinking`, `skills=factory-work`, ticket worktree as `cwd`, and the tools needed to edit and verify code.
- Review: `model=models.review.model`, `thinking=models.review.thinking`, `skills=factory-review`, ticket worktree as `cwd`, and `tools=read,grep,find,ls`. Never `bash`, `edit`, or `write`. After work `--check` passes, run [scripts/review-packet.py](scripts/review-packet.py) once and pass only the two output paths as the reviewer task.
- Wrap-up: `model=models.wrapup.model`, `thinking=models.wrapup.thinking`, `skills=factory-wrapup`, ticket worktree as `cwd`, and the tools needed for documentation, evidence, and the Pi summary plus Fresh diff surfaces.

The reviewer model must differ from the work model. Create a subagent only when its stage is active. The spawn call returns immediately; continue independent work or end the turn and wait for the extension's steer message. Never fabricate a result or poll for one. Tell each child to end with the skill Output template and not to add a recap after it.

Use `subagent_resume` to continue the same planner after `caller_ping`, the same worker after findings, and the same reviewer during later rounds. Do not pass `thinking` on resume; the child session already has it. Use `subagent_interrupt` only to stop work that is no longer valid or explicitly exceeds a limit.

After the steer, run [scripts/pi-session-reader.py](scripts/pi-session-reader.py) **once** against the child's `sessionFile`. Do not treat steered prose as the contract. Do not poll the file, and do not write inline Python to parse Pi JSONL.

```text
python3 <skill-dir>/scripts/pi-session-reader.py contract --schema factory.plan.v3 --check <session-file>
python3 <skill-dir>/scripts/pi-session-reader.py contract --schema factory.work.v3 --check <session-file>
python3 <skill-dir>/scripts/pi-session-reader.py contract --schema factory.review.v4 --check [--round <n>] <session-file>
python3 <skill-dir>/scripts/pi-session-reader.py contract --schema factory.wrapup.v1 --check <session-file>
python3 <skill-dir>/scripts/pi-session-reader.py contract --schema factory.review.v4 --round <n> <session-file>
python3 <skill-dir>/scripts/pi-session-reader.py usage <session-file>
python3 <skill-dir>/scripts/pi-session-reader.py last-message <session-file>
python3 <skill-dir>/scripts/review-packet.py --ticket <ticket-id> --task <task-id> --worktree <worktree> --out /tmp [--round <n>] [--factory-root <factory-root>] [--base HEAD]
node <skill-dir>/scripts/fstate/cli.mjs status [--ticket <ticket-id>]
node <skill-dir>/scripts/fstate/cli.mjs create --ticket <ticket-id> --expected-revision <revision>
node <skill-dir>/scripts/fstate/cli.mjs usage record --ticket <ticket-id> --stage <stage> --session <session-file> --expected-revision <revision>
node <skill-dir>/scripts/fstate/cli.mjs transition --ticket <ticket-id> --stage <stage> --status <status> --expected-revision <revision>
```

`--check` is the stage gate (one-line `ok` / `invalid`, exit 0/3/4). Omit `--check` to print compact JSON for `fstate`. `usage` is billed tokens and cost, not steer `contextUsage`. `last-message` is diagnosis only. `review-packet.py` writes intent-and-scope files and prints `packet:` and `diff:` paths; do not compose that packet in prose. Copy `--expected-revision` from the previous `fstate` JSON `revision`. The full command list is in [references/runtime-protocol.md](references/runtime-protocol.md).

## Coordinate ticket stages

```text
plan → work → review → wrapup → done
          ↑       |
          └───────┘    changes requested; maximum three review rounds
```

At each stage boundary:

1. Run `pi-session-reader.py contract --schema … --check` once on `sessionFile`. Validate `factory.plan.v3`, `factory.work.v3`, `factory.review.v4`, or `factory.wrapup.v1`. Do not treat steered prose as the contract. Exit 0 → continue. Exit 3/4 → `subagent_resume` once with the stderr line and request only the Output template.
2. Record billed usage with `node <skill-dir>/scripts/fstate/cli.mjs usage record` (it calls `pi-session-reader.py usage`).
3. Apply one atomic ticket transition through `node <skill-dir>/scripts/fstate/cli.mjs`. For review, `review record` takes verdict / finding-count / blocking-count from `contract` without `--check`.
4. Record only meaningful progress or blockers.
5. Start or resume the next role with only the context it needs.

Stage is `plan`, `work`, `review`, `wrapup`, or `done`. Status is independently `active`, `waiting_for_user`, `blocked`, `failed`, or `complete`. Herdr lifecycle status is not ticket status, and an idle child is not proof that a stage succeeded.

When a planner calls `caller_ping`, set the ticket to `waiting_for_user`, present its question, and stop. After the user responds, return the ticket to `active` and resume the same planner session with the answer.

## Review loop

After work `--check` passes, run `review-packet.py` once against the ticket worktree. The diff is the cumulative uncommitted ticket change, including earlier approved tasks. Pass only the two output paths as the reviewer task. Do not restate outcome, acceptance criteria, file lists, or test results in the spawn prompt:

```text
Review ticket PROJ-14 task 01 round 1. Follow factory-review.
Packet: /tmp/PROJ-14-T01-R1-packet.md
Diff: /tmp/PROJ-14-T01-R1.diff
End with the factory.review.v4 Output template only.
```

On review completion, run `pi-session-reader.py contract --schema factory.review.v4 --check --round <n>` once. If that fails, resume the reviewer once with the stderr line and request only the Output template. Do not create a review archive. Do not ask for a JSON object.

Relay blocking findings to the existing work session as the parsed Findings list (`R{round}-{n}`, location, finding, suggestion), not the whole review. Validate the worker with `contract --schema factory.work.v3 --check`, including a disposition and evidence for each finding, then rerun `review-packet.py` and resume the same reviewer with the new packet and diff paths. Stop when:

- The reviewer approves with no blocking findings (`critical` or `major`).
- Three review rounds have completed.
- A role reports a genuine blocker requiring the user.

After round three, unresolved blocking findings set the ticket to `waiting_for_user`. Never begin a fourth round without explicit authorization.

The supervisor is the default arbiter: it enforces Output templates, identity, ordering, limits, and evidence relay without overruling technical judgment. If work and review explicitly disagree, it may make one bounded `subagent` call using `models.arbiter.model` and `models.arbiter.thinking` (default `medium`) with only the disputed findings and evidence. Otherwise ask the user rather than paying for another full review.

After approval, set the task to `done`, reset its review counter, and choose the next `pending` task whose dependencies are all `done`. Start wrap-up only after every required task is `done` and required checks pass.

## Finish

Validate the wrap-up handoff with `contract --schema factory.wrapup.v1 --check`, record its usage with `pi-session-reader.py usage`, and render the final all-stage table described in [../factory-wrapup/references/usage-table.md](../factory-wrapup/references/usage-table.md). Include the table in the supervisor's user-facing completion message. Do not create a handoff artifact solely to carry it.

`pi-herdr-subagents` closes a child pane after clean completion. Once the wrap-up result has been steered back, follow [../factory-wrapup/references/panes-handoff.md](../factory-wrapup/references/panes-handoff.md) to open two human-facing panes with its generic argv launcher and leave them open:

- `<ticket-id> · summary` reopens the completed wrap-up Pi session with `pi --session` and no prompt.
- `<ticket-id> · diff` opens Fresh in the worktree and runs the working-tree `Review Diff` command.

Use absolute executable, session, and script paths in the generic launcher. Capture each returned pane ID with `jq`, not inline Python. Reopening the transcript must not call `subagent_resume`, send a prompt, start a model turn, or pass `--thinking`. If either surface cannot be opened, report the exact limitation in the handoff rather than hiding it.

After the handoff and usage table are complete, set stage `done` with status `complete`. Never commit, merge, push, open a pull request, publish a ticket, remove a worktree, or delete a branch unless the user explicitly requests it.

Keep concurrent tickets' workspaces, worktrees, prompts, sessions, and state entries isolated. One ticket's blocker must not stop another ticket.
