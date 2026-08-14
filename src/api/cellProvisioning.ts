/**
 * Investigator-cell provisioning steps that live OUTSIDE the generic
 * saved-search reconcile: the webhook notification target and the
 * alert-notify → target binding.
 *
 * Both are shared so `scripts/provision.ts` (CLI) and the in-app
 * Settings "Provision" flow run the IDENTICAL logic — the divergence
 * where the UI created the search but not the target/binding was a bug.
 *
 * The binding is the subtle one: a Cribl saved search's notifications
 * are a SEPARATE resource under `/m/<group>/notifications`, JOINed into
 * the search's `schedule.notifications` only on read. Writing
 * `schedule.notifications` in the search body is silently ignored (the
 * server keeps `{}`), which is why the trigger never fired. The
 * notification must be POST/PUT to the notifications endpoint.
 */
import type { HttpClient } from './provisioner';
import { CELL_WEBHOOK_TARGET_ID } from './provisionedSearches';

/** The saved search whose results fire the cell webhook. */
export const ALERT_NOTIFY_SEARCH_ID = 'criblapm__alert_notify';
/** The notification record id — Cribl's convention is
 *  `<savedQueryId>_Notification_<n>`. */
export const ALERT_NOTIFY_NOTIFICATION_ID = `${ALERT_NOTIFY_SEARCH_ID}_Notification_1`;

const SEARCH_GROUP = 'default_search';
const NOTIFICATIONS_PATH = `/m/${SEARCH_GROUP}/notifications`;

export interface CellWebhookConfig {
  /** Cell base URL, e.g. https://54-71-34-177.sslip.io */
  cellUrl: string;
  /** The cell's WEBHOOK_BEARER (its /alerts/fire bearer). */
  bearer: string;
}

/** True when a by-id GET actually returned a row. The Cribl API answers
 *  a missing id with `200 {items:[],count:0}` (NOT a 404), so "the GET
 *  didn't throw" is not "it exists". */
function existsFromGet(resp: unknown): boolean {
  const r = resp as { count?: number; items?: unknown[] } | null;
  return (r?.count ?? r?.items?.length ?? 0) > 0;
}

/**
 * Create/update the webhook notification target the alert-notify search
 * fires at. Idempotent: PATCH when it already exists, POST otherwise.
 */
export async function ensureCellWebhookTarget(
  http: HttpClient,
  { cellUrl, bearer }: CellWebhookConfig,
): Promise<'created' | 'updated'> {
  const body = {
    id: CELL_WEBHOOK_TARGET_ID,
    type: 'webhook',
    method: 'POST',
    url: `${cellUrl.replace(/\/$/, '')}/alerts/fire`,
    format: 'custom',
    customContentType: 'application/json',
    // The cell's extractAlerts accepts { results: [...] }; `events` is
    // the per-batch result set in the target's expression context.
    customSourceExpression: '`${JSON.stringify({ savedQueryId, message, results: events })}`',
    customPayloadExpression: '`${events}`',
    authType: 'token',
    token: bearer,
    onBackpressure: 'drop',
  };
  const path = `/notification-targets/${CELL_WEBHOOK_TARGET_ID}`;
  let exists = false;
  try {
    exists = existsFromGet(await http.get(path));
  } catch {
    exists = false;
  }
  if (exists) {
    await http.patch(path, body);
    return 'updated';
  }
  await http.post('/notification-targets', body);
  return 'created';
}

/**
 * Bind the alert-notify search to the webhook target by creating its
 * notification record. Must run AFTER the target exists and the search
 * is provisioned. Idempotent: PUT when the notification exists, POST
 * otherwise. Writing this via the search body does nothing — it has to
 * go through the notifications resource.
 */
export async function ensureAlertNotification(
  http: HttpClient,
): Promise<'created' | 'updated'> {
  const notification = {
    disabled: false,
    condition: 'search',
    targets: [CELL_WEBHOOK_TARGET_ID],
    conf: {
      triggerType: 'resultsCount',
      triggerComparator: '>',
      triggerCount: 0,
      savedQueryId: ALERT_NOTIFY_SEARCH_ID,
      message: 'Cribl APM: firing alert(s) — triggering server-side investigation.',
    },
    targetConfigs: [
      {
        id: CELL_WEBHOOK_TARGET_ID,
        conf: { includeResults: true, attachmentType: 'inline' },
      },
    ],
    group: SEARCH_GROUP,
    id: ALERT_NOTIFY_NOTIFICATION_ID,
  };
  const path = `${NOTIFICATIONS_PATH}/${ALERT_NOTIFY_NOTIFICATION_ID}`;
  let exists = false;
  try {
    exists = existsFromGet(await http.get(path));
  } catch {
    exists = false;
  }
  if (exists) {
    await http.patch(path, notification);
    return 'updated';
  }
  await http.post(NOTIFICATIONS_PATH, notification);
  return 'created';
}

/** Remove the alert-notify notification (used when server investigations
 *  is turned off). Best-effort — a missing record is not an error. */
export async function removeAlertNotification(http: HttpClient): Promise<void> {
  try {
    await http.del(`${NOTIFICATIONS_PATH}/${ALERT_NOTIFY_NOTIFICATION_ID}`);
  } catch {
    /* already gone */
  }
}
