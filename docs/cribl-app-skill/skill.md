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
- `window.CRIBL_BASE_PATH` — React Router basename (e.g., `/app-ui/mypack/`)

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

### Notification targets
Product-level notification targets (Slack, PagerDuty, email, webhooks)
are available at `GET /api/v1/notification-targets`. They're configured
by the Cribl admin and shared across Stream and Search. Reference them
by ID — never ask users to paste webhook URLs into your app.

## KQL caveats

### Known crashes
- `(?i)` inline regex flag crashes in complex pipelines (summarize +
  extend + negation). Use character-class alternation `[Cc]onsume`
- `summarize → summarize max(iff(...))` crashes on real data (works
  on synthetic rows, fails on 36+ real rows from a prior summarize).
  Split into separate searches joined via lookups.

### Unsupported functions
- `any()` — not supported in all Cribl Search versions. Use `max()`
- `percentileif()` — not available. Use conditional filtering before
  `percentile()`

### Operators
- `| lookup <name> on <columns>` — LEFT JOIN against a lookup table
- `| export mode=overwrite to lookup <name>` — write to lookup
  (consumes rows — they don't go to `$vt_results`)
- `| send group="search"` — send events to the Local Search HTTP
  input. Include `dataset="<name>"` in the event to route to the
  right lakehouse dataset. Do NOT use `group="default_search"`
  (crashes).
- `$vt_results` — read scheduled search output. Filter by `jobName`.
- `ago(1h)` — works for time splitting within queries

### Query patterns
- Two-window comparison: use separate searches for current and previous
  windows, join via lookup. Don't try to pivot with `max(iff(...))`.
- State machine in KQL: `case()` with `iff()` for conditional logic,
  `| lookup` for previous state, `| export to lookup` for persistence.

## Sandboxed iframe constraints

- **No `allow-downloads`** — can't trigger file downloads via
  `<a download>`
- **No `allow-popups`** — `window.open()` blocked
- **CSP blocks `blob:` URLs for images** — use `data:` URLs instead
- **Cross-origin frame access blocked** — don't use `html2canvas` or
  libraries that traverse `window.parent`
- **DOM-to-PNG**: use SVG foreignObject with inline styles. Clone the
  DOM, inline all computed styles, serialize to SVG, render to canvas.

## Scheduled search patterns

### Provisioning
Declare searches in a plan file. The provisioner diffs against the
server and creates/updates/deletes as needed. Choose a pack-specific
prefix (e.g., `mypack__`) for managed search IDs to avoid touching
user-created searches.

### Panel caching
Scheduled searches write to `$vt_results`. The UI reads all panels
in a single batched query using `jobName in (...)`. Cache miss falls
back to live queries gracefully.

### Lookup seeding
`| export to lookup` requires the lookup to exist at search creation
time. Seed lookups with an init query in the provisioner before
creating searches that reference them.

### Alert state machine
Three-search pattern for server-side alerting without a browser:
1. Previous-window summary → export to lookup
2. Evaluator → reads current from $vt_results, joins prev from
   lookup, applies state machine, outputs to $vt_results for the UI
3. State export → exports state to lookup for the next cycle

Optional: `| send group="search"` for writing history events back
to the dataset as queryable records.

State machine lifecycle: ok → pending → firing → resolving → ok.
Use `fireAfter` (consecutive bad evaluations before firing) and
`clearAfter` (consecutive good before clearing) for debounce.

### Cadence
Make scheduled search cadence configurable via a Settings page
dropdown. Store in KV, read by both browser and CLI provisioners.
Derive eval cadence (1 minute offset) from panel cadence so the
evaluator runs after the data it depends on is available.

## UI patterns

### Non-destructive refresh
Never set all loading states to `true` at the start of a refresh.
Keep existing data visible while new queries run. Only show skeletons
on the initial load (no data yet). Each panel updates in place when
its query resolves. Show a thin progress bar to indicate a refresh
is in progress.

### Graph stability
When using d3-force or similar layout engines, compute a topology
key from node IDs + link endpoints. Only recreate the simulation
when topology changes. Data-only updates (same nodes, new metric
values) should mutate existing objects in place — no simulation
restart, no visual movement.

## Testing patterns

### CI
Run unit tests (Vitest), type checking (tsc --noEmit), and build
on every push/PR via GitHub Actions.

### Playwright (e2e)
- Auth via `installCriblHostGlobals(page)` which injects
  `CRIBL_BASE_PATH`, `CRIBL_API_URL`, and a Bearer token fetch
  wrapper via `addInitScript`
- Navigate with a helper function that prepends the pack base path
- Can't navigate directly to sub-routes (server returns 404) —
  must load the base path first, then use React Router navigation
  or click nav links

### KQL assertions
Use a `runQuery()` helper for server-side validation in tests:
```typescript
const rows = await runQuery('dataset="$vt_results" | where ...');
assert(rows.length > 0);
```

### Eval harness
Scenario-driven evaluation for detection quality:
1. Flip a feature flag (via flagd or similar)
2. Wait for telemetry to flow through the pipeline
3. Run surface checks (Playwright locators on the UI)
4. Run KQL checks (query polling for server-side state)
5. Optionally run an AI investigator for root-cause validation
6. Score = surface checks × 0.7 + investigator × 0.3

Run scenarios sequentially — staging worker pools can't handle
parallel query load. Allow 10+ minutes between scenarios for
signal decay from the previous scenario.

### Validate every UI change
Every new UI feature must be validated via Playwright against
staging before reporting it as done. Write a short script that
navigates, asserts key elements, and captures a screenshot.

## Performance review process

After making significant view/navigation changes, audit the data
loading patterns across all pages:

### Static code audit
1. List every page and what data it fetches
2. Check whether each fetch uses the panel cache ($vt_results
   batched read) or fires live queries
3. Flag pages that COULD read from cached scheduled search output
   but don't — these are easy wins
4. Check cache hit conditions: most caches only work on `-1h`
   range with stream filter enabled. Pages that always fire live
   queries regardless of range are candidates for caching.
5. Check for redundant fetches — data that's loaded on page A
   and then re-loaded when navigating to page B (consider
   lifting to a shared context or React Router loader)

### Eval framework performance checks
The eval harness should time each page load and flag slow ones:
1. Measure time from navigation to first meaningful content
2. Compare cached vs live query paths
3. Flag pages that take >3s on the cached path or >10s on live
4. Suggest specific scheduled searches that could cache the
   slow live queries

### Panel cache checklist
For each page, verify:
- [ ] Uses `listCachedXxxPanels()` on the default range
- [ ] Falls back to live queries on non-default ranges
- [ ] Shows stale-cache indicator when cache is old
- [ ] Non-destructive refresh (keeps previous data visible)
