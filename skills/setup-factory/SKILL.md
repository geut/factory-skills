---
name: setup-factory
description: Scaffold a new factory once. Asks for role models, thinking levels, a ticket id pattern, pull-request permission, and triage labels, then runs fstate init to write FACTORY.json and the empty SQLite store. Use for /setup-factory, "setup factory", "initialize factory", before the first ticket, or to update those choices. Do not use during plan, work, review, or wrap-up.
---

# Setup factory

Scaffold `<code-root>/.factory`. Do not plan, implement, or review a ticket. Do not write `FACTORY.json` yourself. Collect answers and pass them to `fstate init`.

`init` lives at `node <factory-supervise>/scripts/fstate/cli.mjs`. Use the installed sibling `factory-supervise` skill, or this repo's `skills/factory-supervise`, whichever is present.

## Explore

Do this before asking anything. Report what is present.

1. `git rev-parse --show-toplevel` and `git remote -v`. Stop if this is not a Git repository. The factory root is `<code-root>/.factory` unless the request passes `--factory-root` or `FACTORY_ROOT`.
2. Read `FACTORY.json` when it exists. Those values are the current choices.
3. `node -v`. `init` needs Node.js 24 or newer. If it is older, stop. Do not write `FACTORY.json` by hand.
4. GitHub:
   - `gh auth status` for the account and token scopes. Do not run `gh auth login`.
   - When auth works, `gh repo view --json nameWithOwner,url`.
   - A missing auth does not block setup.

Leave existing `tickets/`, `CONTEXT.md`, `PRD.md`, and `learnings/` alone.

## Ask

One question at a time. Lead with the recommended answer. Do not call `init` until the user accepts the draft.

List models with `pi --list-models`. If that flag is missing, use the list command from `pi --help`. If none exists, ask the user to paste `provider/model` ids that `pi --model` accepts. Never pass an id that was not listed or pasted.

Ask each role, then the ticket pattern, then pull requests, then labels:

- `plan`, `work`, `review`, `wrapup`: model and thinking. Recommend `medium`. `thinking` is `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Keep review at `medium` unless the user raises it. The review model must differ from the work model. Do not append `:<thinking>` to the model id.
- `arbiter`: recommend leaving it unset. Pass `--arbiter-model` only if the user wants one.
- **Ticket id pattern.** Ask once. If the user does not provide one, omit `--ticket-id-pattern`. Tell them `init` used `PROJ-<number>` and that they can change `ticketIdPattern` in `FACTORY.json` later. Do not infer a pattern from issues.
- **Pull requests.** Ask only when `gh` is authenticated and `origin` is GitHub: may wrap-up open or update a pull request? Recommend yes. Pass `--pull-requests true` or `false`. When auth fails or the remote is not GitHub, do not ask. Pass `--pull-requests false` and say why.
- **Triage labels.** Ask only when `origin` is GitHub: keep the default triage labels? Recommend yes. The roles are `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. On yes, omit `--label` and pass `--github-repo` so a new factory stores each role as its own label string. If the repo name is unknown, or stored labels differ from those defaults, pass `--label <role>=<role>` for all five instead. On no, collect one tracker string per role and pass `--label <role>=<string>` for each, so an existing vocabulary is reused. When the remote is not GitHub, skip the question and do not pass `--label` or `--github-repo`.

On a re-run, an omitted flag keeps the stored value.

`limits` stay `maxTickets` 2, `maxAgents` 4, and `reviewRounds` 3. Show them in the draft. `init` has no limit flags. If the user changes them, after `init` succeeds update only the `limits` object in `FACTORY.json`.

Show the draft, including the `init` flags, then run it from the code root:

```text
node <factory-supervise>/scripts/fstate/cli.mjs init \
  --plan-model <provider/id> --plan-thinking <level> \
  --work-model <provider/id> --work-thinking <level> \
  --review-model <provider/id> --review-thinking <level> \
  --wrapup-model <provider/id> --wrapup-thinking <level> \
  [--arbiter-model <provider/id> --arbiter-thinking <level>] \
  [--ticket-id-pattern <pattern>] \
  [--github-repo <owner/name>] \
  --pull-requests <true|false> \
  [--label <role>=<string>]
```

A later run may omit model flags to keep the stored models. The first run requires the four role models.

## Write the factory root

`init` creates `.factory/tickets` when it is missing, appends `/.factory/` to `.git/info/exclude` when that line is absent, and writes `.factory/github.md` when `github.repo` is set. Do not do those yourself. It does not write a committed `.gitignore`.

After `init` succeeds, when `origin` is GitHub, write `.factory/triage-labels.md` from [references/triage-labels.md](references/triage-labels.md), with the label column taken from `factoryJson.github.labels`. Skip that file when the remote is not GitHub, and say that a pasted ticket string still works.

When `gh` is authenticated and labels were stored, list labels with `gh label list --limit 1000 --json name`. For each mapped string that is missing, run `gh label create "<string>" --description "<meaning>"`:

- `needs-triage`: Maintainer needs to evaluate this issue
- `needs-info`: Waiting on the reporter for more information
- `ready-for-agent`: Fully specified, ready for an agent
- `ready-for-human`: Requires human implementation
- `wontfix`: Will not be actioned

Use the meaning of the role, even when the tracker string differs. Leave an existing label unchanged. Do not apply labels to issues.

## Done

Say setup is complete. Repeat the ticket pattern, whether wrap-up may open a pull request, the five label strings when they were stored, and the GitHub auth result. A re-run updates the passed fields and does not wipe the database or ticket directories. The next step is `factory-supervise`.
