# Eval harness — design doc

Resolves every open question from the 2026-04-15 scoping conversation
(`docs/sessions/2026-04-15-cicd-and-eval-harness.md`) and the plan v2
scoring-schema requirement. This is the deliverable ROADMAP §1e calls
for; orchestrator code comes after review.

## Goal

A manual-loop eval tool — run via `npm run eval` — that flips flagd
scenarios against a live Cribl environment, drives the deployed APM
pack in a headless browser, scores both UI surface detection and
Investigator root-cause accuracy, and prints a structured report
showing what's detected and what's not.

The workflow is an **Autoresearch loop**: run → read the report →
fix what's failing (UI changes, agent prompt changes) → deploy →
re-run → repeat until detection scores plateau. Not a nightly
regression gate — the harness runs manually when you want to
evaluate where detection stands and what to improve next.

The value is **before/after comparison**: "did this fix move the
detection score on scenario X?" Historical runs accumulate in a
Cribl dataset for trending.

## Decisions

### 1. Where it runs — developer's machine, same env as tests

The harness runs wherever `npm run eval` is invoked — no dedicated
host, no orchestrator daemon. It uses the same `.env` credentials
the Playwright tests use (`CRIBL_BASE_URL`, `CRIBL_CLIENT_ID`,
`CRIBL_CLIENT_SECRET`, `CRIBL_TEST_EMAIL`, `CRIBL_TEST_PASSWORD`,
`FLAGD_UI_URL`). If the tests work, the eval works.

### 2. Infrastructure — current staging cluster

For now, the harness runs against the same staging workspace and
otel-demo cluster the tests use. A dedicated Lakehouse workspace
becomes worthwhile when the harness runs unattended or when
multiple people need to run evals concurrently — defer that until
the loop proves valuable.

Flag flips do affect the staging cluster's data for other viewers
during the run. The operator is expected to coordinate (same as
running scenario tests today).

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

### 5. Running + reporting

**Invocation:**

```bash
npm run eval                          # full 12-scenario matrix
npm run eval -- --scenario paymentFailure   # single scenario
npm run eval -- --no-investigator     # skip Investigator (faster)
```

The runner prints a live progress line per scenario and a summary
table at the end. Events are also posted to the `apm_evals` Cribl
dataset (if reachable) for historical comparison.

**Console report** (printed at the end of every run):

```
═══════════════════ Eval run 2026-04-19 ═══════════════════
Commit: abc1234  Pack: 0.6.0  Duration: 3h 42m

 Scenario                 Surfaces  Investigator  Score
 ────────────────────────  ────────  ────────────  ─────
 paymentFailure           4/4       ✓ root cause  1.00
 kafkaQueueProblems       2/3       ✗ wrong svc   0.50
 adManualGc               3/3       ✓ root cause  1.00
 paymentUnreachable       3/4       ✗ timed out   0.60
 ...

 Mean score: 0.82  |  12 scenarios  |  9 fully detected
═══════════════════════════════════════════════════════════
```

**Cribl dataset** (`apm_evals`). Same event shape as §4 — events
are posted as the run progresses. When the run finishes, the
`run_summary` event lands. A Cribl Search notebook
(`criblapm__evals_dashboard`) renders the trend across runs:

- **Score over time** per scenario (line chart)
- **Latest run breakdown** (table)
- **Before/after comparison** (diff two run_ids)

The notebook is created once and refreshes on open. Alerting
(scheduled search that fires when detection regresses) can be
added later if the loop becomes automated.

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

### 8. File layout + Playwright fixture

```
eval/
  run.ts                   — CLI entry point (npm run eval)
  engine.ts                — per-scenario runner (flip, wait, drive, score)
  report.ts                — console table + Cribl ingest
  scenarios/
    paymentFailure.ts      — ScenarioDeclaration export
    kafkaQueueProblems.ts
    ...                    — one file per scenario
```

Lives inside the repo as `eval/`, not under `tests/` (these aren't
Playwright Test specs — they're a standalone runner that imports
`playwright-core` directly and reuses helpers from
`tests/helpers/`).

**`package.json` script:**
```json
"eval": "tsx eval/run.ts"
```

**Browser fixture:**

- Launches headless Chromium via `playwright-core`
- Loads `storageState` from the cached Auth0 login
  (`playwright/.auth/cribl-cloud.json` — created by
  `tests/auth.setup.ts`; if stale, `run.ts` runs the setup first)
- Injects `CRIBL_BASE_PATH` + `CRIBL_API_URL` + Bearer token via
  `addInitScript` (same as `tests/helpers/apmSession.ts`)
- Persistent browser context across scenarios (one Auth0 login per
  run); fresh `page` per scenario so page-level state is clean
- `gotoApm(page, path)` for SPA navigation (same helper)

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

- **Automated nightly runs.** The loop is manual for now. When the
  pace of changes warrants it, add a GitHub Actions cron that fires
  `npm run eval` on a dedicated host and posts the summary to the
  Cribl notebook.
- **Multi-cluster / multi-version testing.** v1 tests one pack
  version against one cluster.
- **Synthetic trace injection.** v1 relies on the otel-demo's
  organic traffic + flagd.

## Next steps

1. Scaffold `eval/` in this repo with `run.ts`, `engine.ts`,
   `report.ts`, and 3 starter scenario declarations
   (paymentFailure, kafkaQueueProblems, paymentUnreachable)
2. Wire `npm run eval` in `package.json`
3. Run a single scenario manually to validate the end-to-end loop
   (flip → wait → drive → score → report)
4. Run the full matrix, read the report, and start the first
   improvement cycle: pick the lowest-scoring scenario, fix it,
   deploy, re-run, verify the score improved
5. Provision the `apm_evals` dataset and create the Cribl Search
   notebook once we have 2-3 runs to trend against
