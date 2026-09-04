# Runtime protocol

## Configuration

`FACTORY.json` is machine-readable company configuration. Keep prose in `CONTEXT.md`.

```json
{
  "schemaVersion": 1,
  "companyRoot": "/workspace/company",
  "codeRoot": "/workspace/code",
  "factoryNamePattern": "issue-<ticket-id>",
  "models": {
    "plan": "provider/model",
    "work": "provider/model",
    "review": "different-provider-or-model/model",
    "wrapup": "provider/model",
    "arbiter": null
  },
  "limits": {
    "maxFactories": 2,
    "maxAgents": 4,
    "reviewRounds": 3
  }
}
```

Company configuration may add budgets and project-specific commands. `reviewRounds` may be lower than three. Raising it above three requires a user-approved run and must not become the unattended default.

## State ownership

`FACTORY-STATE.json` is authoritative for factory phase, status, current issue, latest meaningful message, blockers, role session references, per-issue review round, and usage by stage. Specialist agents never edit it directly; the supervisor is the single semantic writer and uses the state CLI for every mutation.

Expected `factory-state` operations:

```text
factory-state create
factory-state status
factory-state transition
factory-state message
factory-state block
factory-state unblock
factory-state usage
factory-state validate
```

Each mutation must acquire an exclusive lock, validate the schema and expected revision, write a temporary file in the same directory, and atomically rename it. Atomic rename without locking is insufficient because concurrent writers can lose updates.

Herdr's `working`, `idle`, `done`, and `blocked` values describe agent lifecycle. Factory phase describes domain progress. Keep them separate.

## Session relay

Use Herdr for lifecycle, prompt delivery, and native Pi session identity. Use the Pi session JSONL for structured assistant messages and usage. Terminal reads are a diagnostic fallback, not the structured source of truth.

Persist verdict, round count, usage, and unresolved blocker status in company state. Detailed findings remain in Pi sessions for v0. Long-term review audit artifacts are deliberately deferred.

## Recovery

On resume:

1. Validate factory state and its revision.
2. Reconcile recorded Herdr workspace, worktree, and Pi session references with live state.
3. Resume current sessions where possible.
4. If a recorded transition lacks a valid structured stage result, return to the prior safe phase and report the recovery action.

Never interpret an idle session as proof that code, review, or wrap-up succeeded.
