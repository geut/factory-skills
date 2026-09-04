# Review contract

Return one object:

```json
{
  "schema": "factory.review.v1",
  "factory": "issue-PROJ-123",
  "issue": "01",
  "round": 1,
  "reviewModel": "provider/model",
  "verdict": "approve|changes_requested|blocked",
  "summary": "One evidence-based sentence.",
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

- `approve`: no blocking findings; `findings` must be empty. Do not keep optional nits alive after approval.
- `changes_requested`: at least one actionable finding is blocking.
- `blocked`: review cannot be trusted because required scope, evidence, model independence, or read-only isolation is missing.

## Severity

- `critical`: credible security, data-loss, privacy, availability, or fundamentally incorrect behavior.
- `major`: unmet acceptance criterion, likely user-visible defect, invalid architecture boundary, or missing proof of essential behavior.
- `minor`: real localized maintainability or clarity problem within scope.

Severity and blocking are related but separate. A minor finding is normally non-blocking. Exclude purely stylistic preferences. A finding must identify a location when possible, make one falsifiable claim, cite evidence, and state the outcome needed.

## Review standard

The implementation is ready only when it:

- Solves the actual issue rather than a nearby problem.
- Preserves relevant existing behavior.
- Has proportionate behavioral evidence.
- Places complexity behind the smallest useful interface.
- Does not make future maintainers understand irrelevant machinery.

When evidence is insufficient, say exactly what is missing. Do not manufacture certainty.
