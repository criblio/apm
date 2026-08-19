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

**The `local/`-override trap (cost hours, 2026-08-14).** The pack ships
`proxies.yml` to `default/`, but the platform stores the effective grant
in a per-app **`local/`** override that shadows it. Symptoms: the runtime
says `Domain X is not declared in proxies.yml` even though the pack (and
`GET /apps/<id>/proxies` on a *fresh* app id) is correct, while the
existing app id keeps serving a stale grant.
- `GET /apps/<id>/proxies` shows the **effective** (local-wins) config,
  not your pack's `default/`. If it doesn't match your `proxies.yml`,
  a stale local override is in play.
- Redeploy (PATCH upgrade) does **not** re-read proxies; even a
  `DELETE /apps/<id>` + fresh install pulled the old grant back — the
  override survives on disk keyed to the app id. Proxies are **not**
  API-writable (`PATCH /apps/<id>/proxies` → 404), and the framework
  `inspect` blocks shipping a `local/` file in the pack.
- Confirm by deploying under a **throwaway app id**: a brand-new id gets
  the correct grant from the pack. Fix = clear the app's stale on-disk
  `local/` config server-side (or Cribl support), then reinstall.

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

**Existence check — 200, not 404 (2026-08-14).** A by-id GET
(`/notification-targets/<id>`, and `/m/<group>/notifications/<id>`)
returns `200 {items:[], count:0}` when the object is **absent**, not a
404. "The GET didn't throw" ≠ "it exists" — check `count`/`items.length`
or you'll PATCH a nonexistent object and 404.

**Saved-search notifications are a SEPARATE resource (cost hours).**
A scheduled search's `schedule.notifications` is **read-only on write**:
it's populated by JOINing from `/m/<group>/notifications` on read, so
writing `schedule.notifications` in the search body (POST or PATCH) is
**silently dropped** — the server keeps `{}` and the search notifies
nothing. To bind a notification, POST/PUT it to
`/m/<group>/notifications` (e.g. `/m/default_search/notifications`). The
record needs a unique `id` (`<savedQueryId>_Notification_1`), `disabled`,
`conf.savedQueryId`, and `targetConfigs[].id` — omit any and the item is
dropped. Match a known-good notification's exact shape. Keep the same
structure in your plan's `schedule.notifications` only so the
provisioner's `isSameAsPlan` deep-subset-matches the joined read and
doesn't churn.

**Webhook target auth.** A webhook target's `token` must equal the
receiving service's expected bearer; a mismatch is a plain `401` from
that service (distinct from the proxy's `403 not declared`). Redeploying
the receiver can rotate the secret and silently break a previously
working trigger — re-align both sides after any receiver redeploy.

## KQL caveats

### Known crashes
- `(?i)` inline regex flag crashes in complex pipelines (summarize +
  extend + negation). Use character-class alternation `[Cc]onsume`
- `summarize → summarize max(iff(...))` crashes on real data (works
  on synthetic rows, fails on 36+ real rows from a prior summarize).
  Split into separate searches joined via lookups.

### Union + `_time` assignment
- `| project _time=<column>` (or `extend _time=<column>`) after a
  `union` silently NULLS `_time` on rows that came from the union's
  subquery branch — main-branch rows keep it (found 2026-08-18 in the
  incident grouper; two identical-value rows, one null). Put a
  materializing operator between the union and the assignment:
  `| sort by <col> | project _time=<col>, …` fixes it. Assigning a
  constant (`_time=now()`) is unaffected.

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
- Fold/read-model searches: make them INCREMENTAL, not recompute. A
  full-history fold needs one wide dataset scan per join subquery —
  every scan pays for the whole time window even when the filter keeps
  only sparse curated events (a -7d scan measured >60s on staging; 8
  of them per cadence saturates the pool). Instead read the search's
  own previous output back from `$vt_results` (latest jobId via a
  `summarize jobId=max(tostring(jobId))` self-join — the fixed-width
  epoch-millis prefix makes the string max the newest run) and merge a
  short delta window, gating per-key on a carried high-water `_time`
  mark so window overlap never double-counts. Caveat: carried state is
  only visible within the search window — pause the search longer than
  that and the fold restarts from the delta.

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

**Deploy needs a version bump.** `installUploadedPack` no-ops when the
installed version equals the pack version (returns `unchanged`) — a
redeploy at the same `package.json` version silently does nothing and
you'll debug a "my change didn't ship" ghost. Bump the version for
every deploy that must land.

**Keep the UI and CLI provisioners identical.** Anything the CLI
(`scripts/provision.ts`) does beyond the saved-search reconcile — e.g.
create a webhook target, bind a notification — the in-app "Provision"
button must do too, or the two diverge (UI creates the search but not
the trigger). Put those steps in a shared, browser-safe `src/api/`
module and run them from both: the CLI directly, the UI via the
framework `ProvisioningPanel`'s `afterReconcile` hook (added 2026-08-14).

**Feature-flag-gated searches vs. an unreadable CLI flag.** When a
plan item is gated on an app-scoped KV flag the machine-token CLI can't
read, don't default the flag OFF — that DELETES the gated search out
from under a UI that has it ON, and every routine deploy fights the
user's setting (a "searches not provisioned" banner that flaps). Infer
the flag from server state (does the gated search exist?) when the
explicit env override is unset, so an unset deploy neither creates nor
deletes it.

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
