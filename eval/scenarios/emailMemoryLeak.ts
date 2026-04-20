import type { ScenarioDeclaration } from '../types.js';

const scenario: ScenarioDeclaration = {
  name: 'emailMemoryLeak',
  flag: 'emailMemoryLeak',
  variant: '100x',
  expectedService: 'email',
  // 100x leak → OOM in minutes. Need enough time for latency
  // drift to become visible on the Duration chart.
  telemetryWaitMs: 5 * 60_000,
  cooldownMs: 5 * 60_000,
  surfaceChecks: [
    {
      surface: 'homeP95Chip',
      page: 'home',
      locator: 'table tbody tr:has-text("email") [title*="vs previous window"]',
      assertion: 'visible',
      timeoutMs: 60_000,
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
      'The email service latency is increasing over time. What could be causing gradual performance degradation?',
    expectedRootCausePattern: 'email.*latency|memory|leak|gradual|drift|increasing',
    waitMs: 5 * 60_000,
  },
};

export default scenario;
