# Server-side investigations

Cribl APM can investigate alerts **autonomously**: when an alert
fires, an agent runs on a server-side "investigator cell", walks the
telemetry with real KQL/PromQL queries (and optionally the service's
source code), and writes its root-cause conclusion back where the app
— and the incident it belongs to — can show it.

This document covers what it is, how the pieces fit, how to turn it
on, and how to operate it. Design history lives in
`docs/research/server-investigations/` (start with `design.md`).

## The short version

- **Off by default.** Everything in the app — alerts, incidents, the
  warroom — works without it. The investigator is enrichment.
- **One flag**: `serverInvestigations` (Configuration → Workspace).
  Provisioning with the flag on creates the trigger machinery; off
  deletes it, and the cell goes quiet by construction.
- **One deployable**: the "cell" — a small celld/worker app in
  `cell/` that hosts the agent loop. The app never blocks on it.

## Architecture

```
alert evaluator (scheduled search, every 5m)
      │  commits firing/resolved events to the dataset
      ▼
criblapm__alert_notify (scheduled search, flag-gated)
      │  selects firing events; results land in $vt_results
      │
      ├─ push: webhook notification → POST cell /alerts/fire
      │        (primary once Cribl notification dispatch works)
      └─ pull: the cell's CoordinatorDO polls the search's cached
               results every 5 minutes (durable alarm — the backstop,
               and currently the workhorse; see "Trigger delivery")
      ▼
CoordinatorDO  — exactly-once admission (dedup on the alert event id),
      │          queue + concurrency cap (1 autonomous at a time),
      │          per-hour runaway cap (10)
      ▼
InvestigationDO — the agent loop: seeded from the alert, runs
      │           read-only KQL/PromQL through the same query builders
      │           the app uses, renders traces, optionally checks out
      │           the implicated service's source (Configuration →
      │           Source repos), concludes with a root-cause summary
      ▼
dataset — `record_kind:'investigation'` lifecycle events
          (started / investigated / investigation_failed) with a
          conclusion snippet; the full transcript stays on the cell
```

**Read surfaces:** the Alerts page shows Investigating/Investigated
badges; the incident page correlates runs via the cell's index and
shows conclusions inline (with links to the full transcript at
Investigate → replay); the Investigate page lists every run in its
recall sidebar and supports interactive follow-up questions — the
human guides the agent mid-investigation.

## Setup

### 1. Deploy the cell

The cell lives in `cell/` (a celld/Workers-style app; see
`cell/README.md` and `cell/infra/` for the Terraform that hosts it).
It needs these environment variables:

| Var | Purpose |
|---|---|
| `WEBHOOK_BEARER` | Bearer for `POST /alerts/fire` (the trigger) |
| `UI_BEARER` | Bearer for the app's proxied UI calls |
| `TICKET_SECRET` | HMAC key for WebSocket tickets |
| `CRIBL_BASE_URL` / `CRIBL_CLIENT_ID` / `CRIBL_CLIENT_SECRET` | Machine credentials for search jobs + event commits |
| `CRIBL_DATASET` | Telemetry dataset (default `otel`) |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | OpenAI-compatible endpoint for the agent |
| `REPOS_JSON` | Optional default source repos for code investigation |
| `DISABLED` | `"true"` = per-node kill switch (acknowledge & drop) |

### 2. Configure the app

In `.env` (for `npm run deploy` / `scripts/provision.ts`):

```
CELL_URL=https://<your-cell-host>
CELL_WEBHOOK_BEARER=<matches the cell's WEBHOOK_BEARER>
CELL_UI_BEARER=<matches the cell's UI_BEARER>
CELL_REPOS_JSON=[{"url":"github.com/org/repo","service":"*"}]
```

Turn on **Configuration → Workspace → Server investigations** in the
app (or set the flag before provisioning). Then provision: the
reconciler creates the `criblapm__alert_notify` search, the webhook
notification target + binding, and pushes the default source repos to
the cell (`POST /config/repos`).

### 3. Verify

- `GET <cell>/healthz` → `{"ok":true,"disabled":false}`.
- Any authed request to the coordinator (the provisioner's
  `/config/repos` push counts) arms the poll alarm.
- Fire a fault (see `FAILURE-SCENARIOS.md`); within ~5–10 minutes of
  the alert firing, `GET <cell>/investigations` (UI bearer) shows an
  `autonomous` row, the Alerts page shows the badge, and the incident
  page lists the run with its conclusion once it concludes.

## Trigger delivery: push and pull

The notify search's **results** are the contract. Two deliveries:

- **Push** — the search's webhook notification POSTs the rows to
  `/alerts/fire`. This is the intended primary. (As of 2026-08-20,
  Cribl saved-search notification dispatch is broken workspace-wide
  on staging — platform bug filed — so push delivers nothing.)
- **Pull** — the CoordinatorDO's durable alarm reads the notify
  search's cached `$vt_results` every 5 minutes. Because it reads the
  search's results rather than the dataset, the flag gate holds: flag
  off ⇒ the search doesn't exist ⇒ the poll is a no-op.

Both paths feed the same admission: the alert event's `event_id` is a
UNIQUE column, so duplicated delivery (push + pull, retries,
overlapping windows) collapses to one investigation.

## Incidents integration

Investigations attach to incidents by **service + time correlation**
today (the incident page queries the cell's index; interactive runs
carry their service in `incident_key` as `svc:interactive`).
P4.4 Phase 4 makes the link first-class: the coordinator will consult
the incident grouping at admission (attach-vs-spawn coalescing) and
stamp `incident_id` on investigation events.

Humans can also link explicitly: launching **Investigate** from an
incident page seeds the agent with the incident's context (members in
first-fired order, derived root, age-scoped time window) and commits
an `investigation_linked` event to the incident's timeline.

## Operations

- **Kill switches**, most-local first: cell env `DISABLED=true`
  (acknowledge-and-drop), app flag off + re-provision (removes the
  trigger machinery), delete the notify search.
- **Cost/storm caps**: 1 concurrent autonomous run, 10 admissions per
  hour, per-run turn caps, orphan reclaim after 20 minutes.
- **Secrets rotation**: the webhook target's token must equal the
  cell's `WEBHOOK_BEARER`; re-provision after rotating either side.
- **Transcripts** live on the cell (SQLite per investigation); the
  dataset only carries lifecycle events + a ≤1KB conclusion snippet.
- **The cell can be down** — incidents, alerts, and the warroom don't
  depend on it; the UI's investigation surfaces degrade to empty.

## Troubleshooting

| Symptom | Check |
|---|---|
| No autonomous runs after an alert fires | Is the cell deployed with this release's coordinator (poll trigger)? Did anything arm the alarm (any coordinator request)? `criblapm__alert_notify` exists and has rows in `$vt_results`? Cell creds valid (celld logs show the poll's search jobs every 5m)? |
| `401` from `/alerts/fire` | `CELL_WEBHOOK_BEARER` mismatch — re-align and re-provision |
| Runs exist but the incident page shows none | The runs may be interactive with no service context (pre-0.14.0 cell), or their service isn't a member of that incident |
| Everything quiet, flag on | The notification-dispatch platform bug affects push only; verify the pull path via celld logs. `DISABLED=true` on the cell drops triggers silently by design |
