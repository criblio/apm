import type { ScenarioDeclaration } from '../types.js';

const scenario: ScenarioDeclaration = {
  name: 'emailMemoryLeak',
  flag: 'emailMemoryLeak',
  variant: '100x',
  expectedService: 'email',
  // 100x leak → OOM in minutes. Need enough time for latency
  // drift to become visible on the Duration chart.
  telemetryWaitMs: 7 * 60_000,
  cooldownMs: 10 * 60_000,
  surfaceChecks: [
    {
      surface: 'homeP95Chip',
      page: 'home',
      locator: 'table tbody tr:has-text("email") [title*="vs previous window"]',
      assertion: 'visible',
      timeoutMs: 60_000,
    },
    {
      surface: 'svcDetailDurationChart',
      page: 'serviceDetail',
      locator: 'text=p95',
      assertion: 'visible',
      timeoutMs: 30_000,
    },
  
    {
      surface: 'homeDetectedIssuesemail',
      page: 'home',
      locator: '[class*="wrap"]:has(span:text-matches("^Detected Issues")) a:has-text("email")',
      assertion: 'countGt0',
      timeoutMs: 60_000,
    },
    {
      surface: 'alertsPageemailFiring',
      page: 'alerts',
      locator: 'table tr:has-text("email"):has-text("Firing")',
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
      surface: 'alertStateemailFiring',
      query: 'dataset="$vt_results" | where jobName == "criblapm__home_alerts" and svc == "email" | project alert_status',
      earliest: '-1h',
      latest: 'now',
      assertion: 'fieldMatches',
      field: 'alert_status',
      pattern: 'firing|pending',
      timeoutMs: 8 * 60_000,
      pollIntervalMs: 30_000,
    },
    {
      surface: 'alertHistoryemailFired',
      query: 'dataset="otel" | where data_datatype == "criblapm_alert" and svc == "email" and event_type == "firing"',
      earliest: '-30m',
      latest: 'now',
      assertion: 'rowCountGt0',
      timeoutMs: 10 * 60_000,
      pollIntervalMs: 30_000,
    },
  ],
  investigator: {
    prompt:
      'The email service latency is increasing over time. What could be causing gradual performance degradation?',
    expectedRootCausePattern: 'email.*latency|memory|leak|gradual|drift|increasing',
    waitMs: 5 * 60_000,
  },
};

export default scenario;
