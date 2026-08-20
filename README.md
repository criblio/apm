# Cribl APM

Cribl APM gives you an APM experience — service health, distributed
traces, dependency maps, and AI-driven root-cause investigation — over
OpenTelemetry data landing in Cribl Search. It runs as a sandboxed
[Cribl App Platform](AGENTS.md) app inside your Cribl Cloud workspace.

Cribl APM is a **UI over data you already have** — it doesn't ingest or
store anything. You point it at a Cribl Search dataset that's receiving
OpenTelemetry traces, logs, and metrics.

## Getting started

Four steps from install to your services on screen.

### 1. Land OpenTelemetry data in a Cribl Search dataset

Cribl APM reads from a dataset that already contains OTel data (default
name `otel`). The dataset needs:

- **Spans** — OTel span rows with `end_time_unix_nano` populated
- **Logs** — rows with a `body` field
- **Metrics** — rows where `datatype == "generic_metrics"`

No OTel data flowing yet? The companion repo
[`criblio/otel-demo-criblcloud`](https://github.com/criblio/otel-demo-criblcloud)
stands up the OpenTelemetry Demo and ships it into Cribl Cloud.

### 2. Install the pack

1. Download `apm-<version>.tgz` from the
   [Releases page](https://github.com/criblio/apm/releases).
2. In your Cribl Cloud workspace, upload it via the **Apps** UI.
3. The app appears in your workspace nav at **`/apps/apm`**.

### 3. Point it at your data and provision

Open the app, go to the **Configuration** tab, and:

1. **Workspace → Dataset** — set to the dataset receiving your OTel data
   (default `otel`).
2. **Setup → Scheduled searches** — click **Preview plan**, then
   **Apply**. This creates the cached searches the pages read from.
3. **Setup → Dataset acceleration** — click **Apply** to index the fields
   the queries filter on.

The **Setup status** card at the top of the page turns green once both
provisioning steps are done.

### 4. Open it

Give the scheduled searches a few minutes to run, then open **Overview**
— it fills with your services, golden-signal sparklines, and detected
issues.

Alerting and incidents need no extra setup: the provisioned searches
evaluate every service's health each cadence, firing alerts on
error-rate spikes, latency regressions, traffic drops, and silent
services — and related alerts collapse automatically into **Incidents**,
the unit you drill into from the Alerts page.

### 5. (Optional) Turn on server-side investigations

With an investigator cell deployed, every fired alert gets an
autonomous AI investigation — root cause, evidence, and remediation,
written back to the incident. See
**[docs/server-side-investigations.md](docs/server-side-investigations.md)**
for setup; without it, everything above still works and the
**Investigate** page runs interactively in your browser session.

## What you get

- **Overview** — system health at a glance: detected issues, golden
  signals, services needing attention.
- **Services / Service Detail** — the health catalog and per-service
  RED charts, top operations, instances, and spotlight diffs.
- **Service Map** — force-directed service dependency graph (RPC +
  messaging edges).
- **Traces** — Jaeger-style trace search; full waterfall span detail;
  structural diff between two traces (Compare).
- **Logs / Metrics** — log search scoped to your services; metric
  discovery and charting over the wide-column store.
- **Alerts & Incidents** — server-evaluated alerts (error rate,
  latency regression, traffic drop, silent service) rolling up into
  incidents; each incident has a warroom page with the summary
  narrative, AI investigation findings, member services, and a
  timeline humans annotate directly (notes, status, severity,
  close/reopen).
- **Errors** — error-class rollup with noise filtering.
- **Investigate** — the AI investigator: seed a symptom (or launch
  from an alert or incident) and it walks the data — and optionally
  the service's source code — to a root cause. Runs server-side when
  the [investigator cell](docs/server-side-investigations.md) is
  deployed, in-browser otherwise.

## Notes

- **Shareable URLs**: the host router flattens externally-pasted deep
  links (e.g. `/apps/apm/trace/abc`) to the default page. Navigate inside
  the app instead — tabs, clicks, and back/forward all work.

## Developing

Building or contributing to Cribl APM? See
**[docs/development.md](docs/development.md)** for the local dev loop,
architecture, deploy-from-source, and project layout — plus
[AGENTS.md](AGENTS.md) (platform reference) and [CLAUDE.md](CLAUDE.md)
(repo conventions).
