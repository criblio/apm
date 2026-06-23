# apm

**Cribl APM** — a Cribl Search App (Vite + React + TypeScript) that runs
inside Cribl Search as a sandboxed iframe and provides an APM experience
on top of traces, logs, and metrics landing in a Cribl dataset. Ship
target: Cribl Cloud. Local dev via `npm run dev`; package for upload with
`npm run package`; deploy to staging with `npm run deploy`.

This repo is app-only. The kind-cluster / OpenTelemetry Demo plumbing
that feeds it test telemetry lives separately in
`criblio/otel-demo-criblcloud`.

## Developing

**Read these before making changes:**

1. **`AGENTS.md`** — Cribl App Platform developer guide (host
   globals, fetch proxy, proxies.yml, KV store, React Router).
   This is the official platform API reference.
2. **`docs/cribl-app-skill/skill.md`** — lessons learned from
   building this app: KQL caveats (crashes, unsupported functions),
   sandboxed iframe constraints (no downloads, no popups, CSP),
   scheduled search patterns (provisioning, caching, lookups,
   alert state machine), and UI patterns (non-destructive refresh,
   graph stability). Consult this before writing KQL queries or
   working around platform limitations.

When building a feature, check `AGENTS.md` for the API surface and
`docs/cribl-app-skill/skill.md` for known pitfalls. Use the Cribl
MCP server (`.mcp.json`) to inspect live APIs and run test queries.

## How we work

These conventions apply whenever you work on this repo. They're here
(rather than in a Claude user memory) so they follow the code across
machines and are visible to every contributor.

### ROADMAP.md is the canonical priority list

`/ROADMAP.md` at the repo root is the single source of truth for
priorities, competitive gap analysis, and the Cribl-Search-leverage
principle (build a domain UI on top of Cribl Search primitives —
saved searches, alerts, KQL, federation — rather than reinventing
them). Read it at the start of a session when the user asks "what's
next" or references prior priorities. Update it in-place when
priorities shift; don't fork the list into a side doc or memory.

Companion docs: `FAILURE-SCENARIOS.md` for the flagd flag catalog
and test plan, `AGENTS.md` for the Cribl App Platform developer guide.

### Remote/mobile collaboration

Clint often reviews work from mobile, so ship everything in a form
he can inspect from GitHub on a phone — no desktop console needed.

1. **The deployed staging app is the primary validation surface**,
   not screenshots in `/tmp/`. When you ship a user-visible change,
   it lives at the staging URL (see `scripts/` and `.env` for the
   host) and he can open it from any mobile browser. Tell him what
   to look for and where, not what you saw.
2. **Chunk work into small PRs.** One PR per coherent story (one
   feature, one doc set, ~1–5 commits). Stacked PRs are fine — PR
   #2 targets PR #1's branch so the diff view only shows the new
   chunk. Avoid mega-PRs; they don't review well on mobile.
3. **Session artifacts go in the repo**, under
   `docs/sessions/YYYY-MM-DD-<slug>.md` plus
   `docs/sessions/screenshots/YYYY-MM-DD-<slug>/` for images. Keep
   the screenshot set lean (milestone shots, empty/error states,
   anything visually non-obvious — not every debug frame). Deeper
   research artifacts go under `docs/research/`.
4. **Reference images from PR bodies via GitHub raw URLs** (e.g.
   `https://raw.githubusercontent.com/criblio/apm/<branch>/docs/sessions/screenshots/.../file.png`).
   GitHub renders them inline in PR markdown on mobile.
5. **Every PR body includes:** a one-sentence summary, commit list
   (if multi-commit), a "Test plan" / "Validate on staging" section
   with concrete click-through steps, a link to the session log,
   and any known limitations.
6. **Push all branches before wrapping a session.** Stacked PR
   branches need to be on origin for mobile review.

### Browser automation

When a task needs a real browser (capturing screenshots for a PR,
driving the staging app through a flow, verifying a UI change), use
the in-repo helper — **not** `@playwright/mcp` or
`chrome-devtools-mcp`. MCP browser servers load their tool schemas
into every conversation turn and burn context tokens; ad-hoc
Playwright scripts cost nothing until they run.

- `scripts/browser.js` — imports `playwright-core` (a dev dep of
  this project) and connects to a running Chromium over CDP via
  `chromium.connectOverCDP(...)`. `close()` only disconnects the
  CDP client; it never kills the user's browser.
- `scripts/browser-smoke.js` — run `npm run browser:smoke` to
  confirm the CDP pipeline is healthy before debugging a more
  complex driver.
- `scripts/chromium-vnc.sh start|stop|restart|status` — relaunch
  the local Chromium with the CDP port exposed when it's not
  listening. Handles the VNC/gnome-shell/Flatpak env-borrowing
  that's machine-specific to Clint's dev box. On a different
  machine you likely just need Chromium launched with
  `--remote-debugging-port=9222 --remote-debugging-address=127.0.0.1`
  (or `CDP_ENDPOINT=http://host:port` set in the env).

Pattern: write a short Node ESM script that imports
`./scripts/browser.js`, does its work, and calls `close()`. Run it
via the Bash tool. Keep these scripts out of version control unless
they become reusable — the repo already has enough one-offs.

### Validating UI changes via Playwright

**Every new UI feature must be validated via Playwright against
staging before reporting it as done.** Use the e2e test helpers
(`tests/helpers/apmSession.ts`) for auth + host-global injection.
Write a short ad-hoc script that:

1. Navigates to the relevant page
2. Asserts key elements are visible (text, buttons, tables)
3. Captures a screenshot as evidence
4. Tests basic interactions (click, verify result)

Use `playwright-core` with `chromium.launch({ headless: true })`
(not the CDP helper — Chromium may not be running). Auth via
`installCriblHostGlobals(page)` + `gotoApm(page, '/path')`.
See `tests/helpers/apmSession.ts` for the pattern.

### Deploying to staging

`npm run deploy` builds, packages, uploads the pack, and
**automatically reconciles scheduled searches** via
`scripts/provision.ts`. The provisioner diffs the plan in
`provisionedSearches.ts` against what's on the server and
creates/updates/noops as needed. Output shows each action:

```
▶ Reconciling scheduled searches …
✓  + create criblapm__metric_catalog
✓  ~ update criblapm__home_slow_traces
✓  · noop   criblapm__home_service_summary
```

You can also run provisioning standalone:
```bash
npm run provision          # reconcile
npm run provision -- --dry # dry-run (show plan without applying)
```

### Framework SHA pin

The shared framework (`cribl-search-app-framework`) is consumed
via a local `file:..` reference in `package.json`. CI clones it
at the SHA recorded in `.framework-sha`. PR #66 shipped a latent
break through green CI because we cloned master with no SHA
record; the pin makes framework bumps deliberate.

**To bump the framework:**

1. Check out the framework repo locally and pull the SHA you
   want to ship.
2. In this repo, replace the contents of `.framework-sha` with
   that 40-char SHA (one line, trailing newline OK).
3. Run `npm run lint && npm test && npx tsc --noEmit` to confirm
   the new framework still builds against APM master.
4. Open a small PR titled `chore: bump framework SHA to <short>`
   with the framework PRs included in the bump listed in the body.

Local devs are expected to keep their framework checkout at the
recorded SHA. If your local is divergent, expect to see lint or
type errors CI won't reproduce.

### Cutting a release

Releases are triggered by pushing a `vX.Y.Z` tag — the `.github/
workflows/release.yml` workflow runs `npm ci`, `npm run lint`,
`npm run package`, then creates a GitHub Release with the
`apm-X.Y.Z.tgz` pack attached. **A lint failure on the tagged
commit means no GitHub Release gets published**, and recovering
requires either force-retagging or bumping to a patch release.
Catch the failure locally before tagging.

**Required pre-tag checks** — run these on the commit you're about
to tag, in this order, in a clean working tree:

```bash
npm run lint          # must pass (0 errors) — what the workflow gates on
npm test              # unit tests
npx tsc --noEmit      # type-check
npm run package       # full build + tgz produced
```

If any step fails, do not tag. Fix on master first.

**Tagging steps**:

1. Confirm CI is green on the commit you intend to tag — open
   `gh run list --branch master --limit 3` and verify the most
   recent `CI` run on that commit is `success`. If CI hasn't run
   yet (you pushed seconds ago), wait for it.
2. Bump `package.json` `version` to the target `X.Y.Z`.
3. Commit as `chore: release X.Y.Z` with a body that lists the
   PRs / threads landing in the release. House style: one bullet
   per coherent feature thread, mention the retro/regular PR
   number, one-sentence summary.
4. Annotated tag the commit: `git tag -a vX.Y.Z -m "vX.Y.Z"`.
5. `git push origin master vX.Y.Z`.
6. Confirm the release workflow succeeded:
   `gh run list --workflow=Release --limit 1` and `gh release
   view vX.Y.Z`.

**Pack version vs tag version**: the workflow's first step
verifies `vX.Y.Z` tag matches `package.json` version. They must
match exactly. The pack filename `apm-X.Y.Z.tgz` is derived from
`package.json` so this is usually automatic, but if the version
was bumped in a separate commit from the tag, double-check before
pushing.

**If a release workflow fails after tag push**:
- Smallest possible fix: commit the fix on master, force-update
  the tag (`git tag -fa vX.Y.Z && git push origin vX.Y.Z --force`),
  re-run the workflow. Only safe within minutes of the original
  tag push — once the broken tag is consumed by downstream tooling
  or other developers fetched it, force-retag is destructive.
- Safer fallback: leave the broken tag as-is, fix on master, and
  cut a patch release (`X.Y.(Z+1)`).
- Either way, the lesson is to catch the failure pre-tag, not
  post-tag. Run the four checks above.

### Running scenario tests

Run scenario specs **one at a time, sequentially** — never in
parallel. The staging Cribl Search instance has a small worker
pool; two specs firing queries concurrently saturate it and cause
timeouts that look like test failures but are really resource
exhaustion.

```bash
# Good — sequential
npx playwright test tests/scenarios/payment-failure.spec.ts
# wait for it to finish, then:
npx playwright test tests/scenarios/flagd-catalog-validation.spec.ts

# Bad — parallel (will overload staging)
npx playwright test tests/scenarios/  # runs both at once if workers > 1
```

`playwright.config.ts` sets `workers: 1` which serializes specs
within a single `npx playwright test` invocation, but launching
two separate `npx playwright test` commands concurrently bypasses
that — don't do it.

Between scenario runs, allow **15–30 minutes** for the previous
run's error signal to decay out of the lookback window. Running
back-to-back is fine for development iteration but produces noisy
baselines for detection-quality measurements.

### Eval harness (Autoresearch loop)

`npm run eval` runs the detection eval harness — 13 scenarios from
`FAILURE-SCENARIOS.md` driven against the deployed pack with
surface checks + Investigator scoring. See
`docs/research/eval-harness/design.md` for the full design.

```bash
npm run eval                              # full 13-scenario matrix (~2.5h)
npm run eval -- --scenario paymentFailure # single scenario (~8min)
npm run eval -- --no-investigator         # surface-only (~45min)
```

Scenarios are declarations in `eval/scenarios/*.ts`. Adding a
scenario means writing ~40 lines of TypeScript with the flag,
expected service, surface locators, and Investigator prompt.

### Metrics schema (wide-column format)

As of 2026-04-15, Cribl Search stores metrics in **wide-column
format**: each metric is a top-level field (e.g.,
`postgresql.backends: 2`) instead of the old `_metric`/`_value`
pair. `_metric_type` still exists. All metric queries use
bracket-quoted field references: `toreal(['metric.name'])`.

Metric discovery uses a regex on `_raw` to extract the numeric
field name, pre-computed by the `criblapm__metric_catalog`
scheduled search. Histogram metrics with cumulative temporality
(e.g., .NET SDK's `http.server.request.duration`) store running
sums — `percentile()` over these gives nonsense. Use `rate`
aggregation for cumulative histograms. This is a known limitation
tracked for the next session.

### Cribl KQL caveats

- **`(?i)` inline regex flag crashes** in complex pipelines
  (summarize + extend + nested negation). Use character-class
  alternation `[Cc]onsume[d]?` instead.
- **`(?i)` upstream of `| export to lookup` silently corrupts the
  write**: export stats report the right `totalEventsOut` and
  `lookupFile`, but the resulting CSV is not joinable — every
  `lookup <name> on <key>` returns no matches, with no error
  anywhere. Same family as the mv-expand/export incompatibility
  (see attrCatalogComputeQuery). Use character-class alternation
  in any query that exports to a lookup (found 2026-06-09 via
  criblapm_trace_originators).
- **`foldkeys`** operator exists but the output `key`/`value`
  columns don't support type filtering. Use `_raw` regex parsing
  for field-name discovery instead.
- **Route conflicts**: avoid using `/settings` in pack routes —
  the Cribl host shell intercepts paths containing "settings".

### End-to-end tests (Playwright)

The `tests/` tree runs against the deployed APM pack on Cribl Cloud
using `@playwright/test` with a headless chromium. This is separate
from the ad-hoc CDP scripts above — tests are reproducible on a
fresh machine, CDP scripts attach to the user's live browser.

- `playwright.config.ts` reads `CRIBL_BASE_URL` from `.env` and
  declares two projects: a `setup` project that runs
  `tests/auth.setup.ts`, and a `chromium` project that runs specs
  with the cached `storageState`.
- `tests/auth.setup.ts` — logs in once via the Auth0 Universal
  Login using `CRIBL_TEST_EMAIL` / `CRIBL_TEST_PASSWORD`, saves
  browser state to `playwright/.auth/cribl-cloud.json` (gitignored).
  If Cribl changes the login form, update the selectors here.
- `tests/apm-smoke.spec.ts` — asserts the APM app shell renders
  inside the workspace at `CRIBL_APM_APP_PATH` (defaults to
  `/app-ui/apm/`).
- Run all tests: `npm run test:e2e`. Debug with
  `npm run test:e2e:ui` or `npm run test:e2e:headed`.
- Add new tests as `tests/*.spec.ts`. They automatically inherit
  the authenticated storage state.

See `.env.example` for the full list of vars tests depend on.

### Triggering failure scenarios

The test telemetry comes from the upstream OpenTelemetry Demo's
`flagd` feature-flag service. `scripts/flagd-set.sh` flips flags to
reproduce the scenarios catalogued in `FAILURE-SCENARIOS.md`.

The script talks to flagd-ui's HTTP API directly — no SSH, no
kubectl, no pod restarts. Set `FLAGD_UI_URL` (in `.env` or the
shell) to a reachable flagd-ui endpoint and you're done. The
demo cluster ships flagd as a `ClusterIP` service so you'll
typically want a port-forward:

```bash
kubectl -n otel-demo port-forward --address 0.0.0.0 svc/flagd 4000:4000 &
export FLAGD_UI_URL=http://localhost:4000
scripts/flagd-set.sh --list
```

`FAILURE-SCENARIOS.md` has the full prerequisites and per-flag
recipes. The script supports `--list`, `--status`, `--all-off`,
and `<flagName> <variant>` (e.g. `paymentFailure 50%`).

### PR conventions

- One purpose per PR. Docs + the minimal code change that
  motivates them is fine; a docs PR that also refactors an
  unrelated module is not.
- Commit messages explain the *why*, not just the *what*. See
  `git log --oneline` for the house style. Area prefixes are
  optional now that the repo is app-only (use them when a PR is
  purely `docs:` or `scripts:`).
- Include a `Co-Authored-By:` trailer when Claude collaborated on
  the commit.
- When a PR body references a session log or screenshot set, link
  by raw.githubusercontent URL so mobile readers see it inline.
