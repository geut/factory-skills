---
name: factory-wrapup
description: Prepare an approved ticket for human submission by updating durable knowledge, summarizing scope and verification, teaching material flows with progressive visuals, and providing the merge handoff. Use only after review approval. When github.pullRequests is true, push the committed branch and create or update the pull request. It never commits or merges.
---

# Factory Wrap-up

Turn approved work into a clean human handoff. Do not change product code unless a broken generated artifact prevents an accurate handoff; route substantive code changes back through work and review.

## Confirm readiness

Read the plan, task files, optional ADR, approved review verdict, diff, and final test evidence. Stop and return the ticket to work or review if required checks failed, acceptance criteria remain open, or the diff contains unexplained scope.

## Update durable knowledge

Update `.factory/CONTEXT.md`, `.factory/PRD.md`, or project documentation only when implementation established knowledge useful beyond this ticket. Keep ticket-local detail in `plan.md`. Add to `.factory/learnings/` only when an observation could improve another ticket or a factory skill; do not create a learning for routine success.

Do not create `wrapup.md` or a `visuals/` directory in the factory root by default. The wrap-up Pi session is the human handoff. Promote an artifact to project documentation only when it must survive the ticket session.

## Build the handoff

The session handoff is the Output template. Do not wrap it in a recap.

Open the diff, relevant code, runtime, or debugger when that lands the explanation faster than prose. Read [references/visual-explanations.md](references/visual-explanations.md) whenever the change has three or more moving parts or a spatial UI behavior.

Read [references/usage-table.md](references/usage-table.md) for the final token and cost table. In a supervised run, do not estimate this wrap-up session's own usage: return the handoff first so the supervisor can record the completed session and show the all-stage table in its completion message. In a direct run, show all usage currently recorded and label the current wrap-up session as pending if it is not yet available.

Read [references/panes-handoff.md](references/panes-handoff.md) for the two human-facing panes. In a supervised run, the supervisor reopens this completed Pi session for inspection after receiving its final output, and opens the diff separately in Fresh. Neither action starts another model turn. Leave both panes open until the human closes them.

## Open or update the pull request

Read `github.pullRequests` in `.factory/FACTORY.json`. When it is missing or false, skip this section and use the merge commands below. Do not push.

When it is true, inspect the worktree:

```sh
git -C "<worktree>" status --porcelain
```

If that prints anything, the branch is not ready. Print the commit commands from the next section and do not push or open a pull request.

If it prints nothing, push the committed ticket branch and create or update the pull request. Do not commit, merge, or delete the worktree.

```sh
git -C "<worktree>" push -u origin "<ticket-branch>"
gh pr list --head "<ticket-branch>" --state open --json number,url
```

When that list is non-empty, update the open pull request instead of creating another:

```sh
gh pr edit <number> --title "<title>" --body "$(cat <<'EOF'
<pr summary>
EOF
)"
```

When the list is empty:

```sh
gh pr create --head "<ticket-branch>" --base "<base-branch>" --title "<title>" --body "$(cat <<'EOF'
<pr summary>
EOF
)"
```

If push or `gh` fails, report the command and its error. Do not claim a pull request exists. Put the pull request URL in the Merge commands section of the handoff.

## Prepare merge commands

Inspect the actual code root, worktree path, ticket branch, base branch, and changed files. When `github.pullRequests` is not true, or the worktree has uncommitted changes, print commands with those exact values and do not execute them. Because the factory does not commit, include this sequence when the worktree has uncommitted changes:

```sh
git -C "<worktree>" status --short
git -C "<worktree>" diff
git -C "<worktree>" add -- <explicit changed paths>
git -C "<worktree>" commit -m "<suggested message>"

git -C "<code-root>" status --short
git -C "<code-root>" switch "<base-branch>"
git -C "<code-root>" merge --ff-only "<ticket-branch>"
```

Never use `git add -A` or an unresolved glob. If the project documents another merge policy, show that policy instead. Without a documented policy, prefer `--ff-only`; explain that failure means the branches diverged and requires a human choice rather than silently recommending rebase or a merge commit.

List cleanup only as an optional post-merge step:

```sh
git -C "<code-root>" worktree remove "<worktree>"
git -C "<code-root>" branch -d "<ticket-branch>"
```

Do not show cleanup unless the ticket is committed and the user can first verify the merge.

In a supervised run, let the supervisor record wrap-up usage, show the final usage table, open the Pi summary and Fresh diff panes, and transition the ticket to stage `done` with status `complete`. In a direct invocation, use `node …/factory-supervise/scripts/fstate/cli.mjs`; the current Pi session already provides the summary surface, so open only the Fresh diff pane. Do not commit, merge, or clean up the worktree. Push and open or update a pull request only in the section above, and only when `github.pullRequests` is true. The human owns the merge.

## Output

Return only this template (`factory.wrapup.v1`). No JSON object, no recap after it. Include every heading.

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
