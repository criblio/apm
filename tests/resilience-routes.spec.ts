import { test, expect, type FrameLocator } from '@playwright/test';
import { apmFrame, gotoApm } from './helpers/apmSession';

interface RouteCase {
  nav: string;
  content: string | RegExp;
  role?: 'heading' | 'button' | 'tab';
}

// The Investigator page's title depends on the `serverInvestigations`
// flag — "Copilot Investigation" (client) vs "Cribl APM Copilot"
// (server-side composer) — so match either. This test only cares that
// the route renders content, not which mode it's in.
const INVESTIGATE_TITLE = /Copilot Investigation|Cribl APM Copilot/;

const ROUTES: RouteCase[] = [
  { nav: 'Overview', content: 'Overview', role: 'heading' },
  { nav: 'Services', content: 'Services', role: 'heading' },
  { nav: 'Service Map', content: 'Graph', role: 'tab' },
  { nav: 'Traces', content: 'Find Traces', role: 'button' },
  { nav: 'Logs', content: 'Logs', role: 'heading' },
  { nav: 'Metrics', content: 'Metrics', role: 'heading' },
  { nav: 'Alerts', content: 'Alerts', role: 'heading' },
  { nav: 'Errors', content: 'Errors', role: 'heading' },
  { nav: 'Investigate', content: INVESTIGATE_TITLE },
  { nav: 'Configuration', content: 'Setup status' },
];

async function clickNav(apm: FrameLocator, item: RouteCase): Promise<void> {
  await apm.getByText(item.nav, { exact: true }).first().click();
  const exact = typeof item.content === 'string';
  const content = item.role
    ? apm.getByRole(item.role, { name: item.content, exact }).first()
    : apm.getByText(item.content, exact ? { exact: true } : undefined).first();
  await expect(content).toBeVisible({ timeout: 45_000 });
  await expect(apm.getByText(/temporarily unavailable/i)).toHaveCount(0);
}

test('all top-level routes survive iframe navigation, history, and wildcard recovery', async ({ page }) => {
  test.setTimeout(6 * 60_000);
  await gotoApm(page, '/');
  const apm = apmFrame(page);

  for (const item of ROUTES) await clickNav(apm, item);

  // Exercise the popstate contract used when the parent host forwards a route
  // change into the iframe. The host owns the actual browser history stack.
  const frame = page.frames().find((candidate) => candidate.url().includes('/app-ui/apm'));
  expect(frame, 'APM iframe should be attached').toBeTruthy();
  await frame!.evaluate(() => {
    const base = window.CRIBL_BASE_PATH ?? '/';
    window.history.replaceState({}, '', `${base.replace(/\/$/, '')}/investigate`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(apm.getByText(INVESTIGATE_TITLE).first()).toBeVisible({
    timeout: 30_000,
  });
  await frame!.evaluate(() => {
    const base = window.CRIBL_BASE_PATH ?? '/';
    window.history.replaceState({}, '', `${base.replace(/\/$/, '')}/configuration`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(apm.getByText('Setup status', { exact: true })).toBeVisible({
    timeout: 30_000,
  });

  // Drive an unknown route inside the mounted iframe; the app must render its
  // contained wildcard page rather than blanking the host.
  await frame!.evaluate(() => {
    const base = window.CRIBL_BASE_PATH ?? '/';
    window.history.pushState({}, '', `${base.replace(/\/$/, '')}/does-not-exist`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(apm.getByRole('heading', { name: 'Page not found' })).toBeVisible({
    timeout: 15_000,
  });
});
