/**
 * Fetch available Cribl notification targets from the product-level
 * API. These are configured by the Cribl admin (Slack webhooks,
 * PagerDuty services, email, etc.) and shared across Stream and
 * Search.
 *
 * Called from the Settings page to populate the auto-alert
 * notification target picker. Uses the platform fetch proxy so
 * auth is handled automatically.
 */

function apiUrl(): string {
  return window.CRIBL_API_URL ?? import.meta.env.VITE_CRIBL_API_URL ?? '/api/v1';
}

export interface NotificationTarget {
  id: string;
  name?: string;
  type: string;
}

export async function listNotificationTargets(): Promise<NotificationTarget[]> {
  try {
    const resp = await fetch(`${apiUrl()}/notification-targets`);
    if (!resp.ok) return [];
    const data = await resp.json() as { items?: NotificationTarget[] };
    return (data.items ?? []).map((t) => ({
      id: t.id,
      name: t.name ?? t.id,
      type: t.type ?? 'unknown',
    }));
  } catch {
    return [];
  }
}
