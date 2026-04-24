# Cribl App Development Skill

Use this skill when working on Cribl Search App packs (Vite + React
+ TypeScript apps that run inside the Cribl Search iframe).

## Platform rules

### Fetch proxy
The Cribl host wraps `window.fetch()` to:
- Inject auth headers (your app never handles tokens)
- Rewrite pack-scoped URLs to the correct API endpoint
- Route external domain calls through `proxies.yml`
- Apply a 30-second timeout

### proxies.yml
Every external domain your app calls must be declared in
`config/proxies.yml` with path allowlists and header injection.
Calls to undeclared domains return a JSON error, not a network error.

### Globals
- `window.CRIBL_API_URL` — full URL to `/api/v1` (injected by host)
- `window.CRIBL_BASE_PATH` — React Router basename (e.g., `/app-ui/apm/`)

### React Router
Always use `basename={window.CRIBL_BASE_PATH}` on `<BrowserRouter>`.

### Route conflicts
Avoid `/settings` in pack routes — the Cribl host shell intercepts
paths containing "settings".

### KV store
Pack-scoped key-value store at `CRIBL_API_URL + '/kvstore/...'`.
- Use `content-type: text/plain` for PUT (JSON content-type causes
  the value to be served back as `[object Object]`)
- 404 on missing keys — normalize to `null`

## KQL caveats

### Known crashes
- `(?i)` inline regex flag crashes in complex pipelines (summarize +
  extend + negation). Use character-class alternation `[Cc]onsume`
- `summarize → summarize max(iff(...))` crashes on real data (works
  on 4 synthetic rows, fails on 36+). Split into separate searches
  joined via lookups.

### Unsupported functions
- `any()` — not supported in all Cribl Search versions. Use `max()`
- `percentileif()` — not available. Use conditional filtering before
  `percentile()`

### Operators
- `| lookup <name> on <columns>` — LEFT JOIN against a lookup table
- `| export mode=overwrite to lookup <name>` — write to lookup (consumes
  rows — they don't go to `$vt_results`)
- `| send group="search"` — send events to the Local Search HTTP input.
  Include `dataset="<name>"` in the event to route to the right lakehouse.
  Do NOT use `group="default_search"` (crashes).
- `$vt_results` — read scheduled search output. Filter by `jobName`.
- `ago(1h)` — works for time splitting within queries

### Query patterns
- Two-window comparison: use separate searches for current and previous
  windows, join via lookup. Don't try to pivot with `max(iff(...))`.
- State machine in KQL: `case()` with `iff()` for conditional logic,
  `| lookup` for previous state, `| export to lookup` for persistence.

## Sandboxed iframe constraints

- **No `allow-downloads`** — can't trigger file downloads via `<a download>`
- **No `allow-popups`** — `window.open()` blocked
- **CSP blocks `blob:` URLs for images** — use `data:` URLs instead
- **Cross-origin frame access blocked** — don't use `html2canvas` or
  libraries that traverse `window.parent`
- **DOM-to-PNG**: use SVG foreignObject with inline styles. Clone the
  DOM, inline all computed styles, serialize to SVG, render to canvas.

## Scheduled search patterns

### Provisioning
Declare searches in a plan file. The provisioner diffs against the
server and creates/updates/deletes as needed. Use `criblapm__` prefix
(or your own pack prefix) to avoid touching user-created searches.

### Panel caching
Scheduled searches write to `$vt_results`. The UI reads all panels
in a single batched query using `jobName in (...)`. Cache miss falls
back to live queries.

### Lookup seeding
`| export to lookup` requires the lookup to exist at search creation
time. Seed lookups with an init query before provisioning searches
that reference them.

### Alert state machine
Three-search pattern:
1. Previous-window summary → export to lookup
2. Evaluator → reads current from $vt_results, joins prev from lookup,
   applies state machine, outputs to $vt_results
3. State export → exports state to lookup for next cycle

Optional: `| send group="search"` for writing history events to the
dataset.

### Cadence
Make scheduled search cadence configurable via a Settings page
dropdown. Store in KV, read by both browser and CLI provisioners.
Derive eval cadence (1 minute offset) from panel cadence.

## Non-destructive refresh

Never set all loading states to `true` at the start of a refresh.
Keep existing data visible while new queries run. Only show skeletons
on the initial load (no data yet). Each panel updates in place when
its query resolves.

## Testing patterns

### Playwright (e2e)
- Auth via `installCriblHostGlobals(page)` which injects
  `CRIBL_BASE_PATH`, `CRIBL_API_URL`, and a Bearer token fetch wrapper
- Navigate with `gotoApm(page, '/path')` (handles base path)
- Can't navigate directly to pack URLs (server returns 404) — must
  load the base path first, then use React Router navigation

### KQL assertions
Use `runQuery()` from test helpers for server-side validation:
```typescript
const rows = await runQuery('dataset="$vt_results" | where ...');
assert(rows.length > 0);
```

### Eval harness
Scenario-driven evaluation: flip a flagd flag, wait for telemetry,
run surface checks (Playwright locators) + KQL checks (query polling),
optionally run the Copilot Investigator. Score = surface checks × 0.7
+ investigator × 0.3.

Run scenarios sequentially (staging worker pool can't handle parallel).
Allow 10+ minutes between scenarios for signal decay.
