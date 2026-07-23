# Developing Cribl APM

Cribl APM is a Vite + React + TypeScript app that runs inside Cribl
Search's sandboxed iframe. This doc covers the local dev loop,
architecture, and shipping a build. For the end-user getting-started, see
the [README](../README.md).

Also read:

- **[AGENTS.md](../AGENTS.md)** — Cribl App Platform reference (host
  globals, fetch proxy, KV store, `proxies.yml`, React Router).
- **[CLAUDE.md](../CLAUDE.md)** — repo conventions (deploy, release, PR
  style, framework SHA pin, KQL caveats, testing).
- **[docs/cribl-app-skill/skill.md](cribl-app-skill/skill.md)** — lessons
  learned building this app (KQL pitfalls, scheduled-search patterns, UI
  patterns).

## Local development

This app is meant to run **inside Cribl Search's iframe**, not
standalone. The platform injects `window.CRIBL_API_URL` and proxies
`fetch()` through the parent window with auth + pack scoping. Hitting
`http://localhost:5173/` directly loads the chrome but every API call
fails.

### The dev loop

1. `npm install`, then `npm run dev` — Vite serves on `localhost:5173`
   and exposes a `/package.tgz?dev=true` endpoint the platform's
   `__local__` slot consumes. (This repo consumes the shared framework
   via a local `file:..` dependency pinned in `.framework-sha`; see
   [CLAUDE.md](../CLAUDE.md) for keeping that checkout in sync.)
2. In your Cribl Cloud workspace, open **`/apps/__local__`** (e.g.
   `https://your-workspace.cribl.cloud/apps/__local__`). The platform
   iframes `localhost:5173` and wires up `window.CRIBL_API_URL`.
3. Save a file → Vite HMR reloads inside the iframe → live data.

CSP is already whitelisted for `http://localhost:5173` on Cribl Cloud.

## Deploy from source

`npm run deploy` builds, packages, uploads, installs, and provisions from
a local checkout. It reads OAuth credentials from `.env` (`CRIBL_BASE_URL`,
`CRIBL_CLIENT_ID`, `CRIBL_CLIENT_SECRET`) and auto-detects prod vs.
staging from the workspace hostname. Underlying scripts:

- `npm run package` — `tsc -b && vite build && node scripts/package.mjs`,
  produces `build/apm-<version>.tgz`.
- `npm run deploy` — runs `package`, uploads/installs the tgz, then runs
  `scripts/provision.ts` to reconcile the scheduled searches.

See [CLAUDE.md](../CLAUDE.md) for the full deploy and release process.

## How it talks to Cribl Search

All data comes from the Cribl Search REST API via the pack-scoped fetch
proxy the platform injects into the iframe. There are no external API
calls — `config/proxies.yml` needs no entries for runtime data.

The query layer lives in `src/api/`:

| File | Role |
|---|---|
| `cribl.ts` | Thin client for `/m/default_search/search/jobs` (create → poll → NDJSON results) |
| `queries.ts` | KQL builders for services, operations, findTraces, traceSpans, dependencies |
| `transform.ts` | Maps raw OTel span rows → Jaeger-shaped `{trace, spans, processes}` |
| `search.ts` | High-level verbs the UI calls (`listServices`, `findTraces`, `getTrace`, …) |

`findTraces` is a 2-stage pipeline: stage 1 returns trace IDs matching the
filter at any depth (Jaeger semantics); stage 2 fetches all spans for
those IDs in one query and the client computes the root span.

Expensive panel queries are cached as scheduled Cribl Saved Searches
(provisioned from the Settings page) that pages read via `$vt_results` /
lookup joins — see [CLAUDE.md](../CLAUDE.md) and
[docs/cribl-app-skill/skill.md](cribl-app-skill/skill.md).

## Project layout

```
src/
├── api/                # Cribl Search client + KQL + transforms
├── components/         # AppShell, NavBar, SearchForm, TraceTable,
│                       # SpanTree, SpanDetail, DependencyGraph, …
├── routes/             # SearchPage, TraceView, SystemArchPage, ComparePage, …
├── styles/             # tokens.css (Cribl Design System subset) + base.css
├── utils/              # spans.ts (timeline + service color), diff.ts
├── App.tsx             # Router (basename = window.CRIBL_BASE_PATH)
└── main.tsx
config/proxies.yml      # Empty — no external API calls
scripts/                # package.mjs, deploy.mjs, provision.ts, browser.js, …
vite.config.ts          # Vite + Cribl App Platform plugins
```

## Visual style

The chrome mirrors Cribl Search: dark navy nav bar, teal brand accent,
green primary buttons, Open Sans, the same `--cds-*` design tokens
(subset). See `src/styles/tokens.css` for the ~30 CSS custom properties in
use.

## Known limitation — deep links flattened by the host

The Cribl App Platform host router strips sub-paths and query strings from
externally-loaded app URLs, so navigating a browser directly to
`/apps/apm/trace/abc123`, `/apps/apm/architecture`, or
`/apps/apm/search?service=frontend` lands on the default route with empty
state. Internal navigation (clicking a tab, clicking a trace, navigating
via `useNavigate()`) works — the URL bar updates via `CRIBL_NAV`
postMessages from the iframe to the parent, and back-button history works
as expected.

A bug is filed upstream; when it's fixed, no app-side change should be
needed — the route definitions in `App.tsx` already cover the relevant
deep-link patterns. The `navItems` entry in `package.json` declares the
app's routes in case the host starts using it to permit deep-link
navigation; it's harmless today if ignored.
