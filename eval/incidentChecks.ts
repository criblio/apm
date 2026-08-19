/**
 * Standard incident-layer checks (P4.4), appended by the engine to any
 * scenario declaring `expectsIncident: true`. One definition instead of
 * 9+ hand-copied blocks, so the incident contract's eval coverage can't
 * drift per scenario.
 *
 * Layers covered:
 *   1. Alerts page — the Incidents section lists a live incident whose
 *      services include the scenario's service (the "Open" tag only
 *      appears in the Incidents table, so the row locator can't match
 *      the Episodes/Currently-Active tables).
 *   2. Incident drill-in page — Summary + Services sections render for
 *      that incident (navigation handled by the engine's `incident`
 *      page type).
 *   3. Dataset — `record_kind:'incident'` opened/attached events exist
 *      for the service.
 *   4. Read model — the state fold has a live row for the service.
 */
import type { KqlCheck, SurfaceCheck } from './types.js';

export function incidentSurfaceChecks(svc: string): SurfaceCheck[] {
  return [
    {
      surface: `incidentListed_${svc}`,
      page: 'alerts',
      locator: `table tr:has-text("${svc}"):is(:has-text("Open"), :has-text("Investigating"), :has-text("Identified"))`,
      assertion: 'countGt0',
      timeoutMs: 120_000,
    },
    {
      surface: `incidentPageSummary_${svc}`,
      page: 'incident',
      locator: 'h2:has-text("Summary")',
      assertion: 'visible',
      timeoutMs: 30_000,
    },
    {
      surface: `incidentPageMember_${svc}`,
      page: 'incident',
      locator: `h2:has-text("Services") ~ * a:has-text("${svc}"), table a:has-text("${svc}")`,
      assertion: 'countGt0',
      timeoutMs: 30_000,
    },
  ];
}

export function incidentKqlChecks(svc: string): KqlCheck[] {
  return [
    {
      surface: `incidentEvents_${svc}`,
      query: `dataset="otel" | where coalesce(tostring(data_datatype), tostring(datatype)) == "criblapm_alert" | where record_kind == "incident" and event_type in ("opened", "attached") and services == "${svc}"`,
      earliest: '-45m',
      latest: 'now',
      assertion: 'rowCountGt0',
      timeoutMs: 12 * 60_000,
      pollIntervalMs: 30_000,
    },
    {
      surface: `incidentFoldRow_${svc}`,
      query: `dataset="$vt_results" | where jobName == "criblapm__incidents_state" and svc == "${svc}" | project status`,
      earliest: '-1h',
      latest: 'now',
      assertion: 'fieldMatches',
      field: 'status',
      pattern: 'open|investigating|identified',
      timeoutMs: 12 * 60_000,
      pollIntervalMs: 30_000,
    },
  ];
}
