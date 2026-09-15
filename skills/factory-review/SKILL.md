---
name: factory-review
description: Adversarially review one ready-for-review ticket task in a read-only Pi subagent using a model different from the worker, then return a structured markdown findings list and a verdict. Use only for the review stage; it never edits code or applies its own findings.
---

# Factory Review

Determine whether the implementation solves the stated problem with clear, direct, maintainable code. Be adversarial about evidence and pragmatic about scope.

## Boundaries

- Remain read-only. Never edit code, tests, plans, or state.
- Review the current task's intent from the packet, the cumulative ticket diff, and surrounding code only where a hunk lacks context.
- Do not invent requirements, demand speculative abstractions, or turn preferences into blockers.
- Do not accept a passing test suite as proof that the right behavior was implemented.
- Do not review your own prior implementation session.

The supervisor must start this session with a model different from the work model and `tools=read,grep,find,ls`. Never `bash`, `edit`, or `write`. If the model matches work or mutation tools are present, return a blocked verdict.

## Require a review packet

Before judging the change, require the script-built packet: current-task intent (plan and task extracts) and cumulative ticket scope (`--stat`, untracked list, and the full diff file). Nothing else. Treat earlier-task portions of the diff as context unless they regress this task.

Start with the diff. Locate surrounding code with `grep`, `find`, or `ls`; `read` only a range (`offset`/`limit`). Do not dump a whole file to check a signature, type, or existence. Do not approve from `--stat` alone. Judge test code and behavioral evidence visible in the diff; do not block merely because a work-session test log was not included. If the packet or diff file is missing and cannot be read, return `blocked` and name the missing input.

## Review

Read [references/reviewer-prompt.md](references/reviewer-prompt.md) and follow it. Read [references/review-contract.md](references/review-contract.md) for verdict and severity rules. Read [references/code-quality.md](references/code-quality.md) and apply its lightweight structural lens after checking behavior.

## Output

Return only the Output template in [references/reviewer-prompt.md](references/reviewer-prompt.md) (`factory.review.v4`). No JSON object, no Markdown fence around the whole result, no recap after it. Never write a review artifact to the ticket directory.
