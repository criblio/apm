# Research: Cribl Saved Searches + Scheduled Searches + Alerts

Drives ROADMAP §2 — durable baselines, alerts, SLOs. Captured by
browser sniffing, JS bundle spelunking, and MCP-server reads of the
live `main-objective-shirley-sho21r7.cribl-staging.cloud` deployment.

Last captured: 2026-04-11.

## TL;DR

- **One API covers all of §2**: saved searches ARE scheduled searches
  ARE alerts. Adding a `schedule.enabled = true` + a
  `schedule.notifications.items[]` entry to a saved search is how you
  create a scheduled search with an alert.
- **No TypeScript SDK for Cribl Search saved searches.** The official
  `cribl-control-plane` and `cribl-mgmt-plane` SDKs are
  Stream/Workspace-focused; their `SavedJob` model is wired to
  `Collectors` (Stream collectors, not Search saved searches).
  We'll hit the REST API directly.
- **Auth from inside our pack iframe is free**: the platform fetch
  proxy injects `Authorization: Bearer <auth0-jwt>` automatically
  for any call to `CRIBL_API_URL + '/m/default_search/...'` — same
  mechanism we already use for `/search/jobs`.

## REST endpoints

Saved-search endpoints are prefixed with `CRIBL_API_URL +
'/m/default_search'` (= `/api/v1/m/default_search` at the network
layer). Notification targets are **top-level cross-product**
(not under `/m/...`). Verbs confirmed via live POST / GET /
DELETE round-trip and JS bundle spelunking.

### Saved searches

| Verb | Path | Purpose | Status |
|---|---|---|---|
| `GET` | `/search/saved` | List saved searches. Supports `?limit=N&offset=M`. Response is `{items: [...], count: N}`. | ✅ confirmed |
| `POST` | `/search/saved` | Create. Body is a saved-search object (see schema). Client-chosen `id` respected. Returns `{items:[<created>], count:1}`. | ✅ confirmed by live round-trip |
| `GET` | `/search/saved/:id` | Get one. Returns `{items: [<one>], count: 1}` — still wrapped. | ✅ confirmed |
| `PATCH` | `/search/saved/:id` | Update (partial). | 🟡 inferred from JS bundle |
| `DELETE` | `/search/saved/:id` | Delete. Returns the deleted object. `GET` afterward 404s. | ✅ confirmed by live round-trip |
| `GET` | `/search/saved/:id/results` | Fetch results of past scheduled runs. **Returned 404 for `tailscale_offline`**; likely needs a search that actually produced output OR a different prefix. Superseded by `dataset="$vt_results" jobName=...` for baseline reads. | 🟡 partial |
| `POST` | `/search/saved/:id/notifications` | Create a notification on a saved search. | 🟡 inferred from JS bundle |
| `PATCH` | `/search/saved/:id/notifications/:notificationId` | Update. | 🟡 inferred |
| `DELETE` | `/search/saved/:id/notifications/:notificationId` | Delete. | 🟡 inferred |

### Notification targets (cross-product)

| Verb | Path | Purpose | Status |
|---|---|---|---|
| `GET` | `/api/v1/notification-targets` | List all cross-product notification targets (webhooks, Slack, PagerDuty, SNS, email, system_messages). | ✅ confirmed |
| `POST` | `/api/v1/notification-targets` | Create a target. | 🟡 inferred |
| `PATCH` | `/api/v1/notification-targets/:id` | Update. | 🟡 inferred |
| `DELETE` | `/api/v1/notification-targets/:id` | Delete. | 🟡 inferred |

A notification target ID (e.g., `typhoon_ntfy`) is referenced
from a saved search's `schedule.notifications.items[].targets[]`.
Targets created in any Cribl product are visible from all of
them. UI path: `Settings > Search > Notification Targets`.

### Related endpoints observed in passing

| Verb | Path | Purpose |
|---|---|---|
| `GET` | `/search/datasets` | List available datasets. |
| `GET` | `/search/dataset-providers` | List dataset provider types (cribl_search, cribl_leader, cribl_edge, s3, minio, …). |
| `GET` | `/search/macros` | KQL macros. |
| `GET` | `/search/dashboard-categories` | Dashboard groupings (saved-search based). |
| `POST` | `/search/jobs` | Run a live search job — already in use by `api/cribl.ts`. |

## Saved search schema

Captured from live examples (`tailscale_offline`, `dummy_alert`,
`Pihole_DNS_Queries`, `OS_Lookup`, `cribl_search_finished_1h`, etc).

```ts
interface SavedSearch {
  id: string;                    // stable identifier; appears in URL paths
  name: string;                  // human-readable
  description?: string;
  query: string;                 // KQL source
  earliest: string | 0;          // e.g. "-1h", "-10m", 0 (epoch start)
  latest: string;                // e.g. "now"
  sampleRate?: number;           // 1 = all events; < 1 = sample
  isPrivate?: boolean;           // visible only to owner
  user?: string;                 // owning user ID (e.g. "google-oauth2|..." or "oidc|...")
  displayUsername?: string;      // cached display name
  lib?: string;                  // library namespace; built-in searches use "cribl"

  schedule?: {
    enabled: boolean;
    cronSchedule?: string;       // e.g. "0 * * * *" (hourly)
    tz?: string;                 // e.g. "UTC"
    keepLastN?: number;          // retain results of last N runs
    emptyNotifications?: object; // empty-result handling
    emptyAdvanced?: object;
    notifications?: {
      disabled?: boolean;
      items?: Array<{
        id: string;              // e.g. "<searchId>_Notification_1"
        disabled?: boolean;
        condition: string;       // e.g. "search"
        targets: string[];       // notification target IDs (e.g. ["typhoon_ntfy"])
        conf: {
          triggerType: string;   // e.g. "resultsCount"
          triggerComparator: string; // e.g. ">"
          triggerCount: number;  // threshold
          message: string;       // template: {{timestamp}}, {{savedQueryId}}, {{searchId}}, {{resultSet}}, {{searchResultsUrl}}, {{notificationId}}, {{tenantId}}
          savedQueryId: string;  // ref back to parent
        };
        targetConfigs?: Array<{
          id: string;
          conf: { includeResults?: boolean; attachmentType?: string };
        }>;
        group: string;           // e.g. "default_search"
      }>;
    };
  };

  // Dashboard-rendering hints (irrelevant for provisioning)
  chartConfig?: object;
  tableConfig?: object;
  timeRange?: object;
}
```

### Example — scheduled alert (live `tailscale_offline`)

```json
{
  "id": "tailscale_offline",
  "name": "tailscale_offline",
  "description": "Monitored machines offline for 1h+",
  "isPrivate": true,
  "query": "cribl dataset=\"tailscale\" | lookup monitored_hosts on hostname | where connectedToControl==false and monitored==\"true\" | extend lastSeenParsed=... | where lastSeenParsed < ago(1h) | project hostname",
  "earliest": 0,
  "latest": "now",
  "sampleRate": 1,
  "schedule": {
    "enabled": true,
    "cronSchedule": "0 * * * *",
    "tz": "UTC",
    "keepLastN": 2,
    "notifications": {
      "disabled": false,
      "items": [{
        "id": "tailscale_offline_Notification_1",
        "condition": "search",
        "targets": ["typhoon_ntfy"],
        "conf": {
          "triggerType": "resultsCount",
          "triggerComparator": ">",
          "triggerCount": 0,
          "savedQueryId": "tailscale_offline",
          "message": "Date: {{timestamp}}\n\nA notification was triggered..."
        },
        "targetConfigs": [
          { "id": "typhoon_ntfy", "conf": { "includeResults": true, "attachmentType": "inline" } }
        ],
        "group": "default_search"
      }]
    }
  }
}
```

## Auth model (from inside our pack)

- The Cribl UI loads an Auth0 SPA bundle that stores a JWT access
  token in `localStorage` under `@@auth0spajs@@::...::...`.
- Each API call is made with `Authorization: Bearer <jwt>`.
- **For our pack**, the iframe fetch proxy described in
  `AGENTS.md` injects this header automatically. We already
  rely on this for `/search/jobs` — same mechanism applies to
  `/search/saved`.
- Research limitation: `fetch()` from `page.evaluate()` in a driven
  browser does NOT inherit the header (the token is in JS memory,
  not cookies). To probe endpoints directly from a script, read
  the token out of `localStorage` first:
  ```js
  const token = JSON.parse(
    Object.entries(localStorage).find(([k]) => k.startsWith('@@auth0spajs@@'))[1]
  ).body.access_token;
  ```

## SDK situation

`npm search @criblio` turns up two official TypeScript SDKs:

- **`cribl-control-plane`** — Stream resources (sources, destinations,
  routes, pipelines, workers). Uses the Cribl OpenAPI spec via
  Speakeasy codegen. `SavedJob`-related operations exist in the
  model directory but are wired into the `Collectors` SDK class
  (Stream's scheduled data-collection jobs). **Does not cover
  Cribl Search saved searches.**
- **`cribl-mgmt-plane`** — Workspaces, API credentials, health. Tiny.
  **Does not cover Cribl Search saved searches.**

There is **no official TS SDK for Cribl Search**. We hit `/search/*`
REST directly. If one lands later, we'd want to swap it in.

## Persistence options — the three mechanisms

There are three ways to persist output from a scheduled search
for later reads. All confirmed via Cribl docs.

### Option A: `$vt_results` (automatic retention)

Every saved-search execution is automatically kept in the
`$vt_results` virtual table for a default 7 days (configurable
at `Settings > Search > Limits > Search history TTL`).

**Read syntax:**
```kql
dataset="$vt_results" jobName="my_saved_search"
// or the Nth-previous run:
dataset="$vt_results" jobName="my_saved_search" execution=-1
// or all history:
dataset="$vt_results" jobName="my_saved_search" execution=*
// or by explicit job ID:
dataset="$vt_results" jobId="1704236905683.wgocax"
```

**Batch reads across multiple named searches** use an `in (...)`
filter instead of the advertised array literal. The docs at
[docs.cribl.io/search/vt_results](https://docs.cribl.io/search/vt_results/)
show `jobName=["a","b"]` as the array form, but Cribl KQL does
not actually parse the array literal in the top-of-pipeline
position. Empirically:

```kql
// FAILS with "no viable alternative at input 'jobName=['":
dataset="$vt_results" jobName=["panel_a","panel_b"]

// WORKS — returns the union of rows from both searches:
dataset="$vt_results"
  | where jobName in ("panel_a", "panel_b", "panel_c")
```

Both reads return one row per cached result row, with the
`jobName` column auto-populated so the client can partition
the mixed stream client-side. See §2b.2 of the ROADMAP for
the full rationale on why this batching is load-bearing.

**Write**: free, automatic — every scheduled run retains its
results with no `| export` or `| send` step needed.

**Drawbacks**:
- Reading technically runs a search against the stored results,
  which consumes minor search credits (distinct from the free
  "open from History" UI action). In practice the cost is
  dominated by the per-job queue wait, not the aggregation — see
  timing numbers below.
- Retention capped at the TTL setting (default 7 days).

**Empirical timing** (staging deployment, single-node worker
pool, reading the cached output of an existing scheduled
search):
```
job id      : 1775952658785.7tDv49
query       : dataset="$vt_results" jobName="tailscale_offline" | limit 100
queue wait  : 511 ms
execution   : 527 ms
total       : 1.04 s
```

That 1-second read is the entire cost regardless of how
expensive the source saved search was — `$vt_results` serves
stored aggregated rows, not the raw data the original query
scanned. For comparison, our live `allOperationsSummary` query
against 24h of raw spans takes ~22 s end-to-end. A `$vt_results`
read of the same cached result would be ~1 s.

**When to pick this**: caching the primary output of a
scheduled search for a later page to render verbatim, where
no join against live data is needed. Ideal for Home catalog
panels, sparklines, slow-trace classes, error classes, graph
edges — any panel that today fires its own dedicated search on
page load.

### Option B: `export ... to lookup` (explicit materialization)

The `| export` operator at the end of a query materializes its
output as a workspace-scoped lookup CSV.

**Syntax (full):**
```
... | export [ mode=Mode ]
             [ description=Description ]
             [ suppressPreviews=Previews ]
             [ fieldMapping=src1:dst1,src2:dst2 ]
             [ compress=auto|true|false ]
             to lookup LookupName
             [ tee=true|false ]
             [ maxEvents=N ]
```

**Modes:**
- `create` — fail if the lookup exists (default if omitted on
  a fresh install)
- `overwrite` — replace the lookup contents atomically on every
  run (**the mode we want for baselines**)
- `append` — accumulate rows across runs

**Limits:**
- Hard cap of 10,000 rows (`maxEvents` defaults to this and
  can't exceed it).
- Admin/Editor role required to run `export`.
- Scope is workspace, not pack — can't write pack lookups.

**Read syntax:**
```kql
... | lookup my_baselines on svc, op
```

A `lookup` is a hash-join against a cached CSV in workspace
state — **sub-millisecond overhead on the search pipeline**.
Not another search job.

**Example scheduled-search body:**
```kql
dataset="otel"
| where isnotnull(end_time_unix_nano)
| extend svc=tostring(resource.attributes['service.name']),
         dur_us=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0
| where dur_us < 30000000
| summarize requests=count(),
            p50_us=percentile(dur_us, 50),
            p95_us=percentile(dur_us, 95),
            p99_us=percentile(dur_us, 99)
  by svc, op=name
| export mode=overwrite
         description="Cribl APM operation baselines"
         to lookup criblapm_op_baselines
```

### Option C: `| send` (round-trip through Stream)

The `| send` operator forwards results to a Cribl HTTP Source
as a POST of NDJSON. Once ingested, the data follows whatever
Stream pipeline / destination the HTTP Source is routed to,
and can then be read as a normal dataset.

**Syntax:**
```
... | send [ tee=true|false ] [ group=WorkerGroup | "URL" ]
```

**Defaults:**
- Targets the Cribl HTTP Source in your Cribl Cloud Organization
- Default group: `default`, default port: `10200`
- No ingest charge for same-workspace routing
- Content-Type: `application/x-ndjson`

**Use case**: long-term baselines beyond lookup's 10k row cap,
or feeding results to a dataset another product can query.
Requires a Stream HTTP Source to be configured and pointed at
a destination, which is a multi-step config. Heavier than
`export to lookup`.

### Comparison for our baseline use case

| Factor | `$vt_results` | `export to lookup` | `send` |
|---|---|---|---|
| Write effort at end of scheduled search | None (free) | `\| export mode=overwrite to lookup X` | `\| send` + HTTP Source config |
| Retention | 7d default | Permanent until overwritten/deleted | Depends on destination |
| Read mechanism | Another search job against stored results | Hash-join on cached CSV | Normal dataset scan |
| Read speed | Slow (new search job) | **Sub-millisecond** | Normal dataset read |
| Read cost | Credit-charged | Free | Credit-charged |
| Idempotent upsert | Automatic per run | `mode=overwrite` | No — append-only to destination |
| Row cap | Not stated | 10,000 hard cap | None |
| Role required | Any search user | Admin/Editor | Any search user |
| Scope | Workspace | Workspace (not pack) | Stream-routed |

### Recommendation — different mechanisms for different jobs

The two §2b use cases land on opposite sides of the
comparison. Use both.

#### For baselines (§2b.1) → `export mode=overwrite to lookup`

1. Baselines are a **join target**, not a standalone result.
   The live anomaly detector needs to cross-reference hundreds
   of current-window ops against their historical p95 in one
   query — that's exactly what `lookup on svc, op` is built
   for.
2. Baselines are small (~100–1,000 `(svc, op)` rows) — well
   under the 10k cap.
3. Join read speed is sub-millisecond — no extra search job,
   no queue wait. Critical because the join runs inside an
   already-in-flight search, not as its own request.
4. Idempotency is built in: `mode=overwrite` atomically
   replaces the lookup on every scheduled run, no diff logic.
5. Operators can inspect the lookup contents directly via
   the Search UI's Lookups page.

The Admin/Editor role requirement for `export` is a
consideration for §2e first-run provisioning but not a blocker
— pack installers are almost always Admins, and the
provisioning dialog can surface a clear error if not.

#### For panel caching (§2b.2) → `$vt_results` + `jobName` array

1. Panel data is the **primary output** of a saved search;
   the page just renders the rows verbatim. No join needed.
2. Some panels (sparklines, time-series) produce thousands of
   rows across many services — safely clear of the 10k
   lookup cap but still a non-trivial size.
3. **Batch reads via `jobName=[...]` array**: one `$vt_results`
   search pulls every cached panel in one job, collapsing
   N queue waits down to 1. This is the biggest single win
   available for Home + System Architecture load time.
4. Zero write-side code: scheduled searches auto-persist to
   `$vt_results`. Just provision the saved searches with
   `schedule.enabled=true`.
5. No Admin/Editor gate for writes — any scheduled search
   works. Still pack-installer-Admin for provisioning.

#### For long-term / cross-workspace flows → `send`

Neither of our §2b use cases needs this. Reserve for future
work (cross-region baselines, multi-workspace rollups, feeding
an external alerting pipeline that isn't Cribl notifications).

## Remaining unknowns (much shorter list than before)

1. **`/search/saved/:id/results` endpoint path**. The JS bundle
   constructs `/search/saved/${id}/results`, but our probe 404'd
   on `tailscale_offline`. **Not blocking §2b**: the canonical
   read path for scheduled search output is
   `dataset="$vt_results" jobName=...`, which IS documented and
   supported. The `/results` HTTP endpoint is superseded by the
   virtual table for our needs.
2. **Install-time hook on the App Platform**. `AGENTS.md` does not
   mention one. File as a platform feature request; design around
   a first-run dialog for now (§2e).
3. **Idempotent naming convention confirmed safe**. Our POST probe
   used `id: "__criblapm_research_probe__"` and the server
   respected it. Proposal stands: prefix all app-managed IDs with
   `criblapm__` so the pack can diff-upsert on upgrade
   without touching user rows.

Everything else that was previously "partial" or "open" is
resolved.

## Next concrete steps for §2b

1. **Write the provisioner.** A node script under `scripts/` that:
   - Loads a declarative config (e.g.
     `config/provisioned-searches.yml`) listing the
     scheduled searches the app needs
   - Reads the Auth0 token from `localStorage` (for dev) or from
     the platform fetch proxy (at app runtime)
   - For each config entry, ensures a saved search exists with
     the right `id`, `query`, `schedule.cronSchedule`, and
     `schedule.enabled=true`
   - Diffs the current set against expected (filter by
     `id.startsWith("criblapm__")`) and upserts/deletes
   - Writes a `criblapm__provisioned_version` KV key on
     success so upgrades can re-run migrations selectively
2. **Ship the first scheduled search**: the per-op baseline.
   Query body captured above; schedule: `0 * * * *` (hourly)
   or `*/10 * * * *` (every 10 minutes, if we want faster
   baseline refresh). `keepLastN: 2` is fine since the lookup
   is the source of truth for reads.
3. **Re-wire `listOperationAnomalies`** to read the baseline
   via `lookup criblapm_op_baselines on svc, op` instead
   of an ad-hoc 24h query. This drops the 22s blocking query
   to roughly the same cost as the current-window-only fetch
   (~2-3s), unblocking the parked `OperationAnomalyList`.
4. **Re-add the widget** to the Home page and remove the
   parking breadcrumbs (`HomePage.tsx` comment, `HEALTH_LEGEND`
   entry, `anomalousServices` arg threading).
5. **Handle the first-run case** where the baseline lookup
   doesn't exist yet (fresh install, provisioned search hasn't
   run its first cycle). Detection: `lookup` on a missing file
   either errors or returns empty — branch: if the anomaly
   join yields zero rows, fall back to "baselines still being
   computed" empty state instead of "no anomalies".
