# Server-side investigations

Cribl APM uses the shared GoatTown service for durable interactive and autonomous
investigations. The feature is optional and off by default; alerts,
incidents, and the warroom continue to work without it.

## Architecture

When provisioning is enabled, APM:

1. Defines the APM agent in the repository-root `goattown.config.yaml` for a
   GoatTown tenant administrator to review and activate.
2. Creates `criblapm__alert_notify` and binds it to GoatTown's
   `POST /alerts/fire` endpoint.
3. Sends interactive sessions to `POST /investigations` with
   `agent: "apm-investigator"`.

The agent can run read-only KQL and PromQL, inspect configured source
repositories, and finish with `report_findings`. APM converts that generic
report to its existing summary card. A full-span `run_search` result for one
trace is converted to the existing waterfall card.

The alert trigger sends GoatTown's generic trigger fields and the former
APM-cell fields. GoatTown deduplicates on `agent + eventId` within the
installation.

## Configuration

| Setting | Purpose |
|---|---|
| `GOATTOWN_URL` | Shared GoatTown base URL (defaults to `https://goattown-shared.lab.cribl.io`) |
| `kv.goattownEmbedToken` | Per-app `gt_a1_` credential for interactive sessions and agent discovery |
| `GOATTOWN_ADMIN_TOKEN` | Optional CLI-only tenant-admin credential for staging configuration; never use the app credential |
| `GOATTOWN_WEBHOOK_TOKEN` / `kv.goatTownWebhookToken` | Installation-scoped Cribl notification target authentication for `/alerts/fire` |
| `GOATTOWN_REPOS_JSON` / `sourceRepos` | Optional repositories available to investigations |

The shared host is package-pinned in `config/proxies.yml`. In GoatTown's hosted
console, select the Workspace and open **Connections -> Connected apps -> Add
app**. Use App ID `apm` and KV key `goattownEmbedToken`, then copy the generated
`gt_a1_` token into APM or use **Update app KV**.

## Provisioning

Use APM's **Test connection** action to verify both authenticated session access
and availability of `apm-investigator`. Agent configuration is managed in the
GoatTown tenant console. APM's connected-app credential deliberately cannot
stage configuration or mutate installation-wide repository settings.

CLI configuration:

```text
GOATTOWN_URL=https://goattown-shared.lab.cribl.io
GOATTOWN_ADMIN_TOKEN=<optional tenant-admin token>
GOATTOWN_WEBHOOK_TOKEN=<gt_w1_ installation token>
GOATTOWN_REPOS_JSON=[{"url":"github.com/org/repo","service":"*"}]
```

When `GOATTOWN_ADMIN_TOKEN` is configured, re-provision after changing the
dataset, then approve the newly staged revision. The active revision remains
unchanged until a human activates it.

## Trigger contract

Each alert row includes:

```json
{
  "agent": "apm-investigator",
  "eventId": "<stable alert event id>",
  "subject": "<alert id>",
  "group": "apm:<service>:<signal type>",
  "summary": "<investigation request>",
  "svc": "<service>",
  "signal_type": "<signal type>"
}
```

The connected-app token isolates APM sessions from other apps. GoatTown scopes
each request further using the signed-in member id APM forwards in
`x-goattown-user`.

## Operations

- Disabling the feature requires re-provisioning to remove the notification.
- Agent configuration and activation are GoatTown tenant-admin actions.
- Session state and transcripts live in GoatTown.
- Interactive source repositories are carried on session creation.
- The app never handles bearer tokens directly in the browser; the platform
  proxy injects `kv.goattownEmbedToken`.

## Known Limitations

- The existing `gt_w1_` webhook creates installation-scoped autonomous
  sessions, while `gt_a1_` reads are app-connection scoped. Full autonomous
  drill-back requires GoatTown to associate webhook runs with the APM app
  connection; interactive sessions are fully app-scoped today.
- Configured repositories cause the harness to inject legacy source tools
  outside the registered agent tool allow-list. They remain read-only and
  repo-scoped, but GoatTown should make them explicit agent capabilities.
- Autonomous preflight is performed by the agent from the registered
  playbooks rather than by a pre-model callback. GoatTown needs an enrichment
  hook to reproduce the old eager preflight exactly.

See `docs/research/goatfarm-migration.md` for the detailed framework analysis.
