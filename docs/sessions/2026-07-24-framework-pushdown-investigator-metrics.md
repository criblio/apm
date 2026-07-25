# 2026-07-24 — Framework push-down + investigator metrics tool

Two coupled efforts, both landing shared code in
`cribl-search-app-framework` (`packages/app-utils`) and wiring APM to
consume it via the `file:..` reference:

1. **Investigator can query the fast metrics store** — a reusable
   PromQL agent tool (`run_metrics_query`) now lives in the framework,
   the APM investigator uses it, and the mid-thought query-approval
   prompt is turned off.
2. **Push down common 0.13 infra** — nav-scoped query cancellation, the
   metrics dedupe+cache, and the signal-aware browser `runQuery` moved
   from APM into the framework so every app gets them.

## What moved into the framework

| Concern | New framework home | Old APM home (now a re-export shim) |
|---|---|---|
| Nav-scoped cancellation (generation controller + `withGenerationSignal` / `captureQueryGeneration`) | `src/query-generation.ts` (+ `@cribl/app-utils/query-generation` subpath) | `src/api/queryGeneration.ts` |
| Metrics dedupe + short-TTL cache | `cachedQueryInstant` / `cachedQueryRange` / `clearMetricsCache` in `src/metrics.ts` | `src/api/metricsCache.ts` |
| Signal-aware browser search client + generation-defaulting `runQuery` | `src/search.ts` (upgraded) | `src/api/cribl.ts` |
| Reusable PromQL agent tool | `createRunMetricsQueryTool` + `MetricsQueryUi` in `src/agent-tools.ts` | (new — modelled on ubiquiti's inline `runMetricsQueryTool`) |
| Metrics chart result card | `src/investigator/MetricsToolCard.tsx` (+ `@cribl/app-utils/investigator/metrics-tool-card` subpath) | (new — promoted from ubiquiti's `MetricsToolCard`) |

### Key design decisions

- **One generation controller.** `runQuery` in the framework now defaults
  its abort signal to `withGenerationSignal(signal)`. Because APM's
  `queryGeneration.ts` is a thin re-export of the framework module, the
  app's `newQueryGeneration()` on nav and the framework search layer read
  the *same* singleton controller — that's the whole point of pushing it
  down. Backward compatible: an app that never calls
  `newQueryGeneration()` keeps the initial never-aborted controller, so
  the default is a no-op (ubiquiti unaffected).
- **Re-export shims are the established pattern here.** `src/api/metrics.ts`
  already re-exports `@cribl/app-utils/metrics` to keep browser code off
  the framework root barrel (which pulls the provisioner → `node:fs`).
  `queryGeneration.ts` / `metricsCache.ts` / `cribl.ts` now follow suit —
  one-line shims over browser-safe subpaths, so existing APM imports are
  untouched and the framework is the single source of truth.
- **The shell stays viz-free.** The metrics chart card pulls the d3-based
  `viz` kit, so it is NOT baked into `InvestigatorChat` (which would force
  d3 on every consumer). It's an opt-in component on its own subpath;
  apps render it via the existing `renderToolCard` hook. Mirrors
  ubiquiti's deliberate split, now shared.
- **No approval prompt.** `requiresApproval` returns `false` for every
  tool. Both data tools are read-only (run_search guarded by
  `assertReadOnlyKql`, PromQL has no mutating forms), so the security
  boundary is execution-time blocking, not the prompt. The
  `agentToolsSecurity` test was reframed accordingly — the side-effect
  and scope-escape blocks (the real boundary) still pass.

### Investigator preamble

`agentContext.ts` gained a "Fast RED numbers — use `run_metrics_query`
first" section listing the `criblapm_*` series and read semantics (delta
counters → `sum_over_time`; latency gauges labelled `quantile` →
`avg_over_time`), so the agent reaches for the ~100ms metrics store before
KQL / `$vt_results` for rate, error rate, and latency.

## Validation

- **Framework:** `tsc --noEmit` clean; `vitest run` 42 tests pass
  (added `query-generation`, `metrics-cache`, `agent-tools-metrics`).
- **APM:** `eslint` 0 errors; `vitest` 353 tests pass (dropped the
  now-obsolete `metricsCache.test.ts` — that logic + test moved to the
  framework); `tsc --noEmit` clean; `npm run build` succeeds (new
  subpath resolves and bundles via `file:..`).

## Ship steps (NOT yet done — gated on framework commit)

Everything above is validated locally through the `file:..` framework
reference. To make it shippable / reviewable on GitHub / deployable to
staging:

1. Commit the framework changes; note the new 40-char SHA.
2. Bump APM's `.framework-sha` to that SHA.
3. Open the framework PR (`chore:`-style, list the changes) and the APM
   PR (investigator metrics tool + infra push-down + SHA bump).
4. `npm run deploy` (reconciles provisioning) and validate the
   investigator metrics card on staging via Playwright.

## Files touched

**Framework** (`packages/app-utils/src`): `query-generation.ts` (new),
`search.ts`, `metrics.ts`, `agent-tools.ts`, `index.ts`,
`investigator/MetricsToolCard.tsx` (+ `.module.css`, new), `package.json`
(2 subpath exports), `__tests__/{query-generation,metrics-cache,agent-tools-metrics}.test.ts` (new).

**APM** (`src`): `api/queryGeneration.ts`, `api/metricsCache.ts`,
`api/cribl.ts` (→ shims), `api/agentToolDefs.ts`, `api/agentTools.ts`,
`api/agentContext.ts`, `routes/InvestigatePage.tsx`,
`api/__tests__/agentToolsSecurity.test.ts`; removed
`api/__tests__/metricsCache.test.ts`.
