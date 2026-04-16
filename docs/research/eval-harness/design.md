# Eval harness — design doc

Resolves every open question from the 2026-04-15 scoping conversation
(`docs/sessions/2026-04-15-cicd-and-eval-harness.md`) and the plan v2
scoring-schema requirement. This is the deliverable ROADMAP §1e calls
for; orchestrator code comes after review.

## Goal (unchanged from scoping)

A nightly eval suite that flips flagd scenarios against a live Cribl
environment, drives the deployed APM pack in a headless browser, and
scores detection efficacy. The value is **trend over time** — "did
this PR move detection rate on scenario X" — not per-run pass/fail.

## Decisions

### 1. Orchestrator host — clintdev for v1

clintdev already has kubectl access to the otel-demo cluster,
Tailscale connectivity, Node.js, and the full repo toolchain. A
dedicated VPS adds cost + setup overhead not justified until the
harness is proven.

**Migration path:** the orchestrator is a single Node.js script
configured via env vars (`FLAGD_UI_URL`, `CRIBL_BASE_URL`,
`CRIBL_CLIENT_ID`, `CRIBL_CLIENT_SECRET`, `CRIBL_TEST_EMAIL`,
`CRIBL_TEST_PASSWORD`). Moving to a VPS means deploying the script
and setting those vars. No structural change needed.

### 2. Dedicated Lakehouse workspace + otel-demo deployment

Flipping flagd corrupts everyone else's view of the dataset for the
run duration, so the eval harness needs its own:

- **Cribl workspace**: a Lakehouse workspace (not Lake — query
  performance matters for the multi-scenario run) with its own
  `otel` dataset. The harness authenticates with a dedicated
  client-credentials pair.
- **otel-demo cluster**: a dedicated `kind` cluster (or namespace)
  on clintdev running `criblio/otel-demo-criblcloud`. The three
  in-place fixes from the 2026-04-15 session (sysctl, product-
  catalog memory, LOCUST_BROWSER_TRAFFIC_ENABLED) are committed
  to the cluster's `values.yaml` so fresh deploys come up
  scenario-ready.
- **flagd-ui access**: `kubectl port-forward svc/flagd 4001:4000`
  on a different port than the dev cluster so the two don't
  collide. `FLAGD_UI_URL=http://localhost:4001`.

### 3. Scenario list for v1 — the 12 fully-detected scenarios

Post-§1d, 12 of 15 scenarios have working UI surfaces:

| # | Scenario | Flag | Expected service |
|---|---|---|---|
| 1 | paymentFailure | paymentFailure 50% | payment |
| 2 | kafkaQueueProblems | kafkaQueueProblems on | fraud-detection, accounting |
| 3 | adManualGc | adManualGc on | ad |
| 4 | loadGeneratorFloodHomepage | loadGeneratorFloodHomepage on | frontend |
| 5 | cartFailure | cartFailure on | cart |
| 7 | productCatalogFailure | productCatalogFailure on | product-catalog |
| 8 | recommendationCacheFailure | recommendationCacheFailure on | recommendation |
| 9 | paymentUnreachable | paymentUnreachable on | payment |
| 10 | adHighCpu | adHighCpu on | ad |
| 11 | emailMemoryLeak | emailMemoryLeak 100x | email |
| 12 | failedReadinessProbe | failedReadinessProbe on | cart |
| 14 | llmRateLimitError | llmRateLimitError on | product-reviews |

Excluded: `adFailure` (10% Bernoulli — detected but poor SNR for
trending), `llmInaccurateResponse` (semantic), `imageSlowLoad`
(client-side / RUM). Can be added later.

### 4. Results storage — events in a dedicated Cribl dataset

Dogfooding: the harness sends its results to a dedicated
`apm_evals` dataset in the same Cribl workspace the app runs
against, then visualizes the trend in a Cribl Search notebook.
This replaces the original "flat JSON in sibling repo" plan —
we get native KQL querying, alerting, and trending without any
new infrastructure. It also aligns with ROADMAP's "lean on Cribl
Search" guiding principle.

**Event shape.** One event per surface check + one summary event
per scenario + one per run, all to the same dataset with a `type`
discriminator. This lets one dataset answer every useful query
via a `where type==...` filter.

```json
// type=surface_check — one per surface check per scenario per run
{
  "_time": 1776300000,
  "type": "surface_check",
  "run_id": "2026-04-17T00:00:00Z",
  "commit_sha": "abc1234",
  "pack_version": "0.6.0",
  "scenario": "paymentFailure",
  "surface": "homeErrorChip",
  "detected": true,
  "latency_ms": 12000,
  "score": 1.0
}

// type=scenario_summary — one per scenario per run
{
  "_time": 1776300120,
  "type": "scenario_summary",
  "run_id": "2026-04-17T00:00:00Z",
  "commit_sha": "abc1234",
  "scenario": "paymentFailure",
  "detected_count": 4,
  "total_checks": 4,
  "score": 1.0,
  "investigator_score": 0.85,
  "duration_sec": 1200
}

// type=run_summary — one per run
{
  "_time": 1776300300,
  "type": "run_summary",
  "run_id": "2026-04-17T00:00:00Z",
  "commit_sha": "abc1234",
  "pack_version": "0.6.0",
  "scenarios_run": 12,
  "mean_score": 0.91,
  "fully_detected": 10,
  "partially_detected": 2,
  "missed": 0,
  "duration_min": 240
}
```

**Ingest.** The orchestrator POSTs events to the workspace's HTTP
ingest endpoint (HEC-compatible) with the same client-credentials
Bearer token the Playwright tests already mint. No new auth setup.

**Safety net.** The orchestrator also logs the full event stream to
stdout and to a local `results/latest.jsonl` file. If the Cribl
ingest POST fails (workspace down, credentials expired), the run
data isn't lost; it can be replayed after the fact.

### 5. Trigger + reporting — GitHub Actions cron → Cribl notebook

v1 flow:

1. `.github/workflows/eval.yml` fires nightly on cron
   (`0 4 * * *` UTC = late evening Pacific).
2. Workflow calls a `repository_dispatch` webhook on clintdev's
   orchestrator listener (Tailscale-exposed). Payload includes the
   commit SHA and pack version.
3. Orchestrator runs the scenario matrix sequentially (see §7
   below).
4. For each scenario, the orchestrator POSTs surface-check events
   to the `apm_evals` dataset as the checks execute. The
   scenario_summary event posts after the scenario completes; the
   run_summary event posts at the end.

**Visualization.** A Cribl Search notebook
(`criblapm__evals_dashboard`) with saved queries renders the trend.
The notebook is created once, manually, then auto-refreshes when
opened. Starter panels:

- **Detection rate over time** (line chart, one series per scenario):
  ```
  dataset="apm_evals" | where type=="surface_check"
  | summarize detection_pct=avg(iff(detected, 1.0, 0.0))*100
    by scenario, bin(_time, 1d)
  | sort by _time asc
  ```
- **Latest run** (table):
  ```
  dataset="apm_evals" | where type=="scenario_summary"
  | summarize latest_ts=max(_time), score=maxif(score, _time)
    by scenario
  | sort by score asc
  ```
- **Regression spotter** (score delta vs 7-day median):
  ```
  dataset="apm_evals" | where type=="scenario_summary"
    and _time > ago(14d)
  | summarize score_today=maxif(score, _time > ago(1d)),
              score_7d_median=percentile(score, 50)
    by scenario
  | extend delta=score_today-score_7d_median
  | where delta < -0.1
  | sort by delta asc
  ```

**Alerts.** A Cribl scheduled search + notification target fires
when any scenario's mean score drops below 0.8 over the last two
runs. Uses the same alerting primitives ROADMAP §2 calls for.

No `gh pr comment` and no Checks API for v1 — the notebook is the
dashboard. If we want per-PR reporting later, a small scheduled
search can post a comment to the most recent PR via `gh pr
comment` in a follow-up GitHub Actions job.

### 6. Investigator scoring — LLM-as-judge, budgeted

Per scenario, the harness optionally submits an Investigator prompt
and scores the response:

- **Prompt**: "Why are there {errorType} errors on {service} in the
  last 15 minutes? Summarise root cause." (parameterized from the
  scenario declaration, not hard-coded in the engine)
- **Wait**: up to 5 minutes for the Summary card
- **Scoring**:
  - `completed`: did a Summary card appear within budget?
  - `mentionsRootCause`: does the transcript match the scenario's
    `expectedRootCausePattern` regex?
  - `score`: 0.0 (no summary), 0.5 (summary but wrong cause),
    1.0 (summary + correct cause)

**Cost**: ~$1-2 per Investigator call × 12 scenarios = ~$12-24 per
run, ~$360-720/month. Not blocked for v1 per the user. Revisit if
the nightly bill surprises.

**Opt-out**: each scenario declaration has an `investigator?: true`
flag. Scenarios where the Investigator isn't meaningful (e.g.
`loadGeneratorFloodHomepage` — traffic surges aren't "errors")
skip the Investigator step.

### 7. Scoring rule schema — parameterized, no service names in engine

```typescript
interface ScenarioDeclaration {
  name: string;
  flag: string;
  variant: string;
  expectedService: string;
  telemetryWaitMs: number;
  cooldownMs: number;
  surfaceChecks: SurfaceCheck[];
  investigator?: {
    prompt: string;
    expectedRootCausePattern: string; // regex
    waitMs: number;
  };
}

interface SurfaceCheck {
  surface: string;     // e.g. 'homeErrorChip', 'svcDetailP99'
  page: 'home' | 'serviceDetail' | 'systemArch';
  locator: string;     // Playwright locator string
  assertion: 'visible' | 'countGt0' | 'textMatches';
  pattern?: string;    // for textMatches
  timeoutMs: number;
}
```

The **engine** is a generic runner: for each declaration, flip flag →
wait → navigate pages → evaluate checks → score → flip off → wait
cooldown. No service names, no flag names, no operation names in the
engine code. Adding a scenario means adding a declaration to the
`scenarios/` directory.

### 8. Playwright fixture shape

```
eval-harness/
  orchestrator.mjs        — main loop: parse declarations, run matrix
  engine.mjs              — per-scenario runner (flip, wait, drive, score)
  lib/
    flagd.mjs             — reexports tests/helpers/flagd.ts (or copy)
    criblSearch.mjs        — reexports tests/helpers/criblSearch.ts
    browser.mjs            — Playwright launcher with storageState
  scenarios/
    paymentFailure.json    — ScenarioDeclaration
    kafkaQueueProblems.json
    ...
  results/                 — gitignored locally; pushed to apm-evals
```

The browser fixture:

- Launches headless Chromium via `playwright-core`
- Loads `storageState` from a cached Auth0 login (same flow as
  `tests/auth.setup.ts`, run once at orchestrator start)
- Injects `CRIBL_BASE_PATH` + `CRIBL_API_URL` + Bearer token via
  `addInitScript` (same as `tests/helpers/apmSession.ts`)
- Persistent context across scenarios (no re-login per scenario)
- `gotoApm(page, path)` for SPA navigation (same helper)

Each scenario run gets a fresh `page` within the same context so
cookies/storageState carry over but page-level state is clean.

## Runtime estimate

Per scenario (sequential):

| Phase | Duration |
|---|---|
| Flip flag | ~1s |
| Telemetry wait | 3 min |
| UI surface checks (Home + ServiceDetail) | 1-2 min |
| Investigator (optional) | 0-5 min |
| Flip off + cooldown | 15 min |

Total per scenario: ~19-25 min. 12 scenarios × 22 min (median) =
**~4.4 hours**. Fits in a nightly window.

Optimization for v2: run non-conflicting scenarios with shorter
cooldowns (scenarios affecting different services can overlap their
cooldown with the next scenario's ramp-up). Could bring total to
~2-3 hours.

## What this does NOT cover

- **Multi-cluster / multi-version testing.** v1 tests one pack
  version against one cluster. Testing across Cribl Cloud versions
  or Lakehouse vs Lake is out of scope.
- **Synthetic trace injection.** v1 relies on the otel-demo's
  organic traffic + flagd. Synthetic injection for controlled
  baselines is a v2 idea.
- **PR-level reporting.** The notebook is the dashboard; per-PR
  comments with the run delta are a cheap v2 add-on.

## Next steps after review

1. Provision the `apm_evals` dataset on the Lakehouse workspace +
   create the HTTP ingest endpoint (or confirm an existing one
   accepts writes from the client-credentials token)
2. Scaffold `eval-harness/` in this repo with the orchestrator,
   engine, browser helper, Cribl ingest client, and 2-3 scenario
   declarations (paymentFailure, kafkaQueueProblems,
   paymentUnreachable — the three most distinct failure shapes)
3. Run manually on clintdev to validate one full matrix pass
4. Create the `criblapm__evals_dashboard` Cribl Search notebook
   with the three starter panels from §5
5. Wire the GitHub Actions cron trigger
6. Let it run nightly for a week, eyeball the notebook, decide
   whether to expand to all 12 scenarios and wire the regression
   alert
