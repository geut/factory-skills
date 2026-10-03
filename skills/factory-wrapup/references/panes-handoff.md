# Handoff surfaces

After the supervised wrap-up result and its usage have been recorded, open two named panes. `<prefix>` is the first 12 characters of the ticket id. Use a shorter id whole. Separate the prefix and emoji with a single space.

- `<prefix> 📦` reopens the completed wrap-up Pi session for the human.
- `<prefix> 🔀` shows Fresh's working-tree `Review Diff` from the ticket worktree.

Resolve `pi`, `fresh`, the Pi session file, and launch scripts to absolute paths. Use the `pi-herdr-subagents` generic argv pane entrypoint so shell initialization cannot swallow a launch command. Each launch script must ignore `TSTP` and `exec` its target TUI. Open the wrap-up pane without focus, then the diff with focus. Capture each returned pane ID and rename it to the label above.

For the wrap-up pane, run `pi --session <wrap-up-session-file>` with no prompt, task argument, or `--thinking`. The original child has completed; this new process displays the same transcript and remains available for inspection. Do not use `subagent_resume` or send automatic input, because either would spend another model turn. If the human later requests substantive code changes there, route them back through work and review.

For the diff, start Fresh with `--no-restore` in the worktree. Once `herdr pane process-info` confirms Fresh owns the pane, use Herdr input commands to open the command palette (`ctrl+p`), enter `Review Diff`, and submit it. Use a bounded readiness check; do not scrape the review contents. `Review Diff` includes staged, unstaged, and untracked working-tree changes. When the intended review target is a committed branch instead, use `Review Diff: Range (Commit or Branch)` with the exact base and ticket branch.

Do not stage, unstage, discard, or edit from the Fresh pane. Leave both panes open for the human. If Pi, Fresh, the generic launcher, the session file, or a required diff target is unavailable, include that exact limitation in the textual handoff and continue without pretending the surface exists.
