import type { ScenarioDeclaration } from '../types.js';

const scenario: ScenarioDeclaration = {
  name: 'cartFailure',
  flag: 'cartFailure',
  variant: 'on',
  expectedService: 'cart',
  telemetryWaitMs: 7 * 60_000,
  cooldownMs: 10 * 60_000,
  surfaceChecks: [
    {
      surface: 'homeCartErrorChip',
      page: 'home',
      locator: 'table tbody tr:has-text("cart") td:nth-child(3)',
      assertion: 'textMatches',
      // Match any non-zero error rate including sub-1% like "0.50%"
      pattern: '[1-9]\\d*\\.\\d+%|0\\.[0-9]*[1-9]+\\d*%',
      timeoutMs: 60_000,
    },
    {
      surface: 'homeErrorClasses',
      page: 'home',
      locator: '[class*="wrap"]:has(span:text-matches("^Error classes")) li:has-text("cart")',
      assertion: 'countGt0',
      timeoutMs: 60_000,
    },
    {
      surface: 'svcDetailErrorsChart',
      page: 'serviceDetail',
      locator: 'text=Errors',
      assertion: 'visible',
      timeoutMs: 30_000,
    },
  
    {
      surface: 'homeDetectedIssuescart',
      page: 'home',
      locator: '[class*="wrap"]:has(span:text-matches("^Detected Issues")) a:has-text("cart")',
      assertion: 'countGt0',
      timeoutMs: 60_000,
    },
    {
      surface: 'alertsPagecartFiring',
      page: 'alerts',
      locator: 'table tr:has-text("cart"):has-text("Firing")',
      assertion: 'countGt0',
      timeoutMs: 120_000,
    },
    {
      surface: 'svcDetailAlertBadge',
      page: 'serviceDetail',
      locator: '[class*="alertBadge"]',
      assertion: 'visible',
      timeoutMs: 30_000,
    },
  ],

  kqlChecks: [
    {
      surface: 'alertStatecartFiring',
      query: 'dataset="$vt_results" | where jobName == "criblapm__home_alerts" and svc == "cart" | project alert_status',
      earliest: '-1h',
      latest: 'now',
      assertion: 'fieldMatches',
      field: 'alert_status',
      pattern: 'firing|pending',
      timeoutMs: 8 * 60_000,
      pollIntervalMs: 30_000,
    },
    {
      surface: 'alertHistorycartFired',
      query: 'dataset="otel" | where data_datatype == "criblapm_alert" and svc == "cart" and event_type == "firing"',
      earliest: '-30m',
      latest: 'now',
      assertion: 'rowCountGt0',
      timeoutMs: 10 * 60_000,
      pollIntervalMs: 30_000,
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
