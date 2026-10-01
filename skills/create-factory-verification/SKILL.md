---
name: create-factory-verification
description: Generate a project-local verification skill that drives the real app and captures evidence for factory lifecycle gates. Use during setup-factory or when a factory has no scripted way to prove UI, CLI, or service behavior.
---

# Create a factory verification skill

Write `.factory/skills/verify-<repo>/` for the next agent, not as a human tutorial. Interview the repo before asking the user.

## Interview

Answer these from the checkout:

- Surface: what a user touches (web UI, CLI, API, library).
- Run: the repo's own dev or start command, port, env, and seed data.
- Drive: an existing harness first, then Surf for a web UI or the real CLI for a terminal tool.
- Observe: screenshots, transcripts, response bodies, logs, exit codes.
- Isolate: a second instance must not reuse the user's port, database, or Surf session.

Then generate the files:

```sh
node <factory-supervise>/scripts/write-verification-skill.mjs \
  --code-root <code-root> \
  --factory-root <factory-root> \
  [--repo <repo-name>]
```

Replace the generated placeholders with commands and selectors you actually observed. The skill needs Launch, Doctor, Drive, Evidence, and Cleanup. Evidence goes to `.factory/evidence/<ticket>/<task>/` and must survive cleanup.

For a web UI, the Drive section must use a unique `SURF_SESSION`, a worktree-owned free port, `surf session.ensure`, `surf go`, `surf wait.ready`, `surf read`, desktop and narrow screenshots, `surf console`, `surf network.stats`, `surf smoke --screenshot`, and `--auto-capture` on failure.

## Prove one feature

Run the generated skill once: launch, doctor, drive one feature, capture evidence, clean up, then confirm the evidence file is still there. Fix the skill if that fails. A skill that was never executed is a draft.

Store a rerunnable command in `FACTORY.json` as `verification.command` when one command can regenerate the manifest. The lifecycle hook still requires the manifest; it does not trust the command name.
