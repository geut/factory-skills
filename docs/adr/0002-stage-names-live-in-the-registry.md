# ADR-002: Stage names live in the stage registry, not in schema CHECKs

- **Status:** Accepted, lands with the input-preparation migration of the stage refactor
- **Date:** 2026-10-11
- **Builds on:** [ADR-001](../../ADR.md)

The SQLite schema used to list every stage name in CHECK constraints (executions, sessions, and the rule that per-task sessions have a task). That duplicated the stage registry: adding a stage, even an optional one like QA, meant a schema migration plus about fifteen edits across the controller. We dropped those constraints. The store now validates stage names against the stage registry when it reads rows, and it enforces the task rule by reading each stage's `scope` from the registry. The database stays the source of truth for what happened, while the registry is the only source of truth for which stages exist.

## Consequences

- A new stage needs no migration. A row whose stage the registry does not know (for example, after a stage is removed) fails loudly when it is read, not when it is written.
- Do not add stage-name CHECKs back "for safety". Change the registry and the store's read-time check instead.
- CHECKs that do not name stages (statuses, kinds, ordinals) stay in the schema.
