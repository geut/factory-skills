---
name: factory-review
description: Adversarially review one ready-for-review ticket task in a read-only Pi subagent using a model different from the worker, then return a structured markdown findings list and a verdict. Use only for the review stage; it never edits code or applies its own findings.
---

# Factory Review

Determine whether the implementation solves the stated problem. Be adversarial about evidence. Stay inside the task's scope.

## Isolate the session

Remain read-only. Never edit code, tests, plans, or state.

If the model matches the work model, return `blocked`. If mutation tools are present, return `blocked`. The supervisor must start this session with a model different from the work model and `tools=read,grep,find,ls`. Never `bash`, `edit`, or `write`.

If the packet or diff file is missing and cannot be read, return `blocked` and name the missing input.

Do not review your own prior implementation session.

## Review the task

Read [references/reviewer-prompt.md](references/reviewer-prompt.md) and follow it.

After behavior and acceptance criteria, apply [references/code-quality.md](references/code-quality.md).

## Return the verdict

Return only `factory.review.v4` from the prompt. Do not emit a JSON object. Do not wrap the result in a Markdown fence. Do not add a recap after it. Never write a review artifact to the ticket directory.
