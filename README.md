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

QA is an optional stage between work and review, on when `FACTORY.json` sets `stages.qa.enabled` and lists at least one `stages.qa.commands`. It reads the task file's `## Acceptance criteria` (AC1..ACn) and launches the `factory-qa` agent on `models.work` in the worktree. The agent writes one observable end-to-end test per criterion a user can observe, lists the others in the ledger with what covers them, and `test-plan.md`, `ledger.md`, and `screenshots/` under `tickets/<slug>/qa/<task>/`. The controller checks that every criterion is tested or in the ledger with a reason and that each screenshot exists, then runs the QA commands itself:

- missing or incomplete QA output resumes the QA agent with the failures, up to `limits.qaCorrections` (default 2) per round;
- a failing command returns the task to work with the failure; work's validation runs again, then QA again. `limits.qaRounds` (default 3) bounds the rounds; at the limit the ticket pauses and `reply` resumes the QA agent;
- a pass hands review the diff QA left, tests included, and wrap-up lists the screenshots for the pull request.

With QA on, the plan must give every task at least one acceptance criterion. A task file can opt out with `QA: none` when no criterion is observable in the running product (a data layer change, docs, an ADR): the task goes from work straight to review, and its QA summary reads `skipped`. Without the line, or with `QA: e2e`, QA runs.

After the last approval, the controller checks the wrap-up input in code: every task is done with an approving review, the plan and task files exist, the worktree is ready on its branch, and no other child runs. It records the worktree, refs, and factory files as a baseline, then launches the `factory-wrapup` agent on `models.work` in the worktree. A failed check pauses the ticket; `retry` checks again.

The wrap-up agent returns the `factory.wrapup.v1` handoff. The controller keeps it as written and validates it against the repository:

- every heading is present; `## Files` lists every changed path and no other; `## Tests` names the `validation.work.commands`; `## Merge commands` holds a pull-request URL or commands with the real worktree and branch;
- wrap-up changed no product code: a change it makes must be documentation, or a generated artifact listed in `validation.wrapup.generated`, and must be named in `## Files`;
- in the factory root only `CONTEXT.md`, `PRD.md`, and `learnings/` may change; no `wrapup.md` or `visuals/`;
- nothing was committed or merged, and the branch still exists;
- `github.pullRequests` decides whether a push and a pull request are allowed: never when it is off or the worktree has uncommitted changes; with a clean worktree, the pull request must exist for the branch.

A failed validation resumes the same wrap-up session with the exact failures; wrap-up corrections have no limit. A pass sets the ticket to `wrapup / ready_for_handoff`, opens two panes without a model turn (`📦 <ticket>` reopens the wrap-up session, `🔀 <ticket>` shows the worktree diff in Fresh), and posts a notice with the all-stage usage table. A pane that fails to open retries and never fails the handoff. Merge the work yourself, then `/factory complete <ticket>` moves it to `done / complete`. Repeating `start` on a ticket ready for handoff only reports its state. Commit, push, merge, and worktree cleanup stay with you unless `github.pullRequests` allows the push and pull request. `/factory rerun` is not implemented.

## Factory server

The factory server hosts the controller outside Pi, so tickets keep moving with no Pi session open ([ADR-003](docs/adr/0003-a-factory-server-owns-the-controller.md)). It is moving in step by step: today it dispatches, recovers runs, and answers `/health`. The API, tokens, and Pi as a client follow in the [build tickets](https://github.com/geut/factory-skills/issues/25). Do not run `/factory` in Pi for a factory root a server owns.

Build the single executable, then run it from the repository root inside a Herdr pane:

```sh
npm run build          # writes dist/factory for this OS and architecture
dist/factory serve
```

`npm run build` bundles `src/cli.ts` with esbuild and injects it into a copy of the running `node` ([single executable applications](https://nodejs.org/api/single-executable-applications.html)). Build on the platform that runs it. `node src/cli.ts serve` runs the same server from source.

- The server refuses to start outside Herdr. It needs `HERDR_PANE_ID` and `HERDR_SOCKET_PATH`, plus `herdr` and `pi` on `PATH`; `FACTORY_PI_BIN` overrides the path to `pi`.
- It listens on `server.host` and `server.port` from `FACTORY.json`, `127.0.0.1:7731` by default. Bind `0.0.0.0` to publish the port from a sandbox. The server warns when it listens off loopback, because it speaks plain HTTP.
- One server owns a factory root. It holds a lease row in SQLite with its URL and a heartbeat, and a second server refuses to start while that lease is live. A lease whose process is gone, or whose heartbeat is older than 15 s, is taken over.
- On SIGINT or SIGTERM it stops dispatching, releases the lease, and exits. Agent panes keep running, and the next start adopts them with `recover()`.
- It upgrades a schema 3 database in place the first time it opens it.

### API

The server's routes are declared once, in [`src/api/routes.ts`](src/api/routes.ts), with Zod schemas. The router validates every request against them, and the OpenAPI 3.1 document is generated from the same list. `GET /openapi.json` serves it without a token, and [`openapi.json`](openapi.json) is the committed copy that clients generate their types from.

- Routes live under `/v1`. `/health` and `/openapi.json` sit outside it.
- Errors are RFC 9457 `application/problem+json` with a stable `type` code, listed in [`src/api/problem.ts`](src/api/problem.ts). A `validation_error` lists each bad field, such as `body.ref` or `query.stage`.
- Source runs and tests also check every response against its schema; the single executable does not.
- A test fails when `openapi.json` no longer matches the routes. After changing a route, run `npm run openapi:update` and commit the document.

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
src/server/        factory serve: HTTP server and owner lease
src/api/           routes, router, problem errors, OpenAPI document
src/cli.ts         the factory executable's entry point
scripts/           single executable build
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
  "server": { "host": "127.0.0.1", "port": 7731 },
  "limits": { "workCorrections": 3, "reviewRounds": 3, "reviewCorrections": 3 },
  "stages": {
    "qa": {
      "enabled": true,
      "commands": [{ "name": "e2e", "argv": ["npx", "playwright", "test"] }]
    }
  },
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
