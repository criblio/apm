# Spotlight redesign — small-multiples histograms (2026-05-29)

Two coupled UX fixes for the Spotlight rail surfaced by manual
validation of the v0.9.0 thread:

1. **Tab order was incoherent.** Spotlight was the *default* tab but
   still rendered on the *right*. Visual primacy didn't match the
   default-active state.
2. **The row-per-value layout ate way too much vertical space.** A
   single attribute could take 200+ pixels with header + per-value
   rows + paired sel/base bars + counts. The rail showed 1–2
   attributes at a time; scanning required scrolling.

## What changed

- **Tabs swapped.** Spotlight is now the left/first tab. Facets
  remains accessible one click away.
- **Small-multiples redesign.** Each attribute is one compact cell:
  attr-name + score header, mini-histogram below. The histogram
  draws two thin bars per value (SEL accent + BASE muted) so the
  eye picks up asymmetric shapes — the same gesture Honeycomb's
  BubbleUp panel supports.
- **Click-to-expand detail.** Clicking an attribute's header opens
  the per-value detail list inline beneath the chart — same
  click-to-filter ergonomics as before, just on-demand. Scan in
  histogram mode, drill in row mode.
- **Pure-SVG histograms.** No chart-library dep. ~100-unit viewBox
  with non-scaling-stroke axis line so the bars render crisply at
  any pixel size.
- **Legend** added below the grid so the SEL/BASE color mapping is
  unambiguous.

## Density win

On the Traces page rail (320px wide, 800px tall) the old design
showed 1–2 attributes before scrolling. The new design fits 5–6
attributes in the same vertical space — same data, ~5× scan
efficiency.

## Screenshots

- `00-spotlight-small-multiples.png` — Traces rail with the new
  layout (5 attributes visible: http.response.status_code,
  http.request.method, k8s.pod.name, http.route, session.id).
- `01-spotlight-expanded.png` — clicking the
  http.response.status_code header expands the per-value detail
  rows with click-to-filter buttons.
- `02-service-detail-spotlight.png` — Service Detail's Spotlight
  section using the same component. http.status_code chart shows
  stark asymmetry — selection accent bar on one value, baseline
  gray bar on a completely different value. The visual *is* the
  signal.

## Why this design

Honeycomb's BubbleUp is the proven UX pattern for "what stands out?"
investigation. Their insight: at scale, the human eye is better at
pattern matching small-multiples than at parsing rows of numbers.
We borrow the pattern without copying the trademark name (the
panel stays "Spotlight" per the v0.9.0 thread's naming convention).

## Limitations / follow-ups

- Histograms normalize each chart to its own max share — so when
  one value dominates (e.g., baseline = 97% on `200`), it eats the
  vertical space and other bars are pixel-sized. That's actually
  the right signal for differentiation but can look sparse. A
  follow-up could optionally clip the dominant value when it's
  overwhelmingly the baseline noise.
- The hover tooltip is browser-default (SVG `<title>`). A custom
  tooltip with better typography is a nice-to-have but not
  blocking.
- Detail expansion currently shows ALL rows for an attribute (up
  to maxRowsPerAttr in the engine, default 10). On very high-
  cardinality attrs this could get tall; a "show more" link could
  bound it.

## Pre-merge checks

tsc clean, lint 0 errors (1 pre-existing warning), 101/101 unit
tests, deploy successful, screenshots captured via Playwright spec
on staging.
