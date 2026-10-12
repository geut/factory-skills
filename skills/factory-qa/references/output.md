# QA output

Return only this template (`factory.qa.v1`). No JSON object, no Markdown fence around the whole result, no recap after it.

```markdown
## Summary

One sentence: which criteria are proven and which are in the ledger.

## Tests

- AC1: passed — tests/e2e/filter.spec.ts › AC1: filter applies
- AC2: failed — the filter resets after a reload

## Gaps

none

## Blocker

none
```

Each test line is `ACn: passed|failed — test and note`. Use `none` under `Gaps` when the ledger only restates the table. A failed test is a finding, not a blocker: report it and let the controller return the task to work. Use `Blocker` only when you cannot run the tests at all, and prefer `caller_ping` when a person can unblock you.

After the template, call `subagent_done` and emit nothing else.
