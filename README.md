# Factory Skills

A [Pi](https://pi.dev) package that runs one ticket from planning through the first work agent. Coordination lives in a TypeScript controller. Skills describe specialist behavior only.

## Commands

Pi loads `src/extension/index.ts` and the `skills/` directory from this package. The first `/factory start` creates `.factory/db/state.sqlite`. `.factory/FACTORY.json` must already exist and name distinct `models.work` and `models.review`. `models.plan` defaults to the work model.

```text
/factory start <github-url | owner/repo#n | KEY-123 | local-file>
/factory start --text <id> <ticket text>
/factory reply <ticket> "answer"
/factory retry <ticket>
/factory status <ticket>
```

`start` resolves the ticket, freezes the source, and launches the planning agent. Repeating it does not open another child. A parent GitHub issue with sub-issues is rejected. After `plan.md` and at least one task file exist, the controller registers the task graph, adds a git worktree at `.factory/worktrees/<slug>`, and launches the first dependency-ready work agent. The planner still hands off with the `factory.plan.v3` template.

`caller_ping` stores the question and waits. `reply` resumes that same session. A failed resume keeps the answer; `retry` reuses it. Plan validation may resume the planner three times. Launch failures retry separately and do not spend that budget.

This slice stops once the work agent is launched. It does not validate work, review, wrap up, open a pull request, or implement `/factory rerun`.

## Layout

```text
src/extension/     Pi /factory command
src/controller/    commands, pure reducer, SQLite persistence
src/actions/       leased dispatcher, worktree preparation
src/runtime/       FactorySubagentRuntime, fake, pi-herdr adapter
src/validation/    factory.plan.v3 checks
src/state/         schema and database opener
skills/            specialist procedures and output templates
tests/             recovery tests against real SQLite
```

Child sessions follow the named skill, return only the versioned template in that skill's `references/output.md`, then call `subagent_done`. `caller_ping` replaces the template when a decision is needed. Skills do not write the controller database.

## Vocabulary

| Term | Meaning |
| --- | --- |
| ticket | External work, from GitHub or a local document. |
| execution | One generation of a ticket. |
| stage | `plan`, `work`, `review`, `wrapup`, or `done`. |
| session | One Pi conversation, reused when that agent resumes. |
| run | One pane launch. A resume or retry creates a new run. |
| factory root | Untracked `.factory/` in the code repository. |

## Factory root

```text
.code-repository/
└── .factory/
    ├── FACTORY.json
    ├── CONTEXT.md
    ├── db/state.sqlite
    ├── tickets/<slug>/
    ├── worktrees/<slug>/
    └── sessions/
```

`FACTORY.json` example:

```json
{
  "models": { "work": "work-model", "review": "review-model" },
  "github": { "owner": "geut", "repo": "factory-skills" },
  "keys": { "PROJ": { "provider": "github" } }
}
```

SQLite is the read contract. Views such as `current_ticket_executions`, `ready_task_frontier`, and `open_attention` are documented in [`src/state/README.md`](src/state/README.md). The controller does not emit a JSON state file.

## Checks

```sh
node --test
npx oxlint .
npx tsc --noEmit
```

Node.js 24 runs the TypeScript tests directly.
