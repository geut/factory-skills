# Review output

Return only this template (`factory.review.v4`). No JSON object, no Markdown fence around the whole result, no recap after it. Never write a review artifact to the ticket directory.

```markdown
## Verdict

approve | changes_requested | blocked

## Summary

One evidence-based sentence.

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

If there are no findings, `## Findings` is exactly `none` and the review stops. An approved review may retain a small number of useful non-blocking minor findings. Use `none` when there are none.

A `Suggestion` states the outcome needed. Do not prescribe an unnecessary implementation.

After the template, call `subagent_done` and emit nothing else.
