# Runtime protocol

## Configuration

`.factory/FACTORY.json` contains portable machine configuration. Keep project and domain prose in `.factory/CONTEXT.md`.

```json
{
  "schemaVersion": 2,
  "ticketIdPattern": "PROJ-<number>",
  "models": {
    "plan": "provider/model",
    "work": "provider/model",
    "review": "different-provider-or-model/model",
    "wrapup": "provider/model",
    "arbiter": null
  },
  "limits": {
    "maxTickets": 2,
    "maxAgents": 4,
    "reviewRounds": 3
  }
}
```

Derive the code root from Git and the factory root as `<code-root>/.factory`. Do not persist those absolute paths in configuration. An explicit `--factory-root` or `FACTORY_ROOT` override may select an external root; resolve a relative value from the code root.

Configuration may add budgets and project-specific verification commands. `reviewRounds` may be lower than three. A higher value requires explicit authorization for that run and must not become the unattended default.

## State ownership

`.factory/FACTORY-STATE.json` is authoritative for all active and completed tickets. It uses a map keyed by ticket ID so concurrent tickets do not overwrite one another:

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

Specialist agents never edit state directly. The supervisor is the semantic writer and uses `factory-state` for every mutation.

Expected operations include the ticket identifier and expected revision on every mutation:

```text
factory-state create --ticket <ticket-id> [--title <title>] [--type <type>] [--source-kind <kind>] [--source-ref <ref>] --expected-revision <revision>
factory-state status [--ticket <ticket-id>]
factory-state transition --ticket <ticket-id> --stage <stage> --status <status> --expected-revision <revision>
factory-state task transition --ticket <ticket-id> --task <task-id> --status <status> --expected-revision <revision>
factory-state review record --ticket <ticket-id> --task <task-id> --round <n> --verdict <verdict> --finding-count <n> --blocking-count <n> --expected-revision <revision>
factory-state session record --ticket <ticket-id> --session-id <id> --session <session-file> --stage <stage> --status <status> [--task <task-id>] [--round <n>] [--pane <pane-id>] [--pane-name <label>] --expected-revision <revision>
factory-state message --ticket <ticket-id> --text <message> --expected-revision <revision>
factory-state block --ticket <ticket-id> --reason <reason> --expected-revision <revision>
factory-state unblock --ticket <ticket-id> --expected-revision <revision>
factory-state usage record --ticket <ticket-id> --stage <stage> --session <session-file> [--task <task-id>] [--round <n>] --expected-revision <revision>
factory-state usage show [--ticket <ticket-id>] [--stage <stage>]
factory-state validate
```

Every mutation must acquire an exclusive lock, validate the schema and expected revision, write a temporary file in the same directory, and atomically rename it. Atomic rename without locking is insufficient because concurrent writers can lose updates.

Every successful mutation increments `revision`, updates the top-level and affected ticket `updatedAt` values, and updates the narrower task, session, message, or usage timestamp when applicable. Use UTC RFC 3339 timestamps. `message` is only the latest meaningful update, not a transcript. When blocked, store `blocker` as an object containing `reason`, `since`, `owner` (`user`, `agent`, or `external`), and optional `task`; clear it on unblock.

## Dashboard consumers and parallel tickets

The ticket map is sufficient for a v0 dashboard and for several tickets advancing independently. `FACTORY.json` and `FACTORY-STATE.json` have independent schema versions; this state shape is version 3. A consumer should:

- Read only the atomically renamed `FACTORY-STATE.json`, never lock files or temporary siblings.
- Treat `revision` as the change cursor and `schemaVersion` as the compatibility boundary.
- Render each ticket independently from `stage`, `status`, `currentTask`, task review summary, `message`, `blocker`, and its timestamps.
- Use session `paneName` for display and `paneId` plus `workspaceId` only for live navigation; pane IDs may become stale after a process closes.
- Treat missing optional metadata as unknown rather than as a zero or empty value.

State version 3 adds dashboard timestamps and ticket metadata, the nested task review summary, pane labels, and session context occupancy. A future `factory-state` implementation should migrate a version 2 file under the same lock and atomic-write protocol; unknown historical values remain `null` rather than being invented.

This file is a current-state snapshot, not an event log. The single lock will become a constraint only when writes are frequent, history/querying is required, or the file grows materially with completed tickets and sessions. Those are the signals to move operational state to SQLite; they are not blockers for parallel-ticket v0.

## Vocabulary and contracts

- Ticket stage: `plan`, `work`, `review`, `wrapup`, or `done`.
- Ticket status: `active`, `waiting_for_user`, `blocked`, `failed`, or `complete`.
- Task status: `pending`, `in_progress`, `ready_for_review`, `done`, or `blocked`.
- Session status: `starting`, `running`, `waiting_for_user`, `completed`, `failed`, or `closed`.
- Plan returns `factory.plan.v2` with status `planned` or `blocked`.
- Work returns `factory.work.v2` with status `ready_for_review` or `blocked`.
- Review returns `factory.review.v3` with verdict `approve`, `changes_requested`, or `blocked`.
- Wrap-up satisfies its human handoff requirements; v0 has no machine JSON envelope.

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

1. Call `subagent` with explicit `name`, `model`, `skills`, `tools`, and `cwd` overrides.
2. Retain the returned `sessionFile`, Pi session ID, pane ID, pane name, and role in state.
3. Wait for the automatic steer message; never poll terminals or session files for completion.
4. Validate the returned structured assistant message.
5. Continue a role with `subagent_resume` rather than starting a replacement session.

`caller_ping` means the child needs user or supervisor input. It is not a failure. Set `waiting_for_user`, surface the exact question, and resume the same session after an answer.

Persist verdict, round count, usage, and unresolved blockers. Detailed findings remain in Pi sessions for v0.

## Usage collection

Store numbers, not display strings such as `in 28 / out 6.9k`. Do not persist `cacheHit`; derive it for display only when its formula is defined.

The completion steer from current `pi-herdr-subagents` may include `details.contextUsage` with `tokens`, `contextWindow`, and `percent`. This is current context occupancy, not cumulative model usage or billed tokens. Store it under the matching session's optional `context` object for diagnostics, mapping `contextWindow` to `window`; never copy it into `usage.tokens.total`.

At every stage boundary and before a session is abandoned, run:

```text
factory-state usage record --ticket <ticket-id> --stage <stage> --session <session-file> [--task <task-id>] [--round <n>]
```

The command should use Pi's cumulative session statistics API when available. Otherwise it must read the active branch of the append-only Pi JSONL and aggregate Pi's numeric usage records, including assistant messages and any compaction or branch-summary entries Pi counts in its own session totals. Preserve Pi's reported `totalTokens` when available and sum `cost.total` as `costUsd`; do not estimate prices locally. If a later subagent extension version adds cumulative numeric usage to the structured steer, prefer that payload after validating its version and session identity.

Usage is keyed by Pi session ID. Recording is an idempotent replacement of that session's cumulative values through `throughEntryId`, not an increment. A resumed session therefore updates one record instead of double-counting earlier turns. `factory-state usage show` derives per-stage, per-task, per-model, per-ticket, and total summaries from these records.

## Recovery

On resume:

1. Validate state and its revision.
2. Reconcile the ticket's Herdr workspace, worktree, and Pi session references with live state.
3. Resume current sessions where possible.
4. If a recorded transition lacks a valid structured stage result, return to the prior safe stage and report the recovery action.

Never interpret an idle or closed session as proof that plan, work, review, or wrap-up succeeded.
