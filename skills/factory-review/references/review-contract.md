# Review contract

Return one object:

```json
{
  "schema": "factory.review.v3",
  "ticket": "PROJ-123",
  "task": "01",
  "round": 1,
  "reviewModel": "provider/model",
  "verdict": "approve|changes_requested|blocked",
  "summary": "One evidence-based sentence.",
  "checks": [
    {
      "criterion": "AC-1: The saved filter is restored on the next visit.",
      "result": "pass|fail|unproven",
      "evidence": [
        "src/filter.ts:42 restores the persisted value.",
        "tests/filter.test.ts:88 fails when restoration is removed."
      ]
    }
  ],
  "findings": [
    {
      "id": "R1-01",
      "severity": "critical|major|minor",
      "blocking": true,
      "location": "src/file.ts:42",
      "claim": "Concrete defect or unmet requirement.",
      "evidence": "Why the current code produces it.",
      "requiredChange": "Outcome required to resolve it; do not prescribe an unnecessary implementation."
    }
  ]
}
```

## Verdicts

- `approve`: every required check passes and no finding is blocking. `findings` is empty when there are no real observations; it may contain a small number of non-blocking minor findings.
- `changes_requested`: at least one actionable finding is blocking, or a required check is `fail` or `unproven` because the implementation lacks necessary behavior or proof.
- `blocked`: review cannot be trusted because required scope, evidence, model independence, or read-only isolation is missing.

## Evidence checks

Include one check for every acceptance criterion. Keep each check compact and cite concrete code, test, or command evidence. A `pass` must say what proves the criterion; “looks correct” and “tests pass” are not evidence.

Use `fail` when the implementation contradicts the criterion. Use `unproven` when the implementation may be correct but the required behavioral proof is missing. Every `fail` or `unproven` check must have a corresponding blocking finding with the same underlying claim. Cross-cutting checks for regression risk, scope, or safety are optional and should appear only when they materially affect the verdict.

## Severity

- `critical`: credible security, data-loss, privacy, availability, or fundamentally incorrect behavior.
- `major`: unmet acceptance criterion, likely user-visible defect, invalid architecture boundary, or missing proof of essential behavior.
- `minor`: real localized maintainability or clarity problem within scope.

Severity and blocking are related but separate. A minor finding is normally non-blocking. Exclude purely stylistic preferences. A finding must identify a location when possible, make one falsifiable claim, cite evidence, and state the outcome needed. Non-blocking findings are observations for the human; they do not trigger another work-review round.

## Review standard

The implementation is ready only when it:

- Solves the actual task and ticket outcome rather than a nearby problem.
- Preserves relevant existing behavior.
- Has proportionate behavioral evidence.
- Places complexity behind the smallest useful interface.
- Does not make future maintainers understand irrelevant machinery.

When evidence is insufficient, say exactly what is missing. Do not manufacture certainty.
