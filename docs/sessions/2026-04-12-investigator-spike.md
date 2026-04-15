# Session: Copilot Investigator API Spike (2026-04-12)

## Goals
1. Clean up ROADMAP.md — move done items below, reorder priorities
2. Spike the Copilot Investigator: capture API traffic, validate it
   finds a payment failure, document how to embed it in our app

## What We Did

### Roadmap cleanup
- Reorganized ROADMAP.md: done items (Metrics, Durable baselines,
  Panel caching, Core APM surfaces) moved to "Completed" section
- Promoted AI-powered investigations to priority #1
- Renumbered remaining priorities (alerts → #2, SLOs → #3, etc.)

### Investigator spike
- Turned on `paymentFailure 50%` via flagd
- Navigated to `/search/agent` (Copilot Investigation page)
- Captured full API traffic for the investigation flow
- Documented the streaming NDJSON protocol, tool definitions,
  and conversation loop in `docs/research/copilot-investigator.md`
- Observed the investigation find the payment failure (50.91% error
  rate on pod payment-786d4cc9bd-k56jj) but it took ~10 minutes
  and 8+ queries due to missing context

### Key API findings
- Core endpoint: `POST /api/v1/ai/q/agents/local_search`
- Standard agentic tool-use loop over streaming NDJSON
- 14 tools available including `run_search`, `get_dataset_context`,
  `sample_events`, `fetch_local_context` (RAG for KQL docs),
  `present_investigation_summary`, `edit_notebook`
- Query approval UI: `confirmBeforeRunning` flag on `run_search`
- Feature flags: `GET /api/v1/ai/settings/features` returns
  `{agentic_search: true, web_search: true, schematizer: true}`

### Why the investigation was slow
1. **5MB field stats** for the otel dataset (5908 fields)
2. **KQL dialect confusion** — tried standard Kusto syntax first
3. **No field mapping** — had to discover that service.name lives
   in `resource.attributes['service.name']` via trial-and-error
4. **Regex extraction from _raw** — fell back to parsing JSON fields
   because it didn't know the data was pre-parsed
5. **No topology context** — didn't know checkout calls payment

### Context we should pre-fill
- Dataset description (OTel, pre-parsed JSON)
- Field mappings (from our query layer — proven patterns)
- Service topology (from System Architecture)
- Current anomaly state (from our anomaly detector)
- KQL dialect notes (summarize not stats, bracket-quoted fields)

## Files Changed
- `ROADMAP.md` — reorganized, Investigator promoted to #1
- `docs/research/copilot-investigator.md` — full API documentation
- `docs/research/investigator-spike/` — screenshots and API captures
- `scripts/investigator-spike.js` — browser automation for the spike

### A/B comparison: bare vs context-enriched

Ran the same investigation twice with `paymentFailure 50%` active:

| Dimension | Bare (no context) | Enriched (APM context) |
|---|---|---|
| Completed? | No (timed out) | Yes (472s) |
| Failed queries | 4+ | 2 |
| Used regex on _raw | Yes | No |
| Time to first result | ~78s | ~52s |
| Found root cause | Partially | Yes (ECONNREFUSED 10.96.141.153:8013) |

**Hypothesis confirmed**: pre-filling field mappings, topology, and
KQL patterns eliminates the discovery phase. The enriched run found
a deeper root cause (outbound TCP connection refused) that the bare
run never reached.

Full comparison in `docs/research/copilot-investigator.md`.

## Next Steps
- Add `ai/q/agents/*` to `config/proxies.yml` path allowlist
- Build streaming NDJSON client in the app
- Build chat UI with query approval cards
- Pre-fill context from our existing query layer + topology data
- Add "Investigate" buttons throughout the app
- Consider skipping `get_dataset_context` tool and auto-approving queries
- Pre-fill anomaly hypothesis from our detector for even faster results
