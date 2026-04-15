# Copilot Investigator — API Spike (2026-04-12)

## Summary

Cribl Search ships a "Copilot Investigation" feature at `/search/agent`.
It's a chat-based AI agent that runs search queries, reads dataset
schemas, and produces structured investigation reports. The goal of
this spike was to understand its API surface so we can embed it inside
the Cribl APM app.

## UI Surface

- Page: `/search/agent` (linked from Search left nav as "Run Investigation")
- Chat input: textarea with "Help me with..." placeholder
- Quick-start tiles: "Start a new investigation", "Explore my data",
  "Resume a prior investigation" (coming soon)
- "Deep Investigation Mode" toggle (Beta) — parallel hypothesis evaluation
- Query approval: each `run_search` tool call shows a "Run Query" /
  "Skip" / "Ask Every Time" approval card

## Core API Endpoint

```
POST /api/v1/ai/q/agents/local_search
```

### Request Shape

```json
{
  "messages": [
    { "id": "uuid", "role": "user", "content": "...", "reqId": 0 },
    { "id": "uuid", "role": "assistant", "content": "...",
      "tool_calls": [{ "id": "call_xxx", "function": { "name": "...", "arguments": "..." } }] },
    { "role": "tool", "tool_call_id": "call_xxx", "content": "..." }
  ],
  "stream": true,
  "sessionId": "uuid",
  "context": {
    "resources": {
      "availableDatasets": [
        { "id": "otel", "description": "..." },
        ...
      ]
    }
  },
  "tools": [ ...tool definitions... ]
}
```

### Response Format

Streaming NDJSON. Each line is one of:

1. **Text token**: `{"name":"agent:local_search","role":"assistant","content":"word"}`
2. **Tool call**: `{"name":"agent:local_search","role":"assistant","content":null,"tool_calls":[...]}`
3. **Tool result** (inline): `{"role":"tool","content":"..."}`
4. **Notification**: `{"notificationMessageType":"loadingMessage","toolName":"fetch_local_context","content":["Retrieving relevant documentation"]}`

### Conversation Loop

Standard agentic tool-use loop:
1. Client sends messages → server streams assistant response
2. If response contains `tool_calls`, client executes each tool
3. Client appends assistant message + tool results to messages array
4. Client sends updated messages → server continues
5. Repeat until agent calls `present_investigation_summary` or `edit_notebook`

## Available Tools

| Tool | Purpose | Client-side? |
|---|---|---|
| `run_search` | Execute KQL query (with approval UI) | Client runs search job via `/search/jobs` |
| `get_dataset_context` | Fetch field stats for datasets | Client calls `/search/datasets/{id}/fieldStats` |
| `sample_events` | Get 5 raw events from datasets | Client-side |
| `fetch_local_context` | RAG retrieval of KQL syntax docs | Server-side |
| `get_lookup_content_sample` | Read lookup table sample | Client-side |
| `update_context` | Set key/value in session context | Client-side |
| `clickable_suggestion_button` | Render suggestion buttons | UI-only |
| `display_incident_overview` | Structured incident card | UI-only |
| `present_investigation_summary` | Final findings + conclusion | UI-only |
| `edit_notebook` | Save to Cribl Search notebook | Client-side |
| `show_exit` | End session UI | UI-only |
| `select_alert` | Pick an alert to investigate | UI-only |
| `selectFirehydrantIncident` | Firehydrant integration | Client-side |
| `get_jira_context` | Jira issue lookup | Client-side |
| `get_bitbucket_context` | Bitbucket PR lookup | Client-side |

### `run_search` tool schema

```json
{
  "query": "KQL query",
  "earliest": "-15m",
  "latest": "now",
  "limit": 100,
  "description": "Human-readable description",
  "confirmBeforeRunning": true
}
```

When `confirmBeforeRunning` is true, the UI shows the query with
"Run Query" / "Skip" buttons. The client executes via the standard
search jobs API (`POST /search/jobs`, poll `/search/jobs/{id}/status`).

## Supporting Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/ai/event` | Analytics event (tracks conversation, user query, surface) |
| `GET /api/v1/ai/consent/` | Check AI consent status |
| `GET /api/v1/ai/settings/disabled` | Check if AI features are disabled |
| `GET /api/v1/ai/settings/features` | Feature flags (returns `{agentic_search, web_search, schematizer, ...}`) |
| `GET /search/datasets/{id}/fieldStats` | Dataset schema (field names, types, cardinality) |

## Observations from the Payment Failure Spike

### What Worked
- The agent correctly identified the payment service failure (50.91% error rate)
- It traced error propagation: payment → checkout → frontend → frontend-proxy
- Duration analysis distinguished immediate failures from timeouts
- It found our `criblapm_op_baselines` lookup table and sampled it

### What Didn't Work Well
- **5MB field stats** download for the otel dataset (5908 fields) — massive context
- **KQL dialect confusion**: tried standard Kusto `stats`/`summarize` first, had to
  retry with Cribl KQL `summarize`/`timestats` syntax via `fetch_local_context`
- **Field flattening gap**: service.name and rpc.* fields weren't at top level for
  recent data, forcing expensive regex extraction from `_raw`
- **Multiple failed queries** before finding working patterns
- **Timeout on streaming**: long AI processing after ingesting 5MB schema
- Total time: ~10 minutes for what should be a 1-minute investigation

## Context We Should Pre-fill When Embedding in Our App

To make investigations fast when launched from Cribl APM:

### 1. Dataset Description
```
The "otel" dataset contains OpenTelemetry traces, logs, and metrics
ingested from an OTel Collector. Records are pre-parsed JSON — do NOT
use regex extraction on _raw. Use the structured fields directly.
```

### 2. Field Mapping (from our query layer)
```
Service name: tostring(resource.attributes['service.name'])
Span timing: start_time_unix_nano, end_time_unix_nano
Duration: (toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0 (microseconds)
Error: status.code == "2" (string, not int)
Status message: status.message
Span kind: kind (1=SERVER, 2=CLIENT, 3=PRODUCER, 4=CONSUMER)
Operation: name
RPC method: tostring(attributes['rpc.method'])
RPC service: tostring(attributes['rpc.service'])
gRPC status: tostring(attributes['rpc.grpc.status_code'])
Exception type: events[].attributes['exception.type']
Parent span: parent_span_id (empty string = root)
Trace ID: trace_id
Span ID: span_id
```

### 3. Service Topology (from System Architecture)
```
Services: frontend-proxy → frontend → {checkout, cart, product-catalog,
  recommendation, ad, currency, shipping, email, payment, flagd,
  image-provider, product-reviews, quote, accounting}
checkout → payment (gRPC oteldemo.PaymentService/Charge)
checkout → cart, product-catalog, currency, shipping, email
Messaging: kafka (cart → kafka → accounting, checkout → kafka → ...)
```

### 4. KQL Dialect Notes
```
- Use `summarize` not `stats`
- Use `timestats` for time-bucketed aggregation
- Use `extend` for computed columns
- Use `tostring()`, `toint()`, `toreal()` for type conversion
- Bracket-quote nested fields: ["resource.attributes.service.name"]
  or use tostring(resource.attributes['service.name'])
- `sort by field desc` (not `order by`)
- `countif(predicate)` works inside summarize
```

### 5. Current Anomalies (from our baselines)
Pre-fill with the services/operations currently flagged as anomalous by
our anomaly detector, so the agent starts with the right hypothesis.

## Integration Plan for Cribl APM

### API approach
The `/api/v1/ai/q/agents/local_search` endpoint is a standard
Cribl Search API — our app's fetch proxy should route to it the same
way it routes to `/search/jobs`. We need to:

1. Add `ai/q/agents/*` to `config/proxies.yml` path allowlist
2. Build a streaming NDJSON client in the app
3. Implement client-side tool execution (run_search → our existing
   search job runner; get_dataset_context → fieldStats API)
4. Build the chat UI with query approval cards
5. Pre-fill the `context` and initial `messages` with APM-specific
   context (see above)

### Integration points
- **"Investigate" button on Home catalog rows**: pre-fill with service
  name, current health status, anomaly details
- **"Investigate" on System Architecture edges**: pre-fill with source →
  target dependency, error rate, latency
- **"Investigate" on Service Detail**: pre-fill with service name,
  top erroring operations, recent errors
- **"Investigate" on traces**: pre-fill with trace ID, error spans
- **Standalone page**: free-form investigation with APM context

### Differentiation from native Copilot
Our version would be much faster because we pre-fill:
- Correct field mappings (no trial-and-error on nested fields)
- Service topology (agent knows the dependency graph upfront)
- Current anomaly state (agent starts with the right hypothesis)
- KQL examples from our own query layer (proven-working patterns)

---

## A/B Comparison: Bare vs Context-Enriched Investigation

Both runs investigated the same scenario: `paymentFailure` flag set
to 50%, causing the payment service's gRPC Charge operation to fail
roughly half the time.

### Run 1: Bare prompt (no context)

**Prompt**: "In my 'otel' dataset I have OpenTelemetry spans. The
payment service is experiencing high error rates on its gRPC Charge
operation in the last 15 minutes. Investigate what is happening."

| Metric | Value |
|---|---|
| Total time | >10 min (timed out, never completed) |
| Search queries run | 8+ (many failed) |
| Agent API round-trips | ~10+ |
| Failed queries | 4+ (KQL syntax errors, wrong field paths) |
| First successful data query | ~78s |
| Time to find error rate | ~5 min |
| Found root cause? | Partially (error rate + pod, no ECONNREFUSED) |

**Problems encountered:**
1. Downloaded 5MB field stats (5908 fields) — huge context window cost
2. Tried standard Kusto `stats` — failed, had to RAG-fetch KQL docs
3. Used `regex extraction from _raw` — expensive, fragile, unnecessary
4. Didn't know `service.name` was nested under `resource.attributes`
5. Didn't know `status.code` is a string `"2"`, not int
6. Multiple query retries before finding working patterns
7. Never identified the ECONNREFUSED root cause signal

### Run 2: Context-enriched prompt (APM context pre-filled)

**Prompt**: Same question, but prefixed with ~3.9KB of context:
dataset description, field mappings, KQL dialect notes, service
topology, and example working queries from our query layer.

| Metric | Value |
|---|---|
| Total time | **472s (~8 min)** |
| Search queries run | **10** (2 failed — 400 errors on complex queries) |
| Agent API round-trips | **19** |
| Failed queries | **2** (query syntax edge cases, not field discovery) |
| First successful data query | **~52s** |
| Time to find error rate | **~56s** (first query!) |
| Found root cause? | **Yes — ECONNREFUSED 10.96.141.153:8013** |

**What went right:**
1. **First query succeeded** — used correct field mappings from context
2. **No regex extraction** — used structured fields throughout
3. **No KQL syntax confusion** — used `summarize`/`extend`/`sort by`
   correctly from the start
4. **Skipped field stats download** — still fetched it (agent decided
   to), but didn't need it for query construction
5. **Found deeper root cause** — traced to `tcp.connect` ECONNREFUSED,
   identified the specific IP:port (10.96.141.153:8013)
6. **Structured findings** — produced a clean "What We Found" summary
   with error scope, instrumentation mismatch analysis, concrete
   failure signal, and caller perspective

### Findings summary from the enriched run

> **Root Cause**: The high Charge error rate is isolated to payment pod
> `payment-786d4cc9bd-k56jj` (v2.2.0) and aligns with an outbound
> connection failure from payment (`connect ECONNREFUSED
> 10.96.141.153:8013`). Checkout observes these as gRPC UNKNOWN errors,
> while payment's server handler span `name="charge"` shows 0
> errors — suggesting the failure happens before the handler span
> records a gRPC status.

### Analysis

The context-enriched run was dramatically better on every dimension:

| Dimension | Bare | Enriched | Improvement |
|---|---|---|---|
| Time to first useful result | ~78s | ~52s | 1.5× faster |
| Total failed queries | 4+ | 2 | 50% fewer |
| Found root cause | No | Yes (ECONNREFUSED) | qualitative leap |
| Used regex on _raw | Yes (all queries) | No | correct approach |
| Completed investigation | No (timed out) | Yes | — |

**The hypothesis is confirmed**: pre-filling APM context (field
mappings, topology, KQL patterns) eliminates the discovery phase
that consumed most of the bare run, and produces materially deeper
findings. The remaining time is dominated by the agentic loop
latency (streaming responses, query approval clicks, search
execution) — not by the agent being confused about the data.

### What could still improve

1. **Skip `get_dataset_context`** — the agent still called it even
   with context pre-filled. We could either: (a) not include the
   tool in the tools array, or (b) pre-fill the context key so the
   agent sees it's already populated
2. **Auto-approve queries** — each "Run Query" approval added ~3-5s
   of latency. For an embedded APM investigation launched from a
   specific context (e.g., "Investigate this service"), auto-approve
   makes sense
3. **Pre-fill anomaly hypothesis** — instead of "investigate the
   payment service", say "the payment service error rate jumped from
   2% to 49% in the last 5 minutes, concentrated on the Charge
   operation; here are the specific anomaly signals from our
   detector". This would skip the first 2-3 queries entirely
4. **Provide the dependency graph as structured data** — the topology
   context helped the agent reason about error propagation
   (checkout → payment), but it could be even more effective as a
   machine-readable adjacency list with current error rates per edge
