---
name: factory-wrapup
description: Prepare an approved ticket for human submission by updating durable knowledge, summarizing scope and verification, teaching material flows with progressive visuals, and providing the merge handoff. Use only after review approval. Unless codeHost.pullRequests is false, commit the approved work, push the ticket branch, and create or update the pull request. It never merges.
---

# Factory Wrap-up

Turn approved work into a clean human handoff. Do not change product code unless a broken generated artifact prevents an accurate handoff; route substantive code changes back through work and review.

## Confirm readiness

Read the plan, task files, optional ADR, approved review verdict, diff, and final test evidence. Stop and return the ticket to work or review if required checks failed, acceptance criteria remain open, or the diff contains unexplained scope.

## Update durable knowledge

Update `.factory/CONTEXT.md`, `.factory/PRD.md`, or project documentation only when implementation established knowledge useful beyond this ticket. For CONTEXT.md, ask: did this ticket hit environment, tooling or test friction that the next ticket would hit again? A command that failed first, a port collision, a flake re-diagnosed, a fixture found late. If so, add the fact to the matching section (see [the CONTEXT.md sections](../factory-plan/references/context.md)), without rewriting what is there. Keep ticket-local detail in `plan.md`. Add to `.factory/learnings/` only when an observation could improve another ticket or a factory skill; do not create a learning for routine success.

Do not create `wrapup.md` or a `visuals/` directory in the factory root by default. The wrap-up Pi session is the human handoff. Promote an artifact to project documentation only when it must survive the ticket session.

## Close the issue loop

The prompt lists the issue's open checklist items as `B1`..`Bn`, each task's review Verification lines, QA test plan rows, and the open review findings. Judge each box against that evidence and record it under `## Issue checklist`: `met` with the task criterion (verified by review or tested by QA) or file that proves it, or `not_met` with the reason. A box an open finding contradicts, even a minor one, stays `not_met`. Under `## Decisions`, list the choices that changed the issue's approach, such as a different API or a dropped requirement. Do not edit the issue yourself: the controller ticks the boxes and posts the comment after it accepts the handoff.

## Annotate the diff

The human reviews the ticket's diff in [Hunk](https://hunk.dev), with notes the controller takes from your handoff: what each `## Files` line says about its path appears above that file, each decision appears on the lines it cites, and each open review finding appears at its location. Say what changed in each file and why, in one line. End a decision with the lines that show it, as `(src/filter.ts:12-40)`. Leave out a location when no lines of the diff show the decision.

## Build the handoff

The session handoff is the Output template. Do not wrap it in a recap.

Open the diff, relevant code, runtime, or debugger when that lands the explanation faster than prose. Read [references/visual-explanations.md](references/visual-explanations.md) whenever the change has three or more moving parts or a spatial UI behavior.

Read [references/usage-table.md](references/usage-table.md) for the final token and cost table. In a controller run, do not estimate this wrap-up session's own usage: return the handoff first so the controller can record the completed session and show the all-stage table in its completion message. In a direct run, show all usage currently recorded and label the current wrap-up session as pending if it is not yet available.

Read [references/panes-handoff.md](references/panes-handoff.md) for the two human-facing panes. In a controller run, the controller reopens this completed Pi session for inspection after receiving its final output, and opens the diff separately in Fresh. Neither action starts another model turn. Leave both panes open until the human closes them.

## Open or update the pull request

Read `codeHost.pullRequests` in `.factory/FACTORY.json`; the controller also passes it in your prompt. It is on unless it is `false`. When it is false, skip this section and use the merge commands below. Do not push.

When it is true, `codeHost.pullRequests` is the project policy that authorizes you to commit, push, and create or update the pull request. Write the handoff's `## Files` first, then inspect the worktree:

```sh
git -C "<worktree>" status --porcelain
```

If that prints anything, commit the approved work on the ticket branch. Stage exactly the paths in `## Files`, by name. Never use `git add -A`, `git add .`, or a glob. Use a conventional message that references the ticket:

```sh
git -C "<worktree>" add -- <every path in ## Files>
git -C "<worktree>" commit -m "feat: <summary> (#<issue>)"
git -C "<worktree>" status --porcelain
```

The last command must print nothing. Then push the ticket branch and create or update the pull request:

```sh
git -C "<worktree>" push -u origin "<ticket-branch>"
gh pr list --head "<ticket-branch>" --state open --json number,url
```

Never amend, rebase, reset, or force-push, never make a merge commit, and never switch to or change the base branch. Existing commits stay as they are. A later change, such as a validation correction or feedback on the pull request from a reviewer or another agent, goes in a new commit on top, staged the same way, then pushed.

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

When the prompt lists QA screenshots, add a `## Screenshots` section to the pull request summary that names each one by task and criterion with its path. GitHub takes images only through its web upload, so the handoff also tells the human which files to drop into the pull request.

Put the pull request URL in the Merge commands section of the handoff. The controller checks that the pull request is for the ticket branch and that its head is your local HEAD.

If the commit, the push, or `gh` fails, report the exact command and its error, do not claim a pull request exists, and print the remaining commands from the next section instead. Never leave part of the work committed and the rest uncommitted.

## Prepare merge commands

Inspect the actual code root, worktree path, ticket branch, base branch, and changed files. When `codeHost.pullRequests` is false, or committing failed, print commands with those exact values and do not execute them. Include this sequence when the worktree has uncommitted changes:

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

In a controller run, let the controller record wrap-up usage, show the final usage table, open the Pi summary and Fresh diff panes, and transition the ticket to `wrapup` / `ready_for_handoff`. Only the human completion action moves it to `done` / `complete`. In a direct invocation, report the result without inventing operational state edits; the current Pi session already provides the summary surface, so open only the Fresh diff pane. Do not merge or clean up the worktree. Commit, push, and open or update a pull request only in the section above, and only when `codeHost.pullRequests` is on. The human owns the merge.

## Output

Return only the `factory.wrapup.v2` template in [references/output.md](references/output.md). No JSON object, no recap after it. Include every heading.

After the template, call `subagent_done` once and emit nothing else. If it replies that the session is shutting down, stop. Do not call it again, do not call `caller_ping`, and do not send more text. `caller_ping` is only for a question you cannot answer. Do not edit the controller database.
