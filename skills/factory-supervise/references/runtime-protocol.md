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
  "schemaVersion": 2,
  "revision": 7,
  "tickets": {
    "PROJ-123": {
      "stage": "review",
      "status": "active",
      "currentTask": "01",
      "message": "Reviewing task 01, round 1.",
      "blocker": null,
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
          "reviewRound": 1
        }
      },
      "sessions": {
        "<pi-session-id>": {
          "stage": "review",
          "task": "01",
          "model": "provider/review-model",
          "paneId": "p4",
          "sessionFile": "/runtime/pi/session.jsonl",
          "status": "completed"
        }
      },
      "usage": {
        "<pi-session-id>": {
          "stage": "review",
          "task": "01",
          "model": "provider/review-model",
          "throughEntryId": "entry-42",
          "tokens": {
            "input": 28,
            "output": 6900,
            "cacheRead": 135000,
            "cacheWrite": 22000,
            "total": 163928
          },
          "costUsd": 0.754
        }
      }
    }
  }
}
```

Specialist agents never edit state directly. The supervisor is the semantic writer and uses `factory-state` for every mutation.

Expected operations include the ticket identifier and expected revision on every mutation:

```text
factory-state create --ticket <ticket-id> --expected-revision <revision>
factory-state status [--ticket <ticket-id>]
factory-state transition --ticket <ticket-id> --stage <stage> --status <status> --expected-revision <revision>
factory-state message --ticket <ticket-id> --text <message> --expected-revision <revision>
factory-state block --ticket <ticket-id> --reason <reason> --expected-revision <revision>
factory-state unblock --ticket <ticket-id> --expected-revision <revision>
factory-state usage record --ticket <ticket-id> --stage <stage> --session <session-file> --expected-revision <revision>
factory-state usage show [--ticket <ticket-id>] [--stage <stage>]
factory-state validate
```

Every mutation must acquire an exclusive lock, validate the schema and expected revision, write a temporary file in the same directory, and atomically rename it. Atomic rename without locking is insufficient because concurrent writers can lose updates.

## Vocabulary and contracts

- Ticket stage: `plan`, `work`, `review`, `wrapup`, or `done`.
- Ticket status: `active`, `waiting_for_user`, `blocked`, `failed`, or `complete`.
- Task status: `pending`, `in_progress`, `ready_for_review`, `done`, or `blocked`.
- Plan returns `factory.plan.v2` with status `planned` or `blocked`.
- Work returns `factory.work.v2` with status `ready_for_review` or `blocked`.
- Review returns `factory.review.v2` with verdict `approve`, `changes_requested`, or `blocked`.
- Wrap-up satisfies its human handoff requirements; v0 has no machine JSON envelope.

`ready_for_review` is the only successful work-stage task status. Do not introduce `implemented` as an alias. Dependencies determine the executable task frontier independently of status.

Herdr's agent lifecycle describes a process. Ticket stage and status describe domain progress. Keep them separate.

## Subagent relay

Use `pi-herdr-subagents` for launch, completion, prompt delivery, and Pi session identity:

1. Call `subagent` with explicit `model`, `skills`, `tools`, and `cwd` overrides.
2. Retain the returned `sessionFile`, Pi session ID, pane ID, and role in state.
3. Wait for the automatic steer message; never poll terminals or session files for completion.
4. Validate the returned structured assistant message.
5. Continue a role with `subagent_resume` rather than starting a replacement session.

`caller_ping` means the child needs user or supervisor input. It is not a failure. Set `waiting_for_user`, surface the exact question, and resume the same session after an answer.

Persist verdict, round count, usage, and unresolved blockers. Detailed findings remain in Pi sessions for v0.

## Usage collection

Store numbers, not display strings such as `in 28 / out 6.9k`. Do not persist `cacheHit`; derive it for display only when its formula is defined.

At every stage boundary and before a session is abandoned, run:

```text
factory-state usage record --ticket <ticket-id> --stage <stage> --session <session-file> [--task <task-id>]
```

The command should use Pi's session statistics API when available. Otherwise it must read the active branch of the append-only Pi JSONL and aggregate Pi's numeric usage records, including assistant messages and any compaction or branch-summary entries Pi counts in its own session totals. Preserve Pi's reported `totalTokens` when available and sum `cost.total` as `costUsd`; do not estimate prices locally.

Usage is keyed by Pi session ID. Recording is an idempotent replacement of that session's cumulative values through `throughEntryId`, not an increment. A resumed session therefore updates one record instead of double-counting earlier turns. `factory-state usage show` derives per-stage, per-task, per-model, per-ticket, and total summaries from these records.

## Recovery

On resume:

1. Validate state and its revision.
2. Reconcile the ticket's Herdr workspace, worktree, and Pi session references with live state.
3. Resume current sessions where possible.
4. If a recorded transition lacks a valid structured stage result, return to the prior safe stage and report the recovery action.

Never interpret an idle or closed session as proof that plan, work, review, or wrap-up succeeded.
