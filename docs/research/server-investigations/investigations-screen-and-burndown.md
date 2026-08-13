# Investigations screen (UX) + end-to-end burn-down

Companion to `design.md`. Two parts: the design for a dedicated
**Investigations** screen (browsing past + in-flight server-side
investigations, instead of reaching them only through Alerts), and a
prioritized burn-down of everything still needed to make the feature
work end-to-end in the product.

## Part 1 — Investigations screen

### Why a separate screen

Today (PR #127) a server-side investigation is reachable only as a
badge on an Alerts *incident* row, and only while that incident is
inside the Alerts history window. That's a fine shortcut but a poor
home: investigations outlive the incident view, a user wants to
browse "what has the investigator looked at," and the Alerts page is
about *alert state*, not *investigation history*. Give investigations
their own first-class list.

The Alerts badge stays (convenient: alert → its investigation). The
Investigations screen becomes the canonical, browsable history.

### Route + nav

- New route `/investigations` → `InvestigationsPage`.
- Sidebar entry in the monitoring group, directly under **Alerts**
  (label: "Investigations"). Visible only when the
  `serverInvestigations` flag is on; when off, the page renders an
  explainer ("Enable server-side investigations in Settings"). Same
  flag-gating pattern the Alerts badges already use.

### Data

Dataset-only — the screen never contacts the cell (same principle as
the Alerts page). It reads the `record_kind=="investigation"`
lifecycle events via `Q.investigationEvents()` (already shipped in
#126) and rolls them up **per `investigation_id`**:

```
rollupInvestigations(events) -> InvestigationRow[]   // newest first
  InvestigationRow = {
    investigationId, alertId, service, signalType,
    status: 'investigating' | 'investigated' | 'failed',
    startedAt, concludedAt|null, durationMs|null,
    conclusion,           // snippet from the 'investigated' event
    triggerEventId,
  }
```

This is a new pure helper next to the existing
`indexInvestigations`/`badgeForIncident` in
`src/utils/investigationBadges.ts` (the Alerts badge keyed by
alert_id; this one keyed by investigation_id, so a service with
several runs shows each). Unit-testable, no new query needed.

Drill-in reuses the replay already built in #127:
`/investigate?investigation=<id>` → read-only transcript via the poll
transport.

### Layout

A single table, newest first, auto-refreshing every 30 s (so
in-flight runs update), with a filter row:

| Service | Signal | Status | Started | Duration | Conclusion | |
|---|---|---|---|---|---|---|
| `payment` (link) | Error Rate | 🟢 Investigated | 06:16 | 4m 12s | "payment is healthy; alert is background noise…" | View → |
| `checkout` | Latency | 🔵 Investigating… | 06:31 | 2m so far | — | View → |
| `cart` | Error Rate | 🟠 Failed | 05:54 | 1m 03s | "hit the 12-turn cap" | View → |

- **Status** reuses the badge colors from #127 (success / info /
  warning).
- **Service** links to Service Detail; **View** opens the replay.
- **Duration** shows "Nm so far" for running rows (the live pattern
  AlertsPage already uses for open incidents).
- **Conclusion** is the stored ≤1 KB snippet, truncated with a title
  tooltip.

Filters (all client-side over the fetched rows):
- Status (all / investigating / investigated / failed).
- Service (free-text or dropdown of services present).
- Time range (reuse `HISTORY_RANGES` from AlertsPage: -1h … -30d),
  which sets the `earliest` on `Q.investigationEvents`.

Empty state: "No server-side investigations yet. When enabled, a
firing alert automatically triggers one." + a link to Settings and
(if the flag is on but nothing exists) a note that it needs a
deployed investigator cell.

### Build sketch (one PR, stacked on #127)

- `src/routes/InvestigationsPage.tsx` — the table + filters + poll,
  modeled on `AlertsPage.tsx` (query-generation cancellation, 30 s
  silent refresh, status styles).
- `src/utils/investigationBadges.ts` — add `rollupInvestigations`.
- `src/App.tsx` + `src/components/Sidebar.tsx` — route + flag-gated
  nav entry.
- Reuse #127's replay page, transport, and status badge styling.
- Validate on staging via Playwright once the cell + proxies wiring
  (burn-down §5) is live: list renders, filter works, drill-in
  replays a real transcript.

Later: a "Continue asking" affordance on a concluded investigation
(the cell already persists the raw pi message history for exactly
this), and per-service investigation counts surfaced on Service
Detail.

## Part 2 — End-to-end burn-down

What's left to go from "proven on a synthetic fire" to "a real alert
fires and a user browses the investigation in staging." Ordered by
whether it blocks the product loop.

### Blocking — required for the real end-to-end loop

1. **Merge #127 (UI replay).** CI is currently unstable — fix and
   land. *(open)*
2. **Merge #131 (real-loop hardening).** Green/clean. *(ready)*
3. **Deploy #131 to the live cell with real-loop env.** Handoff:
   `cell/infra/DEPLOY.md`. *(handed to infra VM)*
4. **The trigger — the notify search + notification target
   (design.md "PR 9").** Not built. Today investigations only start
   via a manual/synthetic POST to `/alerts/fire`. For a *real* alert
   to trigger one we need `Q.alertNotify()` (a flag-gated scheduled
   search selecting `firing` transitions) plus a webhook notification
   target pointing at the cell — provisioned by `scripts/provision.ts`
   (S4 proved targets are fully API-CRUDable). Framework side: the
   `ProvisionedSearch.schedule.notifications` field. **This is the
   single biggest functional gap.**
5. **proxies.yml wiring so the staging iframe reaches the cell.**
   The UI transport (#127) calls `getCellBaseUrl()` but nothing sets
   it and `config/proxies.yml` is empty. Needed: populate
   `proxies.yml` (cell domain; paths `/investigations/*` + `/ws-ticket`;
   header inject `authorization: "'Bearer ' + kv.cellToken"`); swap
   `--require-empty-proxies` → `--proxies-manifest` (tooling shipped
   in framework #22); create the `cellToken` encrypted-KV secret
   (= the cell's `UI_BEARER`); and resolve `getCellBaseUrl()` to the
   cell URL (build-time config or a host global). Until this, the
   badge/replay can't reach the cell from inside the iframe.
6. **Make the `serverInvestigations` flag cell-readable.** The cell's
   machine token can't read app-scoped KV, so #131 ships `FORCE_ENABLE`
   as a crutch. Move the flag somewhere the cell can read — options:
   commit it as a dataset config event the cell queries; a dedicated
   unscoped KV key the machine token *can* read; or fold the
   enabled-state into the notify-search existence (if the notify
   search runs, the feature is on). Then retire `FORCE_ENABLE`.
7. **Deploy the app pack** (with #126/#127/#131 merged) to staging so
   the UI actually carries the badges, replay, and Investigations
   screen.

### Non-blocking — correctness, cost, polish

8. **Investigations screen** (Part 1). Independent of the trigger;
   develops against existing dataset events.
9. **Per-investigation LLM + search caps.** The e2e runaway was fixed
   by the re-entrancy guard, but add belt-and-suspenders: a hard cap
   on LLM calls per investigation and the design's search caps
   (≤2 concurrent / ≤30 total) so a pathological model can't burn
   budget or the search queue.
10. **Tune `MAX_CONCURRENT`.** It's 1 (staging search-pool safety).
    Raise once real load is understood; the orphan-reclaim fix (#131)
    removes the wedging risk that made 1 fragile.
11. **Unit tests** for the #131 pure helpers (`capEvent`,
    `capMessage`, `rollupInvestigations`, orphan-reclaim) — the live
    e2e validated them but they deserve fast regression cover.
12. **CI/CD cell deploy** (design in `DEPLOY.md`): scoped OIDC role +
    on-merge `cell/**` deploy workflow.
13. **Capture the real notification-target webhook envelope** (last
    open S4 item) once #4 lands, and confirm the cell's
    `extractAlerts()` handles it.
14. **Model choice.** deepseek-v4-flash concluded a real investigation
    well; confirm it's the intended production model and consider a
    fallback/timeout.
15. **Transcript polish**: replay backlog pagination; a "Continue
    asking questions" flow on concluded investigations (raw pi
    history is already persisted).

### Dependency order

```
#131 ─┐
#127 ─┼─► deploy app pack (7) ─► proxies wiring (5) ─┐
      │                                              ├─► real UI e2e
cell deploy (3) ─► flag-readable (6) ─► trigger (4) ─┘
                                            │
                                            └─► Investigations screen (8) usable with real data
```

The trigger (4) + proxies wiring (5) are the two that turn the
already-working machinery into the real product loop; everything else
is hardening or UX on top.
