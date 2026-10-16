# Factory

A deterministic controller that takes a ticket through fixed stages, run by specialist agents, and accepts each stage's output only when it passes mechanical checks. See [ADR-001](./ADR.md).

## Language

**Stage**:
One step of the factory flow (plan, work, QA, review, wrapup), with its own skill, inputs, and validator. Work, QA, and review run once per task.
_Avoid_: phase, step

**Optional stage**:
A stage the project turns on or off in its factory configuration; a disabled stage is skipped. QA is the first.

**Skipped stage**:
An optional per-task stage that a task's plan turns off for that task, such as QA for a task no user can observe. The task goes on to the next stage, and the skipped stage's summary says so.
_Avoid_: disabled (that is the project-wide switch)

**QA**:
The stage between work and review that proves a task's acceptance criteria with observable tests run against the real product, and captures screenshots as evidence.
_Avoid_: testing stage, verification

**Acceptance criterion**:
One observable condition a task must meet, listed in its task file.
_Avoid_: requirement, AC (in prose)

**Test plan**:
QA's mapping from each acceptance criterion of a task to the observable test that proves it.

**Test-gap ledger**:
QA's record of what the tests do not prove, and why.
_Avoid_: coverage report

**Run**:
One attempt by an agent to produce a stage's output.
_Avoid_: job, invocation

**Validator**:
The mechanical judge of a stage: given a finished run, it decides whether the output is acceptable. It never uses model judgment.
_Avoid_: checker, verifier

**Validation report**:
What a validator concludes about one run: passed, failed (the agent must correct its output), or error (infrastructure trouble, retry the validation), plus the checks behind that conclusion.
_Avoid_: verdict, validation outcome, validation result

**Validation check**:
One named, recorded fact inside a validation report, such as "diff is non-empty" or "tests pass".
_Avoid_: rule, assertion

**Correction**:
A new run of the same stage, asked to fix the failures a validation report listed.
_Avoid_: retry (which is reserved for infrastructure errors)

**Return to work**:
Sending a task back to the work stage because a later stage (review or QA) found the product does not do what the task asks, with the concrete problems to fix.
_Avoid_: correction (which stays within one stage), rework

**Pause**:
The factory stopping a ticket until a person acts. A person unblocks a pause with a reply, a retry, or neither (then only cancelling is left).
_Avoid_: block, halt

**Reply**:
A person's answer to the agent that paused the ticket, either because it asked a question or because it reached a limit. The reply resumes that agent's session.
_Avoid_: answer (as a command), resume

**Cancel**:
A person ending a ticket for good. Its worktree, branch, and pull request are kept.
_Avoid_: abort, abandon

**Stop**:
A person ending one running agent's run without ending the ticket, which then pauses.
_Avoid_: interrupt, kill

**Rerun**:
Starting a new execution of a finished ticket from a fresh copy of its issue.
_Avoid_: restart, retry (which redoes one failed step)

**Retry**:
Redoing a step that failed for infrastructure reasons, such as input preparation, a validation, or a launch. A retry never asks an agent to change its output.

**Review verdict**:
The reviewer agent's judgment on a task: approve, changes requested, or blocked. It is model judgment, unlike a validation report.
_Avoid_: verdict, when a validation report is meant

### Tracker and repository

**Issue**:
A work item in the issue tracker (GitHub, Linear, Jira). The factory may never have seen it.
_Avoid_: ticket, when the factory has not started it

**Ticket**:
An issue, or a local document, that the factory has started.
_Avoid_: issue, once the factory owns it

**Backlog**:
The issues in scope for the factory that are not yet tickets.

**External review**:
A review of a ticket's pull request by a human or an agent outside the factory. Each one is a round the factory's own review did not prevent.
_Avoid_: review (alone), when the factory's review stage is meant

**Tracker**:
The system that holds issues and the backlog, such as GitHub Issues, Linear, or Jira.
_Avoid_: provider

**Code host**:
The system that holds the repository and its pull requests, such as GitHub.
_Avoid_: repo provider, provider

**Tracker update**:
A comment or status change the factory writes to a ticket's issue when the ticket starts, pauses for a person, or reaches handoff. It never blocks the ticket.
_Avoid_: write-back, sync

**Pull request outcome**:
What happened to a ticket's pull request after handoff: its external reviews, whether it merged, and when.

**External review round**:
A commit on a ticket's pull request that drew at least one review asking for changes, or commenting, from someone other than the pull request's author.
_Avoid_: review round, when the factory's own review stage is meant

**Follow-up commit**:
A commit pushed to a ticket's pull request after handoff.

**Abandoned**:
A cancelled ticket whose pull request was closed without merging, as distinct from one a person cancelled.

### Server and clients

**Factory server**:
The long-running process that owns the controller and serves the API. Pi, the dashboard, and webhooks are its clients.
_Avoid_: daemon, backend

**API client**:
A named holder of a factory server token, such as `local` (Pi) or `dashboard`. Every command records the client that sent it as its actor.
_Avoid_: user, app, consumer

**Factory stats**:
Measures of how well a factory turns tickets into merged pull requests, compared across models and stages.
_Avoid_: metrics, analytics

### Stats

**Model setup**:
A model and its thinking level, as used for one stage. Stage measures are compared per model setup.
_Avoid_: model, when the thinking level matters

**Factory configuration**:
The model setup of every stage that worked on a ticket. Ticket outcomes are compared per factory configuration.

**Factory version**:
The package version and commit of the factory that ran a ticket, so a change to skills is not mistaken for a better model.

**Stage time**:
Wall-clock time a ticket, or a task in a per-task stage, spends in a stage, excluding waiting time.

**Agent time**:
Time an agent's runs are actually running.

**Waiting time**:
Time a ticket spends waiting on a person: waiting for a reply, paused, or failed to resume.

**Factory time**:
Time from a ticket's start to handoff, excluding waiting time.

**Human intervention**:
Something a person had to do for a ticket: answer a question, unblock a limit pause, reply, retry, or complete it by hand.
