# Wrap-up output

Return only this template (`factory.wrapup.v2`). No JSON object, no Markdown fence around the whole result, no recap after it. Include every heading.

```markdown
## Outcome

What changed for the user or system.

## PR summary

Plain pull-request summary. Explicit non-goals.

## Files

Added, modified, and removed paths.

## Tests

Commands, results, and anything not run. Include E2E or the human path.

## Issue checklist

- B1: met — Task 01 AC2 verified; e2e/filter.e2e.ts › survives a reload
- B2: not_met — Task 01 R1-3 (minor): the label is never rendered

## Decisions

- Streamed events with fetch instead of EventSource, to send the auth header.

## Operations

Operational or migration notes, or none.

## Limitations

Known limitations and follow-up that is genuinely out of scope, or none.

## Merge commands

When the pull request was opened or updated, its URL. Otherwise, exact commit, push, and merge commands with real paths; do not execute them.
```

`## Issue checklist` has one line per open box the prompt lists (`B1`, `B2`, ...), or `none` when it lists none. A box is `met` only with evidence: a task criterion that proves it, as `Task 01 AC2`, which review verified or QA's test plan covers, or a file in the worktree. Leave a box `not_met`, with the reason, when it is not done or an open review finding names a criterion it rests on, minor findings included.

`## Decisions` is `none` or bullet points: choices made during the ticket that changed the issue's approach, as a reader of the issue needs them. Not a recap of the work.

The controller ticks the met boxes on the issue and posts one comment with the decisions and the boxes left open. It only ticks boxes; the rest of the issue stays as it is.

In a controller run, the controller validates this handoff against the repository before the ticket is ready for handoff: every heading is present, every open box has one `## Issue checklist` line backed as above, `## Files` lists every changed path in the worktree and no other, `## Tests` names each configured validation command, and `## Merge commands` holds a pull-request URL or commands with the real worktree path and branch. With `codeHost.pullRequests` on, a commit holds only `## Files` paths, sits on top of the commit wrap-up started from with no merge, leaves the worktree clean, and is the head of the reported pull request. A failed check comes back to you with the exact failures.

After the template, call `subagent_done` and emit nothing else.
