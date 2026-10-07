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

## E2E
passed | failed | not_feasible
Note: evidence or human path.

## Review responses
none

- R1-01: fixed — tests/filter.test.ts:88

## Plan changed
false

## Blocker
none

## Evidence
.factory/evidence/PROJ-123/01/manifest.json
```

`Status` is `ready_for_review` or `blocked`. A blocked result must explain the blocker; it must not claim completed verification. Use `none` under `Review responses` when this is not a later round. Use `none` under `Evidence` only when the task is blocked. Each test line is `command: passed|failed|not_run` plus an optional note. `Evidence` is the manifest path written under the factory root, not the worktree.

After the template, call `subagent_done` and emit nothing else. `caller_ping` is the only other terminal call, and it replaces the template when you need a decision.
