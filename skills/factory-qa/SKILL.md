---
name: factory-qa
description: Prove one task's acceptance criteria with observable end-to-end tests against the real product, record a test plan and a test-gap ledger, and capture screenshots for the pull request. Use for the QA stage, after work and before review, when FACTORY.json enables stages.qa.
---

# Factory QA

Prove that one task does what its acceptance criteria say, from the outside. You test the product; you do not change it.

## Establish the contract

Read `.factory/CONTEXT.md`, the ticket's `plan.md`, the task file, and the project's existing end-to-end setup (for example a Playwright config and its tests). The prompt lists the task's acceptance criteria as `AC1`..`ACn`, in the order the task file gives them. Those ids are the keys of everything you write.

## Write one observable test per criterion

For each criterion, write one end-to-end test in the worktree, next to the project's existing end-to-end tests, that drives the product the way a user would and asserts what the criterion says can be observed. Name the criterion in the test title, such as `AC2: the filter survives a reload`.

- Exercise the running product (browser, HTTP, CLI), not internal functions.
- Assert the observable result, not that code ran.
- Capture a screenshot where the result is visible, into `screenshots/` under the QA directory. Name it after the criterion, such as `screenshots/ac2-filter-after-reload.png`.
- When a criterion cannot be proven by an automated observable test, do not fake one. Record it in the ledger instead.

Run the tests yourself. If a test fails because the product does not meet the criterion, keep the test as it is: the controller runs the QA commands and returns the task to work with the failure. Do not weaken the assertion and do not change product code.

## Record the test plan and the test-gap ledger

Write both files in the QA directory the prompt names:

- `test-plan.md`: a table with one row per tested criterion.

  ```markdown
  | AC | Test | Screenshot |
  | --- | --- | --- |
  | AC1 | tests/e2e/filter.spec.ts › AC1: filter applies | screenshots/ac1-filter.png |
  | AC2 | tests/e2e/filter.spec.ts › AC2: filter survives a reload | none |
  ```

- `ledger.md`: what the tests do not prove, one line each, keyed by criterion where one applies.

  ```markdown
  - AC3: Email delivery needs the real provider; checked by hand in staging.
  - Mobile layouts are not covered.
  ```

Every criterion must have a row in the test plan or a ledger line with a reason. A screenshot path must point at a file you captured. The controller checks both, then runs the commands in `FACTORY.json` `stages.qa.commands` in the worktree.

Leave the work uncommitted. Do not edit factory state, start another stage, commit, or push.

## Output

Return only the `factory.qa.v1` template in [references/output.md](references/output.md). No JSON object, no recap after it.

After the template, call `subagent_done` once and emit nothing else. If it replies that the session is shutting down, stop. Do not call it again, do not call `caller_ping`, and do not send more text. `caller_ping` is the only other terminal call, and it replaces the template when you need a decision. Do not edit the controller database.
