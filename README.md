# Factory Skills

A small set of [Pi](https://github.com/earendil-works/pi) skills for running a budget-aware software factory inside the [sbx-shell-pi factory image](https://github.com/geut/sbx-shell-pi).

The factory takes one ticket through research, a small dependency-ordered task plan, tested implementation, bounded adversarial review, and a human-ready pull-request handoff. It favors the shortest clear solution that satisfies the ticket: no speculative infrastructure, unlimited review loops, or automatic publishing.

## Status

This repository contains the v0 skills and their contracts. The supervised flow expects:

- [`pi-herdr-subagents`](https://github.com/modem-dev/pi-herdr-subagents) for asynchronous Pi role sessions inside Herdr.
- A `factory-state` executable for atomic `FACTORY-STATE.json` updates and usage collection. Its contract is specified by `factory-supervise`, but the executable is not implemented here yet.

Until `factory-state` exists, use the manual workflow below or invoke individual skills directly. Detailed reviews remain in Pi sessions in v0; state keeps only verdicts, round counts, token and cost usage, and unresolved blockers.

## Vocabulary

Use these terms consistently in prompts, files, schemas, and user-facing messages:

| Term | Meaning |
| --- | --- |
| factory | The overall system and skill set. It is not a work item. |
| ticket | The external unit of work, from GitHub, a local document, JSON, or plain text. |
| ticket type | Bug, feature, refactor, performance task, or investigation. |
| task | One dependency-ordered implementation slice produced during planning. |
| supervisor | The Pi session that coordinates specialist agents and state. |
| stage | Where a ticket is in the workflow: `plan`, `work`, `review`, `wrapup`, or `done`. |
| status | The ticket's current condition: `active`, `waiting_for_user`, `blocked`, `failed`, or `complete`. |
| worktree | The isolated Git checkout used to change code for one ticket. |
| factory root | The repo-local, untracked `.factory/` directory. |
| ticket directory | `.factory/tickets/<ticket-id>/`, containing the ticket's durable planning artifacts. |

Prefer “Choose a ticket to work on,” “Working on task 01,” and “Ticket PROJ-123 is waiting for user input.” Avoid referring to a ticket or its directory as a factory.

### Simple scenario

Ticket `SHOP-42` asks the product to remember a user's catalog filter.

1. `factory-plan` researches `SHOP-42`, writes `.factory/tickets/SHOP-42/plan.md`, and creates `01-task-store-filter.md` and `02-task-restore-filter.md`.
2. `factory-work` implements task 01 in the ticket worktree and marks it `ready_for_review`.
3. `factory-review`, running on a different model, either approves task 01 or returns focused findings. Work and review repeat for at most three rounds.
4. The supervisor advances to task 02 only after task 01 is `done`.
5. `factory-wrapup` summarizes the approved change, updates durable knowledge when warranted, and prints the commands the human can use to commit and merge the worktree.

## Skills

| Skill | Responsibility | Main output |
| --- | --- | --- |
| `factory-supervise` | Coordinates tickets, Herdr subagents, worktrees, atomic state, budgets, and the review loop. | A ticket advanced safely through its stages. |
| `factory-plan` | Researches one ticket, requests clarification when necessary, and creates the smallest executable plan. | `plan.md`, optional `adr.md`, numbered task files, and `factory.plan.v2` JSON. |
| `factory-work` | Implements one ready task using a small design sketch, behavior-first tests, and a type-specific playbook. | Tests, code, verification evidence, and `factory.work.v2` JSON. |
| `factory-review` | Reviews one task adversarially from a different, read-only model session. | `factory.review.v2` findings and verdict JSON. |
| `factory-wrapup` | Updates durable knowledge and prepares the change for human submission. | PR summary, artifact and test evidence, progressive explanations, and merge commands. |
| `factory-reflect` | Finds reusable lessons and evaluates proposed skill or tooling improvements. | Human-approved learning and improvement proposals. |

The work playbooks cover bugs, features, performance changes, refactors, and investigations. Reflection is not required for every ticket; use it after meaningful corrections, expensive failures, or repeated patterns.

## Requirements

- The `ghcr.io/geut/sbx-shell-pi:node-24-factory` image, with Pi and Herdr.
- [`pi-herdr-subagents`](https://github.com/modem-dev/pi-herdr-subagents), with its Herdr plugin linked and enabled. It requires Herdr 0.8.2 or newer and Node.js 22 or newer.
- A Git repository for the product code. Concurrent tickets use separate Herdr workspaces and worktrees.
- A work model and a different review model.
- The `factory-state` CLI for the fully supervised workflow.

Matt Pocock's [`grill-with-docs`, `to-spec`, and `to-tickets`](https://github.com/mattpocock/skills) are optional but recommended. `factory-plan` reuses their interview, synthesis, and slicing mechanics while overriding their destinations: artifacts stay local and nothing is published to an issue tracker.

The architecture and review behavior are simplified, budget-conscious adaptations of ideas from [pstack](https://github.com/cursor/plugins/tree/main/pstack).

## Install the skills

Pi discovers recursive `SKILL.md` files from package `skills/` directories. Once this repository is published, install it inside the sandbox:

```sh
pi install git:github.com/geut/factory-skills
```

Pin a tag or commit in reproducible factory images:

```sh
pi install git:github.com/geut/factory-skills@<tag-or-commit>
```

For local development, link the skill directories into Pi's global skill directory:

```sh
mkdir -p ~/.pi/agent/skills
for skill_dir in /path/to/factory-skills/skills/*; do
  ln -s "$skill_dir" ~/.pi/agent/skills/"$(basename "$skill_dir")"
done
```

Start a new Pi session after installing or changing skills. Invoke a skill explicitly with `/skill:<name>`; Pi may also select a skill from its description.

## Factory root

The default factory root is `.factory/` inside the code repository. Keep it untracked. It contains only durable guidance and operational state:

```text
<code-repository>/
├── .factory/
│   ├── CONTEXT.md
│   ├── FACTORY.json
│   ├── FACTORY-STATE.json
│   ├── PRD.md                         # optional
│   ├── tickets/
│   │   └── PROJ-123/
│   │       ├── plan.md
│   │       ├── adr.md                 # optional
│   │       ├── 01-task-foundation.md
│   │       └── 02-task-behavior.md
│   └── learnings/                     # created only for reusable findings
└── <product code and tests>
```

Agent conversations, detailed reviews, and temporary visuals remain in Herdr/Pi sessions unless explicitly promoted to durable project documentation.

## First-time setup

From the code repository root:

```sh
mkdir -p .factory/tickets
printf '/.factory/\n' >> .git/info/exclude
```

Create `.factory/FACTORY.json`:

```json
{
  "schemaVersion": 2,
  "ticketIdPattern": "PROJ-<number>",
  "models": {
    "plan": "provider/planning-model",
    "work": "provider/work-model",
    "review": "other-provider-or-model/review-model",
    "wrapup": "provider/wrapup-model",
    "arbiter": null
  },
  "limits": {
    "maxTickets": 2,
    "maxAgents": 4,
    "reviewRounds": 3
  }
}
```

Create `.factory/FACTORY-STATE.json`:

```json
{
  "schemaVersion": 2,
  "revision": 0,
  "tickets": {}
}
```

The code root is derived with `git rev-parse --show-toplevel`; it is not stored in configuration. The factory root defaults to `<code-root>/.factory`. For an exceptional external location, pass `--factory-root` or set `FACTORY_ROOT`; relative values resolve from the code root. Runtime paths such as worktree locations belong in state.

Set `ticketIdPattern` to the project's existing convention. If neither the ticket source nor the configuration supplies an ID, planning asks the user before creating artifacts. `models.review` must differ from `models.work`. Review rounds may be configured below three; a fourth round always requires explicit human authorization.

Before supervision, run Pi inside Herdr and confirm that `subagents_list` is available. The supervisor uses the extension's `subagent`, `subagent_resume`, and `subagent_interrupt` tools directly; it does not create panes by typing shell commands or poll terminals for completion.

## Kick off a ticket

### 1. Enter the sandbox

```sh
sbx run -t ghcr.io/geut/sbx-shell-pi:node-24-factory shell <project-directory>
```

The image opens Herdr. Start Pi in the initial pane if it is not already running.

### 2. Start with a planning gate

In the supervisor Pi session:

```text
/skill:factory-supervise

Start ticket PROJ-123.
Ticket: <ticket URL or full ticket text>

Run the plan stage, then stop so I can review plan.md and the task breakdown.
```

The supervisor creates or reuses the ticket workspace, starts a planning subagent, and produces:

```text
.factory/tickets/PROJ-123/plan.md
.factory/tickets/PROJ-123/01-task-<name>.md
.factory/tickets/PROJ-123/02-task-<name>.md
```

`adr.md` is created only for a consequential, hard-to-reverse architectural decision. If material ticket information is missing, the planner asks one focused question using `grill-with-docs`; the supervisor requests user attention and resumes the same planning session after the answer.

### 3. Review the plan and continue

After checking the scope, user stories, acceptance criteria, and dependency edges, tell the same supervisor:

```text
Continue ticket PROJ-123 through work, review, and wrap-up.
Pause for unresolved product decisions, genuine blockers, or review findings
that remain blocking after the third round.
```

The supervisor works the ready task frontier. A task moves through `pending` → `in_progress` → `ready_for_review` → `done`; `blocked` is available when progress cannot continue. Wrap-up starts only after every required task is approved.

For a small, well-understood ticket, the initial prompt may authorize the complete flow. The planning gate is recommended while the skills are being evaluated.

## Manual v0 workflow

Until `factory-state` is available, run the roles explicitly in separate Herdr tabs:

1. Plan:

   ```text
   /skill:factory-plan Plan ticket PROJ-123 from <URL or ticket text>.
   ```

2. For each dependency-ready task, work:

   ```text
   /skill:factory-work Implement task 01 for ticket PROJ-123.
   ```

3. Start a fresh Pi reviewer tab with a different model and read-only tools:

   ```text
   /skill:factory-review Review task 01 for ticket PROJ-123.
   Use the task, current diff, surrounding code, and supplied test evidence.
   ```

4. Relay blocking findings to the work tab. Return the work response and updated diff to the same reviewer tab. Stop after approval or three rounds.
5. Repeat for the next ready task.
6. After every task is approved, run:

   ```text
   /skill:factory-wrapup Prepare ticket PROJ-123 for human PR submission.
   ```

7. Run `/skill:factory-reflect` only when the ticket produced a reusable lesson worth evaluating.

The reviewer returns JSON only and never edits code. The human remains responsible for committing, merging, pushing, and opening the pull request.

## Review outcomes

- `approve`: no findings remain; the task may become `done`.
- `changes_requested`: blocking findings return to the existing work session.
- `blocked`: review lacks required evidence, model independence, or read-only isolation.
- `waiting_for_user`: blocking findings remain after three rounds or require a product decision.

The supervisor enforces schemas and loop limits but does not overrule technical judgment. An optional arbiter model may receive one bounded dispute-only prompt; it does not perform another full review.

## What the factory does not do

- It does not commit, merge, push, publish tickets, or open pull requests.
- It does not create an ADR for every ticket.
- It does not persist detailed review transcripts in `.factory/`.
- It does not run more than three unattended review rounds.
- It does not treat an idle agent as proof that a stage succeeded.
- It does not automatically rewrite or install improved skills.
