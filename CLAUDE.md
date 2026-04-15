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

**Read `AGENTS.md` before making changes to the app.** It is the
authoritative developer guide for the Cribl App Platform and covers
things that are not obvious from the code:

- Global `window.CRIBL_API_URL` / `window.CRIBL_BASE_PATH` injected by the host
- The automatic `fetch()` proxy (auth injection, pack-scoped URL rewrites,
  external domain routing, 30s timeout)
- `config/proxies.yml` — every external domain the app calls must be
  declared here with path/header allowlists and KV-backed header injection
- Scoped KV store endpoints under `CRIBL_API_URL + '/kvstore/...'`
- Config-group contextual APIs: search endpoints **must** use
  `/m/default_search/search/...`
- React Router: `basename={window.CRIBL_BASE_PATH}`
- Parent/child navigation sync via `pushState`/`popstate`

When building a feature, inspect the relevant Cribl REST APIs first (the
Cribl MCP server is wired up via `.mcp.json` — use it to list datasets,
run searches, etc.) and consult `AGENTS.md` for platform rules before
writing app code.

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
reproduce the scenarios catalogued in `FAILURE-SCENARIOS.md`. The
script currently SSHes into `clintdev` and patches the flagd
ConfigMap in the kind cluster — this is dev-box specific and only
works from Clint's setup. Follow-up work will replace it with an
HTTP API call against the demo cluster's flagd-ui service so other
contributors can run it too.

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
