# Cribl APM

**Cribl APM** is a [Cribl App Platform](AGENTS.md) app that delivers an
APM experience — service health overview, distributed traces, system
architecture, and AI-driven anomaly investigation — on top of
OpenTelemetry traces, logs, and metrics landing in a Cribl Search
dataset. It runs as a sandboxed iframe inside Cribl Search and ships to
Cribl Cloud as an installable pack.

## Features

- **Home** — multi-service health board with golden-signal sparklines,
  top slow / error trace classes, and operation-level anomaly
  highlights.
- **Search** — Jaeger-style trace search by service / operation / time
  range, returning matching traces with root operation, span count,
  duration, and started-at.
- **Trace detail** — full waterfall span tree with timeline, service
  color coding, and a per-span detail panel (tags, events, references,
  process tags). Reachable from any search row or via `/trace/:id`.
- **System Architecture** — force-directed service dependency graph
  computed from `parent_span_id` self-joins. Click any node to jump to
  Search filtered to that service.
- **Compare** — structural diff between two traces, with rows coloured
  by shared / only-in-A / only-in-B and per-side durations. Deep
  linkable as `/compare/:idA/:idB`.
- **Investigate** — embedded Cribl Copilot Investigator: a chat UI that
  takes a seed (service + symptom, or free-form prompt) and walks the
  dataset via approved tool calls to surface a root cause.
- **Service detail** — per-service drilldown with metric cards and
  recent traces, reachable from anywhere a service name is rendered.

## Prerequisites — telemetry source

Cribl APM is a UI; it does not ingest data. It expects OpenTelemetry
traces, logs, and metrics to already be landing in a Cribl Search
dataset (default name: `otel`, configurable on the in-app Settings
page and persisted to the pack-scoped KV store).

The companion repo
**[`criblio/otel-demo-criblcloud`](https://github.com/criblio/otel-demo-criblcloud)**
is the Terraform-orchestrated pipeline that runs the OpenTelemetry Demo
and ships its OTLP traffic into Cribl Cloud. Standing that up — or
otherwise feeding equivalent OTel data into a Cribl Search dataset — is
a prerequisite for non-empty pages in this app.

The dataset must contain:

- **Spans** — OTel span shape with `end_time_unix_nano` populated
- **Logs** — `body` field populated
- **Metrics** — rows where `datatype == "generic_metrics"`

See `src/api/agentContext.ts` for the exact KQL filters the app uses.

## Install

### From a tagged release

Each `v*` tag on this repo triggers the GitHub Actions release workflow,
which builds and attaches `apm-<version>.tgz` to a new
[GitHub Release](https://github.com/criblio/apm/releases). To install:

1. Download `apm-<version>.tgz` from the Releases page.
2. Upload the tgz to your Cribl Cloud workspace via the Apps UI, or
   PUT it to `/api/v1/packs?filename=apm-<version>.tgz` then POST
   `{source, force: true}` to `/api/v1/packs`.
3. The app appears at `/apps/apm` in your workspace nav.

### From source

`npm run deploy` automates the same upload from a local checkout. It
reads OAuth credentials from `.env` (`CRIBL_BASE_URL`,
`CRIBL_CLIENT_ID`, `CRIBL_CLIENT_SECRET` — the same triple the Cribl
MCP server uses) and auto-detects production vs. staging from the
workspace hostname. The two underlying scripts:

- `npm run package` — `tsc -b && vite build && node scripts/package.mjs`,
  produces `build/apm-<version>.tgz`.
- `npm run deploy` — runs `package` then PUTs the tgz to
  `/api/v1/packs?filename=…` and POSTs `{source, force: true}` to
  `/api/v1/packs` to install/replace.

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

When you're ready to ship a build to a real workspace, see the
[Install](#install) section above — `npm run deploy` is the source-side
path.

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
