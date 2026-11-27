# Work output

Your report is the arguments of `subagent_done`, the one channel the controller reads. Text you write and thinking are not read: a report only written out never reaches it. Do not list changed paths; the controller already has git.

```json
{
  "status": "ready_for_review",
  "summary": "Disabled entries are left out of the filtered list.",
  "tests": [
    { "command": "npm test", "result": "passed", "note": "22 files / 109 tests" },
    { "command": "npm run lint", "result": "not_run", "note": "unchanged config" }
  ],
  "validation_selection": {
    "mode": "focused",
    "tests": [
      { "path": "tests/filter.test.ts", "reason": "checks that disabled entries are excluded" }
    ]
  },
  "e2e": { "result": "qa", "note": "QA runs for this task and owns its end-to-end tests" },
  "plan_changed": false
}
```

Required: `status`, `summary`, `validation_selection`.

- `status` is `ready_for_review` or `blocked`. A blocked report sets `blocker` to what stops the task, and claims no completed verification.
- `summary` is one sentence for the observable result.
- `tests` is your account of what you ran: `command`, `result` (`passed`, `failed`, or `not_run`), and an optional `note`. The controller's own command results are the independent evidence.
- `validation_selection` goes to `validation.work.commands` as `FACTORY_VALIDATION_SELECTION`, JSON such as `{"version":1,"tests":[{"path":"tests/filter.test.ts","reason":"…"}]}`; the project's validator decides how to run it.
  - `focused` lists the regression tests you found from your own diff, each a test file relative to the repository root, with a short reason.
  - `default` proposes none, with a `reason`: `FACTORY_VALIDATION_SELECTION` is then unset, and the validator uses its default behavior.
  - Every report states it again; a later round, after review or QA returns the task, starts from your new report.
- `e2e` is `passed`, `failed`, `not_feasible`, or `qa` (QA runs for the task and owns its end-to-end tests), with evidence or the human path in `note`.
- `review_responses`, in a later round, answers each finding: `{"id": "R1-01", "response": "fixed — tests/filter.test.ts:88"}`.
- `feedback_responses`, in a feedback round (`F<n>`), answers each item of the task file exactly once: `{"id": "F1", "disposition": "addressed", "note": "renamed the flag in src/filter.ts"}` or `"declined"` with why. Review reads them and judges every item either way; one left unaddressed without a reason it can accept is a finding. Leave it out for a planned task.
- `plan_changed` is true when you edited `plan.md`.
- `evidence` lists screenshot or transcript paths that help a reviewer.

`subagent_done` checks the report before it ends the run: the required fields, that each selected test is a file in the worktree, and in a feedback round that every item is answered once. A refused report comes back as a tool error naming the fields; fix them and call it again. A turn that ends without the call is asked for it. No project checks run until a report is accepted. Leave the work uncommitted.

## An early result from the gate

`run_validation` is opt-in: use it only when you need an early result from the controller's gate before you submit. It runs `validation.work.commands` on the worktree as it stands, with the `validation_selection` you give it, and waits for their results. While iterating, run focused tests yourself instead, and never invoke the configured validation script directly. Give it the selection your report will have. If they pass and nothing changes before you call `subagent_done` with the same selection (no edit, no new or deleted file, no change to the factory root's `scripts/`, no move of the target branch), the controller reuses that pass instead of running the commands again; otherwise it runs the normal gate. If you submit while it still runs, the controller waits for it. Your own runs of the commands, and what your report says about them, never count as validation.

`caller_ping` is the only other terminal call, and it replaces the report when you need a decision.
