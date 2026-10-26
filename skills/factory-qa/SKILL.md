---
name: factory-qa
description: Prove one task's acceptance criteria with observable end-to-end tests against the real product, record a test plan and a test-gap ledger, and capture screenshots for the pull request. Use for the QA stage, after work and before review, when FACTORY.json enables stages.qa.
---

# Factory QA

Prove that one task does what its acceptance criteria say, from the outside. You test the product; you do not change it.

## Start from what the prompt gives you

The prompt lists the task's acceptance criteria as `AC1`..`ACn`, in the order the task file gives them. Those ids are the keys of everything you write. It also gives you the worker's summary, the files the worker changed, and the work checks that already passed.

Read `.factory/CONTEXT.md` when it exists, before exploring: it gives the test commands, which test layer covers what, the servers and ports, known flakes, and the fixtures to extend. Then read the task file and the project's end-to-end setup (for example `playwright.config.ts` and one or two existing end-to-end tests). Read product code only where a test needs a selector, a route, or a fixture. The worker already built the change and review will read the diff: do not re-derive the implementation.

## Sort the criteria

Before you write anything, put each criterion in one of two groups:

- **Observable**: a user can see the result through the running product: a page, an HTTP response, a CLI's output. It gets one end-to-end test.
- **Internal**: the criterion is about a function's return shape, a schema or fixture detail, the content of documentation, a skill, or an ADR, a grep over the source, or the configured checks being green. It gets a ledger line naming what already covers it, such as `- AC8: covered by the work check test (pnpm test)` or `- AC3: covered by src/lib/server/read.test.ts`. Do not build a harness to watch internals from the outside. For example, do not parse a framework's serialized page data out of the HTML.

When a task has no observable criterion, the ledger can hold every one of them. That is a valid result, not a failure.

## Write one test per observable criterion

Write the test first, straight from the criterion and the project's harness, and let its failures tell you what to read. For each observable criterion:

1. Write a short test that drives the product the way a user would and asserts what the criterion says can be observed. Put the criterion in the test title, such as `AC2: the filter survives a reload`, and put it next to the project's existing end-to-end tests.
2. Run only that test.
3. When it fails, read the failure, and only then the product code it points at: a route, a label, a fixture. Fix the test with a small edit and run it again.

A failure that shows the product misses the criterion is a finding, not something to fix: see below.

- Exercise the running product, not internal functions. Assert the observable result, not that code ran.
- For Playwright projects, follow [references/playwright.md](references/playwright.md).
- Reuse the project's harness: its web server config, fixtures, and seed helpers. Keep each test short: a spec for one task is tens of lines per criterion, not a thousand-line file. Fix a failing test with a small edit, never by rewriting the whole file.
- Iterate with short timeouts and stop at the first failure, for example `pnpm exec playwright test <file> --timeout=15000 --max-failures=1`, so a wrong locator fails in seconds instead of minutes.
- Probe through the test, not by hand. Do not start servers to explore with `curl`. If you must start a process yourself, record its pid (`cmd & pid=$!`) and kill that pid. Never use `pkill -f` with a pattern that also appears in your own command line. Prefer `localhost` to `127.0.0.1`, because dev servers often listen on IPv6 only.
- Capture a screenshot only where the criterion's result is visible on screen. Save it in `screenshots/` under the QA directory, named after the criterion, such as `screenshots/ac2-filter-after-reload.png`. Take one screenshot per distinct screen, and do not capture the same page again for a second criterion.
- When an observable criterion still cannot be proven by an automated test, do not fake one. Record it in the ledger.

Run the QA commands the prompt lists once, at the end. If a test fails because the product does not meet the criterion, keep the test as it is: the controller runs the QA commands and returns the task to work with the failure. Do not weaken the assertion and do not change product code.

Do not mutate product code, docs, or skills to show that your tests catch a regression. Review judges the tests. Restoring files by hand is how product changes leak into the diff.

Decide and act. A QA round should be a short loop of write, run, fix, not a long design exercise.

## Record the test plan and the test-gap ledger

Write both files in the QA directory the prompt names:

- `test-plan.md`: a table with one row per tested criterion. A row can list several screenshots, separated by commas.

  ```markdown
  | AC  | Test                                                     | Screenshot                 |
  | --- | -------------------------------------------------------- | -------------------------- |
  | AC1 | tests/e2e/filter.spec.ts › AC1: filter applies           | screenshots/ac1-filter.png |
  | AC2 | tests/e2e/filter.spec.ts › AC2: filter survives a reload | none                       |
  ```

- `ledger.md`: what the tests do not prove, one line each, keyed by criterion where one applies.

  ```markdown
  - AC3: Email delivery needs the real provider; checked by hand in staging.
  - Mobile layouts are not covered.
  ```

Every criterion must have a row in the test plan or a ledger line with a reason. A screenshot path must point at a file you captured. The controller checks both, then runs the commands in `FACTORY.json` `stages.qa.commands` in the worktree, then runs the work validation commands again (type check, lint, unit tests). Your test files must pass them: a failure in a file you changed comes back to you as a correction.

Leave the work uncommitted. Do not edit factory state, start another stage, commit, or push.

## Output

Return only the `factory.qa.v1` template in [references/output.md](references/output.md). No JSON object, no recap after it.

After the template, call `subagent_done` once and emit nothing else. If it replies that the session is shutting down, stop. Do not call it again, do not call `caller_ping`, and do not send more text. `caller_ping` is the only other terminal call, and it replaces the template when you need a decision. Do not edit the controller database.
