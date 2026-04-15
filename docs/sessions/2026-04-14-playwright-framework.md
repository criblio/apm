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

## Validation

- `npm run lint` — clean
- `npm run build` — 506 kB bundle, clean
- `npm run deploy` — uploads + installs the pack on the configured
  staging workspace. This required a bugfix in `scripts/deploy.mjs`
  (leftover from the flatten PR) where `REPO_ROOT` was still resolving
  to the parent dir of `APP_ROOT`. The app IS the repo now.
- `npm run test:e2e` — both `setup` and `apm-smoke` pass against the
  deployed pack in ~5s total. Verified with `playwright/.auth` cleared
  between runs, so the setup logs in from scratch each time.

## Lessons learned while wiring this up

Things that looked simple but weren't:

1. **`page.goto('/', { waitUntil: 'load' })` fails on the Auth0
   redirect chain** — the original document's `load` event never fires
   because the browser throws it away mid-navigation. Use
   `waitUntil: 'commit'` and wait for `domcontentloaded` separately.
2. **Cribl's Auth0 login is two-step** — email field + "Next" button,
   then password field + "Continue". The outer wrapper also renders
   three social-login buttons ("Continue with <org>", "Continue with
   Cribl Corp Okta", "Continue with Google") whose accessible names
   match `/continue/`. Scope the primary submit lookup with
   `{ name: 'Next', exact: true }` (first step) and
   `{ name: /^(continue|log in|sign in)$/i }` (second step).
3. **Direct navigation to `/app-ui/apm/` doesn't inject host globals**
   — `window.CRIBL_BASE_PATH` / `window.CRIBL_API_URL` are only set
   when the outer Cribl shell wraps the pack. Without them React
   Router's basename defaults to `/` and no route matches
   `/app-ui/apm/`, so the pack renders an empty `#root` with the
   warning "No routes matched location /app-ui/apm/". Fix: use
   `page.addInitScript` in the smoke test to polyfill those globals
   before `goto`. This mirrors what the Cribl host would have done
   if we click-drove through the Apps menu.
4. **`scripts/deploy.mjs` was still assuming a parent monorepo dir**
   after the flatten PR — it was reading `.env` from
   `/home/clint/local/src/.env` instead of
   `/home/clint/local/src/apm/.env`. Fix: `REPO_ROOT = APP_ROOT`.

## Known edges

- **Auth0 selectors** — if Cribl restyles the login page or adds
  localization, update the email/password/button matchers in
  `tests/auth.setup.ts`
- **App path** — default is `/app-ui/apm/`. Set `CRIBL_APM_APP_PATH`
  in `.env` to override
- **Host-global polyfill** — the smoke test pretends the Cribl host is
  serving the pack (`CRIBL_API_URL=/m/default_search`). That's fine
  for assertions against the shell + local React components, but any
  future spec that exercises pack KV reads or search calls needs to
  either accept a couple of background `401`s or load the pack via
  its authenticated wrapper URL instead
