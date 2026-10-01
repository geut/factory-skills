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

The strongest proof is a command someone else can re-run. Write that command, its working directory, its exit code, and the artifact it produced into `.factory/evidence/<ticket>/<task>/manifest.json` under the factory root:

```json
{
  "ticket": "PROJ-123",
  "task": "01",
  "criteria": [
    {
      "id": "AC1",
      "command": "pnpm exec vitest run src/filter.spec.ts",
      "cwd": "/absolute/worktree",
      "exitCode": 0,
      "artifact": "/absolute/factory/evidence/PROJ-123/01/vitest.log"
    }
  ],
  "verifiedAt": "2026-10-01T18:00:00Z"
}
```

A criterion without a command and a zero exit code is not proof. For a UI task, the artifact includes the Surf screenshot and the read-back of the rendered page, taken against the worktree's own server. Commit the manifest only when the ticket itself asks for an auditable trail.
