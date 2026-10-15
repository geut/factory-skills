# PRD: Factory server with a REST API

- **Status:** Accepted
- **Date:** 2026-10-15
- **Decided in:** [Factory server with a REST API, auth, tracker ports, and stats](https://github.com/geut/factory-skills/issues/14). Each section links the ticket that holds its reasoning.
- **Build tickets:** sub-issues of [Factory server with a REST API](https://github.com/geut/factory-skills/issues/25)
- **Builds on:** [ADR-001](../../ADR.md), [ADR-003](../adr/0003-a-factory-server-owns-the-controller.md)

## Summary

The factory controller moves out of the Pi session into a **factory server** that serves a REST API. Pi, factory-dashboard, and code-host webhooks become clients. The API lets the dashboard become a command center:
- see tickets and the backlog
- start, reply to, retry, complete, cancel, stop, and rerun tickets
- read **factory stats**: how well the factory turns tickets into merged pull requests, by stage and model setup

Tracker and code host access goes behind two ports, so Linear or Jira can be added as adapters next to GitHub. Vocabulary is in [`CONTEXT.md`](../../CONTEXT.md).

## Goals

- The factory keeps running, and can be driven, without a Pi session open.
- factory-dashboard reads and acts only through a documented, typed API. It never opens the database.
- Every command records which client sent it.
- Pull request outcomes after handoff (external review rounds, merge) are recorded and correlated to tickets.
- Stats are comparable across factories that run different `FACTORY.json` model setups.
- Tracker and code host code sits behind ports, with GitHub as the first adapter.

## Non-goals

- Dashboard screens. factory-dashboard owns them; see [Become a factory API client and command center](https://github.com/dpaez/factory-dashboard/issues/16).
- Linear and Jira adapters. Only the seam is built.
- Deployment, TLS, headless mode (no Herdr), users, and OAuth.
- Aggregating stats across factories. Only the export that makes it possible is built.
- The sbx-shell-pi kit changes, handed off as [Factory kit: start the factory server and connect the dashboard](https://github.com/geut/sbx-shell-pi/issues/7).

## 1. Factory server

Decided in [Factory server lifecycle and how Pi becomes a client](https://github.com/geut/factory-skills/issues/16) and [ADR-003](../adr/0003-a-factory-server-owns-the-controller.md). The facts behind it are in [Can the controller launch and watch agents without a parent Pi session?](https://github.com/geut/factory-skills/issues/15).

- **Process:** one server per factory root, started with `factory serve` inside a Herdr pane.
  - It owns the controller, the dispatcher, the run watchers, the PR sync, and the API.
  - It refuses to start outside Herdr.
  - It calls `pi` by absolute path.
- **One dispatcher:** an owner lease row in SQLite (instance id, URL, heartbeat).
  - A second server refuses to start while the lease is live.
  - Action leases carry the instance id instead of `'factory-controller'`.
  - Local clients find the server and check that it is alive through this row. There is no `server.json`.
- **Binding:** `server.host` and `server.port` in `FACTORY.json`. The default is `127.0.0.1` on a fixed port. The server warns when the host is not loopback, because it speaks plain HTTP.
- **Herdr layout:** the server pane's workspace is the factory workspace.
  - Each ticket gets a tab named after it, holding its agent panes and handoff panes.
  - Completing or cancelling a ticket closes its tab.
- **Lifecycle:**
  - On stop, the server stops dispatching, releases the lease, and leaves agent panes running.
  - On start, it takes the lease and runs `recover()`.
  - The move is a hard cut: there is no compatibility mode, and the first start adopts the existing database.
- **Handshake:** agents keep `subagent_done` and `caller_ping` from `src/runtime/child-handshake.ts`.

## 2. Pi as a client

Decided in [Factory server lifecycle and how Pi becomes a client](https://github.com/geut/factory-skills/issues/16).

- The extension never creates a `FactoryService` or dispatches.
- `/factory start|reply|retry|complete|cancel|stop|rerun` call the API with the `local` token. When no live lease exists, Pi reports "no server running, start it with `factory serve`".
- Pi reads SQLite directly for `status`, `ticket`, `agents`, cards, and the widget. Once a second it polls `events.revision`, re-reads on change, and renders cards for runs finished since its cursor.
- The SQLite views stop being a public read contract. Only the server and Pi read the database. `src/state/README.md` says so, and keeps documenting the views as internal.

## 3. API

Decided in [API surface v1](https://github.com/geut/factory-skills/issues/21). The facts behind it are in [Producing an OpenAPI 3.1 document from Zod with plain node:http](https://github.com/geut/factory-skills/issues/19).

### Conventions

- **Server and schemas:** plain `node:http` with Zod schemas.
- **OpenAPI document:**
  - OpenAPI 3.1, generated code-first with zod-openapi, committed as `openapi.json`, and served at `/openapi.json`.
  - A `node:test` file snapshot fails when the committed document drifts.
  - The SSE route is declared as `text/event-stream`, and every event payload is a named schema component.
  - The bearer scheme and each route's scope are declared.
- **Validation:** requests are always validated. Responses are validated only in tests and development.
- **Versioning:** a `/v1` prefix. `/health` and `/openapi.json` sit outside it and need no token.
- **Ticket key:** URLs use the factory directory slug (`<slug>-<hash8>`). Responses carry `id`, `displayRef`, and `sourceRef`, and `?ref=` looks a ticket up by reference.
- **Errors:** RFC 9457 `application/problem+json` with stable `type` codes: `ticket_not_found`, `umbrella_issue`, `not_waiting_for_reply`, `invalid_state`, `unauthorized`, `insufficient_scope`, `tracker_unavailable`, `validation_error`. A 400 lists problems per field.
- **Pagination:** cursor-based (`?limit&cursor`), only on collections that grow without bound: finished tickets, runs, and backlog pages.

### Reads (`read` scope)

| Route | Returns |
| --- | --- |
| `GET /v1/tickets` | Current execution per ticket: stage, status, progress, needs-user, actor, PR link, tracker update warnings. Filters are ANDed, and a repeated filter means OR: `status=open\|finished\|all`, `stage=<registry stage>\|done`, `state=<execution status>`, `needsUser=true`, `ref=`. |
| `GET /v1/tickets/{key}` | Adds tasks with dependencies and review state, open attention with replies, and usage totals. `?execution=n` selects a generation. |
| `GET /v1/tickets/{key}/executions` | Every generation of the ticket. |
| `GET /v1/tickets/{key}/runs`, `GET /v1/runs/{id}` | Purpose, round, outcome, model setup, timestamps, validation report and checks, review findings, usage, and the agent's latest activity text. |
| `GET /v1/agents` | Running agents. |
| `GET /v1/backlog?refresh=true` | Open tracker issues that are not yet tickets, flagged blocked or umbrella (with children). |
| `GET /v1/events` | SSE (see below). |
| `GET /v1/stats/*` | See section 7. |

### Commands (`act` scope)

| Route | Pi command |
| --- | --- |
| `POST /v1/tickets {ref}` or `{text, id}` | `/factory start` |
| `POST /v1/tickets/{key}/replies {answer}` | `/factory reply` |
| `POST /v1/tickets/{key}/retries` | `/factory retry` |
| `POST /v1/tickets/{key}/complete` | `/factory complete` |
| `POST /v1/tickets/{key}/cancel {reason?}` | `/factory cancel` |
| `POST /v1/runs/{id}/stop` | `/factory stop` |
| `POST /v1/tickets/{key}/reruns` | `/factory rerun` |

- A command returns `202 {ticket, revision}` once its transaction commits; `revision` is the committed `events.revision`.
- Problems found before the commit (resolution, an umbrella issue, the wrong state) come back synchronously as 4xx. Agent launches happen afterwards.
- The optional `Idempotency-Key` header maps to the controller's `dedupe_key`.
- The optional `X-Factory-On-Behalf-Of` header is stored with the actor, marked as unverified.

### Live updates

`GET /v1/events` streams thin events:
- `id: <revision>`, `event: <kind>`, `data: {ticket, task?, run?, actor?}`. Clients refetch what changed.
- The stream resumes from `Last-Event-ID` or `?since=`.
- A heartbeat comment is sent every 15 s.

## 4. Client authentication

Decided in [Client authentication](https://github.com/geut/factory-skills/issues/20).

- **API clients:**
  - `factory token create <name> --scope read|act` prints the token once.
  - `factory token list` and `factory token revoke <name>` manage the rest.
  - Rotating means create, then revoke.
  - Tokens are managed only through the CLI; the API has no admin scope.
- **Storage:** a SQLite table holds name, scopes, SHA-256 hash, created, last used, and revoked.
- **Local client:** the server creates a `local` client the first time it starts and writes `.factory/local.token` with mode `0600`.
- **Scopes:** `read` and `act`, where `act` includes `read`.
- **Transport:** `Authorization: Bearer` only. Tokens never reach a browser; the dashboard's server makes the API calls, including SSE.
- **Actor:** commands record the client name as `actor`, on `events` and on `attention_replies`, plus the unverified on-behalf-of value.
- **Webhooks:** webhook routes use the code host's signature check, not a token. Secrets come from the environment variable named by `codeHost.webhookSecretEnv`.

## 5. Tracker and code host ports

Decided in [Tracker and code host ports](https://github.com/geut/factory-skills/issues/18). The facts behind it are in [What GitHub, Linear, and Jira expose for backlog, issue links, and pull request state](https://github.com/geut/factory-skills/issues/17).

- **Shape:** a standard interface per port. Adapters translate each operation into native calls and declare their capabilities.
  - An operation an adapter cannot provide raises "not supported".
  - Config that asks for an unsupported capability makes the server refuse to start.
  - GitHub implements both ports through the `gh` CLI.
- **Config (hard cut):** `tracker` and `codeHost` replace `github` and `keys`.

  ```json
  "tracker":  { "kind": "github", "owner": "geut", "repo": "factory-skills",
                "backlog": { "labels": ["factory"] },
                "status": { "in_progress": { "label": "factory:in-progress" },
                            "in_review":   { "label": "factory:in-review" } } },
  "codeHost": { "kind": "github", "owner": "geut", "repo": "factory-skills",
                "pullRequests": true, "webhookSecretEnv": "FACTORY_GITHUB_WEBHOOK_SECRET" }
  ```

  - `pullRequests` defaults to `true`.
  - `KEY-123` means whatever the tracker says it means.
  - GitHub refs stay as `#n`, `owner/repo#n`, or a URL.
  - Local file and `--text` tickets bypass the tracker.
- **Tracker reads:**
  - `resolve(ref)`
  - `children(issue)` and `blockedBy(issue)`, using native links only. The dead `## Parent` / `## Blocked by` parser is deleted, and the README says native links are required.
  - `listBacklog(query)`. The backlog is fetched live with a ~60 s cache and a forced refresh, and is never mirrored into SQLite.
- **Tracker updates:**
  - `comment(issue, markdown)` and `setStatus(issue, in_progress|in_review)`.
  - They are written on start (comment and `in_progress`), on a pause that needs a person (comment with the question and the reply hint), on handoff (comment with the PR link and `in_review`), and on cancel (comment, and the status label removed).
  - An unmapped status is not written.
  - Updates run as outbox actions committed with the state change, then leased, retried, and made idempotent with a marker.
  - A failure is recorded as a warning and **never pauses or fails a ticket**.
- **Code host (read and verify):**
  - `pullRequest(url)`, `findPullRequest(branch)`, `pullRequestOutcome(pr)` (reviews with author, author type, state, commit, and time; merged and closed), and `verifyWebhook(headers, rawBody)`.
  - The wrap-up agent keeps opening the PR itself.
  - The PR is recorded on the ticket when wrap-up validation passes. Otherwise it is found by the ticket's branch.

## 6. Commands beyond v1

Decided in [Command center commands beyond v1: cancel, rerun, and stopping an agent](https://github.com/geut/factory-skills/issues/23).

- **Cancel:**
  - Closes the ticket's panes and tab.
  - Cancels pending actions, open attention, and active tasks.
  - Moves the ticket to `done / cancelled` with reason `cancelled_by_actor` and records the actor.
  - Keeps the worktree, branch, and PR.
  - Posts a tracker update.
- **Stop:**
  - Closes one agent's pane through Herdr, which implements the runtime's `interrupt`.
  - Ends the run with terminal kind `stopped`.
  - Pauses the ticket with reason `stopped_by_actor`. From there, `reply` resumes the same session, `retry` relaunches, and `cancel` ends the ticket.
- **Rerun (lower priority):**
  - Allowed only from complete, cancelled, or failed.
  - Follows ADR-001's guardrails: quiesce everything, then generation N+1 in one transaction.
  - Re-fetches the issue, and gets a new worktree and a branch suffixed `-r<n>`.
  - Always uses `FACTORY.json`; there is no model override.
- **Closed PR:** a PR closed without merging moves the ticket to `done / cancelled` with reason `pull_request_closed`, as ADR-001 specified. A merged PR completes it with actor `code-host`. `/factory complete` stays as the manual path.

## 7. Factory stats

Decided in [Factory stats model](https://github.com/geut/factory-skills/issues/22), amended by [Command center commands beyond v1](https://github.com/geut/factory-skills/issues/23).

### Facts stored

Measures are SQL views over raw facts:
- **New tables:**
  - pull requests: execution, url, state, merged/closed at, last synced
  - PR reviews: GitHub review id, author, author type, state, commit, submitted at
  - PR commits: sha, time
  - status history: execution, task, stage, status, from, to
- **On each execution:** `factory_version` (package version and git sha).
- **On the database:** a **factory id** (UUID), plus a display name from `FACTORY.json`.
- Webhooks and sync upsert by GitHub id.

### PR outcome sync

- The server polls each unfinished PR in handoff every 10 minutes (configurable) and at startup.
- It does one final sync after merge or close, then stops.
- Webhooks write the same tables. Sync stays as a backstop, because GitHub does not retry failed deliveries.

### Measures (`stats.v1`)

- **Units:**
  - A **model setup** is a model plus thinking level, per stage.
  - A **factory configuration** is the setups of every stage on a ticket.
  - Ticket outcomes are attributed to the factory configuration, never to one stage's model.
- **Stage measures (stage × model setup):**
  - first-pass acceptance
  - corrections per accepted output
  - returns to work, by sending stage
  - review rounds per task
  - tokens and cost per accepted output
  - agent time
  - infrastructure-lost attempts, kept apart
- **Times:**
  - lead time (start → merge, split at handoff)
  - factory time (start → handoff minus waiting)
  - waiting time
  - stage time (wall clock in a stage minus waiting; per task for work, QA, and review, summed across returns; per ticket for plan and wrap-up)
  - agent time
  - overhead (stage time minus agent time)
- **Human interventions**, counted separately: questions, limit pauses, replies, manual retries, manual completes, and stops.
- **External review rounds:** distinct PR commits with at least one non-approving review (changes requested, or a comment with a body) from anyone other than the PR author, split by human and bot. **Follow-up commits** are commits pushed after handoff.
- **Outcome:** merged, abandoned (`pull_request_closed`), cancelled (by a person), or unknown. Unknown outcomes count in process measures, but are excluded from merge rate and external review rounds.

### Routes (`read` scope; windows by ticket start)

`/v1/stats/summary`, `/v1/stats/stages?groupBy=setup`, `/v1/stats/configurations`, `/v1/stats/tickets?cursor`, and `/v1/stats/export` (NDJSON fact rows, one per ticket and per run, with factory id, version, and configuration). Every response carries `factoryId`, the factory versions seen, and `definitions: "stats.v1"`.

## Requirements handed to other repos

- **factory-dashboard**, handed off as [Become a factory API client and command center](https://github.com/dpaez/factory-dashboard/issues/16):
  - Drop `DB_URL` and the schema pin, and supersede the read-only ADRs.
  - Vendor `openapi.json` at a pinned commit and generate the client with openapi-typescript and openapi-fetch.
  - Hold the URL and an `act` token on the SvelteKit server. Consume SSE server-side and relay it to the browser.
  - Build the command center (stage columns, a needs-user inbox, backlog, the commands), the stats page, and the `X-Factory-On-Behalf-Of` header.
- **sbx-shell-pi:** [Factory kit: start the factory server and connect the dashboard](https://github.com/geut/sbx-shell-pi/issues/7).
