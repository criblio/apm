# 2026-08-14 — Server investigations: interactive UI + wiring the autonomous trigger end-to-end

Long session that shipped the interactive-investigations UX and then
chased the autonomous alert→investigation trigger from "silently never
fires" to green end-to-end. Most of the time went into non-obvious Cribl
platform behaviors, now captured in `docs/cribl-app-skill/skill.md`.

Branch: `interactive-server-investigations` (app PR #137).
Framework PR: criblio/cribl-search-app-framework #26 (merged, pinned).

## What shipped

**Interactive investigations + recall panel** (PRs A/B/C on the branch)
- Cell: `POST /investigations` (create from a free-form prompt),
  `POST /investigations/:id/messages` (resume), a non-terminal `idle`
  status, `GET /investigations?q=&limit=&before=` (search + pagination).
- App: `investigationTransport` (create/send/list), `useInvestigationSession`
  (streams the transcript via the shared `applyLoopEvent`, `sendMessage`),
  and routing so — when `serverInvestigations` is on — the Investigate
  button and a new-investigation composer run server-side. Reuses the
  framework's exported `InvestigatorTranscript`; **no framework change**.
- Left-hand **recall panel** (`InvestigationsSidebar`): search, load-older
  (keyset), status chips, collapsible (persisted).

**Saved-session user messages** — the cell now records each follow-up as
a `userMessage` transcript event so a reopened session replays the user's
side, not just the assistant's (deduped against the live optimistic
append). Opening question still comes from the seed. Past sessions don't
back-fill (their follow-ups were never recorded).

**Settings** — manual cell-token entry (not just generate); a
`cellWebhookBearer` field; the "Provision" button now runs the same
cell-trigger wiring the CLI does (see UI==CLI below).

## The bug cascade (autonomous trigger never actually worked)

The alert→cell trigger had been "built" earlier but never validated live.
Peeling it back, in order:

1. **Stale `local/` proxy override.** UI showed `403 … Domain
   54-71-34-177.sslip.io is not declared in proxies.yml` even though the
   pack was correct. `GET /apps/apm/proxies` returned the old
   `api.example.com` example; redeploy and even DELETE+reinstall pulled it
   back. Proved it was app-id-keyed by deploying a throwaway id (clean
   grant). Fixed by clearing the app's on-disk `local/` state server-side.
   → skill.md "proxies.yml → local/-override trap".

2. **Deploy no-ops without a version bump** — several "my change didn't
   ship" ghosts. → skill.md "Provisioning → Deploy needs a version bump".

3. **`ensureCellWebhookTarget` existence check** — by-id GET returns
   `200 {items:[],count:0}`, not 404, so it PATCHed a nonexistent target
   and 404'd. → skill.md "Notification targets → 200 not 404".

4. **Notifications are a separate resource (the big one).** Writing a
   search's `schedule.notifications` inline is silently dropped (server
   keeps `{}`); notifications must be POST/PUT to `/m/default_search/
   notifications`, with a specific record shape. This is why `alert_notify`
   ran every 5 min and posted nowhere. → new `src/api/cellProvisioning.ts`
   + skill.md "Notification targets → separate resource".

5. **UI ≠ CLI provisioning.** The in-app Provision button created the
   searches but not the target/binding. Fixed by extracting the shared
   `cellProvisioning` module and adding an `afterReconcile` hook to the
   framework `ProvisioningPanel` (PR #26); the app passes the cell-trigger
   step. → skill.md "Provisioning → Keep UI and CLI identical".

6. **Provisioner churn / banner flap.** A routine `npm run deploy`
   (flag unset → default OFF) deleted `alert_notify`, which the UI (flag
   ON) then flagged as missing — an intermittent "searches not provisioned"
   banner. Fixed by inferring the flag from server state when the env
   override is unset. → skill.md "Provisioning → flag-gated searches".

7. **Webhook bearer 401.** Even fully wired, the cell rejected the fire
   (`401`) because the target's token didn't match the cell's
   `WEBHOOK_BEARER` — the cell had been redeployed and rotated the secret.
   Re-aligned `CELL_WEBHOOK_BEARER` → `202 {accepted:1}`. → skill.md
   "Notification targets → webhook target auth".

## Verified state at end of session

- `/alerts/fire` with the correct bearer → `202 {accepted:1}`.
- `alert_notify` bound to `criblapm_cell_webhook`; provision idempotent.
- Historical data confirmed the pipeline *had* worked (10 `started`, 2
  `investigated`, 08-13→08-14 04:18) before this session's debugging
  temporarily unbound it — it was not "broken on first fire".

## Known follow-ups

- **Investigation completion**: of 10 autonomous runs, only 2 concluded;
  the other 8 didn't finish. Investigate loop/timeout behavior.
- **Cell redeploy** still required for the `userMessage` transcript-event
  change (app side is deployed).
- After PR #137 merges, keep `.framework-sha` on framework master.
