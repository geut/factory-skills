# Factory Skills

A [Pi](https://pi.dev) package that runs one ticket from planning through work, review, and wrap-up to a human handoff. Coordination lives in a TypeScript controller. Skills describe specialist behavior only.

## Commands

Pi loads `src/extension/index.ts` and the `skills/` directory from this package. The first `/factory start` creates `.factory/db/state.sqlite`. `.factory/FACTORY.json` must already exist and name distinct `models.work` and `models.review`. `models.plan` defaults to the work model.

```text
/factory start <github-url | owner/repo#n | KEY-123 | local-file>
/factory start --text <id> <ticket text>
/factory reply <ticket> "answer"
/factory retry <ticket>
/factory complete <ticket>
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

Launch failures and crashes use `limits.infrastructureRetries` and never spend a correction or a review round.

After the last approval, the controller checks the wrap-up input in code: every task is done with an approving review, the plan and task files exist, the worktree is ready on its branch, and no other child runs. It records the worktree, refs, and factory files as a baseline, then launches the `factory-wrapup` agent on `models.work` in the worktree. A failed check pauses the ticket; `retry` checks again.

The wrap-up agent returns the `factory.wrapup.v1` handoff. The controller keeps it as written and validates it against the repository:

- every heading is present; `## Files` lists every changed path and no other; `## Tests` names the `validation.work.commands`; `## Merge commands` holds a pull-request URL or commands with the real worktree and branch;
- wrap-up changed no product code: a change it makes must be documentation, or a generated artifact listed in `validation.wrapup.generated`, and must be named in `## Files`;
- in the factory root only `CONTEXT.md`, `PRD.md`, and `learnings/` may change; no `wrapup.md` or `visuals/`;
- nothing was committed or merged, and the branch still exists;
- `github.pullRequests` decides whether a push and a pull request are allowed: never when it is off or the worktree has uncommitted changes; with a clean worktree, the pull request must exist for the branch.

A failed validation resumes the same wrap-up session with the exact failures; wrap-up corrections have no limit. A pass sets the ticket to `wrapup / ready_for_handoff`, opens two panes without a model turn (`📦 <ticket>` reopens the wrap-up session, `🔀 <ticket>` shows the worktree diff in Fresh), and posts a notice with the all-stage usage table. A pane that fails to open retries and never fails the handoff. Merge the work yourself, then `/factory complete <ticket>` moves it to `done / complete`. Repeating `start` on a ticket ready for handoff only reports its state. Commit, push, merge, and worktree cleanup stay with you unless `github.pullRequests` allows the push and pull request. `/factory rerun` is not implemented.

## What you see

Every status card names the ticket, the stage, and what the run led to, then the task and round:

```text
✓ dpaez/factory-dashboard#11 · review · approved
  03/06 Overview page · r1 · 3/6 done
  The overview page meets every acceptance criterion.
```

Outcomes are `planned`, `ready for review`, `approved`, `changes requested`, `blocked`, `correcting`, `retrying`, `diff changed`, `paused`, `waiting for you`, `failed`, and `finished`. The plan card lists every task with its dependencies. Blocking findings show under the card. A card that waits on you (`▲`) shows its whole message and the command to run next.

Above the editor, the widget keeps each unfinished ticket's progress on screen between runs, followed by the running agents:

```text
● dpaez/factory-dashboard#11 · ■■□□□□ 2/6 · review r1
  03/06 Overview page
```

## Layout

```text
src/extension/     Pi /factory command
src/controller/    commands, pure reducer, SQLite persistence
src/actions/       leased dispatcher, worktree preparation
src/runtime/       FactorySubagentRuntime, fake, pi-herdr adapter
src/validation/    plan, work, review, and wrap-up checks
src/stories/       component gallery: fixtures, scenarios, server, snapshots
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
  "github": { "owner": "geut", "repo": "factory-skills", "pullRequests": false },
  "keys": { "PROJ": { "provider": "github" } },
  "limits": { "workCorrections": 3, "reviewRounds": 3, "reviewCorrections": 3 },
  "validation": {
    "work": { "commands": [{ "name": "tests", "argv": ["npm", "test"], "timeoutMs": 300000 }] },
    "wrapup": { "generated": ["docs/api/", "*.snap"] }
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

## Component gallery

Each TUI component (Status Message, Widget, Ticket View, Agents View) has scenarios next to it in `src/extension/*.stories.ts`. A scenario is one state of the component, rendered without Pi from plain JSON state. The scenarios cover a ticket's life, from the plan card through review rounds, pauses, questions, retries, and wrap-up.

```sh
npm run gallery                       # live gallery at http://127.0.0.1:5180/
npm run gallery -- --port 5200 --host 0.0.0.0
```

The sidebar lists the components. `/component/<id>` shows that component's scenarios, each in its own card with a description, rendered with Pi's own theme at the widths you pick (40, 60, 80, 120). The theme selector at the top applies to every page. **Edit state** opens a scenario's state as JSON; the render updates as you type, the edit is kept in the browser, and **Reset** restores it. The server runs under `node --watch`, so a code change restarts it and the open page reloads.

The same scenarios print in the terminal:

```sh
npm run stories                              # every scenario at 40, 60, 80, 120 columns, Pi's dark theme
npm run stories -- --story widget --width 60 # filter by component or scenario name
npm run stories -- --theme light --plain     # light theme, or no colour
```

`node --test` renders every story at every width, fails if a line is wider than its width, and compares the text with `src/stories/snapshots/`. After an intended UI change, run `npm run stories:update` and review the snapshot diff.
