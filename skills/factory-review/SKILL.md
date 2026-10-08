---
name: factory-review
description: Adversarially review one ready-for-review ticket task in a read-only Pi subagent using a model different from the worker, then return a structured markdown findings list and a verdict. Use only for the review stage; it never edits code or applies its own findings.
---

# Factory Review

Determine whether the implementation solves the stated problem. Be adversarial about evidence. Stay inside the task's scope.

## Isolate the session

Remain read-only. Never edit code, tests, plans, or state.

If the model matches the work model, return `blocked`. If mutation tools are present, return `blocked`. The controller must start this session with a model different from the work model and read-only tools. Never edit or write.

If the packet or diff file is missing and cannot be read, return `blocked` and name the missing input.

Do not review your own prior implementation session.

## Review the task

Read [references/reviewer-prompt.md](references/reviewer-prompt.md) and follow it.

After behavior and acceptance criteria, apply [references/code-quality.md](references/code-quality.md).

## Return the verdict

Return only the `factory.review.v4` template in [references/output.md](references/output.md). Do not emit a JSON object. Do not wrap the result in a Markdown fence. Do not add a recap after it. Never write a review artifact to the ticket directory. After the template, call `subagent_done` once and emit nothing else. If it replies that the session is shutting down, stop. Do not call it again, do not call `caller_ping`, and do not send more text. `caller_ping` is only for a question you cannot answer. Do not edit the controller database.
