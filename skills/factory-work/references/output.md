# Work output

Return only this template (`factory.work.v3`). No JSON object, no Markdown fence around the whole result, no recap after it. Do not list changed paths; the controller already has git.

```markdown
## Status

ready_for_review | blocked

## Summary

One sentence for the observable result.

## Tests

- `npm test`: passed — 22 files / 109 tests
- `npm run lint`: not_run — unchanged config

## Validation selection

none

- `tests/filter.test.ts`: checks that disabled entries are excluded

## E2E

passed | failed | not_feasible | qa
Note: evidence or human path; `qa` when QA runs for the task and owns its end-to-end tests.

## Review responses

none

- R1-01: fixed — tests/filter.test.ts:88

## Feedback responses

none

- F1: addressed — renamed the flag in src/filter.ts
- F2: declined — the README has no flag section yet

## Plan changed

false

## Blocker

none

## Evidence

none
```

`Status` is `ready_for_review` or `blocked`. A blocked result must explain the blocker; it must not claim completed verification. Use `none` under `Review responses` when this is not a later round. Use `none` under `Feedback responses` unless the task is a feedback round (`F<n>`). In a feedback round, end the reply with `## Feedback responses`, one line per item of the task file, `addressed` with what changed or `declined` with why; the rest is optional. Review reads those lines, and judges every item either way: one left unaddressed without a reason it can accept is a finding. Use `none` under `Evidence` unless a screenshot or transcript path helps a reviewer. The controller checks the worktree diff and `validation.work.commands`; of this template it reads only `Validation selection`, and no evidence manifest. Each test line is `command: passed|failed|not_run` plus an optional note.

`Validation selection` lists the focused regression tests you found from your own diff, one line each: ``- `path/to/test_file`: why it covers this change``, with the path relative to the repository root, or `none`. Work validation passes them to `validation.work.commands` as `FACTORY_VALIDATION_SELECTION`, JSON such as `{"version":1,"tests":[{"path":"tests/filter.test.ts","reason":"…"}]}`; the project's validator decides how to run them. Each path must be a file in the worktree, and a malformed entry comes back as a correction. A correction reply that leaves the section out keeps your earlier selection; `none` clears it. `Tests` stays your report of what you ran; the controller's command results are the independent evidence. Leave the work uncommitted.

After the template, call `subagent_done` and emit nothing else. `caller_ping` is the only other terminal call, and it replaces the template when you need a decision.
