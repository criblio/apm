/**
 * Server-side investigations gate. When ON, three things activate:
 *
 *   1. Provision-time: `getProvisioningPlan()` includes the
 *      `criblapm__alert_notify` scheduled search that webhooks firing
 *      alerts to the investigator cell — so toggling requires a
 *      re-provision to start/stop the trigger.
 *   2. UI: the Alerts page renders "Investigating…"/"Investigated"
 *      badges and drill-ins to server-run investigation transcripts.
 *   3. The cell itself re-reads this flag from the app's KV on every
 *      trigger and drops new work when it's off — so flipping the
 *      Settings toggle stops new investigations within ~a minute,
 *      before a re-provision removes the trigger search.
 *
 * OFF by default: the feature ships dark until a deployment opts in.
 * Design: docs/research/server-investigations/design.md.
 */

let enabled = false;
const listeners = new Set<() => void>();

export function getServerInvestigations(): boolean {
  return enabled;
}

export function setServerInvestigations(v: boolean): void {
  if (v === enabled) return;
  enabled = v;
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* listener errors shouldn't block others */
    }
  }
}

export function subscribeServerInvestigations(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
