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

Give the scheduled searches a few minutes to run, then open **Home** — it
fills with your services, golden-signal sparklines, and the slowest and
most error-prone traces.

## What you get

- **Home** — multi-service health board with golden-signal sparklines and
  top slow / error trace classes.
- **Search** — Jaeger-style trace search by service, operation, and time.
- **Trace detail** — full waterfall span tree with per-span detail.
- **System Architecture** — force-directed service dependency graph.
- **Compare** — structural diff between two traces.
- **Investigate** — embedded Cribl Copilot: seed a symptom and it walks
  the data to surface a root cause.

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
