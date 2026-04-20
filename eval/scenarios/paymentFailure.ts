import type { ScenarioDeclaration } from '../types.js';

const scenario: ScenarioDeclaration = {
  name: 'paymentFailure',
  flag: 'paymentFailure',
  variant: '50%',
  expectedService: 'payment',
  telemetryWaitMs: 3 * 60_000,
  cooldownMs: 5 * 60_000,
  surfaceChecks: [
    {
      surface: 'homePaymentErrorChip',
      page: 'home',
      locator: 'table tbody tr:has-text("payment") td:nth-child(3)',
      assertion: 'textMatches',
      pattern: '[1-9]\\d*\\.\\d+%',
      timeoutMs: 30_000,
    },
    {
      surface: 'homeErrorClassesPanel',
      page: 'home',
      locator: '[class*="wrap"]:has(span:text-matches("^Error classes")) li:has-text("payment")',
      assertion: 'countGt0',
      timeoutMs: 30_000,
    },
    {
      surface: 'svcDetailErrorsChart',
      page: 'serviceDetail',
      locator: 'text=Errors',
      assertion: 'visible',
      timeoutMs: 30_000,
    },
    {
      surface: 'svcDetailRecentErrors',
      page: 'serviceDetail',
      locator: '[class*="wrap"]:has(span:text-matches("^Recent errors")) ul li',
      assertion: 'countGt0',
      timeoutMs: 45_000,
    },
  ],
  investigator: {
    prompt:
      'Why are there payment service errors in the last 15 minutes? Summarise root cause.',
    expectedRootCausePattern: 'payment.*error|charge.*fail|invalid.*token',
    waitMs: 5 * 60_000,
  },
};

export default scenario;
