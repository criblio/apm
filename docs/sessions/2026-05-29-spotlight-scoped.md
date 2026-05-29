# Spotlight scoped baseline (2026-05-29)

The Service Detail and Errors-page Spotlight surfaces were comparing
the wrong things. Original design:

- Selection: error spans of this service
- Baseline: everything else in the time window

That baseline includes traffic from *every other service*, so the
top-ranked attributes ended up being whatever made *this service
different from other services* — `rpc.method=Charge` ranks high on
payment because no other service does Charge, but that's not the
question the user is asking. They want to know *what changed when
this service started failing*, which the comparison can't surface
when the baseline is contaminated.

## What changed

- **`spotlightAttrDiff` accepts a `scopeKql` param** — a clause that
  restricts BOTH selection and baseline. With a scope, the
  differential answers "what's different about the selection vs the
  rest of the scope" instead of "vs the rest of the window."
- **`getSpotlightDiff` signature changed** — positional `topPerAttr`
  / `onAttr` collapsed into a single `SpotlightDiffOptions` object
  to make room for `scopeKql` without breaking later additions.
- **`SpotlightSection` accepts `scopeKql`** and plumbs it through.
- **Service Detail call site**: scope = `service.name == X`,
  selection = `status.code == "2"`. Compares failing spans of this
  service against healthy ones.
- **Per-op expansion**: scope = `service + operation`, selection =
  `status.code == "2"`. Compares failing calls of this op against
  successful ones.
- **Errors page expansion**: same scope as per-op (service + op),
  same error selection.
- **Captions rewritten** to describe the new comparison clearly —
  "failing vs healthy calls of this operation" etc.

## Attribute list broadened

`SPOTLIGHT_ATTRIBUTES` got 5 new "where did this come from?" entries:

- `peer.service` — upstream caller identity
- `net.peer.name` / `net.peer.port` — network peer
- `error.type` — OTel error fingerprint
- `exception.type` — exception class

These tend to dominate the ranking when the user is investigating
why a service is failing.

## Validation

`paymentFailure 50%` active on staging. Captured shots:

- `02-payment-spotlight-loaded.png` — paymentservice detail. Only
  ONE attribute now surfaces in Spotlight: `rpc.grpc.status_code`
  (score 6.68). That's the correct, focused answer — the previous
  baseline was showing 5–6 attrs that were just "payment is a gRPC
  service" noise.
- `01-errors-spotlight-scoped.png` — Errors page expansion of the
  payment / oteldemo.PaymentService/Charge error class. Title now
  reads "Spotlight — failing vs healthy calls of payment /
  oteldemo.PaymentService/Charge". The differential surfaces
  rpc.grpc.status_code as the differentiator.

## Caveats

- "Fewer attributes" is the right outcome but it can look like the
  panel is broken. The empty-state message could be improved to say
  "everything matches between failing and healthy" rather than
  "nothing stands out yet."
- The Status Mix chart on Service Detail still shows zero errors
  for gRPC services because it slices by HTTP status code classes
  exclusively. Separate bug — follow-up PR.
- Some of the newly added attributes (`peer.service`,
  `exception.type`, etc.) aren't populated on the OTel demo, so
  they get silently dropped by the engine.

## Tests

- New test cases in `facetedNav.test.ts` for scope plumbing: omits
  scope when undefined, injects scope as `where` before extend,
  treats whitespace as no scope.
- Existing tests still pass (signature change was additive).
- 104/104 total passing.

## Next

- gRPC-aware Status Mix chart.
- Empty-state copy improvement for scoped Spotlight when the
  selection matches the baseline (rare in practice but worth
  handling).
