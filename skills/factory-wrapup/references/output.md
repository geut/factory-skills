# Wrap-up output

Return only this template (`factory.wrapup.v1`). No JSON object, no Markdown fence around the whole result, no recap after it. Include every heading.

```markdown
## Outcome
What changed for the user or system.

## PR summary
Plain pull-request summary. Explicit non-goals.

## Files
Added, modified, and removed paths.

## Tests
Commands, results, and anything not run. Include E2E or the human path.

## Operations
Operational or migration notes, or none.

## Limitations
Known limitations and follow-up that is genuinely out of scope, or none.

## Merge commands
When the pull request was opened or updated, its URL. Otherwise, exact commit and merge commands with real paths; do not execute them.
```

After the template, call `subagent_done` and emit nothing else.
