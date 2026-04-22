# Alerting System Design

## Problem statement

The Detected Issues panel shows what's wrong *right now*, but it has
no memory. When you close the browser, the signals disappear. There's
no notification if something goes wrong while you're not looking, no
history of what fired and when, and no way to suppress noise from
flapping services. We need a real alerting system.

## Design principles

1. **Batteries included** — auto-alerts fire from detected issues
   with zero user configuration. Day-one value without setup.
2. **Lean on Cribl Search** — notifications use Cribl's built-in
   notification targets (Slack, email, PagerDuty, webhooks). We
   don't build our own notification dispatch.
3. **State machine, not threshold checks** — alerts have lifecycle
   states (ok → pending → firing → resolving → ok) with debounce
   at each transition. Prevents flapping.
4. **Clear messages** — when an alert resolves, send a "resolved"
   notification with duration and details.
5. **Suppression** — don't re-notify on every evaluation cycle while
   an alert is still firing. Configurable re-notify interval.

## Two categories of alerts

### Auto-alerts (system-managed)

Generated automatically from the health signals the app already
computes. No user configuration needed. Types:

| Signal | Auto-alert ID pattern | Fires when |
|---|---|---|
| Error rate | `auto:error_rate:{service}` | Error rate crosses warn/critical AND is a new/worsening error (not baseline) |
| Traffic drop | `auto:traffic_drop:{service}` | Request rate fell >=50% vs prior window |
| Latency anomaly | `auto:latency:{service}:{operation}` | Operation p95 >= 5x baseline |
| Service silent | `auto:silent:{service}` | Service had traffic in prior window, zero now |

Auto-alerts are ephemeral — they're created when the condition is
detected and removed when it resolves. They don't persist in the
alert definitions store; they're derived from the health data on
each evaluation cycle.

**Notification targets for auto-alerts:** A global setting in
Settings ("Auto-alert notification target") configures where all
auto-alert notifications go by default — Slack, email, PagerDuty,
webhook, or none. Individual auto-alerts can be overridden on the
Alerts page (e.g., silence a specific noisy service, or route a
critical service's alerts to a different PagerDuty escalation).
This gives day-one value with one setting, and per-alert control
for power users.

### User-created alerts (persistent)

Created via the UI. Persisted in KV. Types:

- **From detected issue** — "Create alert from this issue" pre-fills
  the service + condition. The user adds a notification target and
  optionally adjusts the threshold.
- **From Service Detail** — "Alert on this service" with a
  threshold form (error rate > N%, p95 > Nms, rate drops > N%).
- **Custom KQL** — power-user escape hatch: write a KQL query that
  returns rows when the condition is met.

Each user-created alert becomes a Cribl saved search with a
notification target. The saved search runs on the configured
cadence and fires through Cribl's notification infrastructure.

## Alert lifecycle (state machine)

```
  [condition false]
       ┌──────┐
       │      ▼
 ┌─────┴──┐  ┌──────────┐  [bad × fireAfter]  ┌─────────┐
 │   OK   │──│ PENDING  │─────────────────────▶│ FIRING  │
 └────────┘  └──────────┘                      └────┬────┘
       ▲      [good] │                              │
       └─────────────┘                              │
       ▲                                            │
       │  [good × clearAfter]  ┌───────────┐ [good] │
       └───────────────────────│ RESOLVING │◀───────┘
                               └───────────┘
                                [bad] │
                                      │
                                ┌─────┘
                                ▼
                            [back to FIRING]
```

**State transitions:**

| From | Condition | To | Action |
|---|---|---|---|
| OK | bad evaluation | PENDING | increment `consecutiveBad` |
| PENDING | bad, count < `fireAfter` | PENDING | increment `consecutiveBad` |
| PENDING | bad, count >= `fireAfter` | FIRING | **NOTIFY: firing** |
| PENDING | good | OK | reset counts |
| FIRING | bad | FIRING | check `renotifyAfter`; re-notify if interval elapsed |
| FIRING | good | RESOLVING | increment `consecutiveGood` |
| RESOLVING | good, count < `clearAfter` | RESOLVING | increment `consecutiveGood` |
| RESOLVING | good, count >= `clearAfter` | OK | **NOTIFY: resolved** (with duration) |
| RESOLVING | bad | FIRING | reset `consecutiveGood` |

**Default debounce settings:**

| Parameter | Default | Why |
|---|---|---|
| `fireAfter` | 2 consecutive bad | Prevents single-evaluation spikes from alerting |
| `clearAfter` | 3 consecutive good | Prevents premature "resolved" during recovery oscillation |
| `renotifyAfter` | 30 minutes | Re-notify while still firing, but not every cycle |

With a 5-minute cadence, `fireAfter=2` means an alert fires after
10 minutes of sustained anomaly. `clearAfter=3` means it resolves
after 15 minutes of sustained good. These defaults trade off
speed-to-alert vs noise.

## State storage

Alert state lives in the pack-scoped KV store:

```
alerts/state/{alertId} → AlertState JSON
alerts/definitions/{alertId} → AlertDefinition JSON (user-created only)
```

**AlertState schema:**
```typescript
interface AlertState {
  id: string;
  status: 'ok' | 'pending' | 'firing' | 'resolving';
  consecutiveBad: number;
  consecutiveGood: number;
  firstFiredAt?: string;       // ISO timestamp
  lastFiredAt?: string;
  lastNotifiedAt?: string;
  lastResolvedAt?: string;
  lastEvaluatedAt: string;
  lastDetail?: string;         // human-readable detail from the evaluation
  fireCount: number;           // total times this alert has fired (lifetime)
}
```

**AlertDefinition schema (user-created):**
```typescript
interface AlertDefinition {
  id: string;
  name: string;
  type: 'error_rate' | 'traffic_drop' | 'latency' | 'silent' | 'custom_kql';
  service?: string;
  operation?: string;
  condition: {
    threshold?: number;          // e.g., 0.05 for error rate
    dropThreshold?: number;      // e.g., 0.5 for traffic drop
    p95ThresholdUs?: number;
    baselineMultiplier?: number;
    query?: string;              // for custom_kql
  };
  debounce: {
    fireAfter: number;
    clearAfter: number;
  };
  renotifyAfterMinutes: number;
  notificationTargetId: string;  // Cribl notification target
  enabled: boolean;
  createdAt: string;
  createdFrom?: string;          // "home:detected_issue", "service_detail:payment", etc.
}
```

## Evaluation flow

Each cadence cycle (1m–10m, configurable):

1. **Read current health data** from `criblapm__home_alerts`
   cached results (service summaries with current/prev comparison)
2. **Read latency anomalies** from `criblapm_op_baselines` lookup
   join (existing query)
3. **Derive auto-alert conditions** from the health data (same logic
   as `buildDetectedIssues` but producing alert IDs instead of UI rows)
4. **Read user-created alert definitions** from KV
5. **Evaluate each user-created alert** (run its KQL or check its
   threshold against the cached data)
6. **For each alert (auto + user):**
   - Read current state from KV (or default to `ok`)
   - Apply state machine transition
   - Write updated state to KV
7. **For state transitions that need notification:**
   - Build notification payload (firing or resolved)
   - Dispatch via Cribl notification target API

**Where this runs:** Client-side, on the Home page. The evaluation
triggers on each data refresh (auto-refresh or manual). This means
alerts only evaluate when someone has the app open — BUT the
underlying scheduled searches still run server-side, and user-created
alerts that are Cribl saved searches fire independently.

**Future: server-side evaluation.** If we want alerts to fire when
nobody's looking, we need a scheduled search that reads state from
KV, evaluates conditions, updates state, and dispatches
notifications — all in KQL. This is complex but achievable with
`| lookup` (read state), threshold logic in `| where`/`| extend`,
and `| send` for notifications. Defer to a future iteration.

## Notification payload

**Firing:**
```
🔴 [FIRING] payment — Error rate 12.3% (was 0.2%)
Service: payment
Signal: Error Rate Critical
Detail: Error rate 12.3% (was 0.2%), errors on calls to payment-gateway
First detected: 2026-04-22T10:05:00Z
Duration so far: 10 minutes
Link: https://cribl.cloud/app-ui/apm/service/payment?range=-1h
```

**Resolved:**
```
✅ [RESOLVED] payment — Error rate back to 0.1%
Service: payment
Signal: Error Rate Critical (resolved)
Duration: 25 minutes (10:05 – 10:30 UTC)
Link: https://cribl.cloud/app-ui/apm/service/payment?range=-1h
```

## UI surfaces

### Detected Issues panel (enhanced)

Each row gains a status indicator:
- **New** (yellow dot) — condition detected, in PENDING state
- **Firing** (red dot, pulsing) — alert has been firing for N minutes
- **Resolving** (green dot, fading) — condition cleared, waiting for
  debounce confirmation

Plus a "Create alert" button to persist a user-created alert from
the auto-detected condition.

### Alerts page (new)

A dedicated page listing all alerts (auto + user-created):

| Column | Content |
|---|---|
| Status | ok / pending / firing / resolving (color-coded) |
| Name | Alert name or auto-generated label |
| Service | Service name |
| Type | Error rate / Traffic drop / Latency / Silent / Custom |
| Detail | Last evaluation detail |
| Duration | How long it's been in current state |
| Last fired | Timestamp |
| Notification | Target name or "none" |
| Actions | Edit / Delete / Silence (for user-created) |

### Create Alert dialog

Accessible from:
- Detected issues panel rows ("Create alert")
- Service Detail ("Create alert for this service")
- Alerts page ("New alert")

Fields:
- Name (auto-generated, editable)
- Service (pre-filled from context)
- Condition type (dropdown: Error rate, Traffic drop, Latency, Custom KQL)
- Threshold (context-dependent input)
- Notification target (dropdown from Cribl notification targets)
- Debounce settings (advanced, collapsed by default)

## Implementation phases

### Phase 1: Alert state tracking + Alerts page
- Alert state machine in `src/utils/alertState.ts`
- KV read/write for alert state
- Auto-alert evaluation on Home page refresh
- Alerts page showing current alert states
- Status indicators on Detected Issues panel rows
- No notifications yet

### Phase 2: User-created alerts + notifications
- Create Alert dialog
- AlertDefinition CRUD in KV
- Notification target picker (reads from Cribl API)
- Notification dispatch via Cribl notification target API
- Firing + resolved notification payloads

### Phase 3: Smart alerting polish
- Configurable debounce per alert
- Silence / snooze (suppress notifications for N hours)
- Alert grouping (related alerts from the same incident)
- Alert history (past firings stored in KV or lookup)
- Server-side evaluation via scheduled search (no browser needed)

## Eval suite enhancement (TODO)

Before declaring ROADMAP item 2 complete, enhance the eval harness
(`npm run eval`) to validate that failure scenarios produce detected
issues AND alert state transitions:

1. Flip a flag (e.g., `paymentFailure 50%`)
2. Wait for 2+ cadence cycles
3. Assert: Detected Issues panel shows the service
4. Assert: Alert state for `auto:error_rate:payment` is `firing`
5. Revert the flag
6. Wait for 3+ cadence cycles
7. Assert: Alert state is back to `ok`
8. Assert: A "resolved" transition was recorded

This validates the full lifecycle: detection → alerting → resolution.
