// Scenario 1 — paymentFailure
//
// See FAILURE-SCENARIOS.md for the full signal/surface list. This spec
// flips the flagd `paymentFailure` flag to `50%`, waits long enough for
// telemetry to flow through the OTel Collector → Cribl → the pack, and
// then exercises every surface the scenario is supposed to light up:
//
//   1. Home catalog          — payment row's Errors column shows a
//                              non-zero percentage (e.g. "25.00%")
//   2. Service Detail        — /service/payment Errors chart +
//                              Recent errors panel with at least one trace
//   3. Copilot Investigator  — agent summarises the payment regression
//
// The test uses `expect.soft` so one run surfaces every surface that
// failed to render the scenario, not just the first. The `finally`
// block always flips the flag back off, even if the test explodes
// mid-way — leaving a flag on would skew every subsequent run.
//
// Note on the delta chip: the spec intentionally does NOT assert on the
// red ▲+Npp delta pill. That pill compares the current window against
// the previous window of the same length, so it only lights up when the
// previous window was clean. Scenario tests need to work from any
// starting state; absolute error-rate is a more robust signal.
//
// Prereqs:
//   - FLAGD_UI_URL set in .env (see tests/helpers/flagd.ts)
//   - CRIBL_TEST_EMAIL / CRIBL_TEST_PASSWORD so auth.setup can log in
//   - CRIBL_BASE_URL / CLIENT_ID / CLIENT_SECRET so the Bearer-token
//     helper can authenticate API calls on behalf of the pack
//   - otel-demo cluster is up and producing baseline traffic

import { test, expect } from '@playwright/test';
import { setFlag, allOff } from '../helpers/flagd';
import { installCriblHostGlobals, gotoApm } from '../helpers/apmSession';

const TEST_TIMEOUT_MS = 12 * 60 * 1000;
const TELEMETRY_WAIT_MS = 3 * 60 * 1000;
const INVESTIGATOR_WAIT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 10 * 1000;

/** Parse "1.23%" / "0.00%" / "12.34%" into a number; returns NaN on miss. */
function parseErrorPct(text: string): number {
  const m = text.match(/([\d.]+)\s*%/);
  return m ? Number.parseFloat(m[1]) : Number.NaN;
}

test('scenario 1 · paymentFailure surfaces in Home, Service Detail, Investigator', async ({
  page,
}) => {
  test.setTimeout(TEST_TIMEOUT_MS);
  await installCriblHostGlobals(page);

  try {
    // 1. Flip the flag. `setFlag` throws if the flag/variant is missing,
    //    so if FLAGD_UI_URL is wrong we fail fast here instead of
    //    silently testing an unchanged cluster.
    await test.step('flagd · set paymentFailure 50%', async () => {
      await setFlag('paymentFailure', '50%');
    });

    // 2. Poll Home until the payment row's Errors column shows a
    //    non-zero percentage. Hard-assert here because nothing
    //    downstream makes sense if the UI never picked up the
    //    regression — that would be a data or pipeline problem, not
    //    a UI bug we want to surface on the rest of the surfaces.
    await test.step('home · payment row shows non-zero error rate', async () => {
      const deadline = Date.now() + TELEMETRY_WAIT_MS;
      let seen = false;
      let lastErrorText = '(never polled)';
      while (Date.now() < deadline) {
        await gotoApm(page, '/?range=-15m');
        const paymentRow = page.getByRole('row', { name: /^payment\s/ });
        const visible = await paymentRow
          .waitFor({ state: 'visible', timeout: 15_000 })
          .then(() => true)
          .catch(() => false);
        if (!visible) {
          lastErrorText = 'payment row not visible on Home';
        } else {
          // Errors column is the 3rd <td> (Service=0, Rate=1, Errors=2).
          const errorsCell = paymentRow.locator('td').nth(2);
          const text = (await errorsCell.innerText().catch(() => '')).trim();
          lastErrorText = text;
          const pct = parseErrorPct(text);
          if (Number.isFinite(pct) && pct > 1) {
            seen = true;
            break;
          }
        }
        await page.waitForTimeout(POLL_INTERVAL_MS);
      }
      expect(
        seen,
        `Expected the payment row's Errors cell to show a non-zero rate (>1%) within ${TELEMETRY_WAIT_MS / 1000}s. Last observation: ${lastErrorText}`,
      ).toBe(true);
    });

    // 3. Home surface — propagated checkout error + Error classes panel.
    //    Soft so Home surface gaps don't mask downstream surface gaps.
    await test.step('home · propagated checkout error + Error classes panel', async () => {
      const checkoutRow = page.getByRole('row', { name: /^checkout\s/ });
      if (await checkoutRow.isVisible().catch(() => false)) {
        const checkoutCell = checkoutRow.locator('td').nth(2);
        const text = (await checkoutCell.innerText().catch(() => '')).trim();
        const pct = parseErrorPct(text);
        await expect
          .soft(
            Number.isFinite(pct) && pct > 0,
            `checkout row should carry a propagated non-zero error rate (got "${text}")`,
          )
          .toBe(true);
      }

      // TraceClassList renders the title as "Error classes (N)" in a
      // single span so we can't use an exact match. Anchor a regex at
      // the start of the span text instead.
      const errorClassesHeading = page.getByText(/^Error classes\s/);
      await expect
        .soft(errorClassesHeading, 'Home should render an "Error classes" panel')
        .toBeVisible({ timeout: 5_000 });

      if (await errorClassesHeading.isVisible().catch(() => false)) {
        const wrap = errorClassesHeading.locator('xpath=ancestor::*[contains(@class,"wrap")][1]');
        const paymentEntries = wrap.locator('li').filter({ hasText: /payment/i });
        await expect
          .soft(paymentEntries, 'Error classes panel should list a payment entry')
          .not.toHaveCount(0, { timeout: 5_000 });
      }
    });

    // 4. Service Detail surface — Errors chart + Recent errors panel.
    //    The Cribl host only serves the pack at /app-ui/apm/; deeper
    //    paths like /app-ui/apm/service/payment 404 with a JSON error.
    //    Click the payment row's link to drive React Router instead.
    await test.step('service detail · /service/payment', async () => {
      const paymentRow = page.getByRole('row', { name: /^payment\s/ });
      await paymentRow.waitFor({ state: 'visible', timeout: 15_000 });
      // The service-name cell wraps a <Link> to /service/:serviceName.
      await paymentRow.getByRole('link', { name: /\bpayment\b/ }).first().click();
      await page.waitForURL(/\/service\/payment/, { timeout: 15_000 });
      await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});

      const errorsTitle = page.getByText('Errors', { exact: true }).first();
      await expect
        .soft(errorsTitle, 'Service Detail should render an Errors chart')
        .toBeVisible({ timeout: 20_000 });

      // TraceBriefList renders "Recent errors (N)" inside the title
      // span — anchor a regex instead of using exact match.
      const recentErrorsTitle = page.getByText(/^Recent errors\s/).first();
      await expect
        .soft(recentErrorsTitle, 'Service Detail should render a Recent errors panel')
        .toBeVisible({ timeout: 10_000 });

      if (await recentErrorsTitle.isVisible().catch(() => false)) {
        // The panel is a <div class="wrap"> containing a <ul class="list">
        // of <li> rows. Scope to the wrapper around the heading so we
        // don't accidentally count list items from a sibling panel.
        const wrap = recentErrorsTitle.locator('xpath=ancestor::*[contains(@class,"wrap")][1]');
        const items = wrap.locator('ul li');
        await expect
          .soft(
            items,
            'Recent errors panel should list at least one trace for payment failures',
          )
          .not.toHaveCount(0, { timeout: 10_000 });
      }
    });

    // 5. Investigator surface — ask Copilot about payment errors, wait
    //    for the Summary card, and assert its text references payment.
    //    We use the NavBar Investigate link (React Router client-side
    //    navigation) because a direct goto to /app-ui/apm/investigate
    //    hits the same host-404 issue as /service/payment.
    await test.step('investigator · summarises the payment regression', async () => {
      await page.getByRole('link', { name: 'Investigate', exact: true }).click();
      await page.waitForURL(/\/investigate/, { timeout: 15_000 });
      await page.waitForLoadState('domcontentloaded');

      const composer = page.locator('textarea[placeholder*="Ask me to investigate"]');
      await expect
        .soft(composer, 'Investigator should render a composer textarea')
        .toBeVisible({ timeout: 15_000 });

      if (!(await composer.isVisible().catch(() => false))) return;

      await composer.fill(
        'Why are there payment service errors in the last 15 minutes? Summarise root cause.',
      );
      await composer.press('Enter');

      const summaryTitle = page.getByText('📋 Investigation summary').first();
      const arrived = await summaryTitle
        .waitFor({ state: 'visible', timeout: INVESTIGATOR_WAIT_MS })
        .then(() => true)
        .catch(() => false);
      await expect
        .soft(arrived, 'Investigator should produce a Summary card within the wait budget')
        .toBe(true);

      // Capture the transcript either way — we want to see what the
      // agent said even on success so we can judge quality, not just
      // pass/fail.
      const transcriptText = await page
        .locator('[class*="transcript" i]')
        .first()
        .innerText()
        .catch(() => '');
      console.log('\n========== Investigator transcript ==========\n');
      console.log(transcriptText);
      console.log('\n=============================================\n');

      if (arrived) {
        await expect
          .soft(/payment/i.test(transcriptText), 'Investigator summary should mention "payment"')
          .toBe(true);
        await expect
          .soft(
            /(error|fail)/i.test(transcriptText),
            'Investigator summary should mention "error" or "fail"',
          )
          .toBe(true);
      }
    });
  } finally {
    try {
      await allOff();
    } catch (err) {
      console.error('[teardown] allOff() failed:', err);
    }
  }
});
