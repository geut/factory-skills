# Factory

A deterministic controller that takes a ticket through fixed stages, run by specialist agents, and accepts each stage's output only when it passes mechanical checks. See [ADR-001](./ADR.md).

## Language

**Stage**:
One step of the factory flow (plan, work, review, wrapup), with its own skill, inputs, and validator.
_Avoid_: phase, step

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

**Review verdict**:
The reviewer agent's judgment on a task: approve, changes requested, or blocked. It is model judgment, unlike a validation report.
_Avoid_: verdict, when a validation report is meant
