---
name: prove-it-works
description: Prove a task against the real artifact before calling it done. Use during factory-work, before ready_for_review, and whenever a check only shows that code compiles or a file changed.
---

# Prove it works

Verify the real artifact. Do not infer from proxies, self-reports, or "it compiles."

Check the thing the user touches:

- Run the feature, read the actual value, and inspect the diff.
- Check process liveness directly, not through a derived "it should be up."
- Read the current output, not a cached screenshot or an old log.
- When a check fails, suspect the observation method before suspecting the product.

The strongest proof is a deterministic script that re-runs the same comparison, not a one-time eyeball. When the behavior has more than one case or the comparison is not obvious from one read, write the script, run it, and keep its output as an artifact a reviewer can re-run instead of trusting your word. For a static file, reading back its exact bytes is the proof; no script is needed.

Keep the artifact visible for the human. Commit it only for large or complex work where the trail has to be auditable later, like a big port or migration.

For a UI task, the artifact includes the Surf screenshot and the read-back of the rendered page, taken against the worktree's own server.
