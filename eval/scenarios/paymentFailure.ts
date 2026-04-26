import type { ScenarioDeclaration } from '../types.js';

const scenario: ScenarioDeclaration = {
  name: 'paymentFailure',
  flag: 'paymentFailure',
  variant: '50%',
  expectedService: 'payment',
  telemetryWaitMs: 7 * 60_000,
  cooldownMs: 10 * 60_000,
  surfaceChecks: [
    // Overview page — detected issues
    {
      surface: 'overviewDetectedIssuesPayment',
      page: 'overview',
      locator: 'a:has-text("payment")',
      assertion: 'countGt0',
      timeoutMs: 30_000,
    },
    // Services page — error chip in catalog
    {
      surface: 'servicesPaymentErrorChip',
      page: 'services',
      locator: 'table tbody tr:has-text("payment") td:nth-child(3)',
      assertion: 'textMatches',
      pattern: '[1-9]\\d*\\.\\d+%',
      timeoutMs: 30_000,
    },
    // Errors page — payment error group
    {
      surface: 'errorsPagePayment',
      page: 'errors',
      locator: 'table tr:has-text("payment")',
      assertion: 'countGt0',
      timeoutMs: 30_000,
    },
    // Alerts page — payment firing
    {
      surface: 'alertsPagePaymentFiring',
      page: 'alerts',
      locator: 'table tr:has-text("payment"):has-text("Firing")',
      assertion: 'countGt0',
      timeoutMs: 120_000,
    },
    // Service Detail — charts and alert badge
    {
      surface: 'svcDetailErrorsChart',
      page: 'serviceDetail',
      locator: 'text=Errors',
      assertion: 'visible',
      timeoutMs: 30_000,
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
      surface: 'alertStatePaymentFiring',
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
      surface: 'alertHistoryPaymentFired',
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
      'Why are there payment service errors in the last 15 minutes? Summarise root cause.',
    expectedRootCausePattern: 'payment.*error|charge.*fail|invalid.*token',
    waitMs: 5 * 60_000,
  },
};

export default scenario;
