import type { Page } from 'playwright-core';
import { setFlag, allOff } from '../tests/helpers/flagd.js';
import { runQuery } from '../tests/helpers/criblSearch.js';
import { apmFrame } from '../tests/helpers/apmSession.js';
import {
  INCIDENT_APP_PRODUCER,
  incidentEventCommitQuery,
} from '../src/api/generatedEventContract.js';
import { incidentKqlChecks, incidentSurfaceChecks } from './incidentChecks.js';
import type {
  ScenarioDeclaration,
  ScenarioResult,
  SurfaceResult,
  SurfaceCheck,
  KqlCheck,
  InvestigatorResult,
} from './types.js';

/**
 * Scenario isolation for the incident layer: close every live incident
 * before a scenario runs, so the previous scenario's incident can't
 * absorb this one's fires (same-bin collapse or adjacency) and this
 * scenario's incident checks observe only its own fault. Mirrors the
 * operator workflow — agent-authored `closed` events through the pinned
 * commit KQL; the grouper ignores closed incidents by construction.
 */
async function closeOpenIncidents(): Promise<void> {
  const rows = await runQuery(
    `dataset="$vt_results" | where jobName == "criblapm__incidents_state"
     | join kind=inner (
         dataset="$vt_results" | where jobName == "criblapm__incidents_state"
         | summarize jobId=max(tostring(jobId))
       ) on jobId
     | where tostring(status) != "closed"
     | summarize n=count() by incident_id`,
    '-1h', 'now', 50,
  ).catch(() => [] as Record<string, unknown>[]);
  let closed = 0;
  for (const row of rows) {
    const id = String(row.incident_id ?? '');
    if (!id || id === '__init__') continue;
    const kql = incidentEventCommitQuery(
      {
        event_id: `${id}:closed:eval-${Date.now()}`,
        producer: INCIDENT_APP_PRODUCER,
        incident_id: id,
        event_type: 'closed',
        author: 'agent',
        status: 'closed',
      },
      process.env.CRIBL_DATASET || 'otel',
    );
    await runQuery(kql, '-1m', 'now', 5).catch(() => {});
    closed++;
    console.log(`  [isolation] closed lingering incident ${id}`);
  }
  // Propagation wait: the criblapm_incidents lookup still lists a
  // just-closed incident until the next fold + export cycle (~6 min).
  // Flipping the next flag immediately lets its early fires attach to
  // the old incident and reopen it — exactly the contamination this
  // isolation step exists to prevent. Only pay the wait when something
  // was actually closed.
  if (closed > 0) {
    console.log('  [isolation] waiting 7m for close to propagate to the lookup');
    await new Promise((r) => setTimeout(r, 7 * 60_000));
  }
}

/** Left-nav item locator: Capra VerticalNavigation renders items as
 * <button> (react-aria), so role=link never matches; scope to the nav
 * container and accept either element kind. */
function navItem(apm: ReturnType<typeof apmFrame>, name: string) {
  return apm
    .locator(`[class*="VerticalNavigation"] :is(a, button):has-text("${name}")`)
    .first();
}

async function navigateToPage(
  page: Page,
  pageName: string,
  serviceName: string,
  gotoApm: (page: Page, path: string) => Promise<void>,
): Promise<boolean> {
  // Cribl Cloud's workspace shell wraps the APM app in an iframe.
  // All nav links and content live inside the iframe; main-page
  // locators only see the workspace chrome. Route every selector
  // through `apm` so we land on real APM content.
  const apm = apmFrame(page);

  if (pageName === 'overview') {
    await gotoApm(page, '/?range=-15m');
    await apm.getByRole('heading', { name: 'Overview' }).waitFor({
      state: 'visible',
      timeout: 60_000,
    }).catch(() => {});
    return true;
  } else if (pageName === 'home' || pageName === 'services') {
    await gotoApm(page, '/');
    await page.waitForTimeout(1000);
    await navItem(apm, 'Services').click();
    await apm.getByText(/^Services \(\d+\)/).waitFor({
      state: 'visible',
      timeout: 60_000,
    }).catch(() => {});
    return true;
  } else if (pageName === 'errors') {
    await gotoApm(page, '/');
    await page.waitForTimeout(1000);
    await navItem(apm, 'Errors').click();
    await page.waitForTimeout(5000);
    return true;
  } else if (pageName === 'serviceDetail') {
    await gotoApm(page, '/');
    await page.waitForTimeout(1000);
    await navItem(apm, 'Services').click();
    const tableLoaded = await apm.getByText(/^Services \(\d+\)/).waitFor({
      state: 'visible',
      timeout: 60_000,
    }).then(() => true).catch(() => false);
    if (!tableLoaded) return false;
    await page.waitForTimeout(2000);
    const svcLink = apm.locator(`table tbody a:has-text("${serviceName}")`).first();
    const visible = await svcLink
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    if (!visible) return false;
    await svcLink.click();
    // Inner-frame URL change isn't observable via page.waitForURL —
    // wait on the page-detail content instead.
    await apm.getByText(/^Top operations/).waitFor({
      state: 'visible',
      timeout: 60_000,
    }).catch(() => {});
    return true;
  } else if (pageName === 'alerts') {
    await gotoApm(page, '/');
    await page.waitForTimeout(2000);
    const alertsLink = navItem(apm, 'Alerts');
    const visible = await alertsLink
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    if (!visible) return false;
    await alertsLink.click();
    await page.waitForTimeout(5000);
    return true;
  } else if (pageName === 'incident') {
    // Alerts → the Incidents-section row containing the scenario's
    // service → its drill-in page (P4.4 Phase 2). The "Open"/
    // "Investigating" tags only render in the Incidents table, so the
    // row locator can't land on Episodes or Currently Active.
    await gotoApm(page, '/');
    await page.waitForTimeout(2000);
    const alertsLink = navItem(apm, 'Alerts');
    const linkVisible = await alertsLink
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    if (!linkVisible) return false;
    await alertsLink.click();
    const row = apm
      .locator(
        `table tr:has-text("${serviceName}"):is(:has-text("Open"), :has-text("Investigating"), :has-text("Identified"))`,
      )
      .first();
    const rowVisible = await row
      .waitFor({ state: 'visible', timeout: 60_000 })
      .then(() => true)
      .catch(() => false);
    if (!rowVisible) return false;
    await row.click();
    // Fail honestly if the drill-in never rendered: returning true
    // with the app still on the Alerts page lets fallback locators
    // (e.g. `table a:has-text(svc)`) false-pass against the Alerts
    // page's own service links.
    const summaryVisible = await apm.getByRole('heading', { name: 'Summary' }).waitFor({
      state: 'visible',
      timeout: 30_000,
    }).then(() => true).catch(() => false);
    return summaryVisible;
  }
  return false;
}

async function evaluateCheck(
  page: Page,
  check: SurfaceCheck,
): Promise<SurfaceResult> {
  const start = Date.now();
  try {
    // Scenario locators target APM content, which lives in the
    // workspace shell's iframe. Run them through `apmFrame` rather
    // than the main page.
    const loc = apmFrame(page).locator(check.locator);
    let detected = false;

    if (check.assertion === 'visible') {
      detected = await loc
        .first()
        .waitFor({ state: 'visible', timeout: check.timeoutMs })
        .then(() => true)
        .catch(() => false);
    } else if (check.assertion === 'countGt0') {
      const deadline = Date.now() + check.timeoutMs;
      while (Date.now() < deadline) {
        const count = await loc.count();
        if (count > 0) {
          detected = true;
          break;
        }
        await page.waitForTimeout(2000);
      }
    } else if (check.assertion === 'textMatches' && check.pattern) {
      const deadline = Date.now() + check.timeoutMs;
      const re = new RegExp(check.pattern, 'i');
      while (Date.now() < deadline) {
        const text = await loc
          .first()
          .innerText()
          .catch(() => '');
        if (re.test(text)) {
          detected = true;
          break;
        }
        await page.waitForTimeout(2000);
      }
    }

    return { surface: check.surface, detected, latencyMs: Date.now() - start };
  } catch (err) {
    return {
      surface: check.surface,
      detected: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function evaluateKqlCheck(check: KqlCheck): Promise<SurfaceResult> {
  const start = Date.now();
  const pollInterval = check.pollIntervalMs ?? 15_000;
  const deadline = Date.now() + check.timeoutMs;

  try {
    while (Date.now() < deadline) {
      const rows = await runQuery(check.query, check.earliest, check.latest, 100);

      if (check.assertion === 'rowCountGt0') {
        if (rows.length > 0) {
          return { surface: check.surface, detected: true, latencyMs: Date.now() - start };
        }
      } else if (check.assertion === 'fieldMatches' && check.field && check.pattern) {
        const re = new RegExp(check.pattern, 'i');
        const match = rows.some((r) => re.test(String(r[check.field!] ?? '')));
        if (match) {
          return { surface: check.surface, detected: true, latencyMs: Date.now() - start };
        }
      }

      if (Date.now() + pollInterval > deadline) break;
      await new Promise((r) => setTimeout(r, pollInterval));
    }

    return { surface: check.surface, detected: false, latencyMs: Date.now() - start };
  } catch (err) {
    return {
      surface: check.surface,
      detected: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runInvestigator(
  page: Page,
  config: NonNullable<ScenarioDeclaration['investigator']>,
  gotoApm: (page: Page, path: string) => Promise<void>,
): Promise<InvestigatorResult> {
  try {
    await gotoApm(page, '/');
    const apm = apmFrame(page);
    await page.waitForTimeout(1000);
    await navItem(apm, 'Investigate').click();
    // Inner-frame URL changes aren't observable via page.waitForURL —
    // wait on the composer instead.

    // Two composer generations: the legacy in-browser agent
    // ("Ask me to investigate…") and the server-investigations
    // composer ("e.g. Why is the checkout service throwing errors?").
    // Match either so the harness works with the flag on or off.
    const composer = apm
      .locator(
        'textarea[placeholder*="Ask me to investigate"], textarea[placeholder*="Why is the checkout service"]',
      )
      .first();
    const composerVisible = await composer
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);

    if (!composerVisible) {
      return {
        completed: false,
        mentionsRootCause: false,
        score: 0,
        transcript: '(composer not visible)',
      };
    }

    await composer.fill(config.prompt);
    await composer.press('Enter');

    // Completion marker, either generation: the legacy summary heading,
    // or the server view's "Investigated" status label once the run
    // concludes and parks.
    const summaryTitle = apm
      .getByText('📋 Investigation summary')
      .or(apm.getByText('Investigated', { exact: true }))
      .first();
    const arrived = await summaryTitle
      .waitFor({ state: 'visible', timeout: config.waitMs })
      .then(() => true)
      .catch(() => false);

    const transcript = await apm
      .locator('[class*="transcript" i]')
      .first()
      .innerText()
      .catch(() => '');

    // Persist whatever ran so we can diagnose timeouts / partials.
    // Both the rendered transcript and a screenshot go to disk; the
    // result struct keeps the transcript inline for in-process scoring.
    try {
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const dir = '/tmp/apm-eval-runs';
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${dir}/transcript-${ts}.txt`, transcript || '(empty)');
      await page.screenshot({ path: `${dir}/screen-${ts}.png`, fullPage: true });
      // Also flag in stdout so the user knows where to look.
      console.log(`  [investigator] artifacts: ${dir}/{transcript,screen}-${ts}.*`);
    } catch {
      /* non-fatal */
    }

    const re = new RegExp(config.expectedRootCausePattern, 'i');
    const mentionsRootCause = re.test(transcript);

    let score = 0;
    if (arrived && mentionsRootCause) score = 1.0;
    else if (arrived) score = 0.5;

    return { completed: arrived, mentionsRootCause, score, transcript };
  } catch (err) {
    return {
      completed: false,
      mentionsRootCause: false,
      score: 0,
      transcript: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runScenario(
  scenario: ScenarioDeclaration,
  page: Page,
  gotoApm: (page: Page, path: string) => Promise<void>,
  options: { skipInvestigator: boolean },
): Promise<ScenarioResult> {
  const start = Date.now();
  const surfaces: SurfaceResult[] = [];
  let investigator: InvestigatorResult | undefined;

  // Incident-layer checks are appended, not hand-copied per scenario.
  const surfaceChecks = scenario.expectsIncident
    ? [...scenario.surfaceChecks, ...incidentSurfaceChecks(scenario.expectedService)]
    : scenario.surfaceChecks;
  const kqlChecks = scenario.expectsIncident
    ? [...(scenario.kqlChecks ?? []), ...incidentKqlChecks(scenario.expectedService)]
    : scenario.kqlChecks;

  try {
    // Isolation: the previous scenario's incident must not absorb this
    // scenario's fires (same-bin collapse / adjacency). Close every
    // live incident before flipping the flag.
    console.log(`  [${scenario.name}] closing lingering incidents...`);
    await closeOpenIncidents();

    if (scenario.flag && scenario.variant) {
      console.log(`  [${scenario.name}] flipping ${scenario.flag}=${scenario.variant}`);
      await setFlag(scenario.flag, scenario.variant);
    } else {
      console.log(`  [${scenario.name}] no flag flip — observing natural state`);
    }

    console.log(
      `  [${scenario.name}] waiting ${scenario.telemetryWaitMs / 1000}s for telemetry`,
    );
    await page.waitForTimeout(scenario.telemetryWaitMs);

    // Group checks by page so we navigate once per page, not per check
    const byPage = new Map<string, SurfaceCheck[]>();
    for (const check of surfaceChecks) {
      const list = byPage.get(check.page) ?? [];
      list.push(check);
      byPage.set(check.page, list);
    }

    for (const [pageName, checks] of byPage) {
      console.log(`  [${scenario.name}] navigating to ${pageName}...`);
      const landed = await navigateToPage(
        page,
        pageName,
        scenario.expectedService,
        gotoApm,
      );
      if (!landed) {
        for (const check of checks) {
          surfaces.push({
            surface: check.surface,
            detected: false,
            latencyMs: 0,
            error: `failed to navigate to ${pageName}`,
          });
          console.log(
            `  [${scenario.name}]   ✗ ${check.surface} (navigation failed)`,
          );
        }
        continue;
      }

      for (const check of checks) {
        console.log(`  [${scenario.name}] checking ${check.surface}...`);
        const result = await evaluateCheck(page, check);
        surfaces.push(result);
        const mark = result.detected ? '✓' : '✗';
        console.log(
          `  [${scenario.name}]   ${mark} ${check.surface} (${result.latencyMs}ms)`,
        );
      }
    }

    // KQL checks — validate server-side state (alert status, history)
    if (kqlChecks) {
      for (const check of kqlChecks) {
        console.log(`  [${scenario.name}] KQL check: ${check.surface}...`);
        const result = await evaluateKqlCheck(check);
        surfaces.push(result);
        const mark = result.detected ? '✓' : '✗';
        console.log(
          `  [${scenario.name}]   ${mark} ${check.surface} (${result.latencyMs}ms)`,
        );
      }
    }

    if (scenario.investigator && !options.skipInvestigator) {
      console.log(`  [${scenario.name}] running Investigator...`);
      investigator = await runInvestigator(
        page,
        scenario.investigator,
        gotoApm,
      );
      const mark = investigator.mentionsRootCause ? '✓' : '✗';
      console.log(
        `  [${scenario.name}]   ${mark} investigator (score=${investigator.score})`,
      );
    }
  } finally {
    try {
      await allOff();
    } catch (err) {
      console.error(`  [${scenario.name}] allOff failed:`, err);
    }
  }

  if (scenario.cooldownMs > 0) {
    console.log(
      `  [${scenario.name}] cooldown ${scenario.cooldownMs / 1000}s`,
    );
    await page.waitForTimeout(scenario.cooldownMs);
  }

  const surfaceScore =
    surfaces.length > 0
      ? surfaces.filter((s) => s.detected).length / surfaces.length
      : 0;
  const invScore = investigator?.score ?? 0;
  const hasInv = !!scenario.investigator && !options.skipInvestigator;
  const overallScore = hasInv
    ? surfaceScore * 0.7 + invScore * 0.3
    : surfaceScore;

  return {
    name: scenario.name,
    surfaces,
    investigator,
    score: Math.round(overallScore * 100) / 100,
    durationMs: Date.now() - start,
  };
}
