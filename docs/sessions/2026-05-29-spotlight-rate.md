# Spotlight pivot to error-rate-per-value (2026-05-29)

The previous iterations of Spotlight (small-multiples, readable cards
with TL;DR) kept getting the same feedback: *"I don't understand
what this is showing me or how to use it to find things."*

Root cause: the share-differential paradigm needs the user to
mentally combine three numbers (sel share, base share, diff) to
recover the one number they actually want — the **rate**. The
Operations table on Service Detail shows "PaymentService/Charge: 14%
error rate" — one number per row, instantly readable. Spotlight was
making the user solve a math problem to reach the same insight.

## What changed

Spotlight pivots from "compare distributions" to "per-value selection
rate" — the same primitive as the Operations table, generalized to
every attribute.

For each attribute value, the engine now produces:
- `selN` — spans with this value that ARE in the selection
- `baseN` — spans with this value that are NOT in the selection
- `total` — selN + baseN
- `selectionRate` — selN / total (the headline metric)

The card renders one row per value: value label, horizontal bar
whose width IS the rate, the percentage, "N total · X errors"
caption, and a per-value "Search →" button. Bars whose rate is
above the attribute's overall average get an accent tint; below get
a muted treatment. No histograms, no overlaid distributions, no
sel/base/diff jargon.

Selection wording is context-aware: `selectionNoun="errors"` on
Service Detail / Errors pages renders as "98% errors", not "98%
selection rate."

## Ranking

Score = max over rows of `|row.rate - overall.rate| * log1p(row.total)`.
This is the L∞ norm of the per-value rate deviation, volume-weighted.

The volume-weighted variance approach (earlier attempt) under-counted
the case where a single tiny-but-extreme value is the real signal
among many uniform ones — exactly the "one pod is broken" /
"rpc.grpc.status_code = 13" pattern. The max-deviation approach
captures it cleanly.

minScore = 0.5 keeps the floor honest: a 5%-spread on 100 spans
gives ~0.23; a 30%-spread on 1,000 gives ~2.0. Real signal lands
above; pure noise (e.g., paymentFailure 50% uniform random failure
across pods) correctly produces no signal at all.

## Top-level columns

Added `name` (and `kind`) as queryable "attributes" via a new
`attrValueExpr()` helper. The OTel span operation name lives as a
top-level column (`name`), not under `attributes['name']`. Without
this, the strongest natural Service-Detail differentiator —
*"which operation is failing?"* — was invisible to Spotlight.

`name` is now in both `SPOTLIGHT_ATTRIBUTES` and
`SVC_SPOTLIGHT_ATTRS`.

## Result

On staging with `paymentFailure 50%` active:

- **Errors page, frontend / POST /api/checkout** expansion:
  `http.status_code` surfaces with two rows — `500` at 50% error
  rate (1,610 total · 805 errors) and `200` at 0% (1,636 total · 0
  errors). The asymmetric bars + percentages make the insight
  immediate.
- **Service Detail, payment**: `name` surfaces with
  `oteldemo.PaymentService/Charge` showing the operation's error
  rate, matching what the Operations table below shows.

## Removed

- `SpotlightHistogram` component — no longer used. The chart was
  the wrong primitive; per-value bars are direct.

## Tests

- Rewrote `computeSpotlight.test.ts` for the rate-based metric +
  variance score. 11 cases passing.
- Added `name`/`kind` top-level column resolution test to
  `facetedNav.test.ts`.
- 106/106 total passing.

## Pre-merge

tsc clean, lint 0 errors, build green, deployed + visually validated.
