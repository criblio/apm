/**
 * APM's GoatTown alert trigger: the webhook notification target and the
 * alert-notify → target binding, declared for the framework provisioner.
 *
 * Both are written by the framework's single apply path
 * (`applyProvisioningActions`, behind `reconcile()` and the Settings
 * `<ProvisioningPanel>` Apply): `APM_PROVISIONER_CONFIG.notifications` is
 * `alertNotifyBindings`, and each caller supplies `notificationTargets` —
 * the CLI from its environment (`cliCellWebhookTargets`), Settings from the
 * connected-app credential in KV (`settingsCellWebhookTargets`). The
 * framework ensures the targets after the searches are written and before
 * the bindings, skips a binding whose target failed, and unbinds a search
 * it deletes. The CLI and the UI share that code, so they cannot diverge
 * (the UI once created the search but not the target/binding).
 *
 * A saved search's notifications are a SEPARATE resource under
 * `/m/<group>/notifications`; writing `schedule.notifications` in the
 * search body is silently dropped (the server keeps `{}`), which is why
 * the trigger never fired.
 */
import {
  type NotificationTarget,
  type SavedSearchNotification,
} from '@criblio/app-utils/notifications';
import type { ProvisioningExtraStep } from '@criblio/app-utils/provisioning-panel';
import { CELL_WEBHOOK_TARGET_ID } from './provisionedSearches';
import { getServerInvestigations } from './serverInvestigations';

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

/**
 * `ProvisionerConfig.notifications`: alert_notify → cell webhook while
 * server investigations is on, nothing while it is off. Off still declares
 * the (empty) list, so the apply path unbinds alert_notify before the
 * reconcile deletes it.
 */
export function alertNotifyBindings(): SavedSearchNotification[] {
  return getServerInvestigations() ? [ALERT_NOTIFY_BINDING] : [];
}

/**
 * The connected-app credential as stored in KV, as the bearer the target
 * sends: trimmed, a JSON-encoded string unwrapped (a value someone stored
 * as `"gt_a1_…"` reads as the string inside), empty → null. The framework's
 * `kvGetText` returns the value verbatim; this is the normalisation APM's
 * former local reader applied.
 */
export function bearerFromKvText(raw: string | null): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'string') return parsed.trim() || null;
  } catch {
    /* raw text — the normal case */
  }
  return trimmed;
}

/** `notificationTargets` for `scripts/provision.ts`: the target from the
 *  environment's bearer, or none (Settings provisions it from KV). */
export function cliCellWebhookTargets(env: {
  cellUrl: string | undefined;
  bearer: string | undefined;
}): NotificationTarget[] {
  if (!getServerInvestigations() || !env.cellUrl || !env.bearer) return [];
  return [cellWebhookTarget({ cellUrl: env.cellUrl, bearer: env.bearer })];
}

export interface SettingsCellTargetDeps {
  cellUrl: () => string;
  /** GoatTown's "Allow alert firing" capability for this connection. */
  canFireAlerts: () => Promise<boolean>;
  /** The connected-app credential's raw KV text (null when absent).
   *  A rejection (KV misroute) propagates. */
  readCredential: () => Promise<string | null>;
  credentialKey: string;
  /** Receives a not-ok result row for each reason the target was skipped. */
  report: (step: ProvisioningExtraStep) => void;
}

/**
 * `notificationTargets` for the Settings Apply. Returns the target when
 * server investigations is on, GoatTown grants alert firing and the
 * credential is in KV; otherwise none, with the reason reported. Returning
 * no target leaves the binding to be written (against a target an earlier
 * Apply created), as the former afterReconcile step did. A failed KV read
 * throws, which the framework reports as target `*` and which skips the
 * binding — the former step also stopped before binding on that throw.
 *
 * Cribl's alert fires server-side, so the target must carry a literal
 * bearer — the webhook target schema allows only none/basic/token, with no
 * `credentialsSecret`/`textSecret` reference (probed against the live
 * API). So the credential is inlined, and the API returns it in plaintext
 * to any reader of notification targets. Given that exposure, the
 * connected-app credential is the right one to inline rather than the
 * installation webhook token: it can be rotated from Connections →
 * Connected apps, whereas gt_w1_ is a one-shot enrolment secret.
 */
export async function settingsCellWebhookTargets(deps: SettingsCellTargetDeps): Promise<NotificationTarget[]> {
  if (!getServerInvestigations()) return [];
  // The capability is the only correct check: it is absent unless an
  // administrator has enabled "Allow alert firing" on this connection.
  let mayFire: boolean;
  try {
    mayFire = await deps.canFireAlerts();
  } catch (err) {
    deps.report({
      label: 'Webhook target: skipped',
      ok: false,
      detail: `Could not read GoatTown capabilities: ${err instanceof Error ? err.message : String(err)}`,
    });
    return [];
  }
  if (!mayFire) {
    deps.report({
      label: 'Webhook target: skipped',
      ok: false,
      detail: 'GoatTown has not granted this app connection alert firing. '
        + 'A tenant administrator enables it under Connections → Connected apps; '
        + 'it is off by default because an external event can start billable work.',
    });
    return [];
  }
  const bearer = bearerFromKvText(await deps.readCredential());
  if (!bearer) {
    deps.report({
      label: 'Webhook target: skipped',
      ok: false,
      detail: `No connected-app credential in kv.${deps.credentialKey}. `
        + 'Deliver it from GoatTown\'s console, or paste it above.',
    });
    return [];
  }
  return [cellWebhookTarget({ cellUrl: deps.cellUrl(), bearer })];
}
