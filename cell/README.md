# apm-investigator-cell

Server-side investigator for Cribl APM: a Worker + Durable Objects
bundle that runs on [celld](https://github.com/denoland/celld)
(self-hosted, portable to Cloudflare). When an alert fires, the cell
runs an autonomous investigation and streams the transcript to the
APM UI. Design and PR sequence:
`docs/research/server-investigations/design.md`.

**Status: real agent loop (PR 7).** With LLM + Cribl config set the
cell runs the actual investigation: pi-ai streaming against an
OpenAI-compatible endpoint, the app's shared tool executors
(run_search / run_metrics_query / render_trace /
present_investigation_summary) against the Cribl API, the same
seed + preflight the browser Investigator builds, and
started/investigated lifecycle events committed to the dataset.
Without LLM config the stub agent from the PR 6 scaffold runs, so
the configless smoke keeps working.

This directory is excluded from the packaged app (`files` in the
app's package.json packaging config does not include it; the
pinned-manifest work in PR 5 adds an explicit archive assertion).

## Architecture (scaffold)

- `src/index.ts` — router. Bearer auth on everything except
  `/healthz` and the ticket-authed WS upgrade. Auth is closed by
  default: a missing secret rejects, never allows.
- `src/coordinatorDO.ts` — singleton. Dedupes on the alert event's
  stable `event_id` (UNIQUE), queues, enforces concurrency (1) and a
  per-hour cap (10), serves the index.
- `src/investigationDO.ts` — one DO per investigation. **The agent
  loop is alarm-driven: one turn per `alarm()` invocation** —
  required by celld's 300s handler budget, and it gives per-turn
  durability + automatic resume on another node (verified in the S2
  spike). Transcript = append-only rows with monotonic `seq`; WS
  fanout + `?since=N` replay; poll fallback reads the same rows.
- `src/stubAgent.ts` — canned turns with shape-faithful `ui`
  payloads (RunSearchUi / SummaryUi mirrors). Replaced in PR 7.
- `src/tickets.ts` — 60s HMAC tickets for WS auth (the iframe can't
  put a header on a WS upgrade; it fetches a ticket over the
  proxied HTTPS route first).
- `src/protocol.ts` — the wire protocol (`ServerFrame`,
  `WireLoopEvent` mirroring the framework's `LoopEvent` union).

## Run locally

```bash
# 1. S3-compatible bucket (MinIO shown; any S3 works)
docker run -d --name celld-minio -p 127.0.0.1:9000:9000 \
  -e MINIO_ROOT_USER=admin -e MINIO_ROOT_PASSWORD=adminadmin \
  quay.io/minio/minio server /data
curl -s -X PUT --user admin:adminadmin \
  --aws-sigv4 "aws:amz:us-east-1:s3" http://127.0.0.1:9000/apm-cell

# 2. Deploy the cell (celld bundles with esbuild; point CELLD_ESBUILD
#    at any esbuild binary, e.g. the app repo's node_modules)
export AWS_ACCESS_KEY_ID=admin AWS_SECRET_ACCESS_KEY=adminadmin
celld deploy cell --bucket s3://apm-cell --endpoint http://127.0.0.1:9000

# 3. Run a node with the cell's vars
export CELLD_VAR_WEBHOOK_BEARER=dev-webhook-bearer
export CELLD_VAR_UI_BEARER=dev-ui-bearer
export CELLD_VAR_TICKET_SECRET=dev-ticket-secret
celld --bucket s3://apm-cell --endpoint http://127.0.0.1:9000 \
  --listen 127.0.0.1:8787

# 4. Smoke it (from cell/)
npm run smoke
```

## Secrets / vars

| Var | Purpose |
|---|---|
| `WEBHOOK_BEARER` | Auth for `POST /alerts/fire` (notification-target webhook) |
| `UI_BEARER` | Auth for the UI's proxied calls (`kv.cellToken` in proxies.yml) |
| `TICKET_SECRET` | HMAC key for WS tickets |
| `DISABLED` | `"true"` drops all new triggers (local kill switch) |
| `LLM_BASE_URL` | OpenAI-compatible endpoint base (absent ⇒ stub agent) |
| `LLM_API_KEY` / `LLM_MODEL` | Endpoint key + model id |
| `LLM_VISION` | `"true"` ⇒ the model takes image input, so attached screenshots are forwarded. Off here: the pinned model is text-only, and pi-ai silently DROPS images for an undeclared model while most providers hard-fail image parts sent to a text-only one. APM's UI doesn't attach images. |
| `TURN_BUDGET` | Per-message turn cap for interactive sessions (default 12) |
| `CRIBL_BASE_URL` | Cribl workspace base URL |
| `CRIBL_CLIENT_ID` / `CRIBL_CLIENT_SECRET` | Machine OAuth (search tools, KV kill switch, event commits) |
| `CRIBL_DATASET` | Telemetry dataset (default `otel`) |
| `CRIBL_DEV_TOKEN` | Offline testing only: static bearer for a mock Cribl |

The app's `serverInvestigations` KV flag is a second kill switch:
the cell re-reads it (~60s cache) on every trigger; stale-but-known
values survive KV blips, and a flag that was never readable fails
closed.

## Offline real-mode test

```bash
node scripts/mock-backends.mjs &        # scripted LLM + mock Cribl (:9370)
# deploy + run a node with LLM_BASE_URL=http://127.0.0.1:9370/v1,
# CRIBL_BASE_URL=http://127.0.0.1:9370, CRIBL_DEV_TOKEN=dev, then:
npm run smoke:real
```

## Hosting

Undecided — tracked as an open decision (likely Clint's AWS infra:
one celld node + an S3 bucket is sufficient). Nothing in the cell
assumes a particular host; celld needs an S3-compatible bucket, a
listener, and the vars above. Graceful shutdown (SIGTERM, not
SIGKILL) matters: replication drains on TERM; a hard kill can lose
the last seconds of writes (S2 spike finding).
