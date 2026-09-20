# Review contract

The reviewer Output template in [reviewer-prompt.md](reviewer-prompt.md) is `factory.review.v4`. The result is markdown, not JSON.

## Verdicts

- `approve`: no finding is blocking. `## Findings` is `none` when there are no real observations. It may contain a small number of non-blocking minor findings.
- `changes_requested`: at least one finding is blocking (`critical` or `major`), including an unmet acceptance criterion or missing proof of required behavior.
- `blocked`: required scope, evidence, model independence, or read-only isolation is missing.

Unmet acceptance criteria are findings, not a separate checks list. "Looks correct" and "tests pass" are not evidence.

## Severity

- `critical`: credible security, data-loss, privacy, availability, or fundamentally incorrect behavior.
- `major`: unmet acceptance criterion, likely user-visible defect, invalid architecture boundary, or missing proof of essential behavior.
- `minor`: real localized maintainability or clarity problem within scope.

`critical` and `major` are blocking and trigger another work-review round. `minor` is not. Purely stylistic preferences are not findings. A finding identifies a location when possible, makes one falsifiable claim, cites evidence, and states the outcome needed. Non-blocking findings are observations for the human.

The supervisor synthesizes stable ids `R{round}-{n}` from `### n.` headings for state and worker relay. The same number is kept across rounds when the underlying problem is the same.

## Review standard

The implementation is ready when it:

- Solves the actual task and ticket outcome rather than a nearby problem.
- Preserves relevant existing behavior.
- Has proportionate behavioral evidence.
- Places complexity behind the smallest useful interface.
- Does not make future maintainers understand irrelevant machinery.

Insufficient evidence is named as missing. It is not filled in as certainty.
