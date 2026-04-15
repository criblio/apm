# Session: Playwright e2e framework (2026-04-14)

Follow-up to `docs/sessions/2026-04-14-next-prs-plan.md`. Implements the
"PR #3 — `test/playwright-framework`" scope from that doc.

## What shipped

Infra-only: Playwright scaffolding + one smoke test. No existing
`scripts/*-smoke.js` / `*-spike.js` migrated yet — those stay on the CDP
workflow until we migrate them in follow-ups.

- `@playwright/test` devDep + chromium browser downloaded via
  `npx playwright install chromium --with-deps`
- `playwright.config.ts` — reads `.env` (same dotenv parser as
  `scripts/deploy.mjs`), declares a `setup` project that runs
  `tests/auth.setup.ts` and a `chromium` project that depends on it and
  loads `playwright/.auth/cribl-cloud.json` as `storageState`
- `tests/auth.setup.ts` — navigates to the workspace, handles the Auth0
  Universal Login (one-page or two-step variants), saves storage state
  to `playwright/.auth/cribl-cloud.json` (gitignored)
- `tests/apm-smoke.spec.ts` — loads `CRIBL_APM_APP_PATH` (default
  `/app-ui/apm/`) and asserts the NavBar brand + three tabs render.
  Falls back to frames if the pack is wrapped in an iframe
- `.env.example` — new file documenting every var the repo expects
- `.gitignore` — `!.env.example` negation, Playwright artifact dirs
- `package.json` — `test:e2e`, `test:e2e:ui`, `test:e2e:headed`
- `CLAUDE.md` — new "End-to-end tests (Playwright)" subsection under
  "How we work"

## What was NOT done

- CI wiring — deferred per the PR #3 scope
- Migration of `scripts/browser-smoke.js` / `investigate-smoke.js` /
  `investigator-spike.js` — deferred, CDP scripts still useful for
  interactive dev
- Firefox / WebKit browsers — chromium-only per scope
- `scripts/flagd-api` rewrite (the other queued PR) — separate branch

## Validation done locally

- `npm run lint` — clean
- `npm run build` — 506 kB bundle, clean
- `npx playwright test --list` (with dummy `CRIBL_BASE_URL`) —
  discovers both `auth.setup.ts` and `apm-smoke.spec.ts` under the right
  projects
- `npm run test:e2e` not run end-to-end — `CRIBL_TEST_EMAIL` /
  `CRIBL_TEST_PASSWORD` aren't in `.env` yet. The test suite will need
  creds before it can actually log in. User should add those to `.env`
  and run `npm run test:e2e` to validate

## Known edges that may bite

- **Auth0 selectors** — `tests/auth.setup.ts` uses `getByLabel(/email/i)`
  / `getByLabel(/password/i)` / role-based button matchers. If Cribl
  customizes the Auth0 form fields (non-label-based inputs, non-English
  strings), update the selectors there
- **App path** — default is `/app-ui/apm/`, which matches the Cribl App
  Platform convention documented in `AGENTS.md`. If the pack lives
  somewhere else on staging, set `CRIBL_APM_APP_PATH` in `.env`
- **iframe wrapping** — the smoke test looks for text on the page first,
  falls back to the first frame whose URL matches `/apm/`. If the pack
  renders in an iframe with a different URL pattern, the frame-detection
  fallback will need a tweak
