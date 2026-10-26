# Review output

Return only this template (`factory.review.v5`). No JSON object, no Markdown fence around the whole result, no recap after it. Never write a review artifact to the ticket directory.

```markdown
## Verdict

approve | changes_requested | blocked

## Summary

One evidence-based sentence.

## Verification

- AC1: verified — src/lib/server/events.ts:41-58; test "rejects cross-origin" in src/lib/server/events.test.ts:12
- AC2: verified — src/lib/factory/live.svelte.ts:112
- AC3: not_verified — needs a real browser; covered by QA's e2e
- R1-2: fixed — src/lib/factory/live.svelte.ts:130-141

## Findings

none

### 1. [Severity] Short title

**Location:** file:line or function name
**Finding:** What's wrong
**Evidence:** Why this matters
**Suggestion:** (optional) What to do instead

### 2. [Severity] Short title

...
```

`## Verification` has one line per acceptance criterion the prompt lists (`AC1`, `AC2`, ...) and, from round 2, one per earlier blocking finding it lists (`R1-2`, ...). Each line is `- <id>: <status> — <evidence>`:

- A criterion is `verified` or `not_verified`. A finding is `fixed` or `still_open`.
- `verified` and `fixed` cite at least one `path:line` or `path:start-end`, relative to the worktree. Every cited file must exist and every line must be within it, so cite what you read, not what you remember.
- `not_verified` gives the reason it could not be verified. An approval may leave criteria `not_verified`; the gap is shown to the person and to wrap-up.
- `approve` cannot leave a finding `still_open`. A problem that remains is a blocking finding, under its earlier number.
- With no criteria and no earlier findings, the section is `none`.

`changes_requested` and `blocked` reviews report Verification too.

If there are no findings, `## Findings` is exactly `none` and the review stops. An approved review may retain a small number of useful non-blocking minor findings. Use `none` when there are none.

A `Suggestion` states the outcome needed. Do not prescribe an unnecessary implementation.

The controller parses this template. `## Verdict` holds exactly one verdict word. Every expected Verification id appears exactly once, and no other. Every finding needs a `### n. [Severity] Title` heading, a `**Finding:**`, and an `**Evidence:**`. A result that cannot be parsed comes back to you with the exact errors.

After the template, call `subagent_done` and emit nothing else.
