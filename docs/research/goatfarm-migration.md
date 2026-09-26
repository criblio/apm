# GoatFarm investigator migration

Investigation date: 2026-08-30.

The local implementation repository is named `goattown`; no repository or
package named `goatfarm` exists in the local workspace. This document uses
"GoatFarm" for the shared hosted agent service and names GoatTown when
referring to its implementation.

## Implementation status

APM now uses the existing GoatFarm APIs without requiring a server change:

- Provisioning generates `goattown.config.yaml`, validates it, and stores an
  immutable `cribl-apm` revision for human activation.
- Interactive creates select that agent explicitly.
- Alert notification rows carry both the legacy and generic trigger fields.
- UI-created sessions run the existing preflight before creation.
- GoatFarm reports are normalized into APM's structured summary card.
- Full-span `run_search` results are recognized and rendered as trace
  waterfalls.
- Alert badges read GoatFarm's session index instead of requiring custom
  lifecycle rows.

The old cell wire fields remain during the migration so rollback is possible.

The independent framework package migration is safe and has been completed:

- `@criblio/app-utils@^0.8.1` from npmjs
- `@criblio/agent-protocol@^0.4.1` from npmjs
- `@criblio/app-tooling@^0.2.1` from npmjs
- no GitHub Packages `.npmrc` or token
- no app dependency on the retired `@criblio/cell-harness`

## GoatTown configuration contract

`goattown.config.yaml` is the canonical source-tree definition. Browser and CLI
provisioning send the same generated YAML through `configuration?action=validate`
and `configuration?action=store`, then read its diff. They never call
`action=activate` or `action=apply`; a human reviews and activates the revision
in GoatTown. Interactive creates select `agent: "apm-investigator"`, and a
trigger row sent to `POST /alerts/fire` includes that slug and a stable
`eventId`.

The effective APM agent declaration is:

```yaml
profiles:
  - slug: apm-telemetry-reader
    tools: [cribl-read]
    requiredSkills: [cribl-apm-investigator]
    net: { hosts: [$CRIBL_API_BASE], apiPaths: [], datasets: [otel] }
agents:
  - slug: apm-investigator
    tools: [report]
    inherits: [apm-telemetry-reader]
    triggerable: true
```

The configured APM dataset must replace `otel` when registration runs.
Notification rows must additionally project `agent="apm-investigator"`, map
`event_id` to `eventId`, `alert_id` to `subject`, and preserve the service in
`group` and trigger fields.

## Preamble placement

`src/api/agentContext.ts` currently contains about 71 KB of static preamble.
It cannot be copied into `Agent.instructions`, which is limited to 32,000
characters and is resent on every turn.

Move only these rules into agent instructions:

- The investigator mission and read-only behavior.
- Evidence versus inference discipline.
- The convergence and stopping rules.
- The requirement to finish with the concluding tool.

Move the domain reference material into one required prose skill. The complete
reference is about 71 KB and fits GoatTown's 128 KB preamble limit:

- OTel record shapes and field mappings.
- Cribl KQL syntax, parser traps, timestamps, and cached lookups.
- APM RED metric names and PromQL usage.
- Smooth-climb and leak investigation.
- Downstream attribution and timeout survivorship bias.
- Crashloop, proxy, traffic-drop, and remaining failure playbooks.

Keep question, service, operation, time range, topology, known signals, and
incident identity in the per-session prompt or trigger. They are run-specific
facts, not agent behavior or reusable skills.

## Recommended GoatFarm changes

1. **Custom native tool extension.** A registered app agent should have a supported
   way to add tool definitions and executors, or an equivalent trusted plugin
   contract. APM currently works around this by teaching the agent to return a
   complete trace through `run_search` and recognizing that row shape in the
   client. A native `render_trace` would be more reliable and cheaper.
2. **Concluding-tool compatibility.** Either permit an app-supplied concluding
   tool or let `report_findings` preserve APM's existing structured
   `{kind:"summary", findings, conclusion}` payload. APM currently parses the
   report's markdown headings and normalizes it into the existing summary card.
3. **Lifecycle callback or sink.** Registered agents would benefit from a declarative
   lifecycle sink for started, concluded, and failed events. APM now reads the
   session index for badges and incident correlation, but a sink would retain
   the historical dataset event contract and improve long-window reporting.
4. **Trigger seed enrichment.** Registration should support an app-owned enrichment
   hook, or a callback/MCP phase before the first turn, for APM's anomaly
   preflight. The current generic trigger only converts supplied fields into
   prose and cannot run `runPreflight` before model execution.
5. **Source-tool authorization.** The harness currently appends legacy code
   tools whenever repos are configured, independently of the registered
   agent's tool snapshot. Source tools must be explicit catalog grants (and
   trigger-safe where appropriate) so the agent registry remains the actual
   access boundary.
6. **Published configuration types.** Export configuration revision and
   validation types with the session protocol so integrations do not maintain
   local wire mirrors.

`update_context` does not need to migrate. Its current implementation is a
generic acknowledgement and does not provide durable APM behavior.

## Remaining cutover work

The shared host URL remains configuration-driven and must point at GoatFarm.
The retired custom `cell/` deployable has been removed; its implementation and
infrastructure remain available in Git history if an operational rollback is
needed. Live autonomous and interactive validation is still required against
the configured GoatFarm deployment.
