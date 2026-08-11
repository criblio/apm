# apm-investigator-cell

Server-side investigator for Cribl APM: a Worker + Durable Objects
bundle that runs on [celld](https://github.com/denoland/celld)
(self-hosted, portable to Cloudflare). When an alert fires, the cell
runs an autonomous investigation and streams the transcript to the
APM UI. Design and PR sequence:
`docs/research/server-investigations/design.md`.

**Status: PR 6 scaffold.** The full pipe works end-to-end with a
stub agent (fire → dedupe → queue → alarm-driven turns → transcript
→ WS/poll replay → conclusion). The real pi-agent-core loop, Cribl
search tools, and dataset event commits land in PR 7.

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

PR 7 adds: `CRIBL_CLIENT_ID`/`CRIBL_CLIENT_SECRET` (search tools,
KV-flag kill switch, dataset event commits) and the
OpenAI-compatible endpoint key (pi-ai).

## Hosting

Undecided — tracked as an open decision (likely Clint's AWS infra:
one celld node + an S3 bucket is sufficient). Nothing in the cell
assumes a particular host; celld needs an S3-compatible bucket, a
listener, and the vars above. Graceful shutdown (SIGTERM, not
SIGKILL) matters: replication drains on TERM; a hard kill can lose
the last seconds of writes (S2 spike finding).
