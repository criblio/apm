# Incidents & investigation lifecycle

**Status:** design (2026-08-18). Builds on
[`design.md`](./design.md) (the server-side investigator) and
[`code-investigation.md`](./code-investigation.md). Roadmap item **P4.4**.

## Two problems, one missing layer

Two things the server-side investigator doesn't handle yet:

1. **Old investigations never close.** The recall panel grows without
   bound; concluded runs sit next to live ones. We want an "archived"
   shelf — hidden by default, still searchable — and a principled
   answer for *when* and *how* things move there.
2. **One root cause, many erroring services.** A single fault (payment
   down, a bad deploy, the `recommendationCacheFailure` cache miss
   cascade) trips alerts across every downstream service. Today that
   would spawn N independent investigations of the same incident —
   wasteful against the `MAX_CONCURRENT=1` search pool, and fragmented
   (no unified root cause).

Both are symptoms of a flat hierarchy: **alert → investigation**, with
nothing above. The fix is to introduce a first-class **Incident** that
sits above investigations and owns state, lifecycle, and grouping. Once
it exists:

- *Closing* becomes "the incident resolved, so shelf it (and its
  investigations)."
- *Coalescing* becomes "these alerts and investigations belong to one
  incident."

An Incident is, deliberately, **a lightweight warroom**: a stateful
record with a severity, a living markdown summary, and a timestamped
timeline that both the agent and humans append to.

## First principle: incidents are Cribl-Search-native, not cell-dependent

The server-side investigator is **off by default** behind
`serverInvestigations`, and the cell can be down. **Incidents must work
without it.** So an incident is *not* a celld object — it's a
**Cribl-Search-native** record, exactly like alerts: event-sourced in the
dataset, grouped and materialized by saved searches, read by the app with
no dependency on the cell. This is the same posture the Alerts page
already takes (it reads the dataset and never contacts the cell) and it
honors the roadmap's "lean on Cribl Search" principle.

The **investigator, when enabled, is pure enrichment**: it attaches
automated investigations as incident children and lets the supervisor
agent author a root-cause summary. Turn it off and incidents still open,
group, hold state, collect human notes, resolve, archive, and render a
(deterministic) summary — they just don't get *automated* investigations
or an *agent-written* root cause.

### Where state lives: a lookup, not app KV, not refold-on-read

Two stores are *not* the answer, for concrete reasons:

- **App-platform KV** (the `kvstore/settings/app` surface) is tempting —
  it's a fast, mutable key→JSON store. But it can't own incident state:
  (1) **continuity** — its only writer is the app running in a browser,
  and incidents must open/attach/resolve continuously with no UI open, so
  the engine has to be server-side; (2) **access** — it needs "app
  context", so the CLI (`400 App context required`) and the cell (empty
  machine-token namespace) can't touch it (see `code-investigation.md`).
  Reserve app KV for genuinely **UI/per-user** state: read/ack markers,
  draft notes, view prefs — where the browser *is* the writer.
- **Refold-events-on-read** is also not the default — we don't fold the
  whole event history on every list.

The store that fits is a **Cribl Search lookup/collection** — a KV-style,
mutable, key→row store that the **continuous engine can write** (a
scheduled search via `export to lookup`; it's group-scoped, so the cell
and CLI reach it through the same `/m/default_search/…` API the
provisioner already uses — not app-context-limited), that the **app reads
fast** (a lookup read), and that works **flag-off**. So:

- **Current incident state = a lookup row** (status, severity, services,
  `root_service`, timestamps, `summary_md`, investigation/alert refs).
  This is the "store, not search" for mutable state.
- **Timeline = append-only** — dataset events, or a bounded JSON array on
  the lookup row. The append log is the audit trail; the row is the fast
  read.

The **dataset** remains the shared *event* substrate both sides converge
on for the append log and cross-writer signals — the app reads/writes it
(flag off) and the cell already commits `record_kind:'investigation'`
events to it (flag on). But the *hot read path* is the lookup row, not a
fold.

**Spike:** confirm whether the lookup is written via `export to lookup`
(search) or a direct lookups REST API from the cell — either way it's a
KV row, not a refold.

### What degrades when the investigator is off

| Capability | Flag OFF (Cribl Search only) | Flag ON (+ cell) |
|---|---|---|
| Open / group alerts into incidents | ✅ saved search | ✅ |
| State machine, severity | ✅ app | ✅ |
| Timeline + human notes | ✅ | ✅ |
| Markdown summary | ✅ deterministic template | ✅ + agent root-cause |
| Resolve / archive / retention | ✅ | ✅ |
| **Automated investigations as children** | ❌ | ✅ |
| **Agent-authored root cause / supervisor** | ❌ | ✅ |

## The Incident entity (a simple warroom)

```
Incident
  id                incident-<uuid>
  title             human/agent-authored ("payment charge failures")
  status            open | investigating | identified | mitigated
                    | resolved | closed          (state machine, below)
  severity          sev1 | sev2 | sev3 | sev4     (agent-proposed, human-overridable)
  services[]        affected services (the alert set's union)
  root_service      the downstream-most erroring node (graph-derived)
  opened_at         first alert / first signal
  updated_at        last timeline entry
  resolved_at       all alerts cleared (+ debounce)
  closed_at         archived (== archived_at for incidents)
  summary_md        auto-generated markdown, regenerated on transitions
  timeline[]        append-only, timestamped (below)
  alerts[]          alert event_ids rolled into this incident
  investigations[]  child investigation ids
```

### Warroom parallel

| Warroom concept | Incident field |
|---|---|
| incident channel | the Incident itself |
| status (triggered→resolved) | `status` |
| severity (SEV1–4) | `severity` |
| pinned exec summary | `summary_md` (auto-maintained) |
| channel messages / updates | `timeline[]` |
| automated responder findings | child investigations |
| incident commander keeping the summary current | the supervisor agent (P4.4-B) |

### State machine

```
        alert fires
           │
           ▼
        ┌──────┐  investigation starts  ┌───────────────┐
  ─────▶│ open │───────────────────────▶│ investigating │
        └──────┘                        └──────┬────────┘
                                               │ root cause in a summary
                                               ▼
                                        ┌────────────┐  action taken   ┌───────────┐
                                        │ identified │────────────────▶│ mitigated │
                                        └─────┬──────┘                 └─────┬─────┘
                                              │  all alerts cleared          │
                                              ▼        (+ debounce)          ▼
                                        ┌──────────┐◀───────────────────────┘
                                        │ resolved │
                                        └────┬─────┘
                                             │ retention age / manual close
                                             ▼
                                        ┌────────┐
                                        │ closed │  (== archived; terminal)
                                        └────────┘
```

- `mitigated` is optional — a fast incident can go `identified → resolved`.
- **Re-fire while resolved-not-closed ⇒ reopen** (back to `investigating`),
  not a new incident. Flapping alerts must not churn incidents.
- **Only a `closed` incident lets a new fire open a fresh incident.**
- Transitions are driven by three actors: **system** (alerts open/attach,
  all-cleared → resolved, age → closed), **agent** (open→investigating,
  investigating→identified when a root-cause summary lands, proposes
  severity), **human** (any transition, notes, severity override, reopen).

### Timeline (notes with timestamps)

Append-only, the warroom log. One row:

```
TimelineEntry
  seq       monotonically increasing
  ts        epoch ms
  author    agent | human | system
  kind      note | status_change | severity_change | alert
            | investigation | finding
  text      markdown (for note/finding) or a rendered line
  ref       optional (investigation id, alert event_id)
```

- **Humans** add `note`s (the warroom chat) and status/severity changes.
- **The agent** adds `finding`s as investigations conclude, and its
  `status_change` to `identified`.
- **The system** adds `alert` (fired/cleared), `investigation`
  (started/concluded), and automatic `status_change` rows.

The timeline is the source of truth; `summary_md` is its distillation.

### Auto-generated markdown summary

`summary_md` is regenerated (by the supervisor agent, falling back to a
deterministic template when no LLM) on every material transition — a new
investigation concludes, status/severity change, resolve. Shape:

```markdown
# <title>  · SEV2 · investigating
**Services:** payment, checkout, frontend  **Root:** payment
**Opened:** 14:02 (23m ago)  **Duration:** 23m (ongoing)

## Root cause
<from the child investigations' summaries, correlated by the supervisor>

## Impact
<affected services + blast radius from the dependency graph>

## Timeline
- 14:02 alert: payment error-rate 12% (firing)
- 14:03 investigation inv-… started
- 14:07 finding: charge.js flag-gated failure (paymentFailure)
- 14:05 alert: checkout error-rate 4% (downstream)
…

## Investigations
- [payment:error_rate](…) — concluded
- [checkout:error_rate](…) — concluded (downstream victim)
```

This is the incident's living doc — the thing a human reads first and the
thing we could later post to a real warroom channel or a postmortem.

## Alerts ↔ Incidents

This is the crux, and it's the standard **alert→incident aggregation**
(à la Alertmanager grouping / PagerDuty): **many alerts roll into one
incident, and the incident's lifecycle is partly driven by the aggregate
alert state.** Alerts are the noisy, transient, per-condition *signal*;
the incident is the deduplicated, stateful, human-managed *unit of work*.

The grouping function is **time window + service-dependency adjacency**:

- **First fire, no nearby open incident** ⇒ **open** a new incident;
  its `root_service` starts as the alert's service.
- **Fire while a graph-adjacent incident is open** (within window W) ⇒
  **attach**: add the alert to `alerts[]` + a timeline row, extend
  `services[]`, recompute `root_service` (downstream-most in the affected
  subgraph), possibly bump `severity` (more services / deeper node), and
  attach or coalesce an investigation (below).
- **Alert clears** ⇒ timeline row; the incident resolves only when
  **all** its alerts have cleared and stayed cleared for a debounce
  window D (guards flapping).
- **Fire after `resolved`, before `closed`** ⇒ **reopen** the same
  incident.
- **Fire after `closed`** ⇒ new incident.

Severity is derived from the alert set: error-rate magnitude × number of
services × criticality of `root_service` (the graph gives blast radius).
Agent proposes, human overrides.

**Signal source.** The evaluator already emits both `firing` and
`resolved` events (`event_type in firing|resolved`). Today only firing
rows trigger the cell (`criblapm__alert_notify`, last-15m firing). Add a
**resolved notify → `/internal/resolve`** so clearing drives incident
resolution. Until that's wired, incidents can fall back to age-based
resolution (no fresh fire for T minutes ⇒ resolved).

## Investigations ↔ Incidents

An investigation becomes a **child of an incident** (`incident_id` on the
InvestigationDO + coordinator row). Two layers reduce N-investigations to
one root cause:

### Layer A — coalesce at admission (build first; cheap, high ROI)

The CoordinatorDO already sees every fire, dedups exact retries on
`event_id`, and gates concurrency. Extend admission: when a fire attaches
to an existing open incident, **don't spawn a second autonomous
investigation** if one is already running/recent for that incident —
attach the new service as an additional signal to the existing
investigation's seed instead. The seed lists **all** affected services;
the agent root-causes across them in one pass, using the dependency graph
to separate root from victims.

- **The dependency graph is the key input.** The app already computes it
  for the Service Map. Push it to the coordinator the same way repos are
  pushed — `POST /config/graph`, mirror of `/config/repos` — on provision
  / Settings save. `root_service` ≈ the downstream-most erroring node in
  the affected subgraph; `checkout`/`frontend` erroring because `payment`
  is down are *victims*, and the graph makes that legible to the agent.
- Directly relieves the `MAX_CONCURRENT=1` search-pool constraint: fewer
  concurrent investigations, less storm. For many cascades, one
  graph-aware investigation *is* the whole answer.
- **Risk:** over-coalescing two independent incidents in the same window.
  Keep W conservative and require graph adjacency; Layer B can split.

### Layer B — supervisor / agent-of-agents (build second; higher-order)

Coalescing misses things (fired outside W, or looks unrelated but isn't).
A **supervisor** triggers when ≥K investigations conclude in a window: it
reads their **summaries** (not re-running searches — cheap), plus the
graph, and emits the incident-level **root cause** + `summary_md`,
grouping the children ("root: payment; checkout/frontend downstream").

- Reconciles at a layer coalescing can't (semantic similarity across
  independent investigations); can also **split** an over-coalesced
  incident.
- Cheap relative to the investigations themselves (summaries in, one
  synthesis out).
- Powers the **Incident view**: one root cause with per-service
  investigations nested under it — which is also the unit we archive.

**Sequencing:** A cuts the *number* of investigations (saves cost + search
pool); B correlates the residual and writes the incident narrative. Build
A first (cheaper, attacks the concurrency constraint); add B for the
complex cases and the incident UX.

## Lifecycle & archival (Problem 1, shippable now)

Separate two axes that are currently conflated:

- **Lifecycle** (the agent): `queued → running → idle →
  concluded/failed/cancelled`.
- **Shelf state** (the operator): `active` vs `archived`.

They're orthogonal — a concluded investigation can still be "active"
(fired 10 min ago) or "archived" (last Tuesday). **Close = archive**, a
nullable `archived_at`/`closed_at`, independent of terminal status.
Reopening (a new message, or a re-fire) un-archives.

**When to archive — three triggers, in value order:**

1. **Incident resolved** (best): `resolved` notify → archive the
   incident's investigations with a "condition cleared" note.
2. **Age**: terminal (or idle-interactive) and untouched for N days.
3. **Manual**: a Close button; immediate.

**Lazy now, cron later:**

- **The view is lazy — zero background work.** "Archived" is mostly
  *derived*: the list query defaults to
  `archived_at IS NULL AND NOT (terminal AND concluded_at < now - RETENTION)`.
  Search / an "Archived" toggle drops the filter. Correct the instant it
  ships. Stored `archived_at` only needs to exist for *manual* and
  *resolve*-driven close.
- **A durable self-re-arming CoordinatorDO alarm is our "cron" today** —
  no wait for celld 0.3.0. The InvestigationDO already relies on durable
  alarms + a watchdog; the coordinator arms an hourly sweep that stamps
  `archived_at` on aged rows. Swap the alarm for celld cron when 0.3.0
  lands — same logic, cleaner trigger.
- **Cron's real job is retention/pruning** (genuinely needs a scheduler):
  after M months, delete the heavy transcript (`agent_messages` +
  `transcript_events`) but **keep the summary row** so search still finds
  it. That's what bounds S3 growth.

**UI:** the recall sidebar defaults to active; an "Archived" section
(collapsed) or filter chip; search spans both; Close/Reopen actions. The
existing recall panel already has keyset pagination + search — archived is
one more `WHERE`.

## Store & topology

**Current state = a lookup row; the append log = dataset events; the
engine = a scheduled search.** (See "Where state lives" above.) The
lookup row holds an incident's mutable state (status, severity, services,
`root_service`, `summary_md`, refs); the dataset carries the append-only
`record_kind:'incident'` events — `opened | attached | status_change |
severity_change | note | investigation_linked | resolved | closed`, each
with `incident_id`, `ts`, `author`, payload — as the audit log and the
cross-writer signal. **Incidents exist and mutate entirely within Cribl
Search**, with no cell and no browser required.

- **Grouping (alerts→incidents)** is a saved search: it folds `firing`
  alert rows over a window, joins the service-dependency graph (a
  lookup), and assigns a **deterministic** `incident_id` (hash of the
  incident window + `root_service`) so retries/overlap collapse
  idempotently — the same discipline as the alert evaluator. This is the
  flag-off coalescing: "detect multiple in a row and group them" done in
  KQL.
- **Listing/recall** reads a materialized incidents lookup maintained by a
  scheduled search (the existing panel-cache pattern), so the incident
  list is one fast lookup read, not a live fold.
- **Human writes** (notes, status/severity, close/reopen) append
  `incident` events via `export to search` — the mechanism the app
  already uses for dataset writes. No cell required.
- **Summary** is a deterministic template rendered by the app from the
  incident's events + alert data; when the cell is on, the supervisor
  agent overwrites `summary_md` with a root-caused version (also an
  `incident` event, so it folds in naturally).

**Cell topology (flag on) — an accelerator/executor, never the source of
truth.** The existing coordinator + per-object DOs stay, and gain an
incident-aware role, but they read/write incident state through the
dataset:

- **CoordinatorDO** — on a fire, consults the current incident grouping
  (from the dataset/lookup) to decide **attach vs spawn** an investigation
  (Layer A coalescing), and links investigations to their `incident_id`.
  Holds `/config/graph`; runs the self-re-arming sweep alarm for
  age-archival until celld cron lands. Admission is race-free (single
  threaded), so attach/link is idempotent under webhook retries — the same
  guarantee `event_id` dedup relies on.
- **InvestigationDO** — unchanged, gains `incident_id`; commits it on its
  lifecycle events so the grouping search can nest it under the incident.
- **Supervisor** (Layer B) — reads concluded children's summaries, writes
  the incident's root-cause `summary_md` event.

There is deliberately **no cell-canonical IncidentDO**: the incident lives
in the dataset so it survives the cell being off or down. A low-latency
incident-timeline read *could* later be served by the cell as an
accelerator (like it serves investigation transcripts), with the dataset
still canonical — but that's an optimization, not v1.

## Read / write surface

**Primary path is Cribl-Search-native (flag off or on).** The app reads
incidents from the materialized lookup / dataset and writes human actions
(notes, status, severity, close/reopen) as `incident` events via `export
to search` — the same read/write substrate as alerts. No cell endpoints
are involved for the human warroom.

**Cell endpoints exist only for the flag-on enrichment** and never own
incident state:

```
POST /config/graph                  push the service dependency graph (like /config/repos)
POST /internal/resolve              resolved-alert notify → nudge resolution (optional; the
                                    grouping search can also resolve on all-cleared)
```

The cell links investigations to incidents by stamping `incident_id` on
the `record_kind:'investigation'` lifecycle events it already commits, and
the supervisor writes the root-caused `summary_md` as an `incident` event.
Investigation endpoints gain `incident_id` in their status payload;
`GET /investigations` gains an `archived` filter.

## Phasing (P4.4)

Ordered so the **cell-independent core lands first** (works with the
investigator off), then the flag-on enrichment:

1. **Incident model, Cribl-Search-native** (app + dataset): the
   `record_kind:'incident'` event contract; the alerts→incidents grouping
   saved search (window + graph lookup + deterministic `incident_id`); the
   materialized incidents lookup; the state fold. *No cell.*
2. **Incident UI + human warroom** (app): incidents recall list, detail,
   timeline, human notes / status / severity / close-reopen, deterministic
   `summary_md`. "Archived" hidden-by-default with search across all. *No
   cell.*
3. **Archival + sweep** (app): lazy derived archived filter; retention via
   a scheduled search (and/or the cell's self-re-arming alarm when on).
   Migrate the sweep to celld 0.3.0 cron when it lands.
4. **Investigator ↔ incident linkage** (cell + app, flag on):
   `incident_id` on investigations; coordinator **attach-vs-spawn**
   coalescing consulting the grouping; `/config/graph`.
5. **`resolved` notify → resolution** (app provisioning + optional cell):
   drive incident resolution + resolve-driven archival off the evaluator's
   `resolved` events.
6. **Supervisor agent + Incident view** (cell + app, flag on):
   agent-of-agents over concluded investigations → agent-authored
   root-cause `summary_md`; nested Incident UI.

Steps 1–3 answer Problem 1 **and** stand alone with the investigator off.
4 is the cheap, high-leverage piece of Problem 2; 6 is the higher-order
win. The app never depends on the cell for incidents; each of 4–6
degrades to its step-1–3 baseline when the flag is off.

## Risks & tradeoffs

- **Over-coalescing** independent incidents → conservative window + graph
  adjacency; the supervisor (B) can split.
- **Under-coalescing** → the supervisor catches what admission misses.
- **Supervisor cost** — bounded: it reads summaries, not raw searches.
  Coalescing *saves* cost (fewer deep investigations).
- **Flapping** alerts → resolve debounce D + reopen-not-recreate.
- **Storage** → retention/prune keeps summaries, drops transcripts.
- **celld 0.3.0 cron** not required — durable coordinator alarm covers
  the sweep today; cron is a cleaner trigger, not a blocker.
