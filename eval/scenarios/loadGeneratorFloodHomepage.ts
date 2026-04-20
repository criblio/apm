import type { ScenarioDeclaration } from '../types.js';

const scenario: ScenarioDeclaration = {
  name: 'loadGeneratorFloodHomepage',
  flag: 'loadGeneratorFloodHomepage',
  variant: 'on',
  expectedService: 'frontend',
  telemetryWaitMs: 3 * 60_000,
  cooldownMs: 2 * 60_000,
  surfaceChecks: [
    {
      surface: 'homeRateChip',
      page: 'home',
      locator: 'table tbody tr:has-text("frontend") [title*="vs previous window"]',
      assertion: 'visible',
      timeoutMs: 30_000,
    },
    {
      surface: 'svcDetailRateChart',
      page: 'serviceDetail',
      locator: 'text=Rate',
      assertion: 'visible',
      timeoutMs: 30_000,
    },
  ],
};

export default scenario;
