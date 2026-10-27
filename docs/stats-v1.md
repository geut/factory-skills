# Factory stats: `stats.v1`

Factory stats measure how well a factory turns tickets into merged pull requests, and which model setups do it best. Every `/v1/stats` response and every export line carries `definitions: "stats.v1"`, the `factoryId`, and the factory versions its tickets ran on. Two factories' numbers are comparable when their definitions match.

The measures are computed on every read from raw facts: status history, runs, usage, and the pull request tables. Nothing is stored pre-aggregated, so a change to a definition here recomputes all history. The code is [`src/stats/`](../src/stats). Windows (`from`, `to`) select tickets by their start time.

## Units of comparison

- **Model setup:** a model plus its thinking level, as used for one stage, such as `review-model · high`. Stage measures are grouped by model setup.
- **Factory configuration:** the model setup of every stage that ran on a ticket, such as `plan=… review=… work=… wrapup=…`. Ticket outcomes are compared per factory configuration, never credited to one stage's model.
- **Factory version:** the package version and commit that ran a ticket, such as `0.1.0+f28719d`. A `-dirty` suffix means uncommitted changes.

## Ticket outcome

| Outcome     | Meaning                                                                  |
| ----------- | ------------------------------------------------------------------------ |
| `merged`    | Its pull request merged.                                                 |
| `abandoned` | Its pull request was closed without merging (`pull_request_closed`).     |
| `cancelled` | A person cancelled it.                                                   |
| `unknown`   | It finished, but no pull request outcome was seen, such as a hand merge. |
| `open`      | It has not finished.                                                     |

**Merge rate** is merged over merged, abandoned, and cancelled. Open and unknown tickets are left out of it, not counted as failures. They still count in cost, tokens, time, and interventions.

## Ticket measures

All times are in milliseconds.

- **Lead time:** start to merge, split into **start → handoff** and **handoff → merge**.
- **Waiting time:** time the ticket spent waiting for a reply, paused, or failed to resume.
- **Factory time:** start to handoff, minus the waiting time before handoff.
- **Stage time:** wall-clock time in a stage, excluding waiting. Plan and wrap-up are measured per ticket; work, QA, and review per task while the task is active in that stage, summed across returns to work.
- **Agent time:** the sum of the ticket's run durations.
- **Overhead:** stage time minus agent time: validation, launches, and queueing.
- **Human interventions**, counted separately:
  - questions (an agent's `caller_ping`)
  - limit pauses
  - replies
  - manual retries
  - manual completes (a `/factory complete` with no merge seen)
  - stops

  A ticket **needed a person** when any of them is non-zero.

- **External review rounds:** the distinct pull request commits that drew at least one review asking for changes, or a comment with a body, from anyone other than the pull request's author. Approvals don't count, and neither do comments without a body or the author's own reviews. Rounds are also counted per reviewer kind, **human** and **bot** (GitHub's user type); a commit that drew both counts once in the total. They are also split by disposition: **changes requested** when the commit drew at least one review asking for changes, else **commented**. A commit that drew both counts as changes requested, so the two add up to the total.
- **Follow-up commits:** pull request commits made after handoff.
- **Tokens and cost:** the ticket's total usage. `tokens` is split into four categories: `tokensInput`, `tokensOutput`, `tokensCacheRead`, and `tokensCacheWrite`. They are disjoint: `tokensInput` excludes cached input, which is `tokensCacheRead`. `tokens` is the total Pi reports, not a sum the factory computes; Pi reports it as the sum of the four categories (every provider seen so far: Anthropic, OpenAI, Kimi), so the categories add up to `tokens` without double counting. Run rows in the export carry the same fields. A ticket or run with no recorded usage has `tokens: 0` and null categories, so "unknown" is not mistaken for "none".

## Stage measures (per stage and model setup)

- **First-pass acceptance:** the share of initial runs, among those validated, whose output passed validation.
- **Corrections per accepted output:** validation corrections over runs whose output passed.
- **Returns to work:** work runs that a later stage sent back, grouped by that stage (`qa`, `review`).
- **Review rounds per task:** the mean, over tasks, of each task's highest round in this stage.
- **Tokens and cost per accepted output.**
- **Tokens by category:** `tokens`, and `tokensInput`, `tokensOutput`, `tokensCacheRead`, and `tokensCacheWrite` summed over the runs whose usage is known. A category is null when no run in the row has known usage.
- **Agent time.**
- **Infrastructure-lost attempts:** infrastructure retries and runs that ended by launch failure, crash, a killed pane, or a gap. They are kept apart so a flaky sandbox does not count against the model.

## Routes

| Route                           | Returns                                                                                                                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/stats/summary`         | Totals and medians for the window.                                                                                                                                            |
| `GET /v1/stats/stages`          | One row per stage and model setup.                                                                                                                                            |
| `GET /v1/stats/configurations`  | Ticket outcomes per factory configuration.                                                                                                                                    |
| `GET /v1/stats/tickets?cursor=` | One fact row per ticket, paged.                                                                                                                                               |
| `GET /v1/stats/export`          | NDJSON: one `type: "ticket"` line per ticket, then one `type: "run"` line per run. Their shapes are `StatsExportTicketLine` and `StatsExportRunLine` in the OpenAPI document. |

The export carries raw facts, not aggregates, so another factory's export can be compared row by row.
