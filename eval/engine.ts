import type { Page } from 'playwright-core';
import { setFlag, allOff } from '../tests/helpers/flagd.js';
import type {
  ScenarioDeclaration,
  ScenarioResult,
  SurfaceResult,
  SurfaceCheck,
  InvestigatorResult,
} from './types.js';

async function navigateToPage(
  page: Page,
  pageName: string,
  serviceName: string,
  gotoApm: (page: Page, path: string) => Promise<void>,
): Promise<boolean> {
  if (pageName === 'home') {
    await gotoApm(page, '/?range=-15m');
    await page.getByText(/^Services \(\d+\)/).waitFor({
      state: 'visible',
      timeout: 60_000,
    }).catch(() => {});
    return true;
  } else if (pageName === 'serviceDetail') {
    await gotoApm(page, '/?range=-15m');
    await page.waitForTimeout(2000);
    const row = page.getByRole('row', {
      name: new RegExp(`^${serviceName}\\s`),
    });
    const visible = await row
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    if (!visible) return false;
    await row.getByRole('link').first().click();
    await page.waitForURL(/\/service\//, { timeout: 15_000 });
    await page.getByText(/^Top operations/).waitFor({
      state: 'visible',
      timeout: 60_000,
    }).catch(() => {});
    return true;
  }
  return false;
}

async function evaluateCheck(
  page: Page,
  check: SurfaceCheck,
): Promise<SurfaceResult> {
  const start = Date.now();
  try {
    const loc = page.locator(check.locator);
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

async function runInvestigator(
  page: Page,
  config: NonNullable<ScenarioDeclaration['investigator']>,
  gotoApm: (page: Page, path: string) => Promise<void>,
): Promise<InvestigatorResult> {
  try {
    await gotoApm(page, '/');
    await page.waitForTimeout(1000);
    await page.getByRole('link', { name: 'Investigate', exact: true }).click();
    await page.waitForURL(/\/investigate/, { timeout: 15_000 });
    await page.waitForLoadState('domcontentloaded');

    const composer = page.locator(
      'textarea[placeholder*="Ask me to investigate"]',
    );
    const composerVisible = await composer
      .waitFor({ state: 'visible', timeout: 15_000 })
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

    const summaryTitle = page.getByText('📋 Investigation summary').first();
    const arrived = await summaryTitle
      .waitFor({ state: 'visible', timeout: config.waitMs })
      .then(() => true)
      .catch(() => false);

    const transcript = await page
      .locator('[class*="transcript" i]')
      .first()
      .innerText()
      .catch(() => '');

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

  try {
    console.log(`  [${scenario.name}] flipping ${scenario.flag}=${scenario.variant}`);
    await setFlag(scenario.flag, scenario.variant);

    console.log(
      `  [${scenario.name}] waiting ${scenario.telemetryWaitMs / 1000}s for telemetry`,
    );
    await page.waitForTimeout(scenario.telemetryWaitMs);

    // Group checks by page so we navigate once per page, not per check
    const byPage = new Map<string, SurfaceCheck[]>();
    for (const check of scenario.surfaceChecks) {
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
