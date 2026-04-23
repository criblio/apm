# Plan: Generalizing Cribl APM for reuse

This session identified three layers of reusable work that should
be extracted for the next Cribl app and for other Cribl app authors.

## 1. Cribl App Component Library (`@cribl/app-components`)

A React + CSS component library encoding the look and feel of
Cribl APM, themed to the Cribl design system via `--cds-*` CSS
variables injected by the host shell.

### Layout primitives
- `AppShell` — nav bar + content outlet
- `NavBar` — tabs with dropdown support, settings icon, trace/search input
- `PageHero` — title + subtitle + time range picker + auto-refresh controls
- `RefreshBar` — thin animated progress indicator during data fetch
- `Card` / `Section` — panel with header, border, shadow

### Data display
- `DeltaChip` — before/after comparison pills (rel, points, rateDrop modes)
- `Sparkline` — inline SVG sparkline (request rate, latency)
- `StatusBanner` — error/warning/info banners
- `HealthBadge` — colored badge for health states (healthy/watch/warn/critical/silent/traffic_drop/latency_anomaly)
- `AlertStatusBadge` — firing/pending/resolving/persistent badges
- `TraceClassList` — grouped list panel with skeleton, stale chip
- `DetectedIssuesPanel` — alert rows with severity dots, badges, actions
- `SortableTable` — table with sortable column headers and sort indicators

### Interaction
- `TimeRangePicker` — range selector dropdown
- `InvestigateButton` — launches Copilot with a seed (if available)
- Non-destructive refresh pattern (keep data visible during fetch)

### CSS foundation
- Panel card style (border, radius, shadow)
- Table styles (compact headers, tabular nums, hover rows)
- Skeleton shimmer animation
- Status color palette as a consistent vocabulary
- Health-bucket row backgrounds

## 2. Cribl App SDK (`@cribl/app-utils`)

A TypeScript utility library for building Cribl Search Apps.
Platform-level concerns that any pack needs.

### API layer
- `kvstore.ts` — KV store client (GET/PUT/DELETE with text/plain body workaround)
- `cribl.ts` / `runQuery()` — KQL execution wrapper
- `appSettings.ts` — settings load/save with merge semantics
- Module-level pub/sub pattern (`dataset.ts`, `streamFilter.ts`, `searchCadence.ts`) — reactive settings that trigger re-fetches across the app

### Scheduled search infrastructure
- `provisioner.ts` — declarative reconciliation engine (create/update/delete/noop)
- `provisionedSearches.ts` pattern — declarative search plan with schedule configs
- `panelCache.ts` — `$vt_results` batched reader with partitioning by jobName
- Lookup seeding for chicken-and-egg provisioning

### Alert state machine
- `alertState.ts` — state machine types + transition function (ok → pending → firing → resolving → ok)
- Debounce config (fireAfter, clearAfter)
- The three-search pipeline pattern (prev summary → evaluator → state export)
- `| send group="search"` for writing alert history to the dataset

### Export
- `exportInvestigation.ts` — DOM-to-PNG via SVG foreignObject (sandbox-safe, CSP-safe)

### React hooks
- `useRangeParam` — time range from URL search params
- `useStreamFilter` / `useDataset` / `useSearchCadence` — useSyncExternalStore wrappers

## 3. Claude Skill: `cribl-app`

A Claude Code skill that loads platform knowledge when working on
Cribl Search App packs. Encodes the rules, patterns, and caveats
that aren't obvious from reading code.

### Platform rules (from AGENTS.md)
- The fetch proxy: auth injection, pack-scoped URL rewrites, external domain routing, 30s timeout
- `proxies.yml`: every external domain must be declared with path/header allowlists
- `window.CRIBL_API_URL` / `window.CRIBL_BASE_PATH` injected by host
- React Router: `basename={window.CRIBL_BASE_PATH}`
- Route conflicts: avoid `/settings` in pack routes (host intercepts)
- KV store scoping: pack-scoped namespace, no collisions

### KQL caveats (learned the hard way)
- `(?i)` inline regex flag crashes in complex pipelines — use `[Cc]haracter` alternation
- `any()` not supported in all versions — use `max()` instead
- `summarize → summarize max(iff(...))` crashes on real data — split into separate searches + lookups
- `foldkeys` output doesn't support type filtering — use `_raw` regex parsing
- `| lookup` for reading, `| export to lookup` for writing (10k row cap)
- `| send group="search"` for writing events to the dataset (NOT `group="default_search"`)
- `$vt_results` for reading scheduled search output
- `ago(1h)` works for time splitting within queries
- `| export to lookup` consumes rows — they don't go to `$vt_results`

### Sandbox constraints
- No `allow-downloads` — can't trigger file downloads from the iframe
- No `allow-popups` — `window.open()` blocked
- CSP blocks `blob:` URLs for images — use `data:` URLs
- Cross-origin frame access blocked — don't use html2canvas or libraries that traverse `window.parent`

### Patterns to follow
- Non-destructive refresh: keep previous data visible during fetch, only show skeletons on initial load
- Configurable scheduled search cadence via KV + provisioner
- Lookup seeding for chicken-and-egg provisioning problems
- Graph stability: topology key to avoid simulation restart on data-only refreshes
- Playwright validation of every UI feature against staging before shipping

### Testing patterns
- Auth via `installCriblHostGlobals(page)` + `gotoApm(page, '/path')`
- Bearer token via OAuth client credentials (`CRIBL_CLIENT_ID` + `CRIBL_CLIENT_SECRET`)
- KQL assertions via `runQuery()` helper for server-side validation
- Sequential scenario runs (staging worker pool can't handle parallel)

## 4. Template Repo (`create-cribl-app`)

A starter template for new Cribl Search Apps:

```
create-cribl-app/
  CLAUDE.md              — project-level Claude instructions (from APM)
  AGENTS.md              — Cribl App Platform developer guide
  .env.example           — required env vars
  package.json           — Vite + React + TypeScript + Playwright
  config/proxies.yml     — external domain declarations
  src/
    App.tsx              — BrowserRouter with basename
    components/
      AppShell.tsx       — NavBar + Outlet
      NavBar.tsx         — with dropdown support
      DatasetProvider.tsx — settings loader
    api/
      kvstore.ts
      cribl.ts
      appSettings.ts
      provisioner.ts
    hooks/
      useRangeParam.ts
      useDataset.ts
    routes/
      HomePage.tsx       — starter page
      SettingsPage.tsx    — dataset + provisioning
  scripts/
    deploy.mjs           — build + upload + provision
    provision.ts         — CLI provisioner
  tests/
    helpers/
      apmSession.ts      — Playwright auth
      criblSearch.ts     — KQL runner
    auth.setup.ts        — Auth0 login
  playwright.config.ts
```

## Execution plan

1. **This session**: document the plan (this file), commit eval results
2. **Next session**: extract `@cribl/app-utils` as a shared package
   within this repo (or a sibling repo). Start with kvstore, cribl,
   provisioner, alertState — the most reused modules.
3. **New app session**: use the template to scaffold the new app,
   import `@cribl/app-utils`, and validate that the extraction works
   by building a real feature with it.
4. **Component library**: extract after the second app is working —
   the second consumer will validate the API surface.
5. **Claude skill**: write `cribl-app` skill after the second app,
   incorporating lessons from both projects.
