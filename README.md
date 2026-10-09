# Factory Skills

A [Pi](https://pi.dev) package that runs one ticket from planning through work, review, and the wrap-up launch. Coordination lives in a TypeScript controller. Skills describe specialist behavior only.

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

When a worker finishes, the controller inspects the worktree diff and runs the trusted `validation.work.commands`. A failure resumes the same worker with the exact failures. A pass launches a read-only reviewer on `models.review` with the diff that was checked.

The reviewer returns the `factory.review.v4` template. The controller parses the verdict and its findings, then checks that the reviewer was isolated and that the worktree diff has not changed since the reviewer received it.

- `approve` marks the task done and starts the next dependency-ready task. After the last task, the controller launches wrap-up.
- `changes_requested` resumes the same worker with only the blocking findings. Work validation runs again, then the same reviewer session reviews round 2. `limits.reviewRounds` (default 3) bounds the rounds; at the limit the ticket pauses and `reply` resumes the reviewer with your decision.
- `blocked` pauses the ticket. `reply` resumes the reviewer.
- A result the controller cannot parse resumes the reviewer with the parse errors. That does not spend a round. `limits.reviewCorrections` (default 3) bounds it per round.
- A diff that changed during review is validated again before another review in the same round. The reviewer gets the worktree as it stands after the validation commands. A second change in the same round pauses the ticket, because something keeps writing to the worktree; ignore the generated files, then `retry` validates the work and reviews it again.

Launch failures and crashes use `limits.infrastructureRetries` and never spend a correction or a review round. This slice launches wrap-up but does not validate it. It does not open a pull request or implement `/factory rerun`.

## Layout

```text
src/extension/     Pi /factory command
src/controller/    commands, pure reducer, SQLite persistence
src/actions/       leased dispatcher, worktree preparation
src/runtime/       FactorySubagentRuntime, fake, pi-herdr adapter
src/validation/    plan, work, and review checks
src/state/         schema and database opener
skills/            specialist procedures and output templates
tests/             recovery tests against real SQLite
```

Child sessions follow the named skill, return only the versioned template in that skill's `references/output.md`, then call `subagent_done`. `caller_ping` replaces the template when a decision is needed. Skills do not write the controller database.

## Vocabulary

| Term         | Meaning                                               |
| ------------ | ----------------------------------------------------- |
| ticket       | External work, from GitHub or a local document.       |
| execution    | One generation of a ticket.                           |
| stage        | `plan`, `work`, `review`, `wrapup`, or `done`.        |
| session      | One Pi conversation, reused when that agent resumes.  |
| run          | One pane launch. A resume or retry creates a new run. |
| factory root | Untracked `.factory/` in the code repository.         |

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
  "keys": { "PROJ": { "provider": "github" } },
  "limits": { "workCorrections": 3, "reviewRounds": 3, "reviewCorrections": 3 },
  "validation": {
    "work": { "commands": [{ "name": "tests", "argv": ["npm", "test"], "timeoutMs": 300000 }] }
  }
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
