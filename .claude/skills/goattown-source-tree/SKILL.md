---
name: goattown-source-tree
description: Author and deploy GoatTown agent integrations through repository-root goattown.config.yaml. Use whenever adding or changing APM agents, skills, profiles, MCP tools, schedules, network grants, or configuration deployment. Enforces validate/store/human-activate workflow and forbids direct registry stitching.
---

# GoatTown Source-Tree Configuration

Pinned source: `criblio/goattown@ac172a17c8133e2b841d7d390ed19648e3666a17`,
`cell/seed/source-tree-configuration.md`.

Use `goattown.config.yaml` at the repository root as the canonical, reviewable
definition of an integration's agents. Do not stitch registries together with
separate `/agents`, `/skills`, `/capabilities`, or `/mcp` API calls.

Before editing, inspect the live configuration catalog. Confirm instructions
and success criteria, direct tools, inherited security profiles, optional and
required skills, MCP tools, network/API-path/dataset scope, schedules and
misfire behavior, model settings, and authorization grants. Do not infer
omitted grants.

After every material edit, validate the complete source. Validation does not
store or activate anything. Deployment may validate and store an immutable
revision. It must never activate or apply it automatically. A human reviews
the diff and activates the revision in GoatTown.

## Complete shape

```yaml
version: 1
producer: my-integration

skills:
  - name: investigation-playbook
    displayName: Investigation playbook
    description: Procedures required for every investigation.
    kind: prose
    body: |
      # Investigation playbook
      Follow the evidence.

profiles:
  - slug: telemetry-reader
    displayName: Telemetry reader
    description: Read-only access to Search and metrics.
    tools: [cribl-read]
    skills: []
    requiredSkills: [investigation-playbook]
    mcpTools: []
    net:
      hosts: [$CRIBL_API_BASE]
      apiPaths: []
      datasets: [otel]

mcpServers: []

agents:
  - slug: incident-investigator
    displayName: Incident investigator
    description: Investigates telemetry and reports actionable evidence.
    instructions: |
      Investigate the event and distinguish evidence from inference.
      Finish with report_findings.
    tools: [report]
    skills: []
    requiredSkills: []
    mcpTools: []
    inherits: [telemetry-reader]
    net:
      hosts: []
      apiPaths: []
      datasets: []
    llm: {}
    triggerable: true
    authorizationGrants: []

schedules: []
authorizationGrants: []
```

## Deployment API

Authenticate with GoatTown's UI bearer and send the YAML as
`application/yaml`:

1. `POST /configurations?action=validate`
2. `POST /configurations?action=store`
3. `GET /configurations?action=diff&revision=<revision-id>`

Do not call `action=activate` or `action=apply` from application deployment.
The human reviewer activates the stored revision in GoatTown.

## Rules

- Every top-level array is required, even when empty. Unknown fields fail.
- Names and slugs use lowercase kebab-case.
- Tools are exact native IDs or live catalog set names.
- Inherited profiles are additive; agents cannot subtract inherited grants.
- `skills` are on demand. `requiredSkills` are pinned into the first-turn seed.
- Missing required skills prevent session startup.
- Empty `net.hosts` denies hosts. Empty `apiPaths` and `datasets` are
  unrestricted within other granted boundaries.
- Triggerable agents require `report_findings`, usually through `report`, and
  cannot hold deploy-capability tools.
- Cron is five-field UTC. Scheduled agents must be triggerable. Start schedules
  disabled until an interactive run validates behavior.
- Never put credentials or secrets in YAML. MCP credentials remain in
  GoatTown's secret store and are referenced by name.
- Autonomous writes default to deny. Exact grants require method, path, body,
  byte limits, and per-session and per-hour call limits.
- Saving creates an immutable revision. Activation affects only new sessions.
- A producer owns only resources it activated. Removing a resource from a
  later revision deletes only that producer's resource.
- Validation output is authoritative. Do not claim deployability until the
  live GoatTown validator accepts the source.

Prefer profiles for shared grants. Keep identity and required behavior in
agent instructions; use optional skills for occasional procedures and required
skills for mandatory large context.
