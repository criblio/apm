import type { ScenarioDeclaration } from '../types.js';

const scenario: ScenarioDeclaration = {
  name: 'adHighCpu',
  flag: 'adHighCpu',
  variant: 'on',
  expectedService: 'ad',
  telemetryWaitMs: 7 * 60_000,
  cooldownMs: 10 * 60_000,
  surfaceChecks: [
    {
      surface: 'homeAdP95Value',
      page: 'home',
      locator: 'table tbody tr:has-text("ad") td:nth-child(6)',
      assertion: 'textMatches',
      // Baseline ad p95 is ~1ms. Under CPU saturation it shifts
      // to 5ms+. Match anything showing ms with ≥2 digits or
      // any value in seconds.
      pattern: '[5-9](\\.\\d+)?\\s*ms|\\d{2,}(\\.\\d+)?\\s*ms|\\d+(\\.\\d+)?\\s*s',
      timeoutMs: 30_000,
    },
    {
      surface: 'homeAdP99Value',
      page: 'home',
      locator: 'table tbody tr:has-text("ad") td:nth-child(7)',
      assertion: 'textMatches',
      pattern: '[5-9](\\.\\d+)?\\s*ms|\\d{2,}(\\.\\d+)?\\s*ms|\\d+(\\.\\d+)?\\s*s',
      timeoutMs: 30_000,
    },
    {
      surface: 'svcDetailDurationChart',
      page: 'serviceDetail',
      locator: 'text=p95',
      assertion: 'visible',
      timeoutMs: 30_000,
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
      'The ad service latency has increased across all percentiles. What is causing it in the last 15 minutes?',
    expectedRootCausePattern: 'ad.*cpu|saturat|latency.*increas|p95.*p99.*both|broad.*shift',
    waitMs: 5 * 60_000,
  },
};

export default scenario;
