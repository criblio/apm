# Spotlight on Service Detail (2026-05-28)

PR I, last in the v0.9.0 faceted-nav thread. Brings the differential
view to Service Detail at two levels:

1. **Service-level Spotlight section** between the health charts and
   the Operations table. Selection = error spans of this service.
   Baseline = the rest of the time window. Answers
   *"why is this service unhealthy?"*
2. **Per-operation Spotlight expansion**. Each Operations table row
   gets a chevron; clicking it expands a Spotlight strip scoped to
   that operation (\`service.name\` + \`name\`). Useful for drilling
   into a single op when its error rate or p95 stands out.

## Engineering wins

- **Concurrency limit on streaming queries.** Service Detail already
  fires ~15 queries (RED metrics, time series, status mix, ops,
  instances, dependencies). Unconditionally fanning out 22 more
  Spotlight queries blew past the cluster's 20-concurrent-job ceiling
  and the tail returned 429s. \`getFacetDistribution\` /
  \`getSpotlightDiff\` now cap parallelism at 4 via a small
  semaphore. Per-attr streaming UX is unchanged — attrs still
  appear one by one, just paced.

- **Curated attribute subset.** Embedded \`<SpotlightSection>\`
  surfaces (Service Detail, possibly Errors in future) can pass an
  \`attributes\` prop with a tighter 8-attr curated list instead of
  the full 22. The Traces page still uses the broad set for the
  dedicated rail.

## Screenshots

- \`00-service-spotlight.png\` — frontend service detail with the
  Spotlight section visible. Health charts populated (no 429s after
  the concurrency fix); Spotlight shows http.status_code 500 at
  +99.1% in the failing-span selection.
- \`01-operation-spotlight-expanded.png\` — clicking the chevron on
  an operation row expands an inline Spotlight panel showing
  rpc.method, http.route, k8s.pod.name and others. The
  k8s.pod.name differential is the killer signal — if one pod is
  dominating the failure spans, that's the smoking gun.

## What's next

After this PR lands the v0.9.0 faceted-nav thread is complete:

- PR D (#46) — query helpers + wrappers ✅
- PR E (#47) — engine + UI primitives ✅
- PR F (#48) — Search page integration ✅
- PR G (#49) — Traces UX guidance + Spotlight default ✅
- PR H (#50) — Errors page Spotlight strip ✅
- PR I (this) — Service Detail Spotlight

Cut v0.9.0 once CI is green.
