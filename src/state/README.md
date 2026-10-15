# Controller state

This directory is the persistence boundary for the deterministic factory controller. The SQLite database at `<factory-root>/db/state.sqlite` is authoritative. Dashboard reads use the SQL views below. The controller does not write a JSON state file.

The schema is version 4. A read-write open upgrades a schema 3 database in place with the forward-only steps in [`upgrades.ts`](upgrades.ts). A read-only open of an older database fails until something opens it read-write once. Databases older than schema 3, and legacy databases with the old `meta` table, are rejected with a message telling the operator to back them up or remove them.

## Model

| Table                                     | Purpose                                                            |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `tickets`                                 | Stable external ticket identity and source.                        |
| `ticket_executions`                       | Explicit rerun generations and the current workflow state.         |
| `tasks`, `task_dependencies`              | Ordered plan slices and their ready frontier.                      |
| `agent_sessions`                          | Logical Pi conversations. A resumed agent reuses its session.      |
| `agent_runs`                              | One Herdr pane/process attempt. A resume creates a new run.        |
| `attention_requests`, `attention_replies` | Durable questions and versioned answers.                           |
| `actions`                                 | Transactional outbox leased by the runtime dispatcher.             |
| `events`                                  | Deduplicated inputs and a monotonic dashboard/change cursor.       |
| `validation_runs`, `validation_checks`    | Checks for a finished run. A pass does not require a result hash.  |
| `usage_snapshots`                         | Cumulative Pi usage plus per-run deltas.                           |
| `server_lease`                            | The factory server that owns the database, its URL, and heartbeat. |

Accepted stage output is stored on `agent_runs.result_json`. Review findings do not need a separate audit tree in v0; the normalized review result stays with the review run and the latest verdict/counts are projected onto its task.

## Guardrails

- Repeating `start` returns the existing current execution. The partial unique index on `ticket_executions.ticket_id` is the final duplicate-start guard.
- `rerun` is explicit: first quiesce runs, tasks, actions, sessions, attention, validations, and pending events; then clear the old `is_current` flag and insert generation N+1 in one transaction. Retired generations cannot acquire new active runs or actions.
- Only one task and one child run may be active for a ticket execution in v0.
- A `subagent_done` result is only a validation candidate. It does not move a stage by itself. A passed validation requires that terminal run, at least one passed check, and no failed, errored, or skipped check. It becomes immutable with its checks. Plan acceptance is the local plan files. Work acceptance is the worktree diff and the configured commands. Neither pass requires a result hash.
- Each run accepts one terminal runtime event. Runtime and command inputs are deduplicated by stable keys.
- State changes and their required external `actions` are committed together. A worker must claim an action with a compare-and-set lease before performing its side effect. Reclaiming an expired lease may increment `attempts`; a definitive launch failure creates a new run and a new action linked by `retry_of_action_id`.
- `caller_ping` persists an attention request before notifying the user. A reply is stored before a resume action is queued. If resume fails, `/factory retry` can reuse the current stored reply.
- Review rounds live on runs as `semantic_round`; infrastructure retries get new runs without consuming another semantic round.
- Pi sessions and pane runs are separate. Resumes reuse `agent_sessions` and create new `agent_runs`.
- Token/cost totals use the latest cumulative snapshot for each session. Per-stage and per-run analysis uses stored deltas, avoiding double-counting resumed sessions.

Task dependency cycles and legal state-machine edges are controller rules. They require current database state and are intentionally checked by controller code inside `BEGIN IMMEDIATE`, rather than hidden in SQL triggers.

## Transaction boundaries

The controller should use `immediateTransaction()` for reducer operations:

1. Insert or claim the input event by `dedupe_key`.
2. Load the current execution and compare its `version`.
3. Apply one legal state transition and increment the execution version.
4. Insert any next actions and domain events.
5. Mark the input event processed.
6. Commit.

The transaction callback is deliberately synchronous. Returning a Promise is rejected and rolled back; external work happens only after the state transaction commits.

The global `events.revision` is an observation cursor only. Parallel tickets do not share a write revision.

Action execution happens after commit. A dispatcher claims one pending action with a lease, performs the Herdr or external operation, then records success or failure in another transaction. An expired launch lease must be reconciled with Herdr before retrying; it must never blindly create a second pane.

## Useful views

- `current_ticket_executions`: dashboard rows for every ticket's current generation.
- `ready_task_frontier`: pending tasks whose dependencies are done.
- `open_attention`: questions or approvals still requiring resolution.
- `latest_usage_by_session`: the cumulative record to use for totals.
- `execution_usage_totals`: ticket-generation token and cost totals.
- `execution_usage_by_stage`: stage totals built from per-run deltas.

## Opening the database

```js
import { openStateDatabase } from './src/state/database.ts';

const db = openStateDatabase('/absolute/project/.factory', { create: true });
// Run narrow statements or one controller transaction.
db.close();
```

A new schema version adds its tables to `schema.sql` and an additive step to `upgrades.ts`; a test checks that an upgraded database and a new one have the same tables and columns. Stage names are not constrained by the schema; the store checks them against the stage registry when it reads rows ([ADR-002](../../docs/adr/0002-stage-names-live-in-the-registry.md)).

The opener enables foreign keys, WAL, and a five-second busy timeout. It publishes SQLite `application_id` `FACT`, `user_version`, and `schema_meta` in one schema transaction. Concurrent creators converge on that transaction. Only an empty SQLite file can be initialized; legacy, partial, and unrelated databases are rejected without modification.
