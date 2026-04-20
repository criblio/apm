import type { ScenarioDeclaration } from '../types.js';

const scenario: ScenarioDeclaration = {
  name: 'failedReadinessProbe',
  flag: 'failedReadinessProbe',
  variant: 'on',
  expectedService: 'cart',
  // Readiness probe failure → k8s removes cart from endpoints →
  // upstream callers get connection errors. Propagation is slow.
  telemetryWaitMs: 4 * 60_000,
  cooldownMs: 5 * 60_000,
  surfaceChecks: [
    {
      surface: 'homeCartErrorChip',
      page: 'home',
      locator: 'table tbody tr:has-text("cart") td:nth-child(3)',
      assertion: 'textMatches',
      pattern: '[1-9]\\d*\\.\\d+%',
      timeoutMs: 60_000,
    },
    {
      surface: 'homeErrorClasses',
      page: 'home',
      locator: '[class*="wrap"]:has(span:text-matches("^Error classes")) li:has-text("cart")',
      assertion: 'countGt0',
      timeoutMs: 60_000,
    },
  ],
  investigator: {
    prompt:
      'Why are there cart service errors in the last 15 minutes? Is the service having availability issues?',
    expectedRootCausePattern: 'cart.*error|connection.*refused|unavailable|readiness|pod|restart',
    waitMs: 5 * 60_000,
  },
};

export default scenario;
