# Factory Skills

A small set of [Pi](https://github.com/earendil-works/pi) skills for running a budget-aware software factory inside the [sbx-shell-pi factory image](https://github.com/geut/sbx-shell-pi).

The factory turns one ticket into a researched plan, dependency-ordered issues, tested code, a bounded adversarial review, and a human-ready pull-request handoff. It favors the shortest clear solution that satisfies the task: no speculative infrastructure, no unlimited review loops, and no automatic publishing.

## Status

This repository contains the v0 skills and their contracts. The fully supervised flow also expects a `factory-state` executable for atomic `FACTORY-STATE.json` updates. That executable is specified by `factory-supervise` but is not implemented here yet. Until it exists, use the manual workflow below or invoke individual skills directly.

Review details remain in Pi sessions in v0. The company state keeps the verdict, round count, usage, and unresolved-blocker status; long-term review archives are intentionally deferred.

## Skills

| Skill | Responsibility | Main output |
| --- | --- | --- |
| `factory-supervise` | Coordinates Herdr workspaces, Pi role sessions, worktrees, state, budgets, and the review loop. | A factory advanced safely through its lifecycle. |
| `factory-plan` | Researches one ticket, resolves material uncertainty, and creates the smallest executable plan. | `plan.md`, optional `adr.md`, numbered issue files, and `factory.plan.v1` JSON. |
| `factory-work` | Implements one ready issue using a small design sketch, behavior-first tests, and a type-specific playbook. | Tests, code, verification evidence, and `factory.work.v1` JSON. |
| `factory-review` | Reviews an implementation adversarially from a different, read-only model session. | `factory.review.v1` findings and verdict JSON. |
| `factory-wrapup` | Updates durable knowledge and prepares the change for human PR submission. | PR summary, artifact list, test evidence, and progressive explanations. |
| `factory-reflect` | Finds reusable lessons and evaluates proposed skill or tooling improvements. | Human-approved learning and improvement proposals. |

The work playbooks cover bugs, features, performance changes, refactors, and investigations. Reflection is not part of every ticket; use it after meaningful corrections, expensive failures, or repeated patterns.

## Requirements

The intended runtime is one persistent sandbox per company:

- The `ghcr.io/geut/sbx-shell-pi:node-24-factory` image, with Pi, Herdr, and the Herdr Pi integration.
- A Git repository for the product code. Concurrent factories use separate worktrees.
- A durable company directory, which may be inside or beside the code repository and does not need to be Git-tracked.
- Two configured Pi models at minimum: a work model and a different review model.
- The `factory-state` CLI for the supervised workflow.

Matt Pocock's [`grill-with-docs`, `to-spec`, and `to-tickets`](https://github.com/mattpocock/skills) are optional but recommended. `factory-plan` reuses their interview, synthesis, and slicing mechanics while overriding their destinations: factory documents stay local and nothing is published to an issue tracker.

The architecture and review behavior are simplified, budget-conscious adaptations of ideas from [pstack](https://github.com/cursor/plugins/tree/main/pstack).

## Install the skills

Pi discovers recursive `SKILL.md` files from package `skills/` directories. Once this repository is published, install it globally inside the factory sandbox:

```sh
pi install git:github.com/geut/factory-skills
```

Pin a tag or commit for reproducible factory images:

```sh
pi install git:github.com/geut/factory-skills@<tag-or-commit>
```

For local development, link the individual skill directories into Pi's global skill directory:

```sh
mkdir -p ~/.pi/agent/skills
for skill_dir in /path/to/factory-skills/skills/*; do
  ln -s "$skill_dir" ~/.pi/agent/skills/"$(basename "$skill_dir")"
done
```

Start a new Pi session after installing or changing skills. Invoke a skill explicitly with `/skill:<name>`; Pi may also select a skill from its description when appropriate.

## Company layout

The durable factory documents are deliberately small:

```text
<company>/
├── CONTEXT.md
├── FACTORY.json
├── FACTORY-STATE.json
├── PRD.md                         # optional
├── factories/
│   └── issue-PROJ-123/
│       ├── plan.md
│       ├── adr.md                 # optional
│       ├── 01-issue-foundation.md
│       └── 02-issue-behavior.md
└── learnings/                     # created only for reusable findings
```

Code and tests live in the code repository or its factory worktree. Agent conversations, detailed reviews, handoffs, and wrap-up visuals remain in Herdr/Pi sessions unless explicitly promoted to durable project documentation.

## First-time configuration

`FACTORY.json` contains machine-readable company defaults. Keep company and domain prose in `CONTEXT.md`.

```json
{
  "schemaVersion": 1,
  "companyRoot": "/workspace/acme/factory",
  "codeRoot": "/workspace/acme/code",
  "factoryNamePattern": "issue-<ticket-id>",
  "models": {
    "plan": "provider/planning-model",
    "work": "provider/work-model",
    "review": "other-provider-or-model/review-model",
    "wrapup": "provider/wrapup-model",
    "arbiter": null
  },
  "limits": {
    "maxFactories": 2,
    "maxAgents": 4,
    "reviewRounds": 3
  }
}
```

Replace the example paths and model identifiers. `models.review` must differ from `models.work`. Review rounds may be configured below three; a fourth round always requires explicit human authorization.

The first supervised invocation can create missing company configuration, but it must ask for the roots, ticket naming convention, models, and concurrency limit rather than inventing them.

## Kick off a new ticket

### 1. Enter the company sandbox

```sh
sbx run -t ghcr.io/geut/sbx-shell-pi:node-24-factory shell <project-directory>
```

The factory image opens Herdr. Start Pi in the initial pane if it is not already running.

### 2. Start with a planning gate

In the supervisor Pi session:

```text
/skill:factory-supervise

Start a new factory for ticket PROJ-123.
Ticket: <ticket URL or full ticket text>
Company root: /workspace/acme/factory
Code root: /workspace/acme/code

Run the planning stage, then stop so I can review plan.md and the issue breakdown.
```

The supervisor should create or reuse the factory workspace, launch the planning role, and produce:

```text
factories/issue-PROJ-123/plan.md
factories/issue-PROJ-123/01-issue-<name>.md
factories/issue-PROJ-123/02-issue-<name>.md
```

`adr.md` is created only when the ticket produces a consequential, hard-to-reverse architectural decision.

### 3. Review the plan and continue

After checking the scope, user stories, acceptance criteria, and dependency edges, tell the same supervisor session:

```text
Continue factory issue-PROJ-123 through work, review, and wrap-up.
Pause for unresolved product decisions, genuine blockers, or review findings
that remain blocking after the third round.
```

The supervisor works the ready issue frontier. Each issue moves through work and review before dependent issues become eligible. Wrap-up starts only after all required issues are approved.

Issue files use one status lifecycle: `ready` → `working` → `ready_for_review` → `done`, with `blocked` available when progress cannot continue.

For a small, well-understood ticket, the initial prompt may authorize the complete flow instead of stopping after planning. The planning gate is recommended while the skills are being evaluated.

## Manual v0 workflow

Until `factory-state` is available, run the roles explicitly in separate Herdr tabs:

1. Planning tab:

   ```text
   /skill:factory-plan Plan ticket PROJ-123 from <URL or ticket text>.
   Company root: <path>. Code root: <path>.
   ```

2. For each dependency-ready issue, work tab:

   ```text
   /skill:factory-work Implement issue 01 from factory issue-PROJ-123.
   ```

3. Start a fresh Pi reviewer tab with a different model and read-only tools, then prompt:

   ```text
   /skill:factory-review Review issue 01 from factory issue-PROJ-123.
   Use the issue, current diff, surrounding code, and supplied test evidence.
   ```

4. Relay blocking findings to the work tab. Return the work response and updated diff to the same reviewer tab. Stop after approval or three review rounds.
5. Repeat for the next ready issue.
6. After all issues approve, run:

   ```text
   /skill:factory-wrapup Prepare factory issue-PROJ-123 for human PR submission.
   ```

7. Run `/skill:factory-reflect` only if the factory produced a reusable lesson worth evaluating.

The reviewer returns JSON only and never edits code. The human remains responsible for committing, pushing, and opening the pull request.

## Review outcomes

- `approve`: no findings remain; the issue may become `done`.
- `changes_requested`: blocking findings return to the existing work session.
- `blocked`: the review lacks required evidence, model independence, or read-only isolation.
- `awaiting_human`: blocking findings remain after three rounds or require a product decision.

The supervisor enforces schemas and loop limits but does not overrule technical judgment. An optional arbiter model may receive one bounded dispute-only prompt; it does not perform another full review.

## What the factory does not do

- It does not commit, push, publish tickets, or open pull requests.
- It does not create an ADR for every ticket.
- It does not persist detailed review transcripts in the company directory.
- It does not run more than three unattended review rounds.
- It does not treat an idle agent as proof that a stage succeeded.
- It does not automatically rewrite or install improved skills.
