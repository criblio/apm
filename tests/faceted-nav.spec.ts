// End-to-end smoke test for the faceted-navigation Search page (PR F).
//
// Validates that all four new UI primitives mount inside the Search
// page and that the Spotlight tab switches without crashing. Live
// query results are timing-dependent on the staging dataset so we
// only assert the panels render (placeholder or data) — surface
// presence, not data quality.
import { test, expect } from '@playwright/test';
import { apmFrame, gotoApm } from './helpers/apmSession';

test('Search page renders SearchForm + FilterBuilder + KqlEditor + facet rail', async ({
  page,
}) => {
  await gotoApm(page, '/');
  const apm = apmFrame(page);

  // Navigate to Traces (the Search page) via the nav link. The
  // workspace shell ignores fragment-based deep links on initial
  // mount, so we always click in.
  await apm
    .getByRole('link', { name: 'Traces', exact: true })
    .first()
    .waitFor({ timeout: 30_000 });
  await apm.getByRole('link', { name: 'Traces', exact: true }).first().click();

  // SearchForm "Find Traces" button is the canonical anchor for the
  // page being mounted.
  await expect(
    apm.getByRole('button', { name: 'Find Traces' }),
  ).toBeVisible({ timeout: 20_000 });

  // FilterBuilder
  await expect(apm.getByRole('button', { name: '+ Add filter' })).toBeVisible();

  // KqlEditor
  await expect(apm.getByLabel('Raw KQL predicate')).toBeVisible();

  // Facet rail tabs
  await expect(apm.getByRole('tab', { name: 'Facets' })).toBeVisible();
  await expect(apm.getByRole('tab', { name: 'Spotlight' })).toBeVisible();

  // Switch to Spotlight — the panel either populates or shows the
  // "no strong differentials" placeholder; both are acceptable for
  // an empty selection, just verify no crash and the tab toggles.
  await apm.getByRole('tab', { name: 'Spotlight' }).click();
  await expect(apm.getByRole('tab', { name: 'Spotlight' })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  // Switch back to Facets, add a filter, confirm the row is editable.
  await apm.getByRole('tab', { name: 'Facets' }).click();
  await apm.getByRole('button', { name: '+ Add filter' }).click();
  const attrInputs = apm.getByLabel('filter attribute');
  await expect(attrInputs.first()).toBeVisible();
  await attrInputs.last().fill('http.status_code');
  const valueInputs = apm.getByLabel('filter value');
  await valueInputs.last().fill('500');
  await expect(valueInputs.last()).toHaveValue('500');
});
