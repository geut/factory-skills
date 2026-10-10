# ADR-001: Deterministic factory controller and durable execution model

- **Status:** Accepted — implementation in progress
- **Date:** 2026-10-06
- **Scope:** `factory-skills` and the factory runtime in `sbx-shell-pi`
- **Supersedes:** The prose-driven `factory-supervise` workflow and the legacy `fstate` CLI/schema

## Context

The first Factory design placed most coordination in the `factory-supervise` skill. A supervisor model was responsible for remembering the workflow, launching agents, selecting the next stage, relaying questions and review findings, enforcing loop limits, updating state, and deciding when work was complete.

That arrangement made critical behavior probabilistic. A supervisor could omit a call, launch a duplicate child, misread an output, lose a question, or spend tokens reasoning about a transition that code could determine exactly. It also made concurrent tickets, restart recovery, validation, usage accounting, and dashboard state unnecessarily difficult.

The Factory still needs model judgment for research, implementation, and code review. It does not need model judgment for workflow mechanics. Skills should describe how a specialist behaves; executable code should control when that specialist runs and whether its output is accepted.

## Decision

Replace model-supervised coordination with a deterministic controller backed by SQLite.

The Factory will have four distinct responsibility layers:

1. **Controller code** owns commands, state transitions, limits, task selection, and orchestration policy.
2. **Stage skills** govern the behavior of plan, work, review, and wrap-up agents.
3. **Runtime code** launches Pi children in Herdr, owns their lifecycle watchers, and reports typed outcomes directly to the controller.
4. **Validators and action workers** perform hard checks and external side effects.

There is no `factory-supervise` skill, supervisor agent, supervisor pane, or model call whose job is to continue the workflow. There is no required `factory_continue` tool call. Once started, the controller advances the ticket from persisted events and validated outputs.

## System boundary

The initial controller runs as deterministic TypeScript loaded by a thin Pi extension in the long-lived parent Pi process. The extension registers `/factory` commands and calls an internal controller interface. A public or programmatic command API is outside v0 and may be added later without changing controller semantics.

```text
Human
  │ /factory command
  ▼
Pi extension ──► FactoryController ◄────────► SQLite
                       │                         ▲
                       │ creates leased action   │ lifecycle event,
                       ▼                         │ validation, usage
                Action dispatcher                │
                       │                         │
                       ▼                         │
              FactorySubagentRuntime ───────► Herdr pane
                                                  │
                                                  ▼
                                          Pi child + stage skill

Dashboard SBX Kit mixin ──read-only views────────► SQLite
```

`sbx-shell-pi/factory` assembles the container and runtime environment. Herdr owns panes and processes. Pi executes the role sessions. The subagent package is a replaceable transport implementation. `factory-skills` owns the skills, controller, state, validation, and runtime adapter.

## Responsibility boundaries

### FactoryController

The controller owns:

- ticket commands and idempotency;
- legal execution, task, and review transitions;
- dependency-ready task selection;
- stage input construction and hashing;
- correction, review, and infrastructure retry limits;
- durable questions, answers, and pause reasons;
- action creation and event processing;
- scheduling validators and accepting their results;
- deciding the next deterministic action.

The controller does not research the ticket, design a solution, write code, or review code quality.

### Stage skills

Stage skills own specialist judgment and return a versioned structured result:

| Skill            | Responsibility                                                                                                                                                                           | Durable or validated output                                                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `factory-plan`   | Research the ticket, clarify ambiguity, and produce the smallest useful plan.                                                                                                            | `plan.md`, optional `adr.md`, one or more numbered task files, structured task/dependency data.                                                                     |
| `factory-work`   | Design and implement one ready task, normally behavior-first and test-driven.                                                                                                            | An uncommitted worktree diff. The controller accepts it when the diff and trusted commands pass.                                                                    |
| `factory-review` | Perform a read-only adversarial review with a model different from the worker.                                                                                                           | Structured findings and `approve`, `changes_requested`, or `blocked` verdict.                                                                                       |
| `factory-wrapup` | Update durable knowledge, prepare the approved work for handoff, retain the landing context, and apply concrete pull-request feedback until the pull request reaches a terminal outcome. | Summary, artifact changes, usage table, merge commands, documentation updates, useful visual evidence, verified feedback changes, and pull-request landing context. |

A stage agent never launches the following stage and never mutates operational state directly.

Planning should use a grill-with-docs style of questioning when the ticket is too ambiguous to plan safely. That clarification uses the same durable `caller_ping` flow as any other stage.

### FactorySubagentRuntime

The runtime adapter owns:

- launching, resuming, and interrupting a child;
- Pi session and Herdr pane identities;
- descriptive pane names such as `PROJ-123 · work T01`;
- exactly one lifecycle watcher per child run;
- translating runtime termination into a typed controller event;
- collecting the session path and raw usage needed for accounting;
- reconciling runtime state before retrying an uncertain launch.

Factory children are launched through this adapter, not through the ordinary model-facing `/subagent` path. Their results must never steer or wake an orchestrator model. Runtime callbacks or awaited outcomes go directly to controller code.

### Validators and action workers

Validators own mechanical truth. Depending on the stage and project policy, they check:

- required artifacts and paths;
- task dependencies;
- the worktree diff and configured commands;
- tests, lint, type checks, and project-specific verification;
- reviewer isolation, packet freshness, and read-only policy;
- wrap-up handoff completeness.

Cyclomatic complexity, end-to-end tests, and similar checks are applied when relevant and configured; they are not universal requirements.

Action workers perform effects after state commits: fetching a ticket, preparing a worktree, launching or resuming a run, notifying the user, running validation, opening a diff, observing pull-request state, or updating an external ticket when authorized.

## Deterministic stage flow

The stage path is fixed:

```text
plan → work(task) → review(task) ──approve──► next ready task
           ▲              │                        │
           └──changes─────┘                        │ no tasks remain
                                                   ▼
                                                wrapup
                                                   │↺ actionable PR comment:
                                                   │  wrapup run → hard validation
                                                   │
                         accepted/merged ──────────┤──► done / complete
                         closed/rejected ──────────┘──► done / cancelled
```

`waiting_for_user`, `paused`, `resume_failed`, and `failed` are execution statuses; they do not erase the stage where attention is required.

“Select the next stage” is a pure controller decision:

- accepted plan → lowest dependency-ready task in `work`;
- accepted work result → `review` for that task;
- `changes_requested` within the review limit → return the same task to `work`;
- approved task with another dependency-ready task → `work` for that task;
- approved final task → `wrapup`;
- accepted initial wrap-up that still needs a human submission action → `wrapup / ready_for_handoff`;
- an attached, open pull request → keep the execution in `wrapup / active` while awaiting provider events;
- an actionable pull-request comment → keep the execution in `wrapup`, resume the wrap-up session with that exact comment as input, and hard-validate the concrete change;
- verified feedback changes that still need a human commit, push, or PR update → `wrapup / ready_for_handoff`;
- an updated pull-request head observed after the change is submitted → `wrapup / active` while awaiting further provider events;
- a provider-specific successful terminal outcome such as accepted/merged → `done / complete`;
- a closed or rejected pull request without acceptance → `done / cancelled`, preserving the reason.

v0 allows one active task and one active child for each ticket execution. Different tickets can progress concurrently.

“Wrap-up remains open” describes the landing lifecycle, its attached pull-request record, and its reusable Pi context. The execution stays in `wrapup` while concrete feedback is applied. No agent process must run or poll continuously while the pull request is idle. Pull-request webhooks, bounded polling actions, or explicit refresh commands become controller events; the exact event source is an integration detail.

## One lifecycle for every stage

Every plan, work, review, and wrap-up run follows the same code-owned lifecycle:

1. Load the current ticket execution.
2. Resolve and freeze canonical inputs.
3. Check stage preconditions and the resolved agent policy.
4. Persist the intended run and its launch action in one transaction.
5. Lease the action and launch one child.
6. Arm exactly one controller-owned watcher.
7. Receive exactly one terminal runtime event.
8. Record the terminal output.
9. Run hard validation. Plan acceptance is the local `plan.md` and task files. Work acceptance is the diff plus the trusted commands in `validation.work.commands`. A pass is not bound to a result hash.
10. Transactionally choose one outcome:

- accept and advance;
  - send a concrete bounded correction to the same logical session;
  - persist a user question;
  - schedule an infrastructure retry;
  - pause; or
  - fail.

11. Dispatch newly committed actions after the transaction completes.

The controller does not hold a database transaction open while launching a pane, running commands, notifying a user, or performing any other external effect.

## Child lifecycle contract

Each process/pane launch is an **agent run** and ends in exactly one terminal kind:

- `subagent_done`;
- `caller_ping`;
- `launch_failed`;
- `crashed`;
- `completed_user_exit`;
- `pane_killed`;
- `gap_exit`;
- `cancelled`.

`subagent_done` means only that candidate output arrived. Two different facts must remain distinct:

1. the child emitted a terminal result;
2. stage validation passed.

Only the second fact permits the controller to advance. Plan validation inspects the files in the factory root. Work validation inspects the worktree diff and runs the configured commands. Neither acceptance depends on parsing a result contract or matching a result hash.

`caller_ping` is terminal for that run. The controller stores an attention request before notifying the user and changes the execution status to `waiting_for_user`. The question must be visible in the main Factory UI and retrievable with Factory status even if a notification is missed.

A logical **agent session** represents one Pi conversation. A resume, validation correction, review-change pass, pull-request-feedback action, manual continuation, or infrastructure retry creates a new **agent run** while reusing the appropriate session. A pull-request comment creates a new run in the wrap-up session with purpose `pr_feedback`. Review `semantic_round` is separate from infrastructure attempts, malformed-output corrections, and PR-feedback runs.

Only one watcher may own a Factory child. Duplicate terminal events are deduplicated, and only one terminal runtime event is accepted for each run.

## Review and correction policy

Review is deliberately adversarial but bounded:

- one reviewer runs read-only on a model different from the worker;
- every review receives an exact, fresh packet, diff, plan/task context, and verification evidence;
- findings are structured, prioritized, locatable, and tied to the ticket;
- approval requires no blocking findings;
- blocking findings return to the existing work session as focused input;
- the default maximum is three semantic review rounds;
- launch failures and other infrastructure retries do not consume a review round;
- unresolved blockers after the limit pause the execution and ask the human what to do.

There is no arbiter agent in v0. The controller arbitrates mechanics—valid results, limits, and legal transitions—but does not overrule technical disagreement. The user resolves disagreement that remains at the review limit. This internal `factory-review` loop applies before the pull request enters its landing lifecycle.

Pull-request comments are already outputs of an external review process performed by a human or another agent. They do not start another internal `work → review` cycle. Each actionable provider comment is persisted and deduplicated by its provider event/comment ID. The controller resumes the wrap-up session with the exact comment body, author, URL, affected location, and pull-request head revision as immutable input, plus only the landing context required to make that concrete change.

`factory-wrapup` uses the same model as `factory-work`, but retains its separate skill and responsibility. A PR-feedback run may modify tests, code, and documentation only as required by the comment. Its result must pass the configured hard checks—such as result-contract validation, relevant tests, lint, type checks, and diff-scope checks—but it does not launch `factory-review`. The external reviewer evaluates the updated pull request and may produce another provider event. Ambiguous, conflicting, or materially broader requests cause `caller_ping` rather than speculative implementation. Feedback cycles are bounded by policy and pause for the user when the budget or correction limit is reached.

Detailed review transcripts do not require a permanent review directory. The normalized review result lives on the review run; the task projects its latest round, verdict, finding count, and blocking count.

Validation corrections and action retries are also bounded, but their exact defaults remain project policy rather than being conflated with the three review rounds.

## Command semantics

### Start

The intended kickoff is:

```text
/factory start PROJ-123
```

The input may identify an issue-tracker ticket by qualified reference or URL, a local Markdown/JSON ticket, or supplied text. Tracker adapters share one resolver contract. v0 ships with GitHub first; Jira, Linear, GitLab, and other providers can be added without changing controller semantics. File and text sources remain valid v0 inputs.

Before an execution is created, the selected source adapter must return:

- a canonical ticket ID stored in `tickets.id`;
- a human-facing display reference such as `geut/factory-skills#123` or `PROJ-123`;
- a canonical source reference;
- a normalized ticket snapshot, source revision when available, content hash, and fetch time.

For tracker-backed tickets, `tickets.id` is provider-qualified and globally unique:

```text
<provider>:<instance>:<provider-defined-stable-id>
```

The provider-defined component includes project/repository scope only when the provider's immutable ID requires it for uniqueness. For example, a GitHub adapter resolves a URL or shorthand to the GitHub host and immutable issue identity; `owner/repository#number` remains a display reference. Jira and Linear adapters similarly combine their instance/workspace with the provider's immutable issue ID rather than relying only on a mutable human key. Components are encoded canonically; different URLs or aliases for the same issue must produce the same `tickets.id`.

A full URL selects its adapter and scope. A provider-qualified reference does the same. A bare key is accepted only when `FACTORY.json` maps it to exactly one configured provider instance/project; zero or multiple matches return an actionable error or clarification without creating an execution. File and text inputs require an explicit local ticket ID and use a repository-scoped `local` identity.

The canonical ID is not used directly as a directory name. `ticket_executions.factory_dir` stores a path-safe slug derived from the display reference plus a short canonical-ID hash, preventing collisions across providers and projects.

The normalized snapshot is frozen on the execution in `input_json`, `input_hash`, and `input_fetched_at`. A tracker edit after startup therefore cannot silently change the inputs to an existing execution.

`start` is idempotent for the resolved canonical ticket identity, not for the literal command argument. Repeating it through a different URL or alias never launches a second child, resumes a question, retries a failure, or silently creates a new generation.

| Current state                      | Repeated `start` behavior                                           |
| ---------------------------------- | ------------------------------------------------------------------- |
| Queued, active, or resuming        | Return the current execution and status; do nothing else.           |
| Waiting for user                   | Return the persisted question and reply instructions.               |
| Paused                             | Return the pause reason and the explicit recovery options.          |
| Resume failed or retryable failure | Return the failure; require an explicit retry.                      |
| Non-retryable failure              | Return the failure and stop; v0 does not create another generation. |
| Ready for handoff                  | Return the handoff state; do not mark it complete.                  |
| Complete or cancelled              | Return the existing generation; v0 does not reopen it.              |

The schema retains execution generations so a future explicit rerun can preserve history, but `/factory rerun` is outside v0. `start` never emulates rerun, and operators must not create a new generation through direct database edits.

### Questions, replies, and retry

`/factory reply` stores an immutable, versioned answer before it queues a resume action. If the resume launch fails, the answer remains current and the execution records `resume_failed`. `/factory retry` creates a new run/action and reuses the stored answer; the user does not have to type it again.

A new reply version is created only when the user intentionally changes the answer. Idempotency keys make duplicate command delivery safe.

The final names and detailed policy for status, pause, continue, cancel, and human completion commands remain an implementation decision. They call the internal controller interface. A public command API and external programmatic command triggers are outside v0; internal runtime, validator, action, and pull-request provider events remain part of v0 orchestration.

## Authoritative SQLite state

SQLite at `.factory/db/state.sqlite` replaces the old `fstate` CLI/schema and any writable JSON state file. There is no in-place migration. A legacy, partial, or unrelated database is rejected without modification and the operator is told to back it up or remove it.

The database uses foreign keys, WAL, a busy timeout, strict tables, an application ID, and a schema version.

### Logical schema

```text
tickets
  └── ticket_executions (generation; exactly one current)
        ├── tasks ─── task_dependencies
        ├── agent_sessions
        │     └── agent_runs
        │            ├── validation_runs ─── validation_checks
        │            └── usage_snapshots
        ├── attention_requests ─── attention_replies
        ├── pull_requests
        ├── actions
        └── events
```

| Table                                     | Purpose                                                                                                                                                                       |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema_meta`                             | Identifies the schema version.                                                                                                                                                |
| `tickets`                                 | Provider-qualified canonical ticket identity, display/source metadata, and parent relationship.                                                                               |
| `ticket_executions`                       | Explicit generations, frozen source snapshot/hash/fetch time, current stage/status, policy, paths, worktree state, and optimistic version.                                    |
| `tasks`, `task_dependencies`              | Ordered plan slices and their dependency-ready frontier.                                                                                                                      |
| `agent_sessions`                          | Logical Pi conversations reused across resumes.                                                                                                                               |
| `agent_runs`                              | Individual pane/process attempts, lifecycle result, hashes, and semantic round.                                                                                               |
| `attention_requests`, `attention_replies` | Durable questions and immutable, versioned answers.                                                                                                                           |
| `pull_requests`                           | Attached provider/repository/PR identity, current head revision, normalized provider state, and terminal outcome for the landing stage.                                       |
| `actions`                                 | Idempotent transactional outbox with compare-and-set leases.                                                                                                                  |
| `events`                                  | Deduplicated command, runtime, provider, and domain events—including exact PR comments—with a monotonic observation cursor.                                                   |
| `validation_runs`, `validation_checks`    | Checks for a finished run. A pass requires a terminal `subagent_done`, at least one passed check, and no failed, errored, or skipped check. It is not bound to a result hash. |
| `usage_snapshots`                         | Cumulative Pi usage and computed per-run deltas.                                                                                                                              |

Stage output may be stored on `agent_runs.result_json`. `result_status = valid` means a parser accepted that output; it does not mean stage validation passed. Work runs stay `pending` and keep the raw reply. A passed `validation_run` is the separate acceptance record and becomes immutable with its checks. Plan acceptance is the local plan files. Work acceptance is the diff plus trusted commands.

The core v1 state vocabularies are deliberately closed:

| Record               | States                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Execution stage      | `plan`, `work`, `review`, `wrapup`, `done`                                                                                            |
| Execution status     | `queued`, `active`, `waiting_for_user`, `paused`, `resuming`, `resume_failed`, `failed`, `ready_for_handoff`, `complete`, `cancelled` |
| Task status          | `pending`, `working`, `ready_for_review`, `reviewing`, `done`, `blocked`, `cancelled`                                                 |
| Agent-session status | `prepared`, `open`, `completed`, `abandoned`                                                                                          |
| Agent-run status     | `prepared`, `starting`, `running`, `terminal`                                                                                         |
| Review verdict       | `approve`, `changes_requested`, `blocked`                                                                                             |

Stages describe where an execution is in the workflow. Statuses describe its operational condition. Keeping those concepts separate allows, for example, a planning execution and a review execution to both be `waiting_for_user` without inventing additional stages.

### Concurrency and durability rules

- One current execution exists per stable ticket.
- One task and one agent run may be active per execution in v0.
- Different ticket executions may run concurrently.
- Reducers use narrow `BEGIN IMMEDIATE` transactions and compare the execution version.
- A state change and every action it requires commit together.
- Dispatchers claim actions with compare-and-set leases and idempotency keys.
- An expired launch lease is reconciled with Herdr before retrying; it never blindly opens another pane.
- Runtime and command inputs are deduplicated.
- Provider events are deduplicated by provider, installation/repository scope, and immutable event or comment ID.
- v0 allows one active attached pull request per execution; its historical terminal record is retained.
- Terminal runs, accepted validations, and completed actions are immutable.
- The global event revision is a dashboard/change cursor, not a global write lock.

### Usage accounting

Pi usage is cumulative for a logical session. Every terminal run records the cumulative snapshot and a delta from the prior snapshot:

- input tokens;
- output tokens;
- cache-read tokens;
- cache-write tokens;
- total tokens;
- context tokens/window;
- cost in integer USD micros.

Latest cumulative snapshots provide ticket totals. Run deltas provide per-stage and per-attempt analysis without double-counting resumed sessions.

## Project organization

The Factory is the overall system, not a directory for one piece of work. A ticket is the external work item, and a task is one planned implementation slice.

### Product repository

The default Factory root is a repo-local, untracked `.factory/` directory:

```text
<code-repository>/
├── .factory/                         # untracked operational knowledge
│   ├── CONTEXT.md
│   ├── FACTORY.json                  # policy/configuration, never live state
│   ├── PRD.md                        # optional
│   ├── db/
│   │   └── state.sqlite              # authoritative live state
│   ├── tickets/
│   │   └── PROJ-123/
│   │       ├── plan.md
│   │       ├── adr.md                 # optional; retained for skill compatibility
│   │       ├── 01-task-foundation.md
│   │       └── 02-task-behavior.md
│   └── learnings/                     # promoted reusable lessons only
└── product code and tests
```

The code root is derived from the Git repository and the default Factory root is `<code-root>/.factory`; `FACTORY.json` does not need mandatory machine-specific `companyRoot` and `codeRoot` absolute paths. An explicit Factory-root override may support unusual layouts later.

`PROJ-123` in the example is a display-oriented directory slug, not necessarily `tickets.id`. The controller records the resolved absolute path in `ticket_executions.factory_dir` and adds a short canonical-identity hash whenever needed to prevent collisions between providers, instances, repositories, or projects.

The minimal durable layout intentionally excludes per-ticket `state.json`, `reviews/`, `handoffs/`, `visuals/`, `decisions.md`, and `wrapup.md` directories. Detailed conversations and reviews remain in Pi sessions. Structured operational results live in SQLite. Visual or handoff artifacts are persisted only when they are genuine evidence or are explicitly promoted. `learnings/` contains reusable, human-approved knowledge rather than an automatic transcript dump.

### `factory-skills` repository

The implementation is organized by responsibility:

```text
factory-skills/
├── skills/                 # specialist behavior only
├── src/
│   ├── extension/          # thin /factory command and Pi lifecycle entry point
│   ├── controller/         # commands, reducer, stage/task transition policy
│   ├── state/              # SQLite schema, access, queries, and migrations
│   ├── actions/            # leased external-effect dispatcher
│   ├── runtime/            # subagent/Herdr interface and adapter
│   └── validation/         # result contracts and hard stage checks
└── tests/
```

Exact filenames may change; these boundaries are architectural.

## Dashboard

SQLite is the authoritative operational state store. The separately developed dashboard is delivered through an SBX Kit and attached to the Factory sandbox as a mixin. Its database access is always read-only. Factory correctness and progress do not depend on the dashboard being installed or available.

The dashboard reads a versioned observation contract rather than treating every internal table as a stable API. That contract consists of dedicated read-only views, `schema_meta` compatibility information, and the monotonic `events.revision` change cursor. The dashboard must reject unsupported schema versions. It opens the live database through the mounted `.factory/db/` directory so SQLite WAL state is observed; it must not copy and read `state.sqlite` in isolation.

`FACTORY-STATE.json` is deprecated and is not generated or consumed in v0. There is no projection action or projection module in the v0 design.

The dashboard cannot update tables, enqueue actions, or bypass controller validation. Dashboard-triggered actions and a public Factory API are outside v0. If added later, they must submit commands through a controller-owned API with the same authorization, idempotency, transition, and event rules as `/factory`; database access remains read-only.

## Handoff and pull-request landing boundary

Successful initial wrap-up does not silently mean `done`. If the human still needs to create, attach, or otherwise prepare the pull request, the execution remains at `stage = wrapup`, `status = ready_for_handoff`.

Wrap-up provides:

- a concise explanation of the change;
- files added, modified, and removed;
- verification and review results;
- token and cost usage by stage;
- commands the human can later use to commit or merge the worktree;
- durable documentation updates;
- a named Fresh pane showing the current diff;
- the wrap-up Pi session left visible for inspection;
- durable pull-request identity and landing context once a pull request is attached.

Once a pull request is attached, wrap-up begins a long-lived landing lifecycle that remains open until the provider reports a terminal successful outcome such as accepted/merged, or a terminal unsuccessful outcome such as closed/rejected. Waiting for provider activity consumes no agent tokens and does not require a child process to remain active.

When a reviewer or user leaves an actionable comment, the controller persists that exact provider event and resumes the wrap-up session with the comment as its primary input. The wrap-up agent applies the concrete request and the controller runs the configured hard validation; no internal `factory-review` run follows because review is occurring on the pull request. The wrap-up context and pane stay available throughout the landing cycle, and wrap-up uses the same model configured for the worker while keeping its distinct skill. If project policy does not authorize committing, pushing, or updating the pull request, the execution returns as `wrapup / ready_for_handoff`; it becomes `wrapup / active` again only after the provider reports a pull-request head containing the verified change.

Commit, push, pull-request creation or update, ticket mutation, merge, branch deletion, and worktree removal require explicit project policy or human action. A successful provider terminal outcome moves the execution to `done / complete`. A closed or rejected pull request moves it to `done / cancelled` with its reason preserved. When the integration cannot determine whether an outcome is terminal or acceptable, it asks the user rather than guessing.

## Runtime dependency boundary

The controller depends on a `FactorySubagentRuntime` interface rather than a specific subagent package.

`pi-herdr-subagents` is the initial integration candidate because it has a narrow Herdr-native launch/watch path. The adapter must call the programmatic launch/watch machinery and consume events itself; the package's normal parent-model steering path must not own Factory children.

`edxeth/pi-subagents` is a useful alternative and design reference. It offers separate internal launch/watch/steer layers, typed results, stronger pane visibility, timeouts, policy controls, and resume metadata. It is not adopted directly yet because it lacks a supported controller-facing API, its interactive `subagent_done`/`caller_ping` behavior does not match the Factory contract, normal-run restart adoption is incomplete, and its current Herdr integration relies on shell readiness and polling.

Changing the runtime adapter must not change controller, database, stage, or result-contract semantics.

## Budget and policy

Budget is a first-class operational concern:

- models are selected per stage;
- wrap-up uses the configured worker model while retaining a separate wrap-up skill;
- the reviewer uses a different model from the worker;
- review, validation correction, and action retries are bounded separately;
- pull-request feedback cycles are bounded and wait without an active model run;
- token, cache, context, and cost use is persisted;
- agents receive only the context required for their stage;
- reflective improvements become proposals and require human approval—skills never rewrite themselves automatically.

## Consequences

### Benefits

- Progress no longer depends on a supervisor model remembering the next call.
- Coordination uses fewer tokens.
- Duplicate starts, children, replies, and terminal events can be rejected mechanically.
- Questions and answers survive pane or process failures.
- Review and correction budgets are enforceable.
- Parallel tickets are observable without sharing a global workflow lock.
- Plan acceptance is the local plan files. Work acceptance is the diff plus trusted commands, without a result-hash binding.
- The subagent runtime can be replaced behind an interface.
- The dashboard observes a versioned read-only contract over one authoritative state store.
- Pull-request feedback uses a scoped, hard-validated wrap-up action while leaving review to the external PR reviewer.

### Costs

- The project must implement and maintain a controller, dispatcher, validators, reconciliation, and SQLite migrations.
- Runtime integration may require a pinned internal adapter or an upstream API.
- Result contracts and skills must evolve together.
- Restart recovery is more explicit and therefore requires deliberate testing.
- Hard checks require project-specific configuration to remain useful rather than ceremonial.
- Pull-request landing adds provider-event ingestion, long-lived execution state, and another bounded feedback loop.

## Rejected alternatives

- Keep `factory-supervise` as the workflow authority.
- Require a supervisor model to call `factory_continue`.
- Treat agent prose, an idle pane, or process exit as proof of success.
- Allow stage agents to launch subsequent stages or edit live controller state.
- Generate or consume `FACTORY-STATE.json`; the projection is deprecated and absent in v0.
- Allow the dashboard or another integration to write controller tables directly.
- Perform Herdr or external side effects inside a database transaction.
- Let both controller code and model steering watch the same child.
- Add an arbiter model to every review loop.
- Persist a directory of detailed reviews, handoffs, and visuals for every ticket.
- Run unlimited review, pull-request feedback, correction, or infrastructure retry loops.
- Commit, merge, publish, or clean up automatically without explicit policy.
- Couple controller semantics to one subagent package.

## Open implementation decisions

These items are intentionally not resolved by this ADR:

1. **Runtime backend:** whether the first production adapter uses a pinned internal `pi-herdr-subagents` boundary, an upstream API, or a modified `pi-subagents` runtime.
2. **Restart adoption:** how a restarted parent reconciles running panes, closes the event gap, re-arms exactly one watcher, and safely reclaims expired actions.
3. **Notification sink:** how `notify_attention` surfaces a persisted question without a model turn in interactive and future headless environments.
4. **Initialization:** whether `.factory/` and the database are created by `/factory init` or lazily by the first `start`.
5. **Configuration schema:** the versioned `FACTORY.json` fields for models, budgets, limits, verification commands, source integration, and authorization.
6. **Correction limits:** default automatic counts for malformed results, failed validation, and infrastructure retries.
7. **Result wire format:** whether terminal tools carry canonical JSON directly or the controller extracts it from a session result; it must be versioned, deterministic, and hashable.
8. **Worktree policy:** naming, base ref, adoption after restart, future-generation behavior, and cleanup authorization.
9. **Remaining command names:** exact status, pause/continue, cancel, and handoff-completion commands and their permissions.
10. **Pull-request integration:** webhook versus bounded polling, provider-event persistence, comment-to-task mapping, accepted/rejected semantics, and authorization for commit, push, pull-request, merge, and ticket mutations.
11. **Dashboard read contract:** the exact versioned view set, SBX Kit mount/permission details, and refresh behavior based on `events.revision`.
12. **Public API:** authentication, authorization, and command/result contracts for any post-v0 programmatic action surface.
13. **Rerun:** the post-v0 command and quiescence policy for creating execution generation N+1.

## References

- [factory-skills](https://github.com/geut/factory-skills)
- [sbx-shell-pi](https://github.com/geut/sbx-shell-pi)
- [pi-herdr-subagents](https://github.com/modem-dev/pi-herdr-subagents)
- [pi-subagents](https://github.com/edxeth/pi-subagents)
- [Herdr agent automation](https://herdr.dev/docs/agent-automation/)
