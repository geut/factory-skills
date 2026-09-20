# Runtime protocol

## Configuration

`.factory/FACTORY.json` contains portable machine configuration. Keep project and domain prose in `.factory/CONTEXT.md`.

```json
{
  "schemaVersion": 2,
  "ticketIdPattern": "PROJ-<number>",
  "models": {
    "plan": { "model": "provider/model", "thinking": "medium" },
    "work": { "model": "provider/model", "thinking": "medium" },
    "review": { "model": "different-provider-or-model/model", "thinking": "medium" },
    "wrapup": { "model": "provider/model", "thinking": "medium" },
    "arbiter": null
  },
  "limits": {
    "maxTickets": 2,
    "maxAgents": 4,
    "reviewRounds": 3
  }
}
```

Each `models` role is `{ "model": "provider/id", "thinking": "medium" }`. `thinking` is optional and defaults to `medium`. A legacy string value remains valid and means that object with `thinking` `medium`. Allowed `thinking` values are Pi's: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Do not append `:<thinking>` to the model id. When `arbiter` is set, it uses the same object shape. Keep review at `medium` unless the project raises it; `max` is an expensive failure mode for adversarial review.

Derive the code root from Git and the factory root as `<code-root>/.factory`. Do not persist those absolute paths in configuration. An explicit `--factory-root` or `FACTORY_ROOT` override may select an external root; resolve a relative value from the code root.

Configuration may add budgets and project-specific verification commands. `reviewRounds` may be lower than three. A higher value requires explicit authorization for that run and must not become the unattended default.

## State ownership

`.factory/db/state.sqlite` is authoritative for all active and completed tickets. Tickets are rows keyed by ID so concurrent tickets do not overwrite one another. `fstate status` reconstructs this nested JSON view for agents; dashboards should query the database instead of parsing JSON files.

```json
{
  "schemaVersion": 3,
  "revision": 7,
  "updatedAt": "2026-09-11T15:20:10Z",
  "tickets": {
    "PROJ-123": {
      "title": "Restore the saved catalog filter",
      "type": "feature",
      "source": {
        "kind": "github",
        "ref": "https://github.example/org/repo/issues/123"
      },
      "stage": "review",
      "status": "active",
      "currentTask": "01",
      "message": "Review task 01 completed; validating the result.",
      "messageAt": "2026-09-11T15:20:10Z",
      "blocker": null,
      "createdAt": "2026-09-11T13:10:00Z",
      "updatedAt": "2026-09-11T15:20:10Z",
      "worktree": {
        "path": "/runtime/worktrees/PROJ-123",
        "branch": "PROJ-123",
        "baseBranch": "main",
        "workspaceId": "w2"
      },
      "tasks": {
        "01": {
          "status": "ready_for_review",
          "blockedBy": [],
          "review": {
            "round": 1,
            "verdict": null,
            "findingCount": null,
            "blockingCount": null,
            "updatedAt": null
          },
          "updatedAt": "2026-09-11T15:03:40Z"
        }
      },
      "sessions": {
        "<pi-session-id>": {
          "stage": "review",
          "task": "01",
          "round": 1,
          "model": "provider/review-model",
          "paneId": "p4",
          "paneName": "PROJ-123 · review T01 R1",
          "sessionFile": "/runtime/pi/session.jsonl",
          "status": "completed",
          "context": {
            "tokens": 12450,
            "window": 200000,
            "percent": 6.2
          },
          "startedAt": "2026-09-11T15:04:05Z",
          "updatedAt": "2026-09-11T15:20:10Z"
        }
      },
      "usage": {
        "<pi-session-id>": {
          "stage": "review",
          "task": "01",
          "round": 1,
          "model": "provider/review-model",
          "throughEntryId": "entry-42",
          "tokens": {
            "input": 28,
            "output": 6900,
            "cacheRead": 135000,
            "cacheWrite": 22000,
            "total": 163928
          },
          "costUsd": 0.754,
          "recordedAt": "2026-09-11T15:20:10Z"
        }
      }
    }
  }
}
```

Specialist agents never edit state directly. The supervisor is the semantic writer and uses the bundled CLI for every mutation:

```text
node <skill-dir>/scripts/fstate/cli.mjs <command> …
```

Expected operations include the ticket identifier and expected revision on every mutation. Copy `--expected-revision` from the JSON `revision` printed by the previous successful mutation. Pass `--factory-root` or set `FACTORY_ROOT` only when the factory root is not `<code-root>/.factory`. Never open `.factory/db/` by hand. `help` (or `--help`) prints a JSON catalog of commands, flags, and enum values and does not open the store.

```text
node <skill-dir>/scripts/fstate/cli.mjs help [command]
node <skill-dir>/scripts/fstate/cli.mjs create --ticket <ticket-id> [--title <title>] [--type <type>] [--source-kind <kind>] [--source-ref <ref>] [--worktree-path <path>] [--branch <branch>] [--base-branch <branch>] [--workspace-id <id>] --expected-revision <revision>
node <skill-dir>/scripts/fstate/cli.mjs status [--ticket <ticket-id>]
node <skill-dir>/scripts/fstate/cli.mjs transition --ticket <ticket-id> --stage <stage> --status <status> --expected-revision <revision>
node <skill-dir>/scripts/fstate/cli.mjs task transition --ticket <ticket-id> --task <task-id> --status <status> --expected-revision <revision>
node <skill-dir>/scripts/fstate/cli.mjs review record --ticket <ticket-id> --task <task-id> --round <n> --verdict <verdict> --finding-count <n> --blocking-count <n> --expected-revision <revision>
node <skill-dir>/scripts/fstate/cli.mjs session record --ticket <ticket-id> --session-id <id> --session <session-file> --stage <stage> --status <status> [--task <task-id>] [--round <n>] [--pane <pane-id>] [--pane-name <label>] --expected-revision <revision>
node <skill-dir>/scripts/fstate/cli.mjs message --ticket <ticket-id> --text <message> --expected-revision <revision>
node <skill-dir>/scripts/fstate/cli.mjs block --ticket <ticket-id> --reason <reason> [--owner user|agent|external] [--task <task-id>] --expected-revision <revision>
node <skill-dir>/scripts/fstate/cli.mjs unblock --ticket <ticket-id> --expected-revision <revision>
node <skill-dir>/scripts/fstate/cli.mjs usage record --ticket <ticket-id> --stage <stage> --session <session-file> [--task <task-id>] [--round <n>] --expected-revision <revision>
node <skill-dir>/scripts/fstate/cli.mjs usage show [--ticket <ticket-id>] [--stage <stage>]
node <skill-dir>/scripts/fstate/cli.mjs validate
node <skill-dir>/scripts/fstate/cli.mjs server [--host 127.0.0.1] [--port 8787]
```

Every mutation opens a `BEGIN IMMEDIATE` transaction, checks the expected revision, writes the snapshot tables, appends an `events` row, and commits. WAL mode lets readers query while a writer holds the transaction.

Every successful mutation increments `revision`, updates the top-level and affected ticket `updatedAt` values, and updates the narrower task, session, message, or usage timestamp when applicable. Use UTC RFC 3339 timestamps. `message` is only the latest meaningful update, not a transcript. When blocked, store `blocker` as an object containing `reason`, `since`, `owner` (`user`, `agent`, or `external`), and optional `task`; clear it on unblock.

## Dashboard consumers and parallel tickets

The ticket tables are sufficient for a dashboard and for several tickets advancing independently. `FACTORY.json` and the SQLite store have independent schema versions; the domain state shape is version 3 and `storageVersion` is 1. A consumer should:

- Open `.factory/db/state.sqlite` read-only. Do not write. WAL sidecars stay in `.factory/db/`.
- Treat `meta.revision` as the change cursor and `meta.schemaVersion` as the compatibility boundary.
- Render each ticket independently from `stage`, `status`, `current_task`, task review summary, `message`, `blockers`, and timestamps.
- Use session `pane_name` for display and `pane_id` plus `worktree_workspace_id` only for live navigation; pane IDs may become stale after a process closes.
- Treat missing optional metadata as unknown rather than as a zero or empty value.
- For live updates, run `fstate server` (default `127.0.0.1:8787`) and subscribe to `GET /events`. Cold connect without a cursor receives `event: hello` with the current revision. `Last-Event-ID` or `?after=` replays later `events` rows. After each event, re-query SQLite; the SSE payload is a compact `{ revision, op, ticket, task, payload }`, not a full snapshot.

`scripts/fstate/cli.mjs` imports a leftover version 2 JSON file under the same transaction protocol; unknown historical values remain `null` rather than being invented. The `events` table is the append-only history.

## Vocabulary and contracts

- Ticket stage: `plan`, `work`, `review`, `wrapup`, or `done`.
- Ticket status: `active`, `waiting_for_user`, `blocked`, `failed`, or `complete`.
- Task status: `pending`, `in_progress`, `ready_for_review`, `done`, or `blocked`.
- Session status: `starting`, `running`, `waiting_for_user`, `completed`, `failed`, or `closed`.
- Plan returns a `factory.plan.v3` markdown Output template with status `planned` or `blocked`.
- Work returns a `factory.work.v3` markdown Output template with status `ready_for_review` or `blocked`.
- Review returns a `factory.review.v4` markdown findings list with verdict `approve`, `changes_requested`, or `blocked`.
- Wrap-up returns a `factory.wrapup.v1` markdown Output template with the required handoff headings.

`ready_for_review` is the only successful work-stage task status. Do not introduce `implemented` as an alias. Dependencies determine the executable task frontier independently of status.

Herdr's agent lifecycle describes a process. Ticket stage and status describe domain progress. Keep them separate.

## Herdr display metadata

`pi-herdr-subagents` applies the supplied subagent `name` as the pane label. After each spawn or resume, report the returned pane's display tokens with one call per value:

```text
herdr pane report-metadata <pane-id> --source factory-supervise --token ticket=<ticket-id>
herdr pane report-metadata <pane-id> --source factory-supervise --token stage=<stage>
herdr pane report-metadata <pane-id> --source factory-supervise --token task=<task-id>
herdr pane report-metadata <pane-id> --source factory-supervise --token round=<round>
```

Omit or clear `task` and `round` when they do not apply. Do not use `report-agent` for these fields: the Pi integration and Herdr own lifecycle state, while this metadata is display-only. Token names are available to Herdr sidebar rows as `$ticket`, `$stage`, `$task`, and `$round`.

## Subagent relay

Use `pi-herdr-subagents` for launch, completion, prompt delivery, and Pi session identity:

1. Call `subagent` with explicit `name`, `model`, `thinking`, `skills`, `tools`, and `cwd` overrides. Resolve `model` and `thinking` from `FACTORY.json` as above; always pass `thinking` (default `medium`). Omitting `thinking` inherits the parent session's level. For review, pass `tools=read,grep,find,ls`; never `bash`, `edit`, or `write`. Do not pass `thinking` on `subagent_resume`.
2. Retain the returned `sessionFile`, Pi session ID, pane ID, pane name, and role in state.
3. Wait for the automatic steer message; never poll terminals or session files for completion.
4. Run `scripts/pi-session-reader.py contract --schema <factory.plan.v3|factory.work.v3|factory.review.v4|factory.wrapup.v1> --check` once against `sessionFile`. Do not treat steered prose as the contract. Do not write inline Python to parse Pi JSONL. Exit 3/4: `subagent_resume` once with the stderr line; request only the Output template, never a JSON object. Exit 0: print compact JSON (omit `--check`) when `fstate` needs fields such as verdict and finding counts.
5. Before spawning or resuming review, run `scripts/review-packet.py` once and pass only the printed `packet:` and `diff:` paths. The diff is the cumulative uncommitted ticket worktree change.
6. Continue a role with `subagent_resume` rather than starting a replacement session.

`caller_ping` means the child needs user or supervisor input. It is not a failure. Set `waiting_for_user`, surface the exact question, and resume the same session after an answer.

Persist verdict, round count, usage, and unresolved blockers. Detailed findings remain in Pi sessions for v0.

## Usage collection

Store numbers, not display strings such as `in 28 / out 6.9k`. Do not persist `cacheHit`; derive it for display only when its formula is defined.

The completion steer from current `pi-herdr-subagents` may include `details.contextUsage` with `tokens`, `contextWindow`, and `percent`. This is current context occupancy, not cumulative model usage or billed tokens. Store it under the matching session's optional `context` object for diagnostics, mapping `contextWindow` to `window`; never copy it into `usage.tokens.total`.

At every stage boundary and before a session is abandoned, collect billed usage with a single read:

```text
python3 <skill-dir>/scripts/pi-session-reader.py usage <session-file>
```

Then persist that JSON through:

```text
node <skill-dir>/scripts/fstate/cli.mjs usage record --ticket <ticket-id> --stage <stage> --session <session-file> [--task <task-id>] [--round <n>] --expected-revision <revision>
```

`usage record` calls this reader rather than inventing a second parser. A later `fstate` may call Pi's session statistics API instead.

The reader walks the active `parentId` branch of the append-only Pi JSONL and sums Pi's numeric usage records, including assistant messages and any compaction or branch-summary entries Pi counts in its own session totals. Preserve Pi's reported `totalTokens` when available and sum `cost.total` as `costUsd`; do not estimate prices locally. If a later subagent extension version adds cumulative numeric usage to the structured steer, prefer that payload after validating its version and session identity.

Usage is keyed by Pi session ID. Recording is an idempotent replacement of that session's cumulative values through `throughEntryId`, not an increment. A resumed session therefore updates one record instead of double-counting earlier turns. `factory-state usage show` derives per-stage, per-task, per-model, per-ticket, and total summaries from these records.

## Recovery

On resume:

1. Validate state and its revision.
2. Reconcile the ticket's Herdr workspace, worktree, and Pi session references with live state.
3. Resume current sessions where possible.
4. If a recorded transition lacks a valid structured stage result (Output template), return to the prior safe stage and report the recovery action.

Never interpret an idle or closed session as proof that plan, work, review, or wrap-up succeeded.
