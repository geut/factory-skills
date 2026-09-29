# GitHub

Issues and pull requests for `<owner/name>` use the `gh` CLI. Inside this clone, `gh` infers the repo.

## Issues

- **Read an issue:** `gh issue view <number> --comments`
- **Update an issue:** `gh issue comment <number> --body "..."` and `gh issue edit <number>`. Add or remove a triage label with `--add-label` and `--remove-label`. The strings are in [triage-labels.md](triage-labels.md) and in `FACTORY.json` under `github.labels`.
- **String ticket:** a ticket that is not an issue number or a GitHub issue URL is the ticket text. Do not create a GitHub issue for it.

The factory reads an issue from supervise when the ticket argument is an issue. It does not comment on, edit, or label issues.

## Pull requests

Create or update a pull request only when `FACTORY.json` `github.pullRequests` is `true`.

- **Create:** `gh pr create --title "..." --body "..."`. Use a heredoc for a multi-line body.
- **Read:** `gh pr view <number>` and `gh pr diff <number>`.
- **Update:** `gh pr edit <number>` and `gh pr comment <number> --body "..."`.

If an open pull request already exists for the ticket branch, update it instead of creating another.
