# Template manifest

Files to copy from the APM repo into a new Cribl app project.
This manifest guides the extraction — not all files are copied
verbatim; some need the APM-specific content stripped.

## Copy verbatim
- `AGENTS.md` — platform developer guide (app-agnostic)
- `.env.example`
- `config/proxies.yml` (strip APM-specific entries)
- `src/global.d.ts` — Window type declarations
- `src/api/kvstore.ts`
- `src/api/cribl.ts`
- `src/api/appSettings.ts` (strip APM-specific fields)
- `src/api/dataset.ts`
- `src/api/streamFilter.ts`
- `src/hooks/useRangeParam.ts`
- `src/hooks/useDataset.ts`
- `src/hooks/useStreamFilter.ts`
- `src/components/AppShell.tsx`
- `src/components/DatasetProvider.tsx`
- `src/components/TimeRangePicker.tsx`
- `src/components/StatusBanner.tsx`
- `scripts/deploy.mjs`
- `scripts/package.mjs`
- `scripts/provision.ts`
- `tests/helpers/apmSession.ts` (rename to criblSession.ts)
- `tests/helpers/criblSearch.ts`
- `tests/auth.setup.ts`
- `playwright.config.ts`

## Copy and customize
- `CLAUDE.md` — strip APM-specific sections, keep conventions
- `package.json` — keep deps/scripts, update name/version
- `src/App.tsx` — keep BrowserRouter pattern, strip APM routes
- `src/components/NavBar.tsx` — keep dropdown pattern, strip APM tabs
- `src/routes/HomePage.tsx` — starter skeleton
- `src/routes/SettingsPage.tsx` — keep dataset + provisioning, strip APM panels
- `src/api/provisioner.ts` — keep reconciliation engine, strip APM prefix

## Don't copy (APM-specific)
- All APM-specific routes (SearchPage, LogsPage, MetricsPage, etc.)
- APM-specific components (DependencyGraph, SpanTree, etc.)
- APM-specific queries (queries.ts)
- APM-specific types (JaegerSpan, etc.)
- eval/ directory (scenario-specific)
- docs/ directory (session logs)
