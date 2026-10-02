/**
 * The alert → cell trigger moved from hand-made calls (the Settings
 * `afterReconcile` step and `scripts/provision.ts` called
 * `ensureNotificationTarget(cellWebhookTarget(...))` and then
 * `ensureSavedSearchNotification(ALERT_NOTIFY_BINDING)` after the
 * reconcile) into the framework apply path:
 * `ProvisionerConfig.notificationTargets` + `notifications`.
 *
 * The provisioned objects must be identical — same target id and body, same
 * binding id, group, target and fields — so an upgraded workspace sees
 * `updated` with no field changes, not a second target or binding. These
 * tests replay both paths against one recording HTTP fake and compare every
 * notification write.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { setCurrentDataset } from '@criblio/app-utils/dataset';
import {
  ensureNotificationTarget,
  ensureSavedSearchNotification,
  notificationTargetsPath,
  notificationsPath,
  removeSavedSearchNotification,
} from '@criblio/app-utils/notifications';
import {
  applyProvisioningActions,
  diffProvisioned,
  listProvisioned,
  type HttpClient,
  type ProvisionerConfig,
} from '@criblio/app-utils/provisioner';
import { APM_PROVISIONER_CONFIG } from '../provisioner';
import { CELL_WEBHOOK_TARGET_ID, CRIBLAPM_PREFIX, getProvisioningPlan } from '../provisionedSearches';
import {
  ALERT_NOTIFY_BINDING,
  ALERT_NOTIFY_SEARCH_ID,
  bearerFromKvText,
  cellWebhookTarget,
  cliCellWebhookTargets,
  settingsCellWebhookTargets,
  type SettingsCellTargetDeps,
} from '../cellProvisioning';
import { setServerInvestigations } from '../serverInvestigations';

setCurrentDataset('otel');
afterEach(() => setServerInvestigations(false));

const CELL = { cellUrl: 'https://goattown-shared.lab.cribl.io', bearer: 'gt_a1_test-credential' };
const NOTIFICATION_ID = 'criblapm__alert_notify_Notification_1';

interface Write {
  method: 'post' | 'patch' | 'del';
  path: string;
  body?: unknown;
}

/** A Cribl API fake: saved searches, notification targets and
 *  notifications held in maps; every write recorded in order. */
function fakeCribl(seed: { searches?: string[]; targets?: string[]; notifications?: Array<{ id: string; savedQueryId: string }> } = {}) {
  const searches = new Map<string, Record<string, unknown>>(
    (seed.searches ?? []).map((id) => [id, { id }]),
  );
  const targets = new Set(seed.targets ?? []);
  const notifications = new Map((seed.notifications ?? []).map((n) => [n.id, n]));
  const writes: Write[] = [];
  const savedBase = '/m/default_search/search/saved';
  const http: HttpClient = {
    async get(path) {
      if (path.startsWith(`${savedBase}?`)) return { items: [...searches.values()] };
      if (path.startsWith(`${notificationsPath()}?`)) {
        return { items: [...notifications.values()].map((n) => ({ id: n.id, conf: { savedQueryId: n.savedQueryId } })) };
      }
      if (path.startsWith(`${notificationTargetsPath()}/`)) {
        const id = decodeURIComponent(path.slice(notificationTargetsPath().length + 1));
        return targets.has(id) ? { count: 1, items: [{ id }] } : { count: 0, items: [] };
      }
      if (path.startsWith(`${notificationsPath()}/`)) {
        const id = decodeURIComponent(path.slice(notificationsPath().length + 1));
        return notifications.has(id) ? { count: 1, items: [{ id }] } : { count: 0, items: [] };
      }
      throw new Error(`unexpected GET ${path}`);
    },
    async post(path, body) {
      writes.push({ method: 'post', path, body });
      const id = (body as { id?: string }).id ?? '';
      if (path === savedBase) searches.set(id, body as Record<string, unknown>);
      if (path === notificationTargetsPath()) targets.add(id);
      if (path === notificationsPath()) notifications.set(id, { id, savedQueryId: ALERT_NOTIFY_SEARCH_ID });
      return {};
    },
    async patch(path, body) {
      writes.push({ method: 'patch', path, body });
      return {};
    },
    async del(path) {
      writes.push({ method: 'del', path });
      if (path.startsWith(`${savedBase}/`)) searches.delete(decodeURIComponent(path.slice(savedBase.length + 1)));
      if (path.startsWith(`${notificationsPath()}/`)) notifications.delete(decodeURIComponent(path.slice(notificationsPath().length + 1)));
      return {};
    },
  };
  return { http, writes };
}

const isNotificationWrite = (w: Write) =>
  w.path.startsWith(notificationTargetsPath()) || w.path.startsWith(notificationsPath());

/** APM's config without lookup seeding (irrelevant here, and it runs search jobs). */
function config(extra: Partial<ProvisionerConfig> = {}): ProvisionerConfig {
  return { ...APM_PROVISIONER_CONFIG, seedLookups: [], ...extra };
}

async function reconcileWith(http: HttpClient, cfg: ProvisionerConfig) {
  const plan = getProvisioningPlan();
  const actions = diffProvisioned(plan, await listProvisioned(http, CRIBLAPM_PREFIX));
  return applyProvisioningActions(http, cfg, actions);
}

/** The former path, verbatim: reconcile the searches with no notification
 *  config, then the two calls the afterReconcile step / wireCellTrigger made. */
async function legacyApply(http: HttpClient) {
  await reconcileWith(http, { ...config(), notifications: undefined });
  await ensureNotificationTarget(http, cellWebhookTarget(CELL));
  await ensureSavedSearchNotification(http, ALERT_NOTIFY_BINDING);
}

describe('alert-notify target and binding through ProvisionerConfig', () => {
  it.each([
    ['a fresh workspace (create)', {}],
    [
      'an upgraded workspace (update)',
      {
        targets: [CELL_WEBHOOK_TARGET_ID],
        notifications: [{ id: NOTIFICATION_ID, savedQueryId: ALERT_NOTIFY_SEARCH_ID }],
      },
    ],
  ])('writes exactly what the former calls wrote, in the same order — %s', async (_name, seed) => {
    setServerInvestigations(true);
    const legacy = fakeCribl(seed);
    await legacyApply(legacy.http);

    const next = fakeCribl(seed);
    const { targets, notifications } = await reconcileWith(
      next.http,
      config({ notificationTargets: () => cliCellWebhookTargets(CELL) }),
    );

    const expected = legacy.writes.filter(isNotificationWrite);
    expect(expected).toHaveLength(2); // the target, then the binding
    expect(next.writes.filter(isNotificationWrite)).toEqual(expected);
    // Searches identical too — the binding config adds no saved-search write.
    expect(next.writes.filter((w) => !isNotificationWrite(w))).toEqual(
      legacy.writes.filter((w) => !isNotificationWrite(w)),
    );
    expect(targets.map((t) => [t.targetId, t.ok])).toEqual([[CELL_WEBHOOK_TARGET_ID, true]]);
    expect(notifications.map((n) => [n.searchId, n.step, n.ok])).toEqual([[ALERT_NOTIFY_SEARCH_ID, 'ensure', true]]);
  });

  it('pins the target body and the ids and paths both writes use', async () => {
    setServerInvestigations(true);
    const next = fakeCribl();
    await reconcileWith(next.http, config({ notificationTargets: () => cliCellWebhookTargets(CELL) }));
    const [target, binding] = next.writes.filter(isNotificationWrite);
    expect(target).toEqual({
      method: 'post',
      path: '/notification-targets',
      body: {
        id: 'criblapm_cell_webhook',
        type: 'webhook',
        method: 'POST',
        url: 'https://goattown-shared.lab.cribl.io/alerts/fire',
        format: 'custom',
        customContentType: 'application/json',
        customSourceExpression: '`${JSON.stringify({ savedQueryId, message, results: events })}`',
        customPayloadExpression: '`${events}`',
        authType: 'token',
        token: 'gt_a1_test-credential',
        onBackpressure: 'drop',
      },
    });
    expect(binding.method).toBe('post');
    expect(binding.path).toBe('/m/default_search/notifications');
    expect(binding.body).toMatchObject({
      id: NOTIFICATION_ID,
      group: 'default_search',
      targets: [CELL_WEBHOOK_TARGET_ID],
      conf: { savedQueryId: ALERT_NOTIFY_SEARCH_ID, triggerType: 'resultsCount', triggerComparator: '>', triggerCount: 0 },
    });
  });

  it('still binds when no target is declared (no bearer), as the former calls did', async () => {
    setServerInvestigations(true);
    const next = fakeCribl({ targets: [CELL_WEBHOOK_TARGET_ID] });
    const { targets, notifications } = await reconcileWith(
      next.http,
      config({ notificationTargets: () => cliCellWebhookTargets({ cellUrl: CELL.cellUrl, bearer: undefined }) }),
    );
    expect(targets).toEqual([]);
    expect(notifications.map((n) => [n.searchId, n.ok])).toEqual([[ALERT_NOTIFY_SEARCH_ID, true]]);
    expect(next.writes.filter(isNotificationWrite).map((w) => [w.method, w.path])).toEqual([
      ['post', '/m/default_search/notifications'],
    ]);
  });

  it('writes no target or binding while server investigations is off', async () => {
    setServerInvestigations(false);
    const next = fakeCribl();
    const { targets, notifications } = await reconcileWith(
      next.http,
      config({ notificationTargets: () => cliCellWebhookTargets(CELL) }),
    );
    expect(targets).toEqual([]);
    expect(notifications).toEqual([]);
    expect(next.writes.filter(isNotificationWrite)).toEqual([]);
  });

  it('turning the flag off unbinds alert_notify before deleting it — the DELETE the former teardown sent', async () => {
    const seed = {
      searches: [ALERT_NOTIFY_SEARCH_ID],
      targets: [CELL_WEBHOOK_TARGET_ID],
      notifications: [{ id: NOTIFICATION_ID, savedQueryId: ALERT_NOTIFY_SEARCH_ID }],
    };
    setServerInvestigations(false);
    const legacy = fakeCribl(seed);
    await reconcileWith(legacy.http, { ...config(), notifications: undefined });
    await removeSavedSearchNotification(legacy.http, ALERT_NOTIFY_BINDING);

    const next = fakeCribl(seed);
    await reconcileWith(next.http, config({ notificationTargets: () => cliCellWebhookTargets(CELL) }));

    const unbind = { method: 'del', path: `/m/default_search/notifications/${NOTIFICATION_ID}` };
    expect(legacy.writes.filter(isNotificationWrite)).toEqual([unbind]);
    expect(next.writes.filter(isNotificationWrite)).toEqual([unbind]);
    // The unbind now precedes the search delete instead of following it.
    const order = next.writes.map((w) => w.path);
    expect(order.indexOf(unbind.path)).toBeLessThan(
      order.indexOf(`/m/default_search/search/saved/${ALERT_NOTIFY_SEARCH_ID}`),
    );
  });
});

describe('settingsCellWebhookTargets (Settings Apply)', () => {
  function deps(over: Partial<SettingsCellTargetDeps> = {}) {
    const reported: Array<{ label: string; ok: boolean; detail?: string }> = [];
    const d: SettingsCellTargetDeps = {
      cellUrl: () => CELL.cellUrl,
      canFireAlerts: async () => true,
      readCredential: async () => CELL.bearer,
      credentialKey: 'goattownEmbedToken',
      report: (s) => reported.push(s),
      ...over,
    };
    return { d, reported };
  }

  it('returns the same target the CLI declares', async () => {
    setServerInvestigations(true);
    const { d, reported } = deps({ readCredential: async () => `  ${CELL.bearer}\n` });
    await expect(settingsCellWebhookTargets(d)).resolves.toEqual(cliCellWebhookTargets(CELL));
    expect(reported).toEqual([]);
  });

  it('declares nothing while server investigations is off', async () => {
    const { d } = deps();
    await expect(settingsCellWebhookTargets(d)).resolves.toEqual([]);
  });

  it.each([
    ['the capability read fails', { canFireAlerts: async () => { throw new Error('503'); } }, 'Could not read GoatTown capabilities: 503'],
    ['alert firing is not granted', { canFireAlerts: async () => false }, 'has not granted this app connection alert firing'],
    ['no credential is stored', { readCredential: async () => null }, 'No connected-app credential in kv.goattownEmbedToken'],
    ['the stored credential is blank', { readCredential: async () => '  ' }, 'No connected-app credential'],
  ])('skips the target and reports why when %s', async (_n, over, detail) => {
    setServerInvestigations(true);
    const { d, reported } = deps(over as Partial<SettingsCellTargetDeps>);
    await expect(settingsCellWebhookTargets(d)).resolves.toEqual([]);
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ label: 'Webhook target: skipped', ok: false });
    expect(reported[0].detail).toContain(detail);
  });

  it('a failed KV read skips the binding (target `*`), as the former step stopped before binding', async () => {
    setServerInvestigations(true);
    const { d } = deps({ readCredential: async () => { throw new Error('KV read of goattownEmbedToken returned HTML (404)'); } });
    const next = fakeCribl();
    const { targets, notifications } = await reconcileWith(
      next.http,
      config({ notificationTargets: () => settingsCellWebhookTargets(d) }),
    );
    expect(targets).toEqual([{ targetId: '*', ok: false, error: expect.stringContaining('returned HTML') }]);
    expect(notifications).toEqual([
      expect.objectContaining({ searchId: ALERT_NOTIFY_SEARCH_ID, ok: false, error: expect.stringContaining('skipped') }),
    ]);
    expect(next.writes.filter(isNotificationWrite)).toEqual([]);
  });
});

describe('bearerFromKvText (the normalisation the former local kvGetText applied)', () => {
  it('passes raw text through, trimmed', () => {
    expect(bearerFromKvText(' gt_a1_opaque-credential\n')).toBe('gt_a1_opaque-credential');
  });
  it('unwraps a JSON-encoded string', () => {
    expect(bearerFromKvText('"gt_a1_opaque-credential"')).toBe('gt_a1_opaque-credential');
  });
  it('reads absent and empty as null', () => {
    expect(bearerFromKvText(null)).toBeNull();
    expect(bearerFromKvText('')).toBeNull();
    expect(bearerFromKvText('""')).toBeNull();
  });
});
