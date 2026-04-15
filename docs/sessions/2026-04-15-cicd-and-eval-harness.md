# 2026-04-15 — CI/CD workflows + eval harness design scoping

## What shipped

- **PR #2** (merged) — `.github/workflows/ci.yml` + `.github/workflows/release.yml`.
  - CI runs `npm ci && npm run lint && npm run build` on PRs and `master` pushes.
  - Release fires on `v*` tags, verifies the tag matches `package.json` version
    (fails loudly if not), packages the app, and uploads `apm-<version>.tgz`
    to a GitHub Release with auto-generated notes via
    `softprops/action-gh-release@v2`. Uses the default `GITHUB_TOKEN`.
  - First release: `git tag v1.0.0 && git push origin v1.0.0`.
- **PR #3** — README rewrite: accurate APM pitch + full feature list,
  new **Prerequisites — telemetry source** section naming
  `criblio/otel-demo-criblcloud` as the upstream pipeline, new **Install**
  section covering both the tagged-release tgz path and `npm run deploy`.

## Follow-up: live-backend eval harness

Scoping conversation only — nothing implemented. Capturing the shape so we
can pick this up cleanly next session.

### Goal

A nightly eval suite that flips flagd scenarios from `FAILURE-SCENARIOS.md`
against a live Cribl environment, drives the real deployed apm UI in a
headless browser, and scores detection efficacy (did the anomaly surface?
did the Investigator name the right root cause?). Runtime is measured in
hours per run because each scenario needs time for the flag flip to
propagate and for baselines / anomaly windows to accumulate.

The value is **trend over time**, not per-run pass/fail: "did this PR
move detection rate on scenario X" matters more than "suite is green."

### Architectural direction (tentative)

- **Orchestrator runs off-Actions**, on a long-lived box (clintdev or a
  tiny dedicated VPS). Reason: most of the wall clock is idle waits, and
  a GitHub-hosted runner (a) caps at 6h per job and (b) charges for idle
  minutes. GitHub Actions stays in the loop as **trigger + result sink**:
  nightly cron fires `repository_dispatch` at the orchestrator; the
  orchestrator posts results back via the Checks API against the commit
  SHA and appends to a persistent store (S3 / a results repo) for
  trending.
- **Dedicated Lakehouse workspace + dedicated `otel-demo-criblcloud`
  deployment** (decided this session). Shared infra is a non-starter
  because flipping flagd corrupts everyone else's view of the dataset
  for the run duration. Cribl **Lakehouse** specifically, not Lake —
  performance is expected to matter for the multi-scenario run.
- **Browser driver**: headless Playwright with persisted `storageState`
  so we don't re-OAuth per scenario. Reuses the in-repo `scripts/browser.js`
  pattern (CDP over `chromium.connectOverCDP`), or a parallel Playwright
  launcher if CDP reuse turns out to be awkward for a scheduled run.
- **Scoring**:
  - Rule-based for the anomaly surfaces — "did service X flip red within
    N minutes of the flag flip," "did the slow-traces list include
    operation Y," etc.
  - LLM-as-judge for Investigator conclusions — compare the final
    assistant summary against an expected root cause string for the
    scenario.

### Open questions to resolve before building

1. **Where does the orchestrator live?** clintdev is available today but
   is tied to one dev box; a small dedicated VPS (or a Fly machine,
   etc.) is more durable and shareable. Cost is negligible either way.
2. **Results storage format.** Flat JSON in a sibling `apm-evals` repo
   is the cheapest thing that trends over time and is mobile-reviewable;
   a real DB / dashboard can come later.
3. **Scenario selection per run.** Full matrix every night, or rotate a
   subset to keep wall-clock bounded? `FAILURE-SCENARIOS.md` is the
   source list.
4. **Flagd HTTP switch integration.** User reports the HTTP-API version
   of the flag flipper is already landed in `master` — verify this
   means `otel-demo-criblcloud` exposes a flagd-ui HTTP endpoint the
   orchestrator can call directly, and update `scripts/flagd-set.sh`
   in *this* repo (still SSHes into clintdev as of today) to match, or
   move the flipping logic into the orchestrator entirely and retire
   the in-repo script.
5. **Investigator cost budget.** Not a blocker today per user; revisit
   before turning the suite on nightly so we're not surprised by the
   Cribl AI token bill.
6. **Checks API vs. PR comment for result reporting.** Checks API is
   the cleaner UX (shows up as a named check on the commit and can be
   made non-blocking via branch protection) but requires a GitHub App
   or PAT with the right scopes. A PR comment from `gh pr comment` is
   lower-friction for a first cut.

### Next concrete step

Draft a design doc under `docs/research/eval-harness/` that locks the
orchestrator location, the scenario list for v1, and the exact
Playwright fixture shape. Do that before writing any code.
