# Cribl APM — Cribl Search App

A Jaeger UI clone built as a [Cribl App Platform](AGENTS.md) app. Visualizes
distributed traces from the OpenTelemetry demo against the `otel` lakehouse
dataset in Cribl Search.

Three feature-parity tabs:

- **Search** — pick a service / operation / time range, returns the matching
  traces with root operation, span count, duration, and started-at.
- **Trace detail** — full waterfall span tree with timeline, service color
  coding, and a per-span detail panel (tags, events, references, process
  tags). Reachable from any search row or via `/trace/:id` deep link.
- **System Architecture** — force-directed dependency graph computed from
  `parent_span_id` self-joins. Click any node to jump to Search filtered
  to that service.
- **Compare** — structural diff between two traces. Pick two trace IDs;
  rows are coloured by shared / only-in-A / only-in-B with per-side
  durations. Deep linkable as `/compare/:idA/:idB`.

## How it talks to Cribl Search

All data comes from the Cribl Search REST API via the standard pack-scoped
fetch proxy that the Cribl App Platform injects into the iframe. There are
no external API calls — `config/proxies.yml` doesn't need entries for any
runtime data source.

The query layer lives in `src/api/`:

| File | Role |
|---|---|
| `cribl.ts` | Thin client for `/m/default_search/search/jobs` (create → poll → NDJSON results) |
| `queries.ts` | KQL builders for services, operations, findTraces, traceSpans, dependencies |
| `transform.ts` | Maps raw OTel span rows → Jaeger-shaped `{trace, spans, processes}` |
| `search.ts` | High-level verbs the UI calls (`listServices`, `findTraces`, `getTrace`, etc.) |

`findTraces` is a 2-stage pipeline: stage 1 returns trace IDs participating
in the filter (any depth, not just root spans — matching Jaeger semantics),
stage 2 fetches all spans for those IDs in one query and the client computes
the actual root span.

## Local development

This app is meant to run **inside Cribl Search's iframe**, not standalone.
The platform injects `window.CRIBL_API_URL` and proxies `fetch()` calls
through the parent window with auth + pack scoping. Hitting
`http://localhost:5173/` directly in a regular tab will load the chrome
correctly but every API call will fail.

### The dev loop

1. Run `npm run dev` — Vite serves on `localhost:5173` and exposes a
   `/package.tgz?dev=true` endpoint that the Cribl App Platform's
   `__local__` slot consumes.
2. In your Cribl Cloud workspace, open the URL **`/apps/__local__`**
   (e.g. `https://your-workspace.cribl.cloud/apps/__local__`). The
   platform iframes `localhost:5173` and wires up `window.CRIBL_API_URL`
   for you.
3. Save any file → Vite HMR reloads inside the iframe → live data,
   instant feedback.

CSP is already whitelisted for `http://localhost:5173` on the Cribl Cloud
side, so the iframe loads cleanly.

### Deploying to Cribl Cloud

```sh
npm run deploy
```

Builds, packages, and uploads the app to your workspace in one shot.
Reads OAuth credentials from the project root `.env` (the same
`CRIBL_BASE_URL` / `CRIBL_CLIENT_ID` / `CRIBL_CLIENT_SECRET` the Cribl MCP
server uses) and auto-detects production vs staging from the workspace
hostname. After install the app is reachable at `/apps/apm`.

The two underlying scripts are:

- `npm run package` — `tsc -b && vite build && node scripts/package.mjs`,
  produces `build/apm-<version>.tgz`.
- `npm run deploy` — runs `package` then PUTs the tgz to
  `/api/v1/packs?filename=…` and POSTs `{source, force: true}` to
  `/api/v1/packs` to install/replace.

## Project layout

```
src/
├── api/                # Cribl Search client + KQL + transforms
├── components/         # AppShell, NavBar, SearchForm, TraceTable,
│                       # SpanTree, SpanDetail, DependencyGraph, …
├── routes/             # SearchPage, TraceView, SystemArchPage, ComparePage
├── styles/             # tokens.css (Cribl Design System subset) + base.css
├── utils/              # spans.ts (timeline + service color), diff.ts
├── App.tsx             # Router (basename = window.CRIBL_BASE_PATH)
└── main.tsx
config/
└── proxies.yml         # Empty — no external API calls
scripts/
├── package.mjs         # Build the production tgz
├── pkgutil.mjs         # Cribl-supplied helper used by Vite + package.mjs
├── deploy.mjs          # OAuth + upload + install
├── browser.js          # Playwright-over-CDP helper for dev automation
├── browser-smoke.js    # CDP pipeline smoke test (npm run browser:smoke)
└── chromium-vnc.sh     # Relaunch local Chromium with CDP port exposed
vite.config.ts          # Vite + Cribl App Platform plugins
```

## Known limitation — external deep links are flattened by the host

The Cribl App Platform host router strips sub-paths and query strings from
any externally-loaded app URL. Navigating a browser directly to
`/apps/apm/trace/abc123`, `/apps/apm/architecture`, or
`/apps/apm/search?service=frontend` always lands on the app's default
route (`/search`) with empty state. Internal navigation (clicking a tab,
clicking a trace in the results table, navigating via `useNavigate()`) works
fine — the URL bar updates via `CRIBL_NAV` postMessages from the iframe up
to the parent, and back-button history works as expected.

This means the app's routes are not currently shareable via pasted URLs. A
bug has been filed upstream; when it's fixed, no app-side changes should be
needed — the route definitions in `App.tsx` already cover the relevant
deep-link patterns.

The `navItems` entry in `package.json` declares the app's routes in case the
host ever starts using it to permit deep-link navigation; it is harmless
today if ignored.

## Visual style

The chrome mirrors Cribl Search: dark navy nav bar, teal brand accent,
green primary buttons, Open Sans, the same `--cds-*` design tokens
(subset). See `src/styles/tokens.css` for the ~30 CSS custom properties
in use.
