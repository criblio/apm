---
name: apm-staging
description: Inspect the Cribl APM staging workspace — run KQL via the Cribl MCP (for data), or drive the deployed UI via Playwright (for pixels). Use when working in this repo and you need to see what the deployed pack is doing right now: errors on the home page, what spans/metrics look like, screenshot a page, or run any ad-hoc Cribl Search query. Covers MCP usage (preferred), Playwright auth via the existing test helpers, and the storage-state-expiry pitfall.
---

# apm-staging — how to see what staging is doing

Two distinct tasks, two distinct tools:

1. **Need data** (counts, query results, attribute values): use the
   **Cribl MCP** server.
2. **Need pixels** (screenshot for a PR, UI behavior verification):
   use **Playwright** via the existing test helpers.

These cover ~all real tasks. Don't roll your own Bearer-token search
client, don't reverse-engineer the Search HTTP API, don't try to
script the Auth0 login flow by hand. All of that is already solved.

## Mode 1 — Data via the Cribl MCP (preferred)

The repo ships a Cribl MCP server (`.mcp.json`, `scripts/cribl-mcp.sh`)
that exposes Cribl Search to Claude as MCP tools. **This is the default
path for any "run a query against staging" task.** No auth code, no
endpoint paths, no NDJSON parsing — just call the tool.

### Tools you'll actually use

- `mcp__cribl__cribl_runSearchQuery` — run a KQL query, get rows back.
  This is 95% of the use case.
- `mcp__cribl__cribl_listDatasets` — sanity-check the dataset name (the
  app's default is `otel`; production deployments may differ).
- `mcp__cribl__cribl_getSavedSearches` — see scheduled searches the app
  provisions; useful when verifying a `criblapm__*` lookup exists.

### Prerequisites

The MCP server must be running locally. Check first:

```bash
scripts/cribl-mcp.sh status
```

If it's not running, start it:

```bash
scripts/cribl-mcp.sh start
```

(Reads `CRIBL_BASE_URL` / `CRIBL_CLIENT_ID` / `CRIBL_CLIENT_SECRET` from
`.env`. If those are missing, stop and ask the user — don't guess.)

### KQL gotchas in this dataset

When writing a query through the MCP, the KQL caveats in
`docs/cribl-app-skill/skill.md` still apply. The ones that bite
most often:

- **`(?i)` inline regex flag crashes** in complex pipelines. Use
  character-class alternation instead.
- **`foldkeys` output `key`/`value`** columns don't support type
  filtering — use `_raw` regex parsing for field discovery.
- **Wide-column metrics**: each metric is a top-level bracket-quoted
  field (`['postgresql.backends']`), not a `_metric`/`_value` pair.
  See `src/api/queries.ts` for live examples.
- **`| export mode=overwrite to lookup <name>`** is how the app writes
  lookups (see `Q.serviceSummaryPrev` in `src/api/queries.ts`). Not
  `| send`. `| send` is for streaming events into a dataset (see the
  alert-history flow); they serve different purposes.

### Don't write a Bearer-token script for one-off queries

If you find yourself reaching for `fetch` against
`/api/v1/m/default_search/search/jobs`, stop. That path exists because
the in-app code needs it, but for inspection the MCP is faster, less
code, and doesn't require you to remember:

- The job ID lives at `response.items[0].id` (not `response.id`).
- POST body is `{ query, earliest, latest }` at the top level (not
  wrapped in `{ search: { ... } }`).
- Results are NDJSON; line 0 is schema metadata, skip it.

The reference implementation is `@cribl/app-utils/src/search.ts` if
you ever do need it — but reach for the MCP first.

## Mode 2 — Pixels via Playwright

**Only use this when the goal is actually pixels** — a screenshot for
a PR, verifying a visual change, scraping rendered text that isn't
trivially derivable from a query.

### The pattern that works

```ts
import { test, expect } from '@playwright/test';
import { installCriblHostGlobals, gotoApm } from './helpers/apmSession';

test('thing renders', async ({ page }) => {
  await installCriblHostGlobals(page);
  await gotoApm(page, '/some/path');
  await expect(page.getByText('Whatever')).toBeVisible();
});
```

Run: `npx playwright test tests/<file>.spec.ts`. The
`playwright.config.ts` `setup` project runs `tests/auth.setup.ts`
first, which logs in via Auth0 and caches state to
`playwright/.auth/cribl-cloud.json`. Subsequent specs reuse it.

### Storage state expires

Auth0 sessions are **not eternal.** After ~a few days the cached state
stops authenticating silently and the test bounces to login without
errors — the navigation just doesn't reach the app. Symptoms:

- Test fails with `getByText('Cribl APM')` timing out
- Trace shows redirect chain `/app-ui/apm/` → `/apps/a/apm/` →
  `login.cribl-staging.cloud/u/login/identifier`
- The screenshot shows the Cribl Cloud login carousel, not the app

**Fix:** delete the cached state and let setup re-run.

```bash
rm playwright/.auth/cribl-cloud.json
npx playwright test --project=setup     # re-logs in
npx playwright test tests/<spec>.spec.ts # actual spec
```

If setup itself fails, the credentials in `.env` are wrong or
expired — ask the user, don't keep retrying.

### The hidden trap: headless + Auth0 SSO

In headless Chromium the Auth0 silent-refresh iframe sometimes fails
even with seemingly-valid cookies, because third-party cookies are
blocked by default. If you find a Playwright spec consistently
bouncing through Auth0 despite a fresh storage state, **don't try to
hack around the browser auth flow** — switch to Mode 1 if you can.
If you actually need pixels, the running Playwright test suite has
the right context (it works at the test-fixture level even when
ad-hoc browser scripts don't).

### Ad-hoc Playwright scripts (not specs)

If you're writing a one-off Node script with `playwright-core`
instead of using `@playwright/test`, you have to assemble the
host-global init script yourself. The exact code lives in
`tests/helpers/apmSession.ts` — `installCriblHostGlobals(page)`.
**Copy it, don't reimplement from memory.** Three things must be
set via `page.addInitScript` **before navigation**:

1. `window.CRIBL_BASE_PATH` = the app's mount path without trailing slash
2. `window.CRIBL_API_URL`   = `${BASE}/api/v1`
3. A `window.fetch` wrapper that adds `Authorization: Bearer <token>`
   to any same-origin API call.

Per `CLAUDE.md`, these scripts go in `scripts/` and are not
committed unless they become reusable. The repo already has plenty
of one-offs.

## What NOT to do

- **Don't** write a custom Bearer-token Search-API client for an
  ad-hoc inspection. The MCP exists.
- **Don't** try to login by hand via `fetch` to Auth0. PKCE,
  redirects, CSRF state — use the Playwright setup.
- **Don't** assume `/app-ui/apm/` is the live mount path — staging
  rewrites it to `/apps/a/apm/`. Use the test helpers.
- **Don't** start a browser when you just need data. The MCP is
  faster, more reliable, and doesn't depend on transient session
  state.

## When to update this skill

- Cribl changes the login UI → update `tests/auth.setup.ts` selectors
- A new MCP tool becomes useful for inspection → list it under "Tools
  you'll actually use"
- Storage-state TTL guidance changes → update the "expires" section
- Anyone learns a new gotcha that costs >15 minutes to rediscover →
  add it here, not just in a session log
