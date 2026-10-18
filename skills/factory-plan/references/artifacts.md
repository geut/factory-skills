# Planning artifacts

Persist only durable guidance:

```text
<code-root>/.factory/
├── CONTEXT.md
├── FACTORY.json
├── github.md                      # GitHub remotes only
├── triage-labels.md               # GitHub remotes only
├── db/                            # created by the factory controller
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

- A plain list of findings: what was found, and what changed because of it.
```

`plan.md` is the living guide. Later agents update `Discoveries`, scope, or the task map when evidence changes the plan; they explain the change rather than silently drifting.

`Discoveries` is a plain bullet list. Each bullet says what was found and what it changed, with no dates, rounds, or run labels:

```markdown
## Discoveries

- `git diff --check` rejected the trailing space the ticket asked for; the person chose to drop it, so `hello.md` starts with `# HELLO` and no trailing space.
```

## Task file

Name each file `<NN>-task-<slug>.md`, numbered in dependency order with no number used twice. Keep one task per file.

```markdown
---
type: feature
qa: e2e
blocked_by: []
---

# <task title>

## User story

As <actor>, I want <behavior>, so that <benefit>.

## Outcome

The independently observable result this task delivers.

## Scope

What belongs in this task and what explicitly does not.

## Acceptance criteria

- [ ] Observable, testable behavior.

One behavior per criterion. Phrase it as something a user can see in the running product when it is one: QA writes an end-to-end test for each observable criterion and lists the rest in its ledger.

The frontmatter holds exactly these three fields, and all three are required:

- `type`: one of `bug`, `feature`, `performance`, `refactor`, `investigation`.
- `qa`: whether the QA stage runs for the task when FACTORY.json enables it. Use `e2e` when at least one criterion is observable in the running product: a page, an HTTP response, a CLI's output. Use `none` when every criterion is internal, such as a data layer change covered by unit tests, documentation, an ADR, or a skill. The task then goes from work straight to review. A `none` task still lists its acceptance criteria.
- `blocked_by`: the task files this one waits for, as a list of their numbers, such as `["01", "02"]`, or `[]` when it waits for none. A number that matches no task file, the task's own number, or tasks that wait on each other fail plan validation.

Do not add other fields. The controller tracks each task's status in its own store, never in the file.

## Verification

Expected unit/integration seam and relevant end-to-end story. If E2E automation is not feasible, state why and give a human verification path.

## Context

Only evidence and constraints the worker would otherwise have to rediscover.
```

The controller moves each task through one lifecycle:

```text
pending → active (work → qa → review) → done
             └──────────────────→ blocked
```

An `active` task is at one per-task stage at a time: work, then QA when FACTORY.json enables it, then review. A failing QA test or a changes-requested verdict returns the task to work; only review approval moves it to `done`. A `blocked` task waits for a person at the stage where it stopped.

Do not predesign implementation in the task unless a constraint or agreed contract makes it necessary.

## `adr.md`

Create lazily. For each qualifying decision record context, decision, alternatives, and consequences. Reversible implementation choices belong in `plan.md`, not here.
