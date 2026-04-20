import type { ScenarioDeclaration } from '../types.js';

const scenario: ScenarioDeclaration = {
  name: 'adHighCpu',
  flag: 'adHighCpu',
  variant: 'on',
  expectedService: 'ad',
  telemetryWaitMs: 3 * 60_000,
  cooldownMs: 5 * 60_000,
  surfaceChecks: [
    {
      surface: 'homeAdP95Value',
      page: 'home',
      locator: 'table tbody tr:has-text("ad") td:nth-child(6)',
      assertion: 'textMatches',
      // Baseline ad p95 is ~1-5ms. Under CPU saturation it shifts
      // to 50ms+. Match anything ≥10ms as a positive signal.
      pattern: '\\d{2,}(\\.\\d+)?\\s*ms|\\d+(\\.\\d+)?\\s*s',
      timeoutMs: 30_000,
    },
    {
      surface: 'homeAdP99Value',
      page: 'home',
      locator: 'table tbody tr:has-text("ad") td:nth-child(7)',
      assertion: 'textMatches',
      pattern: '\\d{2,}(\\.\\d+)?\\s*ms|\\d+(\\.\\d+)?\\s*s',
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
