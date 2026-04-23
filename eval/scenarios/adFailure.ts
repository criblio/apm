import type { ScenarioDeclaration } from '../types.js';

const scenario: ScenarioDeclaration = {
  name: 'adFailure',
  flag: 'adFailure',
  variant: 'on',
  expectedService: 'ad',
  // 10% Bernoulli rate on ~10 GetAds/min = ~1 error/min.
  // Need 4+ minutes for reliable detection.
  telemetryWaitMs: 7 * 60_000,
  cooldownMs: 10 * 60_000,
  surfaceChecks: [
    {
      surface: 'homeAdErrorChip',
      page: 'home',
      locator: 'table tbody tr:has-text("ad") td:nth-child(3)',
      assertion: 'textMatches',
      pattern: '[0-9]+\\.\\d+%',
      timeoutMs: 30_000,
    },
    {
      surface: 'homeErrorClasses',
      page: 'home',
      locator: '[class*="wrap"]:has(span:text-matches("^Error classes")) li:has-text("ad")',
      assertion: 'countGt0',
      timeoutMs: 60_000,
    },
  
    {
      surface: 'homeDetectedIssuesad',
      page: 'home',
      locator: '[class*="wrap"]:has(span:text-matches("^Detected Issues")) a:has-text("ad")',
      assertion: 'countGt0',
      timeoutMs: 60_000,
    },
    {
      surface: 'alertsPageadFiring',
      page: 'alerts',
      locator: 'table tr:has-text("ad"):has-text("Firing")',
      assertion: 'countGt0',
      timeoutMs: 120_000,
    },
    {
      surface: 'svcDetailAlertBadge',
      page: 'serviceDetail',
      locator: 'h1:has-text("ad") span:text-matches("firing|pending", "i")',
      assertion: 'visible',
      timeoutMs: 30_000,
    },
  ],

  kqlChecks: [
    {
      surface: 'alertStateadFiring',
      query: 'dataset="$vt_results" | where jobName == "criblapm__home_alerts" and svc == "ad" | project alert_status',
      earliest: '-1h',
      latest: 'now',
      assertion: 'fieldMatches',
      field: 'alert_status',
      pattern: 'firing|pending',
      timeoutMs: 8 * 60_000,
      pollIntervalMs: 30_000,
    },
    {
      surface: 'alertHistoryadFired',
      query: 'dataset="otel" | where data_datatype == "criblapm_alert" and svc == "ad" and event_type == "firing"',
      earliest: '-30m',
      latest: 'now',
      assertion: 'rowCountGt0',
      timeoutMs: 10 * 60_000,
      pollIntervalMs: 30_000,
    },
  ],
  investigator: {
    prompt:
      'Are there any ad service errors in the last 15 minutes? Summarise root cause.',
    expectedRootCausePattern: 'ad.*error|GetAds|UNAVAILABLE|adservice',
    waitMs: 5 * 60_000,
  },
};

export default scenario;
