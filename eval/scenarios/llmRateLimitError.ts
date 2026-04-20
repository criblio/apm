import type { ScenarioDeclaration } from '../types.js';

const scenario: ScenarioDeclaration = {
  name: 'llmRateLimitError',
  flag: 'llmRateLimitError',
  variant: 'on',
  expectedService: 'product-reviews',
  telemetryWaitMs: 3 * 60_000,
  cooldownMs: 5 * 60_000,
  surfaceChecks: [
    {
      surface: 'homeProductReviewsErrorChip',
      page: 'home',
      locator: 'table tbody tr:has-text("product-reviews") td:nth-child(3)',
      assertion: 'textMatches',
      pattern: '[1-9]\\d*\\.\\d+%',
      timeoutMs: 30_000,
    },
    {
      surface: 'homeErrorClasses',
      page: 'home',
      locator: '[class*="wrap"]:has(span:text-matches("^Error classes")) li:has-text("product-reviews")',
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
      'Why are there product-reviews errors in the last 15 minutes? Summarise root cause.',
    expectedRootCausePattern: 'product.reviews|rate.limit|llm|429|throttl',
    waitMs: 5 * 60_000,
  },
};

export default scenario;
