import type { ScenarioDeclaration } from '../types.js';

const scenario: ScenarioDeclaration = {
  name: 'adHighCpu',
  flag: 'adHighCpu',
  variant: 'on',
  expectedService: 'ad',
  telemetryWaitMs: 3 * 60_000,
  cooldownMs: 2 * 60_000,
  surfaceChecks: [
    {
      surface: 'homeP95Chip',
      page: 'home',
      locator: 'table tbody tr:has-text("ad") td:nth-child(6) [title*="vs previous window"]',
      assertion: 'visible',
      timeoutMs: 30_000,
    },
    {
      surface: 'homeP99Chip',
      page: 'home',
      locator: 'table tbody tr:has-text("ad") td:nth-child(7) [title*="vs previous window"]',
      assertion: 'visible',
      timeoutMs: 30_000,
    },
    {
      surface: 'svcDetailDurationChart',
      page: 'serviceDetail',
      locator: 'text=p95',
      assertion: 'visible',
      timeoutMs: 30_000,
    },
  ],
  investigator: {
    prompt:
      'The ad service latency has increased across all percentiles. What is causing it in the last 15 minutes?',
    expectedRootCausePattern: 'ad.*cpu|saturat|latency.*increas|p95.*p99.*both|broad.*shift',
    waitMs: 5 * 60_000,
  },
};

export default scenario;
