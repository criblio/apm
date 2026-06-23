# P0.1 Provisioning guard (2026-06-11)

First P0 tripwire from the 2026-06-10 roadmap rewrite (merged as
PR #71). Goal: the provisioner must refuse to push a corrupt plan
instead of reporting success — the June 2026 outage chain shipped
`dataset=""` into 17 saved searches and unjoinable lookup CSVs with
green output at every step.

## What shipped

- **`src/api/provisionGuard.ts`** — pure string validation, no I/O,
  designed to upstream to `@cribl/app-utils` later. Checks per query:
  1. `dataset="…"` clause present and non-empty (`dataset=""` is the
     June outage vector — framework dataset store defaults to `''`).
  2. No `(?i)` inline regex flag upstream of `export to lookup`
     (writes a CSV that reports success but is unjoinable).
  3. No `mv-expand` upstream of `export to lookup` (Cribl planner
     bug fails the `func:store` write stage).
  4. No dangling `to lookup` with an empty lookup name.
- **`scripts/provision.ts`** — runs the guard over the full plan
  (`getProvisioningPlan()` + `SEED_LOOKUPS`) after KV settings load,
  before reconcile (both `--dry` and apply). Violations print and
  `exit 1`. Since `npm run deploy` calls this script, every deploy
  is gated.
- **`src/api/__tests__/provisionGuard.test.ts`** — 15 tests,
  including two integration tests against the *real* plan: it must
  pass with `dataset=otel`, and must fail when the dataset store is
  empty (a literal replay of the June outage).

## Design notes

- The guard strips KQL `//` comment lines before scanning —
  `Q.traceOriginators()` legitimately mentions `(?i)` and
  `mv-expand` in an embedded comment block (queries.ts ~1090) and
  tripped the first version. Real pipeline stages still get caught.
- Checks are positional: `(?i)` / `mv-expand` only fail when they
  appear *before* the `export … to lookup` match, so live queries
  that never export are unaffected.

## Validation

- `npm run lint` (0 errors), `npx tsc --noEmit`, `npm test`
  (122 passed).
- `npm run provision -- --dry` against staging: guard runs and
  prints `▶ Provision guard: plan OK` before the plan fetch.

## Found along the way: staging provisioner auth is broken (401)

`npm run provision -- --dry` fails after the guard with
`GET /m/default_search/search/saved … (401): Unauthorized`.
Diagnosis: the OAuth client-credentials exchange **succeeds** —
token has correct audience, unexpired, scopes
`user:{read,update}:{workergroups,connections,workspaces}` — but
the workspace API rejects it. Same failure on master (pre-dates
this change). Looks like a credential/grant change on the staging
org side; **`npm run deploy` is currently blocked** until the
client grants are fixed or credentials rotated.
