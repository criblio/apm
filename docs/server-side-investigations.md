# Server-side investigations

Cribl APM uses the shared GoatTown service for durable interactive and autonomous
investigations. The feature is optional and off by default; alerts,
incidents, and the warroom continue to work without it.

## Architecture

When provisioning is enabled, APM:

1. Generates and validates the repository-root `goattown.config.yaml`, with
   the complete APM reference manual as one required skill.
2. Stores an immutable `cribl-apm` configuration revision for human review.
3. Creates `criblapm__alert_notify` and binds it to GoatTown's
   `POST /alerts/fire` endpoint.
4. Sends interactive sessions to `POST /investigations` with
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
| `GOATTOWN_UI_TOKEN` / `kv.sharedCellToken` | Installation-scoped calls to sessions, declarative configurations, and repository configuration |
| `GOATTOWN_WEBHOOK_TOKEN` / `kv.goatTownWebhookToken` | Installation-scoped Cribl notification target authentication for `/alerts/fire` |
| `GOATTOWN_REPOS_JSON` / `sourceRepos` | Optional repositories available to investigations |

The shared host is package-pinned in `config/proxies.yml`. Enroll at
`https://goattown-shared.lab.cribl.io/enroll` to obtain the one-time UI and
webhook installation tokens.

## Provisioning

Turn on **Configuration -> Workspace -> Server investigations**, configure the
installation tokens, then apply provisioning. Provisioning fails instead
of installing a dead trigger if configuration validation or storage fails. It
does not activate the revision. Open GoatTown's **Configurations** page, load
producer `cribl-apm`, review the staged diff, and activate it explicitly.

CLI configuration:

```text
GOATTOWN_URL=https://goattown-shared.lab.cribl.io
GOATTOWN_UI_TOKEN=<gt_i1_ installation token>
GOATTOWN_WEBHOOK_TOKEN=<gt_w1_ installation token>
GOATTOWN_REPOS_JSON=[{"url":"github.com/org/repo","service":"*"}]
```

Re-provision after changing the dataset, then approve the newly staged
revision. The active revision remains unchanged until a human activates it.

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

The installation token isolates APM state from other Workspaces. APM also uses
the registered agent filter and one installation-wide owner, `cribl-apm`, so
incident responders share interactive and alert-triggered sessions.

## Operations

- Disabling the feature requires re-provisioning to remove the notification.
- Deployment validates and stores configuration revisions but never activates
  them. Activation is a GoatTown human-review action.
- Session state and transcripts live in GoatTown.
- Alerts and incidents read GoatTown's installation-scoped session index.
- Source repositories are pushed through `POST /config/repos` and are only
  available when explicitly configured.
- The app never handles bearer tokens directly in the browser; the platform
  proxy injects `kv.sharedCellToken`.

## Known Limitations

- Trigger-created sessions begin unowned. Before listing sessions, APM claims
  them into the installation-wide `cribl-apm` owner. Installation isolation is
  enforced by GoatTown's installation token; owner claims provide collaborative
  separation inside that installation, not an authorization boundary.
- Configured repositories cause the harness to inject legacy source tools
  outside the registered agent tool allow-list. They remain read-only and
  repo-scoped, but GoatTown should make them explicit agent capabilities.
- Autonomous preflight is performed by the agent from the registered
  playbooks rather than by a pre-model callback. GoatTown needs an enrichment
  hook to reproduce the old eager preflight exactly.

See `docs/research/goatfarm-migration.md` for the detailed framework analysis.
