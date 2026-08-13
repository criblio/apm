# Interactive server investigations + recall panel

Follow-on to `design.md`. Two user-driven requirements:

1. **When `serverInvestigations` is ON, all investigations are
   server-side.** Clicking **Investigate** no longer runs the agent
   loop in the browser — it starts a cell-hosted, persistent,
   **interactive** investigation the user can keep chatting with.
   (Flag OFF ⇒ today's client `InvestigatorChat` runs unchanged.)
2. **Keep a record of investigations** and give the Investigator
   window a **left-hand panel** to recall the last N and search older
   ones.

Two decisions the user made (2026-08-13):

- **Record store = the cell** (not the dataset). The panel reads the
  cell's `GET /investigations`, extended with search + pagination.
  The cell's SQLite is the single source of truth for the list.
- **Interaction model = full interactive server chat.** The user can
  send follow-up turns during and after the run; the cell resumes the
  loop from stored `agent_messages`.

## Why no framework change is on the critical path

`InvestigatorTranscript` (the pure transcript view — props
`{entries, running, renderToolCard}`) and `applyLoopEvent` (the
reducer) are already exported from `@cribl/app-utils/investigator`.
The app already composes them app-side in `useInvestigationReplay` +
`InvestigatePage`'s replay view. So the interactive server view is
built entirely app-side: the same transcript view + an input box + a
session hook that streams events from the cell and POSTs user turns
to it. The framework `InvestigatorChat` (client-loop driver) is left
untouched and remains the flag-off path.

## Status lifecycle (the one subtle piece)

Autonomous (alert-triggered) investigations are unchanged:
`queued → running → concluded | failed`.

Interactive (UI-started) investigations add a **non-terminal `idle`**
state — the loop yielded a final answer for the current user turn and
is waiting for the next message:

```
queued → running → idle ⇄ running → … (stays idle; never auto-concludes)
                     └────────────────── failed (on error / turn-cap per batch)
```

- On `done` in interactive mode the DO sets `idle` (not `concluded`),
  frees its coordinator concurrency slot, and does **not** commit an
  `investigated` lifecycle event (interactive runs aren't "closed").
- A new user message flips it back to `running` and reschedules the
  turn alarm; `runTurn` resumes from the stored history.
- `MAX_TURNS` becomes a **per-user-message** budget, not a global cap,
  so a long conversation isn't killed by the 12-turn ceiling.

**v1 limitation:** a resumed interactive investigation re-enters
`running` without re-acquiring a global concurrency slot through the
coordinator's queue (the slot gate only applies at first start).
Interactive runs are human-paced and low-volume, so this is
acceptable; the per-investigation search caps still bound resource
use. Tracked for hardening.

## Cell changes (PR A)

`protocol.ts`
- `InvestigationStatus` gains `'idle'`.
- `InvestigationSummaryRow` gains `title: string` and
  `mode: 'autonomous' | 'interactive'`.

`coordinatorDO.ts`
- `investigations` table gains `title TEXT` and
  `mode TEXT NOT NULL DEFAULT 'autonomous'` (idempotent `ALTER`).
- `POST /internal/create` — UI-initiated: `{ prompt, context?, title? }`
  → insert row with synthetic `event_id = 'ui-' + uuid`,
  `mode = 'interactive'`, `status = 'queued'`, derived title; `pump()`.
  Returns `{ id }`.
- `/internal/complete` accepts `outcome: 'idle'` (frees the slot,
  status `idle`) and `'resumed'` (status `running`, no slot re-gate).
- `pump()` unchanged — it only starts `status = 'queued'` and counts
  `status = 'running'` for the slot budget, so `idle` rows are inert.
- `/internal/list` returns `title` + `mode`, and accepts
  `?q=<substr>` (matches title/incident_key), `?limit=` (default 30,
  max 100), `?before=<created_at>` (keyset pagination, newest-first).

`investigationDO.ts`
- `investigation` table gains `mode` + `title`.
- `POST …/create` — interactive counterpart to `/start`: seeds
  `seed_json` from `{ prompt, context }`, `mode = 'interactive'`,
  status `running`, schedules the alarm. No `alert` blob.
- `POST …/messages` — `{ content }`: appends a pi user message to
  `agent_messages`, resets the per-batch turn counter, sets `running`,
  notifies coordinator `resumed`, schedules the alarm.
- `runTurn` branches on `mode`: interactive `done` ⇒ `idle` +
  `notifyCoordinator('idle')` (no lifecycle commit, no alarm);
  autonomous unchanged.
- `ensureSeededInteractive({ prompt, context })` builds the initial
  history from the user prompt instead of the alert seed.

`index.ts` (public router, `UI_BEARER`)
- `POST /investigations` `{ prompt, context?, title? }` → coordinator
  `/internal/create` → `{ id }`.
- `POST /investigations/:id/messages` `{ content }` → the DO.
- `GET /investigations` gains `q` / `limit` / `before` passthrough.

## App changes (PR B — transport + interactive view)

`investigationTransport.ts`
- `createInvestigation({ prompt, context?, title? }): Promise<{ id }>`
- `sendInvestigationMessage(id, content): Promise<void>`
- `listInvestigations({ q?, limit?, before? }): Promise<Summary[]>`
- `isTerminalStatus` stays terminal-on `concluded|failed|cancelled`;
  `idle` is **not** terminal for the interactive session (polling
  pauses on `idle` and resumes after a send).

`useInvestigationSession(id)` — generalize `useInvestigationReplay`:
same streamed `entries` + `status` + `running`, plus
`sendMessage(content)` (optimistic user-turn append, POST, resume
polling). Read-only replay stays a special case (`concluded` ⇒ no
input box).

Route **Investigate** through the cell when the flag is on:
`InvestigateButton` / `InvestigatePage` — when
`serverInvestigations` is enabled, `createInvestigation(seed)` then
open `?investigation=<id>` in interactive mode; else the client
`InvestigatorChat` as today.

## App changes (PR C — recall panel)

Left sidebar in the Investigator window:
- Recall last N via `listInvestigations({ limit })`; infinite-scroll
  older via `before` cursor.
- Search box → `listInvestigations({ q })`.
- Each row: title, status chip, relative time. Click opens the
  investigation — interactive if `idle`/`running`, read-only if
  `concluded`/`failed`.
- Present in both the new-investigation and drill-in views; collapses
  on narrow (mobile) widths.

## PR sequence

- **PR A (cell):** endpoints + status model above; workerd-local unit
  tests (create → turn → idle → message → resume; list search +
  pagination). Deployed by the infra agent.
- **PR B (app):** transport + `useInvestigationSession` + interactive
  view + flag-gated Investigate routing. Deploy to staging.
- **PR C (app):** recall/search panel. Deploy to staging.

No framework SHA bump required.
