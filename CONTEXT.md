# Factory

A deterministic controller that takes a ticket through fixed stages, run by specialist agents, and accepts each stage's output only when it passes mechanical checks. See [ADR-001](./ADR.md).

## Language

**Stage**:
One step of the factory flow (plan, work, QA, review, wrapup), with its own skill, inputs, and validator. Work, QA, and review run once per task.
_Avoid_: phase, step

**Optional stage**:
A stage the project turns on or off in its factory configuration; a disabled stage is skipped. QA is the first.

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

**Retry**:
Redoing a step that failed for infrastructure reasons, such as input preparation, a validation, or a launch. A retry never asks an agent to change its output.

**Review verdict**:
The reviewer agent's judgment on a task: approve, changes requested, or blocked. It is model judgment, unlike a validation report.
_Avoid_: verdict, when a validation report is meant
