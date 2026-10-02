/**
 * GoatTown provisioning that lives OUTSIDE the saved-search reconcile:
 * the webhook notification target and the alert-notify → target binding.
 *
 * Shared so `scripts/provision.ts` (CLI) and the Settings "Apply" step run
 * the IDENTICAL logic — the divergence where the UI created the search but
 * not the target/binding was a bug. The HTTP work is the framework's
 * `@criblio/app-utils/notifications`; this module only declares APM's
 * target and binding.
 *
 * A saved search's notifications are a SEPARATE resource under
 * `/m/<group>/notifications`; writing `schedule.notifications` in the
 * search body is silently dropped (the server keeps `{}`), which is why
 * the trigger never fired. Callers bind with
 * `ensureSavedSearchNotification(http, ALERT_NOTIFY_BINDING)` AFTER the
 * target exists and the search is provisioned, and unbind with
 * `removeSavedSearchNotification(http, ALERT_NOTIFY_BINDING)`.
 */
import {
  ensureNotificationTarget,
  type NotificationTarget,
  type SavedSearchNotification,
} from '@criblio/app-utils/notifications';
import type { HttpClient } from './provisioner';
import { CELL_WEBHOOK_TARGET_ID } from './provisionedSearches';

/** The saved search whose results fire the cell webhook. */
export const ALERT_NOTIFY_SEARCH_ID = 'criblapm__alert_notify';

/**
 * alert_notify → cell webhook. Framework defaults supply the rest of the
 * record exactly as APM always wrote it: id
 * `criblapm__alert_notify_Notification_1`, group `default_search`,
 * `disabled: false`, trigger `resultsCount > 0`, and per-target conf
 * `{ includeResults: true, attachmentType: 'inline' }` (the cell needs the
 * rows inlined). Pinned field-for-field by alertNotifyPlan.test.ts.
 */
export const ALERT_NOTIFY_BINDING: SavedSearchNotification = {
  searchId: ALERT_NOTIFY_SEARCH_ID,
  targetId: CELL_WEBHOOK_TARGET_ID,
  conf: {
    message: 'Cribl APM: firing alert(s) — triggering server-side investigation.',
  },
};

export interface CellWebhookConfig {
  /** Shared GoatTown base URL. */
  cellUrl: string;
  /** The bearer the target sends to /alerts/fire. */
  bearer: string;
}

/** The webhook notification target the alert-notify search fires at. */
export function cellWebhookTarget({ cellUrl, bearer }: CellWebhookConfig): NotificationTarget {
  return {
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
}

/** Create/update the cell webhook target. Idempotent. */
export function ensureCellWebhookTarget(
  http: HttpClient,
  config: CellWebhookConfig,
): Promise<'created' | 'updated'> {
  return ensureNotificationTarget(http, cellWebhookTarget(config));
}
