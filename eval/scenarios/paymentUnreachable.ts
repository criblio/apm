import type { ScenarioDeclaration } from '../types.js';

const scenario: ScenarioDeclaration = {
  name: 'paymentUnreachable',
  flag: 'paymentUnreachable',
  variant: 'on',
  expectedService: 'payment',
  telemetryWaitMs: 7 * 60_000,
  cooldownMs: 10 * 60_000,
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
  
    {
      surface: 'homeDetectedIssuespayment',
      page: 'home',
      locator: '[class*="wrap"]:has(span:text-matches("^Detected Issues")) a:has-text("payment")',
      assertion: 'countGt0',
      timeoutMs: 60_000,
    },
    {
      surface: 'alertsPagepaymentFiring',
      page: 'alerts',
      locator: 'table tr:has-text("payment"):has-text("Firing")',
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
      surface: 'alertStatepaymentFiring',
      query: 'dataset="$vt_results" | where jobName == "criblapm__home_alerts" and svc == "payment" | project alert_status',
      earliest: '-1h',
      latest: 'now',
      assertion: 'fieldMatches',
      field: 'alert_status',
      pattern: 'firing|pending',
      timeoutMs: 8 * 60_000,
      pollIntervalMs: 30_000,
    },
    {
      surface: 'alertHistorypaymentFired',
      query: 'dataset="otel" | where data_datatype == "criblapm_alert" and svc == "payment" and event_type == "firing"',
      earliest: '-30m',
      latest: 'now',
      assertion: 'rowCountGt0',
      timeoutMs: 10 * 60_000,
      pollIntervalMs: 30_000,
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
