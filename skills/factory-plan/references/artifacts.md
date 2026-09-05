# Planning artifacts

Persist only durable guidance:

```text
<company>/
├── CONTEXT.md
├── FACTORY.json
├── FACTORY-STATE.json
├── PRD.md                         # optional
└── factories/<factory-id>/
    ├── plan.md
    ├── adr.md                     # optional
    ├── 01-issue-<slug>.md
    └── 02-issue-<slug>.md
```

## `plan.md`

Use the sections that carry information; omit empty ceremony.

```markdown
# <task title>

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

## Issue map
Numbered issues, their outcomes, and blocking edges.

## Risks and open questions
Only unresolved items that could change the work.

## Discoveries
New information learned during implementation that changed this plan.
```

`plan.md` is the living guide. Later agents update `Discoveries`, scope, or the issue map when evidence changes the plan; they explain the change rather than silently drifting.

## Issue file

Number files in dependency order. Keep one issue per file.

```markdown
# <issue title>

Status: ready
Type: bug | feature | performance | refactor | investigation
Blocked by: none | <issue numbers>

## User story
As <actor>, I want <behavior>, so that <benefit>.

## Outcome
The independently observable result this issue delivers.

## Scope
What belongs in this issue and what explicitly does not.

## Acceptance criteria
- [ ] Observable, testable behavior.

## Verification
Expected unit/integration seam and relevant end-to-end story. If E2E automation is not feasible, state why and give a human verification path.

## Context
Only evidence and constraints the work agent would otherwise have to rediscover.
```

Issue status uses one lifecycle vocabulary:

```text
ready → working → ready_for_review → done
          └────────────────────────→ blocked
```

`ready_for_review` means implementation and its claimed verification are complete enough for independent review. Only review approval moves an issue to `done`.

Do not predesign implementation in the issue unless a constraint or agreed contract makes it necessary.

## `adr.md`

Create lazily. For each qualifying decision record context, decision, alternatives, and consequences. Reversible implementation choices belong in `plan.md`, not here.
