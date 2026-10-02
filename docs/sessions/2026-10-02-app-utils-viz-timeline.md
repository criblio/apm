# 2026-10-02 — A8: charts, colours and the trace timeline from `/viz`

APM drops its own `StackedColumnChart`, service-colour hash and trace
`buildTimeline` in favour of `@criblio/app-utils/viz` (0.12.1), and gives
dependency-graph links a stable `id`.

## What moved

- `src/components/StackedColumnChart.tsx` (+ the now-orphaned
  `LineChart.module.css`, used only by it) → `/viz` `StackedColumnChart`.
  The one caller (Service detail → Status mix) passes the same props plus
  `height={180}` to keep the old default.
- `serviceColor` / `serviceColorAtLightness` / `serviceHue` → `/viz`
  `entityColor(id, lightness?)` / `entityHue`. Same 31-multiplier hash; a
  test proves byte-identical strings over 23 sample ids × 4 lightnesses.
- APM `buildTimeline` → `/viz` `buildTimeline` via `jaegerSpanAccessors`
  (parent = first `CHILD_OF` ref, end = start + duration), wrapped as
  `traceTimeline(trace)` in `src/utils/spans.ts`. `SpanTree` reads
  `row.offset / width / inWindow` instead of re-deriving the clip.
  `diff.ts` walks `rows` instead of `nodes`.
- Graph links (`DependencyGraph`, `IsometricGraph`) carry
  `id = kind\0parent\0child`; React keys and hover keys use it.

## Behaviour differences (accepted, documented)

Status mix chart (framework aligns it with the sibling LineCharts):
half-bucket x padding so edge columns are not cut in half; bar width from
the tightest bucket spacing (a data gap no longer fattens every bar);
single bucket centred; bars capped at 64 px; solid gridlines; hover dims
the other columns instead of drawing a crosshair; legend click isolates,
shift-click toggles; tooltip uses the LineChart row layout; x ticks gain the
date past 26 h; repeated y labels are deduplicated.

Timeline: identical order, depths, window and bar geometry to the old code
(property test over 40 generated traces with skew and async overflow).
Edge cases that change, both fixes: a zero-duration span inside the window
now draws a (min-width) bar instead of "outside trace window"; a
self-parented or cyclic span is kept as a root instead of vanishing.

Graph: parallel rpc + messaging edges between one pair keep their own
metrics across a refresh that reorders them (the framework matches
data-only updates by `linkKeys`; without ids those are positional).
