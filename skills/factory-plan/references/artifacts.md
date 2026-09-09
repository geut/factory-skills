# Planning artifacts

Persist only durable guidance:

```text
<code-root>/.factory/
├── CONTEXT.md
├── FACTORY.json
├── FACTORY-STATE.json
├── PRD.md                         # optional
└── tickets/<ticket-id>/
    ├── plan.md
    ├── adr.md                     # optional
    ├── 01-task-<slug>.md
    └── 02-task-<slug>.md
```

## `plan.md`

Use the sections that carry information; omit empty ceremony.

```markdown
# <ticket title>

## Outcome
What changes for the user or system, and how success is observed.

## Current behavior
Relevant evidence from the code, tests, runtime, or documents.

## Scope
Included behavior and explicit non-goals.

## Constraints
Compatibility, security, performance, operational, and budget constraints.

## Test seams
The highest existing seams that can prove the behavior. Note any missing seam.

## Task map
Numbered tasks, their outcomes, and blocking edges.

## Risks and open questions
Only unresolved items that could change the work.

## Discoveries
New information learned during implementation that changed this plan.
```

`plan.md` is the living guide. Later agents update `Discoveries`, scope, or the task map when evidence changes the plan; they explain the change rather than silently drifting.

## Task file

Number files in dependency order. Keep one task per file.

```markdown
# <task title>

Status: pending
Type: bug | feature | performance | refactor | investigation
Blocked by: none | <task numbers>

## User story
As <actor>, I want <behavior>, so that <benefit>.

## Outcome
The independently observable result this task delivers.

## Scope
What belongs in this task and what explicitly does not.

## Acceptance criteria
- [ ] Observable, testable behavior.

## Verification
Expected unit/integration seam and relevant end-to-end story. If E2E automation is not feasible, state why and give a human verification path.

## Context
Only evidence and constraints the worker would otherwise have to rediscover.
```

Task status uses one lifecycle vocabulary:

```text
pending → in_progress → ready_for_review → done
             └─────────────────────→ blocked
```

`ready_for_review` means implementation and its claimed verification are complete enough for independent review. Only review approval moves a task to `done`.

Do not predesign implementation in the task unless a constraint or agreed contract makes it necessary.

## `adr.md`

Create lazily. For each qualifying decision record context, decision, alternatives, and consequences. Reversible implementation choices belong in `plan.md`, not here.
