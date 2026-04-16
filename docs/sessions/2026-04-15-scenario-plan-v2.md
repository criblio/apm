# Scenario plan v2 — reconcile with eval-harness direction (2026-04-15)

Supersedes `docs/sessions/2026-04-15-scenario-test-roadmap-plan.md`
(the handoff doc). Read that first for the PR #1–#7 details and the
cluster-state notes — most of it carries forward. This doc only records
what *changes* after the cicd/eval-harness scoping conversation captured
in `docs/sessions/2026-04-15-cicd-and-eval-harness.md`.

## Why the plan is being restarted

The handoff doc's central mechanic was a "scenario → fix → promote"
ratchet: every new `tests/scenarios/*.spec.ts` ships with soft
assertions on every surface, and each soft-fail becomes a fix PR that
flips the assertion from soft to hard in the same commit. Over time
`tests/scenarios/` grows into a regression harness.

The eval-harness scoping doc reshapes that picture:

- Scenario runs are expected to live in an **off-Actions orchestrator**
  against a **dedicated Lakehouse workspace + dedicated otel-demo
  deployment**, scored for **trend over time** (detection rate on
  scenario X across runs), not binary pass/fail.
- Investigator scoring is **LLM-as-judge**, not deterministic
  assertions — fundamentally non-local.
- Wall clock is hours per run; runs are nightly; results land in a
  persistent store (flat JSON in `apm-evals` sibling repo is the
  cheapest first cut).

If the eval harness owns the "did we regress on scenario X" question,
then growing `tests/scenarios/` into a regression harness is duplicate
work — and worse, the `soft → hard` mechanic assumes every scenario
ships half-broken, which is exactly the shape the eval harness handles
better (as a trend line, not a test failure).

## Two surfaces, two purposes

The split that makes both halves coherent:

| | Local Playwright `tests/scenarios/` | Eval harness (new, off-repo) |
|---|---|---|
| **Purpose** | Dev-time manual validation against staging; catches regressions before a PR merges | Nightly trend tracking; answers "did this PR move detection rate" |
| **Assertions** | Hard from day one — only deterministic surfaces | Rule-based scoring for surfaces + LLM-as-judge for Investigator summaries |
| **Runtime budget** | 4–5 min per scenario, run by hand | Hours per nightly run, unattended |
| **Failure mode** | Blocks the PR it's attached to | Moves a trend line; non-blocking |
| **Where results live** | Playwright console | Persistent store (JSON in sibling repo) |

The `expect.soft` → `expect` promotion ratchet is dropped. New local
scenario specs hard-assert only what is deterministic today; fuzzy /
flaky / trend-y detection work becomes eval-harness input instead.

This also means `tests/scenarios/payment-failure.spec.ts` should shrink
slightly: the `expect.soft` on the Investigator summary should move to
the eval harness once it exists, because LLM-generated summaries aren't
a deterministic pass/fail signal. Everything else in scenario 1 is
deterministic and stays in local tests.

## Design principle: fixes must generalize

The OpenTelemetry demo is the test fixture, not the target. Scenarios
drive the fixes, but **the fixes must not encode anything specific to
the demo's service topology, operation names, or flag names**. APM has
to work against any OTel-instrumented application, and the moment a
fix knows about `payment`, `fraud-detection`, `productcatalog`, or
`opentelemetry-demo` by name, it stops being an APM feature and becomes
a demo integration.

Concretely:

- **No service, operation, or flag names in `src/` or
  `pack/scheduled/`.** Scheduled searches operate on whatever
  services the dataset contains, discovered at query time. Pack code
  renders whatever comes back.
- **No hardcoded thresholds tied to one service's known behavior.**
  Detection heuristics are ratios, deltas, and percentiles against
  a learned baseline — "p99 > 3× baseline", "rate dropped ≥50% vs
  previous window" — not absolutes like "fraud-detection p99 > 5s".
- **Baselines are derived from the data.** If a fix needs
  service-level typical volume and `criblapm__op_baselines` is only
  op-level, the answer is a new scheduled search that rolls
  op-level baselines up to service-level — not a hardcoded map.
- **Service names may appear in tests and scenarios.** That's what
  a fixture is for. `tests/scenarios/payment-failure.spec.ts` naming
  `checkout` and `payment` is correct; `src/components/DeltaChip.tsx`
  naming them would not be.
- **Eval-harness scoring rules are parameterized.** v1 scoring says
  "did service X flip red within N minutes of its injection" where X
  is a scenario input, not a literal. Baking `fraud-detection` into a
  rule would make the rule useless against any other environment.

Every fix PR below carries a **Generality** line explicitly naming
what the fix operates on in abstract terms. If that line is about a
specific service, the fix is the wrong shape and needs to be rewritten
before it merges.

## Revised PR sequence

Only the first two PRs are locked in. Everything after PR #2 is gated
on the eval-harness design doc (see "New parallel track" below) because
it changes whether those scenarios are local specs, harness inputs, or
both.

### PR #1 — `fix/home-error-classes-cache-fallback` *(unchanged, safe either way)*

Pure pack fix. Scope, file set, and scenario hook are identical to the
handoff doc: add a live-query fallback when
`panelCache.buildCachedPanels` returns `errorClasses === null` or
empty, plus a "cache stale" chip on the panel header. Re-run
`tests/scenarios/payment-failure.spec.ts`; the Error classes assertion
flips from `expect.soft` to `expect` in the same PR.

This is the only PR from the old plan that is untouched by the
reshape, because the bug is real, the fix is deterministic, and the
surface is deterministic. Good candidate to start with regardless of
what the eval harness ends up owning.

**Generality:** The fix operates on whatever `listErrorClasses()`
returns for the current workspace — it has no concept of payment,
checkout, or any specific service. The cache-stale heuristic (15 min
threshold = 3× the 5-min scheduled cadence) is a property of the
scheduled search's own cadence, not of the demo.

**Size:** ~100 lines of pack code, ~20 lines of test change.

### PR #2 — `scenarios/flagd-catalog-validation` *(unchanged in scope, repurposed)*

Still worth doing, still cheap, still unblocks everything downstream —
flips `adFailure`, `productCatalogFailure`, `llmRateLimitError` and
confirms each one actually injects `status.code=2` spans on the
expected service. Updates `FAILURE-SCENARIOS.md` with ⚠️ notes and
opens upstream issues for any broken flag.

What changes: the output of this PR now directly feeds the eval-harness
design. If a flag is broken, the harness shouldn't run that scenario
nightly; if it's working, the harness should include it in v1.

**Generality:** This PR is a test/validation artifact, not a fix —
it's allowed to name demo flags and services because that's what it
exists to validate. Nothing in this PR touches `src/` or
`pack/scheduled/`.

**Size:** ~80 lines (one spec).

### PRs #3–#7 — *deferred, pending eval-harness design*

The handoff doc's PR #3 (`scenarios/kafka-queue-problems`), #4
(`scenarios/payment-unreachable`), #5 (`fix/delta-chip-rate-drop-red`),
#6 (`fix/system-arch-ghost-nodes`), #7 (`scenarios/ad-manual-gc`) all
stay on the roadmap, but **how** they get tested changes depending on
the harness design.

- The two fix PRs (#5 delta-chip, #6 system-arch ghost nodes) still
  happen as described — they're pack fixes motivated by roadmap
  items, and they land independent of scenario spec shape.
- The three scenario-spec PRs (#3 kafka, #4 payment-unreachable, #7
  ad-manual-gc) wait until we know which surfaces live in local tests
  vs. the harness. Writing them now risks having to rewrite them when
  the harness picks up half of each assertion.

When the design doc lands and v1 of the harness is sketched, revisit
this list and decide, per scenario, which surfaces are local and which
are harness.

**Generality notes for the carried-over fix PRs:**

- **`fix/delta-chip-rate-drop-red`:** Operates on `DeltaChip`'s
  percentage-change input, not on any service name. The `rateDrop`
  mode compares current-window rate to previous-window rate for
  *whatever row the chip is rendering*. The ≥50% threshold is a
  chip-level heuristic, the same for every row. Home catalog rate
  column wiring changes from `relNeutral` to `rateDrop` uniformly,
  not per service.
- **`fix/system-arch-ghost-nodes`:** The "below N% of baseline" check
  is applied per node against that node's own baseline — there is no
  list of "important services" to keep alive. Baseline derivation
  must itself be generic: if the current `criblapm__op_baselines`
  scheduled search is op-level, the fix either rolls those up to
  service-level via a GROUP BY in a new scheduled search or computes
  service-level on-the-fly in the frontend. Either way, the baseline
  query must not enumerate services by name — it aggregates over
  whatever services the dataset contains.

If either fix starts growing a `demoServices.ts` constants file or
a `if (service === 'payment')` branch, the approach is wrong and the
PR needs to be rethought before it merges.

## New parallel track: eval-harness design doc

This is now the highest-leverage non-PR-#1 work. Before writing any
orchestrator code or any more scenario specs, draft
`docs/research/eval-harness/design.md` that locks down:

1. **Orchestrator host** — clintdev (free, tied to one dev box) vs. a
   dedicated VPS / Fly machine (durable, shareable, ~zero cost).
   Recommend the dedicated host to avoid coupling eval runs to the
   kind cluster used for interactive dev.
2. **Dedicated Lakehouse workspace + otel-demo deployment** — who
   provisions, who owns credentials, how the orchestrator authenticates.
   Confirm Lakehouse (not Lake) per the cicd-and-eval-harness
   conversation.
3. **Scenario list for v1** — probably just 3–5 scenarios with
   known-working flags (scenarios 1, 2, 9 are the strongest
   candidates from the handoff doc's analysis). Hold everything else
   until v1 is green.
4. **Result storage + trending UI** — flat JSON in a sibling
   `apm-evals` repo to start, reviewable from mobile via the rendered
   markdown / GH UI. No DB, no dashboard until trends actually need
   one.
5. **Trigger + result reporting** — GitHub Actions cron fires
   `repository_dispatch` at the orchestrator; orchestrator posts back
   via Checks API (ideal) or `gh pr comment` (lower friction first
   cut). Decision criterion: whether a GitHub App / PAT with Checks
   scope is worth setting up for v1.
6. **Playwright fixture shape inside the orchestrator** — can it
   reuse `tests/helpers/apmSession.ts` as-is, or does the orchestrator
   need its own auth/storage setup because it runs against a
   different (dedicated) Cribl workspace with different credentials?
7. **Investigator cost budget + rate limiting** — not a blocker for
   v1 per the cicd doc, but needs a number before nightly runs start.
8. **flagd HTTP switch integration** — verify
   `otel-demo-criblcloud` exposes flagd-ui HTTP in the dedicated
   deployment the same way the dev cluster does, or move the
   flag-flipping logic into the orchestrator and retire
   `scripts/flagd-set.sh` (it's a shell script that already talks to
   the HTTP API in master — orchestrator can call the same API
   directly).
9. **Scoring rule schema** — lock in a scenario-description shape
   where each scenario declares `{ flag, variant, expectedService,
   expectedOp, expectedSurfaceChecks[] }` and the scoring engine
   applies generic checks (`deltaChipFlippedRed(expectedService,
   withinMinutes)`, `slowestTraceClassesIncludes(expectedOp)`)
   against that declaration. **No service names in the scoring
   engine itself** — it's a runner that takes a scenario object and
   evaluates it. Adding a new scenario means writing a new
   declaration, not editing the engine.

The design doc is the deliverable. Orchestrator code comes after
review.

## Unchanged: upstream cluster fixes

Still worth a small PR against `criblio/otel-demo-criblcloud`:

1. `product-catalog.resources.limits.memory=128Mi` override
2. `load-generator.env: LOCUST_BROWSER_TRAFFIC_ENABLED=false` (or
   patch the locustfile mount to apply the upstream-master tracer fix)
3. Document the host sysctl requirement
   (`fs.inotify.max_user_instances=8192`,
   `fs.inotify.max_user_watches=524288`) in the repo README or a
   setup script

These are the three in-place fixes clintdev is currently running with
that aren't persisted anywhere. Unblocks both the dev cluster *and*
whatever host ends up running the dedicated eval-harness cluster.

## Picking this up

On this machine, in this branch, the next concrete step is one of:

1. **Start PR #1** — `fix/home-error-classes-cache-fallback`. Deterministic,
   safe either way, unblocks scenario 1 hard-assertion, trivially
   reviewable on mobile. Probably the right first move.
2. **Draft the eval-harness design doc** — write `docs/research/eval-harness/design.md`,
   resolve the open questions above with the user, ship as a PR.
   Higher leverage for downstream work but no code change yet.
3. **Both in parallel** — PR #1 is small enough that design-doc
   drafting and PR #1 implementation can interleave cleanly. Open PR
   #1 first so it can start baking while the design doc gets reviewed.

Don't start PRs #3–#7 (more scenario specs) until the design doc has
answered whether they're local or harness-owned. Writing them now
risks throwing away work.

## Things NOT changing from the handoff doc

Reading the original handoff doc is still worth it for:

- **Cluster state** section (the three in-place fixes and how to
  reach `FLAGD_UI_URL` from a new machine)
- **`.env` prerequisites** (unchanged)
- **Test-infrastructure layout** (`tests/helpers/`, `tests/scenarios/`,
  `playwright.config.ts` shape — unchanged)
- **Scenario 1 findings** (unchanged — the Home Error classes
  cache-miss bug is still the one unresolved soft-fail and PR #1 is
  still its fix)
- **Timing discipline** for scenario runs (4–5 min each, 15–30 min
  between runs) — applies whether you're running locally or writing
  the eval harness
