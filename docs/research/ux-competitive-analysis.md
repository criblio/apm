# UX Competitive Analysis: Navigation & View Architecture

Research date: 2026-04-26. Covers Datadog, New Relic, Dynatrace,
and Grafana.

## How the competition organizes their UI

### Datadog

**Navigation**: Left sidebar organized by product area. Top-level
sections: Infrastructure, APM, Data, Logs, Digital Experience,
Software Delivery, Security, Service Management, AI. Each section
expands to show sub-features. Quick nav (Cmd+K) for search.

**APM section expands to**: Service Catalog, Service Map, Traces,
Error Tracking, Continuous Profiler, Dynamic Instrumentation, LLM
Observability.

**Service Page** (accessed by clicking a service) has:
- Health status banner (critical/warn/ok from monitors + Watchdog)
- Summary cards: deployments, errors, SLOs, incidents, security
- 4 core charts: requests+errors, errors detail, latency, avg
  time per request
- Resources table (endpoints/operations with RED metrics)
- **Tabs**: Dependencies, Deployments, Error Tracking, Security,
  Databases, Infrastructure, Runtime, Profiling, Memory Leaks,
  **Traces**, **Log Patterns**, Costs

Key insight: the Service Page is a **rich multi-tab experience**
where you can explore traces, logs, errors, and dependencies
without leaving the service context.

**Service Map**: force-directed graph with health-colored borders,
animated traffic lines on hover, click-to-inspect with sequential
dependency exploration. Groupable by team or application.

### New Relic

**Navigation**: Fully customizable left sidebar. Users pin/unpin
capabilities. Default groupings include APM & Services, Browser,
Infrastructure, Logs, Alerts, Dashboards, Distributed Tracing.

**Per-service sidebar** (when viewing a specific APM service):
- Summary (landing page with Apdex, throughput, errors, logs,
  distributed tracing, infrastructure)
- **Triage**: Errors Inbox, Issues, Vulnerabilities
- **Monitor**: Distributed tracing, External services, Databases,
  Service map, Dependencies
- **Activity**: Deployments, Events
- **Recommendations center**: AI-driven gap analysis

**Summary page** has: issues tile, last deployment tile, service
levels tile, vulnerabilities tile. Then Apdex, web transactions
chart, throughput, error rate. Below: logs summary, distributed
tracing view, infrastructure table.

**Errors Inbox**: cross-stack error aggregation (APM + browser +
mobile + serverless). Groups related errors. Shows stack traces,
logs-in-context, and attributes. Triage directly from the view.
Slack integration for real-time notifications.

**Recommendations Center**: AI-powered analysis that identifies
gaps in instrumentation, alert coverage, and agent configuration.
Actionable suggestions to reduce MTTD and MTTR.

### Dynatrace

**Navigation**: "The Dock" — expandable/collapsible left panel
with pinnable apps. CTRL+K for global search. Middle section
shows pinned + recent apps. Collapsible to icon-only mode.

**App navigation pattern**: Primary navigation as horizontal tabs
in the app header. Secondary navigation for subordinate pages.
Breadcrumbs for deeply nested structures. Recommends 6-8 pages
max for flat hierarchies.

**Design principles**: Communicate app purpose immediately on
home page. Consistent patterns for predictable navigation. Clear
content differentiation across pages. Orientation mechanisms
(breadcrumbs, tabs) appropriate to hierarchy depth.

**Davis AI**: Automated root cause analysis — tells you what's
wrong rather than making you hunt for it.

### Grafana

**Navigation**: Left sidebar with Explore, Service Graph, Traces,
Alerting. Signal-first approach — start from Explore and pick
your data source.

**Trace views**: Trace Search (TraceQL or UI), Service Graph
(RED metrics table + node graph), Traces Drilldown app.

**Cross-signal integration**: Extract trace IDs from logs, link
from error spans to Loki logs, correlate span attributes to
Prometheus metrics. Tight traces ↔ logs ↔ metrics linkage.

## What we're doing wrong

### 1. Horizontal top nav with dropdowns

Every competitor uses a left sidebar. Our horizontal nav:
- Runs out of space (forced us into dropdowns)
- Hides primary surfaces (Traces, Logs, Metrics behind "Signals")
- Feels like a website, not an app
- Can't accommodate growth (new features = more cramming)

### 2. Home page tries to be everything

Our Home crams 6 panels into one scroll: detected issues + system
arch + service table + anomalies + slow traces + error classes.
Competitors split these into focused views:
- Overview = just the health summary
- Service Catalog = dedicated table
- Service Map = dedicated graph

### 3. Service Detail is a dead end

Our Service Detail shows charts and tables but you can't pivot to
traces, logs, or errors for that service without going to a
separate top-level page. Competitors make the service page a
**hub** with tabs for Traces, Logs, Errors, Dependencies.

### 4. No Errors Inbox

We have "Error classes" as a panel on the Home page. Every
competitor has a dedicated Errors surface:
- Datadog: Error Tracking (per-service + global)
- New Relic: Errors Inbox (cross-stack, triage, Slack integration)
- Sentry: entire product built around error grouping

### 5. Signals buried behind dropdown

Traces, Logs, Metrics are the three pillars of observability.
Hiding them behind a "Signals" dropdown makes them feel secondary.
Every competitor puts them at the top level.

### 6. No deployment tracking

No deployment markers on charts. Competitors show version
boundaries and can attribute error rate changes to specific
deploys.

### 7. No recommendations / health scoring

New Relic's Recommendations Center and Datadog's Watchdog provide
proactive guidance. We have Copilot Investigator (reactive) but
nothing proactive.

## What we should build

### Navigation (left sidebar with collapsible icons)

```
┌─────────────────────────────┐
│ 🔍 Search (Cmd+K)          │
│                             │
│ ◉  Overview                │
│ 📋 Services                │
│ 🗺️  Service Map            │
│ ─────────────────           │
│ 🔍 Traces                  │
│ 📝 Logs                    │
│ 📊 Metrics                 │
│ ─────────────────           │
│ 🔴 Alerts                  │
│ ❌ Errors                  │
│ ─────────────────           │
│ 🤖 Investigate             │
│ ⚙️  Settings               │
└─────────────────────────────┘
```

Collapsible to icon-only mode. Persistent across all views.
Active item highlighted. No dropdowns needed — 10 items fit
comfortably in a vertical sidebar.

### Overview (replace Home)

Focused dashboard answering "is anything wrong right now?":
1. Detected Issues panel (compact)
2. Key metrics row: total services, req/min, global error rate, p95
3. Miniature service health table (only services with issues)
4. Recent alert events (last 5 transitions)

NOT: system architecture graph (that's Service Map), NOT full
service catalog (that's Services), NOT slow traces/error classes
(those are in Traces and Errors).

### Services (catalog)

The current service table — rate, errors, p50/p95/p99, sparklines,
delta chips, investigate buttons. Full-page, sortable, filterable.
This is the existing ServicesListPage, promoted to top-level.

### Service Map

The current System Architecture graph — force-directed/isometric,
edge health, ghost nodes. Full-page with pan/zoom. This is the
existing SystemArchPage.

### Service Detail (rich multi-tab hub)

When you click a service from Services, Service Map, or Alerts:

**Tabs**:
- **Overview**: RED charts, summary stats, top operations,
  instances (current layout)
- **Traces**: filtered trace search scoped to this service
- **Logs**: filtered log search scoped to this service
- **Errors**: error classes for this service (promoted from panel)
- **Metrics**: service-specific metric cards
- **Dependencies**: upstream/downstream with edge health
- **Alerts**: alert history for this service

### Traces (top-level)

Current Search page — trace search with service/operation/tags
filters, results table, drill to trace detail. Later: faceted
exploration (roadmap item 6).

### Logs (top-level)

Current Logs page — log search with severity/service filters,
facet sidebar.

### Metrics (top-level)

Current Metrics page — metric picker, group-by, chart.

### Alerts (top-level)

Current Alerts page — active alerts, all services, history.

### Errors (new, top-level)

Promoted from the "Error classes" panel. Shows:
- Error groups: (service, operation, exception type, message)
- First seen / last seen / count sparkline
- State: new / acknowledged / resolved
- Sample traces + logs per error group
- Click to see full stack trace + trace detail

This is ROADMAP item 4 (Error tracking / Errors Inbox), elevated
to a higher priority because every competitor has it.

### Investigate

Current Copilot page — unchanged.

### Settings

Current Settings page — dataset, noise filters, cadence,
notification targets, provisioning.

## View composition principles

1. **One job per view** — Overview shows health, Services shows the
   catalog, Service Map shows topology. Don't mix them.
2. **Load order matches display order** — panels render top-to-bottom
   as their data arrives. No skeleton flash for already-loaded data.
3. **Service Detail is a hub, not a dead end** — tabs let you explore
   traces, logs, errors, dependencies without leaving the service.
4. **Cross-linking everywhere** — click a service in Alerts → goes to
   Service Detail. Click an error → goes to trace detail. Click a
   trace → goes to Trace view.
5. **Consistent time range** — shared across all views via URL param.
