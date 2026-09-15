# Review contract

Return only the Output template in [reviewer-prompt.md](reviewer-prompt.md). That markdown is `factory.review.v4`. Do not emit JSON.

## Verdicts

- `approve`: no finding is blocking. `## Findings` is `none` when there are no real observations; it may contain a small number of non-blocking minor findings.
- `changes_requested`: at least one finding is blocking (`critical` or `major`), including an unmet acceptance criterion or missing proof of required behavior.
- `blocked`: review cannot be trusted because required scope, evidence, model independence, or read-only isolation is missing.

Unmet acceptance criteria are findings, not a separate checks list. “Looks correct” and “tests pass” are not evidence.

## Severity

- `critical`: credible security, data-loss, privacy, availability, or fundamentally incorrect behavior.
- `major`: unmet acceptance criterion, likely user-visible defect, invalid architecture boundary, or missing proof of essential behavior.
- `minor`: real localized maintainability or clarity problem within scope.

`critical` and `major` are blocking and trigger another work-review round. `minor` is not. Exclude purely stylistic preferences. A finding must identify a location when possible, make one falsifiable claim, cite evidence, and state the outcome needed. Non-blocking findings are observations for the human.

The supervisor synthesizes stable ids `R{round}-{n}` from `### n.` headings for state and worker relay. Keep the same number across rounds when the underlying problem is the same.

## Review standard

The implementation is ready only when it:

- Solves the actual task and ticket outcome rather than a nearby problem.
- Preserves relevant existing behavior.
- Has proportionate behavioral evidence.
- Places complexity behind the smallest useful interface.
- Does not make future maintainers understand irrelevant machinery.

When evidence is insufficient, say exactly what is missing. Do not manufacture certainty.
