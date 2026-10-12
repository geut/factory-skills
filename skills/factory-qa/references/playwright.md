# Playwright in QA

From [Playwright's best practices](https://playwright.dev/docs/best-practices), with what the QA stage needs.

## Locate what a user sees

- Use the built-in locators, which wait and retry: `page.getByRole('button', { name: 'Save' })`, `getByLabel`, `getByText`, `getByTestId`. Narrow with chaining and `filter`, such as `page.getByRole('row').filter({ hasText: 'Task 02' })`.
- Do not locate by CSS classes, layout utility classes (`div.flex.gap-1`), XPath, or component internals such as `data-slot`. They break when the markup changes and they test the implementation.
- Do not assert CSS classes or colours by class name. Assert the text, role, or state a user perceives. When only a colour tells the states apart, take a screenshot and say so in the ledger.

## Assert with web-first assertions

- Use `await expect(locator).toBeVisible()`, `toHaveText`, `toHaveCount`, `toHaveURL`. They wait until the condition holds.
- Do not check once and assert the result, such as `expect(await locator.isVisible()).toBe(true)`. It does not wait, so it flakes.
- Use `expect.soft` when one test checks several facts of one criterion, so one run reports every failure.
- `await` every Playwright call.

## Keep tests isolated and data controlled

- Each test sets up the data it needs, for example by seeding its own scratch database through the project's seed helpers, and does not depend on another test or on a shared real database.
- Put shared setup in `test.beforeEach` or a fixture, not in a test that others rely on.
- Do not test third-party services. Stub them with `page.route(url, (route) => route.fulfill({ ... }))`.
- Reuse the project's `webServer` config instead of starting servers yourself. When a criterion needs the app on different data, prefer the project's existing pattern for that.

## Run and debug fast

- While iterating, run one file or one test: `npx playwright test <file>:<line> --timeout=15000 --max-failures=1`.
- When a failure is unclear, record a trace instead of probing by hand: `npx playwright test <file> --trace on`, then read the error context Playwright prints, or `npx playwright show-trace <trace.zip>`.
- Take screenshots with `await page.screenshot({ path, fullPage: true })` into the QA directory's `screenshots/`, after the assertion that proves the criterion has passed.
