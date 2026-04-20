import type { ScenarioDeclaration } from '../types.js';

const scenario: ScenarioDeclaration = {
  name: 'productCatalogFailure',
  flag: 'productCatalogFailure',
  variant: 'on',
  expectedService: 'product-catalog',
  telemetryWaitMs: 3 * 60_000,
  cooldownMs: 2 * 60_000,
  surfaceChecks: [
    {
      surface: 'homeErrorClasses',
      page: 'home',
      locator: '[class*="wrap"]:has(span:text-matches("^Error classes")) li:has-text("product-catalog")',
      assertion: 'countGt0',
      timeoutMs: 30_000,
    },
    {
      surface: 'homeProductCatalogErrorChip',
      page: 'home',
      locator: 'table tbody tr:has-text("product-catalog") td:nth-child(3)',
      assertion: 'textMatches',
      pattern: '[0-9]+\\.\\d+%',
      timeoutMs: 30_000,
    },
  ],
  investigator: {
    prompt:
      'Why are there product-catalog errors in the last 15 minutes? Which product is affected?',
    expectedRootCausePattern: 'product.catalog|OLJCESPC7Z|product.*id|GetProduct',
    waitMs: 5 * 60_000,
  },
};

export default scenario;
