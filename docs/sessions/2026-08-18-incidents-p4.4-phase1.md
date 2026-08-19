# Incidents P4.4 Phase 1 — alerts→incidents grouping + state fold

**Session date:** 2026-08-18 (evening). Continues the P4.4 plan from
[2026-08-18-incidents-and-code-investigation-ux.md](./2026-08-18-incidents-and-code-investigation-ux.md);
design in
[incidents-and-lifecycle.md](../research/server-investigations/incidents-and-lifecycle.md).

## What shipped

P4.4 Phase 1: incidents now exist as data, entirely Cribl-Search-native
(no cell, works with `serverInvestigations` off). Three cooperating
scheduled searches on the 5-minute cadence:

| offset | search | job |
|---|---|---|
| +3 min | `criblapm__incident_grouper` | firing transitions → attach to a live incident (lookup join on svc, then single-hop graph adjacency) or open a new time-binned one; appends `opened`/`attached` events |
| +4 min | `criblapm__incidents_state` | incremental fold → one row per (incident, svc) with derived status/severity, in `$vt_results` |
| +0 min (next cycle) | `criblapm__incidents_export` | latest fold run's non-closed rows → `criblapm_incidents` lookup (the grouper's join surface) |

Plus: `criblapm_incidents` seed lookup, `listCachedIncidents()` /
`Q.incidentEvents()` read path with `IncidentSummary` /
`IncidentTimelineEntry` types, and an `incidentPipeline.test.ts`
suite pinning the KQL shapes, idempotency joins, and provisioning
wiring (snapshots + provision-guard).

## Design decisions (delta from the design doc)

- **Incremental fold, not recompute.** The first fold implementation
  replayed -7d of incident events with ~8 join subqueries — each
  subquery is a full-window dataset scan (>60s each on staging), which
  would have saturated the pool P4.5 just relieved. Rewrote to the
  evaluator pattern: read own previous output from `$vt_results`
  (latest-jobId self-join), merge a -1h delta with event_id dedup +
  per-member high-water `_time` mark. Documented as a skill.md query
  pattern.
- **Resolution is fold-derived state, not an event.** All-clear
  (via the evaluator's `criblapm__home_alerts` panel cache) + 10m
  debounce → `resolved`; 24h quiet → `closed`; refire reopens
  automatically because status is recomputed. The `resolved` notify
  event lands with Phase 5.
- **Root service = first-firing member** for now; graph-derived
  root (downstream-most erroring node) comes with Phase 4's
  `/config/graph`. The grouper *does* use graph adjacency for attach.
- **New-incident identity is window-binned** (`inc:<bin(fire_time,
  15m)>`): all unmatched fires in a bin collapse to one incident.
  Deliberate over-coalescing bias — cascades usually spread across
  cycles and attach via the lookup; the supervisor (Phase 6) can split.

## Staging-verified KQL findings (now in skill.md)

1. **`project _time=<column>` after a `union` silently nulls `_time`
   on subquery-branch rows.** Main-branch rows keep it. A sort barrier
   between the union and the assignment fixes it. Constant
   `_time=now()` is unaffected. (Cost ~40 min to isolate.)
2. **Fold searches must be incremental** — see above.
3. Multi-key `join ... on a, b` and `join kind=leftanti` both work
   (verified before betting the dedup design on them).

## Validation

- Unit: 453 tests green, lint 0, tsc clean.
- Live (pre-provision): grouper body over -24h produced exactly one
  `opened` + one `attached` for yesterday's load-generator fire with
  deterministic ids; fold + reader parse clean on empty state.
- Deployed **0.13.46**; provisioner created all three searches + seed.
- End-to-end: flipped `paymentFailure 50%` (recommendationCacheFailure
  left on) and watched the live pipeline — results in the PR test
  plan section.

## Known limitations (Phase 1)

- Fold state carried via `$vt_results` is only visible inside the -1h
  search window: pausing the fold longer loses accumulated state (the
  event log in the dataset stays complete; active incidents rebuild
  from ongoing fires). A daily reconciliation search can land with
  Phase 3 if it bites.
- A human `closed` between fold cycles can still receive attaches for
  ≤10 min (until the export drops the row from the lookup).
- Status/severity override folding uses plain `max()` within the
  delta window — fine until the Phase 2 warroom UI writes them.
- No UI yet: Phase 1 is the data pipeline + read path. The Incidents
  list/detail UI is Phase 2.

## Environment state

- flagd: `paymentFailure` flipped to 50% for validation, then **off**;
  `recommendationCacheFailure` remains ON (unchanged from checkpoint).
- App: **0.13.46** deployed to staging.
- Branch: `feat/incidents-p4.4-phase1` (PR pending).
- Dev box: `scripts/cribl-mcp.sh` now auto-detects the PVE AppArmor
  quirk (was: every `docker run` failed).
