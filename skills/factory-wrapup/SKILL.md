---
name: factory-wrapup
description: Prepare an approved ticket for human pull-request submission by updating durable knowledge, summarizing scope and verification, teaching material flows with progressive visuals, and providing exact worktree merge commands. Use only after review approval; it never commits, merges, pushes, or publishes.
---

# Factory Wrap-up

Turn approved work into a clean human handoff. Do not change product code unless a broken generated artifact prevents an accurate handoff; route substantive code changes back through work and review.

## Confirm readiness

Read the plan, task files, optional ADR, approved review verdict, diff, and final test evidence. Stop and return the ticket to work or review if required checks failed, acceptance criteria remain open, or the diff contains unexplained scope.

## Update durable knowledge

Update `.factory/CONTEXT.md`, `.factory/PRD.md`, or project documentation only when implementation established knowledge useful beyond this ticket. Keep ticket-local detail in `plan.md`. Add to `.factory/learnings/` only when an observation could improve another ticket or a factory skill; do not create a learning for routine success.

Do not create `wrapup.md` or a `visuals/` directory in the factory root by default. The wrap-up Pi session is the human handoff. Promote an artifact to project documentation only when it must survive the ticket session.

## Build the handoff

Present:

1. The user-visible outcome.
2. A plain pull-request summary with explicit non-goals.
3. Files or artifacts added, modified, and removed.
4. Tests and E2E evidence, including anything not run.
5. Operational or migration notes.
6. Known limitations and follow-up work that is genuinely out of scope.
7. Exact commands the user may run later to commit and merge the ticket worktree.

Open the diff, relevant code, runtime, or debugger when that lands the explanation faster than prose. Read [references/visual-explanations.md](references/visual-explanations.md) whenever the change has three or more moving parts or a spatial UI behavior.

Read [references/usage-table.md](references/usage-table.md) for the final token and cost table. In a supervised run, do not estimate this wrap-up session's own usage: return the handoff first so the supervisor can record the completed session and show the all-stage table in its completion message. In a direct run, show all usage currently recorded and label the current wrap-up session as pending if it is not yet available.

Read [references/panes-handoff.md](references/panes-handoff.md) for the two human-facing panes. In a supervised run, the supervisor reopens this completed Pi session for inspection after receiving its final output, and opens the diff separately in Fresh. Neither action starts another model turn. Leave both panes open until the human closes them.

## Prepare merge commands

Inspect the actual code root, worktree path, ticket branch, base branch, and changed files. Print commands with those exact values; do not execute them. Because the factory does not commit, include this sequence when the worktree has uncommitted changes:

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

In a supervised run, let the supervisor record wrap-up usage, show the final usage table, open the Pi summary and Fresh diff panes, and transition the ticket to stage `done` with status `complete`. In a direct invocation, use `factory-state` when available; the current Pi session already provides the summary surface, so open only the Fresh diff pane. Do not commit, merge, push, open a pull request, publish, or clean up the worktree. The human owns submission.
