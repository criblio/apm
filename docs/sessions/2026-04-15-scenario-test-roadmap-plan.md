> **Stale** — this handoff doc was superseded by `docs/sessions/2026-04-15-scenario-plan-v2.md`, which was itself superseded by ROADMAP.md §1d. Kept for historical context.

# Session handoff: scenario-test → roadmap plan (2026-04-15)

Written to pick up this work on a different machine. Read this first,
then `docs/sessions/2026-04-15-scenario-1-payment-failure.md` for the
prior session's detailed findings, then pick one of the "Proposed PR
sequence" items below.

Current master is at v0.5.0 (released earlier today). Cluster is
healthy. Scenario 1 is shipped. The rest of this doc is about the
plan, not the history.

## Where things stand

### Shipped in the current session

- **PR #5** (`scripts/flagd-api`) — rewrote `flagd-set.sh` to talk to
  the flagd-ui HTTP API instead of SSH + kubectl. `FLAGD_UI_URL` now
  required; `.env.example` has the port-forward recipe.
- **PR #6** (session branch → master) — rolled up flagd-api +
  playwright-framework onto master.
- **PR #7** (`scenarios/payment-failure`) — scenario 1 spec + helpers
  + session log. Soft-asserts every surface FAILURE-SCENARIOS §1
  describes.
- **v0.5.0** — first tagged release, `apm-0.5.0.tgz` attached at
  https://github.com/criblio/apm/releases/tag/v0.5.0. GitHub Actions
  workflow `release.yml` does the bundle-and-attach; it triggers on
  any `v*` tag whose name matches `package.json`.

Default branch is `master`. All session branches deleted.

### Test infrastructure that now exists

```
tests/
  auth.setup.ts               Auth0 login → storageState cache
  apm-smoke.spec.ts           NavBar render check (uses helpers)
  helpers/
    apmSession.ts             installCriblHostGlobals + gotoApm
                              (injects CRIBL_BASE_PATH + CRIBL_API_URL,
                               wraps fetch with Bearer token from
                               OAuth client-credentials)
    flagd.ts                  setFlag / allOff against FLAGD_UI_URL
  scenarios/
    payment-failure.spec.ts   Scenario 1 (§1 in FAILURE-SCENARIOS.md)
```

Playwright config is in `playwright.config.ts`. `testMatch: /.*\.spec\.ts$/`
picks up anything under `tests/` recursively. Run via:

```bash
npx playwright test tests/scenarios/payment-failure.spec.ts
```

Timings to respect when running scenario tests:

- Each scenario test: ~4–5 minutes (3 min telemetry wait + click-drive
  + 5 min Investigator budget + teardown)
- Between scenario runs: **wait 15–30 minutes** so both the current
  and previous 15-minute windows are clean of the prior run's signals
- Tests don't belong in CI yet — run them manually until the "promote
  soft → hard" loop has stabilized enough assertions to be reliable

### Cluster state (clintdev / otel-demo-criblcloud)

Three in-place fixes applied this session, all persist until a
helm reinstall or docker restart. None are committed to
`criblio/otel-demo-criblcloud` yet — they need to land there as
values.yaml overrides + host-setup doc so a fresh cluster comes up
scenario-ready.

| Fix | Persists via | Upstream bug |
|---|---|---|
| `fs.inotify.max_user_instances=8192`, `max_user_watches=524288` | `/etc/sysctl.d/99-kind.conf` on clintdev | kind known issue; see https://kind.sigs.k8s.io/docs/user/known-issues/#pod-errors-due-to-too-many-open-files |
| `product-catalog` memory 20Mi → 128Mi | `kubectl set resources` (NOT persisted in helm chart) | https://github.com/open-telemetry/opentelemetry-helm-charts/issues/2121 |
| `LOCUST_BROWSER_TRAFFIC_ENABLED=false` on load-generator | `kubectl set env` (NOT persisted) | v2.2.0 `WebsiteBrowserUser.tracer` AttributeError; fixed in upstream master, not released |

flagd-ui is exposed via a `kubectl port-forward svc/flagd 4000:4000 --address 0.0.0.0`
running as a detached `kubectl` process on clintdev. Survives until
reboot. Reach it from your dev machine via `http://clintdev:4000`.

If you're on a new machine where clintdev isn't reachable:
- You need network path to clintdev (Tailscale / VPN / LAN). If you
  don't have it, run a local kind cluster with `otel-demo-criblcloud`
  and point `FLAGD_UI_URL` at `http://localhost:4000` instead.
- Or use `ssh -L 4000:localhost:4000 clintdev` and point at
  `http://localhost:4000`.

### `.env` prerequisites for running tests

```
CRIBL_BASE_URL=https://main-objective-shirley-sho21r7.cribl-staging.cloud/
CRIBL_CLIENT_ID=<from 1Password or existing clintdev .env>
CRIBL_CLIENT_SECRET=<same>
CRIBL_TEST_EMAIL=<login creds for Auth0>
CRIBL_TEST_PASSWORD=<same>
FLAGD_UI_URL=http://clintdev:4000
```

The Bearer-token injection in `tests/helpers/apmSession.ts` needs
`CRIBL_CLIENT_ID` / `CRIBL_CLIENT_SECRET` — the same credentials
`scripts/deploy.mjs` uses. Without them tests get 401 on API calls.

## The plan — "scenario → fix → promote" ratchet

Each scenario test codifies "what surfaces should catch this failure"
using soft assertions. Each soft-failure becomes a fix PR or a
roadmap item. Once the fix lands, the assertion flips from soft to
hard in the same PR, so regressions can't sneak back. Over time this
turns the scenarios dir into a growing regression harness while
driving real roadmap progress.

Per scenario, the loop is:

1. Write the spec with every surface soft-asserted
2. Run against the deployed pack
3. For each soft failure:
   - Small + clear → fix PR
   - Architectural → add a roadmap item with concrete scope
4. Re-run, confirm surface now lights up
5. Promote the assertion from soft to hard in the fix PR

## Findings from scenario 1 (already captured in its session log)

One unresolved soft-fail: **Home Error classes panel empty under
cache-miss.** Root cause is the `criblapm__home_error_spans`
scheduled search running against a previously-broken cluster. Live
query works (verified); cache path is stale. Fix is PR #1 below.

Everything else in scenario 1 passed. Investigator transcript is
genuinely excellent — it identifies the regression, pulls the real
error message via a cross-service join, renders a representative
trace, and produces a clean Summary Card. That's the bar other
scenarios should meet.

## Proposed PR sequence

Ordered so each PR unblocks the next. All branch off master.

### PR #1 — `fix/home-error-classes-cache-fallback`
**Scope:** When `panelCache.buildCachedPanels` returns `errorClasses === null`
OR an empty array, fire a live `listErrorClasses()` call as a
fallback and render the results. Add a "cache last updated N ago"
chip to the panel header that shows when `lastUpdatedMs` is older
than 15 minutes (3× the expected 5-min cadence). Both features live
in `src/routes/HomePage.tsx` + `src/components/TraceClassList.tsx`.

**Scenario hook:** Re-run `tests/scenarios/payment-failure.spec.ts`.
The last remaining soft-fail should flip to passing. Promote the
"Error classes panel should list a payment entry" assertion from
`expect.soft` to `expect` in the same PR.

**Size:** ~100 lines of pack code, ~20 lines of test change.

### PR #2 — `scenarios/flagd-catalog-validation`
**Scope:** ROADMAP.md 1c. A thin spec that turns on each suspicious
flag (`adFailure`, `productCatalogFailure`, `llmRateLimitError`),
waits 60s, and queries the Cribl dataset for `status.code=2` spans
attributed to the expected service. Updates `FAILURE-SCENARIOS.md`
to mark any flag that produces zero errors with a ⚠️ and a note. If
all three are actually broken upstream, opens follow-up issues
against the otel-demo repo.

**Why now:** Scenarios 6, 7, and 14 can't become regression tests
until we know the flags actually inject. Better to validate once
than to write three scenario specs on top of broken flags.

**Size:** One spec file, ~80 lines.

### PR #3 — `scenarios/kafka-queue-problems`
**Scope:** Scenario 2. Flips `kafkaQueueProblems=on`, polls Home
until `fraud-detection` or `accounting` shows a non-zero p99 delta
chip OR absolute p99 > 5s (whichever reliably fires first), then
soft-asserts:
- Home catalog p99 column on `fraud-detection` / `accounting`
- Home Slowest trace classes panel has an `accounting order-consumed`
  entry with multi-second duration
- Service Detail `/service/fraud-detection` Duration RED chart
  shows a p99 spike while p50 stays low
- System Architecture with messaging lens enabled shows a dashed
  `checkout → fraud-detection` edge
- Investigator asked about `fraud-detection` latency produces a
  Summary mentioning kafka / consumer lag

**Finding seeds (things that will likely soft-fail):**
- The messaging-lens toggle may not be clickable (find out)
- Slowest trace classes panel may also have the cache-staleness bug
  from PR #1 — another reason to land that first

**Size:** ~200 lines of spec, same helper shape as scenario 1.

### PR #4 — `scenarios/payment-unreachable`
**Scope:** Scenario 9. Flips `paymentUnreachable=on`. This is the
strongest pressure test for ROADMAP.md 1b gaps (ghost nodes, red
DOWN chip, root-cause hint). Expected soft failures match each
roadmap item, so the PR also generates clear acceptance criteria
for the follow-up fix PRs.

**Note from roadmap 1a:** The Investigator previously failed on
this scenario by getting anchored on stale cart data. If it still
fails, the fix is in `src/api/agentContext.ts` — add a traffic-drop
preflight paragraph. Re-running this scenario is how you'd verify
that fix works.

### PR #5 — `fix/delta-chip-rate-drop-red`
**Scope:** ROADMAP.md 1b.2. Change `DeltaChip` rate mode from
`relNeutral` to a new `rateDrop` mode that renders red when the
rate dropped ≥50% vs the previous window. Already partly implemented
(the `mode="rateDrop"` variant exists at
`src/components/DeltaChip.tsx:83-90`), but Home catalog's Rate
column still uses `relNeutral` — need to verify and switch.

**Scenario hook:** Scenario 9 soft-fail → hard.

### PR #6 — `fix/system-arch-ghost-nodes`
**Scope:** ROADMAP.md 1b.1. When a service drops below N% of its
baseline span volume, keep its node on the System Architecture graph
with a dashed outline and "no traffic" badge. Click-through still
navigates to Service Detail.

**Scenario hook:** Scenario 9 soft-fail → hard.

**Gotcha:** Need a baseline concept for "what was this service's
typical volume." `criblapm__op_baselines` is op-level, not
service-level. Either derive service-level from op-level or add a
new scheduled search.

### PR #7 — `scenarios/ad-manual-gc`
**Scope:** Scenario 3. Exercises bimodal p99 spikes where p95 stays
flat. The roadmap notes that the Service Detail stats row doesn't
include a p99 tile, so this scenario is expected to soft-fail on
that surface. Use the failure to motivate the fix (ROADMAP.md
§3 mentions this gap).

## Parallel track: upstream cluster fixes

Not blocking the scenario work but worth starting. A small PR
against `criblio/otel-demo-criblcloud` that:

1. Adds `product-catalog.resources.limits.memory=128Mi` override
   to values.yaml
2. Adds `load-generator.env: LOCUST_BROWSER_TRAFFIC_ENABLED=false`
   (or, better, patches the locustfile mount to apply the
   upstream-master fix for the tracer bug)
3. Documents the host sysctl requirement in the repo's README or
   a setup script

Without these, every fresh cluster on a new dev machine will hit
the same three unblocks this session spent an hour on.

## Things I considered but didn't recommend

- **Running scenarios in CI:** Too slow (4–5 min each + 15–30 min
  between runs) and too much upstream cluster instability to be a
  reliable gate. Revisit once we have ≥5 scenarios passing
  reliably — probably a nightly cron triggered via GitHub Actions
  workflow_dispatch or the schedule remote-trigger skill.
- **A shared scenario runner that loops through all flags:**
  Premature. Each scenario has bespoke surfaces to assert on; the
  per-spec shape is the right granularity.
- **A first-run provisioning dialog** (roadmap 2e, cheap wins): it
  would help new dev machines, but the tests bypass the UI
  provisioning flow entirely and mint their Bearer token directly.
  Worth doing for humans but not blocking scenarios.

## Picking this up

On the new machine:

```bash
git clone git@github.com:criblio/apm.git
cd apm
git fetch origin
git checkout docs/scenario-roadmap-plan  # or master if this branch merged
npm install
# Fill in .env from .env.example — you need the Auth0 creds + client credentials
# Verify you can reach FLAGD_UI_URL (clintdev:4000 via Tailscale, or local cluster)
npm run test:e2e                         # smoke test first, should pass in ~5s
npx playwright test tests/scenarios/payment-failure.spec.ts  # baseline scenario
```

If the scenario spec passes except for Error classes panel, start on
**PR #1** (fix/home-error-classes-cache-fallback). If it fails
differently, the cluster state likely regressed — re-check the three
fixes in the "Cluster state" section above.

Prior session logs worth reading in order:

1. `docs/sessions/2026-04-14-next-prs-plan.md` — flagd-api + playwright framework plan
2. `docs/sessions/2026-04-14-playwright-framework.md` — playwright scaffold findings
3. `docs/sessions/2026-04-15-scenario-1-payment-failure.md` — scenario 1 detailed findings + improvement suggestions (the source material for most of PRs #1–#6 above)
4. `docs/sessions/2026-04-15-scenario-test-roadmap-plan.md` — this doc

Everything else is in `ROADMAP.md`, `FAILURE-SCENARIOS.md`, and
`CLAUDE.md`.
