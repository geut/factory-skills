# Factory Skills

A [Pi](https://pi.dev) package that runs one ticket from planning through work, review, and wrap-up to a human handoff. Coordination lives in a TypeScript controller. Skills describe specialist behavior only.

## Commands

Pi loads `src/extension/index.ts` and the `skills/` directory from this package. The controller runs in the [factory server](#factory-server), and Pi is one of its clients: `/factory start`, `reply`, `retry`, and `complete` go to the server's API with the token in `.factory/local.token`, while `status`, the ticket and agents views, the widget, and the status cards read `.factory/db/state.sqlite` directly. Pi looks for new events about once a second and shows the cards the server posted since. With no server running, a command says how to start one and changes nothing. Any number of Pi sessions can watch the same factory. `.factory/FACTORY.json` must already exist and name distinct `models.work` and `models.review`. `models.plan` defaults to the work model.

```text
/factory start <github-url | owner/repo#n | #n | local-file>
/factory start --text <id> <ticket text>
/factory reply <ticket> "answer"
/factory retry <ticket>
/factory complete <ticket>
/factory stop <ticket>
/factory cancel <ticket> ["reason"]
/factory rerun <ticket>
/factory status <ticket>
```

`start` resolves the ticket, freezes the source, adds the ticket's git worktree at `.factory/worktrees/<slug>` (see [Worktree base](#worktree-base)), and launches the planning agent in it. Repeating it does not open another child. An issue with sub-issues is an umbrella and is rejected; see [Tracker and code host](#tracker-and-code-host). After `plan.md` and at least one task file exist, each task file's frontmatter (`type`, `qa`, `blocked_by`) is valid, and `.factory/CONTEXT.md` has its required sections, the controller registers the task graph and launches the first dependency-ready work agent in the same worktree. The plan is those files; the planner's `factory.plan.v3` reply is a suggested summary, not a requirement. When the factory root has no `CONTEXT.md`, the plan prompt asks the planner to create it with the sections Commands, Environment, Test layers, Servers and ports, Known flakes, Fixtures and fakes, and Vocabulary (see [the CONTEXT.md reference](skills/factory-plan/references/context.md)); a file over 150 lines passes with a warning.

`caller_ping` stores the question and waits. `reply` resumes that same session. A failed resume keeps the answer; `retry` reuses it. Plan validation may resume the planner three times. Launch failures retry separately and do not spend that budget.

When a worker finishes, the controller inspects the worktree diff and runs the trusted `validation.work.commands`. A failure resumes the same worker with the exact failures. A pass launches a read-only reviewer on `models.review` with the diff that was checked.

The reviewer returns the `factory.review.v5` template. Its `## Verification` section has a line per acceptance criterion and, from round 2, per earlier blocking finding, each citing the code it checked. The controller parses the verdict, findings, and Verification lines; checks that every expected id is there and every cited `path:line` exists in the worktree; then checks that the reviewer was isolated and that the worktree diff has not changed since the reviewer received it. A problem comes back to the reviewer as a correction.

- `approve` marks the task done and starts the next dependency-ready task. After the last task, the controller launches wrap-up.
- `changes_requested` resumes the same worker with only the blocking findings. Work validation runs again, then the same reviewer session reviews round 2. `limits.reviewRounds` (default 3) bounds the rounds; at the limit the ticket pauses and `reply` resumes the reviewer with your decision.
- `blocked` pauses the ticket. `reply` resumes the reviewer.
- A result the controller cannot parse resumes the reviewer with the parse errors. That does not spend a round. `limits.reviewCorrections` (default 3) bounds it per round.
- A diff that changed during review is validated again before another review in the same round. The reviewer gets the worktree as it stands after the validation commands. A second change in the same round pauses the ticket, because something keeps writing to the worktree; ignore the generated files, then `retry` validates the work and reviews it again.

Launch failures and crashes use `limits.infrastructureRetries` and never spend a correction or a review round.

QA is an optional stage between work and review, on when `FACTORY.json` sets `stages.qa.enabled` and lists at least one `stages.qa.commands`. It reads the task file's `## Acceptance criteria` (AC1..ACn) and launches the `factory-qa` agent on `models.work` in the worktree. QA owns the task's end-to-end tests: the work prompt says so, and the worker writes unit and component tests instead. The agent proves each criterion a user can observe at the cheapest layer that runs the real code (an end-to-end test for a user path through the running app, a component test or story for a component's look or state), extending the feature's existing spec rather than a per-task file, lists the others in the ledger with what covers them, and `test-plan.md`, `ledger.md`, and `screenshots/` under `tickets/<slug>/qa/<task>/`. The controller checks that every criterion is tested or in the ledger with a reason and that each screenshot exists, then runs the QA commands itself:

- missing or incomplete QA output resumes the QA agent with the failures, up to `limits.qaCorrections` (default 2) per round;
- a failing QA command returns the task to work with the failure; work's validation runs again, then QA again. `limits.qaRounds` (default 3) bounds the rounds; at the limit the ticket pauses and `reply` resumes the QA agent;
- after the QA commands, the controller runs `validation.qa.commands` (the `validation.work.commands` when it is not set; `[]` turns it off), so code QA wrote meets the project's bar. A failure whose output names a file QA changed this round resumes the QA agent as a correction, ahead of any other failure; any other failure returns the task to work;
- a pass hands review the diff QA left, tests included, and the checks behind it: the work checks as they stand after QA and QA's own, grouped under Work and QA in the review prompt. Wrap-up lists the screenshots for the pull request.

Every stage after work is given the worker's latest reply for the task, in every round. When a later round's reply is empty, the last reply with text stands in, marked as such.

With QA on, the plan must give every task at least one acceptance criterion. A task file opts out with `qa: none` in its frontmatter when no criterion is observable in the running product (a data layer change, docs, an ADR): the task goes from work straight to review, and its QA summary reads `skipped`. With `qa: e2e`, QA runs.

After the last approval, the controller checks the wrap-up input in code: every task is done with an approving review, the plan and task files exist, the worktree is ready on its branch, and no other child runs. It records the worktree, refs, and factory files as a baseline, then launches the `factory-wrapup` agent on `models.work` in the worktree. A failed check pauses the ticket; `retry` checks again.

The wrap-up agent returns the `factory.wrapup.v2` handoff. The controller keeps it as written and validates it against the repository:

- `## Issue checklist` has one line per open checklist item of the ticket's issue, `B1`..`Bn`: `met` cites a task criterion (`Task 01 AC2`) that review verified or QA's test plan covers, or a worktree file, and is refused while an open review finding, minor included, names that criterion; `not_met` gives a reason. `## Decisions` is `none` or bullet points;
- every heading is present; `## Files` lists every changed path and no other; `## Tests` names the `validation.work.commands`; `## Merge commands` holds a pull-request URL or commands with the real worktree and branch;
- wrap-up changed no product code: a change it makes must be documentation, or a generated artifact listed in `validation.wrapup.generated`, and must be named in `## Files`;
- in the factory root only `CONTEXT.md`, `PRD.md`, and `learnings/` may change; no `wrapup.md` or `visuals/`;
- nothing was merged, the base branch did not move, and the branch still exists;
- with `codeHost.pullRequests` off, nothing was committed or pushed, and `## Merge commands` prints the commands;
- with it on, wrap-up commits the approved work on the ticket branch. Its commits sit on top of the commit wrap-up started from, with no merge and no rewritten history, and hold only paths `## Files` lists. Once anything is committed the worktree must be clean, and with a clean worktree the pull request must exist for the branch with the local HEAD as its head. If committing fails, the worktree stays uncommitted, nothing is pushed, and the commands are printed instead.

A failed validation resumes the same wrap-up session with the exact failures; wrap-up corrections have no limit. A pass sets the ticket to `wrapup / ready_for_handoff`, opens two panes without a model turn (`📦 <ticket>` reopens the wrap-up session, `🔀 <ticket>` shows the ticket's diff since its base commit, in [Hunk](https://hunk.dev) when `hunk` is on PATH, else in Fresh; `FACTORY_HUNK_BIN` and `FACTORY_FRESH_BIN` name other binaries; in Hunk the diff carries notes from the handoff: what each `## Files` line says about its file, each decision on the lines it cites, and each open review finding at its location), and posts a notice with the all-stage usage table. A pane that fails to open retries and never fails the handoff. On a tracker issue, the controller ticks the met items through the tracker and posts one handoff comment with the decisions and the items left open; a rerun replaces that comment. An item someone changed on the issue stays unticked, and the comment and a warning on the ticket say so. None of this can fail the handoff.

The tracker adapter decides what an issue's checklist is: wrap-up's input preparation asks it for the items, numbers the open ones `B1`..`Bn`, and keeps each one's key in the wrap-up baseline, so corrections and validation judge the same list. On GitHub the checklist is the Markdown boxes (`- [ ]`, `1. [ ]`) in the issue body, outside code fences, each keyed by its text and which box of that text it is; ticking re-reads the body and flips only those marks, leaving every other byte as it was. A tracker without a `checklist` capability gives wrap-up no boxes, and the factory only comments. A tracker that cannot be read leaves wrap-up without boxes and says why in its prompt. Merge the work yourself, then `/factory complete <ticket>` moves it to `done / complete`. Repeating `start` on a ticket ready for handoff only reports its state. Merge and worktree cleanup always stay with you. Commit and push do too unless `codeHost.pullRequests` is on.

## Factory server

The factory server hosts the controller outside Pi, so tickets keep moving with no Pi session open ([ADR-003](docs/adr/0003-a-factory-server-owns-the-controller.md)). It dispatches, recovers runs, serves the API below, and creates `.factory/db/state.sqlite` on its first start. The remaining routes follow in the [build tickets](https://github.com/geut/factory-skills/issues/25).

Prebuilt binaries for Linux arm64 and x64 are published on the [Releases](https://github.com/geut/factory-skills/releases) page, each with a `.sha256` checksum. They need no Node and no checkout of this repository, and run on glibc 2.28 or newer. Download one and run it from the repository root inside a Herdr pane:

```sh
arch=$(uname -m | sed 's/aarch64/arm64/; s/x86_64/x64/')
curl -fsSL -o factory "https://github.com/geut/factory-skills/releases/latest/download/factory-linux-$arch"
chmod +x factory
./factory serve
```

On another platform, or to run unreleased changes, build the single executable yourself:

```sh
npm run build          # writes dist/factory for this OS and architecture
dist/factory serve
```

`npm run build` bundles `src/cli.ts` with esbuild and injects it into a copy of the running `node` ([single executable applications](https://nodejs.org/api/single-executable-applications.html)). Build on the platform that runs it. `node src/cli.ts serve` runs the same server from source.

- The server refuses to start outside Herdr. It needs `HERDR_PANE_ID` and `HERDR_SOCKET_PATH`, plus `herdr` and `pi` on `PATH`; `FACTORY_PI_BIN` overrides the path to `pi`.
- Agents see the server's `PATH`, and its `BASH_ENV` when set. Herdr opens panes with its own environment and agents run non-interactive bash, which never reads `~/.bashrc`, so every pane's launch script exports both. Whatever the server can run, its agents can run too, so start `factory serve` from a shell where the project's toolchain (`pnpm`, `bun`, ...) is on `PATH`.
- Each agent's launch script also exports `FACTORY_WORKTREE`, its worktree, and `FACTORY_RUN_ID`, which every process it starts inherits. Handoff panes export `FACTORY_WORKTREE=handoff`. Before a work or QA run, the controller stops the user's processes that belong to a worktree under `.factory/worktrees/` whose execution is complete, cancelled or retired, or whose directory is gone. A marked process belongs to what its marker names; an unmarked one to its working directory. They get SIGTERM, then SIGKILL after 3 seconds. Paused and failed tickets keep theirs, and processes outside the factory are never touched. Each one becomes a `stray_process_stopped` or `stray_process_stop_failed` event on the ticket, with its PID, command and worktree, and a card lists them. A failed sweep is reported and never blocks the run.
- It listens on `server.host` and `server.port` from `FACTORY.json`, `127.0.0.1:7731` by default. Bind `0.0.0.0` to publish the port from a sandbox. The server warns when it listens off loopback, because it speaks plain HTTP.
- One server owns a factory root. It holds a lease row in SQLite with its URL and a heartbeat, and a second server refuses to start while that lease is live. A lease whose process is gone, or whose heartbeat is older than 15 s, is taken over.
- Each ticket gets its own Herdr tab, named after it, in the server pane's workspace. Every agent, and each handoff pane, opens in its own pane in that tab, and the pane closes when its Pi exits. The tab's starting shell closes once the first pane is open, and a resumed agent's pane opens before the finished one closes, so the tab stays while the ticket runs. The tab closes when the ticket finishes. The panes of each tab are remembered in `.factory/runtime/tabs.json`, so a restarted server keeps using them. A tab that cannot be made falls back to splitting the server's pane.
- On SIGINT or SIGTERM it stops dispatching, releases the lease, and exits. Agent panes keep running, and the next start adopts them with `recover()`.
- It upgrades a schema 3 database in place the first time it opens it. It first copies the database to `.factory/db/state.schema-<N>.sqlite`, where N is the old schema version, and does not upgrade if the copy fails. An upgraded database refuses older controllers. To go back to one, stop every factory server and Pi session, replace `state.sqlite` with the copy, and delete `state.sqlite-wal` and `state.sqlite-shm`. Anything recorded after the upgrade is lost.

### API

The server's routes are declared once, in [`src/api/routes.ts`](src/api/routes.ts), with Zod schemas. The router validates every request against them, and the OpenAPI 3.1 document is generated from the same list. `GET /openapi.json` serves it without a token, and [`openapi.json`](openapi.json) is the committed copy that clients generate their types from.

- Routes live under `/v1`. `/health` and `/openapi.json` sit outside it.
- Errors are RFC 9457 `application/problem+json` with a stable `type` code, listed in [`src/api/problem.ts`](src/api/problem.ts). A `validation_error` lists each bad field, such as `body.ref` or `query.stage`.
- Source runs and tests also check every response against its schema; the single executable does not.
- A test fails when `openapi.json` no longer matches the routes. After changing a route, run `npm run openapi:update` and commit the document.

### Reads

Reads need a `read` token.

| Route                        | Returns                                                                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/tickets`            | Each ticket's current execution: stage, status, progress, whether it needs a person, and who started it.                          |
| `GET /v1/tickets/{key}`      | The same, plus the source it started from, tasks with dependencies and review state, questions with their replies, and usage.     |
| `GET /v1/tickets/{key}/runs` | The ticket's runs, oldest first.                                                                                                  |
| `GET /v1/runs/{id}`          | One run: purpose, round, outcome, model setup, latest validation and its checks, review findings, usage, and its latest activity. |
| `GET /v1/agents`             | Runs that are starting or running.                                                                                                |

- `/v1/tickets` filters by `status=open|finished|all` (default `open`), `stage`, `state` (the execution status), `needsUser=true|false`, and `ref`. Filters combine with AND; repeat one for OR, as in `?stage=review&stage=qa&needsUser=true`.
- Finished tickets and runs page: pass the response's `nextCursor` as `cursor`, with `limit` up to 200.
- A ticket's `source` is the issue or brief as fetched when that execution started, so `?execution=n` shows what generation n was asked. A brief has no tracker author or url; `startedBy` says who started it.
- A run's activity is the agent's latest assistant message in that run, read from its Pi session file.
- `GET /v1/backlog` lists open tracker issues that match `tracker.backlog` (labels and milestone on GitHub) and are not tickets yet. Each one carries its description, author, and created and updated times, and says whether another issue blocks it and whether it is an umbrella with sub-issues. The list is cached for about a minute; `?refresh=true` asks the tracker again. A started issue drops out at once.

### Events

`GET /v1/events` (`read`) streams Server-Sent Events, one per row of the `events` table: commands, runtime results, validations, and the status cards the controller posts. Each event is `id: <revision>`, `event: <kind>`, and `data: {ticket, task, run, actor, card}`. Events only name what changed; a client refetches it through the read routes.

- Resume with `Last-Event-ID: <revision>` (EventSource sends it on reconnect) or `?since=<revision>`. Without either, the stream starts with new events.
- A comment line every 15 s keeps proxies from closing the connection.
- `EventPayload` in `openapi.json` types `data`. OpenAPI 3.1 cannot type a stream's items, so clients parse events themselves.

### Stats

`/v1/stats/summary`, `/stages`, `/configurations`, `/tickets`, and `/export` (`read`) report how the factory turns tickets into merged pull requests, by stage and model setup, as defined in [`docs/stats-v1.md`](docs/stats-v1.md). `from` and `to` select tickets by start time. Every response names the factory (`factoryId`, created with the database), the factory versions its tickets ran on, and `definitions: "stats.v1"`. Set `name` in `FACTORY.json` to tell factories apart in an export.

### Commands

Commands need an `act` token. Each one returns `202 {ticket, revision, message}` once it is committed. `ticket` is the ticket key used in the other URLs: its factory directory's name, such as `proj-123-ab12cd34`. `revision` is the `events.revision` that recorded the command. Agent launches happen afterwards, so a client that wants the result waits for the event stream to pass that revision.

| Route                                     | Pi equivalent       |
| ----------------------------------------- | ------------------- |
| `POST /v1/tickets {ref}` or `{id, text}`  | `/factory start`    |
| `POST /v1/tickets/{key}/replies {answer}` | `/factory reply`    |
| `POST /v1/tickets/{key}/retries`          | `/factory retry`    |
| `POST /v1/tickets/{key}/complete`         | `/factory complete` |
| `POST /v1/tickets/{key}/cancel {reason?}` | `/factory cancel`   |
| `POST /v1/tickets/{key}/reruns`           | `/factory rerun`    |
| `POST /v1/runs/{id}/stop`                 | `/factory stop`     |

- Problems found before anything changes come back at once: `validation_error` for a reference that cannot be resolved, `umbrella_issue`, `tracker_unavailable`, `ticket_not_found`, `not_waiting_for_reply`, or `invalid_state`.
- Cancel ends a ticket for good: its agents stop, its tab closes, open questions and tasks are cancelled, and the ticket is `done / cancelled`. Its worktree, branch, and pull request stay for you to keep or clean up. A ticket from the tracker gets a comment, and its factory status label is removed.
- Rerun runs a complete, cancelled, or failed ticket again as generation N+1: it fetches the issue again and works in `<ticket dir>/r<N>` on its own worktree and branch (`factory/<key>-r<N>`), with the models in `FACTORY.json`. Earlier generations stay readable through `GET /v1/tickets/{key}/executions` and `?execution=<n>` on the ticket and run routes.
- Stop closes a running agent's pane and pauses the ticket. A reply resumes that agent's session with your instructions; a retry relaunches it.
- Send `Idempotency-Key: <key>` to make a command safe to repeat: the same key returns the first result instead of applying the command again.

### Tokens

Every `/v1` route needs `Authorization: Bearer <token>`. A token belongs to a named API client and has a scope: `read` routes only look, `act` routes change tickets, and `act` includes `read`. Tokens are managed only from the command line, so whoever can reach the factory root decides who gets one:

```sh
dist/factory token create dashboard --scope act   # prints the token once
dist/factory token list
dist/factory token revoke dashboard
```

- The database keeps only each token's SHA-256. A lost token cannot be shown again; revoke it and create it again.
- To rotate without downtime, create a client with a new name, switch the client over, then revoke the old one.
- The server writes a `local` act token to `.factory/local.token` (mode `0600`) for Pi on the same machine. It replaces the token when the file is missing or the client was revoked.
- `GET /v1/me` returns the client a token belongs to, to check a token.
- Commands record the client that sent them. A client can add `X-Factory-On-Behalf-Of: <who>`, such as a dashboard user's name. The server stores it as given and never uses it for access.
- An unknown or revoked token gets `401 unauthorized`; a `read` token on an `act` route gets `403 insufficient_scope`.
- Keep tokens off browsers: a web client calls the API from its server.

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

## Worktree base

A ticket starts from the tip of its remote's default branch, not from your checkout. Before planning, the controller asks `origin` (or the only remote) for its default branch, fetches it into `refs/remotes/<remote>/<branch>`, and adds the worktree on a new `factory/<slug>` branch at that commit. Plan, work, QA, review, and wrap-up all run in that worktree, so the planner reads the code the workers change, and pull requests merged since your last `git pull` are included. Your checkout, its branch, and its local `main` never move.

- A repository without a remote starts from the code root's `HEAD`, as before.
- With several remotes and none named `origin`, the ticket stops and asks you to name one `origin`.
- A remote that cannot be reached, or a fetch that fails, stops the ticket before planning with git's error, as a failed worktree step. `/factory retry` tries again. Git never prompts: a password or host-key question fails the fetch.
- `.factory/` is untracked, so the worktree has none. Plan files still go to `.factory/tickets/<slug>/` in the code root, and the planner's prompt names the factory root. They stay there after the worktree is removed.
- A ticket started before this change keeps planning in the code root and gets its worktree when its plan is accepted.

## Worktree setup

Each ticket works in its own git worktree, which starts without installed dependencies. `worktree.setup` lists commands the controller runs once in each new worktree, in order, before its first agent (the planner), so agents, validation, and QA start from a ready tree. Each command takes a `name`, an `argv`, and an optional `timeoutMs` (10 minutes by default).

- Use a command that reuses a cache, so each ticket links dependencies instead of downloading them: `pnpm install --frozen-lockfile --prefer-offline` (pnpm's global store makes it mostly hard links), `npm ci --prefer-offline`, `uv sync --frozen`, `bundle install --local`, or `cargo fetch --locked`.
- Each worktree gets its own dependencies, matching its branch's lockfile, so a ticket that changes them cannot affect another ticket or your checkout.
- A command that fails, times out, or cannot start stops the ticket with its output, as a failed worktree step. `/factory retry` runs the setup again in the same worktree.
- An execution keeps the setup it started with; a change to `FACTORY.json` applies to tickets started after it.

## Tracker and code host

The factory reads issues through a **tracker** and pull requests through a **code host**, configured in `FACTORY.json` as `tracker` and `codeHost`. Each is an adapter behind a fixed interface; GitHub is the only one so far, and it works through the `gh` CLI. An operation an adapter cannot do fails with "not supported", and asking for one in `FACTORY.json` stops the server at startup. The old `github` and `keys` blocks are refused with a message saying what replaced them.

- `tracker` resolves issue refs: an issue URL, `owner/repo#n`, or `#n` for the configured repository. Local markdown or JSON files and `--text` tickets bypass it.
- **Parent and blocking links must be native.** The factory reads GitHub's sub-issues and "blocked by" links, not `## Parent` or `## Blocked by` headings in an issue body. An issue with sub-issues is an umbrella: start each sub-issue instead.
- **Tracker updates.** For a ticket that came from the tracker, the factory comments on its issue when it starts, when it pauses for a person (with the question and how to answer), and at handoff (with the pull request link). `tracker.status` maps `in_progress` and `in_review` to labels, such as `{ "in_progress": { "label": "factory:in-progress" } }`; create the labels in the repository first. An unmapped status is not written. Updates go through the outbox and retry; each comment carries a hidden marker, so a retry never posts twice. A tracker that keeps failing leaves a warning in the ticket's `trackerWarnings` and never pauses or fails the ticket. A `tracker.status` the tracker cannot write stops the server at startup.
- `codeHost.pullRequests` is on unless it is `false`. When it is on, wrap-up commits the approved work, pushes the branch, and opens or updates the pull request.
- When wrap-up validation passes, the pull request it checked becomes the ticket's. A ticket with none recorded, such as one you opened by hand, is found later by its branch.
- The server checks the pull request of every ticket in handoff at startup and then every `codeHost.syncMinutes` (10 by default), and stores its reviews and commits. A merged pull request completes the ticket, recorded as done by `code-host`; one closed without merging cancels it with reason `pull_request_closed`. `/factory complete` still works by hand.
- Webhooks make that faster. Set `codeHost.webhookSecretEnv` to the name of an environment variable holding the secret, then point a GitHub webhook for **Pull requests** and **Pull request reviews** at `POST /v1/webhooks/github` with that secret. A delivery needs no token; its `X-Hub-Signature-256` must match, or it gets `401`. Deliveries about pull requests no ticket has are accepted and ignored. The periodic sync stays on as a backstop, because GitHub does not retry a failed delivery.

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
  "name": "factory-skills on Sonnet",
  "models": { "work": "work-model", "review": "review-model" },
  "tracker": {
    "kind": "github",
    "owner": "geut",
    "repo": "factory-skills",
    "backlog": { "labels": ["factory"] }
  },
  "codeHost": { "kind": "github", "owner": "geut", "repo": "factory-skills", "pullRequests": true },
  "server": { "host": "127.0.0.1", "port": 7731 },
  "limits": { "workCorrections": 3, "reviewRounds": 3, "reviewCorrections": 3 },
  "stages": {
    "qa": {
      "enabled": true,
      "commands": [{ "name": "e2e", "argv": ["npx", "playwright", "test"] }]
    }
  },
  "worktree": {
    "setup": [
      { "name": "install", "argv": ["pnpm", "install", "--frozen-lockfile", "--prefer-offline"] }
    ]
  },
  "validation": {
    "work": { "commands": [{ "name": "tests", "argv": ["npm", "test"], "timeoutMs": 300000 }] },
    "qa": { "commands": [{ "name": "lint", "argv": ["npm", "run", "lint"] }] },
    "wrapup": { "generated": ["docs/api/", "*.snap"] }
  }
}
```

The API is the contract for clients outside this package. Only the server and Pi read SQLite; its views, such as `current_ticket_executions`, `ready_task_frontier`, and `open_attention`, are documented in [`src/state/README.md`](src/state/README.md) as internal. The controller does not emit a JSON state file.

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
