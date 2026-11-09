# Review contract

The reviewer output template in [output.md](output.md) is `factory.review.v5`. The result is markdown, not JSON. Verdict rules for the prompt are in [reviewer-prompt.md](reviewer-prompt.md).

## Verdicts

- `approve`: no finding is blocking. `## Findings` is `none` when there are no real observations. It may contain a small number of non-blocking minor findings.
- `changes_requested`: at least one finding is blocking (`critical` or `major`), including an unmet acceptance criterion or missing proof of required behavior.
- `blocked`: required scope, evidence, model independence, or read-only isolation is missing.

Unmet acceptance criteria are findings. `## Verification` records, per criterion, per changed project rule file, and per earlier blocking finding, what was checked and where; the controller checks that every expected id is there, every cited location exists, and every `out_of_scope` rule file has a blocking finding. "Looks correct" and "tests pass" are not evidence.

## Severity

- `critical`: credible security, data-loss, privacy, availability, or fundamentally incorrect behavior.
- `major`: unmet acceptance criterion, likely user-visible defect, invalid architecture boundary, missing proof of essential behavior, or a change to project rules (`AGENTS.md`, `CLAUDE.md`, `.pi/SYSTEM.md`, `.pi/APPEND_SYSTEM.md`) the task didn't ask for.
- `minor`: real localized maintainability or clarity problem within scope.

`critical` and `major` are blocking and trigger another work-review round. `minor` is not. Purely stylistic preferences are not findings. A finding identifies a location when possible, makes one falsifiable claim, cites evidence, and states the outcome needed. Non-blocking findings are observations for the human.

The controller synthesizes stable ids `R{round}-{n}` from `### n.` headings for state and worker relay. The same number is kept across rounds when the underlying problem is the same.

## Review standard

The implementation is ready when it:

- Solves the actual task and ticket outcome rather than a nearby problem.
- Preserves relevant existing behavior.
- Has proportionate behavioral evidence.
- Places complexity behind the smallest useful interface.
- Does not make future maintainers understand irrelevant machinery.

Insufficient evidence is named as missing. It is not filled in as certainty.
