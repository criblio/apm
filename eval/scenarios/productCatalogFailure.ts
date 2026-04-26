import type { ScenarioDeclaration } from '../types.js';

const scenario: ScenarioDeclaration = {
  name: 'productCatalogFailure',
  flag: 'productCatalogFailure',
  variant: 'on',
  expectedService: 'product-catalog',
  telemetryWaitMs: 7 * 60_000,
  cooldownMs: 10 * 60_000,
  surfaceChecks: [
    {
      surface: 'homeErrorClasses',
      page: 'services',
      locator: '[class*="wrap"]:has(span:text-matches("^Error classes")) li:has-text("product-catalog")',
      assertion: 'countGt0',
      timeoutMs: 30_000,
    },
    {
      surface: 'homeProductCatalogErrorChip',
      page: 'services',
      locator: 'table tbody tr:has-text("product-catalog") td:nth-child(3)',
      assertion: 'textMatches',
      pattern: '[0-9]+\\.\\d+%',
      timeoutMs: 30_000,
    },
  
    {
      surface: 'overviewDetectedIssuesproductcatalog',
      page: 'overview',
      locator: '[class*="wrap"]:has(span:text-matches("^Detected Issues")) a:has-text("product-catalog")',
      assertion: 'countGt0',
      timeoutMs: 60_000,
    },
    {
      surface: 'alertsPageproductcatalogFiring',
      page: 'alerts',
      locator: 'table tr:has-text("product-catalog"):has-text("Firing")',
      assertion: 'countGt0',
      timeoutMs: 120_000,
    },
    {
      surface: 'svcDetailAlertBadge',
      page: 'serviceDetail',
      locator: '[data-testid="alert-badge"]',
      assertion: 'visible',
      timeoutMs: 30_000,
    },
  ],

  kqlChecks: [
    {
      surface: 'alertStateproductcatalogFiring',
      query: 'dataset="$vt_results" | where jobName == "criblapm__home_alerts" and svc == "product-catalog" | project alert_status',
      earliest: '-1h',
      latest: 'now',
      assertion: 'fieldMatches',
      field: 'alert_status',
      pattern: 'firing|pending',
      timeoutMs: 8 * 60_000,
      pollIntervalMs: 30_000,
    },
    {
      surface: 'alertHistoryproductcatalogFired',
      query: 'dataset="otel" | where data_datatype == "criblapm_alert" and svc == "product-catalog" and event_type == "firing"',
      earliest: '-30m',
      latest: 'now',
      assertion: 'rowCountGt0',
      timeoutMs: 10 * 60_000,
      pollIntervalMs: 30_000,
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
