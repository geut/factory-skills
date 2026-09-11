# Usage table

Show one aggregate row for every factory stage and one total row:

| Stage | Sessions | Models | Input | Output | Cache read | Cache write | Total tokens | Cost USD |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Plan | 1 | provider/plan-model | 28 | 6,900 | 135,000 | 22,000 | 163,928 | 0.754 |
| Work | 2 | provider/work-model | 100 | 8,000 | 90,000 | 5,000 | 103,100 | 0.620 |
| Review | 2 | provider/review-model | 80 | 4,200 | 50,000 | 2,000 | 56,280 | 0.410 |
| Wrap-up | 1 | provider/wrapup-model | 20 | 1,400 | 12,000 | 500 | 13,920 | 0.090 |
| **Total** | **6** | — | **228** | **20,500** | **287,000** | **29,500** | **337,228** | **1.874** |

Derive rows from the ticket's session-keyed `usage` records in `.factory/FACTORY-STATE.json`. `Sessions` counts usage records. Sum each recorded token field independently; `Total tokens` sums Pi's recorded `tokens.total` values rather than recomputing them from the displayed columns. Format integer tokens with separators only for display. List distinct models used in a stage, comma-separated. Preserve recorded cost precision and do not infer prices.

Use `—`, not `0`, for an unavailable value. Add a short warning below the table when an expected session or field is unrecorded. A resumed Pi session remains one session row in state, so its cumulative replacement must be counted once. Review rounds and separate task sessions count separately.

In a supervised run, the supervisor records wrap-up usage after the wrap-up agent exits, then renders this table in its user-facing completion message. Do not inject it into the completed Pi transcript or create a handoff artifact solely for the table. This ordering is required for the Wrap-up and Total rows to be complete. The table is a completion-time snapshot; later human prompts in the reopened session are outside the run unless the ticket is explicitly resumed. In a direct run, label the live wrap-up session `pending` instead of estimating it.
