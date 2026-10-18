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

When the pull request was opened or updated, its URL. Otherwise, exact commit, push, and merge commands with real paths; do not execute them.
```

In a controller run, the controller validates this handoff against the repository before the ticket is ready for handoff: every heading is present, `## Files` lists every changed path in the worktree and no other, `## Tests` names each configured validation command, and `## Merge commands` holds a pull-request URL or commands with the real worktree path and branch. With `codeHost.pullRequests` on, a commit holds only `## Files` paths, sits on top of the commit wrap-up started from with no merge, leaves the worktree clean, and is the head of the reported pull request. A failed check comes back to you with the exact failures.

After the template, call `subagent_done` and emit nothing else.
