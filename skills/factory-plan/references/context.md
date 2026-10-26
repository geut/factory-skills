# CONTEXT.md

`.factory/CONTEXT.md` holds the facts every ticket's agents would otherwise rediscover. Plan, work and QA read it before exploring. Write facts, not advice: the exact command, the port number, the flake and its fix.

The first plan in a factory root creates it. Plan validation fails until the file exists with every section below, as `##` headings in this order. A section with nothing known yet says `none known yet`.

## Sections

- **Commands**: the exact commands for check (typecheck), lint, unit and component tests, and end-to-end tests, each in its full and focused form (one file, one test), with typical durations.
- **Environment**: the shell and toolchain the commands need, such as which package manager is on `PATH`, and any known quirk with its workaround.
- **Test layers**: which kind of test covers what (component tests next to components, stories, end-to-end for critical paths) and where each lives, so a test lands at one layer only.
- **Servers and ports**: the ports the app and test harness use, the servers the harness starts, and whether it reuses one already running.
- **Known flakes**: each flaky test or tool failure, its symptom, and its fix or workaround.
- **Fixtures and fakes**: the fixtures and fake services, where they live, and how to extend them instead of writing parallel ones.
- **Vocabulary**: project terms and the names tasks should use for them.

## Budget

Every session loads the file, so keep it near 150 lines. Validation warns, but does not fail, past that. Link to longer documentation instead of copying it.

## Keeping it current

When the file exists, add or correct durable facts only. Do not rewrite or reorder what is there: a person may have edited it. A fact belongs here when the next ticket would hit it again; ticket-local detail belongs in `plan.md`.
