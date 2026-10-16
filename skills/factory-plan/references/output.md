# Planning output

Use this template (`factory.plan.v3`) as a model for the reply that hands the plan off. It is a suggestion: the plan is accepted from its files, when `plan.md` exists and at least one task file is defined, whatever the reply says. No JSON object, no Markdown fence around the whole result, no recap after it.

```markdown
## Status

planned | blocked

## Artifacts

- plan: .factory/tickets/PROJ-123/plan.md
- adr: none
- tasks:
  - 01: .factory/tickets/PROJ-123/01-task-foundation.md (pending, blockedBy none)

## Ready

01

## Assumptions

- none

## Blocker

none
```

`Status` is `planned` or `blocked`. A blocked result must name the unresolved decision or missing evidence under `Blocker`; it may list partial artifact paths but must not advertise a ready task frontier. Use `none` for empty optional fields.

After the template, call `subagent_done` and emit nothing else. `caller_ping` is the only other terminal call, and it replaces the template when you need a decision.
