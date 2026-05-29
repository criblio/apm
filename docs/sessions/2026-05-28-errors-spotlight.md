# Spotlight on the Errors page (2026-05-28)

PR H. Brings the Honeycomb-BubbleUp-style differential view to the
Errors page so users can answer *"why is this error happening?"*
without leaving the page or knowing what filters to type.

## What changed

- **Expandable error rows.** Each error group row now has a chevron;
  clicking the row toggles a Spotlight strip immediately beneath it.
- **Per-error Spotlight.** Selection KQL is
  `service.name == "<svc>" and name == "<op>" and status.code == "2"` —
  spans matching this error class. Baseline is the rest of the
  time window. The differential surfaces what's distinct about the
  failing spans relative to everything else flowing through.
- **Click-to-Search.** Clicking any value in the Spotlight panel
  navigates to the Traces page pre-seeded with the error's service,
  operation, lookback, and the picked attribute filter. The user
  goes from "what's this error?" to "show me the matching spans"
  in two clicks.
- **Reusable `<SpotlightSection>`.** Extracted the streaming-fetch +
  panel-render plumbing into one component so PR I (Service Detail)
  can drop it in without re-implementing the same data layer dance.
- **How-to banner.** Above the table, a one-sentence accent-colored
  banner tells the user what clicking does and why. No mystery
  meat affordances.

## Screenshots

- `00-errors-collapsed.png` — table with chevron affordances and
  the explanatory banner. Nine error groups visible in the staging
  demo (frontend, load-generator, product-catalog, flagd, etc.).
- `01-errors-spotlight-expanded.png` — clicking the first row
  expands Spotlight showing eight ranked attributes
  (`rpc.system`, `http.response.status_code`, `http.request.method`,
  `http.route`, `rpc.method`, `messaging.destination.name`,
  `messaging.operation`, `http.method`) with per-value sel/base
  bars and diff %.

## Validation

Deployed to staging. `tests/errors-spotlight-screenshots.spec.ts`
captures both states. Pre-merge: tsc clean, lint 0 errors,
101/101 unit tests, build green.

## Next

- PR I: Spotlight on Service Detail — service-level slice plus
  per-operation-anomaly drilldown using the same SpotlightSection.
- After PR I merges, cut v0.9.0.
