# Spotlight readable redesign (2026-05-29)

User feedback after the scoped-baseline fix landed: "I see one
thing — rpc.grpc.status_code — and I still don't understand how
to read this or how it helps me find things."

Diagnosis: the chart-only design moved the actual information
(value names, counts, percentages) behind a click. Visual asymmetry
told the user "something differs" without telling them what or
what to do about it.

## What changed

Each attribute card now leads with words and numbers; the chart is
a scanning aid, not the primary readout.

- **TL;DR headline sentence** above the chart. Picks the
  strongest single value (largest |diff|) and writes it out:
  "Selection over-represents `13` by +100.0 pp (144 sel vs 0
  base)." The user can read it cold without translating bars.
- **Inline value rows** below the chart — top 3 by default, with
  per-row counts, percentages, and a dedicated "Search →" button
  that drills into the matching spans. No click required to see
  the substance.
- **Per-value Search button** — explicit, single-purpose. Clicking
  it sends the user to the Search page filtered to spans with that
  attribute value. Action is unambiguous.
- **Plain-English legend** at the panel bottom: "selection (the
  spans you're investigating)" / "baseline (what they're being
  compared against)". The earlier "sel"/"base" jargon assumed
  background the novice user doesn't have.
- **"Show N more values"** toggle for the long tail when an
  attribute has more than 3 values.

## What the user sees on payment now

The same scoped-baseline differential, but readable:

> Selection under-represents `0` by -100.0 pp (0 sel vs 905 base).
>
> [tiny histogram]
>
> 0  -100.0 pp     [Search →]
>   sel 0 (0%)
>   base 905 (100%)
>
> 13  +100.0 pp    [Search →]
>   sel 144 (100%)
>   base 0 (0%)

Reading: "Failing payment.Charge calls all return gRPC status 13;
healthy ones all return 0." Click Search next to `13` to see the
matching error spans.

## Validation

Deployed and captured via Playwright. See
`docs/sessions/screenshots/2026-05-29-spotlight-readable/`.

## Pre-merge

tsc clean, lint 0 errors, 104/104 unit tests.

## Follow-ups

- The headline sentence wording could be friendlier ("Failing calls
  always return this value" vs "Selection over-represents X"). Worth
  an A/B once we have feedback from someone other than the OG user.
- Per-value Search button on Service Detail currently drops the
  service+op context onto the Traces page — but the value-pick
  could also navigate to a pre-filtered Errors view if that's more
  useful. Not addressed here.
