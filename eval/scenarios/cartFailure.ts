import type { ScenarioDeclaration } from '../types.js';

const scenario: ScenarioDeclaration = {
  name: 'cartFailure',
  flag: 'cartFailure',
  variant: 'on',
  expectedService: 'cart',
  telemetryWaitMs: 3 * 60_000,
  cooldownMs: 2 * 60_000,
  surfaceChecks: [
    {
      surface: 'homeCartErrorChip',
      page: 'home',
      locator: 'table tbody tr:has-text("cart") td:nth-child(3)',
      assertion: 'textMatches',
      pattern: '[1-9]\\d*\\.\\d+%',
      timeoutMs: 30_000,
    },
    {
      surface: 'homeErrorClasses',
      page: 'home',
      locator: '[class*="wrap"]:has(span:text-matches("^Error classes")) li:has-text("cart")',
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
  ],
  investigator: {
    prompt:
      'Why are there cart service errors in the last 15 minutes? Summarise root cause.',
    expectedRootCausePattern: 'cart.*error|redis|valkey|emptyCart|getCart',
    waitMs: 5 * 60_000,
  },
};

export default scenario;
