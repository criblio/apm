# create-cribl-app

Starter template for new Cribl Search App packs. Fork/copy this
directory to bootstrap a new app with the full development
infrastructure already wired up.

## What's included

```
create-cribl-app/
  CLAUDE.md              — Claude Code project instructions
  AGENTS.md              — Cribl App Platform developer guide
  .env.example           — Required environment variables
  package.json           — Vite + React + TypeScript + Playwright
  tsconfig.json
  vite.config.ts
  vitest.config.ts
  playwright.config.ts
  config/
    proxies.yml          — External domain declarations
  src/
    App.tsx              — BrowserRouter with basename
    global.d.ts          — Window global type declarations
    components/
      AppShell.tsx       — NavBar + Outlet
      NavBar.tsx         — With dropdown support
      DatasetProvider.tsx — Settings loader
      TimeRangePicker.tsx
      StatusBanner.tsx
    api/
      kvstore.ts         — Pack-scoped KV store client
      cribl.ts           — KQL query runner
      appSettings.ts     — Settings load/save with merge
    hooks/
      useRangeParam.ts   — Time range from URL
      useDataset.ts      — Dataset pub/sub hook
    routes/
      HomePage.tsx       — Starter home page
      SettingsPage.tsx   — Dataset + provisioning
  scripts/
    deploy.mjs           — Build + upload + provision
    provision.ts         — CLI provisioner
    package.mjs          — Pack bundler
  tests/
    helpers/
      apmSession.ts      — Playwright auth + host globals
      criblSearch.ts     — KQL runner for assertions
    auth.setup.ts        — Auth0 login flow
```

## Getting started

1. Copy this directory to your new project
2. Update `package.json` name, version, description
3. Copy `.env.example` to `.env` and fill in credentials
4. `npm install`
5. `npm run dev` — local development
6. `npm run deploy` — build + deploy to staging
7. `npm run test:e2e` — run Playwright tests

## Conventions

See CLAUDE.md for the full set of development conventions:
- ROADMAP.md as the canonical priority list
- Small PRs, session artifacts in docs/sessions/
- Playwright validation of every UI feature
- Non-destructive refresh pattern
- Sequential scenario test runs
