import type { ScenarioDeclaration } from '../types.js';

const scenario: ScenarioDeclaration = {
  name: 'paymentUnreachable',
  flag: 'paymentUnreachable',
  variant: 'on',
  expectedService: 'payment',
  telemetryWaitMs: 3 * 60_000,
  cooldownMs: 5 * 60_000,
  surfaceChecks: [
    {
      surface: 'homeRateDropChip',
      page: 'home',
      locator: 'table tbody tr:has-text("payment") [title*="vs previous window"]',
      assertion: 'visible',
      timeoutMs: 30_000,
    },
    {
      surface: 'homeCheckoutErrorChip',
      page: 'home',
      locator: 'table tbody tr:has-text("checkout") td:nth-child(3)',
      assertion: 'textMatches',
      pattern: '[1-9]\\d*\\.\\d+%',
      timeoutMs: 30_000,
    },
    {
      surface: 'homeErrorClasses',
      page: 'home',
      locator: '[class*="wrap"]:has(span:text-matches("^Error classes")) li:has-text("payment")',
      assertion: 'countGt0',
      timeoutMs: 30_000,
    },
    {
      surface: 'svcDetailErrors',
      page: 'serviceDetail',
      locator: 'text=Errors',
      assertion: 'visible',
      timeoutMs: 30_000,
    },
  ],
  investigator: {
    prompt:
      'The payment service appears unreachable. What is causing checkout failures in the last 15 minutes? Summarise root cause.',
    expectedRootCausePattern:
      'payment.*unreachable|unavailable|connection.*refused|payment.*down',
    waitMs: 5 * 60_000,
  },
};

export default scenario;
